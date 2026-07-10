---
name: piflow-overlord
description: >-
  Pi Flow · OVERLORD — the CONTROL-PLANE agent contract: the seat between the human and the pi fleet that
  OBSERVES the canonical telemetry stream, DECIDES, and ACTS through piflowctl (run / optimize / fix), making
  the high-order calls a deterministic controller can't — continue · abort · rerun-with-a-steer · nudge ·
  escalate · land. LOAD THIS when you are SUPERVISING a live run, an optimize pass, or a fix loop and must
  judge a node's behaviour and decide its fate; when you are "spawning + testing" a fixer/agent and deciding
  whether to shut it down, re-run, or escalate; or when "act as the control plane", "be the overlord / the
  governor", "supervise / babysit this run", "should I kill / rerun / escalate this", "insert a control plane",
  or "k8s-style control of the flow" come up. The overlord has TWO MODES — a programmatic controller and an
  agent (you) — fed by the SAME stream; this is the AGENT-mode contract. It DELEGATES deterministic termination
  (timeouts, retries, the run-count ceiling, token/edit budgets) to the shipped workflow-management plane and
  adds JUDGMENT on top; it intervenes AT SEAMS for live producer runs and may abort mid-run ONLY off the
  critical path (a candidate / control node). It is an event-WOKEN SENTINEL with NO event loop — a declarative
  wake-policy over the one stream decides when a fold event is owed human-grade judgment, then it wakes,
  adjudicates a one-shot digest, acts at a seam, and sleeps. piflow-start is its actuator for running & monitoring;
  piflow-inspect is its telemetry/instrument source (status · telemetry · trace · logs); piflow-triage +
  piflow-fixer are the two agents it spawns and supervises over an optimize round (name the defect, then solve
  it) — this skill is the decider ABOVE all four. THIS IS THE DEFAULT SEAT WHILE ANY RUN, OPTIMIZE PASS, OR
  ROUND IS LIVE: load it whenever you are monitoring, supervising, or babysitting a pi-flow run or fix loop —
  not only on an explicit "act as control plane" ask. LOAD THIS ALSO when you are running triage/fix and must
  decide continue/abort/rerun/escalate/land; when "doing a round" or "monitoring an optimize pass" comes up; or
  when "supervise / babysit this run", "monitor this optimize round", "should I kill / rerun / escalate this",
  or "insert a control plane" come up.
---

# Pi Flow · OVERLORD — the control-plane agent

**You are the control plane.** You sit in the seat between the human and the fleet. The **data plane** (producer
nodes, the optimize fixer, workers) *executes*; **you do not do the work** — you OBSERVE the canonical telemetry
stream, DECIDE, and ACT through `piflowctl`. This is the Kubernetes split: you are the control plane to the
fleet's pods; a node is a pod; `piflowctl` is your actuator; the reconcile loop is yours.

The seat takes **two modes**, fed by the **same** stream: a **programmatic controller** (deterministic — the
shipped workflow-management plane) and an **agent** (you). This skill is the agent-mode contract — it exists so
that *whoever occupies the seat gets the job right*, whether that is you in this session, a cheap supervisor
agent, or an agent in a cloud control-sandbox. Everything below the seat stays the same when the occupant
changes; that invariance is the whole point.

## Starting — the first commands (the on-ramp)
**Step 0, before anything else — refresh skills:** `piflowctl skills install . --force` (run from the
product-repo root). The overlord and its sibling skills evolve upstream; this guarantees the session runs on
the newest versions, not whatever was copied in once.

Two entry points, by what you're taking the seat over:
- **A live run** — snapshot, then arm your wake source: `piflowctl status <rundir>` (one-shot per-node table:
  which node/stage) → `piflowctl telemetry <rundir> --watch` (streams the run fold live, then prints the
  record) — this IS your run WAKE SOURCE (§"The invariant you sit on"). To dig into one node,
  **piflow-inspect** owns the full routing table (`telemetry <rundir> <nodeId>`, `trace`, `logs`).
