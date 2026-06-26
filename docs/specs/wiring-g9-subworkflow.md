# Wiring G9 — Saved & nested (sub-)workflows

> Status: DESIGN (research 2026-06-25). Closes §G9 of `competitive-gaps-vs-pi-dynamic-workflows.md` and
> unblocks §G3. Severity LOW–MED · effort MED–HIGH. All `file:line` verified against the working tree.

## TL;DR

G9 is a **near-mechanical port of the shipped fusion expansion**: a sub-template reference expands, before
compile, into the parent's node bag — same insertion point (`entry.ts`, between profile and fusion), same
compiler (unchanged), same id-namespacing + disjoint-top-level-dir + loud-failure discipline, same
in-memory-prompt carriage. The durable DAG stays flat and observable, so G1/G2/G4/G6/checks all keep
working because the child nodes ARE first-class nodes. The "saved workflow" half is a `~/.piflow/`
catalog convention, **not** a core feature.

## THE PRECEDENT — fusion expansion, end to end (the template to copy)

Fusion is **fully shipped** (commits 5b84302, 6aae3e6, cb16658). The mechanism, verified:

- **The transform** — `packages/core/src/workflow/fusion/expand.ts`. `expandFusion(spec, opts):
  WorkflowSpec` (`:195`) is a **pure, pre-compile spec→spec transform** over the flat, edgeless
  `WorkflowSpec` (the `NodeIntent` bag), NOT the compiled DAG. Early-out: a spec with no fusion node is
  returned **referentially unchanged** (`:196`; tested `fusion-expand.test.ts:130-133`).
- `expandNode` (`:69`) turns one node `X` into `[obligations?, ...siblings, judge]`:
  - **id namespacing**: `ns = slugify(x.label,0)` (`:79`); siblings `${x.label}__p${i}` (`:109`); the
    judge **keeps X's original label** (`:154`) so `slugify` round-trips → every downstream edge survives.
  - **disjoint top-level artifact dirs** (parallel-safety): each sibling produces
    `fusion-${ns}-p${i}/partial.json` (`:80`). The comment at `:72-78` explains why — the runner collects
    per-node output (`fs.cp out/<id> → runRoot`) in parallel for a parallel stage; two siblings sharing a
    collected parent dir race and silently drop a partial. **Disjoint top-level dirs are the only pattern
    the parallel collect supports.** (Even with the new collect-mutex from commit 5b84302, fusion *keeps*
    this — see `runner.ts:936`.)
  - **reads/produces rewiring**: siblings clone X's prompt/tools/deps each writing its own partial
    (`:108-118`); the judge reads the partials (`:146,162-163`), keeps X's original
    produces/artifacts/checks/policy/returnSchema (`:166-176`), and **drops X's upstream deps**
    (`:163-164`) so the judge has exactly one upstream layer.
  - **G1 composition**: panel/judge refs classified via `classifyRef` (`:52-55`) — active tier → `.tier`,
    else `.model`; expandFusion never resolves a tier itself (precedence stays in `model-routing.ts`).
  - **loud failure**: `FusionConfigError` for moa-with-no-panel (`:91`) or n<1 (`:97`).
- **The wiring** — `packages/core/src/runner/entry.ts`. **The exact insertion point G9 reuses.** Both
  entries do, verbatim: `applyProfileByName(...)` → `expandFusion(spec, fusionExpandOpts())` →
  `compile(spec)` — `runFromTemplate` (`:107-111`) and `runFromConfig` (`:67-72`). **Order is
  load-bearing**: expand AFTER profile elision ("never expand a dropped node") and BEFORE `compile` (the
  compiler infers siblings→judge edges from the generated reads/produces). `fusionExpandOpts()` (`:27-29`)
  reads `~/.piflow/fusion.json` + `~/.piflow/model-tiers.json` once per run (read-only, graceful absence).
