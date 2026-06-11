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
   time so a bare run can't hit a later toolchain wall; its mirror `--from <phase>` (and the
   `--only <phase>` shorthand) RESUMES from a node on its frozen upstream artifacts —
   preflight-gated — so a one-node fix retests in one node, not a full replay.

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

8. **Adopt the Output Contract (recommended — one paste).** Paste `templates/workflow-snippets/contract.js`
   into your workflow `.js` next to `discipline()`, and wrap each producing node's prompt with
   `contract({ artifacts:[…], owns:[…] })`. Now the driver verifies each node's REQUIRED artifacts
   independent of the self-report — a clean exit missing one is `blocked`, not a false `ok`. This is
   already baked into the engine `run.mjs`; the snippet is the only per-workflow edit.
   See `reference/artifact-contract.md`.

9. **Harden for parallel fleets (opt-in — `--worktree`).** For a multi-run fleet, add `--worktree`
   (or `PI_RUNNER_WORKTREE=1`): each run executes in its OWN git worktree (branch `pi/<id>`), so
   concurrent runs are PHYSICALLY isolated — a cheap model cannot see or clobber another run's files.
   Pass the run's input via `--arg`/`--brief` (the worktree is a clean `HEAD` checkout). Merge-back
   is a conflict-free union IF your project doesn't hand-edit a shared registration list — see the
   auto-discovery enabler (`templates/examples/auto-discover-registry.example.mjs`) +
   `reference/worktree-isolation.md`. Also engine-baked; `--worktree` is the only switch.

10. **Arm the escalation gate (opt-in — `PI_RUNNER_ESCALATE=1`).** A cheap model runs every node; on a
    **verified** failure (artifact-contract breach / stuck-loop / timeout / degenerate — never self-
    confidence) the driver consults a stronger, ideally **cross-family** model ONCE, fed the failure
    evidence. Wiring is `.env` only: `PI_RUNNER_ESCALATE_MODEL` (+ optional `PI_RUNNER_ESCALATE_PROVIDER`),
    `PI_RUNNER_MAX_RETRIES`. Pick a cross-family consult — a provider whose cheap default is already its
    top tier has no headroom (DashScope `cp`: `qwen3.7-max` is the ceiling → escalate to `minimax/MiniMax-M3`).
    `DRIVER-NO-ESCALATE` opts a pure gate out. Engine-baked; driver-side, no pi extension. See `reference/escalation.md`.

11. **Tighten the loop with the node-contract extension (opt-in — `PI_RUNNER_CONTRACT_EXT=1`).** Loads
    `extensions/node-contract.ts` via `-e`: a typed `submit_result` tool (structured return — the model
    *calls* it, so it can't botch the ```json fence; the driver reads `result.details` off the
    `tool_execution_end` event, with the fenced-JSON parser as fallback) + an in-loop owned-paths
    `tool_call` block (BLOCKS an out-of-lane `write`/`edit` before it lands, from the node's `DRIVER-OWNS`).
    Per-node tool gating rides the same family: `DRIVER-TOOLS` / `DRIVER-EXCLUDE-TOOLS` markers →
    `--tools`/`--exclude-tools`. Both spike-verified on qwen headless; see `reference/artifact-contract.md`.

12. **Lock the read-scope with an OS sandbox (opt-in — `--sandbox`, macOS).** `--worktree` stops a node
    *writing* outside its lane; it does NOT stop it *reading* a sibling's files (a cheap model that can't
    find a component greps the whole tree + reads other units' source, bloating context). Add `--sandbox`
    (or `PI_RUNNER_SANDBOX=1`): a node that DECLARES its read scope (a `DRIVER-READ-SCOPE:` marker, rendered
    by the same `contract()` family) runs under macOS `sandbox-exec` (Seatbelt), so any read outside
    {toolchain ∪ declared scope} returns `EPERM` — kernel-enforced and inherited by child `grep`/`find`/`cat`.
    Default OFF and byte-identical when off; only a marked node is wrapped. Pair it with the two behavioral
    watchdogs (`PI_RUNNER_STALL_TIMEOUT` silent-death kill, `PI_RUNNER_TOOL_REPEAT_KILL` no-progress
    tool-thrash kill) that catch the degenerate classes the prompt can't. macOS only (a Linux fleet would
    use bubblewrap — not wired). Engine-baked; `sandbox/read-scope.sb` is the profile. See `reference/read-scope-sandbox.md`.

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
- **Physical isolation for fleets is one switch, not a fork.** `--worktree` runs each run in its own
  git worktree (engine-baked, opt-in) — concurrent runs cannot see each other. Its only cost,
  merge-back, is erased by auto-discovered registration (units register by exporting a descriptor
  from their own file, never by hand-editing a shared list). See `reference/worktree-isolation.md`.
- **Prompt rules are unenforceable on weak models — put the boundary in the OS.** `--worktree` isolates
  WRITES; `--sandbox` (macOS Seatbelt, opt-in) isolates READS: a node's `DRIVER-READ-SCOPE` becomes a
  kernel-enforced deny-all-reads-except-{toolchain ∪ scope}, inherited by every child process, so a
  `grep /` or a sibling-source spelunk EPERMs instead of bloating context. The two layers compose
  (Seatbelt matches the symlink TARGET realpath, so the read-scope auto-follows the worktree). Its
  profile must grant the FULL runtime read surface — process cwd, any `-e` extension dir, and the
  realpath TARGET of every workspace-linked dep (`@scope/*` symlinks point OUTSIDE node_modules) — or
  the toolchain EPERMs before the model runs. See `reference/read-scope-sandbox.md`.
