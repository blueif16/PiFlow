---
name: piflow-maintenance
description: >-
  Pi Flow · MAINTENANCE — the canonical STANDARDS reference for a node config + a run condition: the exact
  per-node lifecycle, the `op[]` action envelope, PRE/POST hooks, gates & policy, how a node FINISHES
  (fenced-JSON tail · `submit_result` · `returnMode` · verified-not-trusted), run PROFILES, and the token /
  contract vocabulary. The brother of piflow-init — init decides WHAT the DAG is (divide the purpose, assign the
  nodes); MAINTENANCE answers "what is our canonical way to DO this?" for an already-built or half-built loop.
  LOAD/FOLLOW when editing or extending an existing node.json / template and you need the standard: "where does
  a script go (which op, pre or post)", "how should this node end / return its result", "how do I add a gate /
  check / judge", "the exact node lifecycle", "how do promote / state channels work", "set up a profile",
  "inject vs readScope", "is this the right op syntax". REFERENCE, not a loop — carries the standards only, never
  the optimize loop and never the divide-and-assign creation strategy. To CREATE use piflow-init · RUN
  piflow-start · IMPROVE piflow-enhance · LOOK INTO a run piflow-inspect.
---

# Pi Flow · maintenance — the canonical node-config & run-condition standards

**One-line model:** a workflow is a `.piflow/<wf>/template/` (the D8 **source of truth**); each node is ONE
self-contained `node.json` (contract-as-DATA); `@piflow/core` loads the template into a `WorkflowSpec`, compiles
it to a DAG, and runs **one headless `pi` per node**, verifying artifacts on disk. This skill is the reference
for the STANDARDS that govern that node config and that run — not how to invent the graph (piflow-init) and not
how to improve it over time (piflow-enhance).

> **Paths below are relative to the piflow repo root** (`~/Desktop/piflow`). This is a REFERENCE skill: it
> POINTS at the ground truth (design docs + `piflowctl understand` slices) and never copies code. When a fact
> here looks stale, the slice wins — re-derive with `piflowctl understand <area>` and `--check`.

## The five Pi Flow lifecycle skills — where MAINTENANCE sits
| Skill | Role |
|---|---|
| **piflow-init** | CREATE: triage the source → divide the purpose → assign each node → build the `template/` |
| **piflow-maintenance** *(you are here)* | The STANDARDS: the canonical way a node config & a run are shaped — read before EDITING an existing/half-built loop |
| **piflow-start** | RUN & monitor a workflow on the pi fleet (dry-run → live → `piflowctl logs`) |
| **piflow-inspect** | LOOK INTO a run/node (telemetry · trace · timing · loop/stall) |
| **piflow-enhance** | IMPROVE a workflow over runs (capture→route→edit loop, criteria fixture, the optimize loop) |

**The boundary (do not cross it in this skill):** MAINTENANCE tells you the SHAPE and the SYNTAX. It does NOT
decide whether a step should exist, who owns it, or how the graph is divided — that judgment is piflow-init's
"Designing a node's I/O". It does NOT run the improve/optimize loop — that is piflow-enhance. If the question is
"should this be a node at all / how do I split the work", route to init; if it's "how do I fix a recurring
failure across runs", route to enhance.

## Law 0 — the template is the truth; author by DATA, verify by COMPILE
- **Every per-node standard lives in ONE `node.json`** (contract-as-data): `deps` · `prompt` · `tools` · `mcp` ·
  `inject` · `contract` · `checks`/`policy` (or `op[]`) · `hooks` · `return`. Nothing is scattered. Editing a
  node = editing its `node.json` (+ its `prompt.md` prose); the engine loads the change automatically.
