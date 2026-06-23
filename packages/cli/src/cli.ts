#!/usr/bin/env node
// The `piflow` CLI — the docker-style front door to a pi-flow run, over the engine-owned `.pi/` run
// layout. ONE front door: `status` + `watch` are this package; `logs` is re-exported from @piflow/core
// (runLogsCli) so a consumer has a single `piflow` bin rather than two.
//
//   piflow status <rundir> [--every <s>]   per-node table (id · label · status · verified/total · dur)
//                                          + stage/rollup, read from .pi/run.json (+ .pi/nodes/<id>/io.json)
//   piflow watch  <rundir> [--notify]      a silent sentinel — one line when the run finishes / a node
//                                          errors|blocks / a node dead-stalls
//   piflow logs   [dir|run] [...]          stream/replay/diagnose a run's per-node event archives (core)
//
// `status`/`watch` are THIN renderers over the shared observability source (@piflow/core/observe):
// `status` lays out a `readRunModel` snapshot, `watch` consumes the `watchRun` live stream. They build
// NO run model of their own — the shared reader VERIFIES artifacts on disk (verified, not trusted).

import { runLogsCli } from '@piflow/core';
import { runStatusCli } from './status.js';
import { runWatchCli } from './watch.js';

const HELP = `piflow — observe a pi-flow run over the .pi/ run layout

USAGE
  piflow status <rundir> [--every <s>]   per-node table + stage/rollup (verified on disk)
  piflow watch  <rundir> [--notify]      silent sentinel — one line on done / fail / dead-stall
  piflow logs   [dir|run] [options]      stream / replay / diagnose per-node event archives

STATUS
  <rundir>      a run dir holding .pi/run.json. Default '.'.
  --every <s>   refresh in place every <s>s (live dashboard); omit for one-shot.

WATCH
  <rundir>      a run dir holding .pi/run.json. Default '.'.
  --notify      best-effort desktop ping on the terminal event.
  --poll <s>    file-source poll interval (default 20).
  --dead-stall <s>  declare a DEAD stall after the run-status stops advancing this long (default 600).

LOGS (from @piflow/core)
  -f --follow · --node <id> · --summary · --raw · --poll <ms>   (see 'piflow logs --help' semantics)
`;

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case 'status':
      await runStatusCli(rest);
      break;
    case 'watch':
      await runWatchCli(rest);
      break;
    case 'logs':
      await runLogsCli(rest);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(HELP);
      break;
    default:
      process.stderr.write(`piflow: unknown command '${sub}'\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n');
  process.exitCode = 1;
});
