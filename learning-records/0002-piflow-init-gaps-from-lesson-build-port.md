# 0002 — piflow-init skill gaps (first real PORT: animation-test `lesson-build`, 14 nodes / 10 stages)

**Purpose.** A LIVING backlog captured while porting a real, battle-tested Claude `.js` workflow
(`animation-test/.claude/workflows/lesson-build.js`) into a `.piflow/lesson-build/template/`. Every entry
is something the **`piflow-init` skill did NOT tell me** and I had to (a) hand-dig from the piflow repo
source, (b) guess at and get wrong, or (c) was left unclear about. The goal of recording it: strengthen
`piflow-init` (+ `template-format.md`) into a **self-contained, referenced** guide so the next port needs
**zero source-spelunking and zero guessing**.

**Meta-directive that frames the whole port (user, this session):** author the template the **SDK's way**
— do NOT preserve the legacy `lesson-build.js`/monolith FORM. Use the port output only for FACTS (what each
node reads / writes / runs / which skill it loads); author the contract layer (tools · inject · checks ·
hooks · owns · returnMode) in the SDK's canonical idioms. `piflow-init` should state this as the PORT law:
*the realized prompt is a fact source, not a format to transliterate.* (Today the skill says "port = the
floor" but doesn't warn against carrying legacy idioms — e.g. I reflexively carried the `owns: _logs/*`
pattern and it broke; see G11.)

Severity: **B** = blocked me / made me guess wrong; **C** = cost time, had to verify; **D** = directive/meta.

---

## B — gaps that blocked or produced a wrong guess

### G1 · The authoritative `node.json` field set is not in the skill
`template-format.md §3` is an illustrative `jsonc` block, not the authoritative schema. To author correctly
I read `packages/core/src/workflow/template/types.ts` (`TemplateNode`) for the real fields:
`tools · mcp · inject · timeoutMs · retries · model · provider · tier · contract{artifacts,owns,readScope,
schema,returnMode,fillSentinel} · checks{pre,post:[{kind,path,param,severity}]} · policy:Record<string,string>
· hooks{seed,project,merge,promote,registryProject} · return · checkpoint · fusion`.
**Skill fix:** reference `template/types.ts` + `template/schema/*.ts` as the authoritative shape, or inline a
field table. The skill must name the file the loader actually validates against.

### G2 · The `hooks.merge` / `run`-op JSON shape is undocumented → my first author attempt was schema-rejected
Skill only says "merge (fold/concat/reconcile/run)". I wrote `hooks.merge.ops:[{kind:'run',cmd,cwd}]` →
`loadTemplate` rejected it (`must have required property 'fold'/'concat'/'reconcile'/'run'; must match exactly
one schema in oneOf; must NOT have additional properties`). The REAL shape: the op-NAME is the discriminant
KEY, body permissive:
```jsonc
"hooks": { "merge": { "ops": [ { "run": { "cmd": "npm", "args": ["run","lesson:scaffold","--","--id","{{arg.lessonId}}"], "cwd": "{{WORKSPACE}}/remotion-svg-primitives", "note": "…" } } ] } }
```
Source: `template/schema/node.schema.ts` `$defs/mergeHook` (oneOf required-key per op) + executor
`templates/pi-runner/hooks/merge.mjs:129-155` (the `run` body = `{ cmd, args=[], cwd, note }`).
**Skill fix:** document the merge-op ENVELOPE (`{ ops: [ { <opName>: {…} } ] }`, exactly one op key per
element, no extra keys) + each op body. For `run`: `cmd` bare → resolved on PATH (special-case `node` →
`process.execPath`); `cwd` defaults to repo root, absolute honored; `{{WORKSPACE}}`/`{{arg.*}}`/`{{state.*}}`
resolved BEFORE the executor; `{project}`/`{root}` are executor-owned tokens.

### G3 · PRE-vs-POST hook timing + execution order undocumented
`seed` = PRE (stage inputs before the model); `project`/`merge`/`promote` = POST (after the model). Within
POST the order is `project → merge → promote` — load-bearing: a `merge.run` that GENERATES a file must run
before a `promote` that READS it. Had to infer from `runner.ts:1032-1036` (`runProjection` then `runMerge`) +
the promote barrier semantics. **Skill fix:** state the deterministic lifecycle once:
`seed → [model] → project → merge → promote → (stage barrier merges state)`.

