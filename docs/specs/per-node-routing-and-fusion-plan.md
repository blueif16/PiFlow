# Execution plan — per-node routing (G1) + fusion nodes

> Status: execution plan for subagents. Created 2026-06-25. **Design contract:**
> [`per-node-routing-and-fusion.md`](./per-node-routing-and-fusion.md) — read it first; this doc does NOT
> repeat the rationale, only the executable tasks. Upstream sources to consult are in that spec §7.

## How to use this plan
Each task below is a **self-contained contract** for one subagent: Objective · Files · Change · Acceptance
(observable) · Verify · Scope fence · Failure path. A subagent gets ONE card, plus the spec. Dispatch order
follows the dependency graph; cards marked **‖** in the same phase may run in parallel (disjoint files).

**Global invariants every card inherits** (do NOT restate, but obey):
- **Additive only.** A node/template that sets none of the new fields behaves byte-identically to today. Every
  new field is optional.
- **Mirror the in-flight `timeoutMs`/`retries` pattern** already in `template/types.ts`,
  `schema/node.schema.ts`, `loader.ts` (`toNodeIntent`) — same shape, same comment density.
- **One source of precedence.** ALL model/provider/fusion override logic lives where §2 of the spec says; never
  duplicate a precedence rule in two files.
- **Verify before returning.** Run `npm run typecheck && npm test` (workspace root); a card is done only when
  green. Report the diff + test output, not a "looks good."
- **Failure path.** If a referenced symbol/file isn't where the card says, or a change would require touching a
  file outside the card's Files list, **HALT and report** — do not improvise scope.

## Dependency graph
```
Phase 0 (git prep)  →  Phase 1 (routing, T1.1→T1.5, T1.6 ‖)  →  Phase 2 (fusion, T2.1→T2.6)  →  Phase 3 (GUI ‖, optional)
```
Phase 2 hard-depends on Phase 1 (fusion siblings use per-node `model`). Phase 3 depends on Phase 2.

---

## Phase 0 — git prep (orchestrator, NOT a subagent — owns the git loop)
The uncommitted WIP (`timeoutMs`/`retries` template wiring, 5 files) sits on `feat/g4-resume-journal`.
1. Confirm green: `npm run typecheck && npm test`.
2. Commit the WIP as its own unit: `feat(core): expose per-node timeoutMs/retries at the template level`.
3. Branch `feat/per-node-model-routing` for Phase 1; `feat/fusion-nodes` for Phase 2 (off Phase 1 after merge).
4. Each Phase-1/2 card commits at its own coherent boundary (one card ≈ one commit).

---

## Phase 1 — per-node model routing (G1)

### T1.1 — Template node: add `model` / `provider` / `tier` ‖
- **Objective:** let an authored `node.json` carry `model?`, `provider?`, `tier?` (route-by-model + optional
  gateway + optional tier alias).
- **Files:** `packages/core/src/workflow/template/types.ts` · `packages/core/src/workflow/template/schema/node.schema.ts`.
- **Change:** in `TemplateNode` add `model?: string; provider?: string; tier?: string;` with comments mirroring
  the existing `timeoutMs`/`retries` doc lines. In `nodeSchema.properties` add three string props
  (`minLength: 1`) with descriptions; keep `additionalProperties: false` intact.
- **Acceptance:** a `node.json` with `"model":"glm-4.6"`, `"provider":"openrouter"`, `"tier":"deep"` validates;
  a typo'd `"models"` still FAILS (the malformed-case test bites). Types compile.
- **Verify:** `npm run typecheck` + `npm test -- template-schema`.
- **Scope fence:** do NOT touch the loader, runtime types, or `fusion`. Do NOT add a tier-name enum (names are
  free data — §0.2).
- **Failure path:** if `TemplateNode`/`nodeSchema` shape differs from the spec, HALT and report.

