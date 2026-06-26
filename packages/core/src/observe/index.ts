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
export { buildRunView } from './runView.js';
export type { RunView, RunViewNode, RunViewStage, RunViewEdge, RunTokens, ScopeBucket, ReadRef, WriteRef, ArtifactRef, NodeAudit } from './runView.js';
export { loadModelCatalog, contextWindowFor, DEFAULT_CONTEXT_WINDOW } from './models.js';
export type { ModelCaps, ModelCatalog } from './models.js';

// FLEET tier — the per-fleet counterpart to the per-run readers above: the global product REGISTRY
// (`~/.piflow/products.json`) + the §D9 run-home DISCOVERY + the unified SNAPSHOT builder + the shared
// thread-row `summarizeRun`. The CLI, the TUI's fleet picker, and the GUI middleware all build the SAME
// snapshot from these (no view-local copy) and are exposed to the SAME registered repos. `registerProductRoot`
// is the write side: a run self-registers its repo at start (entry.ts), so discovery needs no manual `--root`.
export { globalDir, productsFile, indexFile, loadRegistry, upsertRoot, saveRegistry, registerProductRoot } from './registry.js';
export type { ProductEntry, Registry } from './registry.js';
export { discoverNamespaces, discoverRunDirs, summarizeRun, buildSnapshot } from './discover.js';
export type { NamespaceDesc, NamespaceMeta, ThreadRow, SnapshotNamespace, SnapshotProduct, Snapshot } from './discover.js';
