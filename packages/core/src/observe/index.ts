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
export { buildRunView, previewView } from './runView.js';
export type { RunView, RunViewNode, RunViewStage, RunViewEdge, RunTokens, ScopeBucket, ReadRef, WriteRef, ArtifactRef, NodeAudit, PreviewViewOpts } from './runView.js';
// The pure per-node DISPLAY derivation (zones/rankings/unified outputs) `buildRunView` stamps on each node
// as `derived` — the ONE compute site so the GUI + TUI render identical numbers and re-derive nothing.
export { deriveNode, cacheTone, toolErrorTone, contextTone, timeTone, retriesTone } from './derive.js';
export type { NodeDerived, DeriveInput, Tone, RankedTool, DerivedOutput } from './derive.js';
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
export { discoverNamespaces, discoverRunDirs, summarizeRun, buildSnapshot } from './discover.js';
export type { NamespaceDesc, NamespaceMeta, ThreadRow, SnapshotNamespace, SnapshotProduct, Snapshot } from './discover.js';

// SCOPE — resolve the launched project's product roots from a cwd + build a registry scoped to them. The shared
// spine behind "a view shows the project you launched it in, not the whole global registry" (piflowctl gui/tui).
export { isProductRoot, findProductRoot, findProductRootsUnder, resolveScope, registryFromRoots, loadScopedRegistry } from './scope.js';
