---
name: piflow-init
description: >-
  Pi Flow · INIT — create a structured workflow (a DAG of producer/verify nodes coordinating through the
  filesystem) and stand it up to run as a fleet of efficient pi agents (pi.dev / earendil-works/pi) driven by
  non-Claude coding-plan models, with Claude Code as the single console. The source of truth is a structured
  workflow TEMPLATE (`.piflow/<wf>/template/`); the `@piflow/core` SDK loads it into a WorkflowSpec and runs it
  one `pi` per node. INIT triages your starting point — PORT an existing Claude `.js`, IMPORT another engine's
  workflow (n8n/YAML/JSON), or COMPOSE fresh — then builds the template and the per-repo runner. Use to
  "create/author a pi-flow workflow", "stand up the runner in a repo", "port my Claude workflow to pi", "import
  an n8n workflow", "run my workflow on a non-Claude model", "pi-runner". To RUN/monitor an existing workflow
  use piflow-start; to IMPROVE one use piflow-enhance.
---

# Pi Flow · init — create & stand up a structured workflow on a pi fleet

**One-line model:** the **structured workflow template** (`.piflow/<wf>/template/`) is the single source of
truth; the **`@piflow/core` SDK** loads it into a `WorkflowSpec` and runs it, one efficient `pi` process per
node, while Claude Code owns the graph and monitors the run. A Claude Code Workflow `.js` is an OPTIONAL
one-time INGEST seed — `init` lifts it into a template, then it is discarded. **One authored template: no
codegen, no hand-sync, no drift, no second source.**

```
init ──(PORT a .js ONCE │ IMPORT n8n/YAML │ COMPOSE fresh)──► .piflow/<wf>/template/   ← the SOURCE OF TRUTH
                                                                    │ @piflow/core: loadTemplate → WorkflowSpec → compile → runWorkflow
                                                                    ▼ one `pi` per node (non-Claude coding-plan model)
   .piflow/<wf>/runs/<id>/{ product · .pi/state.json · .pi/nodes/<id>/io.json } ──► `piflowctl logs`   ← piflow-start owns this
```

## The three Pi Flow skills (this is the lifecycle)
| Skill | Role | Status |
|---|---|---|
| **piflow-init** *(you are here)* | CREATE a workflow: triage the source → build the `template/` → stand up the per-repo runner | full |
| **piflow-enhance** | IMPROVE a running workflow: the capture→route→edit→verify loop, the criteria fixture, Companion Mode judging | stub (scope declared) |
| **piflow-start** | RUN & monitor a workflow on the pi fleet: dry-run → live → `piflowctl logs` | stub (scope declared) |

> **Paths below are relative to the piflow repo root** (`~/Desktop/piflow`). This skill lives at
> `.claude/skills/piflow-init/`; references like `reference/sdk-consumer.md`, `docs/design/template-format.md`,
> `templates/pi-runner/`, and `packages/core` are at that repo root.

## Step 0 — triage your starting point (do this FIRST)
Getting a workflow into the template has a few distinct **conditions**, each with its own method. Match
**exactly one** row, then route. If none matches, STOP and say so — do not hand-roll an unsupported intake;
that is how a silent, wrong workflow gets built.

| You have… | Condition | Method |
|---|---|---|
| A proven Claude Code Workflow `.js` (`agent()`/`parallel()`/`pipeline()`/`phase()`) | **PORT** | `references/parse-claude-workflow.md` + `scripts/parse-claude-workflow.mjs` — `extractWorkflow` runs it under recording stubs and captures the EXACT realized prompts + DAG; you author the rest (tools/mcp/contract-as-data/hooks/refs). ✅ implemented |
| A workflow in another engine's format (n8n / YAML / JSON) | **IMPORT** | Map the foreign graph → the template's DAG manifest + per-node defs. ⛔ not yet — do not improvise; stop and flag the missing importer |
| Only a task/goal, no workflow yet | **COMPOSE** | Author `.piflow/<wf>/template/` from the task per `docs/design/template-format.md`. ⛔ not yet — stop and flag |

- **The PORT script is the bridge; its 0 exit is the oracle.** It ends by `compile()`ing its own output and
  asserting the DAG survived — trust the exit code, not a glance at the JSON. A non-zero exit means the spec is
  not trustworthy; fix the cause named in the error, never hand-edit around it.
