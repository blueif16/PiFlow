# The workflow template format — the D8 source of truth

> The structured, authored source of truth for a pi-flow workflow (decision **D8**). Lives at
> `.piflow/<wf>/template/` (**D9**), committed. The **init-template skill** builds it (ingest a `.js` once, or
> reconstruct from other sources); the engine LOADS it into a `WorkflowSpec`; `init(${RUN})` instantiates a
> thread from it. **Authoring shape ≅ the runtime `.pi/nodes/<id>/` shape (D7)** — you author what the run
> mirrors. See `sdk-canonical-build-plan.md` for D6/D7/D8/D9.

## 1. Why a structured template (not the `.js`)
The Claude `.js` was always a partial slice (skills / registry / scaffold / hook-executors were never in it),
and it mixes DAG + prompts + contracts + schemas into one monolith. The template makes every piece **data**:
inspectable, diffable, per-node, uniform across projects. `contract()` stops being a JS call — the engine
RENDERS the realized prompt from structured fields. One authored artifact; the `.js` is a discardable ingest
seed.

## 2. On-disk layout (`.piflow/<wf>/template/`)
```
template/
  workflow.json            # GENERATED manifest (§5): the whole DAG, auto-regenerated from every node.json by the
                           #   compile step — committed for visibility/diff; never hand-edit edges here (a lockfile).
  refs.json                # workspace refs (optional, authored): skills dirs, registry paths, product-scaffold source
  meta.json                # the authored header (optional): id · meta · phase ORDER (the only authored DAG input)
  nodes/<id>/              # the COPYABLE per-node skeleton — IDENTICAL shape to the runtime folder
    node.json              # the node definition (§3): deps · tools · mcp · contract · checks · policy · hooks (ONE file, §11)
    prompt.md              # the prompt TEMPLATE: prose body + {{WORKSPACE}}/{{RUN}}/{{state.*}} tokens + a skill pointer
    scripts/               # PER-NODE programmatic code (custom ops/checks for THIS node) — varies a lot per node;
                           #   travels WITH the node in the copy. Generic, cross-node ops live in @piflow/core.
    io.json                # run-only stub, ships EMPTY ({}) so the cp brings it (§10 bucket 4)
    events.jsonl           # run-only stub, ships EMPTY
  .pi/state.json           # run-only stub, ships EMPTY ({}) — the RunState skeleton
```
The per-node folder is the SAME shape as the runtime `${RUN}/.pi/nodes/<id>/` (§10) — authoring ≅ runtime, so a
run is a near-literal copy. The empty `io.json`/`events.jsonl`/`state.json` stubs ride along in the skeleton
(committed empty) so a run folder is uniform + complete from t=0; execution fills them in place.

