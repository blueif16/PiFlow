// index-snapshot.mjs — the SHARED global-index builder (registry + discover + summarize → snapshot).
//
// ONE implementation, two callers (no duplication):
//   • gui/scripts/build-index.mjs — the CLI: registers roots, writes products.json + index.json.
//   • gui/vite.config.ts middleware — serves /__piflow/index.json LIVE (recomputes per request) so a run
//     that starts or progresses after the server launched shows up WITHOUT a manual re-index.
//
// ARCHITECTURAL LAW (unchanged): collected/global data lives ONLY in ~/.piflow. Per-repo run data stays in
// the product; we only READ it and aggregate SUMMARIES + POINTERS into the snapshot.

import { promises as fs } from 'node:fs';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // gui/scripts/lib
export const GUI = path.resolve(HERE, '..', '..');          // gui/
export const REPO = path.resolve(GUI, '..');                // repo root (where the GUI lives)

export const GLOBAL_DIR = path.join(os.homedir(), '.piflow');
export const PRODUCTS_FILE = path.join(GLOBAL_DIR, 'products.json');
export const INDEX_FILE = path.join(GLOBAL_DIR, 'index.json');

// The terminal-OK statuses summarizeRun counts as "done" (mirrors tui/model.mjs).
const TERMINAL_OK = new Set(['ok', 'reused', 'gap', 'dry']);

// ── registry (products.json) ──────────────────────────────────────────────────────────────────────────
export function loadRegistry() {
  let registry = { products: [] };
  if (fssync.existsSync(PRODUCTS_FILE)) {
    try { registry = JSON.parse(fssync.readFileSync(PRODUCTS_FILE, 'utf8')); } catch { registry = { products: [] }; }
  }
  if (!Array.isArray(registry.products)) registry.products = [];
  return registry;
}

/** Idempotent upsert of a repo root (by abs root OR basename id; refreshes a moved/renamed dir). */
export function upsertRoot(registry, root) {
  const abs = path.resolve(root);
  const id = path.basename(abs);
  if (!Array.isArray(registry.products)) registry.products = [];
  const existing = registry.products.find((p) => p.root === abs || p.id === id);
  if (existing) { existing.id = id; existing.name = id; existing.root = abs; }
  else registry.products.push({ id, name: id, root: abs, registeredAt: new Date().toISOString() });
}

export async function saveRegistry(registry) {
  await fs.mkdir(GLOBAL_DIR, { recursive: true });
  await fs.writeFile(PRODUCTS_FILE, JSON.stringify(registry, null, 2) + '\n');
}

