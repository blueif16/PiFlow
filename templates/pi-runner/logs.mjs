#!/usr/bin/env node
// `docker logs` for a pi run — the per-project port hook into @piflow/core's run-observability CLI.
// All logic lives UPSTREAM in @piflow/core (src/runner/events.ts writes the per-node stream; logs.ts
// distills + tails it); this file is the thin entry, the sibling to status.mjs/watch.mjs.
//
// Usage:
//   node pi-runner/logs.mjs [dir|run] [--node <id>] [-f] [--raw] [--poll <ms>]
//
//   dir|run   the run dir (holds run-status.json) or a bare id (→ out/<id>). Default '.'.
//             SDK runs (sdk/run.mjs) write run-status.json + _pi/ at the REPO ROOT, so:
//               node pi-runner/logs.mjs . -f        # follow the live SDK run
//             run.mjs runs namespace under out/<id>, so:
//               node pi-runner/logs.mjs <id> -f     # follow out/<id>
//   --node    stream just one node (live if running, replay if done)
//   -f        follow: attach to the run, stream every started node, roll forward until done
//   --raw     the unslimmed event lines (the firehose); default is the distilled one-line-per-action view
//
// Distilled view: `▸ <tool> <path>` per tool call · `… thinking (n chars)` · `␃ says (n chars)` ·
// `✕ <stderr>`. A `␃ says` with no `▸ write` beside it = the model answered inline and never wrote
// (the cheap-model never-write failure, visible at a glance).

import { runLogsCli } from "@piflow/core";

runLogsCli(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
