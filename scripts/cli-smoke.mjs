#!/usr/bin/env node
// cli-smoke — prove the INSTALLED `piflowctl` bin actually runs (test-discipline: a gate that exercises
// the real published shape, not the in-tree source).
//
// @piflow/cli depends on unpublished workspace packages, so `npm install @piflow/cli` alone would 404.
// To smoke-test the REAL artifact we:
//   1. Pack @piflow/tool-bridge, @piflow/core, @piflow/server, and @piflow/cli into a temp dir.
//   2. In a FRESH temp project, install all four tarballs together
//      (local tarballs satisfy the workspace:* deps without a registry).
//   3. Resolve the installed bin from the temp project's node_modules/.bin and run `piflowctl --version`
//      and `piflowctl --help`. Assert exit 0 + non-empty stdout for each. stderr is NOT swallowed —
//      it is printed on failure so a real break is actionable.
// Temp dirs are cleaned up. Exits nonzero on any failure.
//
// Assumes packages are already built (CI runs `pnpm run build` first); run `pnpm run build` yourself to test.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The cli + its unpublished workspace deps, in install order (deps first is not required for npm, but is
// tidy). Each must be packed and installed together so workspace:* resolves to the local tarballs.
const PACK = [
  { name: '@piflow/tool-bridge', dir: 'packages/tool-bridge' },
  { name: '@piflow/core', dir: 'packages/core' },
  { name: '@piflow/server', dir: 'packages/server' },
  { name: '@piflow/cli', dir: 'packages/cli' },
];

const BIN = 'piflowctl';

/** Run a command, capturing stdout/stderr separately. */
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: process.env });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error,
  };
}

const cleanups = [];
function fail(msg) {
  console.error(`\ncli-smoke: FAILED — ${msg}`);
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      /* best-effort cleanup */
    }
  }
  process.exit(1);
}

// 1. Pack each package into a shared temp dir.
const packDir = mkdtempSync(join(tmpdir(), 'piflow-smoke-pack-'));
cleanups.push(() => rmSync(packDir, { recursive: true, force: true }));

const tarballs = [];
for (const pkg of PACK) {
  console.log(`cli-smoke: packing ${pkg.name} …`);
  // `pnpm pack --pack-destination <dir>` writes the .tgz there and prints its path on the last stdout line.
  const r = run('pnpm', ['pack', '--pack-destination', packDir], join(repoRoot, pkg.dir));
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
    fail(`pnpm pack ${pkg.name} exited ${r.status}`);
  }
  // Identify the produced tarball (most reliable: scan packDir for the new .tgz matching the package).
  // pnpm names scoped tarballs like `piflow-core-0.1.0.tgz` (scope slug-flattened).
  const slug = pkg.name.replace('@', '').replace('/', '-');
  const found = readdirSync(packDir).find((f) => f.startsWith(slug) && f.endsWith('.tgz'));
  if (!found) fail(`could not find packed tarball for ${pkg.name} in ${packDir} (have: ${readdirSync(packDir).join(', ')})`);
  tarballs.push(join(packDir, found));
}

// 2. Fresh temp project; install all tarballs together.
const projDir = mkdtempSync(join(tmpdir(), 'piflow-smoke-proj-'));
cleanups.push(() => rmSync(projDir, { recursive: true, force: true }));

// Minimal package.json so npm install has a project to install into.
run('npm', ['init', '-y'], projDir);

console.log(`cli-smoke: installing ${tarballs.length} tarball(s) into a fresh project …`);
// Use npm (not pnpm) so the bin is materialized into node_modules/.bin exactly as a consumer's `npm i` would.
const inst = run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], projDir);
if (inst.status !== 0) {
  console.error(inst.stdout);
  console.error(inst.stderr);
  fail(`npm install of the tarballs exited ${inst.status}`);
}

// 3. Resolve the installed bin and run the smoke commands.
const binPath = join(projDir, 'node_modules', '.bin', BIN);
if (!existsSync(binPath)) {
  fail(`installed bin not found at ${binPath} — @piflow/cli did not register the '${BIN}' bin (have: ${readdirSync(join(projDir, 'node_modules', '.bin')).join(', ')})`);
}

const SMOKE = [
  { args: ['--version'], label: `${BIN} --version` },
  { args: ['--help'], label: `${BIN} --help` },
];

let anyFail = false;
for (const c of SMOKE) {
  const r = run(binPath, c.args, projDir);
  const okExit = r.status === 0;
  const okStdout = r.stdout.trim().length > 0;
  if (okExit && okStdout) {
    console.log(`[PASS] ${c.label} (exit 0, ${r.stdout.trim().length} bytes stdout)`);
  } else {
    anyFail = true;
    console.log(`[FAIL] ${c.label}`);
    console.log(`       exit=${r.status}  stdout=${r.stdout.trim().length} bytes`);
    if (!okStdout) console.log('       (stdout was EMPTY — a --version/--help must print to stdout)');
    // DO NOT swallow stderr — print it so the real break is visible.
    if (r.stderr.trim()) {
      console.log(
        '       stderr:\n' +
          r.stderr
            .trimEnd()
            .split('\n')
            .map((l) => `         | ${l}`)
            .join('\n'),
      );
    }
    if (r.error) console.log(`       [spawn error] ${r.error.message}`);
  }
}

for (const fn of cleanups) {
  try {
    fn();
  } catch {
    /* best-effort cleanup */
  }
}

if (anyFail) {
  console.error('\ncli-smoke: FAILED — the installed CLI did not run cleanly.');
  process.exit(1);
}
console.log('\ncli-smoke: PASSED — the installed piflowctl runs.');
