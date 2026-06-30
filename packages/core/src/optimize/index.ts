// optimize/ — the out-of-band Score + Triage pass (piflow-memory-v1.5 §7). Pure, read-only, post-run;
// NEVER an in-DAG node. Reads a finished run's traces + the product's criteria → the worklist a fixer
// consumes (= the automated HERMES-ROUTING.md). This facade re-exports the layer's public surface.

export * from './types.js';
export { scoreNodes, scoreRun } from './score.js';
export type { ScoreInput, ScoreRunOpts } from './score.js';
export { triage } from './triage.js';
export type { TriageOpts } from './triage.js';
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
  Fixer, ReplayScore, PrepareCandidate, BaseScore, CandidateEdit,
  FixGateStages, FixGateOpts, FixGateRecord, FixGateResult,
} from './driver.js';
export { writeStagingManifest, adoptFile } from './land.js';
export type { StageOpts } from './land.js';
