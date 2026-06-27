// index-snapshot.mjs — THIN ADAPTER over @piflow/core's fleet-discovery (registry + discover + snapshot).
//
// The registry + run-discovery + snapshot + shared thread-row now live in ONE place — `@piflow/core/observe`
// — so the CLI, TUI, and GUI share a single source. This file re-exports that core surface and adds back the
// two GUI-ONLY pointer fields (`runViewPath`, `viewable`) core deliberately omits, so every existing consumer
// (build-index.mjs, vite.config.ts middleware, src/data/runIndex.ts) keeps working unchanged.
//
// ONE implementation, two callers (no duplication):
//   • gui/scripts/build-index.mjs — the CLI: registers roots, writes products.json + index.json.
//   • gui/vite.config.ts middleware — serves /__piflow/index.json LIVE (recomputes per request) so a run
//     that starts or progresses after the server launched shows up WITHOUT a manual re-index.
//
// ARCHITECTURAL LAW (unchanged): collected/global data lives ONLY in ~/.piflow. Per-repo run data stays in
// the product; we only READ it and aggregate SUMMARIES + POINTERS into the snapshot.

import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // gui/scripts/lib
export const GUI = path.resolve(HERE, '..', '..');          // gui/
export const REPO = path.resolve(GUI, '..');                // repo root (where the GUI lives)

// Resolve @piflow/core's built observe dist by an UP-WALK (it's OUTSIDE the gui's package graph) — the same
// `findUp` pattern vite.config.ts uses, so esbuild never bundles core's heavy barrel. Top-level await is OK
// in an .mjs: both callers `await import()` this module, so the dynamic import settles before any export use.
function findUpFromHere(rel) {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const p = path.join(dir, rel);
    if (fssync.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const corePath = findUpFromHere('packages/core/dist/observe/index.js');
if (!corePath) {
  throw new Error('@piflow/core observe dist not found — run `npm run build` at the repo root');
}
const core = await import(pathToFileURL(corePath).href);

// ── ~/.piflow paths: ONE source (core's globalDir/productsFile/indexFile, honoring PIFLOW_HOME) ──────────
export const GLOBAL_DIR = core.globalDir();
export const PRODUCTS_FILE = core.productsFile();
export const INDEX_FILE = core.indexFile();

// ── registry + discovery: re-export core verbatim (no GUI-local copy) ───────────────────────────────────
export const loadRegistry = core.loadRegistry;
export const upsertRoot = core.upsertRoot;
export const saveRegistry = core.saveRegistry;
export const discoverNamespaces = core.discoverNamespaces;
export const discoverRunDirs = core.discoverRunDirs;

/**
 * Build the unified snapshot from a registry, then post-map EVERY thread to add the two GUI-ONLY pointer
 * fields core omits — keeping the `IndexThread` shape src/data/runIndex.ts consumes unchanged:
 *   • viewable: always false — committed `gui/public/runs` is deprecated by the live `/__piflow/run-view`
 *     middleware (a run is streamed/distilled on demand, never served as a static file from the repo).
 *   • runViewPath: the ABSOLUTE `<runDir>/run-view.json` when that file exists on disk, else null.
 * PURE delegate (no writes, no process.exit) — both the CLI and the live middleware call this.
 */
export async function buildSnapshot(registry) {
  const snapshot = await core.buildSnapshot(registry);
  for (const product of snapshot.products ?? []) {
    for (const ns of product.namespaces ?? []) {
      ns.threads = (ns.threads ?? []).map((row) => {
        const viewFile = path.join(row.runDir, 'run-view.json');
        const runViewPath = fssync.existsSync(viewFile) ? viewFile : null;
        return { ...row, runViewPath, viewable: false };
      });
    }
  }
  return snapshot;
}