### T1.2 — Runtime types: `NodeSpec.model`/`provider` + `NodeIntent` + `materialize`
- **Objective:** carry model/provider onto the compiled node so the runner can read them.
- **Files:** `packages/core/src/types.ts` · `packages/core/src/dag.ts`.
- **Change:** add `model?: string; provider?: string;` to `NodeSpec` (the WORK section, near `agentType`). Add
  both to the `NodeIntent` `Pick<NodeSpec, …>` union. In `dag.ts` `materialize`, copy `intent.model` /
  `intent.provider` onto the returned `NodeSpec`. **Note:** `tier` is resolved to a model by the runner
  (T1.4), so `NodeSpec` carries `tier` too — add `tier?: string` and pass it through `materialize`.
- **Acceptance:** `compile()` round-trips a node's `model`/`provider`/`tier`; existing `dag.test.ts` passes.
- **Verify:** `npm run typecheck` + `npm test -- dag`.
- **Scope fence:** mechanical carry only; no resolution logic here.
- **Failure path:** if `materialize` doesn't spread-or-list every field, follow its existing style; HALT if unclear.

### T1.3 — Loader: carry `model`/`provider`/`tier` into `NodeIntent`
- **Objective:** the loader maps authored fields → runtime intent.
- **Files:** `packages/core/src/workflow/template/loader.ts` (`toNodeIntent`).
- **Change:** in `toNodeIntent`, set `model: n.def.model`, `provider: n.def.provider`, `tier: n.def.tier` on the
  returned intent (additive `...(n.def.model ? … : {})` style, matching the `retries`/`timeoutMs` lines already
  there).
- **Acceptance:** `load-template.test.ts` gains/asserts: a node authored with `model`/`provider`/`tier` surfaces
  them on the compiled `NodeSpec`. Nodes without them are unchanged.
- **Verify:** `npm test -- load-template`.
- **Scope fence:** loader only. **Depends on T1.1, T1.2.**
- **Failure path:** HALT if `toNodeIntent` lacks the timeoutMs/retries lines this mirrors.

### T1.4 — `model-routing.ts`: the ONE precedence resolver + global config readers
- **Objective:** implement the §2 model/provider precedence in a single module. **This is the load-bearing card.**
- **Files (new):** `packages/core/src/runner/model-routing.ts` (+ export from `packages/core/src/index.ts`).
- **Change:** implement, with doc comments stating the precedence verbatim from spec §2:
  - `loadModelTiers(): { active: boolean; tiers: Record<string,string> }` — reads `~/.piflow/model-tiers.json`;
    absent/invalid ⇒ `{active:false, tiers:{}}` (never throws on absence).
  - `loadModelsIndex(): Map<string,string>` — reads `~/.pi/agent/models.json`, builds `model id → provider`.
    Absent ⇒ empty map. (Used only for provider auto-resolve.)
  - `resolveNodeModel(node, run)` where `run = { model?, provider?, tiers, modelsIndex }` →
    `{ model?: string; provider?: string }` applying:
    - model: `node.model` → `tiers[node.tier]` (only if `tiers.active`) → `run.model` → `undefined` (pi default).
    - provider: `node.provider` → `modelsIndex.get(effectiveModel)` → `run.provider` → `undefined` (caller's
      `cp` default).
  - **Loud failures:** `node.tier` set but unresolved (inactive tiers or missing key) ⇒ throw a clear
    `ModelRoutingError`.
- **Acceptance:** unit tests (new `model-routing.test.ts`) cover the full ladder incl. the loud-failure cases,
  and absence of both global files. Pure functions; global reads injectable for tests (pass a `readFile`/paths
  seam or accept the parsed configs as args).
- **Verify:** `npm test -- model-routing`.
- **Scope fence:** no runner edits here; just the module + tests. Do NOT read env or hardcode `~/.piflow`
  outside a single documented helper.
- **Failure path:** HALT if the SDK-boundary rule would be violated (no writing to `~/.piflow`, read-only).

