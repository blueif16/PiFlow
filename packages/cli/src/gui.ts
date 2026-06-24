// `piflow gui` — launch the run viewer (the monorepo `gui/` Vite app) from ANYWHERE on PATH.
//
// Flow: (1) locate `gui/` relative to this CLI (so a globally-linked `piflow` still finds it), (2) refresh
// the global index in ~/.piflow, REGISTERING the product the command was launched from — so a run in THIS
// repo (including the `out/<id>` convention) shows up without hand-editing the registry, (3) start the GUI
// server, which serves the global index + the live-run SSE stream (gui/vite.config.ts middleware).
//
//   • launched inside a product (a dir with `.piflow/` or `out/<id>/.pi/run.json`) → that product is
//     indexed and its running run is auto-focused by the GUI (pickCurrentRun).
//   • launched anywhere else → the already-registered products' global view (nothing new registered).
//
// The viewer is the Vite dev server (it carries the index/products/stream middleware + HMR). It runs in the
// foreground; Ctrl-C stops it.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Nearest ancestor of `start` that is a pi-flow product/workspace (`.piflow/` OR an `out/<id>/.pi/run.json`). */
function findProductRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, '.piflow'))) return dir;
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

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', (e) => { process.stderr.write(`piflow gui: failed to spawn ${cmd} (${String(e)})\n`); resolve(1); });
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
    process.stderr.write('piflow gui: could not locate the gui/ app (expected inside the piflow monorepo).\n');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(path.join(guiDir, 'node_modules', 'vite'))) {
    process.stderr.write(`piflow gui: gui deps not installed — run:  ( cd ${guiDir} && npm install )\n`);
    process.exitCode = 1;
    return;
  }

  // 1) refresh the global index, registering the product we were launched from (if any).
  const productRoot = findProductRoot(process.cwd());
  const indexArgs = [path.join(guiDir, 'scripts', 'build-index.mjs')];
  if (productRoot) {
    indexArgs.push('--root', productRoot);
    process.stdout.write(`piflow gui: indexing product → ${productRoot}\n`);
  } else {
    process.stdout.write('piflow gui: no product at cwd — serving the global index (all registered products).\n');
  }
  const idxCode = await run('node', indexArgs, guiDir);
  if (idxCode !== 0) {
    process.stderr.write('piflow gui: the index build reported a problem — continuing (the GUI shows whatever indexed).\n');
  }

  // 2) start the viewer (Vite dev server: serves /__piflow/index|products.json + /__piflow/stream/<run>).
  const devArgs = ['run', 'dev', '--'];
  if (port) devArgs.push('--port', port);
  if (open) devArgs.push('--open');
  process.stdout.write('piflow gui: starting the viewer…  (Ctrl-C to stop)\n');
  await run('npm', devArgs, guiDir);
}
