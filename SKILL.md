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
   manual merge. The copy also brings `viz-model.mjs` + `tui/` (the `pi-tui` cross-project monitor,
   step 7). **At adoption, register the folder as a namespace once — `pi-tui add .`** — so it appears in
   the global `pi-tui` console before its first run; every run thereafter self-registers too.

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

   **Across all projects — `pi-tui`.** `status.mjs`/`watch.mjs` watch ONE run; `pi-tui` is the standing
   global console. Every run auto-registers its folder as a *namespace* in `~/.pi-runner/registry.json`,
   so a bare `pi-tui` (installed once: `cd pi-runner/tui && npm install && npm link`) lists every project
   and its live runs with no flags — drill in to namespace → thread (run) → per-node detail (status ·
   time · tokens · gantt · artifacts · live output). `pi-tui add .` registers a folder before its first
   run; `PI_RUNNER_NO_REGISTER=1` opts out. See `pi-runner/tui/README.md`.

8. **Adopt the Output Contract (recommended — one paste).** Paste `templates/workflow-snippets/contract.js`
   into your workflow `.js` next to `discipline()`, and wrap each producing node's prompt with
   `contract({ artifacts:[…], owns:[…], readScope:[…] })`. Now the driver verifies each node's REQUIRED
   artifacts independent of the self-report — a clean exit missing one is `blocked`, not a false `ok` —
   and (under `--sandbox`, step 12) the `readScope` becomes the node's OS-enforced read boundary.
   Declare `readScope` on **every** producing node at the same time as `artifacts`/`owns` (it is part of
   authoring a node, not a later bolt-on). This is already baked into the engine `run.mjs`; the snippet
   is the only per-workflow edit. See `reference/artifact-contract.md`.

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
    **Tool-gating doubles as a cheap-model BEHAVIOR LOCK, not only a write-safety rail.** When prompt-craft
    alone won't move a weak executor, cut its tools to FORCE the action shape: a cheap model fills a fresh
    structured artifact far more reliably by whole-file `write` than by exact-match `edit`, so EXCLUDING
    `edit`/read-chain tools until `write` is the only affordance is what finally made MiniMax WRITE a complete
    `blueprint.json` instead of composing it in-head and returning it inline (two prompt-only redesigns had
    failed first). Choose the gated set by the action you must FORCE, not only the writes you must forbid —
    `DRIVER-EXCLUDE-TOOLS` is a structural lever (same family as the owned-paths block), and a structural
    invariant belongs in the harness, not in more prose the model can ignore.

12. **Lock the read-scope — standard per-node, OS-enforced under `--sandbox` (macOS).** `--worktree`
    stops a node *writing* outside its lane; it does NOT stop it *reading* a sibling's files (a cheap
    model that can't find a component greps the whole tree + reads other units' source, bloating context
    until it times out). The fix is two parts. **(a) Author-time, always:** declare a `readScope` on
    EVERY producing node's `contract({…})` — the same tier as `artifacts`/`owns` — so each node's prompt
    carries a `DRIVER-READ-SCOPE:` marker naming its legitimate read surface (its own data/out dirs + the
    shared skills/catalog it reads). Leaving a node un-scoped is the bug this prevents (in the reference
    workflow, only the composer was scoped, so a cheap model read-thrashed an un-scoped node to a
    timeout). **(b) Fleet-time, opt-in:** run with `--sandbox` (or `PI_RUNNER_SANDBOX=1`) so a scoped
    node runs under macOS `sandbox-exec` (Seatbelt) and any read outside {toolchain ∪ declared scope}
    returns `EPERM` — kernel-enforced and inherited by child `grep`/`find`/`cat`. Default OFF and
    byte-identical when off (the markers are inert text); only a marked node is wrapped. Pair it with the
    two behavioral watchdogs (`PI_RUNNER_STALL_TIMEOUT` silent-death kill, `PI_RUNNER_TOOL_REPEAT_KILL`
    no-progress tool-thrash kill) that catch the degenerate classes the prompt can't. macOS only (a Linux
    fleet would use bubblewrap — not wired). Engine-baked; `sandbox/read-scope.sb` is the profile. See
    `reference/read-scope-sandbox.md`.