- **Author by FLAG, not by hand-editing JSON.** The scaffold loop emits every field deterministically from
  flags: `piflowctl add-node <dir> --id … [--dep …] [--tool …] [--artifact …] [--owns …] [--check …]
  [--gate-run …] [--judge …] [--checkpoint …] [--promote …] …`. The only prose you Write by hand is
  `nodes/<id>/prompt.md` (and a judge's `judge.md`). Full flag surface: `piflow-init` SKILL "Gates, judges,
  checkpoints, and control are FLAGS".
- **`piflowctl extract <dir>` (the real `loadTemplate` gate) is the oracle** — a 0 exit means the DAG compiles;
  a non-zero names the malformed field. Never trust a glance at the JSON; run extract after every change. The
  compile step is the workflow's `tsc`: a malformed node fails in ms at author time, not after a 20-min pi run.
- **`workflow.json` is GENERATED, never hand-edited** — the compile step chains every `node.json` `deps` into
  it (add a node = drop a folder; no manifest edit). You read/diff it; you change a `node.json`'s `deps` and
  rebuild. A `piflowctl check` gate fails if it's stale.
- **Ground truth:** `docs/design/template-format.md` (the D8 keystone — §3 node def · §4 hooks/checks · §7 token
  vocab · §10 instantiation) + slice `piflowctl understand runner`.

## 1. The node lifecycle — the exact spine (verified, not trusted)
`runFromTemplate` = load → `instantiateRun` (materialize `${RUN}/.pi/nodes/<id>/`) → compile → `runWorkflow`.
`runWorkflow` walks the topological **stages** in order (`Promise.all` per stage, concurrency-capped, **HALT on
the first `error`/`blocked`**). Same-stage nodes with **write-disjoint `owns`** run as a parallel lane. Nodes
NEVER call each other — **they coordinate ONLY through files on disk; the filesystem IS the contract.**

Each node runs through `runNode` (`packages/core/src/runner/node-lifecycle.ts:114`), in this fixed order:

1. **bind-check** — `verifyToolBinding` runs LOUD and EARLY (before pi spawns): an `oc.*`/`mcp.*` address absent
   from the catalog, or two addresses colliding on one bare name → the node is `blocked` before any model runs.
2. **create the sandbox lane** + **stage reads / `seed`** (the PRE transforms stage inputs the model will read).
3. **PRE ops** — pre-`gate` (checks over the staged inputs, BEFORE the model) · pre-`run` · `inject`-fold (the
   forced-read files fold into the realized prompt).
4. **write the prompt + `DRIVER-*` markers**, resolve `{{WORKSPACE}}`/`{{RUN}}`, then **EXEC exactly ONE
   headless `pi -p --mode json`** (per-node model/provider resolved by `defaultPiCommand`).
5. **collect** the model's outputs back to the host run dir.
6. **verify** — the POST gate engine (`evaluateChecks(effectiveChecks(…))`), **host-stat every declared
   artifact**, schema check, return check.
7. **POST ops** — `transform` (project/merge/promote) · `run` · `promote` (lift into a state channel).
8. **on-failure** — `retry` → `escalate` → `reroute` → `notify` (§5), filtered by the derived `FailureClass`.
9. **`finishNode`** stamps the terminal verdict into the run's `.pi/` tree (`run.json` + a journal entry).

**The 9 terminal verdicts** (`runner/status.ts:18` — a watcher polls exactly these):

| status | meaning |
|---|---|
| `pending` | not yet run (inside the selected `--from`/`--until` window) |
| `running` | exec in flight |
| `ok` | clean exit **AND** every declared artifact present on disk |
| `gap` | self-reported NON-fatal gap, honored from the node's return |
| `blocked` | a required artifact is missing / a blocking gate failed — **beats any self-report** |
| `error` | killed (timeout/stall) or nonzero exit / degenerate run |
| `reused` | upstream node skipped, artifacts reused (`--from` resume) |
| `awaiting-input` | a human `checkpoint` is PARKED, waiting for a reply (G5) |
| `dry` | dry-run: command built, not executed |

**Law:** `ok` is decided by the driver stat()ing the contract's `artifacts`, NOT by the model's message — a
clean exit that did not leave a required artifact is `blocked`. **Verified, not trusted.** Slice:
`piflowctl understand runner`.

## 2. The `op[]` envelope — the ONE canonical node-action format
Every side-effect a node performs is a canonical `op[]` (`OpSpec`, `packages/core/src/types.ts:104`). The
ergonomic aliases (`hooks` / `checks` / `policy` / `inject` / `tools` / `mcp`) are SUGAR the loader lowers INTO
`op[]` (`workflow/template/lower.ts`) — **authoring either the aliases or `op[]` directly is fine; they converge
on the same envelope.** Prefer the aliases for the common cases; reach for raw `op[]` for the long tail.

```ts
interface OpSpec {
  id?; when?;         // when: 'pre' | 'post' | 'on-success' | 'on-failure' | 'always'   (default 'post')
  reads?; writes?;    // files read/written — fold into DAG edge inference (+ pre-op reads fold into the prompt)
  onFailure?;         // 'block' | 'warn' | 'stop' | 'retry' | 'escalate'                (default 'block')
  idempotent?;        // skip when outputs fresh                                          (default true)
  // EXACTLY ONE body (the discriminator — a multi-body op is rejected at load):
  transform?; run?; gate?; action?;
}
```

The four **bodies** (an op is exactly one of them):

| body | verb | shape | fires |
|---|---|---|---|
| `transform` | **DERIVE** | `seed{from}` · `project{ops?,from?}` · `merge{ops}` · `promote{from,to,reducer?}` · `projectRegistry{…}` | `seed` = PRE; the rest = POST |
| `run` | **ACT** | `{cmd,args?,cwd?}` or `{fn}` — a deterministic shell/fn side-effect, **NEVER an LLM** | POST only |
| `gate` | **DETECT** | `{kind,path?,param?,advisory?}` — a pure predicate over `reads` emitting a verdict | PRE or POST |
| `action` | **CONTROL** | `retry{max,onVerdict?}` · `escalate{via,evidence?}` · `notify{channel,payload?}` · `rerouteTo{node,max,evidence?}` | on-failure / on-success |

**Deprecated-alias → `op[]` map** (the migration table, `node-action-protocol.md` §2.2) — all still supported:
- `hooks.seed:[{to,from}]` → `{when:'pre', writes:[to], transform:{kind:'seed',from}}`
- `hooks.project|merge|promote` → `{when:'post', transform:{kind:…}}`
- `checks.post:[Check]` → `{when:'post', gate:{…}, onFailure:<from policy>}`
- `checks.pre:[Check]` → `{when:'pre', gate:{…}}` (runs BEFORE the model — a real pre-gate, not a flattened post)
- `policy:{fail,warn}` → folded into each `gate`'s `onFailure`
- `inject:[path]` → `{when:'pre', reads:[path]}` whose `reads` folds into the prompt

**Ground truth:** `docs/design/node-action-protocol.md` (the as-built architecture) + slice
`piflowctl understand node-action-protocol` (owns `packages/core/src/checks.ts`).

## 3. WHERE does a script go? — PRE vs POST, and the op syntax
This is the most-asked standard. A "script" is a deterministic step with no model judgment — decide its home by
the `mechanical → driver op` law, then use the exact syntax.

**Decide the kind first** — *"is this output a fixed function of already-frozen on-disk inputs, with no
judgment?"*
- **YES → a deterministic driver op** (a TESTED code path, not a per-run gamble). Which op:
  - **STAGE a file the model then reads (PRE)** → a `seed` transform. PRE can do exactly ONE thing: stage a file.
    ```jsonc
    { "hooks": { "seed": [{ "to": "spec/skeleton.json", "from": "{{WORKSPACE}}/templates/skel.json" }] } }
    // ≡ op: [{ "when":"pre", "writes":["spec/skeleton.json"], "transform":{"kind":"seed","from":"…"} }]
    ```
  - **RUN a shell command (POST)** → a `run` op, whose non-zero exit routes through `onFailure`. Or the flags:
    **`--gate-run <cmd>`** for a test/build/lint GATE (non-zero BLOCKS), vs **`--merge-run <cmd>`** for a
    data-DERIVE with no verdict (generate an asset). `run` and `promote` are **POST-only — op-dispatch REJECTS a
    `when:'pre'` `run`.**
    ```jsonc
    { "op": [{ "when":"post", "run":{"cmd":"npm","args":["test"]}, "onFailure":"block" }] }
    ```
  - **DERIVE / validate an output file (POST)** → a `project` or `merge` transform.
  - **PROMOTE a value into shared state (POST)** → a `promote` transform (see §7).
- **NO — design reasoning / open-ended coding / prose / diagnose-and-fix → the model** (a `pi` node prompt).

**Which NODE hosts the script:**
- **Fold into the CONSUMING agent node's PRE-hook** — the default for pure file-STAGING (reuse, zero new node).
- **Its OWN `programmatic: true` node** (no `prompt`/`tools`/`return`; its `op`/`hooks` + `checks` ARE the node)
  when ANY holds: (1) no consuming agent node is guaranteed to run every run (a profile/`--until` may end the
  run on this step); (2) the step needs its own node-scoped `reroute`; or (3) **the step RUNS a shell command or
  PROMOTES shared state** — a pre-hook can do NEITHER, so this class is ALWAYS its own UPSTREAM programmatic node.
- **A custom op the generic families don't cover** → a `scripts/<op>.mjs` in the template + a `hooks/` binding;
  the generic executors (`seed`/`project`/`merge`/`promote`/checks) live in `@piflow/core`.

**Ground truth:** `piflow-init` SKILL "Split MECHANICAL from INTELLIGENT" + `reference/artifact-contract.md`
(the `DRIVER-*` marker grammar). **Marker-grammar trap:** skeleton guide prose must be quote-safe — never a bare
single-word bracket token (`<id>`); use the colon-bearing `<FILL:…>` sentinel.

## 4. Gates — detection ⊥ consequence (never conflate them)
A gate DETECTS; a policy decides the CONSEQUENCE. They are SEPARATE so one check is reusable under any
consequence (the same "schema invalid" can `retry` on one node and `escalate` on another).

- **`checks.pre` = over staged INPUTS before the model; `checks.post` = over produced ARTIFACTS after.** A check
  emits a VERDICT only (`fail`/`warn`), from the pure predicate registry `CHECK_KINDS` (`checks.ts:62`:
  `exists` · `non-empty` · `json-parses` · `count-floor` · …). `advisory:true` = a non-blocking gate.
- **`policy` maps the verdict → `block | warn | stop | retry | escalate`** (`actionForVerdict`, `checks.ts:154`).
  `stop` is a documented ALIAS of `block` (both drain same-stage siblings, then halt before the next stage).
- **The additive gate LIST (`gates:[]`, the CURRENT model)** — a typed, append-only list, three entry types
  (`docs/design/gate-list-and-additive-profiles.md`), each lowering onto machinery that already exists:
  | `type` | what it is | lowers to |
  |---|---|---|
  | `execution` | a deterministic `check` OR a shell `cmd` ("normally always holds") | `op.gate` folded into `io.checks`, or `op.run` |
  | `agentic` | a **judge on a DIFFERENT model** | a materialized `<id>__judge` node |
  | `hitl` | a human checkpoint | the G5 `checkpoint` field |
  The TEMPLATE default carries `execution` gates only; `agentic`/`hitl` are added by a PROFILE (§6). There are
  **no on/off switches — composition is append-only.**
- **Flags:** `--check <kind[:path[:severity[:param]]]>` (post) · `--check-pre …` (pre) · `--on-fail/--on-warn
  block|warn|stop` · `--gate-run <cmd>` (execution gate) · `--judge <judgeTier[:threshold]>` (a judge — the
  `judgeTier` MUST differ from the node's `--tier`; Write `nodes/<id>/judge.md` FIRST).
- **Ground truth:** slice `piflowctl understand node-action-protocol`; `docs/design/node-action-protocol.md` §2.4.

## 5. The four re-attempt axes — never conflate them (above all, never call reroute "retry")
| axis | what it is | discriminator |
|---|---|---|
| **VERIFY** | a gate node judges an already-produced artifact + writes a pass/fail verdict | re-runs nothing, creates nothing load-bearing (`VALIDATION_FAILED` is a value INSIDE the JSON) |
| **RETRY** | the runner's bounded mechanical re-run of the SAME node because ITS OWN exec failed (`retry.ts`) | a runtime loop around one node, blind to any verify verdict; optional single model `escalate` |
| **REROUTE** | a verify FAIL re-invokes an ANCESTOR producer (a bounded QA self-fix), UNROLLED at compile time | `reroute:{onFail:<ancestor>, max}` → acyclic clones, never a runtime back-edge; target MUST be a strict ancestor |
| **OPTIMIZE** | an out-of-band, human-gated, cross-run edit of the node/template ITSELF (`piflowctl optimize`) | improves the NODE, never recovers a single run — this is **piflow-enhance's** territory, not maintenance |

`escalate` = on a VERIFIED failure, re-run on a stronger cross-family model fed the failure facts
(`consultPreamble`), resolved via `escalate.tier`/`escalate.model` through `model-routing.ts`. Slice:
`piflowctl understand runner` (DRIFT NOTE: `retry`/`escalate`/`reroute` live in `runner/retry.ts` + the
`workflow/reroute/expand.ts` compile pass).

## 6. How a node FINISHES — the return contract (verified, not trusted)
Every node ends with **ONE fenced ```json``` block = its self-report** (the rendered Definition-of-Done prose
tells the model to). But the self-report is honest only when the model is, so the driver's verdict comes from
the FILESYSTEM, not the message:

- **Declared `contract.artifacts` are stat()'d on disk** — a clean exit missing a required artifact is
  `blocked`, not `ok`. This is the load-bearing completion signal. The self-reported list is advisory.
- **`submit_result`** (`contract:submit_result`, the first-party typed terminating RETURN tool) — OPT-IN: a node
  declares it in `tools.allow`, which gives the driver a generated `-e` extension that binds a typed return.
  Reach for it where the driver must reliably INTERPRET the non-Claude model's free-form output (the return
  parser is the single most-patched surface); the driver keeps a fenced-tail fallback so it never breaks a run.
- **`returnMode`** (`contract.returnMode`, `types.ts:349`): `optional` (the default WHEN artifacts are declared)
  | `required` — `required` is the **zero-artifact gate-node idiom**: the return JSON IS the deliverable, so its
  presence + shape is the gate. (`returnMode:'required'` ≡ `gate{kind:'json-schema', onFailure:'block'}`.)
- **`return`/`returnSchema`** validates the SHAPE of the fenced tail (DISTINCT from `returnMode`, which says
  WHETHER a return is mandatory). Validated off-disk after the node.

**The standard for finishing a node:** declare the REQUIRED artifacts in `contract.artifacts` (that is what
"done" means); end the prompt with the fenced-JSON self-report; add `submit_result` only when the return value
(not a file) is what downstream code parses; use `returnMode:'required'` only for a node whose whole job is the
return (a gate/decision node that writes no artifact). **Ground truth:** `packages/core/src/contract.ts`,
`packages/core/src/tools/contract-tool.ts`.

## 7. State channels & `promote` — how a value crosses nodes
A node NEVER writes `state.json`. To make a value visible downstream, a POST **`promote`** op lifts a node
output into a RunState channel; the DRIVER applies the channel reducer (`set` default · `append` · `deepMerge`)
and merges at the **stage barrier**. Downstream nodes read it as a deferred **`{{state.<channel>}}`** token,
resolved at node launch from `{{RUN}}/.pi/state.json`.
```jsonc
{ "hooks": { "promote": [{ "from": "spec/classification.json:archetype", "to": "archetype", "merge": "set" }] } }
```
- **The DAG is STATIC** — state drives VALUES, never routing (D6). A promoted value reaches a consumer only via
  a completed upstream node's POST `promote`; a PRE-hook cannot promote (so a value-establishing step is always
  its own UPSTREAM node — §3).
