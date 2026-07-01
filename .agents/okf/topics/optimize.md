---
type: subsystem
key: optimize
title: Optimize (the post-run self-correction loop — score → triage → fix → gate → land → worklist)
description: The out-of-band optimizer — a finished run's trace folds through scoreRun (Tier-0 telemetry disqualifier × Tier-1 checkable outcome) → triage (four-way LAPSE/SKILL/FUNCTIONALITY/ARCH) → runFixGate (a deterministic driver composing a product-injected fixer + held-out replay) → evaluateGate (accept iff a candidate copy strictly improves) → land (stage/adopt) → renderRouting (the HERMES-ROUTING.md worklist).
resource: packages/core/src/optimize/driver.ts
aliases: [optimize, optimizer, scoreRun, scoreNodes, triage, evaluateGate, runFixGate, makeReplayStages, mineTaskFromTrace, renderRouting, readVerifyReport, writeStagingManifest, adoptFile, DefectBucket, NodeScore, Tier0, Tier1, FIX-GATE-LAND, HERMES-ROUTING, self-correction, hermes, accept-gate, replay, strict-improvement, --binding, --fix, --watch, OptimizeEvent, OptimizeEventSink, renderOptimizeEvent, streaming, fixer-trace]
seeds: [packages/core/src/optimize/score.ts, packages/core/src/optimize/triage.ts, packages/core/src/optimize/gate.ts, packages/core/src/optimize/driver.ts, packages/core/src/optimize/replay.ts, packages/core/src/optimize/mine.ts, packages/core/src/optimize/land.ts, packages/core/src/optimize/tier1.ts, packages/core/src/optimize/render.ts, packages/core/src/optimize/events.ts, packages/core/src/optimize/types.ts, packages/cli/src/optimize-fix.ts]
symbols: [scoreRun, scoreNodes, triage, evaluateGate, runFixGate, makeReplayStages, mineTaskFromTrace, readVerifyReport, renderRouting, writeStagingManifest, adoptFile, NodeScore, Defect, DefectBucket, GateVerdict, CheckableTask, OptimizeEvent, OptimizeEventSink, renderOptimizeEvent]
tags: [optimize, self-correction, memory-v1.5, hermes-routing, accept-gate, replay, core, cli]
timestamp: 2026-06-30
---

# Why / how it works (the lifecycle, end to end)
The optimizer is PURE + OUT-OF-BAND — post-run, never an in-DAG node. `scoreRun` reads a finished run dir,
builds the Tier-0 telemetry digest (`projectRunDigest`) and folds it against Tier-1 outcomes (`readVerifyReport`
over the recorded `verify/report.M*.json`) via the pure `scoreNodes`: a structural disqualifier (failed/
truncated/tool-loop) scores 0, an unmeasured/abstained Tier-1 yields `scalar=null` (ABSTAIN ≠ low score).
`triage` projects each `NodeScore` into one of four buckets by ascending blast radius — ARCH (originates
upstream, via `digest.rootCauses`), FUNCTIONALITY (clean node, checkable outcome failed), else LAPSE (the
default-when-unsure); SKILL is deferred and named in `needsSignal`. `renderRouting` emits that `Defect[]` as
the proven HERMES-ROUTING.md worklist (the read-only `optimize` CLI). The `--fix` path runs `runFixGate`: per
defect it `prepareCandidate`s a COPY, calls the product-injected `fixer`, `replayScore`s the copy on a held-out
VAL task (`makeReplayStages` + `mineTaskFromTrace`), and `evaluateGate` accepts ONLY on strict improvement
(FUNCTIONALITY also needs the product build green; ARCH always stages for human). `writeStagingManifest` records
decisions; `adoptFile` (backup-then-overwrite) is a separate explicit land. The live oracle/fixer stay
product-side, dynamic-imported via `--binding` (`packages/cli/src/optimize-fix.ts`).
For a SKILL defect, `triage` also pins a two-leg **scope-context** (`DefectScope`): the cross-run recurrence +
the lesson's distilled root/prevention (Leg A) + the linked `[[okf-slice]]` KEY (Leg B) — the projector stays
pure (it pins only the KEY). The CLI seam then dereferences that key to the slice's curated code-map
(`enrichCodeMap` → `resolveSlice`) and inlines it AT FIX TIME, so the fixer reads *how the code works*
alongside *what recurred* — POINTER + RESOLVE-AT-READ, never a stored copy (the code-map can't rot; it is a
fresh read of the drift-gated slice). See `memory-leg` for the two-leg join.

