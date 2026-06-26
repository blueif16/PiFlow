// @piflow/core — public API.
//
// The frozen L1 schema spine (types) is the contract everything plugs into. The compiler + reference
// primitives below are the spine made executable; horizontal seams (cloud sandboxes, MCP/sdk tool
// compilation, the runner, viz, COMPOSE) fill in against these interfaces without changing the spine.

export * from './types.js';

// DAG compiler (data-flow edge inference + topological staging + validation)
export { compile, tryCompile, validate, inferEdges, stagesOf, slugify, WorkflowError } from './dag.js';

// Run PROFILES — the generic node-elision primitive (profiles-and-resume-robustness.md Phase 2): resolve
// a template-declared profile NAME to a `ProfileSpec` predicate and elide the matched nodes (deps rewired
// transitively) BEFORE compile. `ProfileSpec`/`WorkflowSpec.profiles` types come via `export * from './types.js'`.
export { applyProfile, applyProfileByName, resolveProfile, UnknownProfileError } from './workflow/profile.js';

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

// init-RUN (T5 / template-format.md §10): instantiate a runnable THREAD from an authored template dir —
// the four buckets (pure-copy node.json+prose · intrinsic {{RUN}}/{{WORKSPACE}} resolve, {{state.*}}
// deferred · markersFromNode tail · EMPTY io.json/events.jsonl/state.json stubs). Template ≅ run (D7).
export { instantiateRun } from './workflow/template/instantiate.js';
export type { InstantiateRunOpts, InstantiateRunResult, InstantiatedNode } from './workflow/template/instantiate.js';
export { renderRealizedPrompt } from './workflow/template/render.js';

// G6 — agentType presets: the PURE author-time merge utility + the read-only catalog adapter. The catalog
// (named types, icons, role-prompts) is PRODUCT DATA in ~/.piflow/agents/ — only this LOGIC lives in core.
export { mergePreset, parseAgentPreset, loadAgentPreset, defaultAgentsDir } from './workflow/agent-preset.js';
export type { AgentPreset, PresetMergeable } from './workflow/agent-preset.js';

// (Phase 2) Fusion nodes: the pre-compile siblings+judge expansion + its built-in fusion PRESET AGENTS
// (the judge/obligations roles). `expandFusion` runs before `compile`; the presets brand the generated
// nodes via `agentType`. The verbatim Appendix-A prompt bodies + token fillers live in `fusion/prompts`.
export { expandFusion, FusionConfigError } from './workflow/fusion/expand.js';
export type { FusionDefaults, FusionExpandOpts } from './workflow/fusion/expand.js';
// (G12 — M3) Bounded conditional reroute / self-fix: the pre-compile UNROLL of a QA loop into forward-only
// acyclic clones (the `expandFusion` move), with a zero-pi existence-gate short-circuit (#17). Runs before
// `compile`, immediately after `expandFusion`.
export { expandReroute, RerouteConfigError } from './workflow/reroute/expand.js';
export {
  FUSION_PRESETS,
  FUSION_JUDGE_MOA,
  FUSION_JUDGE_BEST_OF_N,
  FUSION_OBLIGATIONS,
  judgePresetId,
} from './workflow/fusion/presets.js';
// The read-only global fusion defaults reader (`~/.piflow/fusion.json`) — the analogue of `loadModelTiers`.
export { loadFusionConfig, defaultFusionConfigPath } from './runner/fusion-config.js';
export type { FusionConfig } from './runner/fusion-config.js';

// RunState (D6): the per-thread channel object + its reducers + the only state I/O. `RunState`/`Reducer`
// types come via `export * from './types.js'` above.
export { applyReducer, mergeUpdate, loadState, persistState } from './workflow/state.js';

// U7 — the SINGLE runtime token resolver: `{{RUN}}`/`{{WORKSPACE}}`/`{{state.<channel>}}` made physical,
// applied uniformly to every marker (retires the `BASE_ROOT→wtRoot` regex + `RUN_CWD`-relative tokens).
export { resolveTokens, resolveAll, MissingChannelError, MissingArgError } from './workflow/resolver.js';
export type { ResolveCtx } from './workflow/resolver.js';

// U7 — deterministic op executors (seed PRE · project/merge POST), re-rooted onto the logical resolver.
export { driverSeed, resolveSeedTokens, stageSeed } from './workflow/ops/seed.js';
export type { Seed, SeedResult } from './workflow/ops/seed.js';
export { ensureDir, projJson, drillPath, readJsonSafe, fileExists, absUnder } from './workflow/ops/util.js';
// DRIVER-PROJECT ops: generic JSON transforms (copy | assemble | merge | union) + the registry-keyed
// projection runner that resolves a record by key and applies its `projections` op-map.
export { applyProjectionOp, runProjection } from './workflow/ops/project.js';
export type { ProjectionResult, ProjectionMarker, ProjectionSummary } from './workflow/ops/project.js';
export { applyMergeOp, runMerge } from './workflow/ops/merge.js';
export type { MergeResult, MergeSpec } from './workflow/ops/merge.js';

// U7 — the `promote` POST-op (lift a node output into a RunState channel via the reducer) + the
// stage-barrier merge (serial+deterministic parallel-promote merge; a `set` channel with two concurrent
// writers is a flagged ConflictError — LangGraph InvalidUpdateError semantics).
export { parsePromote, extractPromoteValue, applyPromotes, barrierMerge, ConflictError } from './workflow/ops/promote.js';
export type { PromoteSpec, ResolvedPromote, PromoteCtx, NodeUpdate } from './workflow/ops/promote.js';