- **`from` is token-resolved like every field** — a file-sourced `promote from` (e.g. `spec/x.json:archetype`)
  passes through the SAME single resolver as any marker path (`{{WORKSPACE}}`/`{{RUN}}`/`{{state.*}}`, §9); a
  path not expressible in that vocabulary is a design smell.

## 8. Run PROFILES — how to set one up
A profile is a named, per-product run MODE, declared as DATA (the SDK carries none of the vocabulary).

- **CURRENT model — the additive gate overlay** (`gate-list-and-additive-profiles.md`): a profile is a sparse
  overlay `template/profiles/<name>.json` that names only the nodes it modifies and APPENDS gates (typically
  `agentic`/`hitl`) to them. Running with **no profile = the pure-template compile** (execution gates only). It
  is append-only — a profile never subtracts a node.
- **DEPRECATED model — `elidePhases`** (subtractive; `workflow/profile.ts`, still wired via `applyProfileByName`
  but fires a loud warning): `meta.json` declares `profiles` + `defaultProfile`, each a node-ELISION predicate
  keyed by a shared `phase` tag. **Only nodes that CREATE NOTHING may be elided** — that is the verify-node law:
  drop the gate phase and every key artifact still exists because PRODUCERS made them. A verify node that is also
  a producer can't be elided — split it first.
  ```jsonc
  // meta.json (elidePhases model — deprecated but present)
  "profiles": { "production": {}, "companion": { "elidePhases": ["verify-1", "verify-2"] } },
  "defaultProfile": "production"
  ```
