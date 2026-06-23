---
name: transform-workflow-to-pi
description: >-
  Take any Claude Code Workflow (a `.claude/workflows/*.js` script that uses agent()/parallel()/
  pipeline()/phase()) and run the IDENTICAL pipeline efficiently on a fleet of pi agents
  (pi.dev / earendil-works/pi) driven by non-Claude coding-plan models — with Claude Code as the
  single console and monitor. The generic engine ships as the `@piflow/core` SDK; a project installs it
  and drops in a thin consumer (`templates/pi-runner/`) that wires its workflow + deterministic hooks into
  `runWorkflow`, then monitors with `piflow logs`. Use when someone wants to run a proven Workflow at
  lower cost / at scale, "run my workflow on pi", "run this on a non-Claude model", "pi-runner", "offload
  the workflow to more efficient agents", or to stand up the pi-runner harness in a new repo.
---

# Transform a Claude Code Workflow → pi agents

**One-line model:** the Claude Code Workflow `.js` is the single source of truth; the **`@piflow/core` SDK**
*extracts* the exact realized prompts + DAG from that same file and replays them, one efficient `pi` process
per node, while Claude Code owns the graph and monitors the run. **No port, no codegen, no hand-sync, no
drift.**

```
Claude Code (you) ── 1 driver per instance ─► pi-runner/sdk/run.mjs
                                               │ config → bridge → compile → runWorkflow  (@piflow/core)
                                               │ extract.mjs runs workflow.js under recording stubs
                                               │ → exact prompts + parallel lanes + per-node hooks
                                               ▼  one `pi` per node (non-Claude coding-plan model)
        <repo>/* artifacts + run-status.json (state) + _pi/<id>.events.jsonl (behavior) ─► `piflow logs`
```

## When this applies
- You have a Workflow you've **already proven on Claude** (it runs via the `Workflow` tool) and
  want to run it efficiently / at scale.
- The workflow is **pipeline-shaped**: a fixed set of waves over one input, coordinating through
  the filesystem. (Data-driven fan-out needs one extra step — see `reference/architecture.md`
  "Dynamic workflows".)
- You want Claude Code to stay the operator: it runs everything, the user runs nothing.

If there is **no** workflow yet, write and prove one with the `Workflow` tool first. This skill
transforms an existing workflow; it does not author the pipeline logic.

## The transform — adopt the SDK consumer
The engine is the **`@piflow/core`** package; a project does NOT copy an engine, it installs the package and
drops in a thin consumer. **The canonical per-project layout, the file→mission map, and the full adopt steps
are in `reference/sdk-consumer.md` — read it first.** The flow:

1. **Confirm the source of truth.** Exactly one `.claude/workflows/<name>.js`; it begins with
   `export const meta = {…}` (a pure literal); its body uses only the Workflow hooks
   (`agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`). You **edit and prove the workflow on
   Claude**; pi inherits it. Never edit pi's copy of a prompt — there is no copy.

2. **Set the credential ONCE in pi's global config** (per machine, not per repo). The model + key live in
   pi's native `~/.pi/agent/models.json`, which pi resolves for EVERY project — so no product needs its own
   key or `.env` credential. `cp templates/models.json.example ~/.pi/agent/models.json`, edit
   `apiKey`/`baseUrl`/model ids, `chmod 600`, verify `pi --list-models cp`. See `reference/provider-and-headless.md`.

3. **Install `@piflow/core` + drop in `templates/pi-runner/`.** Copy the folder next to `.claude/`, set the
   `@piflow/core` dependency in `pi-runner/package.json` (a `file:` path to the skill's `packages/core`, a
   workspace dep, or the published package), and `npm install`. The `sdk/` glue + `hooks/` op engine are the
   **byte-identical generic consumer** — you edit none of them; per-repo specifics live in `.env` +
   `package.json` + your `hooks/`. See `reference/sdk-consumer.md`.

4. **Configure the per-repo wiring `.env`** (wiring only, no secret). `cp .env.example pi-runner/.env`; set
   `PI_RUNNER_WORKFLOW` (the `.js` path, repo-root relative), `PI_RUNNER_ROOT` if `pi-runner/`'s parent isn't
   the repo root, and `PI_RUNNER_PROVIDER`/`PI_RUNNER_MODEL` (or leave the provider default). Optional:
   `PI_RUNNER_NODE_TIMEOUT`, `PI_RUNNER_STALL_TIMEOUT`, `PI_RUNNER_THINKING`, `PI_RUNNER_CONTRACT_EXT`.

