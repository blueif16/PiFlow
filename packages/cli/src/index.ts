// @piflow/cli — programmatic surface for the run-observability subcommands. The `piflow` bin
// (`./cli.ts`) is the executable front door; these are THIN renderers over the shared observability
// source (`@piflow/core/observe`) — `renderStatus` lays out a `RunModel` (read it with the core's
// `readRunModel`); `watchRun` consumes the core's live `watchRun` stream. The CLI builds no run model
// of its own — model-building lives entirely in `@piflow/core/observe`.

export { renderStatus, runStatusCli } from './status.js';
export { watchRun, runWatchCli } from './watch.js';
export type { WatchResult, WatchOpts, WatchReason } from './watch.js';
export { extractTemplate, renderDag, runExtractCli } from './extract.js';
export {
  buildMeta,
  buildNode,
  scaffoldNew,
  scaffoldAddNode,
  runNewCli,
  runAddNodeCli,
} from './scaffold.js';
export type { NewOpts, NodeOpts, CheckOpt, McpServers } from './scaffold.js';
export { runTemplate, dryRunPlan, parseRunArgs, runRunCli } from './run.js';
export type { RunDeps, ParsedRunArgs } from './run.js';
// The DEFAULT file-backed fix-cycle counter port — the CLI-seam provider that makes `--fix-cycle-ceiling` work
// out-of-the-box (a product can reuse it, or override it by exporting its own readFixCycles/bumpFixCycles).
export { makeDefaultFixCyclesPort } from './optimize-fix.js';
