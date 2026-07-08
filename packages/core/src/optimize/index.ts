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

// The SUBSTRATE issue LEDGER (docs/specs/optimize-substrate-plan.md §M2) — the second optimization system's
// durable, reopenable worklist: one markdown file per issue under `<templateDir>/nodes/<node>/issues/`.
// Parse/write/validate one issue file; list/filter/sort the ledger; the append-only attempt history; the
// status-machine transition guards. A SIBLING system to the §7 Score+Triage worklist above, not a replacement.
export {
  computeIssueId, validateIssue, parseIssueFile, writeIssueFile, stampAttempt, reopen,
  assertTransition, transitionIssue, listIssues, ALLOWED_TRANSITIONS,
} from './substrate/issues.js';
export type {
  Issue, Severity, Status, Reason, Attempt, IssueRecord, ListIssuesOpts,
} from './substrate/issues.js';

// The SUBSTRATE hard MEASUREMENT stage (docs/specs/optimize-substrate-plan.md §M3) — fires a node's
// `optimize.measure` op[] (read straight off its node.json) + the built-in trace detectors + the run digest
// into ONE deterministic `<runDir>/optimize/substrate/measure.<node>.json` report. Fully external to the
// runner (node-lifecycle.ts is untouched); the M4 judge consumes this report as its hard-evidence input.
export { runSubstrateMeasure } from './substrate/measure.js';
export type { RunSubstrateMeasureOpts, MeasureReport, MeasureOpsSection, OpRunResult } from './substrate/measure.js';
// The generic, product-agnostic pi-event trace DETECTORS (thinking-stall span, tool-loop identical-result
// grouping, cumulative token-waste growth, provider-aware cache-miss) over `.pi/nodes/<id>/events.jsonl` —
// core-legal (no product logic), reused directly by `measure.ts` and testable standalone over raw lines.
export { analyzeEvents, analyzeTraceFile, DEFAULT_SUBSTRATE_THRESHOLDS } from './substrate/trace-metrics.js';
export type {
  SubstrateThresholds, TraceMetricsReport, ThinkingSpan, ToolLoopFlag, TokenWasteSignal, CacheMissFlag,
} from './substrate/trace-metrics.js';

// The SUBSTRATE FIX phase (docs/specs/optimize-substrate-plan.md §M6) — per ONE issue: activate → candidate
// closure (the {{WORKSPACE}}-read closure MINUS the oracle exclusions) → fixer agent → prove-rerun → the
// graded-delta gate (REUSING evaluateGate) → stage a substrate manifest; ADOPT is the SEPARATE human step
// (adoptSubstrateManifest → adoptFile + commitAdoption → stampAttempt → status resolved). Its OWN dedicated
// SubstrateEvent stream + renderSubstrateEvent projection (a sibling of optimize/events.ts, never shared).
export {
  fixIssue, adoptSubstrateManifest, commitAdoption, prepareCandidateClosure, foldGradedDelta,
  hashCandidateTree, countChangedFiles, collectWorkspaceRefs, buildFixerPrompt, readSubstrateManifest,
  UNPROVEN_BY_RUN,
} from './substrate/fix.js';
export type {
  FixIssueOpts, FixIssueResult, CandidateClosure, FoldGradedOpts, FoldGradedResult,
  CommitAdoptionResult, CommitIssueRef, SubstrateManifest, SubstrateManifestRecord,
  AdoptSubstrateManifestOpts, AdoptSubstrateManifestResult, RetryContext,
} from './substrate/fix.js';
export { renderSubstrateEvent, safeEmit as safeEmitSubstrate } from './substrate/events.js';
export type { SubstrateEvent, SubstrateEventSink } from './substrate/events.js';

// The OUTER retry loop (docs/design/optimize-verification-loop.md §8) — the bounded, diversifying loop that
// CONSUMES the gate's soft-gate drop-back: fresh fixer per attempt (own candidate dir + prior-drop-back
// context, never the rubric), a triple cap (attempts · wall · token), keep-best + a closed escalation menu on
// exhaustion, plus the system-wide "N consecutive exhausted ⇒ architecture problem" breaker.
export { fixIssueWithRetries, makeConsecutiveExhaustedBreaker } from './substrate/retry-loop.js';
export type {
  FixWithRetriesOpts, FixWithRetriesResult, RetryAttemptRecord, RetryEscalationPacket, RetryStopReason,
} from './substrate/retry-loop.js';

// The SUBSTRATE SOFT-JUDGE stage (docs/specs/optimize-substrate-plan.md §M4) — spawns ONE judge agent turn
// over a run's measure report + criteria/gold/memory + the existing ledger, then mechanically post-processes
// the agent's issue DRAFTS into identity-stamped Issue files and stamps the triaged marker. The `optimize
// triage` CLI (M5) runs runSubstrateMeasure FIRST, then this — hard-feeds-soft is that verb's contract.
export { runSubstrateJudge } from './substrate/judge.js';
export type { SubstrateJudgeOpts, SubstrateJudgeResult } from './substrate/judge.js';
