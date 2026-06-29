// build-demo-data.mjs — capture the CURATED set of example runs into the static-demo bundle.
//
// The marketing site's `/gui-demo/` is a pure-frontend build (no server): `gui/demo/demoFetch.ts`
// answers the GUI's `/__piflow/*` calls from JSON bundled under `gui/demo/data/**`. This script
// (re)generates that bundle for a HAND-PICKED list of light, on-brand example runs, distilling each
// the EXACT way the live dev middleware does — `buildSnapshot` for the index rows + `buildRunView`
// for the per-run view + the same fs walk for the file tree — so the demo never drifts from the
// real product. It writes ONLY `index.json`, `run-view/<run>.json`, `tree/<run>.json`; `agents.json`
// (the preset-icon catalog) is managed separately and left untouched.
//
// Re-curate: edit FEATURED below, then `npm run data:demo` (from gui/), then `npm run build:demo`.
//
// Run: node gui/scripts/build-demo-data.mjs   (or: npm run data:demo, from gui/)

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSnapshot, REPO } from "./lib/index-snapshot.mjs";

// ── CURATION ────────────────────────────────────────────────────────────────────────────────────
// Which example runs the demo shows, IN ORDER. The LAST entry is the run the GUI opens on first load
// (`pickCurrentRun` → the last thread, since none are running and `updatedAt` is null). Each run must
// be a real, distillable run under `<REPO>/.piflow/<namespace>/runs/<run>` registered to this repo.
// As more example runs land in `.piflow/`, add/reorder them here — nothing else needs to change.
const FEATURED = [
  { namespace: "example-fusion", run: "demo-fusion" }, // richer 10-node fusion DAG (MoA + best-of-n) — alternate
  { namespace: "example-academy", run: "academy-e2b-final" }, // light 2-node research→build — DEFAULT (opens first)
];

const PRODUCT_ID = "piflow";
const OUT = path.resolve(REPO, "gui/demo/data");
const CORE = path.resolve(REPO, "packages/core/dist/observe/index.js");

// The live `/__piflow/tree/<run>` walk, replicated 1:1 (gui/vite.config.ts piflowTree) so a leaf's id
// (`f:<run-relative path>`) maps onto the run-view's displayPath → clicking a file opens its node.
const SKIP = new Set([".pi", "node_modules", ".git", ".DS_Store"]);
const MAX_ENTRIES = 5000;
const extOf = (name) => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1).toLowerCase() : undefined; };

async function walkTree(runDir) {
  let count = 0;
  const walk = async (absDir, rel, depth) => {
    if (depth > 12 || count >= MAX_ENTRIES) return [];
    let ents;
    try { ents = await fs.readdir(absDir, { withFileTypes: true }); } catch { return []; }
    const dirs = [], files = [];
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name) || count >= MAX_ENTRIES) continue;
      count += 1;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) dirs.push({ id: `d:${childRel}`, name: e.name, kind: "folder", children: await walk(path.join(absDir, e.name), childRel, depth + 1) });
      else if (e.isFile()) files.push({ id: `f:${childRel}`, name: e.name, kind: "file", typeLabel: extOf(e.name) });
    }
    return [...dirs, ...files]; // folders first, each already alpha-sorted
  };
  const tree = await walk(runDir, "", 0);
  return { tree, truncated: count >= MAX_ENTRIES };
}

async function main() {
  const { buildRunView } = await import(pathToFileURL(CORE).href);

  // Discover this repo's example workflows + runs the EXACT way the middleware does.
  const snap = await buildSnapshot({ products: [{ id: PRODUCT_ID, name: PRODUCT_ID, root: REPO }] });
  const product = (snap.products ?? []).find((p) => p.id === PRODUCT_ID);
  if (!product) throw new Error(`product "${PRODUCT_ID}" not found in snapshot (is the repo registered?)`);

  const findNs = (id) => (product.namespaces ?? []).find((n) => n.id === id);
  const findThread = (ns, run) => (ns?.threads ?? []).find((t) => t.run === run);

  // ── per-run: distill view + tree with the same opts the run-view middleware passes ──
  await fs.rm(path.join(OUT, "run-view"), { recursive: true, force: true });
  await fs.rm(path.join(OUT, "tree"), { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, "run-view"), { recursive: true });
  await fs.mkdir(path.join(OUT, "tree"), { recursive: true });

  for (const { namespace, run } of FEATURED) {
    const ns = findNs(namespace);
    const thread = findThread(ns, run);
    if (!thread?.runDir) throw new Error(`run "${run}" not found under namespace "${namespace}" — check FEATURED`);
    // sibling runs of the SAME workflow are the prior-run baseline (expectedMs) — mirrors the middleware.
    const historyDirs = (ns.threads ?? []).map((t) => t.runDir).filter(Boolean);
    const { view } = buildRunView(thread.runDir, { historyDirs, workspaceRoot: product.root });
    await fs.writeFile(path.join(OUT, "run-view", `${run}.json`), JSON.stringify(view) + "\n");
    await fs.writeFile(path.join(OUT, "tree", `${run}.json`), JSON.stringify(await walkTree(thread.runDir)) + "\n");
    console.log(`  ✓ ${namespace}/${run} → run-view + tree (${view.nodes.length} nodes)`);
  }

  // ── trimmed index.json: only the featured namespaces/threads, in curation order, viewable:true ──
  const nsOrder = [...new Set(FEATURED.map((f) => f.namespace))];
  const namespaces = nsOrder.map((nsId) => {
    const ns = findNs(nsId);
    const runs = FEATURED.filter((f) => f.namespace === nsId).map((f) => f.run);
    const threads = runs.map((run) => ({ ...findThread(ns, run), viewable: true }));
    return { ...ns, threads };
  });
  const index = { generatedAt: snap.generatedAt, products: [{ ...product, namespaces }] };
  await fs.writeFile(path.join(OUT, "index.json"), JSON.stringify(index, null, 2) + "\n");

  const last = FEATURED[FEATURED.length - 1];
  console.log(`  ✓ index.json → ${FEATURED.length} run(s); default opens "${last.run}"`);
  console.log(`\nNext: npm run build:demo  (writes site-piflow/public/gui-demo/)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