5. **Author / keep your `hooks/`.** The shipped generic op engine covers the standard
   `DRIVER-SEED`/`PROJECT`/`MERGE`/`SEED-CONTRACT` families; a new deterministic op is one
   `hooks/<op>.mjs` (parser + executor) + a binding in `sdk/hook-bindings.mjs`. The full pre/post
   hook-assembly contract (DRIVER-\* marker → `@piflow/core` `Hook` → `hooks/` executor → `runHooks`) is in
   `reference/sdk-consumer.md`; the marker grammar in `reference/artifact-contract.md`.

6. **Dry-run (free, no model), then live (background).**
   ```bash
   node pi-runner/sdk/run.mjs --run <id> --arg <k=v> --until <phase> --dry-run   # stages + per-node tools/hooks + pi cmd
   node pi-runner/sdk/run.mjs --run <id> --arg <k=v> --until <phase>             # live; run in background
   ```
   The dry-run prints the stage/node count, each node's `[tools: …] [hooks: …]`, the resolved `pi` command,
   and a `⚠ TOOL BINDING` on any un-tokenized allow/deny entry. Pass `args` with `--arg k=v` (repeatable) /
   `--arg-file k=path`; `--until`/`--from`/`--only` window a long pipeline. See `reference/cli.md`.

7. **Monitor as the console.** Every run writes `run-status.json` (state) + `_pi/<id>.events.jsonl`
   (behavior); `piflow logs` reads both:
   ```bash
   node pi-runner/logs.mjs <run> -f          # live follow — one line per action, per node
   node pi-runner/logs.mjs <run> --summary   # post-run diagnosis (verdict + why; never-write / timeout / stall)
   node pi-runner/logs.mjs <run> --node <id> # one node (replay if done, live if running); add --raw for the firehose
   ```
   Full surface + the failure-signature table: `reference/observability.md`. **You run every command; the
   user runs nothing.**

**Opt-in hardening (each is one switch + its reference — read before arming):**
- **Output Contract** — wrap each producing node with `contract({ artifacts, owns, readScope })`
  (`templates/workflow-snippets/contract.js`) so the driver verifies REQUIRED artifacts independent of the
  self-report. The read-scope is authored at the SAME time as the writes. `reference/artifact-contract.md`.
- **Write isolation for fleets** — `WorktreeSandboxProvider` (`--worktree`): each run in its own git
  worktree. `reference/worktree-isolation.md`.
- **OS read-scope** — `SeatbeltSandboxProvider` (`--sandbox`, macOS): a node's `readScope` becomes a
  kernel-enforced deny-all-reads-except. `reference/read-scope-sandbox.md`.
- **Escalation gate** — on a *verified* failure, consult a stronger cross-family model once
  (`reference/escalation.md`; engine-baked in the monolith, consumer-side + deferred under the SDK).
- **The criteria fixture** — standing up a workflow seeds `<repo>/.agents/skill-system-criteria.md`, the
  per-node human-judged quality bar (NEVER injected into a prompt). Maintained by `hermes-skill-system`.

## The laws (do not violate)
- **Single source of truth = the workflow `.js`.** Improve a wave by editing its prompt/skill in
  the workflow and re-proving on Claude; pi runs the new prompts automatically. Zero hand-sync.
- **The engine is the `@piflow/core` package, not a per-repo copy.** The generic consumer glue
  (`sdk/`, `hooks/`, `extract.mjs`, `logs.mjs`) stays **byte-identical across repos** — 100% of per-repo
  specifics live in `.env` + `package.json` (wiring) + your `hooks/` (your ops), and the credential lives
  once in pi's global `~/.pi/agent/models.json`. An engine fix is a **package bump**, not a manual merge; a
  glue fix is a one-file copy. If you find yourself editing the consumer glue for one repo, you're
  re-introducing the drift this whole pattern exists to prevent — push it into `.env`/`package.json`/`hooks/`
  instead. (The Tier-2 glue still ships in the template only because `@piflow/core` has named gaps; it is
  slated to graduate into the package — see `reference/sdk-consumer.md`.)
- **Extraction, not codegen.** `extract.mjs` runs the workflow under recording stubs and captures
  the exact prompts + grouping; `bridge.mjs` maps that to a compilable `WorkflowSpec`. New/removed/reordered
  waves propagate for free.
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
  and `reference/artifact-contract.md`.
