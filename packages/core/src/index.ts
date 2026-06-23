// @piflow/core — public API.
//
// The frozen L1 schema spine (types) is the contract everything plugs into. The compiler + reference
// primitives below are the spine made executable; horizontal seams (cloud sandboxes, MCP/sdk tool
// compilation, the runner, viz, COMPOSE) fill in against these interfaces without changing the spine.

export * from './types.js';

// DAG compiler (data-flow edge inference + topological staging + validation)
export { compile, tryCompile, validate, inferEdges, stagesOf, slugify, WorkflowError } from './dag.js';

// Workflow extraction: run a Claude Code Workflow .js under recording stubs → realized agent
// records + structural DAG (the RAW recorded shape; the bridge maps it to a WorkflowSpec).
export { extractWorkflow } from './workflow/extract.js';
export type { ExtractedRecord, ExtractedStage, ExtractedMeta, ExtractResult } from './workflow/extract.js';

// Template-format JSON Schemas (draft 2020-12): the on-disk AUTHORING contract for a workflow template
// (docs/design/template-format.md §3/§5). A future loadTemplate/compile step validates node.json /
// meta.json / the generated workflow.json against these fail-closed at author time.
export { nodeSchema, metaSchema, workflowSchema } from './workflow/template/schema/index.js';

// The template LOADER / compile gate (T2): `loadTemplate(dir) → WorkflowSpec` (template-format.md §8) —
// the workflow's `tsc`. Scans nodes/*/, chains deps into the DAG, runs the fail-closed §8 static-check
// suite, renders each node's DRIVER-* marker tail, (re)writes the generated workflow.json lock, and
// returns the in-memory WorkflowSpec the existing `compile`/`runWorkflow` consume.
export { loadTemplate, TemplateError } from './workflow/template/loader.js';
export type { LoadTemplateOpts } from './workflow/template/loader.js';

// RunState (D6): the per-thread channel object + its reducers + the only state I/O. `RunState`/`Reducer`
// types come via `export * from './types.js'` above. The `${state}` resolver / `promote` op land in U7.
export { applyReducer, mergeUpdate, loadState, persistState } from './workflow/state.js';

// Contract-marker codec (DRIVER-*)
export { emitMarkers, parseMarkers, markersFromNode } from './contract.js';
export type { ContractMarkers } from './contract.js';

// Integrity-check engine (detection ⊥ consequence): predicates, fill-sentinel, verdict→action policy
export { CHECK_KINDS, evaluateChecks, effectiveChecks, actionForVerdict, lastFencedBlock, escapeRegex } from './checks.js';
export type { CheckResult, FileBytes } from './checks.js';

// Tool registry (namespace:name → bare pi names)
export { DefaultToolRegistry, BUILTIN_TOOLS } from './tools/registry.js';
// Ingestion: MCP tools/list → ToolEntry[] (the effortless catalog fill)
export { mcpToolsToEntries } from './tools/ingest.js';
export type { McpToolListing, McpIngestOpts } from './tools/ingest.js';
// Ingestion: names-only OpenClaw plugin manifest → skeleton sdk ToolEntry[] (the `sdk` lane)
export { openClawPluginToEntries } from './tools/ingest.js';
export type { OpenClawManifest, OpenClawIngestOpts } from './tools/ingest.js';
// OpenClaw capture-shim: run a plugin's register() to capture its native tool defs (+ purity gate)
export { captureOpenClawTools, makeCaptureApi } from './tools/openclaw-shim.js';
export type { OpenClawToolDef, CapturedTool, CaptureApi, OpenClawPluginEntry } from './tools/openclaw-shim.js';
// Compile: ToolEntry[] → generated `-e` extension source (the declarative wiring)
export { compileToolExtension, planTools, renderExtension, DEFAULT_BRIDGE_MODULE, DEFAULT_SHIM_MODULE } from './tools/compile.js';
export type { CompiledExtension, PlannedTool, CompileOpts } from './tools/compile.js';
// Bundle: render → ONE self-contained ESM `-e` file (esbuild; inlines bridge/SDK/plugin, pi specifiers external)
export { bundleExtension, PI_INJECTED_EXTERNALS } from './tools/compile.js';
export type { BundleOpts } from './tools/compile.js';
// Verify: the per-node bind pre-check (declared tools ⊆ bindable, no collisions)
export { verifyToolBinding } from './tools/verify.js';
export type { BindReport } from './tools/verify.js';
// Catalog (M4 seed): the tiny persisted, searchable registry-as-code + a registry seeded with it
export { OPENCLAW_SEED_CATALOG, loadCatalog, seededRegistry } from './tools/catalog.js';
// Community catalog: a curated, pinned crawl of REAL OpenClaw tool plugins (discoverable, gateway-coupled)
export { OPENCLAW_COMMUNITY_CATALOG, OPENCLAW_PIN } from './tools/openclaw-community.js';