### T1.5 — Runner: thread the resolved model/provider per node
- **Objective:** populate the existing `CommandContext` per node from `resolveNodeModel`.
- **Files:** `packages/core/src/runner/runner.ts`.
- **Change:** load tiers + models index ONCE in `runWorkflow` setup; store on `RunContext` (e.g.
  `ctx.modelRouting = { tiers, modelsIndex }`). At the build call **`runner.ts:880`**, replace
  `model: ctx.model, provider: ctx.providerName` with the result of
  `resolveNodeModel(node, { model: ctx.model, provider: ctx.providerName, ...ctx.modelRouting })` (model →
  `--model`, provider → `--provider`; when a field resolves `undefined`, fall back to today's `ctx.model` /
  `ctx.providerName`). Record the **effective** model on the node's status record for observability.
- **Acceptance:** extend `runner.test.ts`: with a stub `buildCommand`, a node carrying `model:'m-node'` emits
  `--model m-node` even when the run sets `model:'m-run'`; a node with no model emits the run default; a
  `tier`-only node (tiers active) emits the mapped model. `command.ts` is UNCHANGED (it already reads
  `ctx.model`/`ctx.provider`).
- **Verify:** `npm test -- runner model-routing`.
- **Scope fence:** runner threading only; precedence stays in `model-routing.ts`. **Depends on T1.2–T1.4.**
- **Failure path:** if the build call site moved from line 880, locate `ctx.buildCommand(node,` — HALT if absent.

### T1.6 — CLI dry-run: show per-node model ‖
- **Objective:** `piflow run --dry-run` prints each node's effective model/provider.
- **Files:** `packages/cli/src/run.ts` (`dryRunPlan`).
- **Change:** in `dryRunPlan`, compute each node's effective model/provider via `resolveNodeModel` (load the
  global configs once) and include it in the printed per-node line; the realized command already calls
  `defaultPiCommand` — pass the resolved model/provider.
- **Acceptance:** a template with a per-node `model`/`tier` shows it in the dry-run plan; nodes without show the
  run default. No model is invoked (dry-run stays free).
- **Verify:** `npm run typecheck`; manual `piflow run <tpl> --dry-run` on a fixture if available.
- **Scope fence:** dry-run output only; no live-run changes. **Depends on T1.4.**
- **Failure path:** HALT if `dryRunPlan` signature differs.

---

## Phase 2 — fusion nodes (the DAG expansion)

### T2.1 — Template: add the `fusion` block
- **Objective:** an authored node opts into fusion (spec §4 shape).
- **Files:** `template/types.ts` · `schema/node.schema.ts` · `loader.ts`.
- **Change:** add `fusion?: { mode: 'moa'|'best-of-n'; n?: number; panel?: string[]; judge?: string;
  obligations?: boolean; verify?: boolean }` to `TemplateNode`; matching schema object (`mode` enum required
  when `fusion` present; `additionalProperties:false`); carry verbatim through `toNodeIntent` → a new
  `NodeIntent.fusion` (types.ts). **Carry-only — no expansion here.** **Do NOT add `NodeSpec.fusion`:**
  `expandFusion` (T2.2) runs on the WorkflowSpec (the `NodeIntent` bag) BEFORE `compile`, so it reads
  `NodeIntent.fusion`; after expansion no node carries `fusion`, so the materialized `NodeSpec` never needs it.
- **Acceptance:** a node with a valid `fusion` block validates; bad `mode` FAILS; nodes without it unchanged.
- **Verify:** `npm test -- template-schema load-template`.
- **Scope fence:** no expansion, no runner. **Depends on Phase 1 merged.**
- **Failure path:** HALT if `NodeIntent.fusion` cannot be added in the additive style the other intent fields use.

### T2.2 — `expandFusion(spec, fusionDefaults)` — the sibling+judge transform (CORE)
- **Objective:** turn each fusion-activated node into siblings + a judge, per spec §4, so the existing compiler
  draws the graph.
