// @piflow/core — public API.
//
// The frozen L1 schema spine (types) is the contract everything plugs into. The compiler + reference
// primitives below are the spine made executable; horizontal seams (cloud sandboxes, MCP/sdk tool
// compilation, the runner, viz, COMPOSE) fill in against these interfaces without changing the spine.

export * from './types.js';

// DAG compiler (data-flow edge inference + topological staging + validation)
export { compile, tryCompile, validate, inferEdges, stagesOf, slugify, WorkflowError } from './dag.js';

// Contract-marker codec (DRIVER-*)
export { emitMarkers, parseMarkers, markersFromNode } from './contract.js';
export type { ContractMarkers } from './contract.js';

// Tool registry (namespace:name → bare pi names)
export { DefaultToolRegistry, BUILTIN_TOOLS, PENDING_EXTENSION } from './tools/registry.js';
// Ingestion: MCP tools/list → ToolEntry[] (the effortless catalog fill)
export { mcpToolsToEntries } from './tools/ingest.js';
export type { McpToolListing, McpIngestOpts } from './tools/ingest.js';
// Compile: ToolEntry[] → generated `-e` extension source (the declarative wiring)
export { compileToolExtension, planTools, renderExtension, DEFAULT_BRIDGE_MODULE } from './tools/compile.js';
export type { CompiledExtension, PlannedTool, CompileOpts } from './tools/compile.js';

// Sandbox providers (lifecycle; in-memory reference impl + not-implemented stubs)
export { InMemorySandbox, InMemorySandboxProvider, NotImplementedProvider } from './sandbox/index.js';
// Seatbelt read-scope provider (macOS) + worktree stub (ROADMAP M1)
export { SeatbeltSandbox, SeatbeltSandboxProvider, WorktreeSandboxProvider, buildSeatbeltProfile } from './sandbox/seatbelt.js';

// Deterministic hook runner
export { runHooks } from './hooks/index.js';
export type { HookReport, RunHooksOpts } from './hooks/index.js';

// Runner (M1 execution loop — create→stage→exec→collect→dispose; watchdogs · halt-on-failure ·
// --from resume · run-status.json). The pi-spawn is injectable (buildCommand/execRunner) so it runs offline.
export { runWorkflow, defaultExecRunner, defaultPiCommand, lastJsonBlock, writeStatus, artifactState, nowISO } from './runner/index.js';
export type {
  RunOptions,
  RunResult,
  ExecRunner,
  ExecWatchdogOpts,
  CommandBuilder,
  CommandContext,
  RunStatus,
  NodeStatus,
  NodeStatusRecord,
  ArtifactState,
  RunTotals,
} from './runner/index.js';