- **Every producing node declares an Output Contract — `{ artifacts, owns, readScope }`.**
  Requirements live in a skill `description`, I/O in `## Inputs`/`## Output` prose, the RETURN shape in
  `schema` — but Claude validates the *message*, never the *filesystem*. The artifact layer is yours:
  declare it once with a `contract({ artifacts, owns, readScope })` helper in the workflow `.js` that
  renders the Definition-of-Done prose AND the `DRIVER-ARTIFACTS`/`DRIVER-OWNS`/`DRIVER-READ-SCOPE`
  markers (the generic codec in `@piflow/core` parses them). The **write-contract** (`artifacts`/`owns`)
  and the **read-scope** (`readScope`) are the SAME tier — both authored at node creation time, never an
  afterthought. Run the fleet under `SeatbeltSandboxProvider` so `readScope` is OS-enforced (inert otherwise).
  Full spec: `reference/artifact-contract.md`; read-scope syntax: `reference/read-scope-sandbox.md`.
- **A workflow ships with its criteria fixture.** Standing up a workflow creates
  `<repo>/.agents/skill-system-criteria.md` — the per-node, human-judged QUALITY bar (sibling of the
  skill-system map, complement to the mechanical Output Contract: the contract checks the artifact
  *exists*, the criteria say whether it is *good*). It is the standard runs are judged against to
  converge on quality, and the improvement target sharpened each run. It is **never injected into a
  node's prompt** (that would teach-to-the-test and void the clean-room signal), and the
  `hermes-skill-system` loop maintains it.