- **The compiler does the rest, unchanged** — `dag.ts`: `compile` (`:166`) → `inferEdges` (`:58`, edges
  from `produces ⋈ reads`) → `stagesOf` (`:94`, topological levels). `tryCompile` (`:147-157`) does
  **collision-safe id assignment** (`slugify(label,i)`, then dedupe) and `stagesOf:118-121` enforces
  acyclicity (`cycle detected among: …`) — the final backstop.

### THE ONE WRINKLE G9 must solve that fusion didn't — node-folder materialization

`runFromTemplate` calls `instantiateRun(templateDir, runDir, …)` (`entry.ts:105`) **BEFORE** profile +
fusion, and it materializes `${RUN}/.pi/nodes/<id>/` by **scanning the template's on-disk `nodes/<id>/`
dirs** (`workflow/template/instantiate.ts:104-139`). So generated nodes (fusion's, and any G9 children)
get **no pre-created folder**. Fusion gets away with it because **the runner does not read a node's prompt
from disk** — it uses the in-memory `NodeSpec.prompt` (`runner.ts:868` `resolveTokens(node.prompt,…)`,
written into the sandbox at `:876-877`); the `io.json` ledger is created on demand by `writeNodeIo`
(`layout.ts:68-70`, `mkdir recursive`). **So a generated node needs no template folder AS LONG AS its
realized prompt rides in-memory on the `NodeIntent`.** This is the single most important G9 constraint and
is not in the spec doc.

### Reference/cycle precedents already in the loader
`checkRefs` (`checks.ts:245-259`) resolves on-disk refs (`prompt.skill`, `mcp.ref`, `scripts/`) and emits
`dangling ref` on miss — the UX G9 mirrors for a missing sub-template. `checkDeps`/`checkCycles`
(`checks.ts:35-47`) do dangling-dep + cycle detection at the template level — where G9's sub-template
cycle check slots in.

## PDW reference — what transfers, what does NOT

- **Nested** — `vendors/.../src/workflow.ts:605-632`: `workflow('name', args)` is a **runtime function
  call** that runs a saved script inline sharing the parent's limiter, capped one-level-deep
  (`shared.depth >= 1` throws, `:609`). Not durable.
- **Saved** — `src/workflow-saved.ts` (a `SavedWorkflow` persisted as JSON) + `src/saved-commands.ts`
  (registers each as a `/<name>` command). PDW saves the **imperative JS script**.
- **Transfers (concept):** one-level+ nesting, param-passing, a named on-disk reusable artifact.
- **Does NOT transfer:** PDW nests at **runtime** sharing an in-process limiter — possible only with one
  process + shared memory. piflow has no shared in-memory state and one real `pi` per node. A runtime
  sub-run would break the durable, flat, observable filesystem DAG (run-view/journal/watch all assume one
  flat node set) and need its own limiter/journal/checkpoint plumbing. **Compile-time inlining (the
  fusion model) is strictly the right port** — children become first-class nodes, so G1/G4/G6 keep
  working.

## Options

- **A (recommended) — compile-time sub-DAG inlining (fusion-style).** A `subworkflow` block on a node; a
  pre-compile transform loads the referenced template, namespaces its ids under the parent, wires
  parent-inputs→child-entry and child-exit→parent-artifacts, and splices children into the parent spec.
  *Pro:* reuses ~100% of the fusion precedent; durable flat DAG; everything shipped keeps working.
  *Con:* the transform must be **async** (loads a template) — the one structural delta from sync
  `expandFusion`; needs depth-bounded recursion + cycle detection.
- **B — runtime sub-run (PDW port).** ❌ Breaks the durable/flat/observable invariant; no upside for our
  model.
- **C — node-kind-as-macro (author-time inline via `piflow-init`, G6-style).** Zero core change but loses
  the durable reference (edits don't propagate; no single source of truth). Good as a *complement*, not
  the primitive.

## Recommendation — Option A

**4a. Template schema field** (mirror the `fusion` block — `types.ts:68-76`, `node.schema.ts:203-220`,
`additionalProperties:false`):
```jsonc
"subworkflow": {
  "ref": "../verify",                                   // sub-template dir (node-relative, like prompt.skill/mcp.ref)
  "inputs":  { "<childExternalInput>": "<parent artifact path>" },  // parent → child entry reads
  "outputs": { "<parent artifact>":   "<child artifact path>" }     // child exit → parent's declared artifacts
}
```
A node carrying `subworkflow` declares its `contract.artifacts`/`owns` as the **boundary**; the children
fill them. `ref` is the required discriminator. **Additive** — a node without `subworkflow` is
byte-identical to today.

**4b. The expand step** — new `packages/core/src/workflow/subworkflow/expand.ts`, mirroring
`fusion/expand.ts`. For each node `X` with `subworkflow`:
1. **Load the child** via the existing `loadTemplate(resolvedRef)` (`loader.ts:167`) — full child
   validation runs free. **This makes the transform async** (the one delta; `entry.ts` is already async).
2. **id namespacing**: prefix every child label with `${X.label}__`. **X becomes the boundary/exit node**
   (symmetry with the fusion judge keeping X's id at `expand.ts:153-187`): X reads the child's terminal
   artifacts and produces X's original declared artifacts → all downstream edges survive.
3. **disjoint top-level dirs**: rewrite every child's produces/owns under `subwf-${ns}-<childId>/…` (the
   fusion parallel-safe discipline; keep it even with the collect-mutex per `runner.ts:936`).
4. **param wiring**: `inputs` → set each child entry node's `io.reads`/`externalInputs` to the
   parent-supplied path (use `externalInputs` so the "missing producer" check is suppressed,
   `dag.ts:81`). `outputs` → X reads the child terminals + produces X's original artifacts. **No token
   system needed** — wiring is by file path (fusion uses no `tokens.ts`).
5. **prompt carriage (THE constraint)**: child nodes' realized prompts must ride **in-memory** on the
   generated `NodeIntent.prompt` (use the child's `renderRealizedPrompt`/`toNodeIntent` output, marker
   tail inlined). Then the runner's in-memory prompt path handles them with no `.pi/nodes/<id>/` folder.
   **Do NOT rely on `instantiateRun` to materialize child folders** (it ran already, saw only the
   parent's `nodes/`).

**4c. Wire into the run path** — in `entry.ts`, insert `spec = await expandSubworkflow(spec, opts)`
**between `applyProfileByName` and `expandFusion`** in both entries (order: **profile → subworkflow →
fusion → compile**), so a fusion-activated node inside a sub-template still expands and a parent profile
can elide a node before its sub-DAG loads. Export from `index.ts` alongside `expandFusion`.

**4d. Cycle + depth** — track resolved sub-template paths on a stack during recursive expansion; a `ref`
already on the stack → throw `SubworkflowConfigError` (loud, like `FusionConfigError`). Support
**arbitrary nesting with a hard depth cap** (named constant, e.g. 8) — compile-time inlining has no
runtime-limiter reason to cap at 1, and G3's `loop-until-dry`-wrapping-`verify` is a natural 2-deep case.
`tryCompile` id-dedup + `stagesOf` acyclicity are the final backstop.

**4e. Composition:** G1 — children keep their own `model`/`tier`/`provider` (one resolver, unchanged); an
optional parent override is a future knob. G6 — a child's `agentType` survives verbatim → GUI icon rides
observe for children too; a sub-template can carry presets (it's a normal template). G4 — the envelope
hash hashes the realized in-memory prompt + inputs; because child prompts are inlined in-memory, each
child gets a stable hash → resume works node-by-node, no new hashing code (editing the sub-template →
those children + descendants re-run, correct). G2 — children are ordinary nodes in ordinary stages → the
semaphore gates them automatically. checks — each child keeps its own checks/policy/returnSchema; X keeps
the parent contract; `declared ⊇ actual` holds because owns are namespaced disjointly.

**4f. How G3 ships on top (G3-ready):** each pattern is a normal template referenced via `subworkflow`:
- **`verify`** — entry reads `{claim}`, N reviewer nodes (a parallel stage, each its own model), a
  consensus exit producing `{verdict}`. Literally the fusion panel→judge shape generalized.
- **`judge-panel`** — generalizes fusion's MoA judge (reuse the verbatim prompt from `fusion/prompts.ts`)
  as a *referenceable* sub-DAG.
- **`loop-until-dry`** — a bounded `{produce → verify}` sequence, compile-time unrolled to a max iteration
  count (the DAG is static); depth-2 nesting, which §4d supports.

## "Saved workflow" verdict

**For a data-on-disk system this is mostly already solved — a template IS a named, on-disk, reusable,
parameterizable thing.** PDW's save-path exists only because its workflow is an ephemeral script. Scoped
to the SDK/data-boundary rule (templates per-repo; global catalog in `~/.piflow/`):
1. A catalog of reusable sub-templates under `~/.piflow/workflows/<name>/` (parallel to the shipped
   `~/.piflow/model-tiers.json`, `fusion.json`, `agents/`). `subworkflow.ref` resolves a bare name via a
   **read-only** `loadWorkflowCatalog` reader (the analogue of `loadModelTiers`/`loadFusionConfig`/
   `loadAgentPreset`). The G3 templates ship as catalog seeds bundled with `piflow-init` (the G6 model).
2. "Save a run as a workflow" = copy/register a `template/` dir into the catalog — a thin
   `piflow-init`/CLI convenience, **NOT** core SDK. Core needs only the read-only resolver + the expand
   step.

## Test strategy (test-first against a `expandSubworkflow(spec)=>spec` stub; FAILS if broken)

New `packages/core/test/subworkflow-expand.test.ts` + a fixture pair under `test/fixtures/` (parent
referencing a 3-node child), mirroring `test/fixtures/template-fusion/`:
1. **Flattening + edges** (load-bearing): after `compile()`, child nodes appear with namespaced ids, the
   child's parallel stage is preserved, the parent's `inputs` artifact feeds the child entry, a downstream
   parent node still reads the exit node (X's id).
2. **Disjoint artifact dirs**: every child's produces/owns under a distinct `subwf-<ns>-…/` top-level dir.
3. **Cycle rejection**: a self/mutual reference throws `SubworkflowConfigError`.
4. **In-memory prompt carriage**: each expanded child `NodeIntent.prompt` is the child's realized prompt
   (non-empty, marker tail) — guards the folder-materialization constraint.
5. **Passthrough additivity**: a spec with no `subworkflow` is returned referentially unchanged (`toBe`).
6. **Entry integration** (stubbed `buildCommand`): a parent with a `subworkflow` runs the flattened DAG
   end-to-end.
7. **Loud dangling ref**: a `ref` to a non-existent template throws.

## Risks & open questions

- **`expandSubworkflow` must be async** — the one structural divergence from sync `expandFusion` (low
  risk; `entry.ts` already awaits `loadTemplate`/`instantiateRun`). The `runFromConfig` literal-spec path
  likely doesn't support on-disk refs — G9 probably applies to the *template* path only (fine).
- **Child folder materialization (§the wrinkle)** is the highest-risk subtlety — an implementer who
  assumes children get `.pi/nodes/<id>/` folders will ship empty prompts. Keep it in the card's
  scope-fence. (Alternative: move `instantiateRun` after expansion — bigger blast radius since it also
  seeds `state.json`/resume; prefer in-memory prompts, which fusion proves works.)
- **`inputs`/`outputs` wiring** is the one genuinely new authoring surface (fusion needed none) — add a
  `checks.ts`-style referential gate that every declared child `externalInput` is mapped and every parent
  artifact has a source.
- **Worktree/cloud sandbox** with a deep sub-DAG is untested, but children are ordinary nodes with
  disjoint owns → the per-node sandbox contract should hold (fusion makes the same assumption).
- **Depth cap value (8?)** — a named, documented, tunable constant.
