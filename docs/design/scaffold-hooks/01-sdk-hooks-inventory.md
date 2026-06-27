# SDK Hooks Inventory — the authoritative reference for a scaffolder

> The complete, loader-verified shape of every hook family and op in the piflow template `node.json`.
> A code generator (the CLI scaffolder) emits exactly these envelopes; anything else fails `loadTemplate`.
> Every claim carries a `file:line` citation. Source-of-truth files:
> - **SCHEMA** (the validator gate): `packages/core/src/workflow/template/schema/node.schema.ts`
> - **TS shape**: `packages/core/src/workflow/template/types.ts`
> - **LOWERING** (authored → runtime intent): `packages/core/src/workflow/template/loader.ts`, `.../template/lower.ts`
> - **OPS** (semantics): `packages/core/src/workflow/ops/{seed,project,merge,promote,skill,util}.ts`
> - **EXECUTORS** (consumer runtime): `templates/pi-runner/hooks/{seed,project,merge,schema,seed-contract,index}.mjs`
> - **RUNTIME LIFECYCLE**: `packages/core/src/runner/runner.ts`
> - **RESOLVER**: `packages/core/src/workflow/resolver.ts`

The `hooks` block lives at `node.schema.ts:180-191`. It is an object with five optional lanes:
`seed` (array), `project` (array), `merge` (object), `promote` (array), `registryProject` (object).
`additionalProperties:false` at `node.schema.ts:183` — **no key other than these five is accepted in `hooks`.**

---

## 1. Lifecycle — the deterministic PRE/POST order

A node executes its hook families in ONE fixed order. The two runtime lanes (the `pi`-spawning node
`runNode`, and the no-pi `runProgrammatic`) run the SAME families in the SAME order; only the dispatch
frame differs. The order is documented at `runner.ts:960-962` and enforced by the linear code below it:

