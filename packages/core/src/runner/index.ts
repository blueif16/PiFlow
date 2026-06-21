// @piflow/core/runner — the M1 execution loop + its injection seams. Barrel for the parent to wire
// into src/index.ts (the parent owns the public-export edit; this file only collects the runner API).

export { runWorkflow, defaultExecRunner, lastJsonBlock } from './runner.js';
export type { RunOptions, RunResult, ExecRunner, ExecWatchdogOpts } from './runner.js';
export { defaultPiCommand } from './command.js';
export type { CommandBuilder, CommandContext } from './command.js';
export { writeStatus, artifactState, nowISO } from './status.js';
export type {
  RunStatus,
  NodeStatus,
  NodeStatusRecord,
  ArtifactState,
  RunTotals,
} from './status.js';