13. **Seed the per-node output-criteria fixture (the judging standard).** Creating a workflow's harness includes creating its **acceptance-criteria fixture** alongside the skill-system map — `<repo>/.agents/skill-system-criteria.md`, ONE entry per producing node (artifact → downstream purpose → acceptance criteria → red flags). The node set is exactly what `extract.mjs` already enumerates, so draft it with a per-node criteria-drafting workflow (one agent per node reads that node's skill + a real sample artifact + the brief, returns a structured `{purpose, criteria, redFlags}`) and write the returned entries to the fixture. This is the human-judged quality bar every future run is judged against — the complement to the mechanical Output Contract (existence/lane) and the sibling of the skill-system map (composition/diagnostics). It is a **JUDGING fixture, NEVER injected into a node's prompt** (that teaches-to-the-test and voids the clean-room signal that tells you whether the SKILL ITSELF produces good output). The `hermes-skill-system` loop then MAINTAINS it (sharpens a node's criteria whenever an edit changes what good output for that node means); edit it by hand too, whenever you decide a node should emit a different/richer shape.

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
- **The workflow orchestrates; the SKILL carries the craft — never duplicate craft into a node body.**
  When a node loads a skill (`SKILL TO LOAD AND FOLLOW: …`), split content by OWNER. The workflow `.js`
  holds ORCHESTRATION ONLY: the node sequence + parallel lanes (the DAG), each node's I/O contract
  (`contract({artifacts,owns,readScope})` + the return `schema`), and a THIN wiring body — who the node is ·
  which input artifacts it reads · which output it writes · the load-and-follow pointer. The CRAFT — *how* to
  do the work: the method, the bar, the build path, the domain detail — lives ONLY in the skill, its single
  canonical home. A node body that RESTATES the skill's craft is two ground truths: every craft edit then needs
  two edits and they drift (the dual-maintenance trap). So put all craft in the skill, keep the body a pointer,
  and **improve a wave by editing its SKILL / improve the chain by editing the workflow.** Extraction is
  unchanged — the realized prompt is still the (thin) body, and the model reads the loaded skill at runtime;
  only WHERE the craft text lives collapses to one home. (Inline-prompt nodes with no backing skill are exempt —
  there the body IS the only home; this law governs the skill-backed pattern.)
- **Verified against the declared contract, not the self-report.** Each node ends with one fenced
  ```json``` block; the driver `stat()`s every `outputArtifact`. But the self-reported list is
  honest only when the model is — so a node may *also* declare, in its prompt, the files it is
  **required** to leave on disk (`DRIVER-ARTIFACTS`) and the only paths it may write
  (`DRIVER-OWNS`). The driver verifies the **required** set independent of the self-report: a clean
  exit that did not produce a required artifact is `blocked`, not `ok`. See **The Output Contract**
  below and `reference/artifact-contract.md`.
- **Every producing node declares an Output Contract — `{ artifacts, owns, readScope }`.**
  Requirements live in a skill `description`, I/O in `## Inputs`/`## Output` prose, the RETURN shape in
  `schema` — but Claude validates the *message*, never the *filesystem*. The artifact layer is yours:
  declare it once with a `contract({ artifacts, owns, readScope })` helper in the workflow `.js` that
  renders the Definition-of-Done prose AND the `DRIVER-ARTIFACTS`/`DRIVER-OWNS`/`DRIVER-READ-SCOPE`
  markers (the generic engine parses them — no extractor change, same convention as `DRIVER-PREFLIGHT`).
  The **write-contract** (`artifacts`/`owns`) and the **read-scope** (`readScope`) are the SAME tier —
  both authored at node creation time, never an afterthought. This is the shift-left root-cause fix:
  encode the end-product AND the legitimate read surface up front instead of detecting a breach
  downstream. Run the fleet under `--sandbox` so `readScope` is OS-enforced (inert otherwise). Full
  spec: `reference/artifact-contract.md`; read-scope syntax: `reference/read-scope-sandbox.md`.
