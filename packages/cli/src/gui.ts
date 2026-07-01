// `piflowctl gui` — launch the run viewer (the monorepo `gui/` Vite app) from ANYWHERE on PATH.
//
// The viewer is SCOPED TO THE LAUNCHED PROJECT: it shows the project you're in (or, from a parent dir, every
// project beneath you) — never the whole accumulated global registry. Flow:
//   (1) locate `gui/` relative to this CLI (so a globally-linked `piflowctl` still finds it),
//   (2) resolve the DISPLAY SCOPE — the enclosing project (walk up to the nearest real `.piflow/`) OR, if
//       launched outside a project, cwd; then every product AT/UNDER that scope root (walk down),
//   (3) start the GUI server, passing the scope via `PIFLOW_GUI_ROOTS` so the Vite middleware builds its
//       snapshot from EXACTLY those roots (gui/vite.config.ts) — WITHOUT writing to the global ~/.piflow
//       registry (no accumulation, no cross-project bleed).
//
//   • launched inside a product (a dir whose `.piflow/` holds a real workflow, or an `out/<id>/.pi/run.json`)
//     → that whole project (+ any nested products) is shown and its running run auto-focused (pickCurrentRun).
//   • launched above several products → all of them are shown.
//   • launched anywhere with nothing product-shaped at/under it → no scope is set and the viewer falls back to
//     the global registry (the prior fleet view).
//
// A "product" is a dir whose `.piflow/` contains a REAL workflow (`<wf>/template/meta.json` or `<wf>/runs/`) —
// NOT a bare `.piflow`. That distinction matters: the GLOBAL home `~/.piflow` (products.json / index.json /
// agents/) is itself a `.piflow` at $HOME, and a naive "has a .piflow" test would mis-register $HOME as a
// project (exactly how `/Users/<me>` leaked into the registry). The workflow check excludes the home cleanly.
//
// The viewer is the Vite dev server (it carries the index/products/stream middleware + HMR). It runs in the
// foreground; Ctrl-C stops it.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Dir names never worth descending into when scanning for products (build output, deps, test fixtures). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'tmp', '.tmp', 'fixtures', '__fixtures__']);

/** The monorepo `gui/` dir — walk up from this CLI (dist depth-agnostic) for `gui/scripts/build-index.mjs`. */
function findGuiDir(): string | null {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const g = path.join(dir, 'gui');
    if (existsSync(path.join(g, 'scripts', 'build-index.mjs'))) return g;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Is `dir` a pi-flow PRODUCT — i.e. does its `.piflow/` hold at least one REAL workflow (`<wf>/template/meta.json`
 * or a `<wf>/runs/` dir)? This is the guard that separates a product's `.piflow` from the GLOBAL home `~/.piflow`
 * (whose entries are files — products.json/index.json — plus `agents/`, never a `<wf>/template|runs`).
 */
function isProductRoot(dir: string): boolean {
  const wfRoot = path.join(dir, '.piflow');
  let entries;
  try {
    entries = readdirSync(wfRoot, { withFileTypes: true });
  } catch {
    return false; // no `.piflow/` here
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (existsSync(path.join(wfRoot, e.name, 'template', 'meta.json'))) return true;
    if (existsSync(path.join(wfRoot, e.name, 'runs'))) return true;
  }
  return false;
}

/** Nearest ancestor of `start` that is a pi-flow product (a real `.piflow/` OR an `out/<id>/.pi/run.json`). */
function findProductRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 10; i++) {
    if (isProductRoot(dir)) return dir;
    const out = path.join(dir, 'out');
    if (existsSync(out)) {
      try {
        for (const e of readdirSync(out, { withFileTypes: true })) {
          if (e.isDirectory() && existsSync(path.join(out, e.name, '.pi', 'run.json'))) return dir;
        }
      } catch { /* unreadable → keep walking */ }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Every product root AT or UNDER `start` — a recursive, depth-bounded walk that skips deps/build/fixtures and
 * every dot-dir (so `.git`, `.claude/worktrees/*`, and the `.piflow` dir itself are never descended into). The
 * start dir is always tested (even if named like a skip dir). Roots are absolute + sorted (stable order).
 */
export function findProductRootsUnder(start: string, maxDepth = 6): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    if (isProductRoot(dir) && !seen.has(dir)) {
      seen.add(dir);
      roots.push(dir);
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue; // .piflow, .git, .claude, …
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(path.resolve(start), 0);
  return roots.sort();
}

/**
 * The GUI's display scope for a launch `cwd`: the enclosing project (walk up to the nearest real `.piflow/`)
 * OR, when launched outside any project, `cwd` itself — then EVERY product at/under that scope root. So from a
 * subfolder deep inside project P you get P (and P's nested sub-products); from a parent of many projects you
 * get all of them. Empty `roots` ⇒ nothing product-shaped in scope (the caller falls back to the global view).
 */
export function resolveGuiScope(cwd: string): { scopeRoot: string; roots: string[] } {
  const enclosing = findProductRoot(cwd);
  const scopeRoot = enclosing ?? path.resolve(cwd);
  return { scopeRoot, roots: findProductRootsUnder(scopeRoot) };
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', env });
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', (e) => { process.stderr.write(`piflowctl gui: failed to spawn ${cmd} (${String(e)})\n`); resolve(1); });
  });
}

export async function runGuiCli(argv: string[]): Promise<void> {
  let port: string | undefined;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') port = argv[++i];
    else if (a === '--no-open') open = false;
    else if (a === '--open') open = true;
  }

  const guiDir = findGuiDir();
  if (!guiDir) {
    process.stderr.write('piflowctl gui: could not locate the gui/ app (expected inside the piflow monorepo).\n');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(path.join(guiDir, 'node_modules', 'vite'))) {
    process.stderr.write(`piflowctl gui: gui deps not installed — run:  ( cd ${guiDir} && npm install )\n`);
    process.exitCode = 1;
    return;
  }

  // 1) resolve the DISPLAY SCOPE — the launched project (+ nested products), or every product under cwd. Pass
  //    it to the viewer via PIFLOW_GUI_ROOTS so the middleware serves EXACTLY this set (no global-registry write).
  const { scopeRoot, roots } = resolveGuiScope(process.cwd());
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (roots.length) {
    env.PIFLOW_GUI_ROOTS = roots.join(path.delimiter);
    process.stdout.write(`piflowctl gui: ${roots.length} project(s) in scope under ${scopeRoot}:\n`);
    for (const r of roots) process.stdout.write(`  • ${r}\n`);
  } else {
    delete env.PIFLOW_GUI_ROOTS; // never inherit a stale scope
    process.stdout.write(`piflowctl gui: no piflow project at or under ${scopeRoot} — showing the global fleet view.\n`);
  }

  // 2) start the viewer (Vite dev server: serves /__piflow/index|products.json + /__piflow/stream/<run>,
  //    scoped to PIFLOW_GUI_ROOTS when set).
  const devArgs = ['run', 'dev', '--'];
  if (port) devArgs.push('--port', port);
  if (open) devArgs.push('--open');
  process.stdout.write('piflowctl gui: starting the viewer…  (Ctrl-C to stop)\n');
  await run('npm', devArgs, guiDir, env);
}