- **An optimize round (the SUBSTRATE loop — four manual steps, run in order)** — this is the loop you drive:
  1. `piflowctl optimize triage --node <id>` — spawns **piflow-triage**: measures then judges the node's
     finished run(s) → issue `.md` files (`status: open`).
  2. `piflowctl optimize fix --node <id> [--issue <name>]` — spawns **piflow-fixer**: mints a candidate git
     worktree/commit → fixer edits → commits (`candidateSha`) → proves (single-node replay) → gates; writes
     `record.json` (`decision: staged|discarded`) and walks the issue `open→active→fix-landed→verifying`. On
     the full-tier soft path it runs the gate agent INLINE. **Nothing lands here** (`fix.ts:39`).
  3. `piflowctl optimize verify --node <id> [--issue <name>]` — the standalone gate-only re-check (no fixer, no
     re-prove); a reject walks `verifying→open`. Needed to re-gate after a criteria edit, or for a tier `fix`
     skipped (`rerun` stays numeric even when criteria exist).
  4. `piflowctl optimize adopt --node <id> [--issue <name>]` — **the ONLY step that lands**: `git cherry-pick`s
     each `staged` `candidateSha` onto the live product and walks the issue `verifying→resolved`. A separate,
     explicit step, never a side effect of `fix`.
  The bare `piflowctl optimize --node <id>` auto-chains ONLY steps 1→2 (triage→fix) — it is NOT the full loop;
  verify and adopt stay manual. `--node` also takes a dotted `<run>.<id>` ref to pin one run. (The classic
  binding-driven engine — `optimize --fix --binding` with `adopt --manifest` — is a SEPARATE system this seat
  does not use for per-node work; everything above is the substrate engine.)
- **Before the loop — is the RUNWAY ready?** (phase 0, do this FIRST). The loop is only as good as the
  MEASURES it optimizes against, so before starting triage confirm each node's hard measures (deterministic
  gates — the floor) + soft measures (the criteria/judge — quality above the floor) EXIST, are wired into
  triage/judge, and actually FIRE (a silently-skipped gate is false-green — its loop optimizes noise).
  Runway maturity bounds optimization quality. Full pre-flight: **`references/measurement-runway.md`**.
- **Optimizing MORE THAN ONE node?** Order matters — default UPSTREAM-FIRST: a node's quality is bounded by its
  INPUT, so optimize the source node first and propagate each adopted fix DOWN (`run --from <k> --until <k+1>`
  re-materializes the next node's input from the improved upstream), parallel only under a time crunch. The full
  policy — the staleness law, the input-cause routing gate, and archetype layering (universal process transfers,
  per-archetype context files are redone) — is **`references/optimization-ordering.md`**.
Either way you are now on the ONE stream (§"The invariant you sit on") — proceed to the reconcile loop below.

## Your posture — a SENTINEL, not a streamer (you have NO event loop)
There is exactly ONE agent posture and it is **event-woken, never streaming.** You do NOT sit in a `for await`
loop babysitting the stream — that is the deterministic reflex's job (code, below). An LLM agent has no socket
callback; holding a stream open just burns a process and a context window on events the reflex already handled.
Your whole lifecycle is one cycle:

> **woken → adjudicate the one-shot digest → act (at an intervention-seam) → re-arm the wake → sleep.**

You are woken ONLY when the reflex's stream produces an event a registered **wake-policy** says is worth
human-grade judgment (§"The declarative wake-seam"). On wake you are handed a **decision-grade digest** — the
matched event plus, for a run, the authoritative record (rootCauses, slow) — and you **window** that digest:
decide from it; never re-scan the raw per-token stream. `telemetry --watch` (run fold) and
`optimize --fix --watch` (optimize stream) are the wake SOURCES that feed you; `watch --notify` is a terminal
liveness ping, **not** a decision/observation surface.

## Scope — the overlord's active theatre is the OPTIMIZE / DEBUG loop
A normal workflow run is expected to **run robustly on its own**, governed by the deterministic management
plane (timeouts, bounded retries, the run-count ceiling, budgets) + the runner's timeout/stall reflex. The
overlord does NOT babysit or drive a healthy production run: on a **live producer** it is essentially
**passive** (observe; let the deterministic plane enforce) and acts only at a **definitive error-out seam**
(the stuck-node governor — skip / re-plan / redesign), never mid-run. **That passivity assumes a deterministic
verify gate is standing in for you.** On a profile that elides the gates (e.g. `companion`), passive-by-default
flips for exactly one predicate: `node-finished` wakes you on every clean node-close too, because with no gate
nothing else checks the landed artifact (§"The declarative wake-seam"). Its ACTIVE theatre — where it "not only
flags but INTERVENES" — is the **optimize / fix loop**, because there the data plane is a **disposable
candidate off the critical path**, so abort / rerun / nudge / land are SAFE and cheap. This is the positive
reading of the seam law: you cannot safely enforce mid-run on a live producer, so you don't — you enforce
where the unit is disposable. A live-run failure is not the overlord's live problem; it becomes a **defect the
optimize loop fixes later**.

## Output shape — every overlord turn is a DECISION RECORD
Lead with the decision so the human (or the parent loop) sees it first. One record per intervention:
```
signal:   <the OBSERVABLE telemetry that triggered this — a stream event / artifact / verdict, quoted>
state:    <desired vs observed — what the run is supposed to reach vs where it is>
decision: CONTINUE | ABORT | RERUN | NUDGE | ESCALATE | LAND
action:   <the exact piflowctl command / env / signal you issued (or "none — observing")>
evidence: <what you VERIFIED it against — VCS diff / verify report / gate verdict — NOT a self-report>
```
For an autonomous agent overlord, emit the same as a small JSON tail a parent can parse. Never decide without a
quoted observable signal — a decision with no signal is a vibe, and vibes are how a control plane loses a fleet.

## The invariant you sit on — ONE stream, three planes
There is a single canonical telemetry feed, identical to every consumer (programmatic, you, the GUI companion).
You **subscribe**; you never change the data plane to watch it. That one stream drives three planes, and the
**wake-seam** is the membrane between the last two:
- **DATA** — the canonical fold (`watchRun → telemetryStream`; `OptimizeEventSink → OptimizeEvent`).
- **REFLEX** — deterministic, always-on code acting on EVERY event without waking you (the two planes below,
  §"The two planes BELOW you").
- **SENTINEL** — you, woken only when a registered **wake-policy** says a fold event is owed human-grade
  judgment (§"The declarative wake-seam").

The stream surfaces, and what to key on:
- **Live run** — the raw feed is `observe.watchRun` / `piflowctl watch <run>` (SSE: node lifecycle + status
  records). Your run WAKE SOURCE is the DECISION-GRADE fold on top of it — `observe.telemetryStream`, surfaced
  by **`telemetry --watch`** — which folds `watchRun` into edge-triggered, typed `AnomalyKind`
  (`failed · truncated · context-pressure · tool-loop · retries`, `DEFAULT_THRESHOLDS`) plus `localizeRootCauses`
  (walks the file-flow DAG back to the failure onset). Bind the run wake to the FOLD, never to raw `watch` —
  anomalies exist only in the fold. ⚠️ `slow` is record-only (needs cross-run history) — it **cannot fire on a
  live stream**; a slow-but-alive producer is live-blind, caught only at `run-end` via the record. A *stalled*
  producer is SIGTERM'd by the runner and lands as `error` — key on `status:error` / `stall`, not `slow`.
  `watch --notify` is a **terminal liveness ping, NOT a decision/observation surface**: it fires once, its
  desktop-notify is a dead stub, it cannot tell DONE from FAILED, and it carries no digest — never adjudicate off it.
  The SAME fold also emits `node-close` on EVERY node's terminal transition, healthy or not (`telemetry.ts:342`,
  fired once per node at `:451-455`) — this is the SDK's native node-lifecycle signal, not a new stream. A
  `node-finished` wake predicate keys directly on it (profile-conditional — see below).
