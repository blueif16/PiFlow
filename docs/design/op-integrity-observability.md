# op / hook-result integrity observability

**Status:** design (no implementation) · **Owner-slices:** [[node-action-protocol]] · [[observe]] · [[optimize]] · [[gate-composition]]
**Question:** how does piflow give CLEAR, CHEAP, DETERMINISTIC warning that a pre/post hook, op, gate, or in-turn
staging script produced a result lacking basic integrity — and how do `status` / `telemetry` / `trace` / `optimize`
surface that instead of the first stderr line?

## Problem (the motivating incident)

Product Omniscience, workflow `section-adventure`, run `260715-02`, node `plan`. STEP 1 of the node's *prompt* runs a
staging script (`planner-context`) INSIDE the model's turn via bash; it assembles a 205 KB persona file the node then
reads. In-jail, a cache read silently returned empty, so a REQUIRED block (`required_kp_ids = [7 ids]`) vanished from
the staged persona — the script exited 0, printed a plausible manifest, and NOTHING warned. The planner invented a
smaller KP set; a downstream execution gate (which runs unsandboxed on the host and therefore saw the full data)
blocked the run. Diagnosis took manual ledger diffing. Three SDK surfaces compounded it: (a) `opFailures` surfaced the
stderr WARNING `[kp_cache] MCP client unavailable` as the op's failure reason, while the gate's REAL verdict (a JSON
ledger at `{{RUN}}/ledger/verify/output.json`, per-check `ok`/`detail`) was surfaced by no verb; (b) `status`/`telemetry`
show ops only as `op FAILED — <first stderr line>`; (c) `trace` records staged reads (bytes/sha) but has no *content*
contract. The failure was SILENT at the point of corruption and MISLABELLED at the point of report.

## Current architecture (grounded)

The op envelope and its surfacing today, with anchors:

- **Op declaration.** `OpSpec` — `packages/core/src/types.ts:142` — `id`/`when`/`reads`/`writes`/`onFailure`/`idempotent`
  /`note` + exactly one body (`transform`/`run`/`gate`/`action`). `RunBody` = `{cmd,args,cwd} | {fn}` (`types.ts:179`).
  JSON schema twin: `packages/core/src/workflow/template/schema/node.schema.ts:409` (`additionalProperties:false` — a
  new field is REJECTED unless declared here). No integrity/result-file field exists.
- **Dispatch.** `runOpsFromOp` (`packages/core/src/runner/op-dispatch.ts:177`) partitions run ops into `RunnableOp`
  (`op-dispatch.ts:114`) and `RejectedRunOp` (`op-dispatch.ts:119`, `{detail,onFailure}`). `gatesFromOp`
  (`op-dispatch.ts:103`) splits gate ops pre/post — the [[node-action-protocol]] spine.
- **Execution + the failure channel.** In `runNode` the runnable loop is `packages/core/src/runner/node-lifecycle.ts:676`;
  a nonzero exit pushes `opFailures.push({ detail: \`run ${cmd} failed (exit N): ${stderr}\`, onFailure })` at
  **`node-lifecycle.ts:684`** — THIS is where stderr becomes the reason. Rejected ops at `:689`. Stamped onto the record
  at **`node-lifecycle.ts:870`** (`rec.opFailures = opFailures`); blocking subset filtered at `:866`. The op reason
  deliberately does NOT flatten into `issues[]` (user law: "op has nothing to do with the issue system").
- **Post-gate engine (the two-layer design).** `evaluateChecks(effectiveChecks(io.checks,…))` at `node-lifecycle.ts:517`
  over the pure predicate registry `CHECK_KINDS` — `packages/core/src/checks.ts:62` (`exists`/`non-empty`/`json-parses`
  /`count-floor`/…) — with `effectiveChecks` at `checks.ts:138`. A structured failure record (failedChecks · exitCode ·
  `stderrTail.slice(-400)`) is assembled at `node-lifecycle.ts:1002`.
- **The typed carrier.** `NodeStatus.opFailures?: {detail,onFailure}[]` — `packages/core/src/runner/status.ts:157`
  (the comment already says "the optimize substrate reads THIS field, never an issue-string grep"). Carried into the
  digest as evidence at `packages/core/src/observe/telemetry.ts:94`/`:188`/`:286`/`:330`.
- **Surfacing today.** CLI status: `✗ <id>: op FAILED — ${f.detail}` at **`packages/cli/src/run.ts:1014`**. Optimize
  triage reads the raw string: `const opFail = nd.opFailures?.[0]; if (opFail) return \`op failed — ${opFail.detail}\``
  at **`packages/core/src/optimize/triage.ts:61`**.
