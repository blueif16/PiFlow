# DESIGN — The Single-Sentinel Declarative Wake-Seam

Source of truth for the `piflow-overlord` skill rewrite + the build plan (Linear RAN, task "Build
single-Sentinel declarative wake-seam system"). This is the design **after** an adversarial verification
pass found and forced correction of four real defects (§4 mechanism split, §3 processor placement, §5
counts, mislabeled build-state) — see "Corrections applied" at the end of each section that had one. Every
claim below is tagged **[EXISTS]** (read directly from source, file:line) or **[TO-BUILD]**. No claim is
carried over from the draft without being re-read against source in this pass.

Files read to ground this doc: `packages/cli/src/{watch,telemetry,remote,optimize-fix}.ts`,
`packages/core/src/observe/telemetry.ts`, `packages/core/src/optimize/{events,driver,loop}.ts`,
`packages/core/src/checks.ts`, `packages/core/src/runner/status.ts`, `docs/ARCHITECTURE.md` §5,
`.claude/skills/piflow-overlord/SKILL.md`.

---

## 0. The three planes (the frame everything hangs on)

```
Plane 1  DATA        the canonical streams                                     [EXISTS]
         run:      watchRun → RunUpdate → telemetryStream → TelemetryEvent
         optimize: (in-process) driver.ts/loop.ts safeEmit → OptimizeEvent

Plane 2  REFLEX      deterministic, always-on, code — never wakes the agent    [EXISTS]
         maxNodesPerRun ceiling · exec-runner nodeTimeoutMs/stallMs watchdog ·
         retry.ts runNodeWithRetries + escalate.after · checks.ts classifyFailure ·
         optimize editBudget/tokenBudget/fixCycleCeiling · runOptimizeLoop's own
         converged/stalled/circuit-broken early-stop · game-omni binding-live
         watchdog (repro-probe / dep-rabbit-hole / no-progress)

Plane 3  SENTINEL    the agent — has NO event loop                     [posture: TO-BUILD]
         woken ONLY when Plane-2's stream produces an event the WAKE-POLICY says
         is worth a human-grade judgment. Adjudicates, acts through piflowctl
         (gated by the intervention-seam, §6), sleeps.
```

The wake-seam is the membrane **between Plane 2 and Plane 3**: a declarative predicate set that decides
which of the reflex's events are worth spending the agent on.

---

## 1. CORE MODEL — one posture: Sentinel, no streaming mode

There is exactly **one** agent posture and it is **event-woken, never streaming**. The agent never sits in
a loop babysitting a stream — that is Plane 2's job (code, always running, never judging). The agent's
whole lifecycle is:

**woken → adjudicate → act (at an intervention-seam, §6) → re-arm the wake → sleep.**

Why "streaming mode" must not exist as an agent posture:
- `piflowctl telemetry --watch` **[EXISTS]** is the literal anti-pattern: `for await (const ev of
  telemetryStream(...)) process.stdout.write(renderEvent(ev))` (`packages/cli/src/telemetry.ts:155-157`).
  It blocks the whole process for the run's duration, emitting unstructured text even without `--json`
  (there is no `--json` branch inside the stream loop — only the post-loop record dump respects `--json`,
  line 162). An LLM agent holding this open has no callback; it just burns a process and a context window
  on events the reflex already handled or that don't matter. This is the pattern the Sentinel replaces, not
  a mode the Sentinel offers.
- The reflex already watches every event continuously and acts without judgment: `exec-runner.ts` races
  `nodeTimeoutMs` vs `stallMs` and SIGTERMs on a trip; `retry.ts` re-attempts/escalates by `FailureClass`;
  `run-context.ts` HALTs at `maxNodesPerRun`; `runOptimizeLoop` (`packages/core/src/optimize/loop.ts`) is
  itself a full reflex loop with its own converged/stalled/circuit-breaker stop conditions (lines 109-136);
  the game-omni `binding-live.mjs` watchdog SIGTERMs a corrupting fixer at token/edit budgets. **The agent
  must never re-implement or duplicate any of these loops** — not the run watchdog, and (§4 correction)
  not the optimize round loop either.

**Seam-law gates what the agent may DO on wake, not whether it is woken.** A wake fires freely on any
matched event; the *action* on a live producer is deferred to the next intervention-seam (§6). **wake ≠
act** is the load-bearing split that makes a coarse live-run policy safe (§5).

---

## 2. THE WAKE-POLICY — a declarative predicate set

A `WakePolicy` is data the Sentinel (or its launching context) registers once per supervised target. It is
a disjunction (OR) of typed predicates over fields the existing folds already compute — **a projection, not
new detection logic.**

> Framing correction: this is a **declarative projection over a closed, typed vocabulary**
> (`NodeStatus`, `AnomalyKind`, `OptimizeEvent['type']`), not "register arbitrary predicates." You cannot
> add a new predicate *kind* without code; you can only compose the existing ones. That's a feature (the
> policy inherits the fold's edge-triggering and can't invent detection logic the fold doesn't do) but the
> doc must not oversell it as open-ended.

### Schema **[TO-BUILD]** — `packages/core/src/observe/wake.ts`

```ts
type WakePolicy = {
  stream: 'run' | 'optimize';          // which Plane-1 producer this policy binds
  predicates: WakePredicate[];         // OR-composed: wake on ANY match
};

type WakePredicate =
  // ── run stream (telemetryStream(watchRun|remoteUpdates) — see §3 for why this is the ONLY source) ──
  | { on: 'status';  value: NodeStatus[] }          // e.g. ['blocked','error','awaiting-input']
  | { on: 'anomaly'; kind: AnomalyKind[] }          // failed·truncated·context-pressure·tool-loop·retries
                                                     // (telemetry.ts:33 AnomalyKind — 'slow' is record-only, §5)
  | { on: 'metric';  field: 'contextPct'|'retries'|'maxToolRepeat'; gte: number }  // re-tune of the SAME
                                                     // anomalies above (see the note under "metric", §3)
  | { on: 'run-end' }
  | { on: 'node-finished' }                         // matches TelemetryEvent{kind:'node-close'} — the SAME
                                                     // fold's node-lifecycle signal, fired on EVERY terminal
                                                     // status (healthy or not, telemetry.ts:342,451-455).
                                                     // PROFILE-CONDITIONAL registration, not a detection rule
                                                     // — see §3 and §5.
  // ── optimize stream (OptimizeEvent — already typed+decision-grade, events.ts:12-29) ──
  | { on: 'optimize'; type: OptimizeEvent['type'][] } // e.g. ['fixer-aborted','fix-cycle-ceiling','stopped','loop-stopped']
  | { on: 'gated';    verdict: 'reject' | 'accept' }; // sugar over OptimizeEvent 'gated' + verdict.accept
```

### Compact inline grammar **[TO-BUILD]**

`--wake-on '<clause>[; <clause> …]'`, clauses OR-compose:

```
status:blocked,error,awaiting-input
anomaly:failed,truncated
metric:contextPct>=0.9
run-end
node-finished
optimize:fixer-aborted,fix-cycle-ceiling,stopped,loop-stopped
gated:reject
```

or `--wake-policy policy.json` for the full schema.

`node-finished` takes no value — it's a bare clause, like `run-end`. Whether the CLI's *default* LIVE-RUN
policy includes it is decided at policy-construction time from the run's active profile (§3), never inside
`matchWake` itself; an explicit `--wake-on 'node-finished'` always arms it regardless of profile (an operator
overriding the default is not the same thing as the default itself being profile-blind).

### How it composes

- **Disjunctive, edge-triggered, cheap — inherited for free.** `telemetryStream`'s `emitted` set fires
  each anomaly kind exactly once per node (`emitOf`, `fireAnomalies`, `telemetry.ts:370,376,413-420`
  **[EXISTS]**); `node-status` in the raw `RunUpdate` stream only fires on a derived-status *change*
  (`packages/core/src/observe/watch.ts` — status is re-derived, not re-announced, per node accumulator).
  So the policy inherits de-dupe without any new code: it will not thrash the agent.
- **`metric` is a threshold re-tune of the SAME anomaly set, not a new signal.** `contextPct`/`retries`/
  `maxToolRepeat` map 1:1 onto `DEFAULT_THRESHOLDS.{contextPct,retries,toolRepeat}` (`telemetry.ts:31`
  **[EXISTS]**). There is no `toolCalls` metric — see §3's placement correction for why.
- **The predicate closed set = the wake-fireable field set.** `slow` is deliberately absent from the live
  policy: `liveMetrics()` hardcodes `expectedMs:null, priorSamples:0` (`telemetry.ts:390-391` **[EXISTS]**),
  so `detectAnomalies`'s `slow` branch (`telemetry.ts:170-174`, guarded on `priorSamples > 0`) structurally
  cannot fire on the live stream. A policy that wants `slow` must key on `run-end` and read it off the
  authoritative record (§3).
- **`node-finished` inherits the SAME edge-triggering for free, off a DIFFERENT de-dupe set.** `node-close` is
  gated by its own `closed` Set (`telemetry.ts:372,451-456` **[EXISTS]**) — symmetric to `emitted` for
  anomalies — so it fires exactly once per node, on the FIRST terminal status it reaches. It is not folded into
  the `anomaly:` clause (a different `TelemetryEvent.kind`, matched by its own predicate) and it needs no
  `metric`/threshold: unlike an anomaly, it isn't conditional on crossing a value — it fires on completion,
  full stop. **Zero timers anywhere in this**: no `setTimeout`, no polling loop, no wall-clock check — the
  event is produced the instant `watchRun`'s `node-status` update crosses into a `TERMINAL` status
  (`telemetry.ts:451` **[EXISTS]**).

---

## 3. THE PROCESSOR — where it sits, what it emits, corrected

**Correction from the original draft:** the processor binds `telemetryStream`, not the raw `watchRun`
stream `packages/cli/src/watch.ts` iterates. `watch.ts`'s loop (`watch.ts:75-93`) reads **raw `RunUpdate`**
(`u.kind === 'snapshot'|'node-status'|'done'`) and never touches `telemetryStream` — it has no anomalies to
match against. `anomaly:` predicates only exist inside `telemetryStream`'s fold. Binding the wake matcher to
`watch.ts` as originally drafted would leave `anomaly:` predicates with no host; `status:`/`run-end` alone
would work there, but that is not the whole policy. **The wake processor sits on
`telemetryStream(watchRun(dir))` (local) or `telemetryStream(remoteUpdates(entry, run))` (remote) — one
fold, one source — full stop.**

```
run:      watchRun(dir) | remoteUpdates(entry,run)  →  telemetryStream(TelemetryEvent)  →  matchWake(policy,ev)  →  WAKE
optimize: (in-process) driver.ts/loop.ts safeEmit(OptimizeEvent)                         →  matchWake(policy,ev)  →  WAKE
```

### Contract **[TO-BUILD]** — `packages/core/src/observe/wake.ts`

```ts
// pure, O(1) per event — mirrors detectAnomalies (telemetry.ts:154) and renderOptimizeEvent (events.ts:37)
function matchWake(policy: WakePolicy, ev: TelemetryEvent | OptimizeEvent): WakeMatch | null;

type WakeMatch = {
  reasonClass: WakeReasonClass;              // drives the exit code (§4)
  event: TelemetryEvent | OptimizeEvent;     // the raw matched event
  nodeId?: string;
};
```

On the first match, the wake command assembles the decision-grade digest handed to the Sentinel:

1. The matched event verbatim (already decision-grade — `anomaly{kind,nodeId,detail,value,threshold}` or
   an `OptimizeEvent`).
2. **Local runs only:** attach the authoritative record — `projectRunDigest(buildRunView(dir))`
   (`telemetry.ts:294` **[EXISTS]**) — for `rootCauses` (`localizeRootCauses`, `telemetry.ts:250-291`) and
   `slow`, which the live stream cannot produce. This is exactly what `runTelemetryCli` already does *after*
   its loop (`telemetry.ts:161-162`); the wake command does it *at match time*.
   **Remote runs do NOT get this for free** (correction, was claimed "for free" in the draft):
   `buildRunView(dir)` reads a local `.pi/` directory tree — a remote run's `.pi/` lives on the server
   process, not on the wake command's filesystem. Until a server-side digest endpoint exists, a remote wake
   digest is **matched-event-only**, with no `rootCauses`/`slow`. **[TO-BUILD, scoped]**
3. The intervention-seam verdict (§6): `queued-until-boundary` (live producer) vs `immediate` (optimize
   candidate, off critical path).

### Two small extensions `telemetryStream` needs (both inside the fold — no second subscription)

- **`awaiting-input` passthrough.** `telemetryStream`'s `TERMINAL` set (`telemetry.ts:354`, `{'ok','reused',
  'gap','blocked','error','dry'}`) excludes `awaiting-input`, and `detectAnomalies`'s only status-driven
  branch is `isFailed` (`blocked|error`, `telemetry.ts:151,156-158`) — so a checkpoint's `awaiting-input`
  status produces **no** `TelemetryEvent` today. **[TO-BUILD]**: add an `awaiting-input` `AnomalyKind` (or a
  dedicated event) emitted from `fireAnomalies`/`detectAnomalies` when `m.status === 'awaiting-input'`.
- **Custom thresholds — already wired, do not re-build.** `StreamOpts.thresholds?: Partial<
  TelemetryThresholds>` already exists (`telemetry.ts:347-350`) and is merged at `telemetry.ts:364`;
  `projectRunDigest` takes the same `opts.thresholds` (`telemetry.ts:294-295`). **The only real gap is
  CLI-side**: `runTelemetryCli` calls `telemetryStream(…, { verbosity })` and never threads a `thresholds`
  object through (`telemetry.ts:155`) — the new wake command (or a `runTelemetryCli` extension) needs to
  parse `metric:field>=N` clauses into a `thresholds` object and pass it at the call site. **[TO-BUILD,
  CLI-only — core already supports it.]**

### `toolCalls` has no threshold path — dropped from `metric` (correction)

`node-enriched` is a `RunUpdate` kind (`remote.ts:41` lists it), but `telemetryStream`'s `for await`
switch (`telemetry.ts:430-461`) has cases only for `snapshot` / `node-event` / `node-status` / `done` — a
`node-enriched` update falls through unmatched and is silently dropped inside the fold. There is no
`DEFAULT_THRESHOLDS` field for `toolCalls` either. The only place `toolCalls` is exposed live is
terminal-only, on a `node-close` event's `digest.toolCalls` (`NodeDigest.toolCalls`, `telemetry.ts:70`,
populated at `node-close`, `telemetry.ts:451-456`). **`metric` therefore only covers
`contextPct`/`retries`/`maxToolRepeat`** — the three fields with a real `DEFAULT_THRESHOLDS` entry. Do not
add `toolCalls` to the schema without also adding a threshold and a live emission path for it.

### For **optimize**: no fold to sit under — `matchWake` keys directly on `event.type`

`OptimizeEvent` is already typed and decision-grade (`events.ts:12-29` **[EXISTS]**) — there is nothing to
fold. `matchWake` matches `event.type` (or `event.verdict` for the `gated` sugar) directly, with no
projection step.

### For **`node-finished`**: the SAME fold, not a second stream (a naive dual-stream framing corrected here)

**Framing correction, stated explicitly per this doc's own re-read-against-source rule:** a plausible-sounding
version of this requirement says "anomalies live on `telemetryStream`, node-lifecycle lives on raw `watchRun`,
so the processor must consume BOTH streams." That is **not what the source does** and this doc does not adopt
it. `telemetryStream` already emits `{ kind: 'node-close', digest }` itself, from INSIDE its own `for await`
loop over `watchRun`'s raw `RunUpdate`s, the moment a node's status crosses into `TERMINAL`
(`telemetry.ts:337-343` the `TelemetryEvent` union already lists `node-close`; `:451-455` is where it's yielded
**[EXISTS]**). `node-close` fires on EVERY terminal outcome — `ok`/`reused`/`dry` included, not just
`blocked`/`error` — it is simply not wake-worthy TODAY because no `WakePredicate` reads it. So §3's **"one
fold, one source — full stop"** law is not broken by `node-finished` — it's reinforced. The wake processor
still binds exactly one thing, `telemetryStream(watchRun(dir)|remoteUpdates(entry,run))`; `node-finished` is
simply one more `WakePredicate` matched against an event kind that fold was already producing. No second
subscription, no second accumulator, and (per §2) no timer.

**What genuinely differs for `node-finished` is not the event source, it's the policy CONSTRUCTION.** Every
other default predicate in the LIVE-RUN policy (§5) is profile-blind — it fires the same way regardless of how
the run was launched. `node-finished` is the first predicate whose DEFAULT membership in the policy depends on
run metadata outside the event stream itself: the run's active profile, persisted at `runner.ts:536` into
`.pi/workflow.json`'s `profile` field (also mirrored on `RunStatus.profile`, `status.ts:214` **[EXISTS, both]**).
The wake command reads that field once, before arming the default policy, and includes `{on:'node-finished'}`
in it only when the active profile elides the verify gates (§5). This is a projection over run metadata, not a
new detection rule inside `matchWake` — `matchWake` itself stays a pure function of `(policy, event)` with no
knowledge of profiles at all; profile-awareness lives entirely in whichever caller BUILDS the default policy.
**[TO-BUILD, scoped]**: resolving "does profile `<name>` elide the verify gates" needs one small decision —
cross-reference the template's declared `profiles[name].elidePhases` (`template/types.ts:151-153` **[EXISTS]**
as data) against which phases are gate/verify nodes. This doc does not guess the exact mechanism; flag it as an
open call for whoever lands the CLI wiring, per this plan's own "flag it, don't guess past it" convention.

---

## 4. THE WAKE MECHANISM — two producers, TWO mechanisms (corrected — see boxed defect)

> **Defect this section corrects (was the most severe finding in the review):** the original draft said
> "put the same exit-on-match mapper inside the optimize `onEvent` sink" and called it "one mechanism, two
> producers." That is wrong and would have shipped a real bug. `gated` fires on **every** rejected
> candidate (`driver.ts:218`) — routine, not rare — and `runOptimizeLoop` is explicitly built to survive
> rejects across rounds via its own converged/stalled/circuit-breaker stop (`loop.ts:109-140`). Aborting the
> optimize process on the first `gated:reject` or `fixer-aborted` kills the very loop that would try the
> next candidate or round — for the run-stream case "exit → harness re-invokes" is safe because the *run* is
> a separate on-disk process advancing independently of the wake watcher, but for optimize **the loop IS the
> watched process** — killing the watcher kills the work. It also forces the harness to re-drive
> `runOptimizeLoop`'s round-by-round convergence itself, i.e. exactly the loop §1 says the agent must never
> duplicate. **The fix: one wake PRIMITIVE (exit-on-first-match, so the harness's re-invocation trigger stays
> singular), attached differently per producer** so neither attachment can kill the producer it's watching.

### (a) RUN stream — `--wake-on` exits on first match; harness re-invokes — unchanged, still recommended

The wake command subscribes to `telemetryStream(watchRun(dir)|remoteUpdates(...))` (§3), runs `matchWake`
per event, and on the first match prints the decision-grade digest as JSON and **exits with a
reason-encoding code**. The orchestration harness treats process exit as a task-notification and re-invokes
the Sentinel with the digest. This is safe because the *run* keeps advancing on disk (or on the server)
independently of the wake command's process — killing the watcher never kills the run.

Grounding for why this is buildable with small, real changes:
- The shape already exists and is even named for it: `piflowctl watch` self-describes as "the wake-on-event
  SENTINEL … stays SILENT until exactly one thing worth a decision happens, then prints ONE line and
  resolves" (`watch.ts:1-3` **[EXISTS]**) — it already print-once-and-returns on a terminal condition. But
  as noted in §3 it binds the wrong stream (raw `RunUpdate`, no anomalies) — the wake command is a sibling
  that binds `telemetryStream` instead, keeping `watch.ts`'s two-predicate DONE/node-failed sentinel as the
  minimal case it already covers (its `isFailed` check, `watch.ts:45`, is identical to `telemetry.ts:151`).
- `runWatchCli` **discards `WatchResult`** — `await watchRun(...)` at `watch.ts:123` never reads the
  returned `{reason,ok,node,line}`, so `process.exitCode` is never set and the process always exits 0; DONE
  is indistinguishable from FAILED on exit code today. **[TO-BUILD: map `reason` → `process.exitCode`.]**
  This fix is needed regardless of where the wake command lives.
- `--notify` is a dead stub — `notifyDesktop`'s body is `void title; void msg;` (`watch.ts:47-53`). Not
  needed for the wake seam: process exit *is* the notification.
- Local + remote for the **matched event** come for free: `runWatchCli` already dispatches `remote ?
  remoteUpdates(entry, target) : watchRun(rundir)` via `resolveRemote` (`watch.ts:113-126`,
  `remote.ts:142-144` **[EXISTS]**). The DR7 allowlist (`RUN_UPDATE_KINDS`, `remote.ts:41`) already lists
  all 5 `RunUpdate` kinds, so nothing is silently dropped over SSE today — but any *new* `RunUpdate` kind
  added later (e.g. an `awaiting-input` passthrough, if implemented as a raw kind rather than a
  `TelemetryEvent` anomaly) must be added there too, or the remote wake silently misses it.
- **What does NOT come for free**: the digest attachment (§3, point 2) — local-only until a server digest
  endpoint exists.

**Exit-code contract [TO-BUILD]** (stop discarding `WatchResult`; the reason classes below are drawn from
the actual predicate/anomaly/optimize-event vocabulary, corrected counts — see §5 for the reconciliation):

| code | reason class | fires from |
|---|---|---|
| 0 | `done` (clean) | run-end, ok |
| 10 | `node-failed` (blocked/error, incl. watchdog-killed stall/timeout — both classify `error`, see §5) | `status` predicate |
| 11 | `anomaly` (truncated/tool-loop/context-pressure/retries) | `anomaly` predicate |
| 12 | `awaiting-input` (checkpoint) | `status` predicate, once the passthrough (§3) ships |
| 20 | `gated:reject` | optimize |
| 21 | `fixer-aborted` | optimize |
| 22 | `fix-cycle-ceiling` | optimize |
| 23 | `stopped` | optimize (was missing from the original table — `events.ts:23`, `driver.ts:244`) |
| 24 | `loop-stopped` | optimize (`events.ts:29`, `loop.ts:140`) |
| 3 | `aborted` (stream ended pre-terminal) | signal |

### (b) OPTIMIZE stream — non-blocking notification; the loop is NEVER killed by a wake match

`OptimizeEvent` is **in-process** to a single blocking `optimize --fix` (or `optimize --rounds N`)
invocation — `driver.ts`'s `safeEmit` (`driver.ts:170-172`) and `loop.ts`'s `safeEmit` (`loop.ts:88-90`)
are fire-and-forget calls into whatever sink `onEvent` wraps; a throwing sink never breaks the loop by
design (`try { opts.onEvent(event) } catch { /* swallow */ }`). **The wake attachment for optimize must
preserve exactly that swallow-and-continue property for non-terminal matches**:

- **Non-terminal matches (`gated:reject`, `fixer-aborted`)** — the sink runs `matchWake`, and on a match
  **appends** the digest to a side channel (a `--wake-log <path>` JSONL append, mirroring the existing
  `--watch-json` line-per-event format at `optimize-fix.ts:316`) and returns immediately. The
  loop/driver keeps running — this is the correction: **never abort here.** A separate, thin,
  already-running `piflowctl wake --tail <wake-log>` companion process (spawned once alongside `optimize
  --fix`, same "exit on first match" primitive as (a), just tailing a file instead of a live stream) is
  what actually notifies the harness — it exits the moment a line lands, independent of the optimize
  process's lifetime. This keeps the wake **primitive** singular (exit-on-first-match) while the
  **attachment** differs per producer, and it means a non-terminal optimize event CAN wake the agent
  mid-loop without the agent's wake mechanism ever being the thing that kills the loop.
- **Terminal matches (`fix-cycle-ceiling`, `stopped`, `loop-stopped`)** — these already end the
  driver/loop's own execution naturally (`driver.ts:244` `stopped` is the driver's own final emit before
  return; `loop.ts:140` `loop-stopped` is the loop's own final emit before return). No abort logic is
  needed here at all — the process is exiting on its own regardless of the wake policy. The only
  **[TO-BUILD]** work is mapping the reason to `process.exitCode` (same fix as `watch.ts`'s `WatchResult`
  discard, §4a) so the harness's re-invocation trigger can read *why* it stopped off the exit code instead
  of reparsing the JSON line.

This resolves both review findings at once: **F1 (killing the loop on a routine reject)** — fixed, because
non-terminal matches never abort, they only append. **F4 (a second control loop re-driving convergence)** —
fixed, because the agent is re-invoked *within* one `runOptimizeLoop`/`makeFixGateRunner` call via the
tailing companion, never by re-spawning `optimize --fix` per round from the harness side. `runOptimizeLoop`
still owns its own rounds end-to-end, exactly as §1 requires.

**[TO-BUILD]**:
1. `--wake-on <predicates> --wake-log <path>` on `optimize --fix` (and the `--rounds` loop entry point) —
   wraps the existing `onEvent` sink (`optimize-fix.ts:315-317`) with `matchWake`; append-only, never
   throws, never aborts.
2. `piflowctl wake --tail <path> --on <predicates>` (or reuse the run-wake command with a `--source
   file` mode) — the actual exit-on-first-match primitive, run as a companion process.
3. Exit-code mapping for the driver/loop's own natural termination reasons (`stopped`/`fix-cycle-ceiling`/
   `loop-stopped`) at the `optimize --fix` CLI boundary.

### (c) `settings.json` hook — rejected as the primary, unchanged from the draft

Harness lifecycle hooks (Stop, PostToolUse…) don't fire on external telemetry; a hook would have to *poll*,
reintroducing the streaming posture §1 forbids, and it's harness config the agent can't register per-run.
Viable only as a thin adapter that *launches* mechanism (a) or (b).

### (d) discrete resumable CLI events (`wake-next` blocks, returns, agent loops) — rejected, unchanged

Forces the agent to hold the event loop itself (call → block → return → call again) — precisely the
streaming posture §1 forbids. (a)/(b) push that loop into code (the harness's re-invocation, or the tailing
companion), where it belongs.

**Recommendation: (a) for the run stream, (b) for the optimize stream — same exit-on-first-match primitive,
different attachment point, because only one of the two producers is safe to kill on match.**

---

## 5. THE TWO RULE-SETS as policy instances (counts reconciled)

Same schema, same `matchWake`, two registered policies — coarse for what you can't touch mid-flight, fine
for what you can.

### LIVE-RUN policy (COARSE, 3 predicate objects — 4 when the profile elides the verify gates) — because you cannot act mid-run on a live producer

```json
{ "stream": "run", "predicates": [
  { "on": "status",  "value": ["blocked", "error", "awaiting-input"] },
  { "on": "anomaly", "kind": ["failed", "truncated"] },
  { "on": "run-end" }
] }
```

**Plus, CONDITIONALLY, on a gate-eliding profile** (e.g. `companion` — resolved off `.pi/workflow.json`'s
persisted `profile` field, `runner.ts:536` **[EXISTS]**):

```json
{ "on": "node-finished" }
```

Rationale, grounded:
- A live producer node can only be intervened on at a node boundary (`--from` relaunch; `ARCHITECTURE.md`
  §5, "hot-edits happen at seams, not mid-run," lines 54-56 **[EXISTS]**). Waking the agent on `tool-loop` /
  `context-pressure` / a single `retries` **mid-node** is wasted spend — the reflex owns those (retry.ts,
  the exec watchdog), and the agent can't act on them until the seam anyway. They resurface in the
  authoritative record's `anomalies` list at `run-end` if they mattered; keep them OUT of the default live
  wake.
- **Stall is covered by `status:error`, not a `slow` predicate.** A stalled producer is SIGTERM'd by the
  exec-runner's `stallMs` watchdog and lands as `error` with `killedStall=true`
  (`packages/core/src/runner/status.ts:24,149-150` **[EXISTS]** — `'error' // killed (timeout/stall) or
  nonzero exit or degenerate run`). This is why the wake policy keys on `status:error`, never `slow`.
- **Known live-blind spot [EXISTS, flagged, not silently accepted]:** a *slow-but-not-killed* producer (no
  `stallMs` set, or under threshold) emits **no** live anomaly — `slow` is structurally record-only
  (`liveMetrics()` hardcodes `priorSamples:0`, `telemetry.ts:390-391`). Live wake cannot pre-empt a
  slow-but-alive node; it only catches it at `run-end` via the attached record. Also **`--dead-stall` is
  parsed but inert**: `watch.ts:109` skips the flag's value with a comment that the shared `RunModel` has no
  `updatedAt`/staleness field (`watch.ts:12-16`), so a dead-stall predicate is **[TO-BUILD, blocked on a
  RunModel staleness extension]**. The hard guard in the meantime is the driver's own `--node-timeout`.
- **`killedStall`/`killedTimeout` are NOT a distinct escalate signal — they classify `quality-gap`.**
  `classifyFailure` (`packages/core/src/checks.ts:203-220`) checks `failedChecks` first (→ `quality-gap`,
  line 211), then `if (n.killedStall || n.killedTimeout) return 'quality-gap'` (line 214) — same bucket as
  every other capability/budget miss, by explicit design (the comment above it: "capability/budget misses
  … fall through to quality-gap"). The overlord skill's "a watchdog kill is a clean escalate signal" framing
  needs re-wording to: a watchdog kill surfaces as `status:error` on the wake stream and as `quality-gap` in
  the retry/escalate lane — it is not a separately-typed FailureClass the wake policy can key on more
  precisely than `status:error` already does.
- **`node-finished` is the one PROFILE-CONDITIONAL predicate in this policy.** Default-ON when the run's
  active profile elides the verify gates (e.g. `companion`): with no deterministic gate, "the orchestrator IS
  the verifier — judge each node's artifact against the criteria fixture as it lands" (`.claude/skills/
  piflow-start/SKILL.md` "Profiles" **[EXISTS]**) — the wake policy is the mechanism that makes that law
  actually fire, since without it a landed artifact on a gate-eliding run has NOTHING watching it. Default-OFF
  for the gate-checked profile (e.g. `production`): the deterministic gate already judged the artifact, so
  waking on the same node-close is redundant spend the posture above (§"Scope") already forbids. Sourced from
  the SAME fold as every other row here (`node-close`, §3) — no second stream, no timer.
- **A `node-finished` wake also collapses wake-seam and intervention-seam, unlike every other row in this
  policy.** `node-close` fires exactly at the node boundary — the downstream node has not yet started — so
  there is nothing to queue: the seam the other rows defer to (below) is the SAME point this predicate already
  woke you at.
- **On wake, the action is intervention-seam-gated (§6): queue until the next node boundary, then `--from`
  relaunch.** Never a mid-run mutation. (`node-finished` is the exception noted above — it already wakes AT
  that boundary.)

### OPTIMIZE-LOOP policy (FINE, 5 wake conditions across 2 predicate objects) — disposable candidate, full latitude

```json
{ "stream": "optimize", "predicates": [
  { "on": "optimize", "type": ["fixer-aborted","fix-cycle-ceiling","stopped","loop-stopped"] },
  { "on": "gated", "verdict": "reject" }
] }
```

(Corrected count: **5** conditions — `fixer-aborted`, `fix-cycle-ceiling`, `stopped`, `loop-stopped`,
`gated:reject` — not 6 as the original draft claimed.)

Rationale, grounded:
- The optimize fixer edits a **disposable candidate copy**, off the critical path — killing the *candidate*
  never mutates a live run (`SKILL.md` seam law, "You may abort/kill mid-run ONLY off the critical path …
  the optimize fixer edits a disposable candidate" **[EXISTS]**). So the agent has full latitude to
  *adjudicate* on every decision-grade `OptimizeEvent` — but per §4b, adjudicating is no longer the same
  thing as terminating the process for the non-terminal 4 of these 5.
- Each condition maps to a first-class typed emit site, all verified: `fixer-aborted{node,reason}`
  (`driver.ts:203`, read off the fixer's typed `CandidateEdit.aborted` return per the comment at
  `driver.ts:35`, not the opaque trace payload); `gated{node,verdict}` (`driver.ts:218`);
  `fix-cycle-ceiling{node,cycles,ceiling}` (`driver.ts:187`); `stopped{reason}` (`driver.ts:244`);
  `loop-stopped{reason,roundsRun}` (`loop.ts:140`).
- The product watchdog (`binding-live.mjs`) is the reflex *below* this policy: it SIGTERMs a corrupting
  fixer at its own budgets and surfaces the reason into `fixer-trace.payload` (opaque) + the typed `aborted`
  field the wake keys on. The agent **tunes the watchdog's thresholds** and **reads its reason off the
  typed stream** — it does not replace the watchdog.

**The asymmetry that's the actual point:** the live-run policy wakes on 3 coarse predicate objects (4 on a
gate-eliding profile) because only `run-end` — and, when armed, `node-finished` (it wakes exactly at the
boundary, so there's nothing to queue) — are safe to act on immediately; the remaining 2 gate on a queued seam.
The optimize-loop policy wakes on 5 fine conditions across 2 predicate objects, and (post-§4b correction) only
the 3 terminal ones may end the watched process — the other 2 are pure notifications the loop survives.
Coarse-vs-fine is a real asymmetry; "you can always act immediately on optimize" was too strong and is now
scoped to "you are always notified promptly; you may only ever terminate on the loop's own terminal events."
`node-finished` is the one live-run predicate that shares optimize's "act now" property, and for the same
underlying reason — it fires at a point already safe to act on, not mid-node.

---

## 6. VOCABULARY — wake-seam vs intervention-seam (they nest)

Two distinct seams, previously conflated in both the CLI and the skill:

- **wake-seam** — *the event interface that CALLS the agent.* Any Plane-1 event satisfying the registered
  `WakePolicy`. It fires the harness re-invocation (§4). New concept, this doc. **[TO-BUILD]**
- **intervention-seam** — *the safe node boundary where the agent may ACT on a live producer.* The
  `ARCHITECTURE.md` §5 seam: stop at the boundary → splice the debug/control node → `--from` relaunch the
  suffix, reuse unchanged upstream. **[EXISTS: `docs/ARCHITECTURE.md` §5 lines 48-65; `.claude/skills/
  piflow-overlord/SKILL.md` "seam law" lines 127-132.]**

**Nesting — `wake-seam ⊇ intervention-seam`:**

```
LIVE PRODUCER:   wake-seam fires  ──►  agent adjudicates  ──►  action QUEUED
                 (e.g. blocked          (decide continue/           until next
                  at a node)             abort/rerun/steer)      intervention-seam
                                                                 (--from relaunch)