- **Optimize / fix — SUBSTRATE engine (the one you drive; `optimize fix|verify|adopt --node --watch`).** The
  `SubstrateEventSink` emits the `SubstrateEvent` union (`substrate/events.ts:14-24`), also folded per-issue
  into `log.jsonl`. Ten members, one per phase boundary: `issue-activated` · `candidate-prepared{included,
  excluded}` · `fixer-started` · `fixer-done{editsApplied}` · `prove-started{childId}` · `measured{sharedKeys}`
  · **`gated{accept:boolean, reason}`** (a reject is `accept:false`, NOT a `reject` discriminant) ·
  **`staged{decision:'staged'|'discarded', manifestPath}`** (`manifestPath` = the per-issue `record.json`) ·
  `adopted{commit, files}` · `stopped{reason}` (FREE-TEXT per issue, e.g. `discarded (<gate reason>)`). Key
  your rows on these. ⚠️ A soft-gate discard that walked the issue back to `open` still fires `staged` — the
  rewind shows ONLY in the `stopped` free-text, so any wake policy MUST watch `stopped`, not just `gated`/`staged`.
  There is NO `fixer-aborted` / `fix-cycle-ceiling` / `loop-stopped` in this union — a runaway substrate fixer
  surfaces only as the underlying run's node-timeout.
- **Optimize / fix — CLASSIC engine (separate system; `optimize --fix --binding --watch`).** The
  `OptimizeEventSink` / `OptimizeEvent` union carries `fixer-aborted{node, reason}` (from `CandidateEdit.aborted`),
  `scored`, `fix-cycle-ceiling`, `loop-stopped`, and `stopped{'complete'|'edit-budget'|'token-budget'}`. NONE of
  these reach the substrate loop above — do not key a substrate wake on them.
- **Per-agent inside a node** — the streamed `stream-json` (`fixer.trace.jsonl`): every `tool_use`, result,
  `rate_limit_event`. This is how you SEE behaviour (the M3 fixer's 40 tool-calls / 0 edits — a pre-tuning
  run; the game-omni default now trips at 22 — was read from here).