- **Trace (reads, no content contract).** The per-read manifest `sha256`/`bytes`/`lines`/`covered` is computed in
  `packages/core/src/observe/contextComposition.ts:65` (`fileMeta` at `:180`); the CLI row (seq · op · path · range ·
  coverage · sha · via) renders at `packages/cli/src/trace.ts:52`, failed-op marker at `trace.ts:45`.
- **Ledger record.** `NodeIo.writes: {path, verified, bytes?}` (`types.ts:604`) — existence + size, no marker/pointer.

Nothing in this spine checks a *content* post-condition, and nothing lets an op declare WHERE its structured verdict
lives — so the runner has only stderr to report and triage only stderr to read.

## Design

### 1 · The integrity contract — `expect` on `OpSpec`

Add an optional, deterministic post-condition list to an op, checked by the runner AFTER the op body runs, over the
op's own `writes` (or an explicit `path`). It REUSES the `CHECK_KINDS` predicate family (`checks.ts:62`) — no parallel
engine:

```jsonc
// OpSpec.expect?: IntegrityExpectation[]  +  OpSpec.resultFile?: "persona.manifest.json"
{ "kind": "file-exists",          "path": "persona.md" }
{ "kind": "min-bytes",            "path": "persona.md", "param": 200000 }   // the silently-empty 205 KB persona
// PREFERRED (structured) — assert over the op's resultFile MANIFEST, never over the artifact's prose:
{ "kind": "json-parses",          "path": "persona.manifest.json" }
{ "kind": "json-pointer-exists",  "path": "persona.manifest.json", "param": { "pointer": "/required_kp_ids" } }  // the vanished block, as manifest data
{ "kind": "json-pointer-equals",  "path": "persona.manifest.json", "param": { "pointer": "/ok", "value": true } }
{ "kind": "json-schema",          "path": "persona.manifest.json", "param": { "schema": { "type": "object", "required": ["required_kp_ids"] } } }
// LAST RESORT — regex over opaque prose whose producer we do NOT control:
{ "kind": "contains-marker",      "path": "persona.md", "param": "required_kp_ids" }
```

- **The predicate vocabulary (updated — the center of gravity is STRUCTURED DATA, not text-matching).** `file-exists`
  → `exists`; `min-bytes` → `non-empty` (extended to honor a numeric byte FLOOR, back-compat: no param ⇒ `>0`);
  `contains-marker` → `regex-present` (escaped literal); `json-parses` already exists; and the added structured
  predicates: `json-pointer-exists` (an RFC-6901 pointer resolves to a present, non-empty-array value),
  `json-pointer-equals` (pointer resolve + deep-equal), and `json-schema` (validate the parsed file against an inline
  `param.schema` via ajv — already a `@piflow/core` dep — through the runner's injected `SchemaValidator` seam). All
  are pure — per the [[default-profile-programmatic-gates-only]] law, integrity is PROGRAMMATIC only.
- **The three checking LAYERS, in order of preference for a result WE author** (encode the cheapest that could fail):
  **(0) exit-code** — the op body's own non-zero exit (already routed via `onFailure`); **(1) the MANIFEST** —
  `json-pointer-exists` / `json-pointer-equals` / `json-schema` over the op's `resultFile` (structured, robust to
  reformatting, self-describing); **(2) `contains-marker`** — regex over opaque prose, the LAST RESORT for an artifact
  whose producer we don't control. `min-bytes` / `file-exists` are the coarse file-shape floor beneath all three.
- **Default consequence = `warn`** (an author may set `onFailure:'block'`). The incident's real gate already blocked
  correctly; the missing thing was a LOUD, EARLY, correctly-labelled signal at the point of corruption. `expect`
  produces EVIDENCE (the `opFailures` philosophy — evidence for triage, never an auto-issue) surfaced as a WARN row.
- **Jail-correct by construction.** `expect` runs where the op runs and checks the bytes the node will actually read —
  so the in-jail empty file trips `min-bytes` immediately, without a host-side gate ever running. This is the property
  the host-side gate could not give: it validates what the NODE got, not what a later unsandboxed step sees.

### 2 · The verdict-vs-stderr fix — `resultFile` on the envelope