- **Hand-roll the orchestration; reach for pi-native only at the interpretation surfaces.** The
  driver's own deterministic plumbing (the DAG, filesystem coordination, artifact `stat()`, worktree)
  is YOURS — pi is minimal by design (no sub-agents, no native typed-return) and *expects* you to own
  it; keep it. Reach for a pi-native mechanism ONLY where the driver must INTERPRET the cheap model's
  free-form output — that is where harness fragility concentrates (the return-block parser was the
  single most-patched surface). pi's purpose-built seams there: `submit_result` (typed return) and the
  `tool_call` block (in-loop owned-paths) — both opt-in via `PI_RUNNER_CONTRACT_EXT`, both keep the
  driver fallback so they never break a run. Escalation, by contrast, needs NO extension: it is a
  per-node `--model`/`--provider` override over signals the driver already computes.

## Files in this skill
- `reference/cli.md` — the COMPLETE, exact CLI: every `run.mjs` flag, the `--from`/`--until`/`--only`
  node-range model + worked examples, the `.env` knobs, the monitors, and the verify-the-model duty.
  **Read this so node ranges + syntax are never guessed.**
- `reference/architecture.md` — why the workflow runs unchanged: the four invariants, the
  observability tiers, and the one dynamic-workflow caveat. **Read this to understand the pattern.**
- `reference/artifact-contract.md` — the Output Contract: the fourth contract layer Claude Code
  leaves to the orchestrator (`DRIVER-ARTIFACTS`/`DRIVER-OWNS` markers + the `contract()` helper +
  driver enforcement). **Read this to make a node deliver the right artifact to the right place.**
- `reference/escalation.md` — the escalation gate (advisor inversion): the empirical classifier, the
  non-blind consult preamble, the `.env` wiring + cross-family target, `DRIVER-NO-ESCALATE`, and the
  Hermes tie-in. **Read this to arm `PI_RUNNER_ESCALATE`.**
- `reference/orchestration.md` — Claude-Code-as-console: dry-run → background live → poll
  `run-status.json`, fleet, `--until`, debug vs production. **Read this to operate a run.**
- `reference/worktree-isolation.md` — the opt-in `--worktree` physical isolation for parallel
  fleets: what it does, the prompt-rewrite, node_modules symlink, status-stays-in-main, and the
  conflict-free merge-back recipe. **Read this before running a fleet with `--worktree`.**
- `reference/read-scope-sandbox.md` — the opt-in `--sandbox` OS read-scope (macOS Seatbelt): the
  `DRIVER-READ-SCOPE` marker, `buildSandboxProfile`'s full-runtime-surface grants (cwd + extension dir +
  linked-package realpath targets), worktree-compatibility, and the two behavioral watchdogs. **Read
  this before running with `--sandbox`.**
- `reference/provider-and-headless.md` — the native `~/.pi/agent/models.json` credential setup and
  the headless pi invariants/watchdog. **Read this for setup + when a node hangs.**
- `templates/models.json.example` — copy to `~/.pi/agent/models.json` (once per machine): the
  provider + credential pi resolves natively for every project.
- `templates/pi-runner/` — copy this whole folder into a repo **verbatim**. `run.mjs` + `extract.mjs`
  are the generic engine and `watch.mjs` + `status.mjs` the generic monitors (all stay byte-identical) —
  the Output Contract verification AND `--worktree` isolation are baked into `run.mjs`, so a project
  gets both just by copying. `.env` (from `.env.example`) is the only file you fill in — **wiring
  only, no secret**. `providers/coding-plan.ts` ships only for providers that need a custom API impl /
  OAuth; the OpenAI-compatible case uses `models.json` and no extension. `extensions/node-contract.ts`
  is the generic opt-in in-loop layer (typed `submit_result` + owned-paths block), armed via
  `PI_RUNNER_CONTRACT_EXT`; the escalation gate is engine-baked, armed via `PI_RUNNER_ESCALATE`.
- `templates/workflow-snippets/contract.js` — the `contract()` helper to paste into your workflow
  `.js` (the only per-workflow edit to adopt the Output Contract).
- `templates/examples/auto-discover-registry.example.mjs` — adapt-me generator for auto-discovered
  registration (the worktree merge-back enabler — stop hand-editing a shared registration list).

## Reference implementation
The original, battle-tested instance lives in the `animation-test` repo at `pi-runner/` (the
`lesson-build` workflow → 14 nodes / 10 stages with parallel voice/asset/compose lanes). Its
`run.mjs` / `extract.mjs` are **byte-identical** to these templates — the animation-test instance
was converged onto this generic engine, with its wiring (`PI_RUNNER_CWD=remotion-svg-primitives`,
`PI_RUNNER_WORKFLOW=.claude/workflows/lesson-build.js`) living in its gitignored wiring-only `.env`,
and the credential in the machine-global `~/.pi/agent/models.json`. When in doubt about a detail, that
repo is the worked example; to re-sync after a template fix, `cp` the generic files
(`run.mjs`/`extract.mjs`/`watch.mjs`/`status.mjs`).
