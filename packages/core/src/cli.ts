#!/usr/bin/env node
// The `piflow` CLI — the portable, docker-style front door to a run's observability. Today it hosts
// one subcommand, `logs` (stream/replay a run's per-node event archives); more dispatch lands here.
//
//   piflow logs [dir|run] [--node <id>] [-f] [--raw] [--poll <ms>]
//
// `dir` defaults to '.', or a bare run id resolves to `out/<id>`. Any project that depends on
// @piflow/core gets this for free (`npx piflow logs out/<run> -f`).

import { runLogsCli } from './runner/logs.js';

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case 'logs':
      await runLogsCli(rest);
      break;
    default:
      process.stderr.write('usage: piflow logs [dir|run] [--node <id>] [-f] [--raw] [--poll <ms>]\n');
      process.exitCode = 1;
  }
}

main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exitCode = 1; });
