// @piflow/core/runner — the M1 execution loop + its injection seams. Barrel for the parent to wire
// into src/index.ts (the parent owns the public-export edit; this file only collects the runner API).

export { runWorkflow, defaultExecRunner, defaultCheckpointWait, lastJsonBlock, selectedBridgedTool } from './runner.js';
export type { RunOptions, RunResult, ExecRunner, ExecWatchdogOpts, CheckpointWaiter } from './runner.js';
// (op⊖ops) derivesFromOp / gatesFromOp / runOpsFromOp — the SINGLE OpSpec→executor-input adapter home (the
// SOLE derive rep is `op[]`). Surfaced so consumers (the CLI inspector) render derives from `op[]` instead of
// the retired `node.ops`; gatesFromOp/runOpsFromOp unify the gate/run reads the runner inlined per lane (C2).
export { derivesFromOp, gatesFromOp, runOpsFromOp } from './op-dispatch.js';
export type { DerivedExecInputs, ProjectOp, RegistryProject, PromoteInput, RunnableOp, RejectedRunOp } from './op-dispatch.js';
// G5 — HUMAN CHECKPOINT (HITL): the marker/reply schemas, the question hash, and the reply validator (the
// runner's authority). The Vite courier + the console write the reply file; observe surfaces the marker.
export {
  hashCheckpoint,
  buildMarker,
  validateReply,
  writeMarker,
  readMarker,
  readReply,
  readCheckpointJournal,
  journalCheckpoint,
  CHECKPOINT_CHANNEL,
} from './checkpoint.js';
export type {
  CheckpointMarker,
  CheckpointReply,
  CheckpointJournalSlot,
  ReplyVerdict,
} from './checkpoint.js';
// The env-AGNOSTIC run entry (D5): a plain resolved-config object → compile → run. The bridge stays
// consumer-injected (workflowSpec | buildWorkflowSpec). `loadConfig` resolves the env into this config.
export { runFromConfig, runFromTemplate } from './entry.js';
export type { ResolvedRunConfig, RunFromTemplateOpts } from './entry.js';
// loadConfig: resolve PI_RUNNER_* env + parsed args → the run-opts subset runFromConfig consumes (env lives HERE).
export { loadConfig, parseArgFlags } from './config.js';
export type { ConfigArgs, LoadConfigInput, ResolvedRunOpts } from './config.js';
// The scoped-token / sealing-broker seam (defined in ../types.js; re-exported so a host wiring a broker
// alongside the runner finds it here too).
export { defaultSecretResolver } from '../types.js';
export type { SecretResolver } from '../types.js';
export { defaultPiCommand } from './command.js';
export type { CommandBuilder, CommandContext } from './command.js';
export { validateArtifactSchemas, defaultSchemaValidator } from './schema.js';
export type { SchemaValidator, SchemaCheckResult } from './schema.js';
export { writeStatus, artifactState, nowISO } from './status.js';
export type {
  RunStatus,
  NodeStatus,
  NodeStatusRecord,
  ArtifactState,
  RunTotals,
} from './status.js';
// G4 — content-hash journal/replay resume: the per-node envelope hash, the reuse decision, and the
// atomic `.pi/journal.json` reader/writer. G5 (HITL checkpoint journaling) composes onto this.
export {
  envelopeHash,
  inputFilesOf,
  descendantsMap,
  decideResume,
  hashFile,
  loadJournal,
  writeJournalEntry,
  journalFile,
  journalBakFile,
  JOURNAL_VERSION,
} from './journal.js';
export type { Journal, JournalNode, NodeDecision, Decision, ResumeInputs } from './journal.js';
// Observability: per-node event capture (write side) + the docker-style logs reader (read side).
export { NodeRecorder, recordingSandbox, slimEvent } from './events.js';
export type { PiEvent, EventSink } from './events.js';
export {
  makeDistiller,
  distillEvents,
  tailNode,
  followRun,
  runLogsCli,
  parseEventsFile,
  eventsPath,
  statusFilePath,
  diagnoseRun,
  renderDiagnosis,
} from './logs.js';
export type { FollowOpts, NodeDiagnosis } from './logs.js';
// Static pre-run tool/wiring audit over a compiled workflow.
export { auditWorkflow, hasToolFindings } from './audit.js';
export type { NodeToolAudit } from './audit.js';
// G1 — per-node model/provider routing: the single home of the override order.
export {
  resolveNodeModel,
  ModelRoutingError,
  loadModelTiers,
  loadModelsIndex,
  defaultTiersPath,
  defaultModelsPath,
} from './model-routing.js';
export type { ModelTiers, NodeRouting, RunRouting, EffectiveModel } from './model-routing.js';
