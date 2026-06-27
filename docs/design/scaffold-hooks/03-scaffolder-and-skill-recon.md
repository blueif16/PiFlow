# 03 — Scaffolder & Skill Recon (implementation map for emitting node `hooks`)

**Scope.** WHERE and HOW the `piflowctl add-node` scaffolder must grow to emit `node.hooks`, and how to
restructure the `piflow-init` skill's references to document hook authoring. Read-only recon — the build is
delegated separately. All paths repo-root-relative (`~/Desktop/piflow`); line numbers are as of this read.

---

## 1. Scaffolder extension points (exact edit sites)

The scaffolder is `packages/cli/src/scaffold.ts`. Emitting hooks touches FOUR sites, in this order.

### 1a. `NodeOpts` interface — add the hook fields (after `programmatic`, `scaffold.ts:80`)
`NodeOpts` (`scaffold.ts:39-81`) is a flat options bag; every block in `buildNode` reads one or more fields
off it. The five hook families (from `node.schema.ts:180-191` `$defs`) need carriers. Recommended minimal set
(strings the CLI parses, NOT raw schema objects — keep the flat repeatable-flag idiom):

```ts
  /** PRE-hook: stage an input before the model. Each "to=from" → hooks.seed[] (seedHook). */
  seed?: Array<{ to: string; from: string }>;
  /** POST → RunState: lift a node output into a state channel. "from->to[:merge]" → hooks.promote[]. */
  promote?: Array<{ from: string; to: string; merge?: 'set' | 'append' | 'deepMerge' }>;
  /** POST derive (project): "to=from[,from2]" → hooks.project[] (derivedHook). */
  project?: Array<{ to: string; from: string | string[] }>;
  /** POST merge run-op: "cmd arg arg" → hooks.merge.ops[].run. (fold/concat/reconcile are NOT flag-able — too structured; see note.) */
  mergeRun?: Array<{ cmd: string; args?: string[]; cwd?: string; note?: string }>;
  /** POST derive (registryProject): all three required. */
  registryProject?: { source: string; mapRef: string; key: string };
```

Rationale for the split: `seed`, `promote`, `project`, `registryProject` are flat 2–3-field records that map
cleanly onto a `k=v` / `from->to` flag string. `merge` is `{ ops: [ {<opKind>: {...}} ] }` where `fold` /
`concat` / `reconcile` carry permissive nested bodies (`mergeHook`, `node.schema.ts:326-358`) — those are NOT
reducible to a single flag value and should be left to hand-authoring (flag the `run` op only, the common
"shell out to a gen script" case from learning-record G2). State this boundary explicitly in §4's reference.

### 1b. `buildNode()` — assemble `node.hooks` (insert AFTER `contract`, BEFORE `checks`)
`buildNode` (`scaffold.ts:109-145`) appends optional blocks in a deliberate authored order. The `contract`
block is assembled at **`scaffold.ts:132-138`**; `checks` at **139-141**; `policy` at **142**;
`programmatic` at **143**. Insert the hooks assembly **between line 138 (end of `contract`) and line 139
(`checks`)** so the emitted file mirrors the real fixtures (`node.json` ordering in the live examples is
`contract → checks → policy → hooks`, see `template-min/nodes/*/node.json`; matching that keeps emitted files
diff-clean against hand-authored ones). Place it as:

```ts
  // (after node.contract = {...}, scaffold.ts:138)
  const hooks: Record<string, unknown> = {};
  if (opts.seed?.length) hooks.seed = opts.seed.map((s) => ({ to: s.to, from: s.from }));
  if (opts.project?.length) hooks.project = opts.project.map((p) => ({ to: p.to, from: p.from }));
  if (opts.mergeRun?.length)
    hooks.merge = { ops: opts.mergeRun.map((m) => ({ run: { cmd: m.cmd, ...(m.args ? { args: m.args } : {}), ...(m.cwd ? { cwd: m.cwd } : {}), ...(m.note ? { note: m.note } : {}) } })) };
  if (opts.promote?.length)
    hooks.promote = opts.promote.map((p) => ({ from: p.from, to: p.to, ...(p.merge ? { merge: p.merge } : {}) }));
  if (opts.registryProject) hooks.registryProject = opts.registryProject;
  if (Object.keys(hooks).length) node.hooks = hooks;
```