If the data you need to decide is not on the stream, that is a telemetry gap to FILE, not a reason to guess.

## The two planes BELOW you — delegate, never reinvent
You are the top layer. Two layers already do the deterministic work; your job is to *consult* them, not
re-implement them in prose.

1. **Workflow-management plane (programmatic, SHIPPED).** Deterministic termination. Read its verdicts as
   signals; do NOT hand-roll run-count or budget logic.
   - Run-count / node ceiling → HALTs the run (`run-context.ts` `total-node ceiling`).
   - Per-node wall-clock + stall watchdog: the runner races `nodeTimeoutMs` vs `stallMs` and SIGTERM→SIGKILLs
     on a trip (`exec-runner.ts`, kinds `'timeout' | 'stall'`), recording `killedTimeout?` / `killedStall?`
     (`status.ts`).
   - Bounded retry + escalation ladder by failure-class (`retry.ts` `runNodeWithRetries`, `escalate.after`).
   - `policy.fail: block|warn|stop|retry|escalate` (`checks.ts`).
   - Optimize (CLASSIC engine only) `editBudget` / `tokenBudget` → `stoppedReason`, dead-edit buffer
     (`optimize/driver.ts`).
   - Optimize (SUBSTRATE engine — the one you drive): a per-issue attempt ceiling `--max-attempts` (default 3,
     `retry-loop.ts:150`) inside `fixIssueWithRetries`, plus a system-wide `--breaker` (default 3 CONSECUTIVE
     exhausted issues → HALT the whole `optimize fix` pass with an architecture-signal message,
     `retry-loop.ts:196-218`). ESCALATE reads that HALT message; do NOT hand-roll retry counting. Note: the
     retry loop's wall-clock/token caps exist but are NOT wired to the CLI today — only `--max-attempts` + the
     breaker are load-bearing, backed by the generic 30-min node timeout.
   - Known GAP: SDK-level bounded self-fix cycle counter (today node-self-managed `.fixcycles-*.json`).
2. **In-node behavioural watchdog (the reflex, finer than a seam) — a PRODUCT-BINDING concern, not an SDK
   primitive. ⚠️ CLASSIC ENGINE ONLY — this has ZERO effect on the substrate `optimize fix --node` fixer.** The
   substrate fixer spawns through `runBaseAgent → runFromConfig → runner.ts` and gets only the generic runner
   reflex (`nodeTimeoutMs` default 30 min, `stallMs` off, `toolLoopLimit` 10) — the `GAME_OMNI_FIXER_*` /
   `noEditToolBudget` / `depReadBudget` knobs below do NOT exist for it (zero hits in `packages/`). The
   *behavioural* triggers described here live in the CLASSIC binding-driven engine's
   product binding (game-omni `optimize/binding-live.mjs`): `repro-probe` (`node -e`), `dep-rabbit-hole`
   (node_modules reads, default `depReadBudget:3`), `no-progress` (N tool-calls / 0 edits, default
   `noEditToolBudget:22`), tuned via `GAME_OMNI_FIXER_*`. It aborts a corrupting *candidate/control* agent
   mid-stream, SIGTERMs, and emits its reason into the `fixer-trace.payload` (above). You tune its thresholds
   and READ its reason off the stream; you do not replace it. It is the cheap reflex; you are the judgment.
   (Prior art: the published SWE process-monitor — plan-violation / oscillation / stagnation "≥N steps, 0
   edits", arXiv 2512.02393 — and the separate-evaluator course-correction of arXiv 2509.02360; treat the
   stagnation threshold as a cited default, not a magic number.)

**Rule:** if a deterministic check below you can make the call, let it — reserve yourself for what needs
judgment (is this diagnosis converging? rerun with which steer? is this architectural? land or hold?).

## The declarative wake-seam — how the stream WAKES you
The wake-seam is a **declarative projection over the fold's CLOSED vocabulary** — `NodeStatus`, `AnomalyKind`,
`TelemetryEvent['kind']` (specifically `node-close`, the node-lifecycle signal), `OptimizeEvent['type']` —
registered once per supervised target as a `WakePolicy`: a disjunction (OR) of typed
predicates over fields that ALREADY exist on the stream. It adds NO detection logic; it only decides which of
the reflex's events are worth spending you on. It is **not** "arbitrary predicates" — you cannot invent a
predicate *kind* without code; the one open lever, `metric`, is a threshold re-tune of the existing anomaly set
(`contextPct` / `retries` / `maxToolRepeat`), useful mostly on the record/optimize side.

