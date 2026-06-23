// @piflow/core/runner — the M1 execution loop + its injection seams. Barrel for the parent to wire
// into src/index.ts (the parent owns the public-export edit; this file only collects the runner API).

export { runWorkflow, defaultExecRunner, lastJsonBlock, selectedBridgedTool } from './runner.js';
export type { RunOptions, RunResult, ExecRunner, ExecWatchdogOpts } from './runner.js';
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
