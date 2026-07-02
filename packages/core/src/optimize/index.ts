// optimize/ — the out-of-band Score + Triage pass (piflow-memory-v1.5 §7). Pure, read-only, post-run;
// NEVER an in-DAG node. Reads a finished run's traces + the product's criteria → the worklist a fixer
// consumes (= the automated HERMES-ROUTING.md). This facade re-exports the layer's public surface.

export * from './types.js';
export { scoreNodes, scoreRun } from './score.js';
export type { ScoreInput, ScoreRunOpts } from './score.js';
export { triage } from './triage.js';
export type { TriageOpts } from './triage.js';
export { deriveRecurrence, signatureOf } from './recurrence.js';
export type { RecurrenceIndex, RecurrenceHit } from './recurrence.js';
export { memorize } from './memorize.js';
export type { MemorizeOpts, MemorizeResult, MemorizeLesson } from './memorize.js';
// The DISTILLATION SEAM (v1.5 §6; memory-slices MODE B) — turns MEMORIZE's `(pending …)` Root/Prevention
// placeholders into real distilled prose. The write is deterministic (fillLessonProse); the model call is
// INJECTED as a LessonDistiller (core holds no model/network/prompt) and distillLesson degrades on a bad one.
export { fillLessonProse, distillLesson } from './distill.js';
export type { LessonProse, LessonDistiller, DistillLessonOpts } from './distill.js';
// The cap/retire COMPACTION pass (v1.5 §5.3; memory-slices MODE B) — the out-of-band counterpart of MEMORIZE's
// per-round append/update that keeps memory.md bounded by RETIRING discrete lowest-value blocks (never re-summarizes).
export { compactMemory, DEFAULT_MAX_LESSONS } from './compact.js';
export type { CompactOpts, CompactResult, RetiredLesson, RetireReason } from './compact.js';
export { parseCriteria } from './criteria.js';
export { readVerifyReport } from './tier1.js';
export { renderRouting } from './render.js';
export type { RoutingMeta } from './render.js';

// The FIX→GATE→LAND overlord (v1.5 §6) — the deterministic driver + the across-run accept gate + the LAND
// seam. The driver composes injected model stages (fixer · replayScore) but decides/bounds/lands in code,
// gating on a candidate copy with the strict-improvement ratchet; it never mutates the live file.
export { evaluateGate } from './gate.js';
export type { GateInput, GateVerdict, LandPolicy } from './gate.js';
export { runFixGate } from './driver.js';
export type {
  Fixer, ReplayScore, PrepareCandidate, LiveRootFor, BaseScore, CandidateEdit,
  FixGateStages, FixGateOpts, FixGateRecord, FixGateResult, FixCycleSkip,
} from './driver.js';
export { writeStagingManifest, adoptFile, adoptFromManifest } from './land.js';
export type { StageOpts, AdoptManifest, AdoptReport } from './land.js';

// The multi-round OVERLORD (v1.5 §6) — the deterministic straight-line driver that composes the injected
// round stages (run → score+triage → fix+gate → memorize) over N rounds, bounding by run-count + convergence +
// stall + a circuit-breaker. All intelligence stays in the injected stages; the loop only sequences/bounds/records.
export { runOptimizeLoop } from './loop.js';
export type { OptimizeLoopStages, OptimizeLoopOpts, OptimizeLoopResult, RoundRecord, LoopStopReason } from './loop.js';

// The LONG-HORIZON outer loop (v1.5 §6 reconcile, lifted) — the counterpart to the multi-round inner loop: each
// GENERATION runs the inner loop, then an INJECTED redesign subgraph authors the NEXT workflow's blueprint. The
// redesign (the self-design intelligence) is DEFERRED (the STOP); core pins the thin outer driver + the contract.
export { runLongHorizon } from './long-horizon.js';
export type {
  LongHorizonStages, LongHorizonOpts, LongHorizonResult, GenerationRecord,
  NextWorkflowPlan, RedesignStage, RunGeneration, LongHorizonStopReason,
} from './long-horizon.js';

// The LIVE progress surface for the FIX→GATE loop — its OWN dedicated event sink (NOT the runner's EventSink):
// the driver emits one typed OptimizeEvent per phase boundary, fire-and-forget, and `renderOptimizeEvent` is
// the pure one-line projection the `--watch` CLI prints.
export { renderOptimizeEvent } from './events.js';
export type { OptimizeEvent, OptimizeEventSink } from './events.js';

// The held-out replay+scoring harness (v1.5 §5.1) — the KEYSTONE that makes baseScore/replayScore REAL off a
// product oracle. Product-agnostic: folds whatever verify report the injected oracle emits (via readVerifyReport),
// enforcing abstain→null and VAL-hygiene. The product (game-omni) supplies oracle · mineTask · copyScope.
export { makeReplayStages } from './replay.js';
export type { CheckableTask, ReplayOracle, MineTask, CopyScope, ReplayDeps, ReplayStages } from './replay.js';
// The MINING half of the replay binding (v1.5 §5.1) — the default trace task-miner. Reads the incumbent's
// recorded report from a run trace into a CheckableTask (game-omni default config, injectable); the live
// oracle (which imports the product's verify harness + builds the candidate) stays product-side.
export { mineTaskFromTrace, gameOmniNodeToMilestone } from './mine.js';
export type { MineOpts } from './mine.js';