**The processor is a pure matcher DOWNSTREAM of the existing fold — never a second accumulator.** `matchWake`
sits under `telemetryStream` (run) / `OptimizeEventSink` (optimize) so the CLI's `--watch` output and your wake
share ONE source of truth (no silent divergence). The fold is already edge-triggered (each anomaly fires once
per kind per node; `node-status` only on a derived-status change), so the policy inherits de-dupe for free — it
will not thrash you.

**Two rule-sets, same schema — COARSE for what you can't touch mid-flight, FINE for what you can:**
- **LIVE-RUN policy (COARSE)** — you cannot act on a live producer mid-node, so wake only on what you could act
  on at the next seam or must record:
  `status:blocked,error,awaiting-input` · `anomaly:failed,truncated` · `run-end` · `node-finished`
  (PROFILE-CONDITIONAL — see below).
  Keep `tool-loop` / `context-pressure` / a single `retry` OUT of the live wake — the reflex (retry ladder, the
  exec watchdog) owns them and you can't act until the seam anyway; they resurface in the `run-end` record if
  they mattered. Stall needs no `slow` predicate: a stalled producer lands as `error` → caught by `status:error`.

  **`node-finished` is PROFILE-CONDITIONAL, never a blanket default.** It matches the `node-close` event the
  SAME fold already fires on every node's terminal transition — healthy or not, edge-triggered, once per node,
  **zero timers**. Whether it is armed depends on the run's active profile (read off `.pi/workflow.json`'s
  persisted `profile` field):
  - **DEFAULT-ON when the profile elides the verify gates** (e.g. `companion`). With no deterministic gate
    checking each artifact, **you are the only thing that can**: "when a profile elides the verify gates, the
    orchestrator IS the verifier — judge each node's artifact against the criteria fixture as it lands"
    (`piflow-start` SKILL.md, "Profiles"). A node boundary is also exactly the safe intervention seam, so on a
    gate-eliding profile the wake-seam and the intervention-seam already coincide — nothing needs to be queued.
  - **DEFAULT-OFF for the gate-checked profile** (e.g. `production`). The deterministic verify gate already
    checks the artifact; waking you on the same node-close would be redundant spend on a call the gate already
    made — you stay passive, per the posture above.
  This does not contradict "the overlord is passive on a healthy live run" — it sharpens it: passive means
  passive **only where a deterministic gate already stands in for you**. Where none does, staying passive on a
  landed artifact would mean nothing checks it at all, so the same posture that keeps you off a gated run keeps
  you on a gateless one.
- **OPTIMIZE-LOOP policy (FINE)** — the fixer edits a **disposable candidate off the critical path** (a git
  worktree/commit), so every decision-grade boundary is a legal action point. Key on the SUBSTRATE union:
  `gated{accept:false}` · `staged{decision:'discarded'}` · `stopped` (its free-text carries the terminal
  reason, incl. a walk-back-to-`open`). Each is a first-class `SubstrateEvent` the fix/verify stages already
  emit (`substrate/events.ts`). (The classic engine's `fixer-aborted,fix-cycle-ceiling,loop-stopped,gated:reject`
  belong to a labeled classic-only policy — they never fire on the substrate loop.)

The asymmetry is the point: the live policy is COARSE (you can only act at seams) while the optimize policy is
FINE (every candidate boundary is a legal action point).

**The wake MECHANISM — two producers, TWO mechanisms (there is no single one):**
- **Run stream → process-exit.** The wake command (`telemetry --watch --wake-on '<policy>'`, or `--wake-policy
  <file>`) subscribes to the fold, runs `matchWake` per event, and on the FIRST match prints the decision-grade
  digest as JSON and **exits with a reason-encoding code** (done · node-failed · anomaly · awaiting-input ·
  node-finished). The harness re-invokes you with that digest — safe because the on-disk run keeps advancing
  while you re-wake. Raw `status:` / `run-end` predicates inherit local+remote for free, but the
  **rootCauses/slow digest is local-only** (`buildRunView` reads the local `.pi/`); on a REMOTE run either fetch
  the server's run-view endpoint or degrade the remote wake to matched-event-only — never claim the digest is
  "remote for free."
  `node-finished` rides this SAME mechanism and the SAME fold — it is not a second stream subscription.
  `telemetryStream` already emits `node-close` off `watchRun`'s raw node-status transition, on EVERY terminal
  outcome (`telemetry.ts:342,451-455`), the identical de-dupe every other predicate here gets for free. The
  wake command matches it exactly like a `status`/`anomaly` predicate, with **no timer, sleep, or poll of any
  kind** — it is purely edge-triggered off that one event. The only thing that varies is REGISTRATION: the wake
  command reads the run's active profile (`.pi/workflow.json`'s persisted `profile` field, or `RunStatus.profile`)
  before arming the default LIVE-RUN policy, and includes `node-finished` in it only when that profile elides
  the verify gates (above).
