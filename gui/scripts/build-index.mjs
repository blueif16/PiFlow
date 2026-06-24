// build-index.mjs — the GLOBAL INDEX SNAPSHOT generator. Periodic, not live. It registers THIS repo as
// a product, then for each product discovers its namespaces (workspaces) and runs, summarizes each run
// into the canonical "thread row", associates each run to a namespace, and writes ONE unified snapshot
// the (future) GUI workspace/run switcher reads.
//
// ARCHITECTURAL LAW: collected/global data lives ONLY in the user's home global dir (~/.piflow/), NEVER
// inside the SDK (packages/*), the repo's template .piflow/, or gui/public. Per-repo run data stays in
// the product — we only READ it and aggregate SUMMARIES + POINTERS up into the global index.
//
// Outputs (both under ~/.piflow/):
//   products.json — idempotent product registry  { products: [{ id, name, root, registeredAt }] }
//   index.json    — the snapshot { generatedAt, products: [{ id, name, root, namespaces: [...] }] }
//
// Thread-row source: PREFERS summarizeRun(runDir) from packages/tui/model.mjs (the shared row shape the
// TUI uses). If that import is not resolvable (e.g. @piflow/core not built / not a gui dep), FALLS BACK
// to deriving the SAME fields from the run's run-view.json (preferred) or .pi/run.json — matching
// summarizeRun's field names exactly. The path actually taken is reported per-run and in the summary.
//
// Run: node gui/scripts/build-index.mjs   (or: npm run data:index, from gui/)

import { promises as fs } from 'node:fs';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUI = path.resolve(HERE, '..');
const REPO = path.resolve(GUI, '..'); // this repo's absolute root

// COLLECTED GLOBAL DATA — the ONLY place this script writes. Parallels the existing ~/.pi runtime dir.
const GLOBAL_DIR = path.join(os.homedir(), '.piflow');
const PRODUCTS_FILE = path.join(GLOBAL_DIR, 'products.json');
const INDEX_FILE = path.join(GLOBAL_DIR, 'index.json');

// The terminal-OK statuses summarizeRun counts as "done" (mirrors packages/tui/model.mjs:204).
const TERMINAL_OK = new Set(['ok', 'reused', 'gap', 'dry']);

// ── product registry: idempotent upsert of one or more repo roots ─────────────────────────────────────
// THIS repo (where the GUI lives) is always registered; `piflow gui` (and a bare `--root <path>` arg)
// adds the repo it was launched from, so a run in ANOTHER repo (e.g. game-omni's out/<id>) becomes
// discoverable without hand-editing the registry. Upsert is by abs root OR id (refreshes a moved dir).
function upsertRoot(registry, root) {
  const abs = path.resolve(root);
  const id = path.basename(abs);
  if (!Array.isArray(registry.products)) registry.products = [];
  const existing = registry.products.find((p) => p.root === abs || p.id === id);
  if (existing) { existing.id = id; existing.name = id; existing.root = abs; }
  else registry.products.push({ id, name: id, root: abs, registeredAt: new Date().toISOString() });
}

async function upsertProducts(extraRoots = []) {
  let registry = { products: [] };
  if (fssync.existsSync(PRODUCTS_FILE)) {
    try { registry = JSON.parse(await fs.readFile(PRODUCTS_FILE, 'utf8')); }
    catch { registry = { products: [] }; }
  }
  upsertRoot(registry, REPO);
  for (const r of extraRoots) upsertRoot(registry, r);
  await fs.writeFile(PRODUCTS_FILE, JSON.stringify(registry, null, 2) + '\n');
  return registry;
}