Emit each family ONLY when its opt is set (the existing minimal-file discipline, e.g. `mcp` at `:125`,
`checks` at `:139`). `node.hooks` is one key; the SUB-keys (`seed`/`project`/`merge`/`promote`/
`registryProject`) are independently omittable per the schema (`additionalProperties:false`, no `required`).

### 1c. `parseArgs` flags — reuse the repeatable pattern (no parser change needed)
`parseArgs` (`scaffold.ts:184-204`) already collects every value-flag into a **repeatable list** (`flags[key]
??= []).push(val)`, `:201`). New hook flags need NO parser change — they are value-flags. Add small
field-parsers beside the existing `parseMcp` (`:207-216`) and `parseCheck` (`:219-222`):

| flag (repeatable) | value grammar | parsed → `NodeOpts` field | precedent |
|---|---|---|---|
| `--seed` | `to=from` | `seed[]` | `parseMcp` (splits on first `=`) |
| `--promote` | `from->to` or `from->to:merge` | `promote[]` | `parseCheck` (splits on first delim) |
| `--project` | `to=from[,from2,…]` | `project[]` (from = string or array) | `parseMcp` + comma-split RHS |
| `--merge-run` | `cmd arg arg …` (shell-split, first token = cmd) | `mergeRun[]` | new tiny splitter |
| `--registry-project` | `source,mapRef,key` (single, not repeatable in practice) | `registryProject` | 3-way split |

Then wire them into the `scaffoldAddNode(dir, {...})` call in `runAddNodeCli` (`scaffold.ts:264-287`), beside
`checks: (flags.check ?? []).map(parseCheck)` (`:284`):
```ts
    seed: (flags.seed ?? []).map(parseSeed),
    promote: (flags.promote ?? []).map(parsePromote),
    project: (flags.project ?? []).map(parseProject),
    mergeRun: (flags['merge-run'] ?? []).map(parseMergeRun),
    registryProject: flags['registry-project']?.[0] ? parseRegistryProject(flags['registry-project'][0]) : undefined,
```
All are value-flags, so `runAddNodeCli`'s `parseArgs(argv, ['programmatic'])` boolFlags arg (`:255`) is
UNCHANGED (no new bool).

### 1d. `ADD_USAGE` string + `cli.ts` help block
Two help surfaces, both must gain a "Hooks:" line:
- **`ADD_USAGE`** (`scaffold.ts:226-231`) — the one-line usage echoed on a missing `--id`. Append a hooks
  clause after the Gates clause (`:229`):
  `[--seed <to=from>]... [--promote <from->to[:merge]>]... [--project <to=from[,from2]>]... [--merge-run <cmd args>]... [--registry-project <source,mapRef,key>]`
- **`cli.ts` HELP, the ADD-NODE section** (`cli.ts:71-79`) — add a `Hooks:` bullet alongside `Edges/contract`
  / `Tools/io` / `Gates` / `Routing` (`cli.ts:73-77`), e.g.:
  `Hooks: --seed <to=from> (PRE) · --promote <from->to[:merge]> · --project <to=from> · --merge-run <cmd…> · --registry-project <source,mapRef,key> (each repeatable).`