# Anchors
SCORE
- `packages/core/src/optimize/score.ts:35` — `scoreNodes` — PURE fold (Tier-0 disqualifier × Tier-1 value) → NodeScore[]
- `packages/core/src/optimize/score.ts:93` — `scoreRun` — impure shell: read run dir + recorded verify reports, then fold
- `packages/core/src/optimize/tier1.ts:38` — `readVerifyReport` — project a verify-milestone report → Tier1Result (abstain re-tag)
TRIAGE
- `packages/core/src/optimize/triage.ts:35` — `triage` — four-way LAPSE/SKILL/FUNCTIONALITY/ARCH projector → Defect[]
- `packages/core/src/optimize/types.ts:110` — `DefectScope` — the two-leg scope-context a SKILL fixer reads (recurrence + root/prevention + the linked [[okf-slice]] KEY)
- `packages/core/src/optimize/render.ts:33` — `renderRouting` — Defect[] → the proven HERMES-ROUTING.md worklist
GATE
- `packages/core/src/optimize/gate.ts:42` — `evaluateGate` — PURE accept verdict: strict improvement + per-bucket land policy
- `packages/core/src/optimize/driver.ts:124` — `runFixGate` — the FIX→GATE overlord (composes fixer/replay; decides/bounds; lands nothing)
LAND
- `packages/core/src/optimize/land.ts:37` — `writeStagingManifest` — durable deterministic record of the round's decisions
- `packages/core/src/optimize/land.ts:78` — `adoptFile` — backup-then-overwrite the live file from a candidate copy
REPLAY
- `packages/core/src/optimize/replay.ts:87` — `makeReplayStages` — fold a product oracle into baseScore/replayScore/prepareCandidate (abstain→null, VAL-only)
- `packages/core/src/optimize/mine.ts:45` — `mineTaskFromTrace` — the MINING half: read the incumbent's recorded report → a CheckableTask
CLI SEAM
- `packages/cli/src/optimize-fix.ts:96` — `runOptimizeFixCli` — dynamic-import the product `--binding` → compose the core pieces → stage a manifest
- `packages/cli/src/optimize-fix.ts:104` — `enrichCodeMap` — resolve-at-read: dereference each SKILL lesson's [[okf-slice]] → inline the curated code-map into `DefectScope.codeMap`
STREAM (`--fix --watch`)
- `packages/core/src/optimize/events.ts:12` — `OptimizeEvent` — the typed event union the driver emits (one per lifecycle step); the stream is a PROJECTION, never load-bearing
- `packages/core/src/optimize/events.ts:23` — `OptimizeEventSink` — the sink signature `(event: OptimizeEvent) => void`; the `--watch` UI subscribes to it
- `packages/core/src/optimize/events.ts:29` — `renderOptimizeEvent` — one event → a human `--watch` line
- `packages/core/src/optimize/driver.ts:97` — `safeEmit` — the driver's guarded emit point; wraps `onEvent` and re-emits the fixer's OPAQUE sub-trace as a `fixer-trace` event

# Freshness (anti-drift)
anchors ✓ · scope = the seeds above · re-derive when they change · DRIFT NOTE: the live binding (product oracle + fixer) is NOT in this repo — it is dynamic-imported from a game-omni-side module via `--binding` (validated only by a LIVE run, never CI) — so CORE does not fix the fixer's MODEL either; the product binding chooses it (game-omni runs the fixer as Claude Code on a deep-tier model). `criteria.ts`/`parseCriteria` + `events.ts` exist in the dir but are not load-bearing on the core path (criteria is a future SKILL signal; events is the `--watch` projection).

<!-- okf:auto-start -->
> _Auto-generated by `_generate.mjs` — do not hand-edit between the markers; re-run `--write`._

### Final state — file set (seeds)

| File | exists |
|---|---|
| `packages/core/src/optimize/score.ts` | ✓ |
| `packages/core/src/optimize/triage.ts` | ✓ |
| `packages/core/src/optimize/gate.ts` | ✓ |
| `packages/core/src/optimize/driver.ts` | ✓ |
| `packages/core/src/optimize/replay.ts` | ✓ |
| `packages/core/src/optimize/mine.ts` | ✓ |
| `packages/core/src/optimize/land.ts` | ✓ |
| `packages/core/src/optimize/tier1.ts` | ✓ |
| `packages/core/src/optimize/render.ts` | ✓ |
| `packages/core/src/optimize/events.ts` | ✓ |
| `packages/core/src/optimize/types.ts` | ✓ |
| `packages/cli/src/optimize-fix.ts` | ✓ |

