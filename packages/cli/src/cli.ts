#!/usr/bin/env node
// The `piflowctl` CLI — the docker-style front door to a pi-flow run, over the engine-owned `.pi/` run
// layout. ONE front door: `status` + `watch` are this package; `logs` is re-exported from @piflow/core
// (runLogsCli) so a consumer has a single `piflowctl` bin rather than two.
//
//   piflowctl status <rundir> [--every <s>]   per-node table (id · label · status · verified/total · dur)
//                                          + stage/rollup, read from .pi/run.json (+ .pi/nodes/<id>/io.json)
//   piflowctl watch  <rundir> [--notify]      a silent sentinel — one line when the run finishes / a node
//                                          errors|blocks / a node dead-stalls
//   piflowctl logs   [dir|run] [...]          stream/replay/diagnose a run's per-node event archives (core)
//
// `status`/`watch` are THIN renderers over the shared observability source (@piflow/core/observe):
// `status` lays out a `readRunModel` snapshot, `watch` consumes the `watchRun` live stream. They build
// NO run model of their own — the shared reader VERIFIES artifacts on disk (verified, not trusted).

import { runLogsCli } from '@piflow/core';
import { runStatusCli } from './status.js';
import { runWatchCli } from './watch.js';
import { runExtractCli } from './extract.js';
import { runRunCli } from './run.js';
import { runInspectCli } from './inspect.js';
import { runGuiCli } from './gui.js';

const HELP = `piflowctl — drive + observe a pi-flow run over the .pi/ run layout

USAGE
  piflowctl run     <templateDir> [--run <id>] [flags]  drive a template run (real or --dry-run)
  piflowctl inspect <templateDir> [nodeId] [--full]  per-node RESOLVED view (sandbox · tools · ops · prompt)
  piflowctl extract <templateDir>           free DAG preview (node count + parallel lanes; no model)
  piflowctl status  <rundir> [--every <s>]  per-node table + stage/rollup (verified on disk)
  piflowctl watch   <rundir> [--notify]     silent sentinel — one line on done / fail / dead-stall
  piflowctl logs    [dir|run] [options]     stream / replay / diagnose per-node event archives
  piflowctl gui     [--port <n>] [--no-open]  launch the run viewer; indexes the product at cwd (or global)

RUN
  <templateDir> an authored template/ dir (meta.json + nodes/*/). Required.
  --dry-run     build + print the realized per-node pi command(s); invoke NO model (free).
  --run <id>    the instance id (keys out/<id>); aliases --id. Required for a live run.
  --arg k=v     a workflow arg → {{arg.k}} (repeatable).
  --workspace <p>  the read-only {{WORKSPACE}} root (skills/templates/registry); default cwd.
  --sandbox <inmemory|local|danger-full-access>  exec backend. inmemory (default) = no model;
                   local = real in-place pi, read-scope-jailed per node (seatbelt on macOS);
                   danger-full-access = local with the jail OFF (agent reads the whole filesystem).
  --provider <gw>  the pi --provider gateway (e.g. mmgw).
  --thinking <v>   reasoning-depth cap → pi --thinking.
  --model <m>      model pin → pi --model.
  --out <dir>      host run dir (= {{RUN}}) — FALLBACK ONLY. A template under .piflow/<wf>/template/
                   ALWAYS uses its canonical .piflow/<wf>/runs/<run>/ home and IGNORES --out (a
                   canonical run is never relocated). Default: canonical home, else out/<run>.
  --from / --until <substr>  resume / truncate the stage window.

INSPECT
  <templateDir> an authored template/ dir. Compiles it and prints each node's RESOLVED view —
                sandbox (provider/workspace/read/write/output) · tools (allow/deny + resolved
                piTools/excluded) · ops (seed/project/merge/promote) · io.artifacts · the prompt.
  [nodeId]      restrict to one node; omit for all. An unknown id errors with the valid ids.
  --full        print the FULL realized prompt (default: a head slice).

EXTRACT
  <templateDir> an authored template/ dir. Prints stages + parallel lanes. FREE (no model).

STATUS
  <rundir>      a run dir holding .pi/run.json. Default '.'.
  --every <s>   refresh in place every <s>s (live dashboard); omit for one-shot.

WATCH
  <rundir>      a run dir holding .pi/run.json. Default '.'.
  --notify      best-effort desktop ping on the terminal event.
  --poll <s>    file-source poll interval (default 20).
  --dead-stall <s>  declare a DEAD stall after the run-status stops advancing this long (default 600).

LOGS (from @piflow/core)
  -f --follow · --node <id> · --summary · --raw · --poll <ms>   (see 'piflowctl logs --help' semantics)

TIP
  the command is 'piflowctl' (the bare 'piflow' is taken by the unrelated @arche-sh/piflow). if
  'piflow' is free on your system, alias it:  alias piflow=piflowctl
`;

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case 'run':
      await runRunCli(rest);
      break;
    case 'inspect':
      await runInspectCli(rest);
      break;
    case 'extract':
      await runExtractCli(rest);
      break;
    case 'status':
      await runStatusCli(rest);
      break;
    case 'watch':
      await runWatchCli(rest);
      break;
    case 'logs':
      await runLogsCli(rest);
      break;
    case 'gui':
      await runGuiCli(rest);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(HELP);
      break;
    default:
      process.stderr.write(`piflowctl: unknown command '${sub}'\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n');
  process.exitCode = 1;
});
