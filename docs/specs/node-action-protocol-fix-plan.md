# Node Action Protocol — Fix Plan (dependency-ordered milestones)

> Implements `docs/design/node-action-protocol.md`. Each milestone = ONE coherent branch/commit (one idea, no "and"). Closes the 24 defects + 2 blockers from the investigation §4 (branch `docs/node-action-protocol`, commit `acdd502`). G-allocation per the brief: **G11** tool-wiring, **G12** control-flow/trigger-actions, **G13** unified op envelope. Order: live-pi E2E + blocker-#1 registry wiring (red bar) → dead-field/wiring fixes → unified protocol → trigger-action vocabulary → long-tail nits. Every milestone is TEST-FIRST: the named test is written FIRST and FAILS on today's code; ADDITIVITY CHECK proves no existing template breaks. **Tally discipline:** across M0–M7 the "Closes" lines cover #1–#24 with **#14 explicitly DEFERRED (tracked outside core, never counted as closed)** and **#22 closed-in-M5**; no issue number is dropped.

---

## M0 — Live-pi E2E gate: convert "should work" to a RED BAR
**Closes:** #8 (and makes #1 visible to CI) · **G-number:** G11 · **Branch:** `test/g11-live-tool-e2e`

**STEPS**
- Author `packages/core/test/runner-live-tool-e2e.test.ts`. Shared `probePi()` gate copying the proven shape from `openclaw-host-llm-task.test.ts` (offline `pi --list-models` probe → `{runnable}`).
- **V1 — the LOAD-BEARING blocker gate (routes through `runFromTemplate`/`runTemplate`, NO explicit registry):** a one-node template with `tools.allow:['oc.calc:add','contract:submit_result','fs:write']`; call `runFromTemplate(dir, { runDir, … })` (or the CLI `runTemplate`) with **NO `registry` passed and NO `buildCommand` stub** (real `defaultPiCommand`). On today's self-assembling path the registry is `new DefaultToolRegistry()` (`runner.ts:1347`), so the node `block`s. Assert (after M1 wiring flips it green): (1) `status.nodes.calc.status === 'ok'`; (2) `.pi/nodes/calc/events.jsonl` has `tool_execution_end{toolName:'calc_add'}` with the sum; (3) staged `_pi/calc/tools.ts` contains `name: "calc_add"`. Wrap in `it.skipIf(!probePi().runnable)`.
- **V1-smoke (SEPARATE, NOT the blocker gate):** a direct `runWorkflow(compile(spec), { registry: seededRegistry(), … })` with an explicit registry — this PASSES today (the blocker is only on the self-assembling path) and exists purely as a bind smoke test. It must NOT be relied on as the red bar.
- **V2 (sandboxed):** same node/assertions under `SeatbeltSandboxProvider` (gated on `darwin`) + the no-`@piflow/tool-bridge`-import bundle invariant (`compile.ts` inlined-bundle guarantee). Daytona variant behind `probeDaytona()`.
- **V1b (MCP lane):** a local MCP server via `mcpToolsToEntries` into the same `seededRegistry`, `$VAR`-bearing `mcpConfig.servers` + a `secretResolver` stub, select `mcp.<srv>:<tool>`, assert `tool_execution_end` for the prefixed bare name (proves `stageMcp` + the cred path end-to-end). Proves #14's bridge fix once it lands.

**TEST-FIRST GATE:** `runner-live-tool-e2e.test.ts › runFromTemplate binds + EXECUTES a node-declared oc.calc:add in a LIVE pi via the generated -e`. Asserts the agent's own `tool_execution_end{toolName:'calc_add'}` event. **Fails today** because V1 routes through `runFromTemplate` with NO explicit registry, so the canonical path uses `new DefaultToolRegistry()` (`runner.ts:1347`) and the `oc.*` node `block`s before `pi` binds. The bar stays RED until M1 wires `assembleRunTools` into the run path. (The explicit-registry V1-smoke is GREEN today and is therefore NOT the gate.)

**ADDITIVITY CHECK:** it is a new test file; touches no production code. `it.skipIf(!probePi().runnable)` keeps CI green where `pi` is unconfigured (no flake, no coverage theater).

