#!/usr/bin/env node
// ── tui/pi-tui.mjs ─────────────────────────────────────────────────────
// The pi-flow terminal monitor entry. Two modes, same App:
//   • FLEET (no <rundir>): renders ALL runs across the REGISTERED repos — the SAME fleet the GUI shows,
//     built from `buildSnapshot(loadRegistry())` (the one shared fleet builder). Namespaces(workflows) →
//     threads(runs) on the left; drill into any run for its live DAG + per-node inspector.
//   • SINGLE (<rundir>): a self-describing run dir (the `.pi/` layout) — renders just that one run, live.
//
//     piflow-tui                     ← FLEET mode: every registered repo's runs (reads ~/.piflow registry)
//     piflow-tui <rundir>            ← the run dir that holds `.pi/run.json` (e.g. .piflow/<wf>/runs/<id>)
//     piflow-tui <rundir> --every 5  ← refresh interval in seconds (default 2)
//
// Keys:  ↑↓ select · ←→ / Tab move pane · ⏎ drill in · v graph · q quit
// ─────────────────────────────────────────────────────────────────────────────
import { render } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import { runJsonFile } from '@piflow/core';
import { App, html } from './components.mjs';
import { discoverFleet } from './model.mjs';

function parseArgs(args) {
  const c = { runDir: null, every: 2 };
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (k === '--every') c.every = Number(args[++i]);
    else if (!k.startsWith('--') && !c.runDir) c.runDir = path.resolve(k);
    else throw new Error(`unknown arg: ${k}`);
  }
  return c;
}

const config = parseArgs(process.argv.slice(2));
// FLEET mode (no run dir): the App discovers the whole fleet itself via `discoverFleet` (config.fleet).
// SINGLE mode (run dir): the App keeps the EXACT prior behaviour via `discoverNamespaces(config)`.
if (config.runDir) {
  if (!fs.existsSync(runJsonFile(config.runDir))) {
    console.error(`piflow-tui: no .pi/run.json under ${config.runDir}\n  point me at a run dir (e.g. .piflow/<wf>/runs/<id>).`);
    process.exit(1);
  }
} else {
  config.fleet = true;
  // Surface an empty fleet up front (no registered repos) instead of an empty dashboard with no hint.
  const fleet = await discoverFleet();
  if (!fleet.length) {
    console.error('piflow-tui: no runs found across the registered repos (~/.piflow).\n  Start a `piflowctl run`, or point me at one run dir:  piflow-tui <rundir>');
    process.exit(1);
  }
}
if (!process.stdout.isTTY) {
  console.error('piflow-tui needs an interactive terminal (TTY). Run it directly in your shell.');
  process.exit(1);
}
render(html`<${App} config=${config} />`, { patchConsole: false });
