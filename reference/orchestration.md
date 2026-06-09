# Orchestration — Claude Code is the console; the user runs nothing

The point of this transform is **cheap execution under Claude Code's supervision**. Claude Code
(you, the orchestrator) is the single console and monitor. You run every command, you read every
status, you know the exact live state at all times. The user is never handed a command and never
asked "is it still running?".

## The loop

1. **Sanity-check the DAG (free).** Before any live run, print the realized stages — this costs
   nothing (no model is invoked) and proves the extraction matches the workflow you proved on
   Claude:
   ```bash
   node pi-runner/extract.mjs
   ```
2. **Dry-run (free).** Build the prompts + print the exact `pi` command per node:
   ```bash
   node pi-runner/run.mjs --run <id> --arg <k=v> --until <phase> --dry-run
   ```
3. **Live, in the background, always `--debug`.** Launch it as a background process so you keep
   the turn and can poll:
   ```bash
   node pi-runner/run.mjs --run <id> --arg <k=v> --until <phase> --debug
   ```
   Run it with the Bash tool's `run_in_background: true` (or `&`), capture the process, and poll.
4. **Poll the verified status — not the model's word:**
   ```bash
   cat <RUN_CWD>/out/<id>/run-status.json   # or jq '.nodes | map_values(.status)'
   ```
   `run-status.json` carries per-node `status`, `durationMs`, `toolCalls`, `toolBreakdown`
   (`{read,bash,write,…}`), `thinking` (`{deltas,chars,spanMs}`), `tokens` (`{input, output,
   billable, contextPeak, cost}`), `eventCount`, `summary`, `issues`, a `live` heartbeat while
   running, and an `artifacts[]` array the driver `stat()`ed on disk. A node is `ok` only if its
   declared artifacts exist — trust that field, not the prose. These aggregates are present in
   BOTH modes (distilled live), so cost/effort is visible even on a lean production run.
5. **Drop a tier when a node looks wrong:** read `out/<id>/_pi/<node>.debug.log` (the 4s
   heartbeat trail), then `out/<id>/_pi/<node>.events.jsonl` (every pi event) to reproduce. Both
   exist **only under `--debug`** — re-run that one node with `--debug` if a production run needs them.

## Fleet — many instances in parallel
The graph is deterministic and per-instance, so scale is just "one driver per instance in the
background." Spawn N background `run.mjs`, each with its own `--run <id>`, then poll each
`out/<id>/run-status.json`. Don't interleave them into one driver — keep each instance isolated;
the only shared state is the reusable library the workflow's nodes read.

## Debug vs production mode
`--debug` is the **single flip** between full-forensic and lean-fleet. It gates the heavy artifacts
only; the digest's distilled aggregates (timing, tool breakdown, thinking, tokens) land in BOTH modes.
- **`--debug` (always while developing):** 4s console heartbeat per running node — `t=elapsed ·
  ev=events · tools=count · cur=tool · think=chars · tok=billable · last=event · Δ=since-last-event ·
  ⚠STALLED` — continuous `run-status.json` refresh, a **stall flag at >45s** since the last event, a
  hard `--node-timeout` (`$PI_RUNNER_NODE_TIMEOUT` or 1800s) that SIGTERM→SIGKILLs a runaway node, AND
  the full forensic archive (raw `*.events.jsonl` + `*.debug.log`). A hang is visible in seconds.
- **Production (no `--debug`):** lean — 10s status refresh, no console heartbeat, and **no raw event
  archive** (it can hit 100s of MB/node — pi's stream is cumulative). The digest is the telemetry; the
  unattended fleet runs this way. Re-run one node with `--debug` to recover its raw stream.

## The incremental-bring-up lever: `--until`
`--until <substring>` truncates after the first stage whose phase title or node label contains
that substring (case-insensitive); default is `all`. Use it to bring a long pipeline up one
block at a time so a bare run can't hit a later toolchain wall (a billed API key, a heavy
render) during shakedown. Prove the dependency-light front of the pipeline first, then extend.

## Non-negotiables (orchestrator discipline)
- **You run every command. The user runs nothing** — not setup, not status checks.
- **Status is verified, not trusted.** "ok" requires artifacts on disk; the driver enforces it,
  and so do you when you read the digest.
- **Always `--debug` while developing.** The heartbeat + stall flag + node-timeout exist because
  a silent headless hang is otherwise invisible (see provider-and-headless.md).
- **One halt rule.** The driver stops the run on the first `error`/`blocked` node and writes
  `ok: false`. Read `run-status.json`, fix the upstream cause (usually the workflow prompt or a
  missing tool in `RUN_CWD`), re-run from that `--until` block.
