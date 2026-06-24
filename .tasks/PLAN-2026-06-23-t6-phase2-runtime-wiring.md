# PLAN — T6 Phase 2: the runtime wiring that makes a migrated template RUN end-to-end

> Branch `feat/core-canonical-features` @ `1b8cbcc` (confirmed HEAD). Baseline: `npx tsc -b` clean,
> `npx vitest run` = **373 pass / 1 skip** (verified this session). PLAN ONLY — no source touched.
> Scope target: `.piflow/game-omni/template/` (16 nodes). Canon reconciled: `sdk-canonical-build-plan.md`
> (U6/U7/U8 + D6/D7/D8/D9), `template-format.md` §§4/6/7/10, `observability-pipeline.md` §6.

---

## 1. Verified gap map

Each row: the claim · file:line evidence · verdict. The orchestrator's trace is corrected where wrong.

| # | Claim | Evidence | Verdict |
|---|---|---|---|
| G1 | Loader DROPS the op layer — `toNodeIntent` never reads `node.def.hooks` (seed/project/merge/promote) | `loader.ts:87-115` builds `NodeIntent` from `contract`/`tools`/`policy` only; `n.def.hooks` is never referenced. Comment `loader.ts:10-11` says seed/promote/inject delivery is "the runtime's job (T4/T5)". | **VERIFIED-TRUE** |
| G2 | `NodeSpec.hooks` is only `{pre?,post?: Hook[]}` — no field carries the op-specs | `types.ts:36` `hooks?: { pre?: Hook[]; post?: Hook[] }`. `Hook` (`types.ts:245`) is the generic in-process plumbing type, NOT a seed/promote/project/merge op. | **VERIFIED-TRUE** |
| G3 | The ops exist but are EXPORT-ONLY — uncalled by runner/loader | grep over `packages/core/src`: every op (`resolveTokens`, `applyPromotes`, `barrierMerge`, `extractPromoteValue`, `parsePromote`, `driverSeed`, `resolveSeedTokens`, `applyProjectionOp`, `applyMergeOp`, `runMerge`, `loadState`, `persistState`, `mergeUpdate`, `instantiateRun`, `loadTemplate`) is referenced ONLY by its own module + `index.ts` barrel + tests. Zero references in `runner.ts`/`entry.ts`. | **VERIFIED-TRUE (all of them)** |
| G4 | `runNode` stages `node.prompt` VERBATIM — no token resolution at launch | `runner.ts:469` `await sandbox.writeFile(promptFile, node.prompt + (markers…))`. No `resolveTokens`/`resolveAll` anywhere in `runner.ts`. | **VERIFIED-TRUE** |
| G5 | It parses only `{status,summary,issues}` via `lastJsonBlock`; the full `@return` is NOT captured | `lastJsonBlock` returns `NodeReturn = { status?, summary?, issues? }` (`runner.ts:204`); `parsed` is consumed ONLY at `:580/:581/:590` for status/summary/issues. No capture of an arbitrary `@return` object. `extractPromoteValue` needs `ctx.returnValue` (`promote.ts:79-86`) for an `@return:<field>` promote → that source is **unfed** in the run path. | **VERIFIED-TRUE — and load-bearing for G9** |
| G6 | `runWorkflow` never loads/persists `.pi/state.json`; barrier is `Promise.all` (`:787`); POST hooks at `:594` | `runner.ts:787` `Promise.all(s.nodeIds.map(runNode))`; `:594` `runHooks(node.hooks?.post,…)`. No `loadState`/`persistState`/`stateFile` in `runner/*.ts` except the layout helper def. | **VERIFIED-TRUE** |
| G7 | `RunOptions` has NO generic args channel; `loadConfig`/`ConfigArgs` doesn't thread an arg map to a resolver ctx | `RunOptions` (`runner.ts:77-150`) — no `args`. `ConfigArgs` (`config.ts:16-32`) — no `args`. `ResolveCtx` (`resolver.ts:25-32`) has `run`/`workspace`/`state?` only; **no `arg` branch** (grep "arg" in `resolver.ts` → empty). | **VERIFIED-TRUE** |
| G8 | `runFromConfig` does NOT `loadTemplate`/`instantiateRun`/seed `.pi/state.json` — nothing materializes the run folder/state | `entry.ts:32-51`: `compile(spec)` → `runWorkflow`. No template load, no instantiate, no state seed. | **VERIFIED-TRUE** |
| G9 | **#17 shape mismatch** — template hooks declare `{to,from}`, executors expect discriminated shapes | Template: `seed/project/merge` are `{to, from}` (`w2-scaffold/node.json:51-77`, `gameplay/node.json:38-53`, `asset/node.json:38-46`, `w1-design/node.json:51-61`). Executors: `applyMergeOp` wants `{concat\|reconcile\|fold\|run}` (`merge.ts:44/79/146/175`); `applyProjectionOp` wants `{copy\|assemble\|merge}` (`project.ts:46/56/103`); **no structured-seed executor exists** — `ops/seed.ts` has only `driverSeed` (a MARKER-line parser) + `resolveSeedTokens` (a token resolver), and the actual COPY (`fs.cpSync`/`copyFileSync`) was NOT ported from game-omni (`run.mjs:1547`). | **VERIFIED-TRUE — but my trace was IMPRECISE on `seed`** (see correction below) |