### 1e. CRITICAL — the clobber question. **Merge/preserve mode: NOT needed. Flag-only emission is correct; do NOT add a merge mode.**
`scaffoldAddNode` does `fs.writeFile(nodeJson, toJson(buildNode(opts)))` (`scaffold.ts:166`) — an
**unconditional overwrite**. This is not a bug to paper over; it is the load-bearing design contract, stated
three ways in the codebase:
- The file header (`scaffold.ts:4-9`): config is *"overwritten freely (it is a deterministic function of the
  flags — re-run it, don't edit it)"*; only `prompt.md` (PROSE) is agent-owned and never touched.
- The test `re-emitting a node overwrites node.json but never touches an existing prompt.md`
  (`scaffold.test.ts:97-108`) ASSERTS the overwrite (`artifacts: ['b.md']` replaces `['a.md']`) and asserts
  the sibling prose is preserved.
- The division-of-labor comment block (`scaffold.ts:4-9`) names `node.json` as CLI-owned, deterministic.

Therefore hooks emitted **from flags** are fine — a re-run regenerates them from the same flags. The only
clobber risk is a HAND-AUTHORED hook (an author hand-edits `node.json` to add a `merge.fold` that has no flag,
then re-runs `add-node` and loses it). **Resolution: keep the deterministic-overwrite contract; close the gap
NOT with a merge mode but by COVERAGE + DOCS:**
1. Make the common cases flag-emittable (the five families above) so authors rarely need to hand-edit.
2. For the genuinely un-flag-able structured cases (`merge.fold`/`concat`/`reconcile` bodies) the reference
   (§4) must state the rule: *those are hand-authored; once you hand-author a hook into `node.json`, that
   node is "graduated" — stop re-running `add-node` on it (re-run regenerates from flags and drops the
   hand edit), edit the file directly.* This mirrors the existing `prompt.md` boundary (CLI owns config,
   you own prose) — extended to "CLI owns flag-expressible config; you own structured hand-edits."

A merge/preserve mode would BREAK the "deterministic function of the flags" invariant the whole scaffolder
rests on (a re-run would no longer be reproducible — it would depend on prior file state), reintroducing the
exact drift the CLI/prose split exists to prevent. **Verdict: no merge mode; coverage + a documented
graduation rule.** If a future need for hand-edit preservation is proven, the right hook point is a NEW
explicit flag (`--preserve-hooks` reading + re-merging the existing `node.hooks` before writeFile at
`scaffold.ts:166`), opt-in and loud — never the silent default.

---

## 2. Test harness facts (test-first can start immediately)

- **Runner: vitest.** `scaffold.test.ts:1` imports `{ describe, it, expect, beforeEach, afterEach } from
  'vitest'`. Not `node:test`.
- **The test file to extend: `packages/cli/test/scaffold.test.ts`** (109 lines, 4 `it` cases). A hooks feature
  extends THIS file — same `describe` block, same fixtures.
- **The oracle is `loadTemplate` (the real §8 compile gate), NOT a JSON snapshot.** The harness
  (`scaffold.test.ts:8-12` header) emits a template into a `mkdtemp` dir (`beforeEach`, `:15-17`), simulates
  the agent's prose half with `writeProse` (`:27-28`, writes each `nodes/<id>/prompt.md` — required because
  `loadTemplate`'s `checkRefs` treats a missing prose body as a dangling ref), then calls the REAL
  `loadTemplate(DIR)` (`@piflow/core`, imported `:5`) + `compile(spec)`. A dropped required field / mis-wired
  dep makes `loadTemplate` THROW and the test goes red. No loader mock — the emitted JSON is the JSON the
  engine actually accepts.
- **Assertion styles in use:** (a) round-trip — `loadTemplate` resolves + `spec.nodes` / `wf.stages` shape
  (`:52-61`); (b) direct JSON read — `readJson(node.json)` then `expect(node.contract.owns).toEqual(...)`
  (`:73-75`, `:89-94`); (c) CLI parity — `runNewCli`/`runAddNodeCli` produce the same fields as the builder
  (`:78-95`); (d) idempotent-overwrite + prose-preservation (`:97-108`).