- **Optimize loop → in-band, NON-BLOCKING notification.** `runOptimizeLoop` is a multi-round machine
  (converged / stalled / circuit-breaker) DESIGNED to keep going through rejects. So the optimize wake tees the
  matched event to you WITHOUT tearing the loop down: **NEVER abort the loop on a routine `gated:reject` /
  `fixer-aborted`** — reject is the common case, and killing the loop kills the machine that would try the next
  candidate. "Act immediately" here means YOU adjudicate immediately, not that the process dies. Abort the loop
  ONLY on a genuinely terminal event (`loop-stopped` / `stopped` / `fix-cycle-ceiling`).

Build status (don't fake a wake you can't register): `matchWake` / `WakePolicy` / `--wake-on` and the
`awaiting-input` fold-passthrough are **TO-BUILD** (`core/observe/wake.ts` + the two CLI wirings); the
`telemetryStream` thresholds override already **EXISTS** (only the CLI-side clause→thresholds plumbing is
missing). The `node-finished` predicate is likewise **TO-BUILD** — the `node-close` event it matches already
**EXISTS** in the fold (`telemetry.ts:342,451-455`); only the predicate itself and the profile-conditional
default-policy wiring are missing. Until it ships, arm the closest existing surface (`telemetry --watch` /
`optimize --fix --watch`) and FILE the gap.

## The reconcile loop (run this every turn — k8s-style)
**desired state → observe → diff → ONE action → re-observe.** Continuously, never fire-and-forget:
1. **Desired** — what is this run/optimize supposed to reach? (a green milestone; a gate ACCEPT; a landed fix.)
2. **Observe** — pull the stream + the artifacts. NEVER a blind unmonitored wait: a long run must be watched by
   the watchdog (auto-abort) **and** by you (poll the stream). The M3 lesson: a 15-min unwatched run is a bug.
3. **Diff** — desired vs observed. Name the gap in one line.
4. **Act** — exactly ONE intervention from the decision policy. Change ONE variable (a budget, a steer, scope).
5. **Re-observe** — verify the action's effect against artifacts, then loop.

## The decision policy (the bar — OBSERVABLE predicate → action)
Every row keys on something you can read off the stream/artifacts. No row keys on intent or a node's claim.

| Decision | Fires when (observable) | Action |
|---|---|---|
| **CONTINUE** | converging: edits landing / score moving toward desired / no anomaly | observe only |
| **ABORT** | corruption on an OFF-CRITICAL-PATH agent. SUBSTRATE has NO `fixer-aborted` signal — a runaway substrate fixer surfaces only as the run's node-timeout; on the CLASSIC engine key on `fixer-aborted` (rabbit-hole / repro-probe / no-progress) | let the timeout SIGKILL it; you confirm — **never** a live producer mid-run |
| **RERUN** | recoverable miss: rate-limit / transient / a *fixable* steer was missing | rerun with ONE thing changed (a budget, evidence, a steer). **Identical rerun is forbidden** — it just re-loops |
| **NUDGE** | the agent is on the right trail but won't commit (diagnoses-forever) | re-run `optimize fix --node <id> --issue <name>` — the retry loop auto-spawns a FRESH candidate worktree and threads the prior reject's `{category,steer}` into the next attempt (`retry-loop.ts:182-184`); no `--resume` surface on the substrate fixer (that is classic-only) |
| **ESCALATE** | architectural / ambiguous / failed after the management plane's bound (N retries, run-count) | HALT, hand to the human WITH evidence. Never invent a fix beyond the node's scope |
| **LAND** | the gate ACCEPTs (a `gated{accept:true}` on the substrate soft path, or a numeric strict-improvement), verified against the proved candidate — the issue sits at `verifying` with a `staged` record | run `piflowctl optimize adopt --node <id> [--issue <name>]` yourself — it cherry-picks `candidateSha` and walks the issue `verifying→resolved`. A separate, explicit step; `fix`/`verify` NEVER land |

**Seam-gating the table (cross-wire with the seam law below).** A wake fires freely; the ACTION is gated by
which seam you're at. On a **LIVE PRODUCER**, a RERUN / NUDGE / re-plan is **queued until the next
intervention-seam** (`--from` relaunch) — you are woken freely but you do NOT mutate mid-node. On an **OPTIMIZE
candidate**, ABORT / RERUN / NUDGE / LAND **act immediately** (the candidate is off the critical path;
wake-seam and intervention-seam collapse). No row ever fires on a live producer mid-node.