- **Mechanical port = the floor, not the finish.** `references/parse-claude-workflow.md` names what the script
  CANNOT recover (data-flow reads, hooks, the contract decisions) and how to refine it. Read that before you
  ship the template.
- **New conditions are a new row + a new reference + (if programmatic) a new script — never more prose here.**

> **The per-run shape (designed, partially confident — not a separate "store" to build).** There is no
> database/registry layer: the TEMPLATE itself (`.piflow/<wf>/template/`, D8) is the canonical source — authored
> once here, customized per workflow. Each run is a DUPLICATION of it: **init-RUN** (`init(${RUN})`, D7/D9)
> instantiates a thread by materializing `${RUN}/.pi/` and copying each node's per-node configs (`prompt.md` ·
> `tools` · `mcp` · `node.json`) into `${RUN}/.pi/nodes/<id>/`, then filling the runtime STATE on top
> (`state.json` channels + the `io.json` ledger). So a run = a regenerable instance of the template (template
> COMMITTED; `runs/<id>/` GITIGNORED). This is the canon's **two inits** distinction — init-TEMPLATE (authoring,
> THIS skill) vs init-RUN (runtime instantiation). The shape is specified in
> `docs/design/sdk-canonical-build-plan.md` (D7 per-run `.pi/` layout · D8 source-of-truth · D9 `.piflow/`
> namespaces) + `docs/design/template-format.md` §10, and **partially landed** (U6a); the template loader +
> init-RUN (U6b–U8) are the remaining build, with open naming nits (`.pi/` vs `_meta/`). **INIT today is PORT
> (+ the deferred IMPORT/COMPOSE rows); do not finalize the template format or those open items here.**

## Standing up the project (after the template exists)
The engine is the **`@piflow/core`** package; a project does NOT copy an engine, it installs the package and
drops in a thin consumer. **The canonical per-project layout, the file→mission map, and the full adopt steps
are in `reference/sdk-consumer.md` — read it first.** The flow:

1. **Confirm the source of truth — the template.** The workflow lives as a structured template at
   `.piflow/<wf>/template/` (DAG manifest + per-node defs as data + refs — see `docs/design/template-format.md`),
   built by Step 0's triage. You edit the TEMPLATE; there is no maintained `.js`, no second source, no copy.
   (Today's `PI_RUNNER_WORKFLOW` still points at a `.js` pending the loader — the migration target is the
   template dir; see `docs/design/sdk-canonical-build-plan.md` D8.)

2. **Set the credential ONCE in pi's global config** (per machine, not per repo). The model + key live in
   pi's native `~/.pi/agent/models.json`, which pi resolves for EVERY project — so no product needs its own
   key or `.env` credential. `cp templates/models.json.example ~/.pi/agent/models.json`, edit
   `apiKey`/`baseUrl`/model ids, `chmod 600`, verify `pi --list-models cp`. See `reference/provider-and-headless.md`.

