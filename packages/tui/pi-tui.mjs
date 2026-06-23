#!/usr/bin/env node
// ── packages/tui/pi-tui.mjs ─────────────────────────────────────────────────────
// The pi-flow terminal monitor entry. MIGRATED from the legacy pi-runner pi-tui.mjs: a run dir is now
// self-describing (the `.pi/` layout), so there is no global registry / namespace scan — you point it
// at ONE run dir and it renders that run's DAG + per-node inspector, live.
//
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
if (!config.runDir) {
  console.error('usage: piflow-tui <rundir> [--every <s>]   (the run dir holding .pi/run.json)');
  process.exit(1);
}
if (!fs.existsSync(runJsonFile(config.runDir))) {
  console.error(`piflow-tui: no .pi/run.json under ${config.runDir}\n  point me at a run dir (e.g. .piflow/<wf>/runs/<id>).`);
  process.exit(1);
}
if (!process.stdout.isTTY) {
  console.error('piflow-tui needs an interactive terminal (TTY). Run it directly in your shell.');
  process.exit(1);
}
render(html`<${App} config=${config} />`, { patchConsole: false });