**ACCEPTANCE:** V1 (the `runFromTemplate` path, no explicit registry) `block`s pre-M1 and passes post-M1 with a configured `pi`; V1-smoke (explicit registry) passes both before and after (it is not load-bearing); V2/V1b pass on their gated platforms.

---

## M1 — Seed the tool catalog into the canonical run path (UNBLOCK)
**Closes:** #1 (BLOCKER), #7 · **G-number:** G11 · **Branch:** `feat/g11-assemble-run-tools`

**STEPS**
- New `packages/core/src/runner/tool-config.ts` — `assembleRunTools({ spec, extraEntries?, mcpListings? }) → { registry, mcpConfig? }`. Pure: `registry = seededRegistry([...mcpRows, ...extraEntries])`; `mcpConfig` = the UNION of every node's `mcp.servers` with a byte-identical-or-throw conflict guard (never last-wins).
- Carry per-node MCP onto the intent: in `loader.ts`, beside the checkpoint/fusion carry, `if (n.def.mcp) intent.mcp = n.def.mcp;` and add `NodeIntent.mcp?` (authoring layer, NOT dense `NodeSpec`).
- Wire BOTH entries AFTER `expandFusion` — `runFromConfig` (insert after `entry.ts:71`) and `runFromTemplate` (insert after `entry.ts:109`): `const tools = runOpts.registry || runOpts.mcpConfig ? {registry: runOpts.registry, mcpConfig: runOpts.mcpConfig} : assembleRunTools({ spec, mcpListings: opts.mcpListings });` then pass `registry: tools.registry, mcpConfig: tools.mcpConfig, secretResolver: runOpts.secretResolver` into `runWorkflow`. (`entry.ts:107` is `applyProfileByName`, NOT a wiring site — do not touch it.)
- Switch `inspect.ts:133` and the `run.ts` dry-run mirror from `new DefaultToolRegistry()` → `seededRegistry()`.

**TEST-FIRST GATE:** `tool-config.test.ts › runFromTemplate self-seeds seededRegistry so an oc.* node binds`. A deterministic unit test (no pi) that `assembleRunTools` over a spec with an `oc.calc:add` node returns a registry where `verifyToolBinding('oc.calc:add')` is FOUND (not MISSING). **Fails today** because no production caller invokes `seededRegistry`/`loadCatalog` (zero non-test callers) and the run path uses `DefaultToolRegistry`. Plus M0's V1 (the `runFromTemplate` path) flips from RED to GREEN once this lands.

**ADDITIVITY CHECK:** `seededRegistry ⊇ DefaultToolRegistry` for builtins ⇒ a builtins-only node binds identically; the explicit-caller-wins guard means every existing `runner.test.ts` (which passes its own `registry`) keeps control; an all-native template declares no `mcp` ⇒ `assembleRunTools` returns `{ registry }` with no `mcpConfig`, and `stageMcp`'s `selectedBridgedTool && mcpConfig` gate stages nothing new. Regression test: `runner.test.ts` "does NOT write `_pi/mcp.json` for a node that selected NO mcp tools" still passes.

**ACCEPTANCE:** blocker #1 closed — a canonical `runFromTemplate`/CLI run binds + executes `oc.*`/`mcp.*`; M0 V1 green with a configured `pi`; all existing run tests unchanged.

---

## M2 — Dead-field & wiring fixes (mcp read, $VAR allowlist boundary, StringEnum)
**Closes:** #3, #21 (and scopes #14 to the bridge — DEFERRED, not closed) · **G-number:** G11 · **Branch:** `fix/g11-dead-fields`

**STEPS**
- #3: confirmed dead-field read is delivered by M1's `intent.mcp = n.def.mcp`; add a loader CHECK rejecting literal-secret patterns in `mcp.servers` (only `$VAR`/`${VAR}` refs allowed in secret-bearing values).
- #21: `StringEnum` normalization in `compile.ts` — walk each generated param schema; render all-string `enum` subschemas as a generated-preamble `StringEnum` helper, not `Type.Union`.
- #14: document the boundary — runner stages `$VAR`-bearing config verbatim + injects resolved env (already correct); the `$VAR`→value expansion is a one-line `@piflow/tool-bridge` follow-on, OUT of core. Open a tracked bridge issue; V1b proves it once fixed. **#14 is DEFERRED — it is NOT in any "closed" tally.**