- **Headless invariants are non-negotiable.** Close stdin, `--offline`, `--no-extensions` (the `cp`
  provider comes from pi's core `models.json`, which `--no-extensions` does NOT disable), capture each node's
  event stream (`recordEvents`, on by default) so a silent headless hang is visible. A silent hang is
  otherwise invisible — this cost a real ~10-minute mystery stall, and a multi-session "never-write" mystery
  (`reference/observability.md` case study).
- **Physical isolation for fleets is one provider, not a fork.** `WorktreeSandboxProvider` runs each run in
  its own git worktree — concurrent runs cannot see each other. Its only cost, merge-back, is erased by
  auto-discovered registration (units register by exporting a descriptor from their own file, never by
  hand-editing a shared list). See `reference/worktree-isolation.md`.
- **Prompt rules are unenforceable on weak models — put the boundary in the OS.** Worktree isolates
  WRITES; `SeatbeltSandboxProvider` (macOS, opt-in) isolates READS: **every producing node declares a
  `readScope` in its `contract()`**, and under the sandbox that `DRIVER-READ-SCOPE` becomes a kernel-enforced
  deny-all-reads-except-{toolchain ∪ scope}, inherited by every child process, so a `grep /` or a
  sibling-source spelunk EPERMs instead of bloating context. A node left un-scoped is a hole. See
  `reference/read-scope-sandbox.md`.
- **Hand-roll the orchestration; reach for pi-native only at the interpretation surfaces.** The
  driver's own deterministic plumbing (the DAG, filesystem coordination, artifact `stat()`, worktree)
  is YOURS — pi is minimal by design (no sub-agents, no native typed-return) and *expects* you to own
  it. Reach for a pi-native mechanism ONLY where the driver must INTERPRET the non-Claude model's
  free-form output — that is where harness fragility concentrates (the return-block parser was the
  single most-patched surface). pi's purpose-built seams there: `submit_result` (typed return) and the
  `tool_call` block (in-loop owned-paths) — both opt-in via the `extensions/node-contract.ts` `-e`
  (`PI_RUNNER_CONTRACT_EXT`), both keep the driver fallback so they never break a run.
- **Every run records its behavior — state + behavior, two files, one join.** A run writes
  `run-status.json` (per-node status/exit/timing/artifacts — the *verdict*) and `_pi/<id>.events.jsonl`
  (the slimmed `pi --mode json` stream — *what the model did*), joined on node id. `piflow logs` reads both
  (`-f` live · `--summary` diagnosis · `--node`). It is pure reconstruction over data already on disk — no new
  per-run field. This is the SDK successor to the legacy `pi-tui` registry survey. See `reference/observability.md`.
- **A verify node verifies; it never CREATES a key artifact.** Separate the roles: a PRODUCING node authors
  each key artifact the flow binds to; a VERIFY node judges that artifact and may run a bounded inner self-fix
  to *stabilize* it — but it is NEVER the primary creator. The test: **remove the verify node entirely and the
  producing flow must still yield every key artifact.** A verify node that ALSO produces the load-bearing
  artifact is the conflation this law forbids — it makes the node un-removable, re-introduces "the student
  grades its own homework," and breaks the mode toggle below. Split it: a producer makes the artifact, the
  verifier judges it.
- **An output edit is not done until its CONSUMERS are reconciled — keep a node I/O map.** A node's output
  artifact is an INTERFACE other nodes read. Change what a node writes — its format, shape, filename, or
  fields — and you silently break every downstream node still reading the old shape (moving a design doc from
  `gdd.json` to `gdd.md` orphans every node that opened `gdd.json`). So every node-output edit has a mandatory
  second half: **find every consumer of that artifact and reconcile it** (re-point the read, update the parse,
  migrate the field), then verify a `grep` for the old shape returns only history. The `contract()` says what a
  node WRITES; the **node I/O map** (see *Designing a node's I/O* below) says who READS it. **Every
  node/subagent edit checks in there FIRST.**

## Companion Mode (dev-time) — the orchestrator IS the verification node
A workflow ships with both an automated in-pipeline VERIFICATION surface (the verify nodes) AND the
human-judged criteria fixture. Production runs the verify nodes for stable, unattended output. But
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
A dev-time POSTURE, not a code path beyond the one `mode` branch. Pairs with the criteria fixture
and `hermes-skill-system`'s node-validation loop.

## Designing a node's I/O — the standards + the I/O map
Designing a workflow IS setting each node's input/output standards — this is the most meaningful place to fix
them, and where an edit must be reconciled against the rest. For every node:
- **One node, one task**, so its I/O is a clean boundary; split a two-job node. **A producer creates each key
  artifact; a verifier never does** (the verify-node law above).
- **Format the output for its CONSUMER, not by default.** Strict typed JSON ONLY at a machine boundary (a
  parser / schema / the driver). PROSE/Markdown for an LLM-reasoning hand-off (a *middle product* the next
  model THINKS over): reason-in-prose, structure LAST — strict JSON on a reasoning hand-off taxes reasoning
  ~5–15% and ~35% tokens, worst on non-Claude models, and inverts CoT when a decision field precedes its rationale.
  Push the schema boundary as LATE as possible; keep a small fenced-JSON tail only for the fields a parser
  reads. Merge/denormalize for a single downstream reasoner; split only for parallel agents. (Full
  prompt-craft + citations: `agentic-prompt-design` §5.)
- **Declare two things at node-creation time:** the `contract({ artifacts, owns, readScope })` (what it WRITES
  + its read surface) AND the artifact's CONSUMERS in the I/O map.
- **Split MECHANICAL from INTELLIGENT, then push the mechanical into a DRIVER HOOK — don't leave it to the model.**
  List the node's steps; for each ask: *"is this output a fixed function of already-frozen on-disk inputs, with no
  judgment?"* **YES → a deterministic driver hook** (a `Hook` in `hooks/`, run by `runHooks`, not the model) — so
  it becomes a TESTED CODE PATH, not a per-run gamble. Two verbs, one family: a **PRE-hook (`DRIVER-SEED`)** STAGES
  inputs before the model (copy a skeleton/tree → FILL-don't-COMPOSE); a **POST-hook
  (`DRIVER-PROJECT`/`DRIVER-MERGE`)** DERIVES/validates outputs after the model (project a frozen spec → its
  runtime data file, merge fragments, schema-check). **NO** (design reasoning / open-ended coding / prose
  authoring / diagnose-and-fix) **→ the model.** Declare the deterministic part as DATA in the registry, so the
  engine stays uniform + genre-agnostic. *Why:* it removes the non-Claude-model explore-forever / mis-project
  thrash surface, makes mechanical output un-hallucinatable, and cuts tokens. The hook envelope + the
  DRIVER-marker → `Hook` assembly: `reference/sdk-consumer.md`; the marker spec: `reference/artifact-contract.md`.
- **Design for parallelism from the I/O up — the map is where independent lanes become visible.** As you set
  each node's I/O, look for nodes whose inputs are ALL already-frozen upstream artifacts and whose `owns` set is
  DISJOINT from a sibling's — those are independent **lanes** that need not wait on each other, so run them as a
  `parallel([laneA, laneB])` for wall-clock. The **correctness rule is write-disjoint `owns`**: two concurrent
  lanes must share NO writable file. If a "dependency" is only that lane B reads an artifact lane A *also*
  produces, check whether B can read the SAME upstream source instead (re-pointing the read dissolves the
  artificial edge). When two lanes would BOTH touch one shared file, don't serialize the whole lane — split that
  file: give each lane its own per-node fragment and add a tiny SERIAL JOIN node after the parallel stage to
  merge them deterministically. (The script has no fs at eval time, so the join is a NODE, never raw fs in the workflow.)

**The node I/O map** — `<repo>/.agents/skill-system-io-map.md`, the THIRD standing artifact beside the
skill-system map (composition) and the criteria fixture (quality). It is the producer→consumer ledger keyed by
ARTIFACT: for each on-disk artifact, which node PRODUCES it, which nodes CONSUME it, and HOW (strict parse vs
LLM read — because *that* is a format change's blast radius). Derive it once from the node read-lines; update it
on the SAME trigger as the map. Before changing a node's output, read the artifact's consumer row and reconcile
every one; after, verify no consumer reads the stale shape.

## Files in this skill
- `reference/sdk-consumer.md` — **READ FIRST to stand up a project.** The canonical per-project layout (the
  three tiers + the file→mission map), the adopt steps, and the pre/post hook-assembly contract.
- `reference/observability.md` — **`piflow logs` (docker-logs for a run):** the run-status + event-archive
  contract, the CLI (`-f`/`--summary`/`--node`/`--raw`), the pre-run tool audit, the `RunOptions` knobs, and
  the failure-signature table. **Read when a run misbehaves.**
- `reference/cli.md` — the run flags + the `--from`/`--until`/`--only` node-range model + the `.env` knobs.
  Applies to `sdk/run.mjs` (some monolith-only flags are legacy). **Read so node ranges are never guessed.**
- `reference/architecture.md` — why the workflow runs unchanged: the invariants + the one dynamic-workflow
  caveat. **Read to understand the pattern.**
- `reference/artifact-contract.md` — the Output Contract + the `DRIVER-*` marker grammar (the authoring
  surface for hooks + the write/read contract). **Read to make a node deliver the right artifact + to author a hook.**
- `reference/escalation.md` — the escalation gate (engine-baked in the monolith; consumer-side + DEFERRED
  under the SDK). **Read before arming escalation.**
- `reference/orchestration.md` — Claude-Code-as-console: dry-run → background live → poll. **Read to operate a run.**
- `reference/worktree-isolation.md` — `WorktreeSandboxProvider` physical write-isolation for fleets. **Read before a `--worktree` fleet.**
- `reference/read-scope-sandbox.md` — `SeatbeltSandboxProvider` OS read-scope (macOS): the `DRIVER-READ-SCOPE`
  marker + the full-runtime-surface grants. **Read before `--sandbox`.**
- `reference/provider-and-headless.md` — the native `~/.pi/agent/models.json` credential + the headless
  invariants/watchdog. **Read for setup + when a node hangs.**
- `templates/pi-runner/` — **copy this into a repo: the SDK consumer.** `sdk/` (the thin glue) + `hooks/`
  (the deterministic op engine) + `extract.mjs` + `logs.mjs` + `extensions/` + `package.json` + `.env.example`.
  Generic + byte-identical; only `.env`/`package.json`/`hooks/` are yours. See `reference/sdk-consumer.md`.
- `templates/legacy/` — the **archived pre-SDK monolith** (the 153 KB `run.mjs` + its bespoke monitors /
  sandbox profile / provider ext): a parity bridge with a successor-map README. **Do not build on it.**
- `templates/models.json.example` — copy to `~/.pi/agent/models.json` (once per machine): the provider +
  credential pi resolves natively for every project.
- `templates/workflow-snippets/contract.js` — the `contract()` helper to paste into your workflow `.js` (the
  only per-workflow edit to adopt the Output Contract).
- `templates/examples/auto-discover-registry.example.mjs` — adapt-me generator for auto-discovered
  registration (the worktree merge-back enabler — stop hand-editing a shared registration list).
- `packages/core` (**`@piflow/core`**) — **the engine, installed not copied:** `runWorkflow`/`compile`, the
  contract codec, `runHooks`, the sandbox providers, the tool registry, and the `piflow` bin + observability.
  An engine fix is a package bump. (This skill folder IS the `@piflow/core` product repo; `docs/` holds its
  design canon — see `docs/INDEX.md`.)

## Reference implementation
The proven **SDK-consumer** instance is **game-omni's `pi-runner/sdk/`** — the layout these templates were
forward-ported from, running `.claude/workflows/game-omni-v1.6.js` on `@piflow/core` (extract → bridge →
compile → `runWorkflow` on the in-place `LocalSandboxProvider`, with `hooks/` bound in). The original
battle-tested **monolith** instance lives in the `animation-test` repo (the `lesson-build` workflow → 14
nodes / 10 stages) and matches `templates/legacy/run.mjs`; it is the pre-SDK reference. When in doubt about a
detail, those repos are the worked examples.