**Corrections / nuance to the trace:**

- **C1 (trace imprecise on `seed`).** The trace said the seed mismatch is that `driverSeed` "parses `DRIVER-SEED:` MARKER lines, not a `{to,from}` object." True — but the deeper gap is that **there is no seed EXECUTOR at all** in core. The template's `seed: {to, from}` shape DOES match the `Seed` interface (`seed.ts:13` `{to, from}`) and `ContractMarkers.seed` (`contract.ts:26`). The missing piece isn't the shape — it's the file/dir **copy + idempotency + dir-recursion** logic (game-omni `run.mjs:1517-1551`), which `ops/seed.ts` never ported. So `seed` needs a new tiny executor, not a re-author.
- **C2 (op tally correction).** Trace said "merge≈10". Confirmed exactly **10** node.json files contain a `merge` key; `seed`=3, `project`=1, `promote`=1, `inject`=0. So **merge is the dominant op** and the bulk of #17's blast radius is in merge, not project.
- **C3 (the `{to,from}` merge/project shape is AUTHORING-CANON, not a template bug).** The template schema (`node.schema.ts:166-178` `derivedHook`) and `TemplateNode` (`template/types.ts:33-38`) DEFINE `project`/`merge`/`seed` as `{to, from}` — this is the §3/§4 spec vocabulary. The discriminated `{concat|copy|assemble|…}` shapes are what game-omni's `genres.json` `projections` DATA carries (`paddle_ball.json:55-58`, `genres.json:62`), consumed by the PORTED `applyProjectionOp`/`applyMergeOp`. So #17 is **spec-authoring-vocabulary ⟂ ported-executor-vocabulary** — two different op languages, not a malformed template.
- **C4 (NEW blocker the trace missed — tool binding).** EVERY migrated node declares `submit_result` in `tools.allow` (e.g. `w0-classify/node.json:18`), but the builtin catalog (`registry.ts:11-17`) has only `read/write/edit/grep/find/ls/bash` — **no `submit_result`**. The runner's PRE-NODE BIND CHECK (`verifyToolBinding`, `runner.ts:395-398`) marks an unknown address `blocked`. So a live run blocks at W0 on tool-bind BEFORE any state/op wiring matters. (Handoff §2.5 noted this for `template-min`; it equally bites the game-omni template.)
- **C5 (NEW related gap — `io.json` ledger unwired).** `writeNodeIo` (D7 per-node ledger) is NOT called in `runner.ts` (grep clean), though `observability-pipeline.md` §6 + D7 describe it as written per node. The observe reader falls back to `run.json` `artifacts[]` when `io.json` is absent, so this is non-blocking — but it IS the natural home for the `promotes[]` record the barrier-merge produces. Flag, fold opportunistically (Stage 4).
- **C6 (trace's `{{arg.prompt}}` placement).** Confirmed: `{{arg.prompt}}` appears in `w0-classify/prompt.md:14` (one occurrence, in the PROSE body). `{{state.archetype}}` appears ONLY in op-spec `from` fields of `gameplay`/`w1-design`/`w2-scaffold` node.json — **never in a prompt.md body**. Consequence: at node launch the PROMPT needs `{{arg.*}}` resolution; `{{state.*}}` is consumed by the SEED op (resolved via `resolveSeedTokens`), not by prompt staging. This narrows G4's fix.

---

## 2. What the canon intended (per piece: U-unit + template-format section + spec↔code gap)

| Piece | Owning unit / section | Intent | Built-vs-spec gap |
|---|---|---|---|
| **Resolver** (`{{RUN}}`/`{{WORKSPACE}}`/`{{state.*}}`) | **U7** (`build-plan` L97, "Revised U7" L208-214); template-format §6 step 3, §7 | ONE resolver applied to EVERY marker at NODE LAUNCH; a missing channel throws `MissingChannelError`. | Resolver BUILT + unit-tested (`resolver.ts`), but **never called by the runner** (G3/G4). U7's "wire into the run loop" was deferred to U8 (build-plan L98 "U8 composes the rest"). |
| **State load/persist** | **U6a** (build-plan L96, L256 "fold into the U6 foundation"); D6; template-format §10 bucket 4 | `${RUN}/.pi/state.json` is the per-thread checkpoint; staged-in/collected-out per node. | `loadState`/`persistState`/`mergeUpdate` BUILT (`state.ts`), uncalled (G3/G6). `instantiateRun` seeds `state.json='{}'` (`instantiate.ts:111`) but `runWorkflow` never reads/writes it. |
| **promote + barrier** | **U7** (build-plan L97, "Reducers & the barrier-merge" L151-158); D6 | POST-hook `promote` lifts a node output → channel; DRIVER merges via reducer; PARALLEL stage merges SERIALLY at the barrier; `set`+2 writers ⇒ `ConflictError`. | `extractPromoteValue`/`applyPromotes`/`barrierMerge` BUILT (`promote.ts`), uncalled. The `@return:<field>` source (`promote.ts:85`) has **no run-path feeder** (G5). |
| **seed** (PRE) | **U7** (build-plan L97); template-format §4 "PRE — `seed`: stage a node's starting artifact" | Copy a skeleton/slice to a dest the model FILLs; resolve `{{…}}`/`{file:field}` in `from`; idempotent (skip when dest present); dir = recursive overlay. | Token-resolution BUILT (`resolveSeedTokens`); MARKER parser BUILT (`driverSeed`); **the COPY executor is MISSING** (C1). Game-omni's copy logic (`run.mjs:1517-1551`) was not ported. |
| **project / merge** (POST) | **U7** (build-plan L97); template-format §4 "POST — `project`/`merge`: derive/validate from frozen on-disk inputs" | Derive a node's mechanical outputs from frozen inputs. | Executors BUILT (`applyProjectionOp`/`applyMergeOp`/`runMerge`) but for the **discriminated game-omni grammar**, not the template's `{to,from}` (G9/C3). Uncalled either way. |
| **arg channel** | **U8** (build-plan L98, `RunOptions` + `loadConfig`); handoff §2.3/§4 ("Arg delivery = `{{arg.<key>}}` token"); template-format §7 lists only RUN/WORKSPACE/state — **`arg` is a handoff-DECIDED extension, not yet in the spec doc** | `--arg k=v` → `loadConfig` → `RunOptions.args` → resolver ctx; `{{arg.x}}` resolves at launch; missing arg throws (like `MissingChannelError`). | NOT built anywhere: no `RunOptions.args`, no `ConfigArgs.args`, no `arg` branch in the resolver (G7). The template already USES `{{arg.prompt}}` (`w0/prompt.md:14`), so the consumer is ahead of the engine. **Spec gap: template-format §7 must add `{{arg.*}}` to the vocabulary** (parked-doc, not blocking). |
| **run-entry + instantiate** | **U8** (build-plan L98, "`init(${RUN})`"); D7/D9; template-format §10 | `init(${RUN})` materializes the thread (the four §10 buckets) then runs it; the run's canonical home is `.piflow/<wf>/runs/<id>/` (D9, a CLI/init-run default, NOT core). | `instantiateRun` BUILT + tested (`instantiate.test.ts`), uncalled by `runFromConfig` (G8). `loadTemplate`→`compile`→`runWorkflow` and `instantiateRun` are **two disconnected halves**: the loader makes the WorkflowSpec, the instantiator makes the `.pi/nodes/<id>/` folders, and nothing joins them. |

**Authoritative-source ruling where built code diverges from spec:** the **canon (U-units + template-format §4) is authoritative** for the op VOCABULARY — `{to,from}` is the authored language (C3). The **ported executors are the divergence** (they carry game-omni's discriminated grammar, ported "behavior-preserving" per the scope notes in `merge.ts:1-11`/`project.ts:1-12`). #17 resolves toward the canon (§4), not toward the port — see §4.

---

## 3. The solution (design) — the canonical wiring

The design realizes U6a/U7/U8 as they were specified; it does NOT invent a parallel model. Five lifecycle
insertion points, ONE resolver ctx threaded through all of them.

### 3.1 Carry the op-specs on the node (the missing channel — G1/G2)

`NodeSpec.hooks` (`{pre,post: Hook[]}`) is the generic plumbing type and is the WRONG home for the
declarative seed/promote/project/merge specs (they are DATA, not `Hook` fns). Add a SEPARATE, additive
field that carries the authored op-specs verbatim from `node.json`:

```ts
// types.ts — additive on NodeIntent + NodeSpec (both, since compile passes it through)
export interface NodeOps {
  seed?:    { to: string; from: string }[];
  project?: { to: string; from: string | string[] }[];
  merge?:   { to: string; from: string | string[] }[];
  promote?: { from: string; to: string; merge?: Reducer }[];
}
// NodeSpec / NodeIntent gain:  ops?: NodeOps;
```

Then `toNodeIntent` (`loader.ts:87`) and `instantiateRun`'s node copy carry `n.def.hooks` → `intent.ops`
unchanged (the node.json `hooks` block IS `NodeOps`). `compile` (dag.ts) passes `ops` through into the
dense `NodeSpec` (it already passes `hooks`). **No marker round-trip change** — the run loop reads
`node.ops` directly (the codec's `seed`/`promote` marker slots stay for the prompt-display path; #17/parked
codec gap is orthogonal). This is the smallest durable edit: one new optional field, one loader line, one
compile pass-through.

> *Rationale for a new field over compiling into `hooks.pre/post`:* the op executors need the resolver ctx
> + run/workspace roots + the barrier, which a `Hook.run` fn signature (`(ctx: HookContext)=>Promise<void>`)
> cannot express without smuggling state through a closure — exactly the D4 "closure footgun" the canon
> retired. Keeping `NodeOps` declarative lets the runner own the execution + ctx threading.

### 3.2 Build the resolver ctx ONCE per run; thread it (U7 + arg channel)

In `runWorkflow`, after `outDir` is resolved, build the run-level resolver inputs and load state once:

```ts
// runner.ts runWorkflow — additions
const workspace = opts.workspace ?? repoRoot;          // {{WORKSPACE}} (new RunOption; default repoRoot)
const runArgs   = opts.args ?? {};                      // {{arg.*}}     (new RunOption, see 3.5)
let state = await loadState(outDir);                    // {{state.*}} from ${RUN}/.pi/state.json (D6)
```

Per node, at launch, build the per-node `ResolveCtx = { run: outDir, workspace, state }` and resolve:

- **the prompt** (G4): `resolveTokens(node.prompt, ctx)` BEFORE `writeFile` at `runner.ts:469` — this is
  what makes `{{arg.prompt}}` (and any `{{RUN}}`/`{{WORKSPACE}}`/`{{state}}` left in prose) physical.
- **each seed `from`** (3.4) via `resolveSeedTokens(seed.from, ctx)` (already the right fn, just call it).
- **each project/merge/promote source path** via `resolveTokens`/`resolveSeedTokens` before the executor.

Extend `ResolveCtx` + `resolveTokens` with the `arg` branch (mirrors `state`):

```ts
// resolver.ts
export interface ResolveCtx { run: string; workspace: string; state?: RunState; args?: Record<string,string>; }
// add: const ARG_RE = /^arg\.([A-Za-z0-9_]+)$/;  → MissingArgError on absent key (sibling of MissingChannelError)
```

### 3.3 State load → seed-resolve → promote → barrier (U6a + U7 + D6)

Lifecycle, per stage (replacing the bare `Promise.all` at `runner.ts:787`):

1. **Before the stage:** state is already loaded (3.2); the parallel lanes each get a READ-ONLY copy of
   the current `state` in their `ResolveCtx` (seed/prompt `{{state.*}}` resolve against it).
2. **Per node (inside `runNode`):** after the model exits and artifacts verify, run the node's POST ops
   in order: `project` → `merge` → `promote`. `project`/`merge` write files under `outDir`. `promote`
   extracts each value (via `extractPromoteValue` with `{ run: outDir, returnValue }` — see 3.6) and
   collects a `NodeUpdate = { nodeId, promotes: ResolvedPromote[] }` — it does NOT write `state.json` (the
   "mechanical → driver hook" law, D6).
3. **At the stage barrier** (after `Promise.all` resolves, before the halt check): fold every lane's
   `NodeUpdate` via `barrierMerge(state, updates)` (serial, deterministic, `ConflictError` on a `set`
   channel with ≥2 writers — `promote.ts:119-136`), then `persistState(outDir, state)` ONCE. The next
   stage's nodes load the merged state via their ctx.

This is exactly LangGraph super-step semantics as the canon specifies (build-plan L151-158): independent
emits, one serial merge at the barrier, one write.

### 3.4 seed (PRE) — the missing executor (C1)

Add a tiny `stageSeed(seed: Seed, ctx, runDir)` to `ops/seed.ts` that ports the game-omni copy
(`run.mjs:1517-1551`): resolve `to` under `runDir`, `resolveSeedTokens(from, ctx)` → abs source; skip if
dest already filled (file: size>0; dir: every source top-level entry exists); dir source ⇒ `fs.cp(recursive)`,
file source ⇒ `fs.copyFile`. Call it from `runNode` in the PRE phase (alongside the existing `runHooks(pre)`
at `runner.ts:489`), once per `node.ops.seed[]`. This is the ONE place the `{{state.archetype}}`-bearing
seeds (gameplay/w1/w2) get resolved + staged.

### 3.5 The arg channel (U8 + handoff §2.3/§4)

- `RunOptions.args?: Record<string,string>` (`runner.ts`) + `ConfigArgs.args` + thread through `loadConfig`
  (parse `--arg k=v` repeats into a map; the CLI `piflow run` owns the flag).
- `ResolvedRunOpts` (`config.ts:45`) adds `'args'` to the `Pick`.
- `runFromConfig` passes `args` straight into `runWorkflow` (it already spreads `runOpts`).
- The resolver `arg` branch (3.2) makes `{{arg.prompt}}` physical at prompt staging.

### 3.6 Capture the structured `@return` (G5)

`extractPromoteValue`'s `@return:<field>` path needs the node's full structured return, which `lastJsonBlock`
discards (it narrows to `{status,summary,issues}`). Two options:
- **(a, minimal — recommended):** widen `lastJsonBlock`'s return type to `NodeReturn & Record<string,unknown>`
  (it already `JSON.parse`s the whole block; just stop narrowing the type) and pass the parsed object as
  `returnValue` into `extractPromoteValue`. Zero new parsing.
- (b) a separate `@return`-fence parser. Rejected — duplicates `lastJsonBlock`.

For the game-omni template specifically, the ONE promote (`w0-classify`) is `from:
'spec/classification.json:archetype'` — an ARTIFACT source, not `@return` — so 3.6 is **not on the critical
path for the first live run**, but it must ship for the `@return:` promote form to work at all. Land it in
the promote stage (Stage 3); it's a 2-line type widening.

### 3.7 run-entry + instantiate join (U8 + §10)

`runFromConfig` (or a new `runFromTemplate(templateDir, opts)` thin wrapper) becomes:
`loadTemplate(dir)` → `instantiateRun(dir, runDir, {workspace})` → `compile(spec)` → `runWorkflow(wf, {…, outDir: runDir, workspace})`.
This joins the two disconnected halves (G8). Core stays generic — the `.piflow/<wf>/runs/<id>/` convention
(D9) is the CLI/init-run default, NOT hardcoded in core (build-plan L329). Minimal version: add the
`loadTemplate`+`instantiateRun` calls to a new entry fn; leave `runFromConfig` (the WorkflowSpec path)
untouched for the existing consumers.

**Type/signature changes (complete list):**
- `types.ts`: `+ interface NodeOps`; `NodeSpec.ops?`, `NodeIntent.ops?`.
- `resolver.ts`: `ResolveCtx.args?`; `arg.*` branch + `MissingArgError`.
- `runner.ts`: `RunOptions.args?`, `RunOptions.workspace?`; ctx build + per-node resolve + the seed/project/merge/promote calls + barrier merge/persist.
- `ops/seed.ts`: `+ stageSeed(seed, ctx, runDir)`.
- `runner.ts` `lastJsonBlock`: widen return type (3.6).
- `config.ts`: `ConfigArgs.args`, `ResolvedRunOpts` adds `'args'`.
- `entry.ts`: `+ runFromTemplate` (the loadTemplate+instantiate join).
- (parked-doc) `template-format.md §7`: add `{{arg.*}}` to the vocabulary.

---

## 4. The #17 decision

**Decision: RE-AUTHOR the executors' dispatch to accept the canonical `{to,from}` authoring shape — by
adding a thin `{to,from}` adapter layer in core, NOT by re-migrating the template, and NOT by discarding
the discriminated executors.** Concretely:

- `seed {to,from}` → the NEW `stageSeed` copy (§3.4). Native fit; no adapter needed.
- `project {to,from|from[]}` and `merge {to,from|from[]}` → a thin **default executor** that does the
  generic thing the template's `{to,from}` means: **copy/concatenate `from` (one or many on-disk sources,
  resolved via the resolver) into `to`** (file copy for a single source; the existing `concat`/`fold`
  semantics for many). The DISCRIMINATED executors (`applyProjectionOp`'s `copy|assemble|merge`,
  `applyMergeOp`'s `concat|reconcile|fold|run`) are RETAINED and reachable when an op-spec carries a
  discriminator key — so a `from`-only spec routes to the default copy/concat, a `{concat:…}` spec routes
  to the rich executor. One dispatch function, two languages, no loss.

**Why this over the alternatives:**
- *Re-author the template to the discriminated shape (lossless re-migration)* — REJECTED. It fights the
  canon: §4 + the node.schema `derivedHook` (`node.schema.ts:166`) DEFINE `{to,from}` as the authored
  vocabulary. Re-authoring 10 merge + 1 project hooks into `{concat|reconcile|…}` would (a) require the
  init-template skill to emit game-omni's internal op grammar, (b) break the schema gate (`derivedHook`
  rejects a `concat` key — `additionalProperties:false`), and (c) make the template non-generic. The
  authored language is `{to,from}`; the engine must execute it.
- *Discard the discriminated executors* — REJECTED. They are real, tested, and are the consumer-op grammar
  game-omni's `genres.json projections` DATA still uses (`project.ts` scope note). Keep them.

**Blast radius:**
- **Touches:** `ops/project.ts` + `ops/merge.ts` (add the `{to,from}` default branch + a dispatch shim);
  `ops/seed.ts` (the new `stageSeed`); the run loop (calls them). New tests for the `{to,from}` path.
- **Does NOT touch the T3 codec** — the run loop reads `node.ops` directly (§3.1); the `parseMarkers`/
  `emitMarkers` round-trip is the prompt-display path and is the SEPARATE parked #17-codec gap (handoff
  §5). They don't collide.