**TEST-FIRST GATE:** `tools-compile.test.ts › an enum-bearing tool renders the Gemini-safe StringEnum form`. Asserts the compiled `-e` for `submit_result` (`status: { enum: ['ok','gap','blocked'] }`) emits `StringEnum`, not `Type.Union`. **Fails today** because `compile.ts` wraps params verbatim via `Type.Unsafe` with no enum normalization. Second gate: `loader.test.ts › rejects a literal secret in mcp.servers` — asserts a literal Bearer token throws; passes only after the loader check exists.

**ADDITIVITY CHECK:** a param with no `enum` renders byte-identically (`StringEnum` is a strict superset of today's OpenAI-only correctness); the literal-secret check only fires on a NEW field (`mcp.servers`) that no current template populates with literals (refs only). Existing compile-snapshot tests update to assert the `StringEnum` form.

**ACCEPTANCE:** #3 read live + guarded; #21 Gemini-safe on every provider family; #14 scoped and tracked outside core (deferred, not closed).

---

## M3 — Conditional reroute + bounded self-fix (the QA loop, compile-time unroll)
**Closes:** #2 (BLOCKER), #5, #17 · **G-number:** G12 · **Branch:** `feat/g12-reroute-unroll`

**STEPS**
- New `packages/core/src/workflow/reroute/expand.ts` — `expandReroute(spec)`, structured like `expandFusion` AND the SHIPPED `expandSubworkflow` (`docs/specs/wiring-g9-subworkflow.md`): the SAME compile-time sub-DAG-inlining family, not a parallel mechanism. Share the discipline verbatim — id-namespaced clones so downstream edges survive; disjoint top-level artifact dirs (parallel-collect write-disjoint, `runner.ts:936`); in-memory realized-prompt carriage on the generated `NodeIntent` (NO `.pi/nodes/<id>/` folder — G9 §"THE ONE WRINKLE"); referentially-unchanged early return when no node has `reroute`; loud `RerouteConfigError` (mirrors `FusionConfigError`/`SubworkflowConfigError`) on a non-ancestor `onFail` or `max < 1`. `expandReroute` stays SYNC (it rewrites in-spec slices, loading nothing); only `expandSubworkflow` is async (it `loadTemplate`s).
- For node `V` with `reroute:{onFail:T, max:k, evidence:E}` (where `evidence?: string[]`): clone the slice `S=[T…V]` as `S__r{i}` (i=2..k+1), NAMESPACED into `reroute-{V}-r{i}/`; `T__r{i}` reads `E` + gets a `consultPreamble` fix-prefix; final clone `onFailure:'block'|'stop'` (`stop` is a documented alias of `block`, design §2.4); emit a zero-pi existence-gate preflight node between attempts (#17 short-circuit).
- `RerouteSpec` on `NodeIntent` ONLY (the `fusion?` precedent; never dense `NodeSpec`).
- Insert in BOTH entries AFTER `expandFusion` (which is itself after the SHIPPED `expandSubworkflow`): `runFromConfig` after `entry.ts:71`; `runFromTemplate` after `entry.ts:109`. **Full expand-pass ORDER (load-bearing): `profile → subworkflow → fusion → reroute → compile`** — subworkflow FIRST (G9 §4c, so a fusion-activated node inside a loaded sub-template still expands and a parent profile can elide before the sub-DAG loads), reroute LAST (it clones already-expanded slices, so a reroute target inside a sub-DAG or fusion judge is cloned correctly). (`entry.ts:107` = `applyProfileByName`; not a site.)

**TEST-FIRST GATE:** `reroute-unroll.test.ts › expandReroute unrolls a bounded loop into a forward-only DAG that stagesOf accepts`. On `{verify, reroute:{onFail:'produce',max:2}}`, `compile()` yields the cloned slice `produce__r2 → verify__r2` and `stagesOf` does **not** throw `cycle detected`. **Fails today** because there is no `expandReroute` (the only authoring surface for re-entry is a `deps` back-edge, which `checkCycles` rejects). Second gate: `reroute-shortcircuit.test.ts › attempt-1 PASS ⇒ the cloned r2 nodes never spawn`. The test MUST assert a **call-count of 0** for `runNodeWithRetries`/`runNode` on the cloned ids `produce__r2`/`verify__r2` (a spy/counter on the negative), NOT merely that the `r2` preflight is `ok` — a "finishes ok" assertion alone passes vacuously even if the clones also ran. **Fails today** because there is no preflight short-circuit (proves #17 discriminatingly, test-discipline (d)).

**ADDITIVITY CHECK:** `expandReroute` returns the SAME spec object when no node declares `reroute` (the `expand.ts:196`-style early return), so game-omni (no `reroute`) compiles to the identical DAG; `checkCycles` is NEVER modified; `stagesOf` is the acyclicity backstop. The `.fixcycles-M2.json` self-managed counter becomes inert (replaced by `reroute.max`) without removing any byte-identical path.

**ACCEPTANCE:** blocker #2 closed — a verify FAIL re-enters an upstream node as bounded acyclic stages; the cycle gate untouched; #5 bound is SDK-owned; #17 preflight short-circuits a passing attempt AND the cloned bodies provably do not spawn.

---

## M4 — Trigger-action runtime: retry-by-class, escalate-with-evidence, notify, `stop` (documented alias)
**Closes:** #4 (IN FULL — escalate-with-evidence is the #4 core), #6, #15 · **Composes:** G8 schema-repair lane (`docs/specs/wiring-g8-repair-loop.md`) · **G-number:** G12 · **Branch:** `feat/g12-trigger-actions`

**STEPS**
- Widen `PolicyAction` 3→5 (`types.ts:200`): realize the reserved `retry-once`/`subagent-fix` as `retry`/`escalate` (flag as the one type-level change).
- **Schema failure-class lane = G8 composition (do NOT re-spec — `wiring-g8-repair-loop.md` is the spec).** In `classifyFailure`, a node `block`ed SOLELY on `schema.invalid`/`returnSchemaBreach` DERIVES the `schema`/`degenerate-output` class; that class routes FIRST to G8's bounded `contract.maxRepairAttempts` in-sandbox repair (a CHEAP re-prompt in the still-alive sandbox from `{previousOutput, ajvErrors, schema}`) BEFORE the full-re-run `retry`/`escalate` lane. A repair is NOT a retry (it reuses the live sandbox, not a fresh re-seed), so it does not consume the `retry` budget. G8 owns the loop + the field-wiring (`contract.maxRepairAttempts` → `NodeIO.maxRepairAttempts`); M4 only places the schema class as the lane that triggers it first.
- Add `RetrySpec`/`EscalateSpec`/`FailureClass` on `NodeIO` (concern 4, the `retries?` precedent); port `classifyFailure`/`consultPreamble` from `run.mjs` into `runNodeWithRetries` (reads only signals the runner already computes — `failedChecks` `runner.ts:1017`, artifact stat, return parse, stderr). `escalate.tier`/`escalate.model` resolve through `model-routing.ts` (`resolveNodeModel`), NOT a new config home; retire `ESCALATE_MODEL`/`ESCALATE_PROVIDER` env. **#4 closes IN FULL here** (escalate-with-evidence is the defect core; `notify` is a separate best-practice add, design §3, NOT a sub-part of #4).
- `io.retries` preserved as `legacyRetry(io.retries)` (max=retries, classes=`['infra','degenerate']`).
- `Escalator` host seam (mirrors `SecretResolver`; default no-op → `console.warn`) + `runWorkflow` option; `notify` routes through it.
- #15: `stop` is wired as a DOCUMENTED ALIAS of `block` (design §2.4 option B) — both fail the node, drain same-stage siblings via the existing `Promise.all` (`runner.ts:1543`), and halt before the next stage (`halted` set at `:1589`). **Do NOT add a mid-stage abort** (option A, rejected — it changes `block`'s observable behavior at `runner.ts:1589` and breaks additivity for every existing block-policy template). The name `stop` is reserved for a future graceful-cancel primitive once a stage-cancel exists.

**TEST-FIRST GATE:** `classify-failure.test.ts › classifyFailure returns quality-gap on a failed check verdict`. Over synthetic node records: `quality-gap` for a failed `checks` verdict, `contract` for a missing artifact, `infra` for `ECONN`, `upstream`→HALT for a missing input. **Fails today** because the port doesn't exist and `io.retries` fires only on `error`/`blocked` (#6's whole point — a quality verdict can't trigger retry). Companion gate: `escalate-loop.test.ts` (attempt 2 received `consultPreamble` text + the `escalate.tier`-resolved model via injected routing — fails today). **Note:** there is NO `policy-stop-drains` gate — `stop≡block` today (verified: `Promise.all` already drains siblings, `runner.ts:1543,1589`), so a "stop drains while block doesn't" test would PASS on the unmodified runner and is therefore coverage theater. Instead, a `stop-equals-block.test.ts` asserts `stop` and `block` produce the IDENTICAL halt record + sibling-completion set (a real, discriminating equivalence assertion that fails only if someone mistakenly diverges them). G8-composition gate (per `wiring-g8-repair-loop.md` §"Test strategy" #1): `bad-then-good repairs without a full re-run` — with `maxRepairAttempts:1, retries:0` and a stateful `buildCommand` (bad on call 1, good on call 2), assert the node ends `ok` via `rec.repairAttempts===1` with the builder called twice INSIDE one `runNode` and the `retry` budget UNTOUCHED — proving the schema class takes the cheap in-sandbox lane before any full re-run.

**ADDITIVITY CHECK:** every new branch is guarded on an undefined new field; absent `retry`/`escalate` ⇒ `legacyRetry(io.retries)` reproduces today's exact semantics; absent `Escalator` ⇒ `defaultEscalator` (warn→console); `stop` reproduces `block`'s exact halt behavior (no runner change at `:1589`). A "no-new-fields ⇒ identical record" regression test pins it. game-omni's prose self-fix keeps working until an author opts in.

**ACCEPTANCE:** #4 escalate-with-evidence ported IN FULL; #6 retry on a quality verdict; #15 `stop` wired as the documented `block` alias (no additivity-breaking abort); the G8 schema class takes the bounded in-sandbox repair before a full re-run (`bad-then-good repairs without a full re-run` green); deterministic model-free tests (no live pi).

---

## M5 — The unified `op[]` envelope + alias lowering + codec round-trip (the grammar unification)
**Closes:** #9, #10, #11, #16, #18, #22 · **G-number:** G13 · **Branch:** `feat/g13-op-envelope` · **BLOCKED-BY: M3, M4** (the `action:rerouteTo`/`retry`/`escalate` sugar lowers to canonical M3/M4 primitives; the action-lowering tests CANNOT be greened against absent primitives)

**STEPS**
- Add `op?: OpSpec[]` to `NodeSpec` (the one justified spine WIDEN — design §5; flag it, justify against `types.ts:10-11`, keep the named five concerns). The deprecated `hooks`/`ops`/`checks`/`policy` aliases lower to `op[]` **at the loader layer ONLY** (NOT retained on the dense `NodeSpec` — design §5 resolution), so the dense type gains exactly one field. `OpSpec` + the four bodies (`transform|run|gate|action`) with exactly-one-body discrimination (the `mergeHook` `oneOf` precedent).
- Loader LOWERS `hooks`/`ops`/`checks`/`policy` into `op[]` (the `@deprecated` aliases); executors (`seed.ts`/`project.ts`/`merge.ts`/`promote.ts`/`checks.ts`) reused UNCHANGED.
- **Codec round-trip of `op[]` (named M5 work-item, NOT deferred away):** extend `contract.ts` with a `DRIVER-OP` marker (base64-on-one-line, like `DRIVER-CHECKS-PREPOST` `:120-121`) so `markersFromNode`/`nodeFromMarkers` round-trip a node authored in the new `op[]` shape losslessly. Without this, the new shape silently loses the codec losslessness the `checksPrePost` marker was built to preserve (and fusion's judge carries at `expand.ts:171`). The "every grammar is a lossless profile" claim is NOT made until this lands.
- Replace the `reads: []` hardcode (`loader.ts:121`, and update the stale comment at `:119-120`) with `io.reads = unique([...injectReads, ...opReads])`; `io.produces` already = `c.artifacts.slice()` (`:122`), extend to `unique([...artifacts, ...opWrites])` (#10/#16).
- `inject`→ a pre-op whose `reads` is FOLDED into the prompt (#10 — genuinely new, the loader never folded injected reads); `checks.pre`→ a pre-`gate` with a real firing site (#11 — DEAD today, flattened pre→post in `render.ts`); authorable `run` body (#9) with a real `on-failure` lane (no hardcoded `'success'`, #22); `merge.run` exit-code → `RunBody.onFailure` (#18 — a behavior ADDITION: today the `runMerge` return is DISCARDED at `runner.ts:980`, exit never reaches status); `advisory` on `gate` (Dagster `blocking=False`).
- The `op.action:rerouteTo` form lowers to the canonical M3 `NodeIntent.reroute` (sugar, never dense `NodeSpec`); `op.action:retry/escalate` lower to the canonical M4 `NodeIO` fields.

**TEST-FIRST GATE:** `op-lowering.test.ts › an OLD-grammar node and the equivalent NEW op[] node compile to the identical NodeSpec.op[]`. Asserts a `hooks.seed`+`checks.post`+`policy` node and its `op[]` rewrite produce the same compiled `op[]`. **Fails today** because `OpSpec`/`op` does not exist and `loader.ts:121` hardcodes `reads: []`. Companion gates: `inject-fold.test.ts` (a pre-op's `reads` appears in the realized prompt — fails today, `loader.ts:121` hardcodes `reads:[]` so inject never folds); `pre-gate.test.ts` (a `checks.pre` gate fires BEFORE the model — fails today, `render.ts` flattens pre→post); `run-onfailure.test.ts › a merge.run non-zero exit routes to status` — assert the TODAY-SWALLOWED baseline first (a non-zero `merge.run` leaves the node `ok` today because `runMerge`'s return is discarded at `runner.ts:980`), then assert the NEW routing (`warn`→`ok`+warn issue, `block`→`blocked`); **fails today on the new-routing assertion** (#18 is an ADDITION, not a preserve); `op-codec-roundtrip.test.ts` (`nodeFromMarkers(markersFromNode(opNode))` deep-equals `opNode.op` — fails today, no `DRIVER-OP` marker).

**ADDITIVITY CHECK:** the executors are unchanged (only the dispatch frame changes); an OLD-grammar node lowers to the identical `op[]` AT THE LOADER, so the game-omni all-native template (`hooks`+`checks`+`policy`) compiles + runs byte-identically; old keys are `@deprecated`, lowered before the dense `NodeSpec`, never retained on it. Promote barrier and seed idempotency preserved with their own gating tests (M6).

**ACCEPTANCE:** the 8 grammars + 6 I/O styles + 5 inline consequences are one envelope; #9/#10/#11/#16/#22 closed and #18 added (exit code now routes to status); the new `op[]` shape round-trips through the codec; every old template still compiles.

---

## M6 — Derive/merge correctness + capability-preservation superset
**Closes:** #12, #13, #19, #20 · **G-number:** G13 · **Branch:** `fix/g13-derive-correctness`

**STEPS**
- #12: wire the `union` projection path (`project.ts:184` is built but dropped) into `transform:{kind:'projectRegistry'}`.
- #13: serialize same-target `fold` ops into ONE post-barrier assembly node (the fusion write-disjoint pattern) — kills the lost-update race.
- #19: verify companion-mode `elidePhases` is actually consumed (assert the declared profile is not inert).
- #20: surface the OpenClaw `before_tool_call`/`tool_result_persist` hook-bus no-op as `advisory` gate kinds (Dagster `blocking=False`), not silent.
- Author the capability-preservation suite (OQ5): one discriminating test per preserved capability (`merge.run`→status, `promote` reducers incl. arrays-REPLACE + `set`-conflict⇒HALT, `seed` idempotency/skip-if-filled, `checks⊥policy` flip-`onFailure`-without-touching-`gate`, `when:on-failure`, `union` dedup, parallel-`fold` all-fragments-present).

**TEST-FIRST GATE:** `union-projection.test.ts › a 2-source projectRegistry union yields the deduped index.json`. **Fails today** because `union` is built but the calling path drops it (blank-sprite failure, #12). Companion gate: `fold-barrier.test.ts › 3 parallel folds into one file → all 3 fragments present` (fails today — lost-update race, #13).

**ADDITIVITY CHECK:** `union` and the fold-barrier wire EXISTING executors into the (already byte-identical) lowered path; the capability suite asserts the NEW envelope is a strict superset of the OLD grammar — a node authoring the old keys produces the identical result.

**ACCEPTANCE:** #12 correct `index.json`; #13 race-free; #19/#20 verified/surfaced; every Q5 capability has a discriminating test that fails if regressed.

---

## M7 — Long-tail nits (ride their adjacent code)
**Closes:** #23, #24 · **G-number:** rides G11/G13 (doc-only) · **Branch:** `chore/doc-drift`

**STEPS**
- #23: fix the stale `coding-plan.ts` path cited everywhere → `templates/legacy/...`.
- #24: reconcile the host `registerRuntimeLifecycle` doc drift (`dispose` vs `cleanup`).
- (#22 already closed in M5 the moment `run` ops became authorable; #14 is the DEFERRED bridge follow-on from M2 — tracked, never counted as closed.)

**TEST-FIRST GATE:** none (doc-only); a `grep` assertion in CI that the stale `coding-plan.ts` path no longer appears under `docs/` and `packages/`.

**ADDITIVITY CHECK:** documentation/path corrections only; no behavior change.

**ACCEPTANCE:** no stale path references; lifecycle doc matches the implementation.

---

## Issue coverage tally (checklist (c))

| Issue | Milestone | Disposition |
|---|---|---|
| #1 (BLOCKER), #7, #8 | M0/M1 | closed |
| #3, #21 | M2 | closed |
| #14 | M2 | **DEFERRED** (tracked in `@piflow/tool-bridge`; NOT counted as closed) |
| #2 (BLOCKER), #5, #17 | M3 | closed |
| #4, #6, #15 | M4 | closed (#4 in full; #15 as documented `block` alias) |
| #9, #10, #11, #16, #18, #22 | M5 | closed (#18 as ADDITION) |
| #12, #13, #19, #20 | M6 | closed |
| #23, #24 | M7 | closed |

All of #1–#24 accounted; #14 explicitly deferred; #22 in M5. No number dropped, none double-owned.

---

## Sequencing rationale

The order is forced by dependency facts, not preference.

1. **M0 before everything — the red bar must exist before the fix.** Today every `runWorkflow` test stubs `buildCommand` AND most pass an explicit registry, so blocker #1 is INVISIBLE to CI (investigation §5, Island A). A fix with no failing test is coverage theater; M0's LOAD-BEARING V1 routes through `runFromTemplate` with NO explicit registry so it genuinely `block`s on today's code (the explicit-registry direct-`runWorkflow` smoke is GREEN today and is deliberately NOT the gate) and asserts the agent's own `tool_execution_end` event, giving M1 a bar to turn green.

2. **G11 (M1–M2) is the foundation the other two build confidence on.** It is the only blocker fix needing no new authoring vocabulary and zero dense-spine change; `assembleRunTools` is the single seam G12/G13 layer ON, never around. Its live-pi gate de-risks every later milestone. M2's dead-field/StringEnum fixes are small and ride the same tool concern, so they commit immediately after M1 while the context is hot.

3. **G12 (M3–M4) before G13 (M5–M6) — control-flow is model-free, deterministically testable, and introduces the primitives G13 references.** M3's `expandReroute` and M4's `Escalator`/`PolicyAction`/`classifyFailure` are CANONICAL; **M5 (`action:rerouteTo`/`retry`/`escalate` sugar) is BLOCKED-BY M3+M4** — the sugar lowers to them, so M5's action-lowering tests cannot green against absent primitives (pinned in the M5 header). Shipping G12 first means the heaviest migration (M5's alias lowering + codec extension, the one byte-identical-back-compat risk) does NOT block the two blockers. M3 precedes M4 because the unroll pass is the structural carrier; M4's runtime actions slot onto the stages M3 produces.

4. **G13 (M5–M6) last — the largest surface, the most touched files, the riskiest single change.** M5 is the one justified spine widen (one field; aliases lowered at the loader, NOT retained on the dense type) PLUS the codec `DRIVER-OP` round-trip; M6 is the data-integrity superset proof. Both depend on G11 (tools delivered) and G12 (the `action`/`reroute` primitives) already being real, so the unification is the closing move, not the opening one.

5. **M7 (nits) last — doc/path drift rides whichever G-number owns the adjacent code, fixed opportunistically without holding up a blocker.**