// @piflow/core/observe — THE shared observability source: one reader, one model, one live stream.
// `readRunModel` is the one-shot snapshot; `watchRun` is the live stream. The CLI, the TUI, and a
// future GUI all render the SAME `RunModel`/`RunUpdate` contract (src/observe/types.ts) over the
// engine-owned `.pi/` run layout — no view re-derives status, stages, or edges on its own.

export { readRunModel, readRunJson, deriveStatus } from './read.js';
export { watchRun } from './watch.js';
export type { WatchOpts } from './watch.js';
export type { RunModel, RunUpdate, NodeView, StageView, EdgeView } from './types.js';

// Rich per-node aggregation — the shared distiller + run-view builder + pi-native model registry. The
// GUI middleware, the TUI, and the CLI all build the SAME enriched view from these (no view-local copy).
export { createNodeAccumulator } from './distill.js';
export type { RichNode, RichTokens, NodeAccumulator } from './distill.js';
export { buildRunView, previewView, makeDisplayPath, scopeKind } from './runView.js';
export type { RunView, RunViewNode, RunViewStage, RunViewEdge, RunTokens, ScopeBucket, ReadRef, WriteRef, ArtifactRef, NodeAudit, PreviewViewOpts, ScopeKind } from './runView.js';
// Context-composition — the ordered "element tree" (force-injected prompt + every agent read, each with
// range/coverage/sha/order) + the advertised-vs-read blind-spot. A PROJECTION over events.jsonl + prompt.md
// + the run-time reads-manifest, computed once here (never in a view). See observe/contextComposition.ts.
export { buildNodeContext } from './contextComposition.js';
export type { ContextOp, NodeComposition, NodeContext, ContextBuildCtx, ReadsManifest, ReadsManifestEntry } from './contextComposition.js';
// Turn-dissection — per-MODEL-TURN "reasoning-effort" timeline (thinking/text volume + the tool calls each
// turn made) + the derived node-level rollup (totalThinkChars, largestTurn, megaThinkTurns, derivation-
// marker count). A PROJECTION over events.jsonl, computed once here (never in a view). See turnDissection.ts.
export { buildNodeTurns, MEGA_THINK_CHARS, DERIVATION_MARKERS } from './turnDissection.js';
export type { TurnRecord, TurnToolCall, TurnSummary, MegaThinkTurn, TurnDissection } from './turnDissection.js';
// The pure per-node DISPLAY derivation (zones/rankings/unified outputs) `buildRunView` stamps on each node
// as `derived` — the ONE compute site so the GUI + TUI render identical numbers and re-derive nothing.
export { deriveNode, cacheTone, toolErrorTone, contextTone, timeTone, retriesTone } from './derive.js';
export type { NodeDerived, DeriveInput, Tone, RankedTool, DerivedOutput } from './derive.js';
// The falsifiable full-run rubric (docs/design/full-run-simulation.md §5) — the reusable "did this run
// actually succeed?" assessor the smoke drivers + L1–L3 E2E tiers call instead of reward-hackable substrings.
export { assessRunView } from './assess.js';
export type { AssessOpts, RunAssessment } from './assess.js';
export { loadModelCatalog, contextWindowFor, DEFAULT_CONTEXT_WINDOW } from './models.js';
export type { ModelCaps, ModelCatalog } from './models.js';

// TELEMETRY tier — the agent-facing PROJECTION over the run-view (a lens, not a second collector). RECORD
// (`projectRunDigest`) is the one-shot RunDigest; STREAM (`telemetryStream`) folds a `watchRun` stream into
// edge-triggered TelemetryEvent deltas. Field names track OTel gen_ai.* (`toGenAiAttributes` exports them).
export { projectRunDigest, telemetryStream, toGenAiAttributes, DEFAULT_THRESHOLDS } from './telemetry.js';
export type { RunDigest, NodeDigest, Anomaly, AnomalyKind, RootCause, TelemetryEvent, Verbosity, StreamOpts, TelemetryThresholds } from './telemetry.js';

// FLEET tier — the per-fleet counterpart to the per-run readers above: the global product REGISTRY
// (`~/.piflow/products.json`) + the §D9 run-home DISCOVERY + the unified SNAPSHOT builder + the shared
// thread-row `summarizeRun`. The CLI, the TUI's fleet picker, and the GUI middleware all build the SAME
// snapshot from these (no view-local copy) and are exposed to the SAME registered repos. `registerProductRoot`
// is the write side: a run self-registers its repo at start (entry.ts), so discovery needs no manual `--root`.
export { globalDir, productsFile, indexFile, homeTiersFile, ensurePiflowHome, loadRegistry, upsertRoot, saveRegistry, registerProductRoot } from './registry.js';
export type { ProductEntry, Registry } from './registry.js';
export { discoverNamespaces, discoverRunDirs, summarizeRun, buildSnapshot, groupByParent } from './discover.js';
export type { NamespaceDesc, NamespaceMeta, ThreadRow, ThreadNode, SnapshotNamespace, SnapshotProduct, Snapshot } from './discover.js';

// M8 — the issues ENDPOINT projection: a thin observe wrapper over the optimize-substrate ledger
// (`listIssues`, optimize/substrate/issues.ts) so the server/GUI never re-implement the ledger read.
export { nodeIssuesProjection } from './issues.js';

// SCOPE — resolve the launched project's product roots from a cwd + build a registry scoped to them. The shared
// spine behind "a view shows the project you launched it in, not the whole global registry" (piflowctl gui/tui).
export { isProductRoot, findProductRoot, findProductRootsUnder, templateLayout, resolveScope, registryFromRoots, loadScopedRegistry } from './scope.js';
