# Orchestration — Claude Code is the console; the user runs nothing

The point of this transform is **efficient execution under Claude Code's supervision**. Claude Code
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
   node pi-runner/status.mjs --run <id>     # ergonomic dashboard: per-node status/dur/cost + rollup
   node pi-runner/watch.mjs  --run <id>     # background sentinel: wakes ONLY on done/error/driver-gone/dead-stall
   cat <RUN_CWD>/out/<id>/run-status.json   # the raw truth — or jq '.nodes | map_values(.status)'
   pi-tui                                   # GLOBAL standing console: EVERY registered project + its live runs
   ```
   `status.mjs`/`watch.mjs` watch ONE run; `pi-tui` (installed once via `pi-runner/tui/`) is the
   cross-project console — every run auto-registers its folder as a *namespace* in
   `~/.pi-runner/registry.json`, so a bare `pi-tui` surveys all projects and drills into namespace →
   thread (run) → per-node detail, live. It reconstructs everything from the same `run-status.json` you
   already poll (no new state). `pi-tui add .` registers a folder before its first run.
   Prefer `watch.mjs` for a backgrounded run: it stays silent (no context spam) and exits with one
   summary line on the first event that needs you — and it will NOT trip on the transient ~60–90s
   `cp` stream pause (only a real >10-min dead stall, the stale driver, or a node error).
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
  cur=tool · think=chars · tok=billable · Δ=since-last-event · ⚠STALLED` — continuous
  `run-status.json` refresh, a **stall flag at >45s**, a hard `--node-timeout` (`$PI_RUNNER_NODE_TIMEOUT`
  or 1800s) that SIGTERM→SIGKILLs a runaway node, AND the forensic archive (`*.events.jsonl` +
  `*.debug.log`). A hang is visible in seconds.
- **Production (no `--debug`):** lean — 10s status refresh, no console heartbeat, and **no event
  archive**. The digest is the telemetry; the unattended fleet runs this way. Re-run one node with
  `--debug` to recover its archive.
- **The archive is slimmed.** pi's `message_update` events are cumulative (each delta re-embeds the
  whole accumulated message → 100s of MB/node); the driver strips those snapshots as it writes,
  keeping only deltas (~55× smaller, lossless). A giant transcript is **bloat, not a loop**.
- **Three cost guards.** stall flag (>45s no event) · `--node-timeout` hard kill · **stuck-loop kill**
  (`PI_RUNNER_REPEAT_KILL`, default 400 consecutive identical deltas — the signature of a model stuck
  emitting one token; legit nodes never exceed ~2). Kills early instead of burning to the timeout.

## The bring-up + resume levers: `--until` / `--from` / `--only`
`--until <substring>` truncates after the LAST stage whose phase title, node label, or node id
contains that substring (case-insensitive); default is `all`. Use it to bring a long pipeline up one
block at a time so a bare run can't hit a later toolchain wall (a billed API key, a heavy
render) during shakedown. Prove the dependency-light front of the pipeline first, then extend.

`--from <substring>` is its mirror: **resume** — skip every stage BEFORE the first match and reuse
their on-disk artifacts (a prior run must have produced them). Because nodes coordinate only through
the filesystem, any node is a pure function of its frozen upstream artifacts, so the retest unit is
ONE node. Pair them for an inclusive range (`--from verify --until scaffold`); `--only <substring>`
is sugar for `--from X --until X` — re-run exactly one node against frozen upstream, the tight
edit→retest loop that avoids replaying the whole prefix. Soundness: when `--from` skips a prefix the
driver runs a **resume preflight** — it `stat()`s the skipped nodes' `DRIVER-ARTIFACTS` (no pi
spawn) and HALTs (exit 1, naming each missing file + owner) rather than resume on absent/stale
inputs. Skipped nodes register as `reused` in the digest; stage numbering stays absolute (`stage k/N`
over the full DAG). The remaining roadmap is making the skip AUTOMATIC (content-hash the inputs and
reuse on match) so resume needs no manual `--from`.

## Non-negotiables (orchestrator discipline)
- **You run every command. The user runs nothing** — not setup, not status checks.
- **Status is verified, not trusted.** "ok" requires artifacts on disk; the driver enforces it,
  and so do you when you read the digest.
- **Verify the model before every real run.** The driver defaults to `--provider cp`; confirm `cp`
  (or `$PI_RUNNER_PROVIDER`/`--provider`) resolves to the model you intend — check
  `~/.pi/agent/models.json` and the run's first `message_start` event — never assume a provider added
  under a new name is the one in use. (Full syntax: `cli.md`.)
- **Always `--debug` while developing.** The heartbeat + stall flag + node-timeout exist because
  a silent headless hang is otherwise invisible (see provider-and-headless.md).
- **One halt rule.** The driver stops the run on the first `error`/`blocked` node and writes
  `ok: false`. Read `run-status.json`, fix the upstream cause (usually the workflow prompt or a
  missing tool in `RUN_CWD`), then **`--from <that node>`** to resume on the frozen upstream (or
  `--only <that node>` to retest it in isolation) — never replay the prefix you didn't change.
