#!/usr/bin/env node
// ── pi-runner/tui/pi-tui.mjs ─────────────────────────────────────────────────
// The pi-runner terminal monitor. Install once (npm link / npm i -g) and then just:
//
//     pi-tui                 ← every registered project + its live runs. No flags.
//
// Projects register THEMSELVES: run.mjs upserts the project into ~/.pi-runner/registry.json
// on every run, so anything you've ever run with pi-runner shows up automatically. Manage it:
//
//     pi-tui add [dir] [--name X]   register a project (defaults to cwd) — for one you
//                                   haven't run yet. Otherwise unnecessary.
//     pi-tui rm  [dir]              forget a project.
//     pi-tui ls                     print the registry.
//
// Advanced (compose with the registry): --scan <parent> · --root [name=]dir · --out <name> · --every <s>
//
// Keys:  ↑↓ select · ←→ / Tab move pane · ⏎ drill in · q quit
// ─────────────────────────────────────────────────────────────────────────────
import { render } from 'ink';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { App, html } from './components.mjs';
import { registerProject, unregisterProject, listRegistered, registryPath } from '../viz-model.mjs';

// ── subcommands (registry management; no UI) ────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === 'add') {
  const rest = argv.slice(1);
  const dir = rest.find((a) => !a.startsWith('--')) || process.cwd();
  const ni = rest.indexOf('--name');
  const abs = registerProject(dir, { name: ni >= 0 ? rest[ni + 1] : undefined });
  console.log(`✔ registered ${abs}\n  → ${registryPath()}\n  run \`pi-tui\` to see it.`);
  process.exit(0);
}
if (cmd === 'rm' || cmd === 'remove') {
  console.log(`✔ forgot ${unregisterProject(argv[1] || process.cwd())}`);
  process.exit(0);
}
if (cmd === 'ls' || cmd === 'list') {
  const regs = listRegistered();
  if (!regs.length) console.log('no projects registered yet — run a pi-runner workflow once (auto-registers), or `pi-tui add` in a project.');
  for (const r of regs) {
    const live = fs.existsSync(path.join(r.dir, r.out || 'out')) ? '' : '  (out/ missing — stale)';
    console.log(`${(r.name || '').padEnd(18)} ${r.dir}${live}`);
  }
  console.log(`\nregistry: ${registryPath()}`);
  process.exit(0);
}

// ── dashboard (bare `pi-tui` or with compose flags) ─────────────────────────────
function loadConfigFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { roots: (j.roots || []).map((r) => (typeof r === 'string' ? { name: null, dir: r } : r)), scan: j.scan || null, out: j.out, every: j.every };
  } catch { return null; }
}
function parseArgs(args) {
  const c = { roots: [], scan: null, out: 'out', every: 2, registry: true };
  for (let i = 0; i < args.length; i++) {
    const k = args[i]; const next = () => args[++i];
    if (k === '--root') { const v = next(); const eq = v.indexOf('='); c.roots.push(eq > 0 ? { name: v.slice(0, eq), dir: v.slice(eq + 1) } : { name: null, dir: v }); }
    else if (k === '--scan') c.scan = next();
    else if (k === '--out') c.out = next();
    else if (k === '--every') c.every = Number(next());
    else if (k === '--no-registry') c.registry = false;
    else if (k === '--config') { const cfg = loadConfigFile(next()); if (cfg) { c.roots.push(...cfg.roots); c.scan = cfg.scan || c.scan; if (cfg.out) c.out = cfg.out; if (cfg.every) c.every = cfg.every; } }
    else throw new Error(`unknown arg: ${k}`);
  }
  return c;
}

const config = parseArgs(argv);
if (!process.stdout.isTTY) {
  console.error('pi-tui needs an interactive terminal (TTY). Run it directly in your shell.');
  process.exit(1);
}
render(html`<${App} config=${config} />`, { patchConsole: false });