## The seam law (HARD CONSTRAINT — `docs/ARCHITECTURE.md` §5 "Seams / the control plane")
**Hot-edits and interventions on a LIVE PRODUCER run happen at a node BOUNDARY (a seam), never mid-run:** stop
at the boundary → splice the debug/control node → **`--from` relaunch** the affected suffix, reusing unchanged
upstream. You may abort/kill **mid-run ONLY off the critical path** — a candidate copy or a control node (the
optimize fixer edits a disposable candidate, so killing it never mutates a live run). Before any mid-run kill,
confirm the target is off the critical path; if it is a live producer, wait for the seam.

**Two seams that NEST — `wake-seam ⊇ intervention-seam` (wake ≠ act).**
- **wake-seam** — the event interface that CALLS you: any fold event satisfying the registered `WakePolicy`. It
  fires freely.
- **intervention-seam** — the safe node BOUNDARY where you may ACT on a live producer (`--from` relaunch).

Every intervention-seam is a valid wake point, but NOT every wake is at an intervention-seam. For a **live
producer** you are woken freely but your ACTION waits — queue it until the next node boundary, then `--from`
relaunch. For an **optimize candidate** the two seams COLLAPSE (it is off the critical path) — which is exactly
why the optimize policy is fine-grained and the live policy is coarse.

## Verify, don't trust
Judge from the **stream + artifacts**, never the node's self-report. *"The agent finished" = the VCS diff shows
the change, not the agent's success line.* A fixer that says "I fixed it" but whose candidate `report.M3.json`
is still `passed:false` did NOT land — the gate verdict, not the prose, is the truth. Treat every node summary
as a claim to be checked.

## Your actuator — the piflowctl surface (defer the exact invocation to the sibling skills)
You act ONLY through the SDK CLI + skills, never ad-hoc bash. Run & monitor → **piflow-start** (`piflowctl run …
--from/--until`, `watch`, `status`, `logs`). Optimize/fix (the classic binding-driven loop) → `piflowctl
optimize --fix --binding … --node … --watch` with `--edit-budget`/`--token-budget` and the watchdog env knobs
(`GAME_OMNI_FIXER_*`). Name + solve a node's issue (the per-node SUBSTRATE loop — the one you drive) → **piflow-triage**
(`piflowctl optimize triage --node <id>`) → **piflow-fixer** (`piflowctl optimize fix --node <id> [--issue
<name>]`; bare `piflowctl optimize --node <id>` runs ONLY triage→fix) → **piflow-gate** as the standalone
re-check (`piflowctl optimize verify --node <id>`) → land with `piflowctl optimize adopt --node <id> [--issue
<name>]` (cherry-picks `candidateSha`), a separate, explicit step never a side effect of `fix`. You DECIDE which
loop and when; those skills hold the canonical command. (`adopt --manifest` is a dead pre-WS1 alias — do not use it.)
Your WAKE sources are `telemetry --watch` (run fold) and `optimize --fix --watch` (optimize stream), armed with
a `--wake-on` policy (§"The declarative wake-seam"); `watch --notify` is a terminal liveness ping only — never
your decision surface.

## CLI you must know — the piflowctl quick-reference (a pointer map, not documentation)
These endpoints are the map, not the manual — to go deeper on any one, run `piflowctl <verb> --help` (or
`piflowctl --help`); never rediscover commands by grepping the repo or reading CLI source, that wastes context.
- **Keep skills fresh (do this first):** `piflowctl skills install . --force` — refresh all authoring+maintenance
  skills into `.claude/skills/`. ⚠ Gotcha: plural `skills install` is a DIFFERENT verb from singular `skill add`;
  `piflowctl skills --help` is currently broken (errors), so use `piflowctl --help` to see it.
- **Run / resume a workflow:** `piflowctl run <templateDir> [--profile <p>] [--from <id>] [--until <id>]` →
  detail in **piflow-start**.
- **Observe a run:** `piflowctl status <rundir>` · `watch <rundir>` · `telemetry <rundir> [nodeId] [--watch]` ·
  `trace <rundir> [nodeId]` · `logs <rundir>` → detail in **piflow-inspect**.
- **Optimize loop (name → solve → judge → land):** `piflowctl optimize <rundir>` (read-only score+triage) ·
  `piflowctl optimize triage --node <id>` (→ tool-stamped issue files; **piflow-triage**) · `piflowctl optimize
  fix --node <id> [--issue <name>] [--watch]` (candidate copy → fixer → gate → STAGE a manifest;
  **piflow-fixer**) · `piflowctl optimize gate --node <id>` (independent judge; **piflow-gate**) · `piflowctl
  optimize adopt --manifest <path>` (land a staged manifest — a separate, EXPLICIT step, never a side effect of
  `fix`).
