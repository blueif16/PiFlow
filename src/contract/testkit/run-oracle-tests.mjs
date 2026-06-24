/**
 * run-oracle-tests.mjs — the AGGREGATE runner for the per-cap *.oracle.test.mjs
 * real-engine drive tests (there is otherwise no aggregate gate — each test is a
 * standalone `node <file>`).
 * ============================================================================
 *
 * Globs every `**​/__tests__/*.oracle.test.mjs` under templates/modules/<arch>/src,
 * runs each in its own `node` child (per-test process isolation — each boots + tears
 * down its own real Phaser.HEADLESS game and calls process.exit), tallies per
 * archetype, and exits NON-ZERO if any test fails. Only the oracle-only 2D archetypes
 * ship `*.oracle.test.mjs` (platformer/top_down use the light-kit `*.drive.test.ts`;
 * the 3D modules have none yet), so this naturally scopes to exactly the oracle suite.
 *
 *   cd templates/core && npm run testkit:oracle            # the whole suite
 *   node ../core-contract/src/testkit/run-oracle-tests.mjs grid_logic   # one archetype
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.resolve(HERE, '../../..'); // …/templates
const MODULES = path.join(TEMPLATES, 'modules');

const only = process.argv[2]; // optional archetype filter

const modules = fs
  .readdirSync(MODULES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (!only || d.name === only))
  .map((d) => d.name)
  .sort();

let total = 0;
const fails = [];
const rows = [];

for (const arch of modules) {
  const srcDir = path.join(MODULES, arch, 'src');
  if (!fs.existsSync(srcDir)) continue;
  let files;
  try {
    files = fs
      .readdirSync(srcDir, { recursive: true })
      .filter((f) => typeof f === 'string' && f.endsWith('.oracle.test.mjs'))
      .map((f) => path.join(srcDir, f))
      .sort();
  } catch {
    files = [];
  }
  if (!files.length) continue;

  let archFail = 0;
  for (const f of files) {
    total++;
    // Each test is self-contained: boots the real engine, asserts, process.exit(0|1).
    const r = spawnSync(process.execPath, [f], { encoding: 'utf8' });
    if (r.status !== 0) {
      archFail++;
      const errLine =
        (r.stderr || '')
          .split('\n')
          .find((l) => l.includes('AssertionError') || l.includes('Error:')) ||
        (r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] ||
        `exit ${r.status}`;
      fails.push({ file: path.relative(TEMPLATES, f), err: errLine.trim() });
    }
  }
  rows.push({ arch, pass: files.length - archFail, count: files.length });
}

console.log(`\nregistry oracle drive tests — ${total} caps across ${rows.length} archetype(s)\n`);
for (const r of rows) {
  const mark = r.pass === r.count ? 'ok' : 'FAIL';
  console.log(`  ${r.arch.padEnd(16)} ${String(r.pass).padStart(2)}/${String(r.count).padEnd(2)} green   ${mark}`);
}
console.log(`  ${'-'.repeat(40)}`);
console.log(`  TOTAL  ${total - fails.length}/${total} green`);

if (fails.length) {
  console.error(`\n  ORACLE FAILURES (${fails.length}):`);
  for (const x of fails) console.error(`    - ${x.file}\n        ${x.err}`);
  process.exit(1);
}
console.log(`\n  registry oracle suite ok — ${total}/${total} per-cap drive tests green.\n`);
process.exit(0);
