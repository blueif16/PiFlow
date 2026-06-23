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
  workflow.json            # the DAG manifest (§5)
  refs.json                # workspace refs (optional): skills dirs, registry paths, product-scaffold source
  nodes/<id>/              # the COPYABLE per-node skeleton — IDENTICAL shape to the runtime folder
    node.json              # the node definition (§3): deps · tools · mcp · contract · hooks (one file, §11)
    prompt.md              # the prompt TEMPLATE: prose body + ${WORKSPACE}/${RUN}/${state.*} tokens + a skill pointer
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
  "deps": ["w0-classify"],                 // DAG edges (§5). disjoint `owns` + same deps ⇒ a parallel lane
  "prompt": { "skill": "packages/skills/write-gdd/SKILL.md", "file": "prompt.md" },
  "tools":  { "allow": ["read","write","edit","submit_result"], "deny": [] },   // → DRIVER-TOOLS / --exclude-tools
  "mcp":    { "servers": { /* … */ } },    // or { "ref": "..." }; omitted ⇒ none
  "contract": {                            // → rendered into DRIVER-ARTIFACTS/OWNS/READ-SCOPE/SCHEMA + DoD prose
    "artifacts": ["spec/gdd.md"],          // REQUIRED outputs, ${RUN}-relative (driver stat()s them → blocked if missing)
    "owns":      ["spec/**"],              // write authority
    "readScope": ["${RUN}", "${WORKSPACE}/packages/skills/write-gdd",
                  "${WORKSPACE}/templates/modules/${state.archetype}"],
    "schema":    "${WORKSPACE}/.../gdd.schema.json"          // optional, validated off-disk after the node
  },
  "hooks": {                               // deterministic driver ops (§4); each omittable
    "seed":    [{ "to": "spec/genre-options.json",
                  "from": "${WORKSPACE}/templates/genres/${state.archetype}.json" }],   // PRE
    "promote": [{ "from": "spec/classification.json:archetype", "to": "archetype", "merge": "set" }], // POST → RunState
    "project": [ /* … */ ], "merge": [ /* … */ ]            // POST derive/merge
  },
  "return": { /* optional JSON-schema for the node's structured result (the fenced-JSON tail) */ }
}
```
Every field is **data**. Nothing here is JS; the engine renders the realized prompt from it (§6).

## 4. Hooks (deterministic driver ops — the `mechanical → driver hook` law)
- **PRE — `seed`**: stage a node's starting artifact before the model (copy a skeleton/slice to FILL).
- **POST — `project` / `merge`**: derive/validate a node's mechanical outputs from frozen on-disk inputs.
- **POST — `promote`** (D6): lift a node output into a RunState channel; the DRIVER applies the channel reducer
  (`set` default · `append` · `deepMerge`) and merges at the stage barrier — the node never writes `state.json`.

## 5. The DAG manifest (`workflow.json`)
```jsonc
{ "id": "game-omni", "meta": { "name": "game-omni", "description": "…" },
  "phases": ["classify","design","harden","scaffold", "…"],
  "nodes": [
    { "id": "w0-classify", "phase": "classify", "deps": [] },
    { "id": "w1-design",   "phase": "design",   "deps": ["w0-classify"] },
    { "id": "w3a-art",     "phase": "produce",  "deps": ["harden"] },
    { "id": "w3b-sound",   "phase": "produce",  "deps": ["harden"] }       // disjoint owns ⇒ parallel with w3a
  ] }
```
`deps` define edges; the loader derives stages; phase-mates with **write-disjoint `owns`** become a parallel
lane. (Static DAG only — state drives values, never routing; D6.)

## 6. Rendering (engine, at load / instantiate)
The engine produces each node's realized prompt from its def — replacing the old JS `contract()` call:
1. read `prompt.md` (+ inline the `prompt.skill` pointer line),
2. append the `DRIVER-*` markers derived from `contract` + `hooks` + `tools` (ARTIFACTS · OWNS · READ-SCOPE ·
   SCHEMA · TOOLS · EXCLUDE-TOOLS · SEED · PROJECT · MERGE · PROMOTE) + the Definition-of-Done prose,
3. resolve `${WORKSPACE}`/`${RUN}` to physical roots; leave `${state.*}` as DEFERRED tokens (resolved by the
   driver at node launch from `${RUN}/.pi/state.json`).
The output is byte-equivalent to what extraction recovers from a `.js` — but from authored DATA, single-sourced.

## 7. Vocabulary (the only path/value tokens — one resolver, every field)
`${WORKSPACE}` (canonical, read-only) · `${RUN}` (per-thread) · `${state.<channel>}` (RunState, deferred). The
single resolver is applied uniformly to every marker; a path not expressible in this vocabulary is a design
smell (D6/D7).

## 8. Loader (`loadTemplate(dir) → WorkflowSpec`)
Read `workflow.json` + each `nodes/<id>/{node.json,prompt.md}` → the in-memory `WorkflowSpec` the existing
`compile`/`runWorkflow` consume. **Static checks** (fail closed): every `dep` resolves; every `ref`/skill path
exists; every `${state.<channel>}` referenced is `promote`d by some upstream node (a dangling-channel gate, the
state analogue of the dangling-ref check). `WorkflowSpec` stays the runtime contract; the template is its
authored on-disk form.

## 9. Ingest (`.js` → template) — one-time, init only
`extractWorkflow` (U5) recovers the DAG + realized prompts from a `.js`. The init-template skill maps each
recorded node → a `node.json` (DAG + prompt) and the human/skill authors the "more" extraction can't recover
(tools / mcp / contract-as-data / hooks / refs). Output: the template. The `.js` is then discarded — **no
two-way bridge, no Claude-Workflow execution** (D8).

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
- **Token syntax — RECOMMENDED `{{ … }}`** (Mustache/Jinja-style: `{{ state.archetype }}`, `{{ WORKSPACE }}`,
  `{{ RUN }}`) — lowest collision with the `${…}` (JS/shell) and `{…}` (JSON/code) that prompt prose carries.
  Pending final confirm. NOTE: the design docs write `${WORKSPACE}`/`${RUN}` as CONCEPTUAL shorthand for the
  engine-resolved roots; the on-disk delimiter in template files is this decision.
- **Per-run metadata dir name** (`.pi/` vs `_meta/`) — the D9 naming nit; open.