OPTIMIZE CAND.:  wake-seam fires  ──►  agent adjudicates  ──►  action IMMEDIATE,
                 (gated:reject,                                 loop NOT interrupted
                  fixer-aborted)                                (§4b — the two seams
                                                                  COLLAPSE, but the
                                                                  wake mechanism itself
                                                                  never kills the loop)
```

Every intervention-seam is a valid wake point, but **not every wake is at an intervention-seam** — hence
the gate. For a live producer the Sentinel is *woken* freely but its *action* waits for the node boundary.
For an optimize candidate the two seams collapse (the candidate is entirely off the critical path) — which
is why the optimize policy is fine-grained — but per §4b's correction, "the seams collapse" describes what
the *agent* may do (adjudicate + act now), not a license for the *wake mechanism* to terminate the loop on
a routine event.

**Skill-rewrite consequence:** the overlord decision table (`SKILL.md` lines 118-125) treats every anomaly
as an immediate-action trigger; the seam-law lives in a separate section (127-132) not cross-wired to it.
The rewrite must annotate every `ESCALATE`/`RERUN`/`NUDGE` row for a live producer with **"queue until the
next intervention-seam,"** and mark `optimize` rows **"act immediately (candidate off critical path); the
wake mechanism itself never aborts the loop — only its own terminal events do."** The wake-seam /
intervention-seam distinction is the vocabulary that lets the table say this precisely.

---

## BUILD-STATE TABLE

| Piece | State | Where |
|---|---|---|
| Run stream fold (`watchRun` → `telemetryStream`) | **EXISTS** | `packages/core/src/observe/telemetry.ts:363-462` |
| Edge-triggered anomaly de-dupe (`emitted`/`emitOf`) | **EXISTS** | `telemetry.ts:370,376,413-420` |
| `DEFAULT_THRESHOLDS` (contextPct/toolRepeat/slowRatio/retries) | **EXISTS** | `telemetry.ts:31` |
| `StreamOpts.thresholds` override (core-side) | **EXISTS** (draft mis-tagged this TO-BUILD) | `telemetry.ts:347-350,364` |
| `projectRunDigest` thresholds override (core-side) | **EXISTS** | `telemetry.ts:294-295` |
| CLI wiring: clause → `thresholds` object, threaded into the stream call | TO-BUILD | new wake command; `telemetry.ts:155` currently omits it |
| `awaiting-input` anomaly/event passthrough | TO-BUILD | `telemetry.ts` `TERMINAL` set (354) + `detectAnomalies` (154-179) |
| `node-close` `TelemetryEvent` (node-lifecycle signal — fires on EVERY terminal status, healthy or not) | **EXISTS** | `telemetry.ts:337-343` (union), `:451-455` (yielded), de-dupe `:372` |
| `node-finished` `WakePredicate` (matches `node-close`) | TO-BUILD | new `packages/core/src/observe/wake.ts` — the event exists, the predicate does not |
| Profile→default-wake-policy conditioning (`node-finished` armed only when the active profile elides the verify gates) | TO-BUILD, mechanism scoped as an open decision | reads `.pi/workflow.json` `profile` (`runner.ts:536`, **EXISTS**) / `RunStatus.profile` (`status.ts:214`, **EXISTS**); cross-referencing "elides gates" against `profiles[name].elidePhases` (`template/types.ts:151-153`, **EXISTS** as data) is the piece not yet designed |
| `toolCalls` metric predicate | **NOT BUILDING** (no threshold, no live path — terminal-only via `node-close.digest.toolCalls`) | `telemetry.ts:70,451-456` |
| `node-enriched` forwarding inside `telemetryStream` | does not exist, not needed for the wake seam | `telemetry.ts:430-461` (no case for it) |
| `WakePolicy` / `WakePredicate` schema | TO-BUILD | new `packages/core/src/observe/wake.ts` |
| `matchWake(policy, ev)` pure matcher | TO-BUILD | new `packages/core/src/observe/wake.ts` |
| `wake --on <predicates>` over the run stream (local + remote), exits on first match | TO-BUILD | new sibling to `packages/cli/src/watch.ts`, binds `telemetryStream` per §3 |
| `WatchResult` → `process.exitCode` mapping | TO-BUILD (small, real bug) | `packages/cli/src/watch.ts:99-128`, esp. line 123 discarding the result |
| `--dead-stall` staleness | TO-BUILD, blocked on a `RunModel` extension | `watch.ts:12-16,109` (currently parsed-but-inert) |
| Remote local/remote dispatch for the wake command | **EXISTS** (reusable pattern) | `watch.ts:113-126`, `remote.ts:142-144` |
| DR7 `RUN_UPDATE_KINDS` allowlist (must extend for any new raw kind) | **EXISTS** | `remote.ts:41` |
| Remote authoritative digest (`rootCauses`/`slow`) attachment | TO-BUILD, needs a server endpoint OR scope to local-only | none yet — `buildRunView(dir)` is local-fs-only |
| `OptimizeEvent` union (already decision-grade, no fold needed) | **EXISTS** | `packages/core/src/optimize/events.ts:12-29` |
| `fixer-aborted` emit (typed, off `CandidateEdit.aborted`) | **EXISTS** | `packages/core/src/optimize/driver.ts:203` (typed contract noted at line 35) |
| `gated` emit | **EXISTS** | `driver.ts:218` |
| `fix-cycle-ceiling` emit | **EXISTS** | `driver.ts:187` |
| `stopped` emit (driver's own terminal event) | **EXISTS** | `driver.ts:244` |
| `loop-stopped` emit (loop's own terminal event) | **EXISTS** | `packages/core/src/optimize/loop.ts:140` |
| `runOptimizeLoop`'s own converged/stalled/circuit-broken stop | **EXISTS** — must NOT be duplicated by the agent | `loop.ts:100-140` |
| `onEvent` sink wiring on `optimize --fix` (`--watch`/`--watch-json`) | **EXISTS** | `packages/cli/src/optimize-fix.ts:315-317,324` |
| `--wake-on --wake-log <path>` append-only sink for optimize (never aborts) | TO-BUILD | wraps `optimize-fix.ts:315-317`'s `onEvent` |
| `wake --tail <path>` companion (exit-on-first-match over a file, not a live stream) | TO-BUILD | reuse the run-wake command's matcher with a file source |
| Exit-code mapping for the driver/loop's own terminal reasons | TO-BUILD | `optimize --fix` CLI boundary |
| `killedStall`/`killedTimeout` → `quality-gap` classification | **EXISTS** (informs skill wording, not a build item) | `packages/core/src/checks.ts:203-220` |
| ARCHITECTURE.md §5 seam law (intervention-seam definition) | **EXISTS** | `docs/ARCHITECTURE.md:48-65` |
| Overlord skill seam law + decision table | **EXISTS but NOT cross-wired** — rewrite needed | `.claude/skills/piflow-overlord/SKILL.md:118-132` |
| Overlord skill rewrite (Sentinel posture, wake-seam vocabulary, two policies, seam-law cross-wire) | TO-BUILD | `.claude/skills/piflow-overlord/SKILL.md` |

---

## Open risks / gaps to file, not guess around

1. Slow-but-alive producer is live-blind by design (`slow` is record-only); wake only catches it at
   `run-end`.
2. `--dead-stall` is inert until `RunModel` carries staleness — a real gap, not yet scheduled.
3. Remote wake digest cannot carry `rootCauses`/`slow` without a new server endpoint; must ship scoped to
   "matched-event-only on remote" rather than silently degrading.
4. Any new `RunUpdate` kind (e.g. if `awaiting-input` were implemented as a raw kind instead of a
   `TelemetryEvent` anomaly) must be added to `remote.ts:41`'s `RUN_UPDATE_KINDS` or it is silently dropped
   over SSE — the allowlist is additive-invariant, not automatic.
5. The optimize wake's tailing companion (§4b) is a new process-lifecycle shape (spawned alongside
   `optimize --fix`, must be reaped when the parent exits) — needs a concrete spawn/cleanup contract before
   it ships, not just "a companion process."
6. **"Does profile `<name>` elide the verify gates" has no resolved mechanism yet** — `profiles[name]
   .elidePhases` (`template/types.ts:151-153`) names elided PHASES, not a boolean "this profile skips
   verification." Cross-referencing an elided phase against which phases are gate/verify nodes is a small,
   real design decision `node-finished`'s default-policy wiring depends on; not guessed past here.
