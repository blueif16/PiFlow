---
name: transform-workflow-to-pi
description: >-
  Take any Claude Code Workflow (a `.claude/workflows/*.js` script that uses agent()/parallel()/
  pipeline()/phase()) and run the IDENTICAL pipeline cheaply on a fleet of pi agents
  (pi.dev / earendil-works/pi) driven by non-Claude coding-plan models — with Claude Code as the
  single console and monitor. Use when someone wants to run a proven Workflow at lower cost / at
  scale, "run my workflow on pi", "run this on a cheap model", "pi-runner", "offload the workflow
  to cheaper agents", or to stand up the pi-runner harness in a new repo. Ships copy-paste
  templates (extract.mjs, run.mjs, provider extension, .env) so any project can adopt it.
---

# Transform a Claude Code Workflow → pi agents

**One-line model:** the Claude Code Workflow `.js` is the single source of truth; pi-runner
*extracts* the exact realized prompts + DAG from that same file and replays them, one cheap `pi`
process per node, while Claude Code owns the graph and monitors `run-status.json`. **No port, no
codegen, no hand-sync, no drift.**

```
Claude Code (you) ── 1 driver per instance ─► run.mjs (owns the DAG)
                                               │ extract.mjs runs workflow.js under recording stubs
                                               │ → exact prompts + parallel lanes
                                               ▼  one `pi` per node (non-Claude coding-plan model)
                              <repo>/* artifacts + out/<id>/run-status.json  (you poll)
```

## When this applies
- You have a Workflow you've **already proven on Claude** (it runs via the `Workflow` tool) and
  want to run it for cheap / at scale.
- The workflow is **pipeline-shaped**: a fixed set of waves over one input, coordinating through
  the filesystem. (Data-driven fan-out needs one extra step — see `reference/architecture.md`
  "Dynamic workflows".)
- You want Claude Code to stay the operator: it runs everything, the user runs nothing.

If there is **no** workflow yet, write and prove one with the `Workflow` tool first. This skill
transforms an existing workflow; it does not author the pipeline logic.

## The transform — seven steps

1. **Confirm the source of truth.** There is exactly one `.claude/workflows/<name>.js`, it begins
   with `export const meta = {…}` (a pure literal), and its body uses only the Workflow hooks
   (`agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`) — no `import`/`export` besides
   `meta`, and top-level `return`/`await` are fine. You **edit and prove the workflow on Claude**;
   pi inherits it. Never edit pi's copy of a prompt — there is no copy.

2. **Set the credential ONCE in pi's own global config (per machine, not per repo).** The model +
   key live in pi's native `~/.pi/agent/models.json`, which pi resolves for EVERY project — so no
   product ever needs its own key, `.env` credential, or provider extension.
   ```bash
   cp templates/models.json.example ~/.pi/agent/models.json   # edit: apiKey + baseUrl + model ids
   chmod 600 ~/.pi/agent/models.json
   pi --list-models cp                                          # verify: lists your models
   ```
   The provider name MUST stay `cp` (that's what the driver passes as `--provider`). Any
   OpenAI-compatible endpoint works (`api: "openai-completions"`). Skip this if it's already set up
   on the machine. See `reference/provider-and-headless.md`.

3. **Drop in the harness — verbatim.** Copy `templates/pi-runner/` into the repo (alongside
   `.claude/`): `extract.mjs`, `run.mjs`, `.env.example`, `.gitignore` (and `providers/coding-plan.ts`
   only if a provider needs a custom API impl / OAuth — `models.json` covers the OpenAI-compatible
   case). **You edit none of the engine files.** `run.mjs` / `extract.mjs` are generic and stay
   byte-identical across every repo (and this template) — a future fix is a one-file copy, never a
   manual merge.

4. **Configure the per-repo wiring `.env`.** `cp templates/pi-runner/.env.example pi-runner/.env`,
   then set the **wiring only** (no secret): `PI_RUNNER_WORKFLOW` (path to the `.js`, relative to
   repo root) and, if your build runs in a subpackage, `PI_RUNNER_CWD` (where pi executes + where
   node-reported relative artifact paths resolve). `PI_RUNNER_ROOT` defaults to `pi-runner/`'s parent.
   Optionally `PI_RUNNER_UNTIL` (default `--until` during bring-up) and `PI_CP_MODEL` (pin a non-default
   model id from `models.json` for this repo).

5. **Sanity-check the DAG (free).** `node pi-runner/extract.mjs` prints the realized stages — no
   model invoked. Confirm node count + parallel lanes match the workflow you proved on Claude.

6. **Dry-run (free), then live (background, `--debug`).**
   ```bash
   node pi-runner/run.mjs --run <id> --arg <k=v> --until <phase> --dry-run   # prints exact pi cmds
   node pi-runner/run.mjs --run <id> --arg <k=v> --until <phase> --debug     # live; run in background
   ```
   Pass the workflow's `args` with `--arg k=v` (repeatable) and `--arg-file k=path` (reads file
   text, e.g. `--arg-file brief=./brief.md`). `--until` brings a long pipeline up one block at a
   time so a bare run can't hit a later toolchain wall.

