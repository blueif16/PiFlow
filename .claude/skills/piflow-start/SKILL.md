---
name: piflow-start
description: >-
  Pi Flow · START — run an already-created pi-flow workflow on the pi fleet and monitor it as the single
  console: dry-run → live (background) → `piflow logs`. Use to "run my piflow workflow", "start the pipeline on
  pi", "kick off a run", "monitor/follow a run", "diagnose why a node stalled / never-wrote". To CREATE the
  workflow first use piflow-init; to IMPROVE it use piflow-enhance. STATUS — STUB: the run/monitor procedure is
  authored but lives in the references below; this skill will become its dedicated home.
---

# Pi Flow · start — run & monitor a workflow on the pi fleet  ·  STUB

> **This is a scope-declaring stub, not the finished skill.** The run + monitor procedure already exists and
> works — it currently lives in piflow-init's "Standing up the project" + the `reference/` files named below.
> This skill exists so the lifecycle has a clean RUN entry; do NOT hand-roll a parallel procedure here. Follow
> the references; if they don't cover your case, HALT and flag it rather than improvise.
> (Paths are relative to the piflow repo root, `~/Desktop/piflow`.)

## What this skill will own (the RUN half of the lifecycle)
Claude Code is the operator — **you run every command; the user runs nothing.** The flow:

1. **Dry-run (free, no model)** — confirm the realized DAG, per-node `[tools: …] [hooks: …]`, the resolved `pi`
   command, and any `⚠ TOOL BINDING`:
   ```bash
   node pi-runner/sdk/run.mjs --run <id> --arg <k=v> --until <phase> --dry-run
   ```
2. **Live (background)** — drop `--dry-run`; run it in the background and never block on it:
   ```bash
   node pi-runner/sdk/run.mjs --run <id> --arg <k=v> --until <phase>
   ```
   `--until`/`--from`/`--only` window a long pipeline. `--worktree`/`--sandbox` arm fleet isolation /
   OS read-scope (see piflow-init's hardening list).
3. **Monitor — `piflow logs` is docker-logs for a run** (reads `run-status.json` state + `_pi/<id>.events.jsonl`
   behavior, joined on node id):
   ```bash
   node pi-runner/logs.mjs <run> -f          # live follow — one line per action, per node
   node pi-runner/logs.mjs <run> --summary   # post-run diagnosis (verdict + why; never-write / timeout / stall)
   node pi-runner/logs.mjs <run> --node <id> # one node (replay if done, live if running); add --raw for the firehose
   ```

## Where the material is (read these — do not duplicate them here)
- `reference/orchestration.md` — Claude-Code-as-console: dry-run → background live → poll.
- `reference/cli.md` — the run flags + the `--from`/`--until`/`--only` node-range model + the `.env` knobs.
- `reference/observability.md` — the run-status + event-archive contract, the `piflow logs` CLI, the pre-run
  tool audit, the `RunOptions` knobs, and the **failure-signature table** (never-write / timeout / stall). Read
  this when a run misbehaves.
- `reference/provider-and-headless.md` — the headless invariants + watchdog (a silent hang is otherwise
  invisible).
- piflow-init → "Standing up the project" (step 6) and "The laws" (headless invariants · every-run-records-its-behavior).

## When this stub is filled in
Lift the run/monitor procedure into a self-contained skill here (the dry-run → live → logs flow + the
failure-signature triage), keep the `reference/` files as the deep spec, and trim piflow-init's run step to a
one-line pointer to this skill. Until then: this stub + the references ARE the procedure.