## 3. The node definition (`node.json`) — contract-as-DATA
```jsonc
{
  "id": "w1-design",
  "phase": "design",
  "deps": ["w0-classify"],                 // THE edges — SINGLE SOURCE (§5); the compile step chains these into the DAG.
                                           //   disjoint `owns` + same deps ⇒ a parallel lane
  "prompt": { "skill": "packages/skills/write-gdd/SKILL.md", "file": "prompt.md" },
  "tools":  { "allow": ["read","write","edit","submit_result"], "deny": [] },   // → DRIVER-TOOLS / --exclude-tools
  "mcp":    { "servers": { /* … */ } },    // SEPARATE field, SAME file (§11); or { "ref": "..." }; omitted ⇒ none
  "inject": [                              // KIND 1 — FORCED reads, auto-injected into the prompt (§6a).
    "{{RUN}}/spec/classification.json"     //   small · always-needed · stable; the model is GUARANTEED to see these
  ],
  "contract": {                            // the WRITE/READ contract → DRIVER-ARTIFACTS/OWNS/READ-SCOPE/SCHEMA + DoD prose
    "artifacts": ["spec/gdd.md"],          // REQUIRED outputs, {{RUN}}-relative (driver stat()s them → blocked if missing)
    "owns":      ["spec/**"],              // write authority
    "readScope": ["{{RUN}}", "{{WORKSPACE}}/packages/skills/write-gdd",     // KIND 2 — EXPOSED scope: dirs the model
                  "{{WORKSPACE}}/templates/modules/{{state.archetype}}"],   //   EXPLORES via pi `read` (§6a) + OS allow-list
    "schema":      "{{WORKSPACE}}/.../gdd.schema.json",    // optional, validated off-disk after the node
    "returnMode":  "optional",             // optional (default when artifacts declared) | required (zero-artifact gate nodes)
    "fillSentinel": null                   // optional write-first sentinel
  },
  "checks": {                              // INTEGRITY checks = the DETECTION (DRIVER-CHECKS); ⊥ the policy below (§4)
    "pre":  [ /* validate staged inputs / preconditions BEFORE the model */ ],
    "post": [ /* validate the produced artifacts AFTER the model */ ]
  },
  "policy": { /* verdict → action = the CONSEQUENCE (DRIVER-POLICY): a failed check ⇒ block | retry | escalate */ },
  "hooks": {                               // deterministic driver OPS (§4); each omittable
    "seed":    [{ "to": "spec/genre-options.json",
                  "from": "${WORKSPACE}/templates/genres/${state.archetype}.json" }],   // PRE
    "project": [ /* … */ ], "merge": [ /* … */ ],          // POST derive/merge
    "promote": [{ "from": "spec/classification.json:archetype", "to": "archetype", "merge": "set" }]  // POST → RunState
  },
  "return": { /* optional JSON-schema for the node's structured result (the fenced-JSON tail) */ }
}
```
Every field is **data** (no JS). The WHOLE per-node contract is SELF-CONTAINED in this ONE `node.json` —
PRE+POST hooks AND pre/post checks AND the verdict→action policy, nothing scattered — and the engine renders the
realized prompt from it (§6). A custom op/check the generic families don't cover points to a script in
`scripts/` (§2); the generic executors live in `@piflow/core`.

## 4. Hooks & checks (deterministic driver ops + integrity gates — the `mechanical → driver hook` law)
**Hooks — deterministic OPS that do work for the model:**
- **PRE — `seed`**: stage a node's starting artifact before the model (copy a skeleton/slice to FILL).
- **POST — `project` / `merge`**: derive/validate a node's mechanical outputs from frozen on-disk inputs.
- **POST — `promote`** (D6): lift a node output into a RunState channel; the DRIVER applies the channel reducer
  (`set` default · `append` · `deepMerge`) and merges at the stage barrier — the node never writes `state.json`.

**Checks + policy — detection ⊥ consequence (the two are SEPARATE so a check is reusable under any consequence):**
- **`checks.pre` / `checks.post` = the DETECTION** (DRIVER-CHECKS): integrity gates over the staged inputs
  (pre) or the produced artifacts (post). A check emits a VERDICT only — it never decides the action.
- **`policy` = the CONSEQUENCE** (DRIVER-POLICY): maps a failed-check verdict → `block | retry | escalate`. The
  same check (e.g. "schema invalid") can `retry` on one node and `escalate` on another — because detection and
  consequence are decoupled.

All of these live in `node.json` (§3). The generic check/op executors live in `@piflow/core`; a genuinely
custom one is a `scripts/` file (§2) the node references.

## 5. The DAG — authored in `node.json` `deps`; `workflow.json` is GENERATED (the lockfile)
**There is NO authored edge list.** Each `node.json` owns its own `deps` (§3) — the SINGLE SOURCE of the edges.
The compile step (§8) **auto-discovers** the node set by scanning `nodes/*/node.json` and **chains their `deps`**
into the DAG (add a node = drop a folder; no manifest edit). The overall workflow is *produced by chaining the
per-node info*, exactly.

The authored ⟷ generated split mirrors `package.json` ⟷ `package-lock.json`:
- **`meta.json` — authored, tiny:** `{ id, name, description }` (+ an optional phase DISPLAY order). `phase` is a
  DECORATIVE label a node carries; it does NOT drive ordering or parallelism (deps + `owns` do — below), so it
  can never contradict the edges.
- **`workflow.json` — GENERATED + committed (the lock AND the visible whole-DAG):** the compile step regenerates
  it from `meta.json` + every `node.json` on each build — the full resolved topology (nodes · edges · stages ·
  parallel lanes). You READ it (and diff it in a PR) but never hand-edit edges; change a `node.json`'s `deps` +
  rebuild. A `piflowctl check` gate fails if it's stale.