### Evolution arc

- `18cb3a7` 2026-06-30 — test(optimize): RED contracts + stubs + fixtures for score/triage layer
- `9163bb3` 2026-06-30 — feat(optimize): the out-of-band Score + Triage pass (v1.5 §7)
- `1775bfa` 2026-06-30 — feat(optimize): the FIX→GATE→LAND overlord (v1.5 §6)
- `7f1c175` 2026-06-30 — feat(optimize): the held-out replay+scoring harness — the v1.5 §5.1 keystone
- `b165d7d` 2026-06-30 — feat(optimize): mineTaskFromTrace — the mining half of the game-omni replay binding (v1.5 §5.1)
- `05a98a7` 2026-06-30 — feat(cli): piflowctl optimize --fix --binding — the product→optimizer injection seam (v1.5 §6)
- `6795a9d` 2026-06-30 — feat(cli): optimize --fix --node <substr> — scope the worklist to one node
- `5bd7c75` 2026-06-30 — feat(optimize): native live streaming — OptimizeEventSink + optimize --fix --watch
- `e56c85d` 2026-06-30 — feat(optimize): surface verify consoleErrors into the fixer's evidence
- `596e6e0` 2026-06-30 — feat(optimize): first-class fixer-aborted OptimizeEvent (portable watchdog/timeout signal)
- `991cb7f` 2026-06-30 — feat(optimize): SDK-level fix-cycle ceiling (portable per-node re-attempt bound + fix-cycle-ceiling event)
- `240da26` 2026-06-30 — feat(optimize): Leg-A recurrence reader — fills the deferred SKILL bucket in triage

### Lessons — memory cluster

**Alias matches** (review — may include false positives):
- [[cloud-sandbox-portability]]
- [[codebase-memory-mcp-analysis]]
- [[delegate-inspection-to-subagents]]
- [[expert-representations]]
- [[game-omni-reference-product]]
- [[gui-nodehud-redesign]]
- [[node-illustration-pipeline]]
- [[optimize-loop-native-not-adhoc]]
- [[piflow-memory-system-v1]]
- [[piflow-optimize-layer-built]]
- [[piflow-overlord-control-plane]]
- [[piflow-product-positioning]]
- [[piflow-rollout-enablement]]

### Code anchors / blast radius (codegraph)

- `scoreRun` (packages/core/src/optimize/score.ts:93) — 4 callers in `packages/cli/src/optimize.ts`, `packages/core/src/index.ts`, `packages/core/src/optimize/index.ts`; ⚠ no covering tests found
- `CheckableTask` (packages/core/src/optimize/replay.ts:34) — 10 callers in `packages/core/src/index.ts`, `packages/core/src/optimize/index.ts`, `packages/core/src/optimize/mine.ts`, `packages/core/src/optimize/replay.ts`; tests: `packages/core/test/optimize-replay.test.ts`, `packages/core/test/optimize-root-exports.test.ts`
- `makeReplayStages` (packages/core/src/optimize/replay.ts:87) — 7 callers in `packages/cli/src/optimize-fix.ts`, `packages/core/src/index.ts`, `packages/core/src/optimize/index.ts`; tests: `packages/core/test/optimize-mine.test.ts`, `packages/core/test/optimize-replay.test.ts`, `packages/core/test/optimize-root-exports.test.ts`
- `runFixGate` (packages/core/src/optimize/driver.ts:124) — 10 callers in `packages/cli/src/optimize-fix.ts`, `packages/core/src/index.ts`, `packages/core/src/optimize/index.ts`; tests: `packages/core/test/optimize-driver-events.test.ts`, `packages/core/test/optimize-driver.test.ts`, `packages/core/test/optimize-fix-cycle.test.ts`, `packages/core/test/optimize-loop-gs01.test.ts` +2
- `renderRouting` (packages/core/src/optimize/render.ts:33) — 6 callers in `packages/cli/src/optimize.ts`, `packages/core/src/index.ts`, `packages/core/src/optimize/index.ts`; tests: `packages/core/test/optimize-gs01.test.ts`, `packages/core/test/optimize-render.test.ts`

<sub>derived 2026-07-01 · arc=12 commits · files=12 · lessons=13</sub>
<!-- okf:auto-end -->