- **Does NOT touch the migration / `extractWorkflow`** — the committed template is already in the canonical
  `{to,from}` shape; the migrate-test (`migrate-game-omni.test.ts`) asserts DAG structure only and stays
  green.
- **Does NOT touch the template schema** — `derivedHook`/`seedHook`/`promoteHook` already encode `{to,from}`.

---

## 5. Staged implementation plan (ordered; each stage names its test-first gate + stub-vs-live)

Dependency order: **S0 → S1 → S2 → S3 → S4 → S5 → S6 (live)**. S0 unblocks any live run; S1 is the spine
the rest hang on. S2–S4 are the op families (independent of each other once S1 lands; can fan out). S5 joins
the entry. S6 is the live attempt.

> The runner is already driven offline by injected `buildCommand`/`execRunner` stubs + the in-memory
> provider (`runner.test.ts` pattern, `RunOptions.buildCommand`/`execRunner`/`provider`). EVERY spine stage
> below is **stub-verifiable**: a stub `execRunner` returns a canned stdout (incl. a fenced `@return` JSON);
> a stub `buildCommand` writes the seeded/expected artifact; the in-memory provider's `downloadDir` copies
> it back. The model is never called. Only S6 needs the live gateway.

| Stage | Changes (files) | Test-first gate (the assertion that goes RED if the wiring is wrong) | Stub or live | Commit (`type(scope): subject`) |
|---|---|---|---|---|
| **S0** | Register `submit_result` (+ any other declared builtin) in `BUILTIN_TOOLS` (`tools/registry.ts`) — OR resolve the policy with the human (is `submit_result` a real pi builtin?). | `tools-verify`/`tools` test: `verifyToolBinding({allow:['submit_result',…]}, registry.list()).ok === true`. RED today (unknown address). | **stub** | `fix(tools): register submit_result builtin so migrated nodes bind` |
| **S1** | `NodeOps` type + `NodeSpec.ops`/`NodeIntent.ops` (`types.ts`); loader carries `hooks→ops` (`loader.ts:87`); `compile` passes `ops` (`dag.ts`); `ResolveCtx.args` + `arg.*` branch + `MissingArgError` (`resolver.ts`); `RunOptions.args`/`.workspace` (`runner.ts`); build ctx + `resolveTokens(node.prompt,ctx)` at `:469`. | (a) `load-template` test: a node with a `hooks` block surfaces `intent.ops.seed/promote`. (b) `resolver` test: `resolveTokens('{{arg.prompt}}', {…,args:{prompt:'hi'}})==='hi'`; absent arg THROWS `MissingArgError`. (c) `runner` test: a staged prompt containing `{{arg.x}}` is resolved on disk (assert via the recording provider's `writeFile` capture). Mutation check: break the `arg` branch → (b)/(c) RED. | **stub** | `feat(core): carry node ops + resolve {{arg}}/{{state}} at node launch` |
| **S2** | `stageSeed` (`ops/seed.ts`); call per `node.ops.seed` in `runNode` PRE (`runner.ts` ~:489) with the node ctx. | `ops-seed` test: a `{to,from}` seed of a fixture file lands at `${RUN}/<to>` with the source bytes; a token-bearing `from` (`{{state.archetype}}`) resolves against ctx.state; an already-filled dest is NOT re-staged (idempotency). Runner-integration: a node with a seed has its dest present before exec. | **stub** | `feat(ops): seed PRE executor — stage {to,from} skeletons (ports run.mjs copy)` |
| **S3** | promote wiring: per-node `extractPromoteValue` → `NodeUpdate`; `barrierMerge` + `persistState` at the stage barrier (`runner.ts:787`); widen `lastJsonBlock` (`:204`) + feed `returnValue` (§3.6). | `runner`-integration test: a stage of 2 nodes that each `promote` a channel ends with `${RUN}/.pi/state.json` holding BOTH (merged); a downstream node's `{{state.x}}` resolves to the promoted value; a `set` channel promoted by 2 PARALLEL lanes throws `ConflictError`. Mutation: skip `persistState` → next-node `{{state}}` resolution RED. | **stub** (canned stdout supplies the artifact + the `@return` fence) | `feat(core): promote + barrier-merge wired into the run loop (D6)` |
| **S4** | project/merge dispatch shim + `{to,from}` default executor (`ops/project.ts`,`ops/merge.ts`); call per `node.ops.project/merge` in `runNode` POST; (opportunistic) write `io.json` `promotes[]` via `writeNodeIo` (C5). | `ops-merge`/`ops-project` test: a `{to, from:[a,b]}` merge concatenates a+b into `to`; a discriminated `{concat:…}` spec STILL routes to the rich executor (no regression on the existing ported tests). Runner-integration: a node's `merge` output exists post-node. | **stub** | `feat(ops): {to,from} default project/merge dispatch (canonical authoring shape)` |
| **S5** | `runFromTemplate(templateDir, opts)` join: `loadTemplate`→`instantiateRun`→`compile`→`runWorkflow` (`entry.ts`); `loadConfig` parses `--arg k=v`→`args` (`config.ts`); `ResolvedRunOpts` adds `'args'`. | `entry`/`config` test: `runFromTemplate` over the `template-min` fixture materializes `${RUN}/.pi/nodes/<id>/` AND runs (with stub exec) to a terminal `run.json`; `loadConfig({args:{...}, '--arg a=b'})` yields `args:{a:'b'}`. | **stub** | `feat(core): runFromTemplate joins loadTemplate+instantiate+run (U8)` |
| **S6** | none (config/creds only) — the real headless run of `.piflow/game-omni/template/`. | Manual gate: W0 reaches `ok` (classification.json written, `archetype` promoted to state.json), W1 seed staged, the run progresses past the producer barrier. Judged against the criteria fixture, NOT a unit test (prompt/skill artifact = an eval, per `test-discipline`). | **LIVE** (minnimax gateway) | (no code commit; a run record + a memory note) |

---

## 6. Live-run readiness

**What a real headless run needs (S6):** the minnimax.chat gateway (provider `mmgw`, model M3) — set ONCE
in `pi-runner/.env` per the memory (`pi-runtime-on-minnimax-gateway`); never pass provider/model on the CLI.
Time: a full 16-node game-omni run is long (multi-node, real generation) — expect to run in the background
and monitor via `piflow logs`/`watchRun`. The `${WORKSPACE}` must resolve to the game-omni checkout
(skills + templates + genres + modules live there) — for a `local` provider that's the live tree
(build-plan "decision 1": local = LIVE `${WORKSPACE}`).

**Which nodes run with only the state spine vs need the op layer:**
- **w0-classify** — needs S0 (tool bind) + S1 (prompt `{{arg.prompt}}` resolve) + S3 (its ONE `promote`
  of `archetype`). NO seed, NO project/merge. So **W0 is reachable after S0+S1+S3** (the minimal live
  slice). Its promote is an ARTIFACT source (not `@return`), so 3.6 isn't required for W0.
- **w1-design / gameplay / w2-scaffold** — need S2 (their `{{state.archetype}}`-bearing seeds) → require
  the FULL state spine (state must be persisted by W0's barrier first). gameplay also has a `project`;
  w2-scaffold + the producer lane have the bulk of the `merge` ops → need S4.
- **the 5-wide producer lane + W4 milestones** — need S4 (merge) end-to-end.

**Fully verifiable OFFLINE with a stub (no gateway):** S0–S5 in their entirety. The runner's injected
`execRunner`/`buildCommand` + the in-memory provider prove: tool-bind passes (S0), tokens resolve at launch
(S1), seeds stage (S2), promotes land in `state.json` + barrier-merge + ConflictError (S3), project/merge
derive (S4), and the template materializes + runs to a terminal `run.json` (S5). The ONLY thing a stub
cannot prove is that a REAL model, given the resolved prompt + staged seed, produces a valid artifact — that
is S6, and it is an eval against the criteria fixture, not a unit test.

---

## 7. Recommended scope for THIS unit

**Recommendation: land S0 + S1 + S2 + S3 as ONE coherent unit ("the state spine + the first live slice"),
defer S4/S5 to a fast follow, and run S6 as a separate gated step.**

Reasoning:
- S0–S3 are **tightly coupled run-loop work** sharing the per-node `ResolveCtx` + the stage barrier — they
  cannot be cleanly isolated to separate worktrees without each re-deriving the ctx threading. They are
  ONE idea ("the runtime resolves tokens, stages seeds, and flows state through the barrier"). They are
  ALSO exactly what unblocks the **W0 live slice** (the smallest end-to-end proof: prompt resolves →
  classify → promote → state.json) — a high-value, low-risk milestone.
- S4 (project/merge `{to,from}`) and S5 (the template entry join) are **separable**: S4 is the op-family
  fan-out (independent executors, parallelizable); S5 is a thin entry wrapper. Landing them as a second
  unit keeps each commit one idea and lets the W0 slice prove the spine BEFORE the heavier producer-lane
  ops go in. (Per the working pattern in handoff §3, S4's two executors could even fan out to subagents.)
- S6 (live) must follow S4 to reach past W0 — but a W0-only live confirmation is worth taking after S3, as
  the first real-gateway signal that the spine holds.

So: **Unit A = S0–S3 (+ a W0 live smoke), Unit B = S4–S5 (+ the full live run S6).** The human decides
whether to also fold S4/S5 into Unit A; the coupling argument favors splitting.

---

## 8. Open questions / risks (surfaced, not invented)

1. **`submit_result` semantics (S0 blocker).** Is `submit_result` a REAL pi-native builtin (just missing
   from `BUILTIN_TOOLS`), or a game-omni convention that should map to an existing builtin / be dropped from
   the template's `tools.allow`? The fix differs (register it vs re-author 16 nodes' tools vs alias). **Cannot
   resolve from this repo** — needs the pi tool catalog / the game-omni run.mjs tool handling. HALT-and-ask
   before S0. (Confirmed present: every node declares it; confirmed absent from `BUILTIN_TOOLS`.)
2. **`{{state.archetype}}` inside a NESTED `{file:field}` seed token (w2-scaffold).** `w2-scaffold` seed
   `from` is `{{WORKSPACE}}/templates/{templates/modules/{{state.archetype}}/genre.json:genres.0.coreBase}`
   — a `{{state}}` token INSIDE a `{file:field}` drill. `resolveSeedTokens` does phase-1 `{{…}}` then
   phase-2 `{file:field}` (`seed.ts:42-56`), so the inner `{{state.archetype}}` resolves first — but verify
   the ORDER holds when the state token is nested inside the `{…}` drill braces (the `oneToken` regex
   `/\{([^:{}]+):([^{}]+)\}/` excludes inner braces). **Needs a unit test in S2** to confirm; if it breaks,
   it's a resolver-ordering fix, not a redesign.
3. **`${RUN}` ≠ `outDir` collection mismatch.** The runner stages reads from `outDir` and `downloadDir`s the
   node's output back to `outDir` (`runner.ts:460-511`), but seed/project/merge write under `${RUN}` (=
   `outDir` for a local run). For a WORKTREE/remote provider, `scope.root` ≠ `outDir`. The ops resolve
   `{{RUN}}` to `outDir` (the collection namespace), while the model runs in `scope.root` — confirm the ops
   write to the place the model later reads. For the **local provider** (the S6 posture) `scope.root ===
   repoRoot` and `outDir` is the run dir, so this is fine; flag for worktree/remote (out of S6 scope).
4. **D9 run home (`.piflow/<wf>/runs/<id>/`) ownership.** Core must stay generic (build-plan L329) — the
   `.piflow/` convention is the CLI/init-run default. S5's `runFromTemplate` should take `runDir` as a
   param, NOT hardcode the convention. Confirm the CLI (`piflow run`) is where the `.piflow/<wf>/runs/<id>/`
   default lives. (Non-blocking; a design constraint on S5.)
5. **`io.json` ledger (C5) — in or out of this unit?** `writeNodeIo` is unwired but non-blocking (observe
   falls back to `run.json`). It IS the natural home for `promotes[]`. Recommend folding the `promotes[]`
   record into S3/S4 opportunistically, but it can be its own parked unit if S3 grows. Flag for the human.
6. **Parked-doc: `template-format.md §7` lists only RUN/WORKSPACE/state.** The `{{arg.*}}` token is
   handoff-DECIDED (§4) but not in the spec doc. Add it when S1 lands (a docs edit, not blocking).