```jsonc
// workflow.json — GENERATED, do not hand-edit (run the compile step)
{ "id": "game-omni", "meta": { "name": "game-omni", "description": "…" },
  "stages": [ ["w0-classify"], ["w1-design"], ["harden"], ["w3a-art","w3b-sound"] ],  // resolved from deps
  "nodes":  { "w1-design": { "phase": "design", "deps": ["w0-classify"] } }            // mirror of each node.json
}
```
**Stages + parallelism are DERIVED from `deps` + `owns`:** topological levels give the stages; same-level nodes
with **write-disjoint `owns`** are a parallel lane — NOT from `phase` (decorative). (Static DAG only — state
drives values, never routing; D6.)

## 6. Rendering (engine, at load / instantiate)
The engine produces each node's realized prompt from its def — replacing the old JS `contract()` call:
1. read `prompt.md` (+ inline the `prompt.skill` pointer line),
2. append the `DRIVER-*` markers derived from `contract` + `checks` + `policy` + `hooks` + `tools` (ARTIFACTS ·
   OWNS · READ-SCOPE · SCHEMA · RETURN · CHECKS · POLICY · TOOLS · EXCLUDE-TOOLS · SEED · PROJECT · MERGE ·
   PROMOTE) + the Definition-of-Done prose,
3. resolve `{{WORKSPACE}}`/`{{RUN}}` to physical roots; leave `{{state.*}}` as DEFERRED tokens (resolved by the
   driver at node launch from `{{RUN}}/.pi/state.json`).
The output is byte-equivalent to what extraction recovers from a `.js` — but from authored DATA, single-sourced.

### 6a. Two KINDS of read scope — FORCED (inject) vs EXPOSED (explore)
A node's reads split into two kinds (researched 2026-06-23 — Claude Code INJECTS user-pointed files, pi hands
PATHS to its `read` tool; brief in `docs/research/file-ingestion-claude-pi-2026-06-23.md`):

- **KIND 1 — FORCED reads → auto-INJECTED (`inject`, §3).** Specific files the node ALWAYS needs, pre-read and
  embedded in the prompt, wrapped exactly like Claude Code so the model treats them as authoritative system
  context: `<system-reminder>` + a `Contents of {{abs-path}}:` preamble + the numbered contents. The model is
  GUARANTEED to see them — no read decision, no explore-forever (defuses the cheap-executor over-read failure;
  piflow's FILL-don't-explore lesson + pi issue #3432). For small · always-needed · stable inputs (a spec, the
  classification, a config). The path is also passed so a re-read stays possible.

- **KIND 2 — EXPOSED scope → EXPLORE via the `read` tool (`contract.readScope`, §3).** Directory paths handed to
  the model to NAVIGATE itself — **the skill systems, the registry, archetype modules**, large/optional trees.
  You do NOT inject a whole skill system; you expose its DIR and let the model pull the `SKILL.md` + the
  references it needs (paged via offset/limit). This IS `readScope` (also the OS allow-list under the sandbox).
  Required for large · optional · mutable inputs (a producer's artifact a later node consumes is EXPOSED, not
  injected — tool-read sees current bytes; injection would freeze a stale copy).