- **Selecting one is a RUN concern** — `--profile <name>` (piflow-start owns it; `packages/cli/src/run.ts:273`).
- **Standard:** default to ONE profile unless the workflow genuinely needs a gate-lighter dev posture; when it
  does, prefer the additive overlay for NEW work. When gates are elided, the orchestrator IS the verifier
  (judge each `ok` artifact against the gold sample + the criteria fixture — a piflow-enhance concern).

## 9. The vocabulary you must get right (tokens · read-scope · contract fields)
- **Path/value tokens (one resolver, every field):** `{{WORKSPACE}}` (canonical, read-only) · `{{RUN}}`
  (per-thread) · `{{state.<channel>}}` (deferred RunState). A path not expressible in this vocabulary is a design
  smell. On-disk the delimiter is `{{ }}` (some older prose writes `${…}` as shorthand).
- **Two KINDS of read (get this right or the model over-reads or reads stale bytes):**
  - **`inject` = KIND 1 FORCED** — small · always-needed · stable files, pre-read and embedded in the prompt as
    authoritative context (guaranteed sight, no explore). The `inject` set must be inside `readScope`.
  - **`contract.readScope` = KIND 2 EXPOSED** — directory trees the model NAVIGATES via its `read` tool (skills,
    the registry, a producer's artifact a later node consumes). Large · optional · mutable → EXPOSED, never
    injected (injection would freeze a stale copy; a tool read sees current bytes). Under `--sandbox`, `readScope`
    is ALSO the OS-enforced read allow-list.
- **`contract` fields:** `artifacts` (REQUIRED outputs, stat()'d → `blocked` if missing) · `owns` (write
  authority; write-disjoint `owns` = a parallel lane) · `readScope` · `schema` · `returnMode` · `fillSentinel`.
- **Ground truth:** `docs/design/template-format.md` §3 / §6a / §7.

## The laws (the standards, condensed)
- **The template is the single source of truth; author by DATA, verify by `piflowctl extract`.** `workflow.json`
  is generated, never hand-edited.
- **Verified against the declared contract, not the self-report** — `ok` iff the declared artifacts exist on disk.
- **One node, one job.** A producer CREATES each key artifact; a verify node judges + may self-fix but NEVER
  creates the load-bearing artifact (the test: remove the verify node and the producing flow still yields every
  key artifact). This is what makes the verify phase safely elidable.
- **Driver owns the graph; `pi` owns the node.** Plain code decides stage order + parallel lanes +
  halt-on-failure; the model never decides control flow. Nodes coordinate ONLY through files.
- **`run` and `promote` are POST-only; a PRE-hook can only STAGE a file** — a step that runs a shell command or
  promotes shared state is always its own upstream `programmatic` node.
- **Detection ⊥ consequence** — a `gate`/`check` emits a verdict; `policy`/`onFailure` decides the action; never
  fuse them.
- **The workflow orchestrates; the SKILL carries the craft** — a node body is a THIN pointer (who · reads what ·
  writes what · load-and-follow), the method lives in its skill; never restate craft in the node body.
- **An output edit is not done until its CONSUMERS are reconciled** — a node's artifact is an interface; change
  its shape/name/fields and every downstream reader breaks. Reconcile them, then `grep` for the old shape.

## Verify + go deeper
- **Understand a subsystem before editing it:** `piflowctl understand <area>` (the canonical slice) then
  `piflowctl understand --check <key>` (freshness) — the slices `runner` and `node-action-protocol` own this
  skill's spine. Do NOT re-map from scratch.
- **Ground-truth design docs:** `docs/design/template-format.md` (node def · tokens · rendering) ·
  `docs/design/node-action-protocol.md` (the `op[]` architecture) · `docs/design/gate-list-and-additive-profiles.md`
  (gates + profiles) · `docs/design/profiles-and-resume-robustness.md` (the elision primitive).
- **To CREATE the workflow** use piflow-init · **to RUN it** use piflow-start · **to IMPROVE it** use
  piflow-enhance · **to LOOK INTO a run** use piflow-inspect.

## Self-check (before you rely on a standard from this skill)
- Did I answer with the CANONICAL construct (the right op/hook/gate/profile), not an ad-hoc one? Is the op
  `when` lane legal (`run`/`promote` are POST-only)?
- Did I preserve "verified, not trusted" — is the node's "done" defined by a declared artifact (or a
  `returnMode:'required'` return), not a self-report?
- Is detection kept separate from consequence? Is a would-be-elided node a pure non-producer?
- Did I run `piflowctl extract` (compile) after the edit, and reconcile every consumer of any changed artifact?
- If the question was really "should this node exist / how do I divide the work" → I routed to piflow-init; if
  "improve across runs" → piflow-enhance. This skill is standards, not those loops.