7. **Monitor as the console.** Poll `out/<id>/run-status.json` (verified status — `ok` requires
   artifacts on disk), or use the two generic monitors shipped in the kit:
   ```bash
   node pi-runner/status.mjs --run <id>            # one-shot dashboard: per-node status/dur/cost + rollup
   node pi-runner/status.mjs --run <id> --every 5  # live dashboard (refresh in place)
   node pi-runner/watch.mjs  --run <id> --notify   # background sentinel: silent until the ONE event
   ```
   `watch.mjs` is the wake-on-event sentinel for a backgrounded run — it stays silent (no console
   spam) and exits with one summary line the moment the run finishes, a node errors, the driver goes
   stale, or a node DEAD-stalls (past 10 min — NOT the noisy 45s transient `cp` pause). Both are
   PID-free (driver-death is inferred from run-status staleness), so they work for any run with zero
   wiring. Fleet = one background driver per instance, one `watch.mjs` each. See
   `reference/orchestration.md`. **You run every command; the user runs nothing.**

## The laws (do not violate)
- **Single source of truth = the workflow `.js`.** Improve a wave by editing its prompt/skill in
  the workflow and re-proving on Claude; pi runs the new prompts automatically. Zero hand-sync.
- **The engine files never diverge.** `run.mjs` / `extract.mjs` / `watch.mjs` / `status.mjs` stay
  byte-identical across every repo and this template; 100% of per-repo specifics live in the wiring `.env`, and the credential
  lives once in pi's global `~/.pi/agent/models.json`. A fix is a one-file copy. If you find yourself
  editing an engine file for one repo, you're introducing the drift this whole pattern exists to
  prevent — push it into `.env` (wiring) or `models.json` (credential) instead.
- **Extraction, not codegen.** `extract.mjs` runs the workflow under recording stubs and captures
  the exact prompts + grouping. New/removed/reordered waves propagate for free.
- **Driver owns the graph; pi owns the node.** Plain code decides stage order + parallel lanes +
  halt-on-failure; the model never decides control flow. Nodes coordinate via the filesystem.
- **Verified against the declared contract, not the self-report.** Each node ends with one fenced
  ```json``` block; the driver `stat()`s every `outputArtifact`. But the self-reported list is
  honest only when the model is — so a node may *also* declare, in its prompt, the files it is
  **required** to leave on disk (`DRIVER-ARTIFACTS`) and the only paths it may write
  (`DRIVER-OWNS`). The driver verifies the **required** set independent of the self-report: a clean
  exit that did not produce a required artifact is `blocked`, not `ok`. See **The Output Contract**
  below and `reference/artifact-contract.md`.
- **Every producing node declares an Output Contract.** Requirements live in a skill `description`,
  I/O in `## Inputs`/`## Output` prose, the RETURN shape in `schema` — but Claude validates the
  *message*, never the *filesystem*. The artifact layer is yours: declare it once with a
  `contract({ artifacts, owns })` helper in the workflow `.js` that renders BOTH the
  Definition-of-Done prose AND the `DRIVER-ARTIFACTS`/`DRIVER-OWNS` markers (the generic engine
  parses them — no extractor change, same convention as `DRIVER-PREFLIGHT`). This is the shift-left
  root-cause fix: encode the end-product up front instead of detecting a missing one downstream.
  Full spec + the per-stage-commit/worktree roadmap: `reference/artifact-contract.md`.
- **Headless invariants are non-negotiable.** Close stdin, `--offline`, `--no-extensions` (the `cp`
  provider comes from pi's core `models.json`, which `--no-extensions` does NOT disable), always
  `--debug` while developing (heartbeat + 45s stall flag + node-timeout). A silent headless hang is
  otherwise invisible — this cost a real ~10-minute mystery stall.

## Files in this skill
- `reference/architecture.md` — why the workflow runs unchanged: the four invariants, the
  observability tiers, and the one dynamic-workflow caveat. **Read this to understand the pattern.**
- `reference/artifact-contract.md` — the Output Contract: the fourth contract layer Claude Code
  leaves to the orchestrator (`DRIVER-ARTIFACTS`/`DRIVER-OWNS` markers + the `contract()` helper +
  driver enforcement). **Read this to make a node deliver the right artifact to the right place.**
- `reference/orchestration.md` — Claude-Code-as-console: dry-run → background live → poll
  `run-status.json`, fleet, `--until`, debug vs production. **Read this to operate a run.**
- `reference/provider-and-headless.md` — the native `~/.pi/agent/models.json` credential setup and
  the headless pi invariants/watchdog. **Read this for setup + when a node hangs.**
- `templates/models.json.example` — copy to `~/.pi/agent/models.json` (once per machine): the
  provider + credential pi resolves natively for every project.
- `templates/pi-runner/` — copy this whole folder into a repo **verbatim**. `run.mjs` + `extract.mjs`
  are the generic engine and `watch.mjs` + `status.mjs` the generic monitors (all stay byte-identical);
  `.env` (from `.env.example`) is the only file you fill in — **wiring only, no secret**. `providers/coding-plan.ts` ships only for providers that need
  a custom API impl / OAuth; the OpenAI-compatible case uses `models.json` and no extension.

## Reference implementation
The original, battle-tested instance lives in the `animation-test` repo at `pi-runner/` (the
`lesson-build` workflow → 14 nodes / 10 stages with parallel voice/asset/compose lanes). Its
`run.mjs` / `extract.mjs` are **byte-identical** to these templates — the animation-test instance
was converged onto this generic engine, with its wiring (`PI_RUNNER_CWD=remotion-svg-primitives`,
`PI_RUNNER_WORKFLOW=.claude/workflows/lesson-build.js`) living in its gitignored wiring-only `.env`,
and the credential in the machine-global `~/.pi/agent/models.json`. When in doubt about a detail, that
repo is the worked example; to re-sync after a template fix, `cp` the generic files
(`run.mjs`/`extract.mjs`/`watch.mjs`/`status.mjs`).