**The line:** force-inject iff `small (≲300–500 lines / well under pi's per-call cap) · always-needed · stable
when the prompt is composed`; everything else is EXPOSED-and-explored. `readScope` is the OS allow-list for BOTH
kinds (a node may only read what's in scope — the `inject` set must be inside it).

## 7. Vocabulary (the only path/value tokens — one resolver, every field)
`${WORKSPACE}` (canonical, read-only) · `${RUN}` (per-thread) · `${state.<channel>}` (RunState, deferred). The
single resolver is applied uniformly to every marker; a path not expressible in this vocabulary is a design
smell (D6/D7).

## 8. Loader / compile step (`loadTemplate(dir) → WorkflowSpec`, and (re)write `workflow.json`)
The compile step is the workflow's `tsc` — the SINGLE fail-closed gate (this is where the "everything in
node.json" design pays off: a malformed workflow fails in ms at author time, not after a 20-min pi run). It:
1. reads `meta.json` + **scans `nodes/*/`** for each `{node.json, prompt.md, scripts/}`,
2. **chains the per-node `deps`** into the DAG; derives stages (topological levels) + parallel lanes
   (same-level + write-disjoint `owns`),
3. renders each node's marker tail from its contract (§6) and validates it,
4. **(re)writes `workflow.json`** — the generated lock/overview — so it is ALWAYS auto-synced from the node.json
   set, never hand-maintained,
5. returns the in-memory `WorkflowSpec` the existing `compile`/`runWorkflow` consume.

**Static checks (fail closed — the gate):** `node.json`/`meta.json` SCHEMA-valid · every `dep` resolves to a
discovered node · NO cycles · `phase` is decorative (never an ordering source beside `deps`) · every PARALLEL
lane has write-disjoint `owns` · every `{{state.x}}` consumed is `promote`d upstream (dangling-channel) · every
artifact a node READS is produced upstream (dangling producer/consumer) · every `ref`/skill/`scripts/` path
exists (dangling-ref) · `workflow.json` is in sync (else regenerate). `WorkflowSpec` stays the runtime contract;
the template is its authored on-disk form.

## 9. Ingest (`.js` → template) — one-time, init only
`extractWorkflow` (U5) recovers the DAG + realized prompts from a `.js`. The init-template skill maps each
recorded node → a `node.json` (its `deps` + prompt) and the human/skill authors the "more" extraction can't
recover (tools / mcp / contract-as-data / checks / policy / hooks / refs / `scripts/`). Output: the template.
The `.js` is then discarded — **no two-way bridge, no Claude-Workflow execution** (D8).

## 10. Instantiation (init-RUN) — ONE per-node schema, template ≅ run (a near-literal copy)
The template's `nodes/<id>/` folder and the runtime `${RUN}/.pi/nodes/<id>/` folder are the **same schema** — a
run is a near-literal COPY of the template, so every run shows ONE clear, complete structure and all tooling
(I/O discovery, run↔template diff, resume) stays generic with zero per-node knowledge. `init(${RUN})` sorts each
node's files into four buckets:

1. **Pure copy (verbatim, template→run byte-identical).** `node.json` + the PROSE body of `prompt.md`.
2. **Token-resolve (intrinsic, deterministic).** `${RUN}`→the run dir, `${WORKSPACE}`→the canonical tree;
   `${state.*}` left DEFERRED (resolved at node launch from `state.json`). A string substitution — as safe as a
   copy; the ONLY thing that can't be a blind copy, because the run lives at a new path.
3. **Derive the marker tail — RECOMMENDED: render at instantiation.** The `DRIVER-*` markers + DoD prose are a
   pure function of `node.json`'s `contract`/`tools`/`hooks`: `markersFromNode(node)` (the codec — the tested
   inverse of `parseMarkers`). init-RUN APPENDS the freshly-rendered block to the copied prose body. So
   `node.json` stays the ONE source for the contract; the markers are never hand-authored and **cannot drift**.
   *(Alternative (b): pre-render the markers into a COMMITTED `prompt.md` so instantiation is a pure `cp`, gated
   by a `build`/`check` lockfile step — choose only if an un-failable runtime copy outweighs carrying a second
   representation of the contract + a drift gate. Default to render-at-instantiation.)*
4. **Run-only files — shipped EMPTY in the skeleton, filled by execution.** `io.json` (`{}`), `events.jsonl`
   (empty), and the run-level `${RUN}/.pi/state.json` (`{}` / seeded channels) ride along in the copyable
   structure so the run folder is COMPLETE from t=0 — no conditional file creation, one uniform shape every
   time. Execution writes into them in place (`io.json` ← resolved reads · verified writes · promotes;
   `events.jsonl` ← the behavior stream; `state.json` ← the barrier-merged channels).

So init-RUN is: `cp -r template/nodes → ${RUN}/.pi/nodes` · resolve tokens · append `markersFromNode` · (the
empty run-only stubs are already there). A handful of deterministic, individually-testable steps — not
open-ended logic. A run is a generated instance of the template, and any node's I/O is retrievable from its
folder without knowing the node.

> **Per-run variants (NOT built — recorded as a future knob the copy model unlocks).** Because each run is its
> OWN copy, runs can carry SLIGHT per-run tweaks — e.g. run A's `prompt.md` prose has tweak X, run B's has tweak
> Y — while the contract (rendered from the same `node.json`) is held CONSTANT. Launch a batch of runs with
> different tweaks in parallel and compare outcomes to see which direction to improve the system (prompt-craft
> A/B; could also vary `node.json` itself for a contract/tooling A/B). A clean built-in experiment substrate. Not
> implemented — kept here as the intended use.