### G4 · The IN-PLACE workflow model is entirely absent (the single biggest gap)
The skill + `example-basic` assume every artifact lives under `{{RUN}}` (a fresh per-run dir). But a
repo-MUTATING pipeline — `lesson-build` writes `lesson-data/`, `src/lessons/`, `public/audio/`, `out/`
directly in the working tree, and shells out to repo npm scripts that need the real repo layout — cannot run
in an isolated `{{RUN}}` dir. It needs **artifacts/owns/readScope under `{{WORKSPACE}}`**, with `{{RUN}}`
holding ONLY the `.pi/` metadata. I had to PROVE the engine supports this by reading source:
- `runner.ts:1042` verifies artifacts via `path.resolve(ctx.outDir, a.path)` → `path.resolve` returns an
  **absolute** `a.path` AS-IS (ignores `outDir`), so `{{WORKSPACE}}`-absolute artifacts are stat()'d directly. ✓
- `workflow/ops/util.ts:45` `absUnder = (base, rel) => isAbsolute(rel) ? rel : join(base, rel)` → all ops
  honor absolute paths too. ✓
**Skill fix:** add a first-class **"in-place vs run-isolated"** section: when each applies; that absolute
`{{WORKSPACE}}` artifacts/owns/readScope are fully honored by the gate AND every op; and that an in-place
node's `promote` must use `@return:` (its source file is NOT under `{{RUN}}`) — see G5. This pattern is the
default for "port an existing repo-rooted build pipeline," which is a major init use-case.