**How a test-first hooks test would look (the red mutation).** Add an `it` that scaffolds a 2-node template
where node A `promote`s a field to a state channel and node B reads `{{state.X}}` in a `seed` source — then
asserts both that `loadTemplate` resolves (hook schema valid AND the promoted channel satisfies B's
`{{state.X}}` consumer, so `checkChannels` doesn't flag a dangling channel) AND that the emitted
`node.json.hooks.promote` / `.seed` equal the expected objects via `readJson`. **It must FAIL when the code is
wrong:** before `buildNode` assembles `node.hooks`, the `--promote`/`--seed` flags are silently dropped → the
emitted file has no `hooks` key → node B's `{{state.X}}` has no promoting upstream → `loadTemplate`'s
`checkChannels` THROWS `dangling channel`. That throw is the failing signal; it turns green only once
`buildNode` actually emits the `promote`+`seed` blocks. (Mutation test for the assertion's teeth: delete the
`hooks.promote =` line in `buildNode` and confirm the test reddens.) A weaker test that only `readJson`-checks
the object without a `{{state.X}}` consumer would still catch a dropped field but NOT a mis-wired channel —
include the consumer to exercise the real gate.

---

## 3. Concrete hook examples (verbatim — the scaffold targets)

### From `learning-records/0002-...` G2 — the `merge.run` envelope (was schema-rejected on first guess)
> The REAL shape: the op-NAME is the discriminant KEY, body permissive:
> ```jsonc
> "hooks": { "merge": { "ops": [ { "run": { "cmd": "npm", "args": ["run","lesson:scaffold","--","--id","{{arg.lessonId}}"], "cwd": "{{WORKSPACE}}/remotion-svg-primitives", "note": "…" } } ] } }
> ```

For `run`: *`cmd` bare → resolved on PATH (special-case `node` → `process.execPath`); `cwd` defaults to repo
root, absolute honored; `{{WORKSPACE}}`/`{{arg.*}}`/`{{state.*}}` resolved BEFORE the executor.* (G2,
`0002:44-46`.)

### From `0002` E1 — the `promote` `@return:` block (the in-place state-threading pattern)
> the producing root node (`setup-scaffold`) declares
> `hooks.promote:[{from:"@return:camelLessonId",to:"camelLessonId"},{from:"@return:composition",to:"composition"}]`,
> sets `returnMode:"required"`, returns the two values … and every downstream node uses
> `{{state.camelLessonId}}`/`{{state.composition}}`. Live proof: after setup-scaffold,
> `.pi/state.json = {"camelLessonId":"kptestCountToTwo","composition":"CompleteKptestCountToTwoLesson"}`

Two `promote.from` forms: `"<artifact>:<field>"` (file-source, resolves under `{{RUN}}` via `absUnder`) and
`"@return:<field>"` (drills the node's validated structured RETURN, no filesystem — REQUIRED for in-place
nodes whose source file is not under `{{RUN}}`; G5, `0002:70-79`). The `extractPromoteValue` file-source form
does NOT `resolveTokens` first, so a `{{WORKSPACE}}`-rooted file source mis-resolves — prefer `@return:`
(E-note, `0002:307`).

### From `0002` G3 — the deterministic lifecycle (ordering the scaffolder must respect)
> `seed` = PRE (stage inputs before the model); `project`/`merge`/`promote` = POST (after the model). Within
> POST the order is `project → merge → promote` — load-bearing: a `merge.run` that GENERATES a file must run
> before a `promote` that READS it. … the deterministic lifecycle once:
> `seed → [model] → project → merge → promote → (stage barrier merges state)`.

### From the live fixtures — real `node.json` hooks (one per family)
- **`promote`** (`packages/core/test/fixtures/template-min/nodes/w0-classify/node.json:22-24`):
  ```json
  "hooks": {
    "promote": [{ "from": "spec/classification.json:archetype", "to": "archetype", "merge": "set" }]
  }
  ```
- **`seed`** (`.../nodes/w2a-levels/node.json:23-25`):
  ```json
  "hooks": {
    "seed": [{ "to": "spec/level-skeleton.json", "from": "{{WORKSPACE}}/templates/modules/{{state.archetype}}/level-skeleton.json" }]
  }
  ```
- **`project`** (`.../nodes/w2b-assets/node.json:18-20`):
  ```json
  "hooks": {
    "project": [{ "to": "public/assets/manifest.json", "from": ["spec/classification.json", "public/assets"] }]
  }
  ```
  (Note `project.from` is a string OR an array — `derivedHook`, `node.schema.ts:313-325`.)

### `registryProject` shape (from `enrich-contract.md:28` + `registryProjectHook`, `node.schema.ts:371-381`)
> `registryProject: { source: spec/blueprint.json, mapRef: {{WORKSPACE}}/templates/genres.json, key: {{state.archetype}} }`
All three (`source` · `mapRef` · `key`) are **required**.

**Schema authority for the scaffolder (`node.schema.ts`):** `hooks` = `{seed[],project[],merge,promote[],
registryProject}` (`:180-191`); `seedHook` requires `{to,from}` (`:303-312`); `derivedHook`(=project) requires
`{to,from}`, from = string|array (`:313-325`); `mergeHook` = `{ops:[…]}`, each op EXACTLY ONE of
`fold|concat|reconcile|run`, a bare `{to,from}` is REJECTED (`:326-358`); `promoteHook` requires `{from,to}`,
optional `merge ∈ {set,append,deepMerge}` (`:360-370`); `registryProjectHook` requires `{source,mapRef,key}`
(`:371-381`). The scaffolder must emit these EXACT shapes or `loadTemplate` rejects.

---

## 4. Skill + references structure recommendation

### Current reference inventory (`.claude/skills/piflow-init/references/`)
| file | purpose | length | style |
|---|---|---|---|
| `enrich-contract.md` | the per-target construction recipes the LLM applies after a mechanical port (hooks · state-promotion · vocab translation · policy/checks) | 60 ln | terse, numbered §, a marker→hook TABLE + verbatim exemplars; one focused job |
| `parse-claude-workflow.md` | the PORT bridge: what the `.js`→template script recovers vs what the LLM must construct | 77 ln | prose + a "must construct" bar |
| `agent-presets/README.md` | the agent-type preset contract + how to author one | 83 ln | contract + index |
| `agent-presets/<id>.md` (6) | ONE preset per file (explore, plan, interview, market-research, paper-analyzer, general-purpose) | 13–31 ln | one tightly-scoped doc per variant |
| `fixtures/sample-workflow.js` | a port input fixture | — | — |

**Pattern observed:** references are SHORT (13–83 ln) and SINGLE-PURPOSE; a multi-variant topic
(agent-presets) is split **one-file-per-variant under a subdir + a README index**, not crammed into one long
file. `SKILL.md` is already 398 lines (near its budget) and DELEGATES depth to references (the file list at
`SKILL.md:352-391` is pure pointers).

### Recommendation: **one-file-per-hook-family under `references/hooks/`, plus a README index** — mirror `agent-presets/`, do NOT use a single `hooks.md`.
Justification: (1) the user's stated intent — *"different references to guide different projects on how to
scaffold for each of the hooks and each of the ways"* and *"don't cram everything in the field"* — maps
exactly to one-per-family. (2) It matches the established `agent-presets/<id>.md` + `README.md` precedent (the
only other multi-variant reference). (3) The five families have genuinely different grammars (promote's two
`from` forms; merge's op-discriminant + the `run` body; seed PRE vs the POST trio; registryProject's
registry-record dependency) — a single `hooks.md` would be long and force a reader past four irrelevant
families. (4) It keeps `SKILL.md` lean: the existing "Split MECHANICAL from INTELLIGENT" bullet
(`SKILL.md:297-307`) and the hook law gain ONE pointer line to `references/hooks/README.md`, not inline
prose.

**Proposed files (each ≤ ~50 ln, matching `enrich-contract.md`'s density):**
| path | one-line purpose |
|---|---|
| `references/hooks/README.md` | the hook MODEL: the PRE/POST lifecycle (`seed → [model] → project → merge → promote`, G3), the family→flag table, the schema-authority pointer (`node.schema.ts:180-191`), and the "which family for which job" router |
| `references/hooks/seed.md` | PRE — stage an input before the model: `--seed to=from`, `seedHook {to,from}`, the FILL-don't-COMPOSE skeleton pattern, token-bearing `from` |
| `references/hooks/promote.md` | POST → RunState: `--promote from->to[:merge]`, BOTH `from` forms (`<artifact>:<field>` vs `@return:<field>` — prefer `@return:` for in-place, E1/G5), the `set|append|deepMerge` reducer, and the E2 caution (never write a literal `{{state.X}}` in the promoting node's own prose) |
| `references/hooks/project.md` | POST derive: `--project to=from[,from2]`, `derivedHook` (from = string\|array), when to use `project` vs `registryProject` |
| `references/hooks/merge.md` | POST merge: the `{ops:[{<kind>:…}]}` envelope, EXACTLY-ONE-kind discriminant, the `run` op body (`cmd/args/cwd/note`, G2) flag-emittable via `--merge-run`, and the **graduation rule** (fold/concat/reconcile are hand-authored — once hand-edited, stop re-running `add-node` on that node; §1e) |
| `references/hooks/registry-project.md` | POST derive from a registry record: `registryProjectHook {source,mapRef,key}`, the projections-map-in-registry pattern (enrich-contract §3), `key` as a `{{state.*}}` token |

**SKILL.md edits (pointers only, no inline craft):** add `references/hooks/README.md` to the file list
(`SKILL.md:375` area, beside `parse-claude-workflow.md`); add one pointer in the "Split MECHANICAL from
INTELLIGENT" bullet (`SKILL.md:297-307`) — *"the per-family authoring grammar + the scaffolder flags:
`references/hooks/`"*. Fold the existing `enrich-contract.md` §1 hook TABLE into `references/hooks/README.md`
(or cross-link it) so there is ONE canonical hook-family table, not two drifting copies.

---

## Self-check (audit vs the 4 Bar items)

1. **§1 names exact NodeOpts/buildNode/parseArgs/ADD_USAGE sites + resolves clobber — PASS.** NodeOpts add
   after `:80`; buildNode insert between `:138`–`:139` (contract→checks); parseArgs unchanged (repeatable
   `:201`) + new field-parsers beside `parseMcp`/`parseCheck`; ADD_USAGE `:226-231` + cli.ts HELP `:71-79`.
   Clobber verdict: **no merge mode** — overwrite is the deterministic-function-of-flags contract
   (`scaffold.ts:4-9,166` + test `:97-108`); close the hand-edit gap with coverage + a documented graduation
   rule; a merge mode would break reproducibility.
2. **§2 identifies real test file + runner — PASS.** vitest (`scaffold.test.ts:1`), file
   `packages/cli/test/scaffold.test.ts`, oracle = real `loadTemplate`; red mutation = dropped hooks → dangling
   `{{state.X}}` channel throw.
3. **§3 quotes promote + merge verbatim (+ seed/project/registryProject) — PASS.** merge.run envelope (G2),
   promote `@return:` block (E1) + the live `w0-classify` promote, plus seed/project fixtures, all verbatim
   with line cites.
4. **§4 concrete reference paths + purposes justified by existing style — PASS.** one-per-family under
   `references/hooks/` + README, mirroring `agent-presets/`; 6 concrete paths each with a one-line purpose;
   justified by the user's "don't cram" intent + the 398-line SKILL.md budget.