// ── discovery ───────────────────────────────────────────────────────────────────────────────────────
// namespaces (workspaces) from <root>/.piflow/*/template/meta.json
export function discoverNamespaces(root) {
  const wfRoot = path.join(root, '.piflow');
  const out = [];
  if (!fssync.existsSync(wfRoot)) return out;
  for (const entry of fssync.readdirSync(wfRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const templatePath = path.join(wfRoot, entry.name, 'template', 'meta.json');
    if (!fssync.existsSync(templatePath)) continue;
    let meta;
    try { meta = JSON.parse(fssync.readFileSync(templatePath, 'utf8')); } catch { continue; }
    out.push({ id: meta.id || entry.name, name: meta.name || meta.id || entry.name, templatePath, meta });
  }
  return out;
}

// run dirs = ONLY the canonical run home `.piflow/<wf>/runs/<id>` (sdk-canonical-build-plan §D9: "a run's
// canonical home is ALWAYS .piflow/<wf>/runs/<id> … no more shared out/game"). We deliberately do NOT scan
// `out/<id>` (a product's BUILD-OUTPUT dir that merely happened to colocate a `.pi/` — scanning it
// scavenges stray/legacy build dirs as if they were runs) nor `gui/public/runs` (committed run data must
// never live in the GUI — the data-boundary rule). Real runs are distilled live by the run-view middleware.
export function discoverRunDirs(root) {
  const wfRoot = path.join(root, '.piflow');
  const searchRoots = [wfRoot];
  const runDirs = [];
  const pushIfRun = (dir) => { if (fssync.existsSync(path.join(dir, '.pi', 'run.json'))) runDirs.push(dir); };
  const eachChildDir = (parent, fn) => {
    if (!fssync.existsSync(parent)) return;
    for (const e of fssync.readdirSync(parent, { withFileTypes: true })) if (e.isDirectory()) fn(path.join(parent, e.name));
  };
  eachChildDir(wfRoot, (wfDir) => eachChildDir(path.join(wfDir, 'runs'), pushIfRun));
  return { runDirs, searchRoots };
}

// run → namespace association via run.json.source (basename, strip -vX.Y + .js)
function namespaceIdForSource(source, namespaceIds) {
  if (typeof source !== 'string' || !source) return 'unfiled';
  const base = path.basename(source).replace(/\.js$/i, '').replace(/-v\d+(\.\d+)*$/i, '');
  return namespaceIds.has(base) ? base : 'unfiled';
}

function readRunSource(runDir) {
  try { return JSON.parse(fssync.readFileSync(path.join(runDir, '.pi', 'run.json'), 'utf8')).source ?? null; }
  catch { return null; }
}

// ── thread row: prefer summarizeRun import (the TUI's shared shape); fall back to run-view/run.json ────
let _summarize;
async function getSummarizeRun() {
  if (_summarize !== undefined) return _summarize;
  try {
    const mod = await import(pathToFileURL(path.join(REPO, 'packages', 'tui', 'model.mjs')).href);
    _summarize = { fn: mod.summarizeRun };
  } catch { _summarize = { fn: null }; }
  return _summarize;
}

function deriveRowFallback(runDir) {
  const viewFile = path.join(runDir, 'run-view.json');
  const runFile = path.join(runDir, '.pi', 'run.json');
  let v = null;
  if (fssync.existsSync(viewFile)) v = JSON.parse(fssync.readFileSync(viewFile, 'utf8'));
  else if (fssync.existsSync(runFile)) {
    const rj = JSON.parse(fssync.readFileSync(runFile, 'utf8'));
    v = { ...rj, nodes: Object.values(rj.nodes || {}) };
  } else return null;
  const nodes = Array.isArray(v.nodes) ? v.nodes : [];
  const nodesDone = nodes.filter((n) => TERMINAL_OK.has(n.status)).length;
  const running = nodes.find((n) => n.status === 'running');
  const errored = nodes.find((n) => n.status === 'error' || n.status === 'blocked');
  return {
    run: v.run, runDir, statusPath: runDir,
    state: v.done ? (v.ok === false ? 'failed' : 'done') : 'running',
    done: !!v.done, ok: v.ok ?? null,
    stageIndex: null, stageTotal: null, phase: null,
    runningNode: running?.id || null, runningTool: null, runningStalled: false,
    nodesDone, nodesTotal: nodes.length,
    frac: v.done ? 1 : (nodes.length ? nodesDone / nodes.length : 0),
    elapsedMs: v.durationMs ?? null,
    tokensBillable: 0, cost: 0,
    provider: v.provider || null, model: v.model || null,
    updatedAt: v.updatedAt ?? null, staleMs: null,
    errorNode: errored?.id || null,
  };
}

async function buildThread(runDir) {
  const { fn } = await getSummarizeRun();
  let row = null;
  if (fn) { try { row = await fn(runDir); } catch { row = null; } }
  if (!row) { row = deriveRowFallback(runDir); if (!row) return null; }
  row.runDir = path.resolve(runDir);

  // GUI pointer: a static GUI can only FETCH a run-view that lives under gui/public (canvas render). A
  // non-viewable run is still streamable live (companion + live canvas) — viewable only gates run-view.json.
  const guiRunsRoot = path.join(GUI, 'public', 'runs');
  const hasView = fssync.existsSync(path.join(runDir, 'run-view.json'));
  let runViewPath, viewable;
  if (path.resolve(runDir).startsWith(path.resolve(guiRunsRoot) + path.sep) && hasView) {
    runViewPath = `runs/${path.basename(runDir)}/run-view.json`;
    viewable = true;
  } else {
    runViewPath = hasView ? path.join(path.resolve(runDir), 'run-view.json') : null;
    viewable = false;
  }
  return { ...row, runViewPath, viewable };
}

/**
 * Build the unified snapshot from a registry — `{ generatedAt, products:[{ id,name,root,namespaces }] }`.
 * PURE (no writes, no process.exit). Both the CLI and the live middleware call this. Per-run reads are a
 * few file stats, so recomputing it per request (live mode) is cheap for a normal fleet.
 */
export async function buildSnapshot(registry) {
  // GLOBAL namespace registry: a run associates to its workflow by run.json.source, and that workflow's
  // template can live in a DIFFERENT registered product than the run — e.g. game-omni runs sit under
  // /…/game-omni/out while the game-omni template lives in the piflow repo's .piflow/. Resolve source
  // against ALL products' templates (not just the run's own product), so such runs file under their REAL
  // namespace WITH its templatePath/meta instead of falling to 'unfiled'.
  const globalNs = new Map(); // namespace id → { id, name, templatePath, meta }
  for (const p of registry.products) for (const ns of discoverNamespaces(p.root)) if (!globalNs.has(ns.id)) globalNs.set(ns.id, ns);
  const globalNsIds = new Set(globalNs.keys());

  const products = [];
  for (const product of registry.products) {
    const root = product.root;
    const namespaces = discoverNamespaces(root);
    const { runDirs } = discoverRunDirs(root);
    const nsById = new Map(namespaces.map((ns) => [ns.id, { ...ns, threads: [] }]));

    for (const runDir of runDirs) {
      const thread = await buildThread(runDir);
      if (!thread) continue;
      const nsId = namespaceIdForSource(readRunSource(runDir), globalNsIds);
      if (!nsById.has(nsId)) {
        const g = globalNs.get(nsId);
        nsById.set(nsId, g ? { ...g, threads: [] } : { id: nsId, name: nsId, templatePath: null, meta: null, threads: [] });
      }
      nsById.get(nsId).threads.push(thread);
    }

    const orderedNs = [...namespaces.map((ns) => ns.id)];
    for (const id of nsById.keys()) if (!orderedNs.includes(id)) orderedNs.push(id);
    const productNamespaces = orderedNs.map((id) => {
      const ns = nsById.get(id);
      return { id: ns.id, name: ns.name, templatePath: ns.templatePath, meta: ns.meta, threads: ns.threads };
    });
    products.push({ id: product.id, name: product.name, root, namespaces: productNamespaces });
  }
  return { generatedAt: new Date().toISOString(), products };
}