- **A workflow ships with its criteria fixture.** Standing up a workflow creates
  `<repo>/.agents/skill-system-criteria.md` — the per-node, human-judged QUALITY bar (sibling of the
  skill-system map, complement to the mechanical Output Contract: the contract checks the artifact
  *exists*, the criteria say whether it is *good*). It is the standard runs are judged against to
  converge on quality, and the improvement target sharpened each run. It is **never injected into a
  node's prompt** (that would teach-to-the-test and void the clean-room signal), and the
  `hermes-skill-system` loop maintains it (step 13 above; that skill's INIT seeds it, OPERATE evolves it).
- **Headless invariants are non-negotiable.** Close stdin, `--offline`, `--no-extensions` (the `cp`
  provider comes from pi's core `models.json`, which `--no-extensions` does NOT disable), always
  `--debug` while developing (heartbeat + 45s stall flag + node-timeout). A silent headless hang is
  otherwise invisible — this cost a real ~10-minute mystery stall.
- **Physical isolation for fleets is one switch, not a fork.** `--worktree` runs each run in its own
  git worktree (engine-baked, opt-in) — concurrent runs cannot see each other. Its only cost,
  merge-back, is erased by auto-discovered registration (units register by exporting a descriptor
  from their own file, never by hand-editing a shared list). See `reference/worktree-isolation.md`.
- **Prompt rules are unenforceable on weak models — put the boundary in the OS.** `--worktree` isolates
  WRITES; `--sandbox` (macOS Seatbelt, opt-in) isolates READS: **every producing node declares a
  `readScope` in its `contract()`** (the read tier of the write-contract), and under `--sandbox` that
  `DRIVER-READ-SCOPE` becomes a kernel-enforced deny-all-reads-except-{toolchain ∪ scope}, inherited by
  every child process, so a `grep /` or a sibling-source spelunk EPERMs instead of bloating context. A
  node left un-scoped is a hole (the cheap-model read-thrash this fixes). The two layers compose
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
- **Every run announces its namespace.** A folder that adopts the harness IS a *namespace*; `run.mjs`
  upserts it into `~/.pi-runner/registry.json` on every run (opt out `PI_RUNNER_NO_REGISTER=1`), and the
  global `pi-tui` reads that registry so ONE command surveys every project's live runs. It is pure
  reconstruction over data already on disk — the DAG from the `.js` ⋈ `run-status.json`, joined on node
  `id` — so it adds NO new per-run field: the same "measure, don't duplicate" discipline as the digest.
- **A verify node verifies; it never CREATES a key artifact.** Separate the roles: a PRODUCING node authors
  each key artifact the flow binds to; a VERIFY node judges that artifact and may run a bounded inner self-fix
  to *stabilize* it — but it is NEVER the primary creator. The test: **remove the verify node entirely and the
  producing flow must still yield every key artifact.** A verify node that ALSO produces the load-bearing
  artifact (e.g. a design gate that *authors* the frozen spec it also grades) is the conflation this law
  forbids — it makes the node un-removable, re-introduces "the student grades its own homework," and breaks
  the mode toggle below. Split it: a producer makes the artifact, the verifier judges it. (The bounded
  stabilize-edit a verifier may apply mirrors a QA node's `src/**` self-fix — editing-to-stabilize an artifact
  a PRODUCER created, never authoring one from nothing.)
- **An output edit is not done until its CONSUMERS are reconciled — keep a node I/O map.** A node's output
  artifact is an INTERFACE other nodes read. Change what a node writes — its format, shape, filename, or
  fields — and you silently break every downstream node still reading the old shape (moving a design doc from
  `gdd.json` to `gdd.md` orphans every node that opened `gdd.json`). So every node-output edit has a mandatory
  second half: **find every consumer of that artifact and reconcile it** (re-point the read, update the parse,
  migrate the field), then verify a `grep` for the old shape returns only history. This is the
  producer/consumer twin of "verified against the declared contract": the `contract()` says what a node
  WRITES; the **node I/O map** (a standing artifact — see *Designing a node's I/O* below) says who READS it,
  so the reconcile is one glance, not grep-and-pray. **Every node/subagent edit checks in there FIRST.**

## Companion Mode (dev-time) — the orchestrator IS the verification node
A workflow ships with both an automated in-pipeline VERIFICATION surface (the verify nodes) AND the
human-judged criteria fixture (step 13). Production runs the verify nodes for stable, unattended output. But
during development/debugging — when you're babysitting the run — they're slow, and you (orchestrator + human)
judge better. Companion Mode makes the orchestrator the standing verifier:
- **One static toggle, two clean DAGs.** Branch the workflow on a `mode` INPUT arg
  (`const COMPANION = (args.mode === 'companion')`) and wrap every verify node `if (!COMPANION)`. Because
  `mode` is a static input (resolved BEFORE any node runs), `extract.mjs`/`run.mjs` realize a FIXED DAG per
  mode — NOT the result-dependent branching the extractor can't see. `production` (default) = full pipeline;
  `companion` = producing nodes only.
- **This only works because verify nodes create nothing (the law above).** Drop them and every key artifact
  still exists, because PRODUCERS made them. If a verify node is also a producer you could not drop it — split
  it FIRST, then add the toggle.
- **Run in the background; judge every stage as it lands.** Poll `run-status.json`; the moment a node goes
  `ok`, compare its artifact to (a) the GOLD sample and (b) its criteria-fixture entry — the same dual
  reference the `hermes-skill-system` node-validation loop uses (criteria stay a JUDGING reference, NEVER
  injected). You are the verifier for EVERY surface the skipped nodes would have covered.
- **On a heavy mistake, stop** — don't pour effort onto a bad upstream artifact. Fix at the canonical owner
  (Hermes), rerun the SUFFIX fixed by the first changed node (`--from`/`--only`), reuse unchanged upstream.
  Borderline → surface to the human (the eye), don't guess. Promote a fresh artifact over the gold when it's
  better (this is also how the gold + criteria get sharpened each run).
A dev-time POSTURE, not a code path beyond the one `mode` branch. Pairs with the criteria fixture (step 13)
and `hermes-skill-system`'s node-validation loop.

## Designing a node's I/O — the standards + the I/O map
Designing a workflow IS setting each node's input/output standards — this is the most meaningful place to fix
them, and where an edit must be reconciled against the rest. For every node:
- **One node, one task**, so its I/O is a clean boundary; split a two-job node. **A producer creates each key
  artifact; a verifier never does** (the verify-node law above).
- **Format the output for its CONSUMER, not by default.** Strict typed JSON ONLY at a machine boundary (a
  parser / schema / the driver). PROSE/Markdown for an LLM-reasoning hand-off (a *middle product* the next
  model THINKS over): reason-in-prose, structure LAST — strict JSON on a reasoning hand-off taxes reasoning
  ~5–15% and ~35% tokens, worst on cheap models, and inverts CoT when a decision field precedes its rationale.
  Push the schema boundary as LATE as possible; keep a small fenced-JSON tail only for the fields a parser
  reads. Merge/denormalize for a single downstream reasoner; split only for parallel agents. (Full
  prompt-craft + citations: `agentic-prompt-design` §5.)
- **Declare two things at node-creation time:** the `contract({ artifacts, owns, readScope })` (what it WRITES
  + its read surface) AND the artifact's CONSUMERS in the I/O map.
- **Split MECHANICAL from INTELLIGENT, then push the mechanical into a DRIVER HOOK — don't leave it to the model.**
  List the node's steps; for each ask: *"is this output a fixed function of already-frozen on-disk inputs, with no
  judgment?"* **YES → a deterministic driver hook**, run in the driver, not the model — so it becomes a TESTED CODE
  PATH, not a per-run gamble. Two verbs, one family: a **PRE-hook (`DRIVER-SEED`, the proven one)** STAGES inputs
  before the model (copy a skeleton/tree → FILL-don't-COMPOSE); a **POST-hook (`DRIVER-PROJECT`/`DRIVER-MERGE`, its
  derive-don't-recompute sibling)** DERIVES/validates outputs after the model (project a frozen spec → its runtime
  data file, merge fragments, schema-check). **NO** (design reasoning / open-ended coding / prose authoring /
  diagnose-and-fix) **→ the model.** Declare the deterministic part as DATA in the registry (next to the routing
  facts), so the engine stays uniform + genre-agnostic and adding a type needs ZERO node-prompt and ZERO engine
  edit. Aim the model's residual to be WRITE-DOMINANT + health-checkable (the write-first gate + a build/validate
  signal cover it). *Why:* it removes the cheap-model explore-forever / mis-project thrash surface, makes mechanical
  output un-hallucinatable, and cuts tokens — a structural invariant belongs in the harness, not in prose the model
  can ignore. Hook spec + the `DRIVER-SEED`/contract markers: `reference/artifact-contract.md`.
- **Design for parallelism from the I/O up — the map is where independent lanes become visible.** As you set
  each node's I/O, look for nodes whose inputs are ALL already-frozen upstream artifacts and whose `owns` set is
  DISJOINT from a sibling's — those are independent **lanes** that need not wait on each other, so run them as a
  `parallel([laneA, laneB])` for wall-clock. The **correctness rule is write-disjoint `owns`**: two concurrent
  lanes must share NO writable file (the `parallel()` collapses to one extractor stage and `run.mjs` runs them
  via `Promise.all` — a real race). If a "dependency" is only that lane B reads an artifact lane A *also*
  produces, check whether B can read the SAME upstream source instead (re-pointing the read dissolves the
  artificial edge). When two lanes would BOTH touch one shared file, don't serialize the whole lane — split that
  file: give each lane its own per-node fragment and add a tiny SERIAL JOIN node after the parallel stage to
  merge them deterministically (e.g. `MEMORY.<node>.md` fragments → a merged `MEMORY.md`; an asset lane's own
  manifest → reconciled into the build lane's index). The shared-write becomes one serial node, not a serial
  pipeline. (The script has no fs at eval time, so the join is a NODE, never raw fs in the workflow.)

**The node I/O map** — `<repo>/.agents/skill-system-io-map.md`, the THIRD standing artifact beside the
skill-system map (composition) and the criteria fixture (quality). It is the producer→consumer ledger keyed by
ARTIFACT: for each on-disk artifact, which node PRODUCES it, which nodes CONSUME it, and HOW (strict parse vs
LLM read — because *that* is a format change's blast radius). It is the interface contract of a
filesystem-coordinated pipeline, and the lookup that makes the reconcile-consumers law cheap: before changing a
node's output, read the artifact's consumer row and reconcile every one; after, verify no consumer reads the
stale shape. Derive it once from the node read-lines; update it on the SAME trigger as the map (any change to a
node's read/write set). When an agent edits a node or its skill, it CHECKS IN here, fixes the downstream
consumers the change affects, and reconciles with the upstream artifacts it reads — so a format change can
never leave a dangling consumer (the class of bug where W1 moved to `gdd.md` and its readers still opened
`gdd.json`).

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
- `templates/pi-runner/viz-model.mjs` + `templates/pi-runner/tui/` — the **`pi-tui` monitor**: a
  renderer-agnostic data layer (the DAG from the `.js` ⋈ `run-status.json`, joined on node `id`) and an
  Ink TUI over it. Install once (`cd templates/pi-runner/tui && npm install && npm link`); then a bare
  `pi-tui` shows every registered namespace → its threads (runs) → per-node detail (status · time ·
  tokens · gantt · artifacts · live output), live. Runs self-register (`run.mjs` → `~/.pi-runner/registry.json`);
  `pi-tui add|rm|ls` manage it. **Read `templates/pi-runner/tui/README.md` to install + operate the console.**
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
