// `piflowctl gui` — launch the run viewer (the monorepo `gui/` Vite app) from ANYWHERE on PATH.
//
// The viewer opens FOCUSED on the launched project but can SWITCH across workspaces (the in-app launcher).
// So it SERVES every registered folder (the global registry, pruned to those still on disk) UNION the launched
// project(s), while the launched project stays the initial FOCUS. Flow:
//   (1) locate `gui/` relative to this CLI (so a globally-linked `piflowctl` still finds it),
//   (2) resolve the FOCUS via the shared `resolveScope` (@piflow/core): the enclosing project (walk up to the
//       nearest real `.piflow/`) OR, if launched outside a project, cwd; then every product AT/UNDER it,
//   (3) start the GUI server, passing the SERVED set via `PIFLOW_SCOPE_ROOTS` (focus ∪ pruned global registry)
//       so the Vite middleware builds its snapshot from those roots (gui/vite.config.ts → core's
//       `loadScopedRegistry`) — WITHOUT writing to the global ~/.piflow registry — and the FOCUS via
//       `VITE_PIFLOW_HOME_ROOTS` so the client biases initial focus to the launched folder even after widening.
//       The env channel is required because the spawned Vite server's own cwd is `gui/`, not the user's project.
//
// The viewer is the Vite dev server (it carries the index/products/stream middleware + HMR). It runs in the
// foreground; Ctrl-C stops it. (`piflowctl tui` is the parallel front door for the terminal viewer.)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveScope, loadRegistry, isProductRoot } from '@piflow/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

  // 1) resolve the FOCUS (launched project + nested products) and widen the SERVED set to every registered
  //    folder so the in-app "switch workspace" launcher has somewhere to switch to. The global registry is
  //    pruned to roots that still exist AND are real product roots (drops dead / non-product junk entries).
  //    PIFLOW_SCOPE_ROOTS = focus ∪ pruned-global (what the middleware serves, no global-registry write);
  //    VITE_PIFLOW_HOME_ROOTS = focus (the client biases initial focus here even after widening).
  const { scopeRoot, roots } = resolveScope(process.cwd());
  const globalRoots = loadRegistry().products.map((p) => p.root).filter((r) => existsSync(r) && isProductRoot(r));
  const served = Array.from(new Set([...roots, ...globalRoots]));
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (served.length) {
    env.PIFLOW_SCOPE_ROOTS = served.join(path.delimiter);
  } else {
    delete env.PIFLOW_SCOPE_ROOTS; // nothing registered and not in a project → middleware falls back to global
  }
  if (roots.length) {
    env.VITE_PIFLOW_HOME_ROOTS = roots.join('\n'); // newline-joined: safe across OS path delimiters
    process.stdout.write(`piflowctl gui: focus = ${roots.length} project(s) under ${scopeRoot}; serving ${served.length} workspace(s) (switchable):\n`);
    for (const r of served) process.stdout.write(`  ${roots.includes(r) ? '▸' : '·'} ${r}\n`);
  } else {
    delete env.VITE_PIFLOW_HOME_ROOTS;
    process.stdout.write(`piflowctl gui: no piflow project at or under ${scopeRoot} — serving ${served.length} registered workspace(s).\n`);
  }

  // 2) start the viewer (Vite dev server: serves /__piflow/index|products.json + /__piflow/stream/<run>,
  //    scoped to PIFLOW_SCOPE_ROOTS when set).
  const devArgs = ['run', 'dev', '--'];
  if (port) devArgs.push('--port', port);
  if (open) devArgs.push('--open');
  process.stdout.write('piflowctl gui: starting the viewer…  (Ctrl-C to stop)\n');
  await run('npm', devArgs, guiDir, env);
}