3. **Install `@piflow/core` + drop in `templates/pi-runner/`.** Copy the folder next to `.claude/`, set the
   `@piflow/core` dependency in `pi-runner/package.json` (a `file:` path to this repo's `packages/core`, a
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

6. **Dry-run to confirm the DAG (free, no model).** `init` ends here — the first real run + monitoring is
   **piflow-start**'s job.
   ```bash
   node pi-runner/sdk/run.mjs --run <id> --arg <k=v> --until <phase> --dry-run   # stages + per-node tools/hooks + pi cmd
   ```
   The dry-run prints the stage/node count, each node's `[tools: …] [hooks: …]`, the resolved `pi` command,
   and a `⚠ TOOL BINDING` on any un-tokenized allow/deny entry. Pass `args` with `--arg k=v` (repeatable) /
   `--arg-file k=path`; `--until`/`--from`/`--only` window a long pipeline. See `reference/cli.md`. **You run
   every command; the user runs nothing.**

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
  per-node human-judged quality bar (NEVER injected into a prompt). Maintained by `hermes-skill-system` (the
  improve loop — see piflow-enhance).

## The laws (do not violate)
- **Single source of truth = the structured template.** Improve a wave by editing its node def / its skill in
  the template (`.piflow/<wf>/template/`); the engine loads the change automatically. The Claude `.js` is an
  init-only INGEST seed, discarded after — NEVER a maintained second source. Zero hand-sync.
- **The engine is the `@piflow/core` package, not a per-repo copy.** The generic consumer glue
  (`sdk/`, `hooks/`, `extract.mjs`, `logs.mjs`) stays **byte-identical across repos** — 100% of per-repo
  specifics live in `.env` + `package.json` (wiring) + your `hooks/` (your ops), and the credential lives
  once in pi's global `~/.pi/agent/models.json`. An engine fix is a **package bump**, not a manual merge; a
  glue fix is a one-file copy. If you find yourself editing the consumer glue for one repo, you're
  re-introducing the drift this whole pattern exists to prevent — push it into `.env`/`package.json`/`hooks/`
  instead. (The Tier-2 glue still ships in the template only because `@piflow/core` has named gaps; it is
  slated to graduate into the package — see `reference/sdk-consumer.md`.)
- **Ingest once, then author — not codegen, not a live bridge.** To PORT an existing Claude `.js`,
  `extractWorkflow` runs it under recording stubs and captures the exact prompts + DAG ONCE; `init` maps
  that into the template, and the `.js` is discarded. Thereafter the engine loads the TEMPLATE directly
  (`loadTemplate → WorkflowSpec`). There is no two-way bridge and no Claude-Workflow execution target — pi + the
  human + the verify harness are the proving ground.
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
  declare it once as the `contract { artifacts, owns, readScope }` fields in each node def; the engine
  renders the Definition-of-Done prose AND the `DRIVER-ARTIFACTS`/`DRIVER-OWNS`/`DRIVER-READ-SCOPE`
  markers from them (the generic codec in `@piflow/core` parses them back). The **write-contract** (`artifacts`/`owns`)
  and the **read-scope** (`readScope`) are the SAME tier — both authored at node creation time, never an
  afterthought. Run the fleet under `SeatbeltSandboxProvider` so `readScope` is OS-enforced (inert otherwise).
  Full spec: `reference/artifact-contract.md`; read-scope syntax: `reference/read-scope-sandbox.md`.
- **A workflow ships with its criteria fixture.** Standing up a workflow creates
  `<repo>/.agents/skill-system-criteria.md` — the per-node, human-judged QUALITY bar (sibling of the
  skill-system map, complement to the mechanical Output Contract: the contract checks the artifact
  *exists*, the criteria say whether it is *good*). It is the standard runs are judged against to
  converge on quality, and the improvement target sharpened each run. It is **never injected into a
  node's prompt** (that would teach-to-the-test and void the clean-room signal), and the
  `hermes-skill-system` loop (piflow-enhance) maintains it.
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
- **A node WIRES its own tools in `tools.allow`/`deny`, and as of G11 a catalog tool BINDS on the canonical
  path — so author the address, don't fear it.** Four address families (`tools.allow` entries, template
  `node.json` `tools:{allow,deny}` — template/types.ts:26): `fs:*`/`sh:*` (pi builtins), `oc.<plugin>:<tool>`
  (the OpenClaw sdk catalog, e.g. the live-proven pure `oc.calc:add` → `tool_execution_end{calc_add, sum:5}`),
  `mcp.<server>:<tool>` (a per-node MCP server), and `contract:submit_result` (the typed terminating return
  tool, `tools/contract-tool.ts:20`). These now bind because `assembleRunTools` (`runner/tool-config.ts`)
  seeds the run registry (builtins + the `oc.calc:add` seed + the community catalog + `submit_result`) into
  BOTH `runFromConfig` and `runFromTemplate` (`runner/entry.ts:34-37,132-142`) under an explicit-caller-wins
  guard — before G11 a selected `oc.*`/`mcp.*` had ZERO canonical caller and the node went `blocked`. The bind
  PRE-CHECK runs LOUD and EARLY: `verifyToolBinding` (`runner.ts:771-778`, *before* pi spawns) marks the node
  `blocked` if a declared address is absent from the catalog or two addresses collide on one bare name — so a
  selected `oc.*`/`mcp.*` MUST exist in the catalog; the dry-run's `⚠ TOOL BINDING` audit (line 112 above)
  surfaces it for free. Per-node MCP creds: declare `mcp.servers` in the `node.json` (the loader reads
  `def.mcp` → `NodeIntent.mcp`, `template/loader.ts:165`), and **every secret-bearing value MUST be a
  `$VAR`/`${VAR}` env REFERENCE — the loader REJECTS a committed literal** (`checkMcpSecrets`,
  `template/checks.ts:318`); the runner forwards ONLY the referenced `$VAR`s through the `SecretResolver`
  allowlist, never the full env (on cloud, only the allowlist crosses — `runner.ts:447-478`). Param `enum`s
  render Gemini-safe automatically (`StringEnum`, `tools/params.ts` / `tools/compile.ts` #21) — authoring is
  unchanged. CAVEAT: an `oc.*` tool with a pure native execute runs end-to-end TODAY; a `mcp.*` tool routed
  through the bridge still needs the `$VAR`→value EXPANSION, a `@piflow/tool-bridge` follow-on **deferred
  (#14)** — `template/checks.ts:271-273`. FORWARD-POINTER: `docs/design/node-action-protocol.md` is the
  CONVERGING canonical node-action format (a unified `op[]` envelope), but its `op[]` is milestone M5 and is
  **NOT loadable today** (no `op`/`OpSpec` field in the loader/template types — the loader will REJECT it). So
  author today's loadable shape — `tools`/`mcp` above + `hooks`/`checks`/`policy` — and treat that doc as the
  target the format moves toward; **do NOT emit `op[]` yet.**
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
  (the slimmed `pi --mode json` stream — *what the model did*), joined on node id. `piflowctl logs` reads both
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

## Run profiles (product-declared modes) — let the USER choose how many
A workflow can declare named run PROFILES in its template `meta.json` — each a GENERIC node-ELISION
predicate the SDK applies before compile (`docs/design/profiles-and-resume-robustness.md`). A profile that
elides the verify/gate phase yields a producing-only DAG (the dev-time "companion" posture, where the
orchestrator IS the verifier); the default runs everything (the unattended "production" posture). The names
are the PRODUCT's vocabulary, declared as DATA — `@piflow/core` carries none of it (it knows only "elide the
nodes this predicate matches, rewiring deps so the survivor graph is gateless").
- **Authoring a workflow that has gate/verify nodes? PRESENT THE USER A CHOICE of how many profiles to
  declare — and ONE is a fine, common answer.** Don't force a pair. Offer, Claude-Code style: **(1)** just one
  default profile [recommended if unsure]; **(2)** add a dev profile that elides the gate nodes (faster babysat
  runs); **(3)** more, you name them. Declare the chosen set as `profiles` + `defaultProfile` in `meta.json`:
  ```json
  "profiles": { "production": {}, "companion": { "elidePhases": ["verify-1", "verify-2"] } },
  "defaultProfile": "production"
  ```
  A profile selects nodes to elide by their generic `phase` tag — so give the gate nodes a shared `phase`.
  Selecting one at run time is `--profile <name>` (piflow-start owns that).
- **A profile may only elide nodes that CREATE NOTHING — that IS the verify-node law above.** Drop the gates
  and every key artifact still exists, because PRODUCERS made them; that is precisely why the gate phase is
  safely elidable. A verify node that is also a producer can't be elided — split it FIRST.
- **When the gates are elided, the orchestrator IS the verifier.** Run in the background; the moment a node
  goes `ok`, judge its artifact against (a) the GOLD sample and (b) its criteria-fixture entry — the dual
  reference the `hermes-skill-system` node-validation loop uses (criteria stay a JUDGING reference, NEVER
  injected). You cover every surface the elided gates would have.
- **On a heavy mistake, stop** — don't pour effort onto a bad upstream artifact. Fix at the canonical owner
  (Hermes), rerun the SUFFIX from the first changed node (`--from`), reuse unchanged upstream. Borderline →
  surface to the human (the eye). Promote a fresh artifact over the gold when it's better.
A dev-time POSTURE on a product-declared profile — no engine branch, no per-workflow `mode` code. Pairs with
the criteria fixture and `hermes-skill-system`'s node-validation loop.

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

- **Agent-type presets (G6) — a node may START from a branded preset, then customize above it.** When an
  author assigns a node `agentType: <id>` (e.g. `market-research`), EXPAND it at author time — do not treat the
  name as magic: read `~/.piflow/agents/<id>.md`, call `mergePreset` (`@piflow/core`) to fold its base tools +
  role-prompt INTO the node's concrete `tools`/`prompt` (additive: the node ADDS tools and its task is appended
  to the role), keep `agentType` as the branding LABEL (the GUI renders its icon via observe), and choose the
  node's `model`/`tier` yourself — a preset NEVER sets a model. Unknown `<id>` ⇒ HALT, never invent one.
  Presets are an optional convenience, not a lock-in — skipping them and wiring `tools`/`prompt`/`model` by
  hand is the common path. **Full contract + the seed presets + how to author a new one:**
  `references/agent-presets/README.md`. On init, materialize any missing seed into `~/.piflow/agents/`
  (create-if-absent — never overwrite a user-edited preset).

**The node I/O map** — `<repo>/.agents/skill-system-io-map.md`, the THIRD standing artifact beside the
skill-system map (composition) and the criteria fixture (quality). It is the producer→consumer ledger keyed by
ARTIFACT: for each on-disk artifact, which node PRODUCES it, which nodes CONSUME it, and HOW (strict parse vs
LLM read — because *that* is a format change's blast radius). Derive it once from the node read-lines; update it
on the SAME trigger as the map. Before changing a node's output, read the artifact's consumer row and reconcile
every one; after, verify no consumer reads the stale shape.

## Files in the piflow repo (paths relative to the repo root, `~/Desktop/piflow`)
- `reference/sdk-consumer.md` — **READ FIRST to stand up a project.** The canonical per-project layout (the
  three tiers + the file→mission map), the adopt steps, and the pre/post hook-assembly contract.
- `reference/observability.md` — **`piflowctl logs` (docker-logs for a run):** the run-status + event-archive
  contract, the CLI (`-f`/`--summary`/`--node`/`--raw`), the pre-run tool audit, the `RunOptions` knobs, and
  the failure-signature table. **Read (with piflow-start) when a run misbehaves.**
- `reference/cli.md` — the run flags + the `--from`/`--until`/`--only` node-range model + the `.env` knobs.
  Applies to `sdk/run.mjs` (some monolith-only flags are legacy). **Read so node ranges are never guessed.**
- `reference/architecture.md` — why the workflow runs unchanged: the invariants + the one dynamic-workflow
  caveat. **Read to understand the pattern.**
- `reference/artifact-contract.md` — the Output Contract + the `DRIVER-*` marker grammar (the authoring
  surface for hooks + the write/read contract). **Read to make a node deliver the right artifact + to author a hook.**
- `reference/escalation.md` — the escalation gate (engine-baked in the monolith; consumer-side + DEFERRED
  under the SDK). **Read before arming escalation.**
- `reference/orchestration.md` — Claude-Code-as-console: dry-run → background live → poll. **Read to operate a run (piflow-start).**
- `reference/worktree-isolation.md` — `WorktreeSandboxProvider` physical write-isolation for fleets. **Read before a `--worktree` fleet.**
- `reference/read-scope-sandbox.md` — `SeatbeltSandboxProvider` OS read-scope (macOS): the `DRIVER-READ-SCOPE`
  marker + the full-runtime-surface grants. **Read before `--sandbox`.**
- `reference/provider-and-headless.md` — the native `~/.pi/agent/models.json` credential + the headless
  invariants/watchdog. **Read for setup + when a node hangs.**
- `docs/design/template-format.md` — **the template-format keystone** (the D8 source of truth): the
  contract-as-data node def, the DAG manifest, the loader, the `{{ }}` token vocabulary, the one-time `.js` ingest.
- `docs/design/sdk-canonical-build-plan.md` — D1–D9 + the U-unit table (the runtime build status).
- `references/parse-claude-workflow.md` + `scripts/parse-claude-workflow.mjs` — **the PORT condition** (Step 0):
  the `.js` → template bridge + what it cannot recover. (These live inside this skill.)
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
  contract codec, `runHooks`, the sandbox providers, the tool registry, and the `piflowctl` bin + observability.
  An engine fix is a package bump. (This repo IS the `@piflow/core` product repo; `docs/` holds its
  design canon — see `docs/INDEX.md`.)

## Reference implementation
The worked instance is **game-omni**: its `.claude/workflows/game-omni-v1.6.js` is the INGEST SEED being
ported into a `.piflow/game-omni/template/` (the `extractWorkflow` → init path); `pi-runner/sdk/` runs
`@piflow/core` on the in-place `LocalSandboxProvider` with `hooks/` bound in. The original battle-tested
**monolith** lives in the `animation-test` repo (`lesson-build` → 14 nodes / 10 stages, matching
`templates/legacy/run.mjs`) — the pre-SDK reference. When in doubt, those repos are the worked examples.