### G5 · `promote` `@return:<field>` form (and resolution rules) undocumented
`template-format §3` shows only `promote.from = "<file>:<field>"`. The crucial second form `@return:<field>`
(drills the node's validated structured RETURN — no filesystem) is what makes in-place promotion work, since
the source file isn't under `{{RUN}}`. Also undocumented: the file form resolves under `{{RUN}}` via
`absUnder` (absolute honored), dotted nested fields work (`pipeline.json:voice.constPrefix`), and a value
resolving to `undefined` THROWS (loud wiring error, not a silent ''). Source: `workflow/ops/promote.ts:74-94`.
**Skill fix:** document both `from` forms, the resolution + throw contract, and recommend `@return:` for
in-place workflows. (Worked use here: Setup scaffolds `pipeline.json`, returns `camelLessonId` + `composition`
read from it, and two `@return:` promotes lift them into `{{state.*}}` — the lesson-agnostic derived-name
single-source.)

### G6 · `{{arg.*}}` is missing from the token vocabulary
`template-format §7` lists only `{{WORKSPACE}}` / `{{RUN}}` / `{{state.*}}`. But run args (`--arg k=v`) surface
as `{{arg.k}}` (learned from `piflow run --help`, confirmed it's the parameterization channel). Every
parameterized template needs this. **Skill fix:** add `{{arg.*}}` to the canonical §7 vocabulary with the
`--arg k=v` / `--arg-file k=path` entry point.

### G7 · The canonical offline validation gates point at the wrong (legacy) path
Skill "stand up" step 6 says dry-run via `node pi-runner/sdk/run.mjs --dry-run`. The canonical author-time
gates are the **`piflow` bin against the template dir**:
`piflow extract <tpl>` (free DAG/stages/lanes) · `piflow inspect <tpl> [nodeId] [--full]` (per-node RESOLVED
sandbox/tools/ops/prompt) · `piflow run <tpl> --dry-run` (realized pi commands, no model). Learned from
`piflow --help`. These three are the entire offline author→validate loop and the skill should center them.
**Skill fix:** replace the `sdk/run.mjs` references with the `piflow` bin gates.

---

## C — clarity gaps (cost time, had to verify; no hard failure)

### G8 · The loader build-status hedging is STALE
The skill repeatedly hedges: "template loader + init-RUN (U6b–U8) are the remaining build", "Today's
`PI_RUNNER_WORKFLOW` still points at a `.js` pending the loader". In reality `loadTemplate` /
`runFromTemplate` / `markersFromNode` are exported from `@piflow/core` and `piflow {run,inspect,extract}
<templateDir>` all work against an authored template today. The hedging made me waste a probe confirming the
loader exists. **Skill fix:** update status — the template dir IS the live load path; drop the "pending
loader / points at a .js" caveats (or scope them precisely to what's actually unbuilt).

### G9 · Tool-name vocabulary unspecified
What strings are valid in `tools.allow/deny`? `example-basic` uses bare `read`/`write`/`submit_result`;
`artifact-contract.md` mentions `ls,grep,find,edit,bash`; the G11 note in the skill lists FAMILY addresses
(`fs:*` / `sh:*` / `oc.<plugin>:<tool>` / `mcp.<server>:<tool>` / `contract:submit_result`). It is unclear
when to use a bare builtin name vs a family address. I used bare `read,write,edit,bash,submit_result`.
**Skill fix:** a canonical tool-name table — the pi builtin bare names (read/write/edit/ls/grep/find/bash/…),
`submit_result`, and when the `oc.*`/`mcp.*`/family forms are required.

### G10 · Ported `agentType:"claude"` — what to do with it
The PORT (`parse-claude-workflow.mjs`) stamps every node `agentType:"claude"` (the recorded Claude hint). But
"claude" is NOT a piflow preset (presets live at `~/.piflow/agents/<id>.md`; an unknown id ⇒ HALT per the G6
preset law). I had to decide to DROP `agentType` on all nodes. **Skill fix:** PORT guidance — strip the
recorded Claude `agentType` (it's the Claude-executor default, not a piflow preset); set `agentType` ONLY for
a real `~/.piflow/agents/<id>.md` preset.

### G11 · Parallel-lane write-disjoint `owns` is ENFORCED, and "every node owns the logs dir" is a legacy anti-pattern
The skill says "same-level + write-disjoint owns ⇒ a parallel lane" but doesn't warn that the loader
**REJECTS** same-level nodes sharing a write GLOB. The legacy `contract()` helper gave EVERY node
`owns: …/_logs/*` (so each can write its wave log) — under the SDK this makes all 6 parallel lanes collide
(`parallel lane owns overlap: … share write authority`). Fix = narrow each node's `_logs/*` glob to its
SPECIFIC `_logs/<wave>.md` (the dir is shared, the files are disjoint), or add a serial join node. Source:
the loader's parallel-lane check (`loadTemplate`). **Skill fix:** document the rejection + the per-node-file
fix, and flag the carried-over `_logs/*`-on-every-node as a legacy idiom to rewrite on port (ties to the D
meta-directive).

### G12 · The `checks` KIND vocabulary lives only in the legacy `artifact-contract.md`
The integrity-check kinds (`exists, non-empty, regex-absent/present, json-parses, field-present, count-floor,
fenced-tail` + `severity:'fail'|'warn'`) are documented for the monolith `DRIVER-CHECKS`, not for the template
`node.json` `checks.pre/post`. They are the same set the loader/runtime honor. **Skill fix:** surface the
checks-kind table in the template reference so an author picks a real predicate (not a blanket `non-empty`).

### G13 · `workflow.json` (re)generation — who writes it, when?
The skill calls `workflow.json` GENERATED + committed (a `package-lock`-style lockfile) and says "a check gate
fails if stale" — but it's unclear whether the AUTHOR commits it, which command (re)writes it, and whether
`piflow extract` regenerates it on the fly. (Still verifying in this port.) **Skill fix:** name the exact
command that (re)generates `workflow.json` and whether an authored template must commit it.

### G14 · `prompt.skill` vs an in-body skill pointer — one home or two?
`template-format §6` says the engine "inlines the `prompt.skill` pointer line." The ported prompts ALREADY
embed `SKILL TO LOAD AND FOLLOW: <path>` in the prose. It's unclear whether ALSO setting `prompt.skill`
duplicates the pointer. I chose to rely on the body's existing pointer (single home) and omit `prompt.skill`.
**Skill fix:** state the rule — `prompt.skill` is the ONE home for the pointer (engine inlines it); the prose
body should NOT also hard-embed the path (or vice-versa), to avoid a duplicated/ drifting pointer.

---

## D — directives / principles to bake into the skill

### D1 · PORT = facts, not form (the meta-directive above)
Author the template in the SDK's canonical idioms; treat the realized `.js` prompt purely as a source of
FACTS. The skill should make this an explicit PORT law and pair each legacy idiom with its SDK replacement
(`owns:_logs/*` → per-node log file; `contract()` prose → engine-rendered markers from `node.json`;
`agentType:'claude'` → drop; absolute REPO paths → `{{WORKSPACE}}`/`{{arg.*}}`/`{{state.*}}` tokens).

---

## Resolved confusion — arg/state resolution at node launch

### G15 · The engine does NOT arg/state-resolve `node.io` paths at launch — only the PROMPT and the POST-ops are resolved (this CORRECTS G4)

**The question.** An in-place template declares each node's `contract.artifacts`/`owns`/`readScope`/
`checks[].path` with `{{WORKSPACE}}/.../{{arg.lessonId}}/...` tokens. At REAL node launch (not the dry-run),
does the runner resolve `{{arg.*}}`/`{{state.*}}` (and `{{WORKSPACE}}`) INSIDE the io/owns/read-scope/checks
paths BEFORE it stat()s them and BEFORE it renders the `DRIVER-*` markers — or does it leave them literal
(making the artifact gate stat a literal-`{{…}}` path that can never exist)?

**Verdict: NO — the io/owns/read-scope/checks paths are NOT token-resolved at launch.** Only `node.prompt`
(via `resolveTokens`) and the POST-ops (`project`/`merge`/`registryProject`, via `resolveDeep`) are resolved
with the args-bearing ctx. Proof, traced end-to-end:

- **Args reach exactly two places.** `resolveCtx = { run, workspace, state, args }` is built at
  `runner/runner.ts:981`, then consumed by ONLY: `resolveTokens(node.prompt, resolveCtx)` (`:1010`) and
  `resolveDeep(...op..., resolveCtx)` for the POST-ops (`:1116`/`:1124`/`:1129`). Nothing else on the launch
  path takes `resolveCtx`.
- **The artifact gate stats the RAW path.** All five stat sites do
  `node.io.artifacts.map((a) => artifactState(path.resolve(ctx.outDir, a.path), a.path))` with `a.path`
  verbatim — `runner.ts:882, 1137, 1257, 1705, 1735`. No `resolveTokens`/`resolveDeep` wraps `a.path`.
- **The DRIVER-* markers are emitted from the RAW node.** `emitMarkers(markersFromNode(node, resolved))`
  (`runner.ts:1018`); `markersFromNode` (`contract.ts:186-205`) reads `node.io.artifacts[].path`,
  `node.sandbox.read`/`.write`, `node.io.checks` directly — it has NO `resolveCtx` parameter and cannot
  resolve anything. (`resolved` here is the TOOLS bundle, `ctx.registry.resolve(node.tools)` at `:924`, not a
  resolved node.)
- **read-scope reaches the sandbox raw.** `scope.create({ readScope: node.sandbox.read, ... })`
  (`runner.ts:966`) — literal.
- **checks paths are read raw.** `effectiveChecks(node.io.checks, ...)` → `evaluateChecks` (`checks.ts:117-129`)
  reads `c.path` and hands it to the `readBytes` closure (`runner.ts:1155-1162`), which does
  `path.resolve(ctx.outDir, rel)` on the LITERAL `c.path`. No resolution.
- **The tokens were never resolved upstream either.** The loader copies them verbatim: `toNodeIntent`
  (`loader.ts:119-145`) sets `artifacts: c.artifacts.map(...)`, `sandbox.read: c.readScope.slice()`,
  `sandbox.write: c.owns.slice()`, `checks: collectChecks(...)` with ZERO token handling. And init-RUN copies
  `node.json` BYTE-IDENTICAL (`instantiate.ts:126`) — its `resolveIntrinsic` (`{{RUN}}`/`{{WORKSPACE}}` only,
  `instantiate.ts:67-73`) runs over the PROMPT, never over `node.json`/`node.io`. So `node.io.*` carries BOTH
  `{{WORKSPACE}}` AND `{{arg.*}}` literally into the runtime `NodeSpec`.
- **The resolver that WOULD do this is dead code.** `resolveAll` — whose own header comment (`resolver.ts:4`)
  says it is "applied UNIFORMLY to EVERY marker (artifacts · owns · readScope · seed · schema)" — has ZERO
  callers in the engine (only a re-export at `index.ts:72`). The intent is documented; the wiring is absent.

**Why the gate FAILS doubly on a literal path.** A path string like
`"{{WORKSPACE}}/.../{{arg.lessonId}}/brief.md"` starts with `{`, so it is NOT absolute → `path.resolve(ctx.outDir, literal)` joins it UNDER the `.pi` run dir with the braces intact, and the stat misses. This also
**corrects G4's line** ("`path.resolve` returns an absolute `a.path` AS-IS … so `{{WORKSPACE}}`-absolute
artifacts are stat()'d directly ✓"): that is true ONLY for an ALREADY-RESOLVED absolute path. The runtime
`a.path` is never resolved, so it is never absolute, so the AS-IS claim does not hold for a `{{…}}`-token
path. The dry-run "passes" precisely because it never stat()s — the literal-`{{arg}}` failure only appears at
a REAL launch.

**Most-robust template-side handling (recommendation): (b) promote the derived names to `{{state.*}}` from
the Setup node — BUT it does not fix the io-path resolution gap on its own, because `{{state.*}}` in
`node.io` is ALSO left literal (same dead-`resolveAll`).** The resolution gap is token-KIND-agnostic: neither
`{{arg.*}}` NOR `{{state.*}}` NOR `{{WORKSPACE}}` is resolved inside `node.io`/`owns`/`readScope`/`checks`
today. So the choice of `{{arg.*}}` vs `{{state.*}}` for `camelLessonId`/`composition` is NOT what makes the
gate pass. The honest options, in order:

1. **FLAG-TO-WIRING-OWNER (the real fix).** This is an ENGINE gap, not a template one: the launch path must
   call `resolveAll(node.io.artifacts paths / owns / readScope, resolveCtx)` and resolve `check.path` BEFORE
   the stat at `:1137`, BEFORE `markersFromNode` at `:1018`, and BEFORE `scope.create` at `:966` (and mirror
   it at the G8-repair re-stat `:1257` and the entry re-stat `:1705`/`:1735`). The resolver and its
   doc-contract already exist (`resolveAll`); only the call sites are missing. Until that lands, NO purely
   template-side token choice makes the artifact/checks gate honest for an in-place template — the dry-run is
   green and the live run blocks on a literal-`{{…}}` stat.
2. **If a template-only workaround is forced before the engine fix:** author the io/owns/readScope/checks
   paths with the lessonId ALREADY-LITERAL (no `{{arg}}`/`{{state}}` in `node.io`), i.e. instantiate a
   per-lesson template (or a thin pre-pass that substitutes the id), and keep `{{arg.*}}`/`{{state.*}}` ONLY
   in the PROMPT and the POST-ops where they ARE resolved. This is ugly (defeats one-template-many-lessons)
   but it is the only thing that makes the gate stat a real path with today's engine.

**Net for the porter:** keeping `{{arg.lessonId}}` in `node.io` is NOT "correct as-is" (G4 implied it was);
it is blocked on an unwired engine step. Choosing `{{state.*}}` over `{{arg.*}}` for the DERIVED names buys
nothing here. Treat this as a wiring-owner FLAG (resolve `node.io`/checks at launch via the existing
`resolveAll`), and do not trust a green dry-run as evidence the io-path gate will pass live.

**Skill fix:** `piflow-init` (+ `template-format.md`) must state the resolution SCOPE explicitly — which
fields are token-resolved at launch (PROMPT + seed/project/merge/promote ops) vs which are consumed RAW
(`node.io.artifacts`/`owns`/`readScope`/`checks[].path`/`sandbox.read`). Pair it with the dry-run caveat: the
dry-run does not stat artifacts, so an unresolved-token io path is invisible until a live run. Correct G4's
"stat()'d directly ✓" to "stat()'d directly ONLY once already-absolute — a `{{…}}`-token io path is neither
resolved nor absolute and the gate misses."

---

## Resolutions (verified from source — close C-gaps G8/G9/G12/G13)

- **G8 RESOLVED — loader hedging IS stale.** `loadTemplate`/`runFromTemplate` are exported (`index.ts:31,169`)
  and all three CLI verbs take a template DIR through `loadTemplate` (`extract.ts:42`, `inspect.ts:50`,
  `run.ts:264` + live `runFromTemplate :282`). The "U6b–U8 pending / points at a `.js`" wording is obsolete.
- **G9 RESOLVED — bare builtin tool names are CORRECT.** Authoritative `BUILTIN_TOOLS` =
  `read, write, edit, grep, find, ls, bash` (`tools/registry.ts:12-20`; internally `fs:*`/`sh:*`, but pi sees
  the bare name). `submit_result` is the first-party `contract` tool (`tools/contract-tool.ts:60`) — opt-in via
  the registry SEED (`registry.ts:30`), so a node MUST list it in `tools.allow` to bind its generated `-e`
  extension. The node.json schema accepts any `minLength:1` string (no enum) for `allow`/`deny`. Family
  addresses (`oc.*`/`mcp.*`) are needed ONLY for sdk/mcp tools. So `read,write,edit,bash,submit_result` is right.
- **G12 RESOLVED — `checks.kind` registry = 8 kinds.** `CHECK_KINDS` (`checks.ts:62`):
  `exists, non-empty, regex-absent, regex-present, json-parses, field-present, count-floor, fenced-tail`
  (policy actions: `block|warn|stop|retry|escalate`, `checks.ts:166`). The node.json schema does NOT enum-gate
  `kind` (`node.schema.ts $defs.check.kind = {type:string,minLength:1}`) and an unknown kind degrades to a
  non-fatal `warn` at runtime (`checks.ts:127`) — so `non-empty`/`json-parses` are valid; an author TYPO in a
  kind silently warns instead of failing (worth a skill caution).
- **G13 RESOLVED — `workflow.json` regenerates on load; no separate command, no staleness gate.**
  `loadTemplate(dir)` itself (re)writes it every load (`loader.ts:213` → `writeWorkflowJson`/`buildWorkflowJson`),
  idempotent (rewrites only on byte-diff, `workflow-json.ts:46-58`). So `piflow extract|inspect|run` regenerate
  it for free; committing it is conventional (mirrors `package-lock`), NOT enforced — the "`piflow check`
  staleness gate" is aspirational (`workflow-json.ts:4`); no `piflow check` subcommand exists.

---

_Append new entries as the port proceeds (node-by-node authoring + the live dry-run/run)._

---

## E — FIRST LIVE RUN (companion profile, MiniMax-M3 / `mmgw`, 2026-06-26)

Run `ctt-1`, lesson `kptest-count-to-two`, `piflow run … --provider mmgw --profile companion --thinking low --sandbox local`. setup→w2a→w2b all produced clean, skill-faithful artifacts; the model tier is NOT the bottleneck. The findings below are SDK/authoring gaps surfaced by a REAL run — each framed as guidance so piflow-init/the SDK can give better defaults.

### E1 · promote→`{{state.*}}` IS the SDK-native way to thread a derived path component — and it works live (resolution is LAZY per-node, not eager)
The port referenced `{{arg.camelLessonId}}`/`{{arg.composition}}` in downstream io paths + prompts, but neither was ever a launch arg → `MissingArgError` the moment a consuming node runs. The mature fix, **fully supported on the shipped SDK**: the producing root node (`setup-scaffold`) declares `hooks.promote:[{from:"@return:camelLessonId",to:"camelLessonId"},{from:"@return:composition",to:"composition"}]`, sets `returnMode:"required"`, returns the two values (copied VERBATIM from the scaffolded `pipeline.json` — single source of truth), and every downstream node uses `{{state.camelLessonId}}`/`{{state.composition}}`. Live proof: after setup-scaffold, `.pi/state.json = {"camelLessonId":"kptestCountToTwo","composition":"CompleteKptestCountToTwoLesson"}`, and the per-node lifecycle resolved both `{{arg.lessonId}}`/`{{WORKSPACE}}` (→ absolute, `exists:true`) AND the promoted `{{state.*}}` against the barrier-merged state. **This CORRECTS the lingering "eager launch resolution" fear (cf. G15): io paths ARE resolved per-node at runtime** (`runner.ts:967,976-990`; `runState = loadState(outDir)` `:1715`); the resolver throws only when a token names a channel/arg that genuinely doesn't exist yet.
**SDK/skill guidance:** piflow-init should TEACH promote→`{{state}}` as THE pattern for "a value computed by an early node (camelCase id, composition name, any scaffold field) used in later io paths." Include the `@return:<field>` form (avoids the file-source caveat in E-note below).

### E2 · `checkChannels` flags a literal `{{state.X}}` written in the PROMOTING node's OWN prose as a dangling consumption
Documenting the promote by writing the example tokens `{{state.camelLessonId}}` in setup-scaffold's *own* prompt made `extract` fail: `dangling channel: node "setup-scaffold" consumes {{state.camelLessonId}} but no upstream node promotes the "camelLessonId" channel` (it's the root — nothing upstream). The scanner can't tell "I document this token" from "I consume it" (`checks.ts checkChannels` scans `readScope`/`seed.from`/**prose**).
**Guidance:** skill caution — NEVER write a literal `{{state.X}}` in the prose of the node that promotes X (name the channel in plain words). Or: SDK exempts a node from "consuming" a channel it itself promotes.

### E3 · No meta-level computed/derived args (the cleaner end-state for E1)
A value that is a PURE function of a launch arg (`camelLessonId=camelCase(lessonId)`, `composition=Complete<Pascal>Lesson`) still needs a node+promote — there is no `meta.json` computed/derive facility (`meta.schema.ts` `additionalProperties:false`, no `args`; args are a flat `Record<string,string>`, no schema/coercion/transform).
**SDK guidance (feature):** add `meta.computedArgs` (or `args[].derive`) = pure string transforms over launch args, evaluated BEFORE the run, feeding `ctx.args`. Then camelLessonId/composition are declared ONCE at the template level — no node, no promote. Until then E1 is the shipped workaround.

### E4 · `--from` resume preflight stats RAW UNRESOLVED token paths → `--from` is unusable for any tokenized template  (HIGH PRIORITY)
`piflow run … --from w2c-sound-design` aborted: `cannot --from "w2c-sound-design": missing upstream artifact(s): {{WORKSPACE}}/remotion-svg-primitives/lesson-data/{{arg.lessonId}}/brief.md (setup-scaffold), …` — the files EXIST at the resolved path; the preflight stats the LITERAL `{{WORKSPACE}}/{{arg.lessonId}}/…` string. This is the ONE place the "raw path" story is real: the `--from` window stat preflight (`runner.ts ~1680`, "skipped upstream nodes register reused after a stat preflight") does NOT `resolveTokens` each upstream node's declared artifacts before `stat`. (Normal per-node io resolution is fine — E1.)
**SDK guidance:** resolve `{{WORKSPACE}}`/`{{arg.*}}`/`{{state.*}}` in upstream artifacts BEFORE the `--from` stat preflight (reuse the per-node `resolveCtx`; `{{state.*}}` is available via `loadState`). Until fixed, the documented `--from` lever cannot be used.

### E5 · Journal auto-resume does NOT reuse a prior FAILED run's good prefix — it re-runs from scratch
After a mid-run failure + a one-node prompt fix, re-running the same `--run ctt-1` (no `--from`) re-ran from stage 1 (did not reuse the 5 nodes that had succeeded; their artifacts + `state.json` channels were all on disk). Combined with E4 (`--from` broken), **there is currently NO cheap "resume the good prefix" path after a failure** — a one-node fix costs a full re-run.
**SDK guidance:** either (a) let the journal reuse the still-valid completed-node prefix of a FAILED run, or (b) fix `--from` (E4) as the manual lever. (A clean-room full re-run is fine for validation, but expensive for iteration.)

### E6 · In-place LocalSandbox logs a spurious "downloadDir identity-only" issue on EVERY node
Every node logs: `output collection failed: LocalSandbox.downloadDir: in-place collection is identity-only, but remote (…/out/<node>) !== local (…/runs/<id>). The output already lives at the in-place root; a non-identity target is a misuse.` Non-fatal where the node writes artifacts to the WORKSPACE (the gate stats them in place), but it is CONCATENATED into the node's `issues` and on a genuinely-failing node (w2c) it muddied the real cause.
**SDK guidance:** in identity in-place mode, SKIP `downloadDir` (output already lives at the in-place root) rather than attempt+log a failure; or stop defaulting `sandbox.output=out/<node>` under in-place-identity.

### E7 · A node that must ENUMERATE a directory needs a readable INDEX or `bash` — readScope+`read` alone can't `ls`  (authoring guidance)
`w2c-sound-design` had the sound library in `readScope` and `read` granted, but no `bash`; to discover bed/sting/sfx keys the model reached for `ls`/glob (forbidden by the READING LAW + ungranted) and correctly BLOCKED rather than invent keys (good discipline). Fix: point the prompt at the machine-readable `_beds|_sfx|_stings/_index.json` files to `read` (mirroring the already-correct `w3c-sound-asset`), NOT grant bash.
**Guidance:** piflow-init should flag — a node that discovers/enumerates a directory must be given a machine-readable INDEX to `read`, OR `bash`+the dir in readScope; a read-only node CANNOT list a directory. Prefer the index (deterministic, no shell, honors a no-explore reading law).

_Note (promote file-source caveat, from SDK read): `extractPromoteValue` reads a `from:"<file>:<field>"` source via `absUnder(ctx.run, source)` WITHOUT `resolveTokens` first — so a `{{WORKSPACE}}`-rooted promote source mis-resolves; the `@return:<field>` form (used in E1) sidesteps it. Resolving tokens in `promote.from` would enable file-field promotes from workspace artifacts._

### E8 · A read/write/edit node BLOCKS over a missing SHELL op it could do with `write` (the dominant live failure class)
Two of run `ctt-1`'s blocks were the same shape — a node granted only read/write/edit/submit_result reached for a shell capability and self-blocked instead of using the tools it had:
- `w2c-sound-design` tried `ls` to enumerate the sound library (→ E7).
- `w2a-visual-design` tried `mkdir _logs/` to create a directory that ALREADY EXISTED (w0/w1 — same grant — wrote their `_logs/*.md` into it the same run) and self-blocked EVEN THOUGH it had already written its real artifact (visual-design.md, verified 1/1). NON-DETERMINISTIC: w2a SUCCEEDED in the first run, blocked in the re-run — pure model variance.
**Authoring fix (shipped, commit 2131a77):** a FILE-OP DISCIPLINE clause on the shared preamble (line 11, all 14 nodes): create logs/outputs with `write` DIRECTLY (the `_logs/` dir exists, write makes parent dirs) — never mkdir/ls/touch/bash; a node without bash MUST NOT block over a missing shell op doable with write/edit; a missing INPUT → pipelineFinding + PROCEED; block ONLY when a REQUIRED OUTPUT can't be written.
**SDK guidance (optional):** (a) surface "write creates parent dirs" in the tool description so the model doesn't reach for mkdir; (b) in the status ladder, distinguish a model SELF-block from a required-artifact-missing failure, so an over-cautious self-block on a node that DID produce its declared artifact isn't a hard run-failure (the runner already knows artifacts verified 1/1).

_Divergence note: the `.piflow/lesson-build/template` prompts were PORTED one-time from `.claude/workflows/lesson-build.js`; the E1/E7/E8 preamble+prompt fixes live ONLY in the .piflow template. `lesson-build.js`'s `discipline()` preamble should get the same FILE-OP clause for parity (flagged to the wiring owner; orchestration `.js` is out of Hermes prose scope)._

### E9 · The composer (bash-granted) ran `find /` from ROOT to locate kit imports — READING-LAW violation + multi-minute whole-disk scan; `--sandbox local` does NOT confine bash
On the heaviest node (`w4a-composer`, which HAS `bash`), MiniMax-M3 didn't know the import paths for the kit layers (`@studio/narration-kit` / `<LessonAudioLayer>` etc.) and ran `find / -name 'narration-kit'; find / -name '@studio'` — a whole-machine scan from `/` that ran 4.5+ min with no useful result (and would eventually trip a node timeout). The shared READING LAW (preamble line 7) ALREADY forbids "read, grep, find, ls, or otherwise explore … outside your declared scope" — the cheap model violated it under uncertainty. Manually killing the runaway let w4a resume INSTANTLY and keep composing (the tool just returned empty).
**Guidance (authoring):** a prohibition is not enough for a cheap model under uncertainty — the composer prompt/skill must POSITIVELY supply the exact kit import paths (or pin them in catalog-digest's lesson-infra section with "imports come ONLY from here"), so the model never needs to search. Prompt fix deferred to AFTER this run (editing the template prompt mid-node doesn't affect the in-flight staged prompt anyway).
**Guidance (SDK/sandbox) — notable:** under `--sandbox local`, a node's `bash` is NOT confined to its declared readScope — `find /` escaped to the entire machine. The seatbelt read-scope sandbox (the `DRIVER-READ-SCOPE` mechanism) WOULD bound this; `local` does not. Consider: deny absolute-root traversal / scope the bash cwd / surface that `local` = unconfined so authors know readScope is advisory there. (A runaway `find /` from a cheap model is a predictable failure mode worth a guardrail.)