// ── namespace discovery: workspaces from <root>/.piflow/*/template/meta.json ───────────────────────────
function discoverNamespaces(root) {
  const wfRoot = path.join(root, '.piflow');
  const out = [];
  if (!fssync.existsSync(wfRoot)) return out;
  for (const entry of fssync.readdirSync(wfRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const templatePath = path.join(wfRoot, entry.name, 'template', 'meta.json');
    if (!fssync.existsSync(templatePath)) continue;
    let meta;
    try { meta = JSON.parse(fssync.readFileSync(templatePath, 'utf8')); }
    catch { continue; }
    out.push({ id: meta.id || entry.name, name: meta.name || meta.id || entry.name, templatePath, meta });
  }
  return out;
}

// ── run discovery: any dir with .pi/run.json under the documented search roots ────────────────────────
// A run dir is ANY dir holding `.pi/run.json`. We scan THREE conventions: the documented
// `.piflow/<wf>/runs/<id>/`, the GUI's served `gui/public/runs/<id>/`, and the live-run `out/<id>/`
// convention (game-omni and the legacy run.mjs write there). The `.pi/run.json` existence check is the
// filter, so scanning `out/*` never picks up bare node-output dirs (e.g. out/w0-classify with no .pi).
function discoverRunDirs(root) {
  const wfRoot = path.join(root, '.piflow');
  const guiRuns = path.join(root, 'gui', 'public', 'runs');
  const outRoot = path.join(root, 'out');
  const searchRoots = [wfRoot, guiRuns, outRoot];
  const runDirs = [];
  const pushIfRun = (dir) => {
    if (fssync.existsSync(path.join(dir, '.pi', 'run.json'))) runDirs.push(dir);
  };
  const eachChildDir = (parent, fn) => {
    if (!fssync.existsSync(parent)) return;
    for (const e of fssync.readdirSync(parent, { withFileTypes: true })) if (e.isDirectory()) fn(path.join(parent, e.name));
  };
  // .piflow/<wf>/runs/<id>
  eachChildDir(wfRoot, (wfDir) => eachChildDir(path.join(wfDir, 'runs'), pushIfRun));
  // gui/public/runs/<id>  and  out/<id>
  eachChildDir(guiRuns, pushIfRun);
  eachChildDir(outRoot, pushIfRun);
  return { runDirs, searchRoots };
}

// ── run→namespace association via run.json.source ─────────────────────────────────────────────────────
// basename → strip trailing -vX.Y and .js → workspace id; match a known namespace, else "unfiled".
function namespaceIdForSource(source, namespaceIds) {
  if (typeof source !== 'string' || !source) return 'unfiled';
  let base = path.basename(source).replace(/\.js$/i, '').replace(/-v\d+(\.\d+)*$/i, '');
  return namespaceIds.has(base) ? base : 'unfiled';
}

// ── thread row: prefer summarizeRun import; fall back to run-view.json / run.json ─────────────────────
// Resolved once and cached: { fn } if the import worked, else { fn: null }.
let _summarize = undefined;
async function getSummarizeRun() {
  if (_summarize !== undefined) return _summarize;
  try {
    const mod = await import('../../packages/tui/model.mjs');
    _summarize = { fn: mod.summarizeRun, source: 'summarizeRun-import' };
  } catch (e) {
    _summarize = { fn: null, source: 'run-view-fallback', err: e?.message?.split('\n')[0] || String(e) };
  }
  return _summarize;
}

// Derive the SAME row shape summarizeRun returns, from run-view.json (preferred) or .pi/run.json.
function deriveRowFallback(runDir) {
  const viewFile = path.join(runDir, 'run-view.json');
  const runFile = path.join(runDir, '.pi', 'run.json');
  let v = null, from = null;
  if (fssync.existsSync(viewFile)) { v = JSON.parse(fssync.readFileSync(viewFile, 'utf8')); from = 'run-view.json'; }
  else if (fssync.existsSync(runFile)) {
    const rj = JSON.parse(fssync.readFileSync(runFile, 'utf8'));
    // normalize run.json (nodes is a map) into the same node-array shape run-view uses
    v = { ...rj, nodes: Object.values(rj.nodes || {}) }; from = '.pi/run.json';
  } else return null;

  const nodes = Array.isArray(v.nodes) ? v.nodes : [];
  const nodesDone = nodes.filter((n) => TERMINAL_OK.has(n.status)).length;
  const running = nodes.find((n) => n.status === 'running');
  const errored = nodes.find((n) => n.status === 'error' || n.status === 'blocked');
  return {
    _from: from,
    row: {
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
    },
  };
}

// Build the thread row for one run dir + the GUI pointer fields (runViewPath, viewable) + which source.
async function buildThread(runDir) {
  const { fn, source: rowSource } = await getSummarizeRun();
  let row = null, usedSource = rowSource;
  if (fn) {
    try { row = await fn(runDir); } catch { row = null; }
  }
  if (!row) {
    const fb = deriveRowFallback(runDir);
    if (!fb) return null;
    row = fb.row; usedSource = `run-view-fallback(${fb._from})`;
  } else {
    usedSource = 'summarizeRun-import';
  }
  // make runDir absolute (summarizeRun echoes back whatever it was passed)
  row.runDir = path.resolve(runDir);

  // GUI pointer: a static GUI can only fetch run-views that live under gui/public.
  const guiRunsRoot = path.join(GUI, 'public', 'runs');
  const hasView = fssync.existsSync(path.join(runDir, 'run-view.json'));
  let runViewPath, viewable;
  if (path.resolve(runDir).startsWith(path.resolve(guiRunsRoot) + path.sep) && hasView) {
    runViewPath = `runs/${path.basename(runDir)}/run-view.json`; // GUI-fetchable relative path
    viewable = true;
  } else {
    runViewPath = hasView ? path.join(path.resolve(runDir), 'run-view.json') : null; // absolute or none
    viewable = false; // static GUI can't fetch outside its public dir yet
  }
  return { thread: { ...row, runViewPath, viewable }, source: row.source ?? undefined, usedSource };
}

// ── source-of-association read: run.json.source for a run dir ─────────────────────────────────────────
function readRunSource(runDir) {
  const runFile = path.join(runDir, '.pi', 'run.json');
  try { return JSON.parse(fssync.readFileSync(runFile, 'utf8')).source ?? null; }
  catch { return null; }
}

async function main() {
  await fs.mkdir(GLOBAL_DIR, { recursive: true });
  // `--root <path>` (repeatable) registers extra repos before indexing — how `piflow gui` registers
  // the repo it was launched from. THIS repo is always registered too (see upsertProducts).
  const extraRoots = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--root' && process.argv[i + 1]) extraRoots.push(process.argv[++i]);
  }
  const registry = await upsertProducts(extraRoots);

  const products = [];
  let totalNamespaces = 0, totalThreads = 0;
  const rowSources = new Set();

  for (const product of registry.products) {
    const root = product.root;
    const namespaces = discoverNamespaces(root);
    const { runDirs, searchRoots } = discoverRunDirs(root);

    // HALT only for THIS repo if the documented roots yield nothing — never invent data.
    if (root === REPO && (namespaces.length === 0 || runDirs.length === 0)) {
      console.error('HALT: no real data found at the documented roots.');
      console.error(`  workspaces searched: ${path.join(root, '.piflow')}/*/template/meta.json  → ${namespaces.length} found`);
      console.error(`  runs searched:       ${searchRoots.map((s) => s + '/*/.pi/run.json').join('  AND  ')}  → ${runDirs.length} found`);
      process.exit(1);
    }

    // bucket: namespace id → threads[]
    const nsById = new Map(namespaces.map((ns) => [ns.id, { ...ns, threads: [] }]));
    const namespaceIds = new Set(namespaces.map((ns) => ns.id));

    for (const runDir of runDirs) {
      const built = await buildThread(runDir);
      if (!built) continue;
      rowSources.add(built.usedSource);
      const source = readRunSource(runDir);
      const nsId = namespaceIdForSource(source, namespaceIds);
      if (!nsById.has(nsId)) {
        // an "unfiled" bucket (no matching workspace meta) — a synthetic namespace, no template
        nsById.set(nsId, { id: nsId, name: nsId, templatePath: null, meta: null, threads: [] });
      }
      nsById.get(nsId).threads.push(built.thread);
    }

    // keep deterministic order: discovered namespaces first, then any synthetic buckets (e.g. unfiled)
    const orderedNs = [...namespaces.map((ns) => ns.id)];
    for (const id of nsById.keys()) if (!orderedNs.includes(id)) orderedNs.push(id);
    const productNamespaces = orderedNs.map((id) => {
      const ns = nsById.get(id);
      return { id: ns.id, name: ns.name, templatePath: ns.templatePath, meta: ns.meta, threads: ns.threads };
    });

    totalNamespaces += productNamespaces.length;
    totalThreads += productNamespaces.reduce((a, ns) => a + ns.threads.length, 0);
    products.push({ id: product.id, name: product.name, root, namespaces: productNamespaces });
  }

  const snapshot = { generatedAt: new Date().toISOString(), products };
  await fs.writeFile(INDEX_FILE, JSON.stringify(snapshot, null, 2) + '\n');

  // ── human summary ──
  console.log(`index → ${INDEX_FILE}`);
  console.log(`registry → ${PRODUCTS_FILE}`);
  console.log(`  ${products.length} product(s) · ${totalNamespaces} namespace(s) · ${totalThreads} thread(s)`);
  console.log(`  thread-row source: ${[...rowSources].join(', ') || '(no threads)'}`);
  for (const p of products) {
    console.log(`  product ${p.id} (${p.root})`);
    for (const ns of p.namespaces) {
      console.log(`    namespace ${ns.id.padEnd(12)} ${ns.threads.length} thread(s)`);
      for (const t of ns.threads) {
        console.log(`      ${String(t.run).padEnd(12)} ${String(t.state).padEnd(7)} ${t.nodesDone}/${t.nodesTotal} nodes · viewable=${t.viewable} · ${t.runViewPath || '(no view)'}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
