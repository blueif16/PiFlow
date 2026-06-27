// build-index.mjs — the GLOBAL INDEX SNAPSHOT generator (CLI). A THIN wrapper over the shared builder
// (scripts/lib/index-snapshot.mjs) so the live middleware and this script can never diverge.
//
// It registers THIS repo (always) + any `--root <path>` (repeatable — how `piflowctl gui` registers the repo
// it was launched from), writes products.json, builds the snapshot, and writes index.json. Both outputs
// live ONLY under ~/.piflow (the architectural law — never inside packages/, the repo's .piflow/, or
// gui/public). The live GUI reads a freshly-COMPUTED snapshot from the Vite middleware; this file is the
// periodic on-disk artifact + the registration front door.
//
// Run: node gui/scripts/build-index.mjs [--root <path>]...   (or: npm run data:index, from gui/)

import { promises as fs } from 'node:fs';
import {
  REPO, PRODUCTS_FILE, INDEX_FILE,
  loadRegistry, upsertRoot, saveRegistry, buildSnapshot,
  discoverNamespaces, discoverRunDirs,
} from './lib/index-snapshot.mjs';

async function main() {
  // `--root <path>` (repeatable) registers extra repos before indexing; THIS repo is always registered.
  const extraRoots = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--root' && process.argv[i + 1]) extraRoots.push(process.argv[++i]);
  }

  const registry = loadRegistry();
  upsertRoot(registry, REPO);
  for (const r of extraRoots) upsertRoot(registry, r);
  await saveRegistry(registry);

  // HALT only for THIS repo if the documented roots yield nothing — never invent data.
  const ns = discoverNamespaces(REPO);
  const { runDirs, searchRoots } = discoverRunDirs(REPO);
  if (ns.length === 0 || runDirs.length === 0) {
    console.error('HALT: no real data found at the documented roots for THIS repo.');
    console.error(`  workspaces: ${searchRoots[0]}/*/template/meta.json → ${ns.length}`);
    console.error(`  runs:       ${searchRoots.join('/*/.pi/run.json  ')} → ${runDirs.length}`);
    process.exit(1);
  }

  const snapshot = await buildSnapshot(registry);
  await fs.writeFile(INDEX_FILE, JSON.stringify(snapshot, null, 2) + '\n');

  // ── human summary ──
  const totalNs = snapshot.products.reduce((a, p) => a + p.namespaces.length, 0);
  const totalThreads = snapshot.products.reduce((a, p) => a + p.namespaces.reduce((b, n) => b + n.threads.length, 0), 0);
  console.log(`index → ${INDEX_FILE}`);
  console.log(`registry → ${PRODUCTS_FILE}`);
  console.log(`  ${snapshot.products.length} product(s) · ${totalNs} namespace(s) · ${totalThreads} thread(s)`);
  for (const p of snapshot.products) {
    console.log(`  product ${p.id} (${p.root})`);
    for (const ns2 of p.namespaces) {
      console.log(`    namespace ${ns2.id.padEnd(12)} ${ns2.threads.length} thread(s)`);
      for (const t of ns2.threads) {
        console.log(`      ${String(t.run).padEnd(12)} ${String(t.state).padEnd(7)} ${t.nodesDone}/${t.nodesTotal} nodes · viewable=${t.viewable} · ${t.runViewPath || '(no view)'}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