// Sandbox providers (lifecycle; in-memory reference impl + not-implemented stubs)
export { InMemorySandbox, InMemorySandboxProvider, NotImplementedProvider } from './sandbox/index.js';
// Local in-place provider ('local' kind): roots the sandbox AT workdir (no temp dir), dispose is a NO-OP
// (preserves the user's tree) — the semantic opposite of InMemory (which wipes on dispose).
export { LocalSandbox, LocalSandboxProvider } from './sandbox/local.js';
// Bounded stdout/stderr capture (guards every provider against the cumulative-snapshot string blow-up)
export { tailAppend, DEFAULT_CAPTURE_MAX } from './sandbox/capture.js';
// Seatbelt read-scope provider (macOS)
export { SeatbeltSandbox, SeatbeltSandboxProvider, buildSeatbeltProfile } from './sandbox/seatbelt.js';
// Worktree per-run git WRITE-isolation provider (run-scoped: branch pi/<run> + sibling .pi-worktrees/<run>)
export { WorktreeSandbox, WorktreeSandboxProvider } from './sandbox/worktree.js';
// Daytona cloud provider (run-scoped VM lifecycle) + its dependency-inversion SDK seam.
export { DaytonaSandbox, DaytonaSandboxProvider } from './sandbox/daytona.js';
export type {
  DaytonaSdk,
  DaytonaVm,
  DaytonaFs,
  DaytonaProcess,
  DaytonaCreateParams,
  DaytonaExecResponse,
  DaytonaSessionCommand,
  DaytonaSessionCommandInfo,
} from './sandbox/daytona.js';
// Live wiring: the real `@daytona/sdk` adapter + convenience factory (the ONLY SDK-importing module).
export { realDaytonaSdk, createDaytonaProvider } from './sandbox/daytona-sdk.js';
export type { CreateDaytonaProviderOpts } from './sandbox/daytona-sdk.js';

// Deterministic hook runner
export { runHooks } from './hooks/index.js';
export type { HookReport, RunHooksOpts } from './hooks/index.js';

// Runner (M1 execution loop — create→stage→exec→collect→dispose; watchdogs · halt-on-failure ·
// --from resume · run-status.json). The pi-spawn is injectable (buildCommand/execRunner) so it runs offline.
export { runWorkflow, defaultExecRunner, defaultPiCommand, lastJsonBlock, writeStatus, artifactState, nowISO } from './runner/index.js';
// Post-node schema gate (injectable validator seam + best-effort ajv-2020 default)
export { validateArtifactSchemas, defaultSchemaValidator } from './runner/index.js';
export type { SchemaValidator, SchemaCheckResult } from './runner/index.js';
// Scoped-token / sealing-broker seam: a host plugs a SecretResolver so a cloud VM gets a short-lived
// scoped token, not the raw credential (also surfaced via `export * from './types.js'` above).
export { defaultSecretResolver } from './runner/index.js';
export type { SecretResolver } from './runner/index.js';
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
// Observability — `docker logs` for a run: per-node event capture (NodeRecorder) + the distill/tail/
// follow reader the `piflow logs` CLI is built on. Any consumer streams a run via these or `npx piflow logs`.
export {
  NodeRecorder,
  recordingSandbox,
  slimEvent,
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
  auditWorkflow,
  hasToolFindings,
} from './runner/index.js';
export type { PiEvent, EventSink, FollowOpts, NodeDiagnosis, NodeToolAudit } from './runner/index.js';
// Per-run `.pi/` layout (D7): the engine-owned, project-identical path helpers + the io.json ledger
// writer. Pure path joins (opaque `run` base — core never hardcodes `.piflow/<wf>/runs/`) except
// writeNodeIo. `NodeIo` type comes via `export * from './types.js'` above.
export {
  piDir,
  stateFile,
  runJsonFile,
  nodeDir,
  nodeIoFile,
  nodePromptFile,
  nodeToolsFile,
  nodeMcpFile,
  nodeEventsFile,
  writeNodeIo,
} from './runner/layout.js';