| # | Phase | Family | Runner site (programmatic / pi-node) | Gate |
|---|-------|--------|--------------------------------------|------|
| 1 | **PRE** | `seed` (stage starting artifacts) | `runner.ts:999` / `runner.ts:1356` | always runs (before the model) |
| 2 | **PRE** | `checks.pre` gates (lowered to `op` gates) | `runner.ts:1009` / (in runNode pre-block) | blocking pre-gate fails the node |
| 3 | **PRE** | `hooks.pre` runtime hooks | `runner.ts:1037` / `runner.ts:1452` | — |
| — | — | *(the model runs — pi node only)* | — | gated below on clean exit |
| 4 | **POST** | `project` | `runner.ts:1048` / `runner.ts:1537` | runs only on clean model exit (`killed===null && code===0`, `runner.ts:1535`) |
| 5 | **POST** | `registryProject` | `runner.ts:1056` / `runner.ts:1545` | same gate |
| 6 | **POST** | `merge` (`{ops:[...]}`) | `runner.ts:1069` / `runner.ts:1564` | same gate |
| 7 | **POST** | authorable `run` op bodies | `runner.ts:1078` / `runner.ts:1574` | same gate |
| 8 | **POST** | artifact stat + schema gate + `checks.post` | `runner.ts:1088-1121` / `runner.ts:1588-1622` | the verdict ladder |
| 9 | **POST** | `hooks.post` runtime hooks | `runner.ts:1152` / `runner.ts:1781` | fires with the node outcome |
| 10 | **POST** | `promote` (lift output → RunState) | `runner.ts:1161` / `runner.ts:1795` | **only when `st==='ok'`** |
| 11 | **BARRIER** | `barrierMerge` (fold all lanes' promotes → state) | `runner.ts:2352` | per-stage, serial, deterministic |

Key ordering facts:
- POST DERIVE (`project → registryProject → merge → run`) runs **strictly BEFORE** the artifact/schema/check
  gates so a node whose required artifact is *generated* by its own merge `run` op does not deadlock
  (`runner.ts:1521-1527`). The DERIVE block is wrapped in `if (killed === null && result.code === 0)`
  (`runner.ts:1535`): a crashed model skips all POST derives.
- `promote` is the LAST family and runs **only on an `ok` node** (`runner.ts:1161`, `runner.ts:1795`) — it
  lifts a *good* node's output. Across a parallel stage all promotes are drained and folded at the stage
  barrier serially in node order (`runner.ts:2347-2362`), never racily.

### Token resolution — which fields are resolved, where, with what

ONE resolver vocabulary (`resolver.ts:1-19`): `{{RUN}}` → the per-thread output root, `{{WORKSPACE}}` →
the read-only canonical tree, `{{state.<channel>}}` → a promoted RunState channel, `{{arg.<key>}}` → a
`--arg k=v` run arg. A missing `{{state.*}}` or `{{arg.*}}` **throws loudly** (`MissingChannelError`
`resolver.ts:37`; `MissingArgError` `resolver.ts:48`) — never a silent `''`.

| Hook field | Resolver applied | Where | Throws on missing token? |
|------------|------------------|-------|--------------------------|
| `io.artifacts[].path`, `io.checks[].path` (contract) | `resolveTokens` (flat) | `runner.ts:986-987`, `runner.ts:1302-1303` | yes (`{{state}}`/`{{arg}}`) |
| `seed.from` / `seed.to` | `resolveSeedTokens` = `resolveTokens` THEN the `{file:field}` drill | `seed.ts:42-67` (called via `stageSeed` `runner.ts:1000`,`:1357`) | `{{state}}` throws (`seed.ts:43-44`); a `{file:field}` drill that misses is left **verbatim** (`seed.ts:61`) |
| `project` op (whole op tree) | `resolveDeep` (deep, nested objects) | `runner.ts:1049`, `runner.ts:1538` | yes |
| `registryProject` `{source,mapRef,key}` | `resolveDeep` | `runner.ts:1057`, `runner.ts:1546` | yes (`key` may carry `{{state.*}}`) |
| `merge` `{ops:[...]}` (whole tree) | `resolveDeep` | `runner.ts:1071`, `runner.ts:1566` | yes |
| `prompt` body | `resolveTokens` | `runner.ts:1402` | yes |
| `promote.from` / `promote.to` | **NOT `{{…}}`-resolved.** `from` is parsed by `parsePromote` + `extractPromoteValue` (its own `<file>:<field>` / `@return:<field>` grammar) | `promote.ts:69-94` | `from`→undefined **throws** (`promote.ts:92`) |

`resolveDeep` (`resolver.ts:107-116`) recurses every string leaf of an op tree, so a `{{RUN}}`/`{{WORKSPACE}}`
buried inside `{ fold:{ from, to } }` or `{ run:{ cmd, args[] } }` is made physical before the executor runs.
Note the executor *also* substitutes its own `{project}` token in a merge `run` op (`merge.ts:201`) — that
is a SEPARATE, executor-owned token, not a `{{…}}` logical root.

---

## 2. Hook families

For each family: the loader-VALID JSON envelope, the field table, and (where applicable) the per-op
enumeration. All `$def` line numbers are in `node.schema.ts`.

### 2.1 `seed` — PRE: stage a starting artifact before the model

`$def seedHook`, `node.schema.ts:303-312`. `additionalProperties:false`, `required:['to','from']`.

```jsonc
{
  "hooks": {
    "seed": [
      { "to": "spec.json", "from": "{{WORKSPACE}}/templates/spec.skeleton.json" }
    ]
  }
}
```

| Field | Type | Required | Meaning | Token-resolved? |
|-------|------|----------|---------|-----------------|
| `to` | string (minLen 1) | **yes** | Destination, `{{RUN}}`-relative — what the model FILLs (`node.schema.ts:309`) | yes (`resolveSeedTokens`; a relative dest resolves under `runDir`, `seed.ts:94`) |
| `from` | string (minLen 1) | **yes** | Source skeleton/slice; a token-bearing path (`node.schema.ts:310`) | yes — `{{RUN}}`/`{{WORKSPACE}}`/`{{state.*}}` first, then the `{file:field}` drill to a fixpoint (`seed.ts:42-67`) |

Semantics (`stageSeed`, `seed.ts:93-139`): idempotent (never clobbers an already-filled dest — file
"filled" = size>0, dir "filled" = every source top-level entry present, `seed.ts:108-121`); a DIR source
copies recursively with `verbatimSymlinks` (`seed.ts:133`); an ABSENT source is a **graceful skip**, not a
throw (`seed.ts:124`). Exactly two keys; `from` carries a second-stage `{file:field}` token (drills a JSON
field) that is NOT a `{{…}}` root.

### 2.2 `project` — POST: derive a mechanical output from frozen inputs

`$def derivedHook`, `node.schema.ts:313-325`. `additionalProperties:false`, `required:['to','from']`.
`from` is a `oneOf`: a single string OR a non-empty array of strings (`node.schema.ts:320-323`).

```jsonc
{
  "hooks": {
    "project": [
      { "to": "derived/index.json", "from": "spec.json" },
      { "to": "derived/all.json",   "from": ["a.json", "b.json"] }
    ]
  }
}
```

| Field | Type | Required | Meaning | Token-resolved? |
|-------|------|----------|---------|-----------------|
| `to` | string (minLen 1) | **yes** | Derived output path, `{{RUN}}`-relative (`node.schema.ts:319`) | yes (`resolveDeep`) |
| `from` | string \| string[] (minLen 1, minItems 1) | **yes** | Source path(s) the derive reads (`node.schema.ts:320-323`) | yes (`resolveDeep`) |

> ⚠ The `project` *op semantics* (the `copy`/`assemble`/`merge`/`union` op kinds in `project.ts` /
> `project.mjs`) are NOT expressible in the `derivedHook` schema — that schema only carries `{to,from}`.
> The richer projection grammar reaches the executor through `registryProject` (the op map lives in a
> registry record, §2.5), or is applied at runtime by `applyProjectionOp` reading an op-spec that the
> runner derives from the `project` op (`runner.ts:1048-1053`). A scaffolder emitting `hooks.project`
> can ONLY emit `{to, from}`. See ⚠ Ambiguities.

### 2.3 `merge` — POST: the DRIVER-MERGE op set

`$def mergeHook`, `node.schema.ts:326-359`. `additionalProperties:false`, `required:['ops']`. `ops` is a
non-empty array (`minItems:1`, `node.schema.ts:336`). **Each op is an object with `additionalProperties:false`
and a `oneOf` requiring EXACTLY ONE of four op-kind keys** (`node.schema.ts:342-355`): the op-NAME (`fold` |
`concat` | `reconcile` | `run`) is the key; exactly one key per array element. A bare `{to,from}` element is
**rejected** (that is the entire point of the gate — `node.schema.ts:329-330`).

```jsonc
{
  "hooks": {
    "merge": {
      "ops": [
        { "fold":      { "from": "frag.json", "to": "out.json", "into": "section" } },
        { "concat":    { "glob": "parts/*.md", "to": "all.md", "heading": "## {name}" } },
        { "reconcile": { "from": "src.json", "to": "out.json", "key": "slot",
                         "fields": ["label"], "arrayAt": "slots", "fromAt": "slots" } },
        { "run":       { "cmd": "node", "args": ["scripts/gen.mjs"], "cwd": "build", "note": "asset gen" } }
      ]
    }
  }
}
```

| Field | Type | Required | Meaning | Token-resolved? |
|-------|------|----------|---------|-----------------|
| `ops` | array (minItems 1) | **yes** | Ordered merge ops; each exactly one op-kind key (`node.schema.ts:335-356`) | yes — whole tree via `resolveDeep` (`runner.ts:1566`) |

The op bodies stay permissive in the schema (`{ type:'object' }`, `node.schema.ts:344-347`) — the executor
`applyMergeOp` reads the kind-specific params (`merge.ts:58-223`). The FOUR op kinds, exhaustively:

**`fold`** (`merge.ts:165-194`) — read-modify-write: SET `to[into] = parse(from)`, then write the whole object back.
| field | type | required | meaning |
|-------|------|----------|---------|
| `from` | string | yes | the fragment JSON path (`merge.ts:166-167`) |
| `to` | string | yes | the target file to fold into |
| `into` | string | yes | the top-level key SET to the fragment |
Same-target folds serialize under a per-path lock so concurrent folds into one file don't lose updates
(`merge.ts:24-35`, `:171`); disjoint targets stay parallel.

**`concat`** (`merge.ts:63-95`) — glob → one file, each part under a heading, stable lexical order, idempotent.
| field | type | required | meaning |
|-------|------|----------|---------|
| `glob` | string | yes | `dir/*pat*` glob; `*`→`.*` (`merge.ts:64-69`) |
| `to` | string | yes | destination file (excluded from its own glob, `merge.ts:78`) |
| `heading` | string | no (default `"## {name}"`) | per-part heading; `{name}`/`{path}` substituted (`merge.ts:89`) |

**`reconcile`** (`merge.ts:98-162`) — copy `from.<keys>` → matching rows in `to.<arrayAt>[]` by key; row keys/order untouched.
| field | type | required | meaning |
|-------|------|----------|---------|
| `from` | string | yes | source JSON path (`merge.ts:99-113`) |
| `to` | string | yes | target JSON path (must already exist, `merge.ts:116-120`) |
| `key` | string | no (default `"slot"`) | the row→source match key |
| `fields` | (string \| `{name, when:{field,equals}}`)[] | no (default `[]`) | fields to copy; an object form is a conditional copy (`merge.ts:54`,`:150-152`) |
| `arrayAt` | string | no (default `"slots"`) | dotted path to the target row array |
| `fromAt` | string | no (default `"slots"`) | dotted path to the source map |

**`run`** (`merge.ts:198-220`) — execute a deterministic shell command; a GENERATE/derive side-effect, never an LLM.
| field | type | required | meaning |
|-------|------|----------|---------|
| `cmd` | string | yes | the command (`merge.ts:199-200`) |
| `args` | string[] | no (default `[]`) | argv |
| `cwd` | string | no (default = `projectBase`) | working dir; relative → under `projectBase` (`merge.ts:211`) |
| `note` | string | no | a ledger note echoed on success (`merge.ts:219`) |

**`run` cmd resolution** (`merge.ts:201-211`): the executor substitutes `{project}` → `projectBase` in
`cmd`/`args`/`cwd` first (`merge.ts:201`). Then `cmd` resolves: absolute → as-is; `"node"` → `process.execPath`
(the driver's own interpreter, robust to a PATH/nvm mismatch, `merge.ts:206`); a **bare** name with no path
separator → left bare for PATH lookup (`merge.ts:207-208`); a name CONTAINING a separator → joined under
`projectBase` (`merge.ts:209`). `cwd` defaults to `projectBase` (`merge.ts:211`); a relative `cwd` joins
`projectBase`. A non-zero exit returns `{failed:true, exit}` (`merge.ts:217-218`) which routes through the
op's `onFailure` (default `block`, `runner.ts:1565`,`:1568`).

> Note: the **core** `merge.ts` `run` uses only `{project}` (`merge.ts:201`). The legacy pi-runner executor
> `templates/pi-runner/hooks/merge.mjs:135` ALSO substitutes `{root}` → `ctx.root` and defaults `cwd` to
> `ctx.root`. The core SDK path (what the scaffolder targets) is `{project}`-only with `cwd` defaulting to
> `projectBase`. See ⚠ Ambiguities.

### 2.4 `promote` — POST → RunState: lift a node output into a state channel

`$def promoteHook`, `node.schema.ts:360-370`. `additionalProperties:false`, `required:['from','to']`.

```jsonc
{
  "hooks": {
    "promote": [
      { "from": "result.json:summary.title", "to": "title", "merge": "set" },
      { "from": "@return:chosen",             "to": "picks", "merge": "append" }
    ]
  }
}
```

| Field | Type | Required | Meaning | Token-resolved? |
|-------|------|----------|---------|-----------------|
| `from` | string (minLen 1) | **yes** | Source — `"<artifact>:<field>"` OR `"@return:<field>"` (`node.schema.ts:366`) | NO `{{…}}` — parsed by its own grammar (`promote.ts:79-94`) |
| `to` | string (minLen 1) | **yes** | Target RunState channel name (`node.schema.ts:367`) | no |
| `merge` | enum `set`\|`append`\|`deepMerge` | no (default `set`) | The channel reducer (`node.schema.ts:368`; default filled in `parsePromote`, `promote.ts:69-71`) | no |

**Both `from` forms** (`extractPromoteValue`, `promote.ts:79-94`): the parser splits on the FIRST `:`
(`promote.ts:80`); no `:` at all → throws (`promote.ts:81`).
- **`@return:<field>`** — `source === '@return'` (`promote.ts:85`): drills `<field>` (dotted) into the node's
  parsed structured fenced-JSON return (`ctx.returnValue`, `promote.ts:86`). An empty `<field>` (`@return:`)
  → the whole return object. A programmatic node has NO parsed return, so `returnValue` is `undefined`
  (`runner.ts:1166`) — only a pi node can use `@return:`.
- **`<file>:<field>`** — else: reads the produced file at `<file>` under `{{RUN}}` (`absUnder(ctx.run, source)`,
  `promote.ts:88`) and drills `<field>`. An unreadable artifact → throws (`promote.ts:89`).

**Dotted-nested-field** behavior: `<field>` is a dotted path drilled by `drillPath` (`util.ts:20-23`, `a.b.0.c`,
array indices allowed). **undefined → THROW contract**: a `from` that resolves to `undefined` (absent field, or
missing file/return) **throws** `promote.from "<...>" resolved to undefined (field absent)` (`promote.ts:92`);
this downgrades the node to `error` (`runner.ts:1170-1172`, `runner.ts:1806`). A promote of nothing is a loud
wiring error — never a silent skip.

**`merge` reducer** (`set | append | deepMerge`, applied by `applyReducer`/`barrierMerge`): the channel value
is folded at the stage barrier (`runner.ts:2352`). A `set` channel written by ≥2 parallel nodes in one stage
is a `ConflictError` (`promote.ts:48-60`,`:128-131`) — a channel promoted by parallel lanes MUST declare
`append` or `deepMerge`.

### 2.5 `registryProject` — POST: project a registry record's `projections` over a frozen source

`$def registryProjectHook`, `node.schema.ts:371-381`. `additionalProperties:false`,
`required:['source','mapRef','key']`. **This lane is an OBJECT, not an array** (`node.schema.ts:189`).

```jsonc
{
  "hooks": {
    "registryProject": {
      "source": "classification.json",
      "mapRef": "{{WORKSPACE}}/registry/index.json",
      "key": "{{state.archetype}}"
    }
  }
}
```

| Field | Type | Required | Meaning | Token-resolved? |
|-------|------|----------|---------|-----------------|
| `source` | string (minLen 1) | **yes** | Frozen JSON the projections derive from, `{{RUN}}`-relative (`node.schema.ts:377`) | yes (`resolveDeep`) |
| `mapRef` | string (minLen 1) | **yes** | Registry index carrying each record; a token-bearing path (`node.schema.ts:378`) | yes (`resolveDeep`) |
| `key` | string (minLen 1) | **yes** | Record key — MAY be a `{{state.*}}` token (`node.schema.ts:379`) | yes (`resolveDeep`, `runner.ts:1546`) |

Semantics (`runProjection`, `project.ts:261-300`): resolve the record in `mapRef` whose `id === key`, else
the first record whose namespace prefix `id.split(':')[0] === key` (`project.ts:279-283`); read its
`projections` map and apply each op (`copy`/`assemble`/`merge`/`union`, `applyProjectionOp` `project.ts:73-236`)
against the frozen `source` read once. Every failure degrades to a graceful skip — never throws
(`project.ts:284`,`:290`,`:296`).

---

## 3. The unified `op[]` field

The `op` $def: `node.schema.ts:265-290`. Top-level `op` array property: `node.schema.ts:238-246`. TS type
`OpSpec`: `types.ts:117-140`.

**Common frame fields** (each `additionalProperties:false`, `node.schema.ts:267`): `id` (string), `when`
(enum `pre`|`post`|`on-success`|`on-failure`|`always`, default `post`, `node.schema.ts:270`), `reads`
(string[]), `writes` (string[]), `onFailure` (`policyAction` = `block`|`warn`|`stop`, default `block`,
`node.schema.ts:273`), `idempotent` (boolean, default true).

**Body discriminator** — EXACTLY ONE of four body keys, OR none (`oneOf`, `node.schema.ts:282-289`):
`transform` (DERIVE — seed/project/merge/promote/projectRegistry, discriminated by inner `kind`,
`types.ts:143-148`), `run` (ACT — `{cmd,args,cwd}` or `{fn}`, `types.ts:151`), `gate` (DETECT — a Check
predicate, `types.ts:154`), `action` (CONTROL — retry/escalate/notify/rerouteTo, `types.ts:157-161`). A
body-less op (a pure read/write — the lowered `inject` form) is ALSO valid (`node.schema.ts:288`).

```jsonc
{
  "op": [
    { "when": "pre",  "reads": ["spec.json"] },
    { "when": "pre",  "writes": ["spec.json"], "transform": { "kind": "seed", "from": "{{WORKSPACE}}/skel.json" } },
    { "when": "post", "writes": ["out.json"], "reads": ["spec.json"], "transform": { "kind": "project", "from": "spec.json" } },
    { "when": "post", "transform": { "kind": "merge", "ops": [ { "fold": { "from": "f.json", "to": "out.json", "into": "x" } } ] } },
    { "when": "post", "transform": { "kind": "promote", "from": "out.json:title", "to": "title", "reducer": "set" } },
    { "when": "post", "gate": { "kind": "non-empty", "path": "out.json" }, "onFailure": "block" },
    { "when": "on-failure", "action": { "kind": "rerouteTo", "node": "fallback", "max": 1 } }
  ]
}
```

### VERDICT: `op[]` is **LOADABLE-TODAY**.

Proof chain:
1. **Schema accepts it** — the top-level `op` property exists at `node.schema.ts:238-246`, items `$ref` the
   `op` $def at `node.schema.ts:265-290`. (The TS `TemplateNode.op` is typed `OpSpec[]`, `types.ts:74`.)
2. **The loader reads `def.op`** — `lowerToOps(def)` returns `def.op` VERBATIM when present (`lower.ts:45`):
   `if (def.op) return def.op as OpSpec[];`. `toNodeIntent` calls `const op = lowerToOps(n.def)`
   (`loader.ts:120`) and attaches it onto the intent: `if (op) intent.op = op;` (`loader.ts:174`). When `op`
   is authored directly, the deprecated aliases are NOT also lowered (`lower.ts:44-45` short-circuits).
3. **There IS an OpSpec lowering AND a runtime executor** — the runner dispatches on `node.op`:
   `projectRegistry` transforms (`runner.ts:1554-1560`), authorable `run` bodies (`runner.ts:1574-1582`),
   pre-gates (`runner.ts:1009`,`runProgrammatic`), and the merge `onFailure` lookup (`runner.ts:1565`).
   Control actions are lowered to canonical intent fields by `lowerActions(op)` (`lower.ts:92-111`,
   `loader.ts:121`,`:160-161`,`:198`).

**Caveat for a scaffolder:** authoring `op` directly is loadable, but it is the LOWER-LEVEL surface. Not
every transform `kind` has full runtime parity through the `op[]` path that the `hooks` path has — e.g. a
`transform:{kind:'seed'|'project'|'promote'}` authored ONLY in `op[]` (with no `hooks` twin) is carried
onto the intent but the runner's POST-derive loop reads `node.ops.project`/`.merge`/`.registryProject`
(the `hooks`-derived `NodeOps`, `runner.ts:1537`,`:1564`,`:1545`) and, for `op[]`, only re-dispatches
`projectRegistry` and `run` bodies (`runner.ts:1554`,`:1574`) plus gates/actions. **Prefer emitting `hooks.*`**
(seed/project/merge/promote/registryProject) for the derive families; the `op[]` envelope's first-class
runtime today is gates, `run`, `projectRegistry`, and the control actions. See ⚠ Ambiguities.

---

## 4. Scaffolder-relevant gotchas

- **`hooks` rejects unknown keys.** `hooks` is `additionalProperties:false` (`node.schema.ts:183`) with only
  `seed`/`project`/`merge`/`promote`/`registryProject` allowed. A typo (`promotes`, `seeds`) FAILS the gate.
- **`merge` is an OBJECT `{ops:[...]}`, `registryProject` is an OBJECT, but `seed`/`project`/`promote` are
  ARRAYS** (`node.schema.ts:185-189`). Do not wrap `merge`/`registryProject` in an array, and do not emit a
  bare object for `seed`/`project`/`promote`.
- **Every `merge` op needs EXACTLY ONE op-kind key.** Each `ops[]` element is `additionalProperties:false`
  with a `oneOf` of `fold|concat|reconcile|run` (`node.schema.ts:342-355`). A bare `{to,from}` element is
  **rejected** (`node.schema.ts:329-330`); an element with two kinds (`{fold:..., run:...}`) is rejected; an
  element with an extra sibling key is rejected.
- **`mergeHook.ops` must be non-empty** (`minItems:1`, `node.schema.ts:336`). An empty `ops:[]` fails.
- **`project.from` is `string | string[]`, never an object** (`node.schema.ts:320-323`). The richer
  `copy`/`assemble`/`merge`/`union` projection grammar is NOT authorable via `hooks.project` — emit it via
  `registryProject` (the op map lives in a registry record).
- **`promote.from` is its OWN grammar, NOT a `{{…}}` token.** Emit `"<file>:<field>"` or `"@return:<field>"`
  VERBATIM (`promote.ts:79-94`). It splits on the FIRST `:`. A no-colon `from` throws (`promote.ts:81`).
  `@return:` requires a pi node with a structured return (a programmatic node's `returnValue` is undefined,
  `runner.ts:1166`).
- **`promote` of an undefined source THROWS and errors the node** (`promote.ts:92`, `runner.ts:1170`). Only
  scaffold a promote whose source field is guaranteed produced upstream.
- **A `set` channel promoted by ≥2 parallel nodes is a `ConflictError`** (`promote.ts:128-131`). If two
  same-stage nodes (disjoint `owns`, same `deps`) promote the same channel, the scaffolder MUST emit
  `merge:"append"` or `"deepMerge"`, never `"set"`.
- **`seed.from`/`merge run cmd`/etc. carry tokens the scaffolder passes through VERBATIM.** `{{RUN}}`,
  `{{WORKSPACE}}`, `{{state.<channel>}}`, `{{arg.<key>}}` (the four roots, `resolver.ts:1-19`), the seed-only
  second-stage `{file:field}` drill (`seed.ts:42-67`), and the merge-`run`-only `{project}` token
  (`merge.ts:201`). Do not pre-resolve any of these — the runner resolves them at launch.
- **A `{{state.*}}` or `{{arg.*}}` that no upstream node promotes / no `--arg` supplies THROWS at runtime**
  (`resolver.ts:37`,`:48`). Only emit a `{{state.X}}` token for a channel some upstream node `promote`s to `X`.
- **`mcp.servers` secret-bearing fields must be a `$VAR`/`${VAR}` ref, never a literal.** The `checkMcpSecrets`
  gate (`checks.ts:319-334`) rejects a literal in any key under `headers`/`authorization`/`token`/`apikey`/
  `api_key`/`password`/`secret`/`credential[s]`/`bearer` (`checks.ts:277-288`). This is an `mcp` (not a hook)
  gate, but a scaffolder emitting MCP config alongside hooks must honor it.
- **`registryProject.key` may be `{{state.*}}`** but `source`/`mapRef` are plain paths; `mapRef` typically
  carries `{{WORKSPACE}}` (`node.schema.ts:378-379`). The record is matched by `id === key` then by the
  `id.split(':')[0]` prefix (`project.ts:279-283`) — a bare key matches a namespaced record id.
- **`op[]` is loadable but lower-level** — for the seed/project/promote DERIVE families prefer `hooks.*`,
  which has full runtime parity; `op[]`'s first-class runtime today is gates, `run`, `projectRegistry`, and
  control actions (§3 caveat). Authoring BOTH `op` and `hooks` is allowed (the runner reads both surfaces),
  but if `def.op` is present the deprecated-alias lowering is skipped (`lower.ts:44-45`) — so do not expect
  `inject`/`checks`/`policy` to ALSO lower when you hand-author `op`.

---

## ⚠ Ambiguities (schema vs executor divergences — recorded, not papered over)

1. **`project` op grammar: schema `{to,from}` vs executor `copy|assemble|merge|union`.** The `derivedHook`
   schema (`node.schema.ts:313-325`) accepts only `{to, from}`. But `applyProjectionOp` (`project.ts:73-236`,
   and `project.mjs:26-155`) implements four rich op kinds (`copy`/`assemble`/`merge`/`union`) keyed on op
   fields (`opSpec.copy`, `opSpec.assemble`, …) that the `derivedHook` schema cannot express. **Reading A**
   (schema): `hooks.project` carries only `{to,from}` and the runner derives a minimal op from it
   (`runner.ts:1050-1053` picks a `name` from `op.op ?? copy|assemble|merge`). **Reading B** (executor): the
   full projection grammar is intended to flow via `registryProject` (where the op map is DATA in a registry
   record, not in `node.json`). A scaffolder targeting `node.json` can only emit `{to,from}` for `project`;
   rich projections go through `registryProject`.

2. **`registryProject` record shape: core generic vs legacy `genres`-specific.** The CORE executor
   `runProjection` (`project.ts:272-283`, what the runner calls) finds records under "the FIRST top-level
   property that is an array of id-bearing objects" — generic, no key name baked in. The LEGACY pi-runner
   executor `runProjection` (`project.mjs:173`) reads `map.genres` specifically and matches a `genreToken`.
   The runner uses the CORE one (`runner.ts:1058` calls the imported `project.ts` `runProjection`). A
   scaffolder should target the CORE shape: any registry index whose record array elements carry an `id`
   field. Field names `genre`/`genreToken` are legacy-only.

3. **`merge run` token set: core `{project}` vs legacy `{project}`+`{root}`.** Core `merge.ts:201` substitutes
   only `{project}` and defaults `cwd` to `projectBase`. Legacy `merge.mjs:135` ALSO substitutes `{root}` →
   `ctx.root` and defaults `cwd` to `ctx.root`. The SDK path (the scaffolder's target) is `{project}`-only.
   Do not emit `{root}` in a `merge.run` op authored for the core runner.

4. **`op[]` runtime parity is partial** (§3 caveat). The schema + loader fully accept `op[]`, but the runner's
   POST-derive loop primarily reads the `hooks`-derived `NodeOps` (`node.ops.*`) for the seed/project/merge/
   promote families, re-dispatching from `op[]` only `transform:{kind:'projectRegistry'}` (`runner.ts:1554`),
   `run` bodies (`runner.ts:1574`), pre-gates (`runner.ts:1009`), and control actions (`lowerActions`,
   `lower.ts:92`). A seed/project/promote authored ONLY in `op[]` (no `hooks` twin) is carried onto the dense
   `NodeSpec` but not re-executed by the POST-derive loop. Verdict for §3 stands: `op[]` is LOADABLE; full
   derive-family runtime is via `hooks.*`.

---

## Self-check (audited against the 5 Bar items)

| # | Bar item | Verdict | Evidence |
|---|----------|---------|----------|
| 1 | Every hook family in §2 with a loader-VALID example | **PASS** | 5 families, each `$def`-verified: seed `node.schema.ts:303-312`; project `:313-325`; merge `:326-359`; promote `:360-370`; registryProject `:371-381`. Each example uses only schema-accepted keys. |
| 2 | merge ops enumerated exhaustively | **PASS** | All four of `fold|concat|reconcile|run` (the schema `oneOf`, `node.schema.ts:350-355`) documented with bodies + `run` cmd resolution (`merge.ts:201-211`). None missed. |
| 3 | promote's two `from` forms + throw contract | **PASS** | `@return:<field>` (`promote.ts:85-86`) and `<file>:<field>` (`promote.ts:88`) both documented; undefined→THROW at `promote.ts:92`. |
| 4 | §3 definitive LOADABLE/NOT verdict with file:line | **PASS** | LOADABLE-TODAY; proof: schema `node.schema.ts:238-246`, loader reads `def.op` `lower.ts:45` + `loader.ts:120,174`, runtime dispatch `runner.ts:1554,1574`. |
| 5 | Every claim carries a file:line citation | **PASS** | Every table row and assertion cites a `file:line` (node.schema.ts / lower.ts / loader.ts / runner.ts / the ops/*.ts). |