Add `OpSpec.resultFile?: string` (a run-relative path to the op's structured verdict, e.g. the gate ledger). Extend the
op-failure entry (`status.ts:157`, `telemetry.ts:94`/`:188`) from `{detail,onFailure}` to
`{detail,onFailure,resultFile?,integrity?}` where `integrity?: {kind,ok,detail}[]` carries the `expect` verdicts.

The inversion: when `op.resultFile` is set and the op fails, the runner READS that file at `node-lifecycle.ts:684`
instead of formatting stderr, and distills its structured content (e.g. the failing `checks[].detail` entries) into
`detail`. The raw path rides the envelope so verbs can open it. Because triage already reads `opFailures[0].detail`
(`triage.ts:61`), it then reads the VERDICT for free — same field, correct content.

### 2.5 · The MANIFEST convention (structured-first — the design-upgrade centerpiece)

An op that **stages or assembles** an artifact should EMIT a structured JSON **manifest** declaring what it produced —
the ids it pulled, the sources, per-block presence flags, char/byte counts — and name it as the op's `resultFile`.
`expect` then targets **the manifest** (`json-pointer-exists` / `json-pointer-equals` / `json-schema`), *never* a regex
over the artifact's own prose. The manifest is the op's own account of its work, so an assertion over it is robust to
reformatting, self-documenting, and reads back as the failure `detail` for free (via §2). Concretely, the incident's
staging script emits `persona.manifest.json` = `{ "ok": true, "required_kp_ids": [7 ids], "chars": 205123, … }`; the
`expect` asserts `json-pointer-exists /required_kp_ids` (the block is present as DATA) + `json-schema` (shape) — and the
empty-cache-read failure surfaces as `required_kp_ids absent` at the pre-op, not a stderr WARNING.

- **Precedence.** exit-code (0) → manifest json-pointer/json-schema (1) → `contains-marker` (2, last resort). Reach for
  `contains-marker` ONLY when the artifact is opaque prose from a producer we do not control (no manifest is possible).
- **`json-schema`.** Validates the manifest (or any JSON result) against an inline `param.schema` through the runner's
  already-resolved `SchemaValidator` (ajv, a `@piflow/core` dep). Kept a *pure* predicate: the validator is injected
  (like the file reader), never imported into the predicate; a `param.schemaPath` is resolved to an object by the runner
  before the check runs, and a missing/uncompilable validator DEGRADES to pass (the schema gate's degrade-don't-brick
  contract — never a false breach).
- **Follow-up (not in WS-I0/I1/I2): `file-size-matches-pointer`.** A cross-check "the staged file's byte size equals a
  declared manifest field" needs TWO files (the artifact's size + the manifest's pointer) and so does NOT fit the pure
  single-file predicate contract (`CHECK_KINDS` predicates read one file's bytes). It is DEFERRED rather than forced
  through a parallel engine; `min-bytes` (absolute floor) + `json-pointer-equals` (the manifest's own count vs an
  expected value) cover the incident today. Revisit as a runner-level cross-file expectation if a case demands it.

### 3 · Surfacing (the four verbs)

| Verb | Today | With integrity |
|---|---|---|
| `status` (`run.ts:1014`) | `op FAILED — <first stderr line>` | `⚠ plan: op integrity — min-bytes fail persona.md (0<200000)`; when `resultFile` set, the verdict summary, NEVER stderr |
| `telemetry` (`telemetry.ts`) | `opFailures` as digest evidence only | + a per-node **ops table** (id · exit · duration · integrity verdict) — needs a per-op `rec.ops[]` record, not just failures |
| `trace` (`trace.ts:52`) | seq·op·path·range·coverage·sha·via | + a `contract` column: `✓ marker` / `✗ marker missing` on a staged element carrying a declared content contract |
| `optimize` triage (`triage.ts:61`) | reads raw `detail` string | reads `resultFile` content + `integrity[]` — the verdict, not the stderr WARNING |

## The in-turn staging blind spot (the real killer)

Staging that runs INSIDE the model's turn (a bash tool-call in STEP 1 of the prompt) is invisible to op machinery — it
is not an `op[]` entry, so `expect` on op[] cannot see it. Options, honestly:

- **(a) Move staging to a PRE-op with an `expect` contract.** The prompt's STEP-1 script becomes
  `op:[{ when:'pre', run:{cmd:'planner-context …'}, writes:['persona.md'], expect:[{kind:'min-bytes',path:'persona.md',param:200000},{kind:'contains-marker',path:'persona.md',param:'required_kp_ids'}] }]`.
  The runner runs it BEFORE pi (`node-lifecycle.ts:250`/`:353`), checks the contract, injects the persona as a forced
  read. Respects the laws: a deterministic pre-hook (info, never autofix — a violation WARNs, never rewrites the file);
  UNFORCED (the node still owns whether to have the op; it is NOT made a pure programmatic node — the model still plans,
  per [[flexibility-over-hardcoded-plans]]). PRO: catches the failure at the earliest point, deterministically, fully
  enveloped. CON: re-authors the template; the rare staging that genuinely needs mid-turn context can't move.
- **(b) Content-marker contracts on trace elements.** Declare, per node/read, "the staged input read here must contain
  marker X." When the runner computes the read's sha/bytes for the trace (`contextComposition.ts:180`), it also checks
  the declared markers, annotates the trace row (`trace.ts:52`), and emits a WARN. Catches in-turn staging WITHOUT
  moving it — the node still READS the persona, and `declared ⊇ actual` (`types.ts:409`) means that read is declared.
  PRO: no restructure; catches ANY staged input regardless of producer. CON: post-hoc (fires when the node reads, not
  when the script writes) — still within the same node, before the downstream gate.

**Recommendation: (a) primary, (b) backstop.** (a) makes staging a first-class, envelope-visible, deterministically
gated step — the cleanest fit and a direct fix for the incident (empty cache read → `min-bytes` WARN at the pre-op,
ledger as detail, no manual diffing). (b) is the safety net for staging that must stay in-turn: a marker check on the
traced read. Both are deterministic, info-not-autofix, and leave the node's intelligence unforced.

## Non-goals

- **No agentic / LLM integrity judging** — `expect` is `min-bytes`/`json-pointer-*`/`json-schema`/`contains-marker`,
  never "ask a model if this looks complete" ([[default-profile-programmatic-gates-only]]). `json-schema` uses ajv
  (deterministic), not a model.
- **No auto-issue creation** — integrity failures are EVIDENCE on `opFailures`; triage decides if it is an issue (the
  opFailures philosophy — evidence, never auto-issues).
- **No auto-repair** of the staged file — hooks give info, never autofix ([[flexibility-over-hardcoded-plans]]).
- **No new collector / data path** — everything rides the existing op envelope + trace manifest ([[observe-single-data-path]]).
- **No behaviour change for existing templates** — absent `expect`/`resultFile`/`readContract`, the runner path and
  every verb are byte-identical to today.

## Fix plan (subagent-sized)

- **WS-I0 · schema + type.** Add optional `expect?: IntegrityExpectation[]` + `resultFile?: string` to `OpSpec`
  (`types.ts:142`) and the op schema (`node.schema.ts:409`, keep `additionalProperties:false`). Define
  `IntegrityExpectation` over the `CheckKind` vocabulary (`checks.ts:62`) + the added structured predicates
  `json-pointer-exists` / `json-pointer-equals` / `json-schema` (and extend `non-empty` to a byte floor for
  `min-bytes`). `evaluateChecks` gains an injected `{ validate }` seam that only `json-schema` reads. Tests: predicate
  unit tests (pointer/schema, mutation-verified) + op-codec round-trip carrying `expect`/`resultFile` + schema
  accept/reject cases + a backward-compat load of an `expect`-free template.
- **WS-I1 · runner expect pass.** After the runnable-op loop (`node-lifecycle.ts:676`) evaluate `op.expect` over
  `op.writes`/`path` via `evaluateChecks`/`CHECK_KINDS`; default violation `onFailure:'warn'`. Test-first: a
  min-bytes/contains-marker violation appears on the envelope; a passing expect is silent.
- **WS-I2 · envelope enrichment.** Extend the op-failure entry (`status.ts:157`, `telemetry.ts:94`/`:188`) with
  `resultFile?`/`integrity?`. When `op.resultFile` is set on failure, build `detail` from the file's structured content
  at `node-lifecycle.ts:684` instead of stderr. Add a per-op `rec.ops[]` record (id · exit · durationMs · integrity) for
  the telemetry table. Test: a declared `resultFile` yields verdict-derived detail, never the stderr WARNING.
- **WS-I3 · status + telemetry surfacing.** `run.ts:1014` renders the integrity/verdict line (never first stderr);
  add the telemetry per-node ops table projected in `telemetry.ts`.
- **WS-I4 · trace content contract (option b).** Add a per-read/per-node marker contract; check it in
  `contextComposition.ts:180`; render a `contract` column in `trace.ts:52`. The in-turn backstop.
- **WS-I5 · optimize triage reads the verdict.** `triage.ts:61` prefers `opFail.resultFile` content + `integrity[]`
  over the raw `detail`; the same read in blame/substrate `measure.ts`.
- **WS-I6 · standard + reference migration.** Document `expect`/`resultFile`/`readContract` in the piflow-maintenance
  skill; re-author the Omniscience `plan` node's STEP-1 staging as a PRE-op with `expect` (option a) as the reference
  example (product-side, not SDK).

Parallelizable: WS-I0 first (blocks all), then WS-I1‖WS-I4, then WS-I2→WS-I3‖WS-I5, WS-I6 last.