// Contract-marker codec (DRIVER-*)
export { emitMarkers, parseMarkers, markersFromNode } from './contract.js';
export type { ContractMarkers } from './contract.js';

// Integrity-check engine (detection ⊥ consequence): predicates, fill-sentinel, verdict→action policy
export { CHECK_KINDS, evaluateChecks, effectiveChecks, actionForVerdict, lastFencedBlock, escapeRegex } from './checks.js';
export type { CheckResult, FileBytes } from './checks.js';

// Tool registry (namespace:name → bare pi names)
export { DefaultToolRegistry, BUILTIN_TOOLS, DEFAULT_TOOLS } from './tools/registry.js';
// The first-party `submit_result` contract tool (the typed terminating return tool): the catalog entry
// (seeded into every DefaultToolRegistry) + its param schema + its inline-execute render for the `-e` ext.
export { SUBMIT_RESULT_TOOL, SUBMIT_RESULT_PARAMETERS, SUBMIT_RESULT_ADDRESS, renderContractTool } from './tools/contract-tool.js';
export type { ContractRenderable } from './tools/contract-tool.js';
// Ingestion: MCP tools/list → ToolEntry[] (the effortless catalog fill)
export { mcpToolsToEntries } from './tools/ingest.js';
export type { McpToolListing, McpIngestOpts } from './tools/ingest.js';
// Ingestion: names-only OpenClaw plugin manifest → skeleton sdk ToolEntry[] (the `sdk` lane)
export { openClawPluginToEntries } from './tools/ingest.js';
export type { OpenClawManifest, OpenClawIngestOpts } from './tools/ingest.js';
// OpenClaw capture-shim: run a plugin's register() to capture its native tool defs (+ purity gate)
export { captureOpenClawTools, captureOpenClawHooks, makeCaptureApi } from './tools/openclaw-shim.js';
export type { OpenClawToolDef, CapturedTool, CaptureApi, OpenClawPluginEntry, AdvisoryHook } from './tools/openclaw-shim.js';
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
// The env-AGNOSTIC run entry (D5): a plain resolved-config object (workflowSpec | buildWorkflowSpec +
// run opts) → compile → run. The bridge is consumer-injected; env resolution lives in `loadConfig`.
export { runFromConfig } from './runner/index.js';
export type { ResolvedRunConfig } from './runner/index.js';
// runFromTemplate (U8 / §10): the TEMPLATE-run join — loadTemplate → instantiateRun → compile → runWorkflow,
// the one entry that connects the spec-compile and run-folder-materialize halves into an end-to-end run.
export { runFromTemplate } from './runner/index.js';
export type { RunFromTemplateOpts } from './runner/index.js';
// G1 — per-node model/provider ROUTING: the single home of the override order (model > tier > run > default).
export {
  resolveNodeModel,
  ModelRoutingError,
  loadModelTiers,
  loadModelsIndex,
  defaultTiersPath,
  defaultModelsPath,
} from './runner/index.js';
export type { ModelTiers, NodeRouting, RunRouting, EffectiveModel } from './runner/index.js';
// loadConfig — the env layer (D5): PI_RUNNER_* env + parsed args → the run-opts object runFromConfig
// consumes (arg > env > default; timeouts seconds→ms). The ONLY place env is parsed; runFromConfig is pure.
export { loadConfig, parseArgFlags } from './runner/index.js';
export type { ConfigArgs, LoadConfigInput, ResolvedRunOpts } from './runner/index.js';
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
  // G5 — human-checkpoint marker/reply file paths (per-run data in the RUN dir).
  checkpointsDir,
  checkpointMarkerFile,
  checkpointReplyFile,
} from './runner/layout.js';

// Docker-style run-name generation (`<bake-adjective>-<pie>`, e.g. "flaky-pecan"): the CLI mints a
// memorable, collision-checked run name when `--run/--id` is omitted, decoupling a run's identity from
// any prompt id. `pieSlug`/`pieSlugList` back the regenerable `pies.json` (CSV → generate-pies.mjs).
export { generateRunName, ADJECTIVES, PIES, pieSlug, pieSlugList, type Rng } from './names/index.js';

// Observability source (the shared CONTRACT): ONE reader, ONE model, ONE live stream that the CLI, the
// TUI, and a future GUI all render. `readRunModel(runDir)` is the one-shot snapshot; `watchRun(runDir)`
// is the live stream of `RunUpdate`s. Built over the engine-owned `.pi/` layout — a superset of what
// packages/cli + tui derive today.
export { readRunModel, readRunJson, deriveStatus, watchRun } from './observe/index.js';
export type {
  RunModel,
  RunUpdate,
  NodeView,
  StageView,
  EdgeView,
  WatchOpts,
} from './observe/index.js';

// The ENRICHED run-view: `buildRunView(runDir)` replays each node's `events.jsonl` through the shared
// distiller for per-node `tokens` (input/output/cacheRead/cacheWrite/cost/contextPeak/billable) + tool
// breakdown + read/write/artifact ledgers — a superset of the lean `RunModel`. The CLI, the TUI, and a
// GUI build the SAME view from here (no view-local copy). Used by consumers that show cost/token panels.
export { buildRunView } from './observe/index.js';
export type { RunView, RunViewNode, RunViewStage, RunViewEdge, RunTokens } from './observe/index.js';