- **Files (new):** `packages/core/src/workflow/fusion/expand.ts` (+ export from index).
- **Change:** `expandFusion(spec: WorkflowSpec, defaults): WorkflowSpec` (pure, pre-compile):
  for each node `X` with `fusion`:
  1. Resolve params via spec-§2 fusion precedence (`node.fusion.*` → `defaults` → built-ins:
     `mode` required, `n=3`, `panel` required for moa, `judge=X`'s model, `obligations=false`, `verify=true`).
  2. **Siblings** `X__p1..pN` (N = `panel.length` for moa, else `n`): clone `X`'s original `prompt`, `deps`/
     `io.reads`, `sandbox.read`; each `produces` a distinct partial `<X output>/fusion/p{i}.json`; set
     `model = panel[i]` (moa) or inherit `X`'s model (best-of-n). New ids; new `owns` for the partial.
  3. **Judge = X (same id):** replace `prompt` with Appendix A1 (moa) / A2 (best-of-n) filled with
     `{{ORIGINAL_TASK}}` = X's original prompt, `{{PARTIAL_FILES}}` = the partial paths, `{{OBLIGATIONS}}` =
     the obligations artifact (or omit the line). Set `io.reads` = the partials (+ obligations); keep X's
     ORIGINAL `produces`/artifacts so downstream edges are preserved.
  4. *(if `obligations`)* prepend an obligations node (Appendix A3) `X__obl` producing
     `<X output>/fusion/obligations.json`, read by siblings + judge.
- **Acceptance:** `fusion-expand.test.ts`: for a 1-node moa(`panel:[a,b]`) workflow, expansion yields 2 siblings
  + judge(id=X); after `compile()`, siblings share one parallel stage, judge the next, and an original
  successor of X still reads X. best-of-n(`n:3`) yields 3 same-model siblings. `obligations:true` adds the obl
  node upstream. A spec with no fusion nodes is returned unchanged (referential-equality of nodes acceptable).
- **Verify:** `npm test -- fusion-expand`.
- **Scope fence:** transform only — do NOT call the model, do NOT edit the runner/compiler. Reuse Appendix A
  prompts VERBATIM (do not redesign agent-facing prose). **Depends on T2.1.**
- **Failure path:** if an activated node has no downstream/owns to preserve, still expand; if `panel` refs an
  unresolvable tier, throw `FusionConfigError` (loud).

### T2.3 — `~/.piflow/fusion.json` reader + defaults
- **Objective:** the global fusion defaults + activation toggle.
- **Files (new):** `packages/core/src/runner/fusion-config.ts` (+ index export).
- **Change:** `loadFusionConfig(): { active: boolean; ...defaults }` reading `~/.piflow/fusion.json`; absent ⇒
  `{active:false}` with built-in defaults. Pure/injectable for tests. (The `active`+best-quality auto-mark used
  by piflow-init is a SKILL concern — expose the config; do not auto-mark here.)
- **Acceptance:** `fusion-config.test.ts` covers present/absent/invalid.
- **Verify:** `npm test -- fusion-config`.
- **Scope fence:** read-only; SDK-boundary respected.
- **Failure path:** HALT on any write attempt to `~/.piflow`.

### T2.4 — Wire `expandFusion` into the run path
- **Objective:** runs honor fusion automatically.
- **Files:** `packages/core/src/runner/entry.ts` (`runFromTemplate`: after `applyProfileByName` L91, before
  `compile` L93; `runFromConfig`: after `applyProfileByName` L55, before `compile` L56).
- **Change:** insert `spec = expandFusion(spec, loadFusionConfig())` AFTER `applyProfileByName` and immediately
  BEFORE `compile`, in BOTH entries. **Order matters:** expand AFTER the profile elides nodes, so a fusion node
  a profile dropped is never expanded (and a surviving fusion node's siblings enter the graph the profile sees).
- **Acceptance:** `entry.test.ts`: a template with a fusion node runs as the expanded DAG end-to-end with a stub
  `buildCommand` (siblings + judge execute; judge reads partials). A non-fusion template is unaffected.
- **Verify:** `npm test -- entry`.
- **Scope fence:** insertion only; no logic in entry. **Depends on T2.2, T2.3.**
- **Failure path:** HALT if the `loadTemplate → compile` order differs from the spec.

### T2.5 — Participant fallback policy (objective-failure only)
- **Objective:** mirror pi-fusion `src/fallback.ts` — a sibling falls back to another model ONLY on objective
  failures (rate-limit/quota/timeout/network/empty/context-limit/provider error), never on quality.
- **Files:** `packages/core/src/runner/model-routing.ts` (extend) or `fusion/expand.ts` sibling config.
- **Change:** allow a sibling `model` to carry a fallback chain (from `node.fusion` or `defaultFallbacks`);
  reuse the existing per-node `retries` mechanism, restricting model-switch retries to objective failures.
  Keep minimal — a thin policy, not a new retry engine.
- **Acceptance:** a test simulating a rate-limit failure switches the sibling to the next model; a "bad quality"
  (non-error) result does NOT switch. 
- **Verify:** `npm test -- model-routing`.
- **Scope fence:** participants only. **Depends on Phase 1 retries.** *Optional for v1 — defer if it grows.*
- **Failure path:** if it can't reuse `io.retries`, HALT and propose a design note rather than forking retry.

### T2.6 — Fusion docs + an example template
- **Objective:** a runnable example + author docs.
- **Files:** a `templates/` example with one fusion node (both modes documented); a short `docs/` how-to linking
  the spec.
- **Acceptance:** the example loads, dry-runs, and shows the expanded DAG.
- **Verify:** `piflow run <example> --dry-run`.
- **Scope fence:** docs/example only. **Depends on T2.4.**

---

## Phase 3 — GUI activation (optional, thin)

### T3.1 — "Activate as fusion" control ‖
- **Objective:** clicking a node in the viewer writes a `fusion` block into its `node.json`.
- **Files:** the node-detail/HUD component under `gui/src/components/` (locate `NodeHud`/`ContentView`) + a dev
  write endpoint in `gui/vite.config.ts` middleware (mirrors the existing read-from-`~/.piflow` mechanism).
- **Change:** a control that POSTs `{templateDir, nodeId, fusion:{mode,…}}`; middleware writes the block into
  the node's `node.json`; on reload the viewer re-compiles and shows the expanded graph (siblings + judge).
- **Acceptance:** activating a node persists the block and the re-rendered DAG shows the expansion.
- **Scope fence:** viewer + dev middleware only; NEVER commit collected data into the GUI (CLAUDE.md). Template
  stays the source of truth (no runtime-only fusion state). **Depends on Phase 2.**
- **Failure path:** if no dev write mechanism exists, HALT and propose one (don't bypass the static-viewer rule).

### T3.2 — Render the expanded graph distinctly ‖
- **Objective:** the DAG view visually groups a fusion node's siblings → judge.
- **Files:** the graph/flowmap component in `gui/`.
- **Acceptance:** siblings render as a parallel cluster feeding the judge; the judge keeps the original node's
  downstream edges.
- **Scope fence:** rendering only. **Depends on T3.1.**

---

## Done-criteria (the whole feature)
- A node can pin `model`/`provider`/`tier`; precedence matches spec §2 exactly; **all precedence lives in
  `model-routing.ts`**.
- `~/.piflow/model-tiers.json` + `~/.piflow/fusion.json` are read-only global config; absence is graceful.
- A fusion node expands to siblings + judge that the existing compiler renders as
  `deps → (siblings ‖) → judge → original successors`, in both modes, on local mode, with no new DAG code.
- `npm run typecheck && npm test` green; additive (no existing test changed in meaning).