## 11. Decisions & open items
- **DAG edges — RESOLVED: authored in each `node.json` `deps`; `workflow.json` is GENERATED (the lock).** Authored
  ⟷ generated mirrors `package.json` ⟷ `package-lock.json`: `meta.json` (tiny authored header) + the `node.json`
  deps are the source; the compile step (§8) auto-discovers nodes, chains deps, and **(re)writes `workflow.json`
  on every build** so it's always synced from the node set (never hand-edit edges; a `check` gate fails if
  stale). `phase` is DECORATIVE (deps + `owns` drive order/parallelism). (§5/§8.)
- **Read scope — RESOLVED: TWO KINDS** (§6a; researched 2026-06-23). **KIND 1 FORCED → `inject`**: specific
  small · always-needed · stable files auto-injected (Claude-Code-style `<system-reminder>` + `Contents of
  {{path}}:`) — guaranteed sight, defuses cheap-model over-read. **KIND 2 EXPOSED → `readScope`**: directory
  paths (skill systems · registry · modules · large/optional/mutable trees) the model EXPLORES via pi `read`.
  `readScope` is the OS allow-list for both; the `inject` set must sit inside it.
- **Pre/post hooks + checks + policy — RESOLVED: ALL self-contained in the one `node.json`** (§3/§4): `hooks`
  (seed=PRE; project/merge/promote=POST) + `checks` (pre/post integrity DETECTION) + `policy` (verdict→action
  CONSEQUENCE; detection ⊥ consequence) + `returnMode`/`fillSentinel`. Nothing scattered across files.
- **`scripts/` — RESOLVED: PER-NODE (`nodes/<id>/scripts/`).** Each node's custom ops/checks vary a lot, so its
  scripts live IN its folder and travel with it in the copy (self-contained node). Generic, cross-node executors
  live in `@piflow/core` (installed, not copied). (§2.)
- **`mcp` + `return` — RESOLVED: INLINE in `node.json`** (one self-contained per-node def; no sidecar files).
- **`tools` + `mcp` — RESOLVED: one `node.json`, SEPARATE FIELDS; NO exploded `tools.ts`/`mcp.json` files.** Both
  live as keys in the single `node.json` and the driver consumes both from it (this supersedes the `tools.ts
  mcp.json` sketch in the D7 layout). They stay SEPARATE fields because they're acquired differently — `tools`
  is mostly pi-native, `mcp` carries external-gateway config — so the resolver can source each its own way; but
  don't over-separate beyond co-located fields.
- **Instantiation (init-RUN) — RESOLVED: §10's four buckets.** Template ≅ run is ONE schema; instantiation is a
  near-literal copy + token-resolve + `markersFromNode` render. **Derive path = (a) render at instantiation**
  (one source in `node.json`, no drift); (b) pre-render+gate is the documented alternative only.
- **Run-only files (`io.json`/`events.jsonl`/`state.json`) — RESOLVED: ship EMPTY stubs in the copyable
  skeleton** so the run folder is uniform + complete from t=0; execution fills them in place (no conditional
  creation).
- **Per-run variants — NOTED, not built** (§10): each run is its own copy, so per-run prompt/`node.json` tweaks
  enable a parallel A/B experiment substrate. A future knob; recorded, not implemented.
- **`deepMerge` array policy — RESOLVED: arrays REPLACE** (treated as leaves); `append` is the explicit concat
  reducer (per U6a, `6518272`).
- **Token syntax — ADOPTED `{{ … }}` FOR NOW** (Mustache/Jinja-style: `{{ state.archetype }}`, `{{ WORKSPACE }}`,
  `{{ RUN }}`) — lowest collision with the `${…}` (JS/shell) and `{…}` (JSON/code) that prompt prose carries.
  **PROVISIONAL — leave the resolver's delimiter behind a single constant so it can change later** (e.g. if a
  prompt body legitimately contains `{{ }}`). Some older prose still writes `${WORKSPACE}`/`${RUN}` as conceptual
  shorthand; on-disk the delimiter is `{{ }}`.
- **Per-run metadata dir name** (`.pi/` vs `_meta/`) — the D9 naming nit; open.
