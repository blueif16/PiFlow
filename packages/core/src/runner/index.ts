// @piflow/core/runner — the M1 execution loop + its injection seams. Barrel for the parent to wire
// into src/index.ts (the parent owns the public-export edit; this file only collects the runner API).

export { runWorkflow, defaultExecRunner, lastJsonBlock, selectedBridgedTool } from './runner.js';
export type { RunOptions, RunResult, ExecRunner, ExecWatchdogOpts } from './runner.js';
// The env-AGNOSTIC run entry (D5): a plain resolved-config object → compile → run. The bridge stays
// consumer-injected (workflowSpec | buildWorkflowSpec). `loadConfig` resolves the env into this config.
export { runFromConfig } from './entry.js';
export type { ResolvedRunConfig } from './entry.js';
// loadConfig: resolve PI_RUNNER_* env + parsed args → the run-opts subset runFromConfig consumes (env lives HERE).
export { loadConfig } from './config.js';
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