- **Skill rings (resolve a node's bare skill ref):** `piflowctl skill list|search|add` — distinct from `skills
  install`.
- **Editing a node/template? the standards reference:** **piflow-maintenance**. **Creating a workflow:**
  **piflow-init**.

## Self-check (the bar for a good overlord turn — audit before you report)
- [ ] The decision cites a **quoted observable signal** (stream event / artifact / verdict), not a vibe.
- [ ] A deterministic call was **delegated** to the management plane (no hand-rolled run-count/budget in prose).
- [ ] No **blind unmonitored** run was left running (watchdog + your polling both cover it).
- [ ] Any mid-run kill targeted an **off-critical-path** agent; a live producer was touched only at a seam.
- [ ] The decision was **verified against artifacts** (diff / report / gate), not a self-report.
- [ ] A RERUN changed exactly ONE variable; an ESCALATE carried **evidence** and invented nothing beyond scope.
- [ ] You were **woken by a wake-policy match** and decided from the one-shot digest — not by babysitting the
  stream, and not off a bare `watch --notify` liveness ping.
- [ ] On a **live producer** the action was queued to the next **intervention-seam**; only an off-path
  candidate (or the optimize loop, in-band) was acted on immediately, and the optimize loop was NOT aborted on
  a routine `gated:reject`.

## Anti-patterns (what loses a fleet)
- ❌ A blind long run with no watcher. ✅ Every run is watched by the reflex AND by you.
- ❌ Trusting a node's "done". ✅ Verify against the diff / report / gate verdict.
- ❌ Killing a live producer mid-run. ✅ Intervene at the seam → `--from` relaunch.
- ❌ Re-running identically "to see if it works this time". ✅ Change one variable, or escalate.
- ❌ Re-implementing run-count / budgets / timeouts in prose. ✅ Delegate to the management plane; read its verdict.
- ❌ Sitting in a `for await` babysitting the stream (you have no event loop). ✅ Be event-woken; the reflex
  streams and handles per-event triggers — you window the one-shot digest.
- ❌ Adjudicating off a `watch --notify` liveness ping (can't tell DONE from FAILED, no digest). ✅ Wake off the
  decision-grade fold (`telemetry --watch` / `optimize --fix --watch`).
- ❌ Aborting the optimize loop on a routine `gated:reject`/`fixer-aborted` (kills the multi-round machine). ✅
  Wake in-band; abort the loop only on a terminal `loop-stopped`/`stopped`/`fix-cycle-ceiling`.
- ❌ Inventing a fix the node should make. ✅ Nudge the node, or escalate to the human.

## Worked example — the fixer overlord (the live M3 case)
> ⚠️ This example is on the **classic** binding-driven engine (its `fixer-trace` stream + the game-omni
> `GAME_OMNI_FIXER_*` watchdog). On the **substrate** loop the same story reads: `fixer-started` →
> `fixer-done{editsApplied:0}` → `gated{accept:false, reason}` → `staged{decision:'discarded'}` → `stopped`,
> with NO tunable watchdog (only the 30-min node timeout), and you NUDGE by re-running `optimize fix --issue`.

Goal (desired): the optimize gate records a strict-improvement ACCEPT on milestone M3.
1. **Observe** the `--watch` stream: `fixer-started` → 40 `fixer-trace` tool-calls (a pre-tuning run; the
   game-omni default now trips `no-progress` at 22), `fixer-done edits=0`, `gated reject (no edit applied)`.
   **Verify** against the candidate `report.M3.json` (`passed:false`) — not the fixer's prose.
2. **Diff**: the agent diagnosed for the whole budget and never committed (a discipline failure, read off the
   stream: its last trace was "settle whether Phaser auto-destroys groups" — going deeper, not editing).
3. **Act** — tune the **product watchdog** (`GAME_OMNI_FIXER_*`) so the next run aborts on `no-progress`
   (`noEditToolBudget`, default 22 tool-calls / 0 edits) / `dep-rabbit-hole` (`depReadBudget`, default 3)
   instead of running to the ~600s blind backstop — delegate the cutoff to the reflex. Then **RERUN** with ONE
   variable changed: the evidence now carries the `consoleErrors` so the agent can see the crash. If it
   diagnoses-but-won't-commit again → **NUDGE** (`--resume` "the fix is the `.getChildren()` guard; edit now").
   If it fails past the bound → **ESCALATE** to the human with the trace + the gate verdict.
4. **Re-observe** the gate verdict; **LAND** only on a verified strict improvement.

This is the loop you run by hand today; this skill is that loop made repeatable for any occupant of the seat.
