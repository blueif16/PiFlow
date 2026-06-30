---
type: subsystem
key: optimize
title: Optimize (the post-run self-correction loop — score → triage → fix → gate → land → worklist)
description: The out-of-band optimizer — a finished run's trace folds through scoreRun (Tier-0 telemetry disqualifier × Tier-1 checkable outcome) → triage (four-way LAPSE/SKILL/FUNCTIONALITY/ARCH) → runFixGate (a deterministic driver composing a product-injected fixer + held-out replay) → evaluateGate (accept iff a candidate copy strictly improves) → land (stage/adopt) → renderRouting (the HERMES-ROUTING.md worklist).
resource: packages/core/src/optimize/driver.ts
aliases: [optimize, optimizer, scoreRun, scoreNodes, triage, evaluateGate, runFixGate, makeReplayStages, mineTaskFromTrace, renderRouting, readVerifyReport, writeStagingManifest, adoptFile, DefectBucket, NodeScore, Tier0, Tier1, FIX-GATE-LAND, HERMES-ROUTING, self-correction, hermes, accept-gate, replay, strict-improvement, --binding, --fix]
seeds: [packages/core/src/optimize/score.ts, packages/core/src/optimize/triage.ts, packages/core/src/optimize/gate.ts, packages/core/src/optimize/driver.ts, packages/core/src/optimize/replay.ts, packages/core/src/optimize/mine.ts, packages/core/src/optimize/land.ts, packages/core/src/optimize/tier1.ts, packages/core/src/optimize/render.ts, packages/core/src/optimize/types.ts, packages/cli/src/optimize-fix.ts]
symbols: [scoreRun, scoreNodes, triage, evaluateGate, runFixGate, makeReplayStages, mineTaskFromTrace, readVerifyReport, renderRouting, writeStagingManifest, adoptFile, NodeScore, Defect, DefectBucket, GateVerdict, CheckableTask]
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

# Anchors
SCORE
- `packages/core/src/optimize/score.ts:35` — `scoreNodes` — PURE fold (Tier-0 disqualifier × Tier-1 value) → NodeScore[]
- `packages/core/src/optimize/score.ts:93` — `scoreRun` — impure shell: read run dir + recorded verify reports, then fold
- `packages/core/src/optimize/tier1.ts:38` — `readVerifyReport` — project a verify-milestone report → Tier1Result (abstain re-tag)
TRIAGE
- `packages/core/src/optimize/triage.ts:35` — `triage` — four-way LAPSE/SKILL/FUNCTIONALITY/ARCH projector → Defect[]
- `packages/core/src/optimize/render.ts:33` — `renderRouting` — Defect[] → the proven HERMES-ROUTING.md worklist
GATE
- `packages/core/src/optimize/gate.ts:42` — `evaluateGate` — PURE accept verdict: strict improvement + per-bucket land policy
- `packages/core/src/optimize/driver.ts:86` — `runFixGate` — the FIX→GATE overlord (composes fixer/replay; decides/bounds; lands nothing)
LAND
- `packages/core/src/optimize/land.ts:37` — `writeStagingManifest` — durable deterministic record of the round's decisions
- `packages/core/src/optimize/land.ts:78` — `adoptFile` — backup-then-overwrite the live file from a candidate copy
REPLAY
- `packages/core/src/optimize/replay.ts:87` — `makeReplayStages` — fold a product oracle into baseScore/replayScore/prepareCandidate (abstain→null, VAL-only)
- `packages/core/src/optimize/mine.ts:45` — `mineTaskFromTrace` — the MINING half: read the incumbent's recorded report → a CheckableTask
CLI SEAM
- `packages/cli/src/optimize-fix.ts:87` — `runOptimizeFixCli` — dynamic-import the product `--binding` → compose the core pieces → stage a manifest

# Freshness (anti-drift)
anchors ✓ · scope = the seeds above · re-derive when they change · DRIFT NOTE: the live binding (product oracle + fixer) is NOT in this repo — it is dynamic-imported from a game-omni-side module via `--binding` (validated only by a LIVE run, never CI); `criteria.ts`/`parseCriteria` + `events.ts` exist in the dir but are not load-bearing on the core path (criteria is a future SKILL signal; events is the `--watch` projection).
