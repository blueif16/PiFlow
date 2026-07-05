# Overlord Wake-Seam — Implementation Build Plan

> **Status:** PLAN ONLY — nothing in this document is implemented yet. It is the build contract for
> `packages/core` + `packages/cli`. The skill-vocabulary rewrite (wake-seam vs intervention-seam in
> `piflow-overlord`'s SKILL.md / decision table) is explicitly OUT OF SCOPE for this plan — it is a
> follow-on once the mechanism below ships, listed in §7, not a numbered build step.
> **Grounding:** every file:line cited below was re-read directly against this worktree
> (`fix/run-layout-self-contained`) while authoring this plan — not copied from the upstream ground
> report unverified. Two corrections vs. that report are called out inline where the code already
> does more than it credited (§2.2, §2.5).
> **Prior art this plan builds on:** the DESIGN SPEC passed into this task (the three-plane frame,
> the wake-seam/intervention-seam split, the two policy instances) is the architecture; this document
> is its literal build sequence — files, functions, signatures, test files, in order.

---

## 0. What "the wake-seam" is, in one paragraph

Today, an agent that wants to supervise a live run or an optimize pass has exactly one option:
hold a `for await` loop open on the whole event stream for the run's duration (`piflowctl telemetry
--watch`, `packages/cli/src/telemetry.ts:155-157`) — burning a process and a context window on every
event, including the ones nobody needs to act on. The wake-seam replaces this with **a declarative
predicate set (`WakePolicy`) evaluated by a pure processor (`matchWake`) against the two streams that
already exist** (`TelemetryEvent` from `telemetryStream`, `OptimizeEvent` from the optimize driver),
wired into a CLI surface that **exits the process the instant a predicate matches** so the harness
that spawned the watcher can re-invoke the agent with the matched event as its wake reason. No new
detection logic is added anywhere — this is a routing/exit layer over signals that are already
computed.

---

## 1. The exact new artifact — `WakePolicy` + `matchWake`

### 1.1 File: `packages/core/src/observe/wake.ts` (NEW)

This is the one new source file at the core of the whole plan. It is pure — no I/O, no async, no
knowledge of `watchRun`/`telemetryStream`/the optimize driver beyond their already-exported event
types. That purity is what makes it the first safe slice (§6).

```ts
import type { NodeStatus } from '../runner/status.js';       // status.ts:18-27 [EXISTS]
import type { AnomalyKind, TelemetryEvent } from './telemetry.js'; // telemetry.ts:33, 337-343 [EXISTS]
import type { OptimizeEvent } from '../optimize/events.js';  // events.ts:12-29 [EXISTS]

/** One OR-branch of a wake policy. Every predicate keys on a field the stream ALREADY carries —
 *  no new detection is introduced here; this is a projection, not a second collector. */
export type WakePredicate =
  | { on: 'status'; value: NodeStatus[] }                       // matched off a run-stream node-status forward (§2.1)
  | { on: 'anomaly'; kind: AnomalyKind[] }                       // TelemetryEvent {kind:'anomaly'} (telemetry.ts:341)
  | { on: 'run-end' }                                            // TelemetryEvent {kind:'run-end'} (telemetry.ts:343)
  | { on: 'node-finished' }                                      // TelemetryEvent {kind:'node-close'} — ALREADY
                                                                  // emitted by telemetryStream on every terminal
                                                                  // status (telemetry.ts:342,451-455 [EXISTS]).
                                                                  // Takes no value, like run-end. Whether it's in
                                                                  // the DEFAULT run policy is profile-conditional
                                                                  // (Step 3b) — matchWake itself stays profile-blind.
  | { on: 'optimize'; type: OptimizeEvent['type'][] }            // any OptimizeEvent by discriminant (events.ts:12-29)
  | { on: 'gated'; verdict: 'accept' | 'reject' };                // sugar: OptimizeEvent{type:'gated'} + verdict.accept

export interface WakePolicy {
  stream: 'run' | 'optimize';
  /** OR-composed: the policy fires on the FIRST predicate any incoming event satisfies. */
  predicates: WakePredicate[];
}

export type WakeReasonClass =
  | 'done' | 'node-failed' | 'anomaly' | 'awaiting-input' | 'node-finished' // run stream
  | 'gated-reject' | 'fixer-aborted' | 'fix-cycle-ceiling' | 'loop-stopped' | 'optimize-stopped'; // optimize stream

export interface WakeMatch {
  reasonClass: WakeReasonClass;
  predicate: WakePredicate;
  /** the raw event that satisfied the predicate — handed to the agent verbatim, no re-shaping. */
  event: TelemetryEvent | OptimizeEvent;
  nodeId?: string;
}

/** Pure, O(predicates) per event. Discriminates TelemetryEvent (`.kind`) from OptimizeEvent (`.type`)
 *  — the two producers never collide on that field, so no wrapper/tag is needed. Returns the FIRST
 *  matching predicate (policy order = priority order) or null. */
export function matchWake(policy: WakePolicy, ev: TelemetryEvent | OptimizeEvent): WakeMatch | null;

/** Compact CLI grammar: `"status:blocked,error,awaiting-input; anomaly:failed,truncated; run-end"`
 *  → WakePolicy. Clauses separated by `;`, OR-composed. Throws a descriptive error on an unknown
 *  clause head or an unknown enum value (fail loud, never silently drop a typo'd predicate). */
export function parseWakePolicy(stream: 'run' | 'optimize', spec: string): WakePolicy;

/** WakeReasonClass → process exit code, the CLI-facing contract (§4 table). Pure lookup, kept here
 *  (not in the CLI package) so core owns the one canonical mapping and both `watch.ts` and
 *  `optimize-fix.ts` import the SAME table instead of hand-rolling two. */
export function wakeExitCode(cls: WakeReasonClass): number;
```

**Why `status` needs a run-stream forward that does not exist yet today (dependency, not a flaw in
the design):** `TelemetryEvent` has no `node-status` variant — the only status-shaped signal it emits
is the `failed` anomaly (`isFailed`, `telemetry.ts:151`, `blocked`/`error` only) and `node-close.digest.
outcome` (`telemetry.ts:342,454-455`, only on a *terminal* status). `awaiting-input` is a **non-terminal**
`NodeStatus` (`status.ts:26`) that `telemetryStream`'s `TERMINAL` set (`telemetry.ts:354`,
`{ok,reused,gap,blocked,error,dry}`) explicitly excludes — so a checkpoint pause produces **zero**
`TelemetryEvent`s today. `matchWake`'s `status` predicate is unusable for `awaiting-input` (or for
`pending`/`running`, which nobody needs to wake on) until Step 2 below exists. This is why Step 2 is
ordered before the CLI wiring steps (3–4), not after: **build the matcher pure and test it against
synthetic events first (Step 1); only then extend the real producer to emit what Step 1 assumes
exists (Step 2); only then wire a live command to it (Steps 3–4).**

**`node-finished` is the OPPOSITE case — the event it needs already exists, nothing to forward.**
`telemetryStream` already yields `{ kind: 'node-close', digest }` on every `TERMINAL` status, not only
`blocked`/`error` (`telemetry.ts:342` the union member, `:451-455` where it's yielded, gated by its own
`closed` de-dupe Set at `:372` **[EXISTS]**). So `matchWake`'s `node-finished` predicate is testable
against real-shaped synthetic events from day one, in Step 1, alongside `status`/`anomaly`/`run-end` — it
needs no Step-2-style producer extension. What it DOES need, uniquely among these predicates, is a
CALLER that decides whether to register it by default — that's profile data, not stream data, and it is
why the profile-conditional default-policy wiring is its own step (Step 3b) landing AFTER Step 3, not
folded into Step 1's "pure matcher, zero I/O" scope.

### 1.2 Export via `packages/core/src/observe/index.ts` and `packages/core/src/index.ts`

Add one line to each, mirroring the existing telemetry export block exactly:

- `packages/core/src/observe/index.ts:31-32` (immediately after the `telemetryStream`/`TelemetryEvent`
  export block) — add:
  ```ts
  export { matchWake, parseWakePolicy, wakeExitCode } from './wake.js';
  export type { WakePolicy, WakePredicate, WakeMatch, WakeReasonClass } from './wake.js';
  ```
- `packages/core/src/index.ts:356-357` (the root re-export block that already forwards
  `projectRunDigest, telemetryStream, ...`) — add the same two lines. `OptimizeEvent` is already
  exported from the root (`index.ts:396-433` block); no new optimize-side export is needed since
  `wake.ts` only *imports* `OptimizeEvent`, it doesn't redefine it.

---

## 2. Ordered build steps

Each step is independently buildable, independently testable, and — except Step 3, which is a
deliberate behavior-preserving refactor — additive (nothing existing changes shape).

### Step 1 — `matchWake` + `WakePolicy` + `parseWakePolicy` + `wakeExitCode` (pure, core) — **THE FIRST SAFE SLICE, see §6**
- **File:** `packages/core/src/observe/wake.ts` (new).
- **Includes `node-finished`.** Unlike `awaiting-input` (Step 2), the event `node-finished` matches
  (`TelemetryEvent{kind:'node-close'}`) already exists in `telemetryStream` today
  (`telemetry.ts:342,451-455`) — there is no producer to extend, so the predicate needs no Step-2-style
  follow-on and ships in this first slice alongside `status`/`anomaly`/`run-end`. `matchWake` stays
  profile-blind: it matches `{on:'node-finished'}` against any `node-close` event unconditionally. WHETHER
  that predicate is in a given run's default policy is a separate, profile-aware concern — Step 3b, below —
  that never touches this file's purity.
- **Test:** `packages/core/test/wake.test.ts` (new) — TEST-FIRST, see §5.1. No filesystem, no
  `watchRun`, no real `telemetryStream`/driver invocation — synthetic `TelemetryEvent[]` and
  `OptimizeEvent[]` fixtures only (the exact idiom `packages/core/test/optimize-events.test.ts:15-32`
  already uses for `OptimizeEvent`).
- **Depends on:** nothing beyond the two already-exported event unions.
- **Risk:** none — net-new file, zero call sites, cannot regress anything that exists.

### Step 2 — forward `awaiting-input` through `telemetryStream` (small, core)
- **File:** `packages/core/src/observe/telemetry.ts`.
- **Change:** `telemetryStream`'s `node-status` branch (`telemetry.ts:448-456`) currently only acts
  on a status once it's in `TERMINAL` (line 451) or to re-run `fireAnomalies` (line 450, a no-op for
  `awaiting-input` since `detectAnomalies` has no clause for it, `telemetry.ts:154-179`). Add ONE new
  case: when `u.status === 'awaiting-input'` and it hasn't been announced yet for this node, yield a
  new `TelemetryEvent` variant.
  - **Type change:** extend the `TelemetryEvent` union at `telemetry.ts:337-343` with
    `| { kind: 'node-status'; nodeId: string; status: NodeStatus }`. Keep this the ONE passthrough
    variant (not a general-purpose status mirror of everything — `running`/`pending` stay unyielded;
    only `awaiting-input` triggers it, gated by a `Set<string>` de-dupe symmetrical to `emitted`
    at `telemetry.ts:370` so it fires once per node, matching every other edge-triggered signal in
    this file). Document the "why only awaiting-input" rationale inline (mirrors the existing
    `// the slow anomaly needs cross-run history...` comment style at `telemetry.ts:358-361`).
- **Test:** extend `packages/core/test/telemetry.test.ts` — a `watchRun`-shaped fixture stream with a
  `node-status: awaiting-input` delta must yield exactly one `{kind:'node-status', status:
  'awaiting-input'}` event and no duplicate on a second identical delta.
- **Correction vs. the upstream ground report:** the report flagged *both* `awaiting-input` forwarding
  **and** a `thresholds` override as `[TO-BUILD]`. Re-reading `telemetry.ts:347-352` and `:364`
  directly: `StreamOpts.thresholds?: Partial<TelemetryThresholds>` **already exists** and is already
  merged (`{ ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) }`, line 364). Only the
  `awaiting-input` forward is real work — drop the thresholds item from scope entirely (a
  `matchWake({on:'metric', field:'contextPct', gte: 0.9})` predicate is satisfiable today by a
  caller passing `{ thresholds: { contextPct: 0.9 } }` straight into `telemetryStream`, no core
  change needed).
- **Depends on:** Step 1 (so the new event shape has somewhere to be consumed/tested against, though
  it can technically land in parallel — order it after Step 1 to keep the PR sequence test-first
  end-to-end).
- **Risk:** low — additive union member; every existing `switch(ev.kind)` / `renderEvent`-style
  consumer must gain a case or hit a TS exhaustiveness error, which is the safety net, not a risk.
  Grep-check consumers before landing: `packages/cli/src/telemetry.ts`'s `renderEvent`
  (`telemetry.ts:110-125` in the CLI package) switches on `TelemetryEvent.kind` and will need a new
  case (even a no-op one) or TypeScript's `never` exhaustiveness check fails the build — this is the
  intended compile-time catch, not a surprise.

### Step 3 — replace `watch.ts`'s hardcoded predicate with `matchWake`, stop discarding `WatchResult` (CLI, behavior-preserving refactor)
- **File:** `packages/cli/src/watch.ts`.
- **Change A (mechanism swap, behavior UNCHANGED by default):** replace the two hardcoded
  `if (u.kind==='snapshot'/'node-status'/'done')` branches (`watch.ts:76-92`) with a loop over
  `matchWake(policy, ev)` where `ev` is now **`telemetryStream`'s output**, not the raw `RunUpdate`
  from `coreWatchRun` directly (this is the "downstream of telemetryStream" placement — see the
  design's §3 rationale: reuse the one accumulator, never fork a second one). Concretely,
  `watchRun()`'s `source` (currently `opts.updates ?? coreWatchRun(...)`, `watch.ts:63-64`) is wrapped:
  `const events = telemetryStream(source, {})`. Define `DEFAULT_RUN_WAKE_POLICY` in `wake.ts` (or
  inline in `watch.ts`) to reproduce **today's exact two predicates** — `{on:'status', value:
  ['blocked','error']}` (via the `failed` anomaly, since raw `node-status` isn't in `TelemetryEvent`
  pre-Step-2 for non-awaiting-input statuses — actually: today's `isFailed` check in `watch.ts:45`
  already only tests `blocked`/`error`, which is exactly what the `failed` AnomalyKind covers, so
  `{on:'anomaly', kind:['failed']}` is the literal equivalent) and `{on:'run-end'}`. `awaiting-input`
  is **NOT** added to the default — it stays opt-in via an explicit `--wake-on`, so existing behavior
  does not silently change for a consumer who never passes the new flag.
- **Change B (the actual bug fix, flagged in both ground reports):** `runWatchCli` (`watch.ts:123`)
  currently does `await watchRun(...)` and **discards the returned `WatchResult`** — the process
  always exits 0. Fix: `const result = await watchRun(...); process.exitCode = wakeExitCode(...)`
  mapped from `result.reason`/the matched predicate's `reasonClass`. This turns "the sentinel fired"
  into an externally observable signal for the FIRST time — the load-bearing fix this whole plan
  exists to deliver on the run-stream side.
- **Change C (new flags):** add `--wake-on '<clauses>'` (parsed via `parseWakePolicy('run', spec)`,
  overriding `DEFAULT_RUN_WAKE_POLICY`) and `--wake-policy <file.json>` (reads+`JSON.parse`s a
  `WakePolicy` literal — for a predicate set too long for one flag) to the arg loop at
  `watch.ts:104-111`. On match, print the JSON digest (§4) instead of (or in addition to, gated by a
  `--wake-json` flag mirroring optimize's `--watch-json`) the existing human line — reuse the
  existing `print`/`fire` injection seam (`watch.ts:62,66-70`) so this stays testable with the same
  `updates`/`print` fixture pattern the file already documents in its own header comment
  (`watch.ts:1-10`).
- **Test:** extend `packages/cli/test/watch.test.ts` — see §5.2. **Every existing test in this file
  must still pass unmodified** (the behavior-preservation contract for Change A/B).
- **Depends on:** Steps 1–2.
- **Risk:** medium — this is the one step touching a shipped, tested command's internals. Mitigate by
  keeping Change A's default policy byte-equivalent to today's `isFailed` check (verified by the
  unmodified-existing-tests requirement above) and landing Change B (the exit-code fix) as its own
  commit, separable from Change A/C, since it is a real (if minor) behavior change on its own — a
  caller that relied on `piflowctl watch` always exiting 0 (unlikely, but possible in a shell script
  that ignores `$?`) would newly see nonzero. Call this out in the changeset.

### Step 3b — profile-conditional `node-finished` in the default LIVE-RUN wake policy (CLI, additive)
- **File:** `packages/cli/src/watch.ts` (extends Step 3's `DEFAULT_RUN_WAKE_POLICY` construction).
- **Change:** before arming the default policy, read the run's active profile — `.pi/workflow.json`'s
  persisted `profile` field (written at `runner.ts:536` **[EXISTS]**; the same value is mirrored on
  `RunStatus.profile`, `status.ts:214` **[EXISTS]**) — and cross-reference it against the template's
  declared `profiles[name].elidePhases` (`template/types.ts:151-153` **[EXISTS]** as data) to decide
  whether that profile elides the verify-gate phases. If it does, `DEFAULT_RUN_WAKE_POLICY` additionally
  includes `{on:'node-finished'}`; if it doesn't (including the no-profile / full-DAG case), the default
  stays exactly what Step 3 shipped — `node-finished` is OFF. **Resolving "which phases are gate/verify
  phases" is a small, real design decision this step must make explicit, not guess past** (flag it in the
  PR description; do not silently assume a naming convention like `phase startsWith 'verify'` without
  confirming it against the template schema).
  An explicit `--wake-on 'node-finished'` (or a clause naming it inside `--wake-policy`) always arms it,
  regardless of profile — the conditionality is only on the DEFAULT, never a ceiling on what an operator
  can request.
- **No timer, no polling, anywhere in this step.** The predicate itself (Step 1) is purely edge-triggered
  off the `node-close` event; this step only changes which STATIC set of predicates gets registered before
  the stream starts. Nothing here reads a clock or sets an interval.
- **Test:** extend `packages/cli/test/watch.test.ts` — see §4.3b. A fire/no-fire PAIR keyed on profile, not
  on the event: the SAME `node-close` event, against a fixture run recorded with `profile: 'companion'`
  (gate-eliding) → the default policy wakes; against a fixture run recorded with `profile: 'production'`
  (or no profile) → the default policy does NOT wake on that event (it still wakes on `status`/`anomaly`/
  `run-end` as before — this is an ADDITION to the default, not a replacement).
- **Depends on:** Step 1 (the `node-finished` predicate must exist) and Step 3 (the `DEFAULT_RUN_WAKE_POLICY`
  construction site and the profile-plumbing point it extends).
- **Risk:** low — additive to a policy CLI callers already opt into via `--wake-on`/defaults; the only real
  risk is under-scoping "elides gates" (flagged above) and shipping a heuristic that silently mis-classifies
  a product's profile. Land the cross-reference mechanism as its own reviewable commit, separate from the
  predicate itself (Step 1) and the policy-plumbing refactor (Step 3), so a wrong heuristic is easy to
  revert without touching either.

### Step 4 — wire `matchWake` into `optimize --fix`'s `onEvent` sink (CLI, additive)
- **File:** `packages/cli/src/optimize-fix.ts`.
- **Change:** the `onEvent` sink is already the exact seam (`optimize-fix.ts:315-317`):
  ```ts
  const onEvent: OptimizeEventSink | undefined = args.watch
    ? (e) => print(args.watchJson ? JSON.stringify(e) : renderOptimizeEvent(e))
    : undefined;
  ```
  Add a parallel, independent `--wake-on <clauses>` flag. When present, wrap (or replace) `onEvent`
  with a closure that calls `matchWake(policy, e)` per event; on the first match, print the JSON
  digest and **abort the loop** — `runFixGate`/`fixGate` has no built-in cancellation today
  (confirmed: `FixGateOpts` has no `signal`), so the wiring must either (a) throw a sentinel error
  from inside `onEvent` and catch it at the `await fixGate(...)` call site (`optimize-fix.ts:325`),
  since `safeEmit` (`driver.ts:170-173`) only swallows a *throw from the sink into the driver*, not a
  throw the driver re-raises — confirm this contract in Step 4's own test before relying on it (do
  NOT assume; `safeEmit`'s swallow behavior is exactly why a naive `process.exit()` inside `onEvent`
  is the simpler, more certain mechanism for a CLI process — see §4's recommendation), or (b) call
  `process.exit(wakeExitCode(...))` directly from inside the sink, matching `watch.ts`'s exit-driven
  contract precisely and sidestepping the swallow question entirely. **Prefer (b)** — same mechanism
  on both stream sides, one exit-code table (`wakeExitCode`, defined once in core), no dependency on
  `runFixGate`'s internal error-swallowing behavior holding.
- **Test:** extend `packages/cli/test/optimize-fix-cli.test.ts` — see §5.3, reusing the FAKE binding
  + `onEvent` capture idiom already in that file (`optimize-fix-cli.test.ts:378-401`).
- **Depends on:** Step 1 only (the optimize stream needs no `telemetryStream`/awaiting-input work —
  `OptimizeEvent` is already fully typed and decision-grade, per the ground report's §(1)).
- **Risk:** low-medium — `process.exit()` inside a callback mid-loop is a real behavior change
  (in-flight fixer subprocess handling); flag explicitly that Step 4 must confirm no orphaned child
  process survives the exit (the game-omni `binding-live.mjs` fixer spawns `claude` via `spawn()` —
  check whether it's detached; if so, Step 4 needs a `child.kill()` in the exit path, which is a
  scope question to raise with the human before landing, not to guess past).

### Step 5 — sibling wiring for `optimize --rounds --watch` (CLI, additive, optional for v1)
- **File:** `packages/cli/src/optimize-loop.ts`.
- **Change:** identical shape to Step 4, applied to the shared `onEvent` sink at
  `optimize-loop.ts:105-107` (which already receives both per-fix events from `fixGate` and the
  round-boundary events from `runOptimizeLoop` on the SAME sink). No new logic — literally the same
  `matchWake` + exit closure, parameterized by whichever `WakePolicy` was parsed.
- **Test:** extend `packages/cli/test/optimize-loop-cli.test.ts`, same shape as Step 4's test.
- **Depends on:** Step 4 (reuses its exit closure verbatim — extract it as a small shared helper,
  e.g. `makeWakeSink(policy, print)` in a place both CLI files can import, rather than duplicating the
  `process.exit` closure twice).
- **Risk:** low — same mechanism, second call site. Marked optional-for-v1 because Step 4 alone
  already delivers the fine-grained optimize policy end to end for the single-shot path; multi-round
  is a straightforward extension once Step 4 is proven, not a blocker to shipping v1.

### Step 6 — attach the authoritative digest on a run-stream match
- **File:** `packages/cli/src/watch.ts` (the `fire()` closure / the new match-handling branch from
  Step 3).
- **Change:** on a **run**-stream match (not optimize), additionally compute
  `projectRunDigest(buildRunView(dir))` (`telemetry.ts:294`, both already exported from core) and
  fold it into the JSON payload the CLI prints — this is what supplies `rootCauses`
  (`localizeRootCauses`, RECORD-only, `telemetry.ts:250-291`) and the `slow` anomaly (record-only per
  `telemetry.ts:358-361`) that the live stream structurally cannot produce (§ground report). This is
  exactly what `runTelemetryCli` already does *after* its loop ends (`packages/cli/src/telemetry.ts:
  161-162`) — Step 6 does the identical call, just at match-time instead of stream-end-time.
- **Test:** a `watch.test.ts` case with a real on-disk fixture run dir (mirroring the existing
  `buildRunFixture` helper, `packages/cli/test/fixture.js`, already used by `cli/test/watch.test.ts:6`)
  asserting the printed JSON on a `run-end` match contains a `rootCauses` field sourced from
  `buildRunView`, not just the live `TelemetryEvent`.
- **Depends on:** Step 3.
- **Risk:** low — additive field on the digest; remote/local dispatch is unaffected since
  `buildRunView` already works off the local `dir` the same way `telemetry`'s post-loop record does.

### Step ordering summary

```
1 (pure matcher, core, incl. node-finished)  ──┬──► 3 (watch.ts wiring)  ──► 3b (profile-conditional default)
                                                │                        └─► 6 (digest attach)
                                                │
                                                └──► 2 (awaiting-input forward, core) ──► 3
                                                │
                                                └──► 4 (optimize-fix.ts wiring) ──► 5 (optimize-loop.ts wiring)
```

Steps 1 and 2 can land as two small core PRs in sequence (2 depends on 1 only for test-sequencing
discipline, not a real code dependency). Steps 3 and 4 can proceed in parallel once 1 (+2 for 3) are
merged, since they touch disjoint CLI files. Step 6 depends only on 3. Step 5 depends only on 4. Step 3b
depends on 1 (the predicate) and 3 (the default-policy construction site it extends) and should land
strictly after 3 — it changes what Step 3's tests must assert (the new-vs-existing default split, §4.3b),
so extending an already-green Step 3 is safer than folding it in.

---

## 3. The recommended per-event wake mechanism (already decided by the ground report — recorded here as the literal contract)

**`piflowctl watch <rundir> --wake-on '<predicates>'` for the run stream, and `piflowctl optimize
--fix --wake-on '<predicates>'` for the optimize stream — each exits the process on the first matched
event, with a reason-encoding exit code.** No third universal `piflowctl wake` command is introduced
in v1 (the design's §4 "alternative composition" — `optimize --fix --watch-json | piflowctl wake
--on '…'` over stdin — is noted as a viable future unification but is NOT part of this plan; it would
require `telemetry --watch` to finally honor `--json` in its stream loop, a separate, unscoped fix
flagged in the ground report at `telemetry.ts:155-157` and left as a follow-on, not a build step here).

### 3.1 Exit-code contract (`wakeExitCode`, `packages/core/src/observe/wake.ts`)

| code | `WakeReasonClass` | fires from |
|---|---|---|
| 0 | `done` | run-end, ok |
| 10 | `node-failed` | `status`/`anomaly:failed` predicate |
| 11 | `anomaly` | `anomaly` predicate (truncated/tool-loop/context-pressure/retries) |
| 12 | `awaiting-input` | `status` predicate (Step 2-dependent) |
| 13 | `node-finished` | `node-finished` predicate (Step 1; profile-conditional default, Step 3b) |
| 20 | `gated-reject` | `gated` predicate |
| 21 | `fixer-aborted` | `optimize` predicate |
| 22 | `fix-cycle-ceiling` | `optimize` predicate |
| 23 | `loop-stopped` / `optimize-stopped` | `optimize` predicate |
| 3 | (existing `aborted` `WatchReason`, `watch.ts:21`) | stream ended pre-terminal (signal abort) |

This table is a pure function (`wakeExitCode`), not a CLI-local `switch`, specifically so `watch.ts`
and `optimize-fix.ts`/`optimize-loop.ts` cannot drift into two different numberings for the same
`WakeReasonClass`.

### 3.2 Why exit-on-match over the alternatives (recorded, not re-litigated — see the passed-in DESIGN §4 for the full comparison)

- A `settings.json` hook fires on harness lifecycle events, not external telemetry — would have to
  poll, reintroducing the very streaming posture this plan deletes.
- A blocking "wake-next" call that returns and loops forces the agent to hold the event loop itself —
  the same anti-pattern `telemetry --watch` already demonstrates is wrong for an LLM caller.
- Exit-on-match is the only option where the *harness* (not the agent) owns the loop, and process
  exit is already a first-class notification primitive every orchestration layer understands.

### 3.3 DR7 caveat (remote/SSE — no new work required, just an invariant to preserve)

Any new `RunUpdate`/`TelemetryEvent` kind introduced by Step 2 must be checked against
`RUN_UPDATE_KINDS` (`packages/cli/src/remote.ts:41`, currently `{snapshot, node-status, node-event,
node-enriched, done}`). **Step 2's new `TelemetryEvent` kind (`node-status`) is a `TelemetryEvent`,
not a `RunUpdate`** — it is produced by `telemetryStream`, which runs client-side over whatever
`RunUpdate`s arrive (local or remote). Since `node-status` is already in `RUN_UPDATE_KINDS`
(`remote.ts:41`), the SSE path already forwards the raw `RunUpdate.node-status` the new
`telemetryStream` case consumes — **no `remote.ts` change is required for Step 2.** This is called
out explicitly so nobody "fixes" `remote.ts` unnecessarily.

---

## 4. TEST-FIRST — the meaningful gate for every step

The operative law (from `test-discipline`): **a test has value iff it fails when the behavior is
wrong.** For a predicate matcher, that means every test in this plan is a PAIR — a fire case and a
no-fire case over the SAME predicate — never a fire case alone. A suite with only positive matches
would pass even if `matchWake` matched *everything* unconditionally; the negative case is what proves
the predicate is actually discriminating, not just present.

### 4.1 Step 1 — `packages/core/test/wake.test.ts` (the load-bearing test file)

Structure mirrors the existing `packages/core/test/optimize-events.test.ts` fixture style (a flat
array of every event variant) crossed with the existing `packages/cli/test/watch.test.ts` injectable
generator idiom (`async function* seq(...)`).

Required behaviors (one `it` per row minimum — each is a fire/no-fire PAIR, not a single assertion):

1. **`status` predicate fires on a matching status, not on any other.**
   `matchWake({stream:'run', predicates:[{on:'status', value:['blocked','error']}]}, ev)` where `ev`
   is the Step-2 `{kind:'node-status', nodeId:'w2', status:'blocked'}` → returns a `WakeMatch` with
   `nodeId:'w2'`. The SAME policy against `{kind:'node-status', nodeId:'w2', status:'awaiting-input'}`
   → returns `null`. (Two asserts, one test — or two named tests; either is fine, but BOTH must exist
   in the same file so a reviewer can see the pair.)
2. **`anomaly` predicate fires on a matching kind, not on an unlisted kind.** Policy
   `{on:'anomaly', kind:['failed','truncated']}` against `{kind:'anomaly', anomaly:{kind:'failed',
   nodeId:'w4', detail:'blocked'}}` → matches. Against `{kind:'anomaly', anomaly:{kind:'retries',
   nodeId:'w4', detail:'2 retries'}}` (a REAL `AnomalyKind` the policy did not list) → `null`. This is
   the row that most directly tests "does NOT fire otherwise" — `retries` is a legitimate anomaly,
   not a garbage input, so a matcher that just checks "is this an anomaly event" (ignoring `kind`)
   would wrongly pass it. A test asserting only the positive case would NOT catch that bug.
3. **`run-end` predicate fires on `{kind:'run-end'}` only**, not on `{kind:'node-close', ...}` or any
   other `TelemetryEvent` kind.
4. **`node-finished` predicate fires on `{kind:'node-close'}` only, on ANY terminal status.** Policy
   `{stream:'run', predicates:[{on:'node-finished'}]}` against `{kind:'node-close', digest:{...,
   status:'ok'}}` → matches (the healthy case — this is the row that proves the predicate is NOT folded
   into `anomaly`/`status:blocked,error`, which is the entire point of this predicate existing). The SAME
   policy against `{kind:'anomaly', anomaly:{kind:'failed', nodeId:'w2', detail:'blocked'}}` (a REAL event
   from the same node, wrong kind) → `null`. A matcher that accidentally matched "any terminal-shaped
   event" instead of `kind==='node-close'` specifically would wrongly fire on the anomaly case — that's
   the bug this negative half catches. Also assert a SECOND `node-close` for a DIFFERENT node still fires
   (no accidental single-fire-ever global latch) and a REPEATED `node-close` for the SAME `nodeId` (the
   fold's own de-dupe should already prevent this upstream, but `matchWake` itself must not assume it —
   it should match every `node-close` event it's HANDED, since de-dupe is the fold's job, not the
   matcher's).
5. **`optimize` predicate fires on a listed `OptimizeEvent.type`, not on an unlisted one.** Policy
   `{stream:'optimize', predicates:[{on:'optimize', type:['fixer-aborted','fix-cycle-ceiling']}]}`
   against `{type:'fixer-aborted', node:'w4', reason:'no-progress'}` → matches. Against
   `{type:'fixer-done', node:'w4', editsApplied:1, tokensSpent:10}` (a routine, non-wake-worthy event
   in the SAME stream) → `null`.
6. **`gated` predicate distinguishes accept from reject.** Policy `{on:'gated', verdict:'reject'}`
   against a `{type:'gated', verdict:{accept:false,...}}` → matches; against `{type:'gated',
   verdict:{accept:true,...}}` → `null`. (Reuse the exact `acceptVerdict`/`rejectVerdict` fixtures
   already defined in `packages/core/test/optimize-events.test.ts:12-13` — do not re-invent them.)
7. **OR-composition across multiple predicates.** A policy with two predicates fires on an event
   matching EITHER, and a THIRD event matching neither still returns `null` (proves the matcher
   doesn't accidentally AND its predicate list, and doesn't accidentally match-all once ≥2
   predicates are present).
8. **`parseWakePolicy` round-trips the compact grammar.**
   `parseWakePolicy('run', 'status:blocked,error,awaiting-input; anomaly:failed,truncated')` produces
   a `WakePolicy` for which `matchWake` behaves identically to the hand-built object equivalent (i.e.
   test the PARSER by feeding its output back into `matchWake`'s own fire/no-fire pairs above — not
   by snapshotting the parsed object shape, which would be a copy-the-output assertion the
   test-discipline skill explicitly forbids). Include one deliberately malformed clause
   (`'status:blocked; bogus:foo'`) and assert it throws (fail loud, per §1.1) rather than silently
   dropping the clause. Include `node-finished` in at least one round-trip case (the bare-clause parse,
   no value list — the same shape as `run-end`).
9. **`wakeExitCode` is a total function over every `WakeReasonClass`** — a table-driven test asserting
   each of the 10 classes maps to its documented code (§3.1) and that two different classes never
   collide on the same code (a `new Set(codes).size === codes.length` assertion — this is the
   concrete regression a future "just add one more reason" edit could silently break).

**Mandatory self-check (test-discipline §4, run before trusting this file):** for at least the
`status`, `anomaly`, and `node-finished` rows, hand-flip one comparison in the not-yet-written
implementation (e.g. change `value.includes(ev.status)` to always `true`, drop the `kind` filter, or
change `node-finished`'s check from `ev.kind === 'node-close'` to `ev.kind !== undefined`) and confirm
the corresponding no-fire assertion goes RED. Record which mutation you tried and that it caught it —
this is the proof the negative half of each pair is load-bearing, not decorative.

### 4.2 Step 2 — `packages/core/test/telemetry.test.ts` (extend, don't fork)

- **Fire:** a `watchRun`-shaped `RunUpdate` sequence with a `node-status: awaiting-input` delta
  yields exactly one `{kind:'node-status', nodeId, status:'awaiting-input'}` `TelemetryEvent`.
- **No-fire / de-dupe:** the SAME status repeated in a second delta (e.g. a late-attach snapshot
  re-confirming the same node) yields ZERO additional `node-status` events — proves the de-dupe `Set`
  works, not just that the event CAN fire once.
- **No-fire on unrelated statuses:** a `running`→`ok` transition on a different node in the same
  stream never emits a `node-status` `TelemetryEvent` (only `awaiting-input` is forwarded — this
  guards against someone "helpfully" generalizing the passthrough to every status later without
  updating this plan's stated scope).

### 4.3 Step 3 — `packages/cli/test/watch.test.ts` (extend; existing tests are the regression gate)

- **Regression gate (no new test needed, just: run the file unmodified):** every existing `it` in
  this file (the `done`/`node-failed` cases already shown in the ground report, `watch.test.ts:34-60`)
  must still pass byte-for-byte after Step 3 lands. This IS the test that proves Change A's default
  policy is behavior-preserving — if any existing assertion changes, the refactor broke the contract
  it promised to preserve.
- **New fire/no-fire pair for `--wake-on`:** using the same injectable `seq(...)` + `print`
  capture idiom (`watch.test.ts:13-15,36-39`), drive a `WatchOpts`-equivalent call with
  `--wake-on 'status:awaiting-input'` (once Step 2 lands) through a stream containing a
  `node-status: awaiting-input` delta → asserts the process-level result carries `reasonClass:
  'awaiting-input'` and `process.exitCode === 12` (§3.1). The SAME policy against a stream that never
  reaches `awaiting-input` (only `running`→`ok`) → asserts the stream drains to `done` with
  `exitCode === 0`, i.e. the wake predicate did NOT fire early and steal the terminal event. This
  second half is the one that proves "does not fire otherwise" at the CLI-process level, not just the
  pure-matcher level — a bug where the wiring calls `matchWake` on every event but ignores its `null`
  return (always exits on the first call) would pass every Step-1 test yet fail exactly this case.

### 4.3b Step 3b — `packages/cli/test/watch.test.ts` (extend; the load-bearing PROFILE fire/no-fire pair)

This is the test the missing requirement actually turns on: **`node-finished` must wake ONLY when the
run's profile elides the verify gates, never otherwise, and never off a clock.**

- **Fire (gate-eliding profile):** a fixture run recorded with `profile: 'companion'` (a fixture
  `.pi/workflow.json`/`RunStatus` carrying that profile name, cross-referenced per Step 3b against a
  fixture `meta.json` whose `companion` profile elides a verify phase), driven through the injectable
  `seq(...)` with a single `{kind:'node-close', digest:{status:'ok', ...}}` event and NO `--wake-on` flag
  (default policy only) → asserts `process.exitCode === 13` and `reasonClass: 'node-finished'` — the
  DEFAULT policy woke on a clean completion, unprompted.
- **No-fire (gate-checked profile):** the IDENTICAL `node-close` event, against the IDENTICAL default
  policy construction, but the fixture run is recorded with `profile: 'production'` (or no profile at
  all) → asserts the stream drains past that event with NO exit and no `node-finished` match; the run
  only terminates on its actual `run-end`, `exitCode === 0`. This is the pair that proves the
  conditionality is real — a wiring bug that always includes `node-finished` in the default (ignoring
  profile entirely) would pass the fire case above but fail this one.
- **No-timer proof:** drive both cases above through a **synthetic, already-fully-buffered
  `async function* seq(...)`** (the exact idiom `watch.test.ts` already uses) with NO `setTimeout`, NO
  `vi.useFakeTimers()`/`vi.advanceTimersByTime()`, and no `await sleep(...)` anywhere in the test or the
  implementation under test — the match must resolve the instant the generator yields the `node-close`
  event, in the same tick-driven `for await` the rest of Step 3 already uses. If the implementation ever
  needs a timer to decide `node-finished` (e.g. "debounce node-close events" or "wait N ms before
  matching"), THAT is the bug this test is designed to catch — assert the whole test completes without
  the test runner's fake-timer utilities ever being invoked, not just that it completes fast.
- **Depends on:** §4.3 (Step 3's existing regression gate must stay green — this section only ADDS cases,
  per Step 3b's own "additive to the default" contract).

### 4.4 Step 4 — `packages/cli/test/optimize-fix-cli.test.ts` (extend, reuse the FAKE binding)

Reuse the exact pattern already in the file for `--watch` (`optimize-fix-cli.test.ts:378-401`): a
`FAKE` binding module whose fixer emits a scripted sequence of `OptimizeEvent`s via the driver's real
`onEvent` plumbing (not a hand-rolled fake sink — go through `runOptimizeFixCli` end to end, since
that's what proves the wiring, not just the matcher).

- **Fire:** a fixture run where the fake fixer's `CandidateEdit.aborted` is set (driving a real
  `fixer-aborted` `OptimizeEvent` off `driver.ts:200-203`) with `--wake-on 'optimize:fixer-aborted'`
  → asserts the process exits with code 21 (§3.1) at the point that event is emitted, i.e. BEFORE the
  driver would have proceeded to `scored`/`gated` for that defect (assert the captured event list
  stops at `fixer-aborted` — no `gated`/`landed` line follows it — which is the concrete evidence the
  exit happened at match-time, not merely that the exit code was eventually right).
- **No-fire:** the SAME policy against a fixture run where every fixer call succeeds cleanly
  (`fixer-done` → `scored` → `gated{accept:true}` → `landed`, no `fixer-aborted` anywhere) → asserts
  the CLI runs to its normal completion (the existing summary line, `optimize-fix.ts:330`) with the
  default exit code, proving the wake predicate correctly ignored an entire run's worth of
  non-matching events.

### 4.5 Step 5 / Step 6 tests

Same fire/no-fire pairing discipline, against `optimize-loop-cli.test.ts` (Step 5) and a real
`buildRunFixture` on-disk run dir asserting the JSON payload's `rootCauses` field is populated only
from `buildRunView`, never fabricated by the live path (Step 6) — detailed above per-step in §2, not
repeated here to avoid duplicating the same PASS/FAIL template five times.

---

## 5. FIRST SAFE SLICE

**Build Step 1 alone: `packages/core/src/observe/wake.ts` (`WakePolicy`, `WakePredicate`, `matchWake`,
`parseWakePolicy`, `wakeExitCode`) + `packages/core/test/wake.test.ts`, TEST-FIRST per §4.1. Stop
there, land it, and re-assess before touching Step 2 or any CLI file.**

Why this is the correct first slice, not just the first item in the list:

- **Zero blast radius.** It is a brand-new file with zero existing call sites — nothing that works
  today can regress. Every other step touches a shipped, tested, currently-used code path
  (`telemetry.ts`'s `TelemetryEvent` union that `renderEvent` exhaustively switches on; `watch.ts`'s
  `runWatchCli` that real users invoke; `optimize-fix.ts`'s `onEvent` sink that a live product binding
  already drives end-to-end against `binding-live.mjs`).
- **Fully test-first in isolation.** Every fixture in §4.1 is a hand-built `TelemetryEvent` or
  `OptimizeEvent` literal — no `watchRun`, no filesystem fixture, no dry-run process spawn. This is
  the cheapest possible RED→GREEN loop in the whole plan (no `mkdtempSync`, no `async function* seq`
  wiring beyond what the matcher itself needs) and it exercises the exact question the rest of the
  plan depends on the answer to: **"does the predicate grammar correctly discriminate a matched event
  from a merely-similar unmatched one?"** If that answer is wrong, every downstream CLI wiring step
  inherits the bug silently (a `matchWake` that's too permissive would make `watch --wake-on
  'status:blocked'` exit on `error` too, `context-pressure`, or worse — anything).
- **It is independently reviewable and independently useful even before Step 3/4 exist** — `matchWake`
  is a pure function a human or a future test can call directly against a captured JSONL trace to
  answer "would policy X have woken here?" offline, with no CLI changes at all. That gives the plan a
  natural pause point to validate the predicate GRAMMAR itself (is `metric`/`gte` actually the right
  shape? should `anomaly` take a single kind or a list?) against a few real captured
  `events.jsonl`/optimize traces before committing to the CLI-facing flag surface in Steps 3–4, which
  is much more expensive to revise once shipped (flag names, exit codes, and JSON payload shape all
  become an external contract the moment a real harness starts parsing them).
- **It matches the size discipline in `CLAUDE.md`** ("Implement only what's explicitly requested.
  Prefer minimal changes") — one file, one test file, no touched call sites, reviewable as a single
  self-contained commit.

**Concretely, "done" for the first safe slice means:** `packages/core/src/observe/wake.ts` exists,
exported through both `index.ts` files (§1.2); `packages/core/test/wake.test.ts` has the 9 behaviors
in §4.1 (including `node-finished`'s fire/no-fire pair — the profile-conditional DEFAULT is explicitly
OUT of this slice, per §2 Step 3b; Step 1 only proves the predicate discriminates `node-close` from
every other event kind), each with a demonstrated RED (pre-implementation) → GREEN (post-implementation) transition
and the mutation self-check recorded; `npx vitest run packages/core/test/wake.test.ts` is green;
nothing outside `observe/wake.ts` and the two index re-export lines is touched. Stop there.

---

## 6. Non-goals / explicitly out of scope for this plan

- **The `piflow-overlord` SKILL.md rewrite** (wake-seam vs. intervention-seam vocabulary threaded into
  the decision table, §6 of the passed-in DESIGN SPEC) — a documentation follow-on once Steps 1–4
  ship, not a code build step.
- **A universal `piflowctl wake --on <predicates>` stdin evaluator** composing over
  `telemetry --watch-json`'s output — noted in §3 as a future unification, deliberately deferred
  because it requires fixing `telemetry.ts:155-157`'s `--json`-not-honored-in-the-stream-loop gap,
  which is an unrelated, unscoped bug.
- **`--dead-stall` / `RunModel` staleness** — still blocked on a `RunModel` extension neither ground
  report nor this plan proposes building; the hard guard remains the driver's own `--node-timeout`.
- **The `slow`-live-blind-spot** — by design (§ground report, `telemetry.ts:358-361`), not a defect
  this plan fixes. A wake policy wanting `slow` reads it off Step 6's attached record at `run-end`,
  which is already sufficient — no live-`slow` mechanism is proposed.
- **A general-purpose "elides verify gates" classifier for every possible profile shape** — Step 3b needs
  ONE working cross-reference (profile name → declared `elidePhases` → gate/verify phases) for the products
  this plan actually targets; it does not attempt to anticipate every future profile schema. If a product's
  profile declaration doesn't fit the assumed shape, `node-finished`'s default should fail loud (skip the
  default, log why) rather than guess — never silently mis-classify a profile as gate-checked when it isn't.
