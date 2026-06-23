#!/usr/bin/env node
// The `piflow` CLI — the portable, docker-style front door to a run's observability. Today it hosts
// one subcommand, `logs` (stream/replay a run's per-node event archives); more dispatch lands here.
//
//   piflow logs [dir|run] [--node <id>] [-f] [--raw] [--poll <ms>]
//
// `dir` defaults to '.', or a bare run id resolves to `out/<id>`. Any project that depends on
// @piflow/core gets this for free (`npx piflow logs out/<run> -f`).

import { runLogsCli } from './runner/logs.js';

const HELP = `piflow — observe a pi-flow run (docker-logs for a workflow)

USAGE
  piflow logs [dir|run] [options]      stream / replay / diagnose a run

  dir|run   a run dir (holds .pi/run.json) or a bare id (→ out/<id>). Default '.'.

OPTIONS (logs)
  -f, --follow     attach live: stream every started node, roll forward until the run is done
      --node <id>  just one node (live if running, replay if done)
      --summary    post-run DIAGNOSIS: per-node verdict — status · exit · killed · writes/reads/tools ·
                   missing declared artifacts · the never-write heuristic · last words · stderr
      --raw        the unslimmed event lines (the firehose); default is the distilled one-per-action view
      --poll <ms>  follow poll interval (default 700)

EXAMPLES
  piflow logs out/myrun -f          # watch a run live
  piflow logs out/myrun --summary   # one-glance diagnosis after it finishes
  piflow logs out/myrun --node w0   # replay one node, distilled

Per-node event archives live at <dir>/.pi/nodes/<id>/events.jsonl (written when RunOptions.recordEvents
is on, the default). See docs/observability.md.\n`;

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
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

main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exitCode = 1; });
