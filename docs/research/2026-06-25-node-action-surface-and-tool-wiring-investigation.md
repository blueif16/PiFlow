> **Provenance:** Read-only investigation, 2026-06-25, run `wf_89dab259-592`. Produced by a 5-agent workflow: SDK action-surface map · game-omni template demands · pi/OpenClaw + cross-framework best-practice corpus · adversarial defect confirmation. Evidence-dense with `file:line` citations. **Findings only — no design.** The converged target + fix plan live in `docs/design/node-action-protocol.md` and `docs/specs/node-action-protocol-fix-plan.md`.

---

# piflow Node Action Surface — Synthesis Investigation Report

This report consolidates four read-only audits: (1) the SDK action-surface map (every PRE/POST mechanism a node binds to), (2) the game-omni template's actual demands (the real-world workload), (3) the best-practices corpus (pi/OpenClaw wiring + cross-framework hook vocabulary), and (4) an adversarial confirm/refute of every suspected defect. It is a findings + best-practice document. No design, no implementation.

---

## 1. Node Pre/Post Action Taxonomy

Four categories, grounded in what game-omni's 15 `node.json` + prompts ACTUALLY demand (Input 2), mapped to the SDK surface that serves (or fails) each (Input 1). Category legend: **DTD** data-triggered decision script · **DRS** dataless required script · **QGC** quality-gate check · **TA** trigger-action (retry/warn/notify/stop/escalate).

### DRS — dataless required script (run a fixed step, no data branch)
| Demand (game-omni) | SDK surface | Status |
|---|---|---|
| Seed a starting artifact / dir tree (D1, D3) | **#1 `hooks.seed`** (`seed.ts:93` recursive dir copy; idempotent skip-if-filled) | SERVED |
| Per-node toolset allow/deny (D13) | **#3 `tools.allow`/`deny`** (`node.schema.ts:53`) | SERVED for **native** names; **latent blocker** for `oc.*`/`mcp.*` (see §4 blocker) |

### DTD — data-triggered decision script (derive/transform from data)
| Demand | SDK surface | Status |
|---|---|---|
| Token-resolved seed source `{{state.x}}`+`{file:field}` (D2) | **#1 `hooks.seed`** `from` grammar (`seed.ts:34`) | SERVED |
| Promote output field → run STATE (D4) | **#15 `hooks.promote`** (`set`/`append`/`deepMerge`, barrier-merge; `set`-conflict ⇒ HALT) | SERVED |
| Derive artifact via subprocess (D5) | **#13 `hooks.merge` `run` op** (`spawnSync`, `merge.ts:175`) — the ONLY author-reachable shell-exec | SERVED (but exit-code consequence is inline — see §2 / G7) |
| Fold fragment into shared JSON (D6) | **#13 `merge.fold`** | SERVED but **lost-update race** when 3 siblings fold one file (G2) |
| Concat glob (D7) / reconcile manifest (D8) | **#13 `merge.concat` / `reconcile`** | SERVED |
| Registry/genre projection incl. `union` (D9) | **#14 `hooks.registryProject`** | PARTIAL — `project.ts` ports copy/assemble/merge, **drops `union`** → wrong `index.json` (G5) |
| Static DAG selection by run input (D26 companion elision) | `meta.json profiles.elidePhases` | template-level; **consumption unverified** (G8) |

### QGC — quality-gate check (detect; consequence via policy)
| Demand | SDK surface | Status |
|---|---|---|
| Required-artifact existence (D10) | **#7 `contract.artifacts`** (`runner.ts:984-1000`) | SERVED |
| Owns / read-scope (D11/D12) | sandbox `write`/`owns`, `read` (OS-enforced) | SERVED |
| JSON-Schema validation (D14) | **#7 `contract.schema`** | SERVED |
| Fill-sentinel completeness (D15) | **#9 `contract.fillSentinel`** (`checks.ts:138`) | SERVED |
| Declarative content check (D16 `fenced-tail` ≥3) | **#8 `checks.post`** | SERVED |
| Structured fenced-JSON return (D17) | **#10 `contract.returnMode`+`return`** | SERVED |
| Advisory non-blocking VLM verdict (D28) | could map to `checks`+`policy.warn` | PARTIAL — no first-class "advisory check" kind; today a free `return` field (G9) |

A structural limit cuts across QGC: **`count-floor` asserts "≥N items EXIST, never that items are GOOD"** (`checks.ts:5-7`). There is NO per-node post-gate vocabulary that judges goodness; LLM-as-judge quality lives only out-of-band (fusion judge / criteria fixture).

### TA — trigger-action (retry / warn / stop / escalate)
| Demand | SDK surface | Status |
|---|---|---|
| Self-reported status routes verdict (D18) | **#11 node return `status`** (driver-verified beats it; `runner.ts:1080`) | SERVED |
| Fail → block/stop run (D19) | **#8/#19 `policy.fail`** + run-level halt (`runner.ts:1589`) | SERVED |
| Per-node bounded retry (D20) | **#17 `io.retries`** | SERVED but **fires ONLY on `error`/`blocked`**, never on a `gap`/`warn` (G3) |
| Per-node timeout (D21) | **#18 `timeoutMs`** (`runner.ts:919`) | SERVED |
| Escalate to stronger/cross-family model w/ evidence (D22) | — | **GAP** — escalation ladder DEFERRED (`runner.ts:12`); `PolicyAction.retry-once`/`subagent-fix` collapse to `block` (`checks.ts:154-156`) |
| Conditional route-back on verify FAIL (D23) | — | **GAP (load-bearing)** — routing is static (`deps`); reroute is PROSE only (`verify-2-m1/prompt.md:18`) |
| Bounded self-fix + cycle counter (D24) | — | **GAP at SDK layer** — `.fixcycles-M2.json` is node-self-managed; core has zero `fixcycle` wiring |
| Halt on missing upstream / resume preflight (D25) | run-level halt + `--from` | PARTIAL — no `DRIVER-PREFLIGHT` existence-gate node surface (G6) |
| Regression-guard re-run after self-fix (D27) | — | **GAP** — in-prompt only |

**Net taxonomy verdict:** the QGC and the "deterministic step / seed / derive" families are well served. The **entire TA family beyond retry-on-hard-failure is missing or prose-only** — and that family (escalate-with-evidence + conditional reroute + bounded self-fix) IS game-omni's correctness/QA story. It "works" today only because each verify node self-loops inside its own agent turn and a hard failure halts the run.

---

## 2. Uniformity Verdict

**NOT uniform. There is NO single "run script X over declared files Y → produce/decide/gate/act Z" grammar.** The node spine is principled at the TYPE level (`types.ts:17` — "five concerns: work · sandbox · tools · hooks · contract") but the AUTHORING surface fragments into ~8 incompatible op grammars under one `hooks` key plus three more declaration styles.

**Inputs/outputs declared ≥6 different ways:** `io.reads`/`io.produces` (DAG edges; but loader hard-codes `reads:[]`, `loader.ts:118`) · `contract.artifacts` (gated outputs; `produces = artifacts`, `loader.ts:122`) · sandbox `read`/`write` (OS scope, a 3rd I/O vocab) · `hooks.seed {to,from}` · `project`/`merge`/`promote` (each its own source/dest keys) · `Hook[] {inputs,outputs}` (a 7th, runtime-only).

**Four non-aligning "point at a file/field" notations:** seed `{{…}}`+`{file:field}` drill (`seed.ts:34`) · promote `<artifact>:<field>` / `@return:<field>` (`promote.ts:79`) · project/merge bare run-relative paths under `projectBase` · checks run-relative `path`.

**The headline trap — two things both named "hooks":** `NodeSpec.hooks` = shell/fn `Hook[]` (runtime-only); `node.json.hooks` = declarative `NodeOps` (seed/project/merge/promote/registryProject). The loader maps `node.json.hooks → NodeOps` only (`loader.ts:94`), NEVER to `Hook[]`. Same word, two layers, different meaning.

**Decision⊥consequence is clean in exactly ONE place:** `checks` (detection) ⊥ `policy` (consequence) is genuinely well-factored (`types.ts:179`). That discipline does NOT extend: `merge.run`'s exit code, a `Hook`'s `failure`, an artifact's existence, and a `returnSchema` breach each encode their consequence INLINE, with no shared policy vocabulary (G7 — `model/node.json:53` even documents "misses are NON-FATAL" purely in prose).

### Duplication / overlap map (Input 1 §"Duplication")
| Overlap | Members | Verdict |
|---|---|---|
| Two "run a deterministic step" | `Hook[]` shell/fn (#2/#16) vs `merge.run` (#13) | REDUNDANT capability; but `Hook[]` is unauthorable from a template, so `merge.run` is today the ONLY author-reachable shell-exec |
| Two "derive an output" families | `project` (copy/assemble/merge/union) vs `merge` (fold/concat/reconcile/run) | PARTIALLY redundant (both generic JSON transforms over a frozen source); kept distinct for porting fidelity, not necessity |
| Two integrity shapes | `io.checks` (evaluated) vs `io.checksPrePost` (round-tripped, **never evaluated**) | `pre` lane DEAD (`render.ts:16` flattens pre+post→post); necessary only as a codec round-trip artifact |
| Two output ledgers | `io.produces` vs `contract.artifacts` | identical (`produces = artifacts.slice()`); `reads`/`produces` edge inference vestigial |
| `model` vs `tier` | — | NOT duplication (tier = indirection; precedence single-homed in `model-routing.ts`) |
| cli/langgraph/tool-bridge | — | NO node-action surface; langgraph only transports run status, tool-bridge only executes a call; both INHERIT core's registry-less gaps |

**What one protocol could subsume:** a single declarative op envelope — `{ op, when:'pre'|'post', reads:[], writes:[], on-failure:'block|warn|stop|retry', run|transform|gate-spec }` — could replace seed + project + merge + promote + the unreachable `Hook[]` + the inline artifact/check/return consequences. Today those are **8 grammars, 6 I/O conventions, 5 inline consequence encodings**. (Reported as an observation, not a design.)

---

## 3. Best Practices To Adopt

### 3a. Canonical pi / OpenClaw tool-wiring pattern (Input 3, grounded in Context7 `/earendil-works/pi` + `/openclaw/openclaw`)
The blessed **ingest → schema → bind → execute** pipeline (Input 4 confirms it is FULLY BUILT as pure functions, but NOT wired into the CLI run path):
1. **DISCOVER** — crawl OpenClaw `extensions/*` manifests filtered to non-empty `contracts.tools`; mirror the MCP registry incrementally. (`discoverToolBearingPlugins`, `openclaw-host.ts:594`.)
2. **SCHEMA** — OpenClaw manifest is NAMES-ONLY → a SKELETON entry (`description:''`, params omitted, never fabricated, `ingest.ts:90`). Fill description+TypeBox params by running `register(api)` under the capture-shim whose **absent `api.runtime` is the purity gate** (`openclaw-shim.ts:16`). MCP `tools/list` maps 1:1.
3. **REGISTER + CONFLICT-GUARD** — flat name space; **prefix-on-collision (`<source>_<piName>`), resolve never skip** (`registry.ts:51`).
4. **VERIFY (bind pre-check)** — declared ⊆ bindable; only two real failures: MISSING + COLLISION (`verify.ts:38`); a miss → node `blocked` before spawn.
5. **BIND** — compile one `registerTool` per non-builtin; mcp/unpinned-sdk route by `callTool(address,…)`, pinned sdk binds native execute; params `Type.Unsafe(jsonSchema)`; **esbuild-bundle host-side** so identical bytes resolve on any sandbox/cloud VM (`compile.ts:303`).
6. **DELIVER + EXECUTE** — stage `_pi/tools.ts`+`_pi/mcp.json`, spawn headless pi with `--tools` + `-e`; secrets as `$VAR` refs, **declared allowlist only on cloud, never full `process.env`** (`runner.ts:479`).

**Key facts to honor:** pi's selection surface is a **flat allowlist of bare names** — any `namespace:name` is purely an SDK abstraction (`registry.ts:1-4`). pi has **No native MCP** ("build an extension that adds MCP support" — README); MCP is an extension concern, which is what `@piflow/tool-bridge` is. The pre-call veto is the extension-side `pi.on("tool_call")` ONLY — there is no `beforeToolCall` option on `createAgentSession`.

### 3b. Cross-framework hook & trigger-action vocabulary (Input 3 §"Cross-Framework")
| Framework | retry | fallback | notify | gate | compensate | timeout | Source |
|---|---|---|---|---|---|---|---|
| **pi** | re-`sendUserMessage` | — | `ctx.ui.notify` | `pi.on("tool_call")`→`{block}` | — | driver watchdog | Context7 `docs/extensions.md` |
| **OpenClaw** | — | — | channel hooks | `before_tool_call` deny | — | `requireApproval{timeoutMs,timeoutBehavior:"deny"}` | Context7 `hook-types.ts` |
| **Claude Code** | Stop-hook loop | `permissionDecision:"ask"` | `Notification` | PreToolUse exit 2 | — | per-hook `timeout` | code.claude.com/docs/en/hooks |
| **LangGraph** | per-node `RetryPolicy` | conditional edge → fallback node | — | conditional edge / `interrupt()` HITL | — (manual) | node timeout | Context7 langgraph |
| **Temporal** | **first-class per-step `RetryPolicy`** | — | — | fail on retry-exhaustion | **Saga: auto-run compensation per forward step** | activity/workflow timeouts | temporal.io/blog (Saga) |
| **dbt** | — | — | — | failing pre-hook skips model | txn rollback | — | corpus |
| **Airflow** | `retries`/`retry_delay` | trigger rules | `on_failure_callback`→Slack/email | downstream skip via trigger rules | — | `execution_timeout` | airflow callbacks docs |
| **Dagster** | op `RetryPolicy` | — | failure sensor (Slack) | **`@asset_check(blocking=True)`** | — | run timeout | docs.dagster.io |
| **Prefect** | `retries` | — | **Automations** (event-driven) | Automation gate | `on_rollback` txn hook | task timeout | docs.prefect.io |
| **n8n** | "Retry on Fail" | "Continue On Fail" + error branch | Error Trigger → Slack | `Stop And Error` node | — | — | docs.n8n.io |
| **GitHub Actions** | — | — | — | step `if: success()` | `post:` runs on failure | step/job timeout | corpus |

**What the powerful frameworks expose that piflow LACKS:**
1. **Per-step retry policy that distinguishes failure CLASS** (Temporal/LangGraph/Dagster/Airflow all have first-class `RetryPolicy`). piflow's `io.retries` re-runs the SAME envelope and fires only on `error`/`blocked` — no retry-on-quality-gate, no retry-on-different-model/tier (G3, D22).
2. **Automatic compensation / rollback** (Temporal Saga, Prefect `on_rollback`, GitHub `post: always()`, dbt txn). piflow has NO per-node "if I fail, run cleanup" — `Hook[] when:'on-failure'` could express it but is unauthorable.
3. **`when: always | on-success | on-failure` firing control made a DECLARED knob** (GitHub `post-if: always()`, Prefect, dbt). dbt's *implicit* "post-hook skips on failure" is the #1 practitioner pain — make it explicit.
4. **Blocking validation gate with an advisory escape hatch** (Dagster `@asset_check(blocking=True)`). piflow has block/warn but no first-class advisory-check kind (G9).
5. **Typed HITL interrupt with timeout-behavior** (LangGraph `interrupt()`/`Command(resume)` + OpenClaw `requireApproval{timeoutMs}`). piflow's checkpoint (#5) parks but has no timeout-behavior vocabulary.
6. **notify / escalate as first-class actions** (Airflow `on_failure_callback`, Prefect Automations, n8n Error Trigger, Dagster failure sensor). piflow has ZERO notify/webhook/Slack surface (`grep notify` → 0 hits) and escalation is DEFERRED.
7. **Conditional edges as the routing primitive** (LangGraph). piflow routing is static `deps`; the QA loop is prose-only (D23).
8. **Determinism discipline** — keep hooks model-free; promote any LLM-on-a-seam to its own node with its own sandbox + tool allowlist (corpus `node-hooks-best-practices:129-138`). piflow already lives the pre-veto-vs-post-cannot-undo asymmetry via `tool_call`-blocks-vs-driver-post-check.

---

## 4. Verified Issue List (deduped across all four inputs)

Defects appearing in multiple inputs are merged (Inputs 1 and 4 substantially overlap; Input 4 is the adversarial confirmation). Ordered by severity.

| # | Title | Claim | Evidence (file:line) | Sev | Conf | Sources |
|---|---|---|---|---|---|---|
| 1 | **Catalog never seeded into canonical run path (THE blocker)** | `runFromTemplate`/`runFromConfig`/CLI build no `registry` and no `mcpConfig`; `runWorkflow` defaults to bare `DefaultToolRegistry()` (builtins+`submit_result`). Any `oc.*`/`mcp.*` selection → MISSING in `verifyToolBinding` → `blocked` BEFORE pi spawns. `seededRegistry`/`loadCatalog` have **zero non-test callers**. | `entry.ts:98-113`; `run.ts:278-296`; `config.ts:51-65`; `runner.ts:1347`; `verify.ts:60-62`+`runner.ts:775-778`; `registry.ts:82`; `inspect.ts:133`; `catalog.ts:58` | **blocker** | high | I1, I2(G6/D13), I4 |
| 2 | **Conditional reroute on verify FAIL has no authoring surface** | game-omni's QA loop (verify-2 FAIL ⇒ re-run W4/VERIFY-1) is PROSE in prompts; the DAG is strictly forward; runner cannot re-enter an upstream node on a `VALIDATION_FAILED` marker. Loop survives only via in-turn self-fix + run-halt. | `verify-2-m1/prompt.md:18`; `w4-execute-m1/prompt.md:23`; forward-only DAG `migrate-game-omni.test.ts:90`; absent: SDK map "routing is static (`deps`)" | **blocker** | high | I2 |
| 3 | **`node.json.mcp` accepted but never read (dead field)** | Schema + `TemplateNode` define `mcp:{servers,ref}`, but the loader never reads `def.mcp.servers`; only the static path-check reads `mcp.ref`. Declared MCP servers silently dropped. | `node.schema.ts:62`; `template/types.ts:27`; `loader.ts:106-159`; `template/checks.ts:241` | major | high | I1, I4 |
| 4 | **Escalate-with-evidence (legacy reliability core) unported** | Legacy `runNodeWithEscalation`/`classifyFailure`/`consultPreamble` (re-run on a stronger cross-family model fed prior failure evidence) has NO per-node surface; `model`/`tier` are static-only; `PolicyAction.retry-once/subagent-fix` collapse to `block`. | `run.mjs:91,1954-2022,1970`; `runner.ts:12`; `checks.ts:154-156` | major | high | I2(D22), I1 |
| 5 | **Bounded self-fix cycle counter is node-self-managed, not an SDK mechanism** | The "harness-enforced ≤3-cycle" the verify prompt promises is written BY the verify node (`.fixcycles-M2.json {attempts:3}`); core has zero `fixcycle` wiring. No "retry-while-quality-gate-fails, bounded" surface. | `verify-2-m1/prompt.md:18`; live `runs/run01/verify/.fixcycles-M2.json`; `grep fixcycle packages/core/src` → 0 | major | high | I2 |
| 6 | **Retry cannot trigger on a quality-gate verdict** | `io.retries` fires only on `error`/`blocked`; a `fenced-tail` `gap`/`warn` (milestones<3) cannot trigger a redo. | `w1-design/node.json:20,36`; `runner.ts:758` | major | high | I1, I2(D20/G3) |
| 7 | **`mcpConfig` never built by cli/config** | `ResolvedRunOpts` omits `registry`+`mcpConfig`; `loadConfig` never produces them; only tests populate `mcpConfig`. `stageMcp` unreachable on a real run. | `config.ts:51-65,105-130`; `runner.ts:804` | major | high | I1, I4 |
| 8 | **No E2E test binds+executes a node-declared tool in a LIVE pi via the generated `-e`** | Every `runWorkflow`/`runFromConfig` test stubs `buildCommand`; the live precedent exercises `hostOpenClawTool`, not the generated `-e`; compile tests `new Function`-eval with stubs; the calc "real pi" proof is a comment. Blocker #1 is invisible to CI. | `runner.test.ts:444-495`; `tools-compile.test.ts:149-188`; `catalog.test.ts:87-94`; `openclaw-host-llm-task.test.ts:184`; `calc.ts:8` | major | high | I1, I4 |
| 9 | **Shell/fn `Hook[]` has no template authoring surface** | The only general deterministic pre/post side-effect mechanism (`NodeSpec.hooks.pre/post`) cannot be authored in `node.json` — loader maps `node.json.hooks` exclusively to `NodeOps`. Only `fusion/expand.ts` sets it. | `loader.ts:94-103,146`; `types.ts:48` vs `:58`; `runner.ts:897,1097` | major | high | I1, I4 |
| 10 | **`inject` forced-reads never folded into the prompt** | Schema-valid + validated for producer/consumer wiring, but file contents (nor an `@path` ref) never delivered into the realized prompt; loader sets `reads:[]`. | `node.schema.ts:108-111`; `loader.ts:11,121`; `instantiate.ts:60-70`; `template/checks.ts:221-223` | major | high | I1, I4 |
| 11 | **`checks.pre` lane dead (no pre-input gate)** | `collectChecks` flattens pre+post into one post list; runner evaluates only after collect; `checksPrePost` round-tripped but ignored. Cannot gate on STAGED INPUTS before the model runs. | `render.ts:15-23`; `runner.ts:1012-1015`; `types.ts:253-255` | major | high | I1, I4 |
| 12 | **`union` projection op dropped → wrong `index.json`** | `w2-scaffold registryProject` needs `union` to build asset-slot rows; `project.ts` ports copy/assemble/merge, drops `union`. Result: thin `index.json` (blank-sprite failure) unless hand-written. | `w2-scaffold/node.json:66`; legacy `run.mjs:553`; `d10…:101,135` | major | high | I2 |
| 13 | **Parallel `fold` into one file is a lost-update race** | shell∥guidance∥sound each `fold` into the SAME `spec/blueprint.json` in the parallel producer stage — 3 concurrent read-modify-writes. No post-barrier "assembly" surface. | `guidance/node.json:38`+`shell:36`+`sound:38`; `migrate-game-omni.test.ts:66-71`; `d10…:108-120` | major | high | I2 |
| 14 | **`$VAR` expansion is a DESIGN, not built (tool-bridge)** | `@piflow/tool-bridge` uses config values VERBATIM — no `$VAR` substitution; a literal `"$GITHUB_TOKEN"` reaches the MCP server as the 12-char string → opaque `connect-failed`. **Scope note:** this is a tool-bridge-internal concern; the runner side correctly stages the verbatim `$VAR` config and forwards resolved env. | `tool-bridge-env-2026-06-21.md:16-22,256-262` | major | **med** | I3 (I4 confirms runner side correct, did not re-verify bridge) |
| 15 | **`policy.fail:"stop"` behaviorally identical to `"block"`** | `actionForVerdict` preserves `stop`, but the runner's blocking filter only excludes `warn` (`!== 'warn'`), so `stop` and `block` both → `blocked` and both halt at the stage boundary. Vocabulary distinction, no runtime effect. | `checks.ts:156`; `node.schema.ts:234`; `runner.ts:1018-1019,1074-1076,1589` | minor | high | I1, I4 |
| 16 | **`io.reads`/`io.produces` edge inference vestigial in template path** | Loader hard-codes `reads:[]`, derives edges from `deps`, sets `produces = artifacts.slice()`. The "edges from io" design is inert for any template-authored workflow. | `loader.ts:118-124` | minor | high | I1, I4 |
| 17 | **No pure existence-gate node / resume-preflight surface** | Legacy `DRIVER-PREFLIGHT` no-pi existence-gate + `--from` resume preflight (HALT on missing skipped-node artifact) have no `node.json` field. | `run.mjs:342-348,2053-2074` | minor | high | I2(G6) |
| 18 | **`merge.run` gate consequence inline, no declared policy** | Five nodes gate on a subprocess whose blocking-ness ("else status=blocked" / "misses are NON-FATAL") lives in prose `note`s + exit semantics, not a declared `on-failure: block|warn` — unlike the clean `checks`⊥`policy` split. | `w2-scaffold/node.json:121`; `w4-execute-m1/node.json:54`; `model/node.json:53` | minor | high | I1, I2(G7) |
| 19 | **Companion-mode `elidePhases` consumption unverified** | `meta.json profiles.companion.elidePhases` declares the static DAG branch, but no loader/compile consumer is evidenced; if unconsumed, the declared profile is inert. | `meta.json:17`; `d10…:122` | minor | **med** | I2(G8) |
| 20 | **OpenClaw `before_tool_call`/`tool_result_persist` hook bus silently no-op'd** | Host stubs `api.on` + `registerHook`. A future plugin whose OWN tool self-gates via `before_tool_call` would have that gate skipped (host drives `tool.execute` directly, bypassing the loop). No bundled plugin does this today. | `openclaw-host.ts:453,473`; `openclaw-shim.ts:80-81`; Context7 `hook-types.ts` | minor | med | I3, I4 |
| 21 | **`StringEnum` not enforced on captured/generated params** | Captured/generated params pass verbatim as `Type.Unsafe(...)`; a hand-authored `Type.Union(Type.Literal)` enum is fine on OpenAI-compatible `cp` but **breaks on Google/Gemini** (pi requires `StringEnum`); not auto-rewritten. | `compile.ts:155`; `node-contract.ts:70` | minor | med | I3 |
| 22 | **PRE-hook outcome hardcoded `'success'`** | `runHooks(node.hooks?.pre, …, {outcome:'success'})` — a pre-hook can never see `'failure'`, so `when:'on-failure'` on a pre-hook is unreachable (correct by construction now, latent trap once #9 is fixed). | `runner.ts:897`; `hooks/index.ts:30-33` | nit | high | I1, I4 |
| 23 | **Stale `coding-plan.ts` path cited everywhere** | Briefs + host doc cite the old `pi-runner/providers/` location for `coding-plan.ts`; real file is `templates/legacy/providers/coding-plan.ts` (only a worktree copy remains). Documentation-only. | `pi-tools-…:352`; `openclaw-substrate-adoption.md:138` | nit | high | I3 |
| 24 | **Host `registerRuntimeLifecycle` doc drift (`dispose` vs `cleanup`)** | Host comment documents `{id,description,dispose}`; installed dist passes `{id,description,cleanup}`. Harmless (field is no-op'd) but misleads an S4 implementer. | `openclaw-host.ts:469-472`; dist `codex-supervisor/index.js` | nit | med | I3, I4 |

### Contradictions reconciled
- **Issue #1 severity (blocker) vs game-omni "works today":** Input 2 notes game-omni uses ONLY bare native tool names (D13), so it *dodges* the blocker — the blocker is latent for that template but a hard wall for any `oc.*`/`mcp.*` node. Both streams are consistent once scoped: the registry-less path is a confirmed blocker for non-native tools, not a regression in the native game-omni run. **Not a contradiction.**
- **Two "blocker"-class items (#1 registry wiring, #2 reroute) come from different streams** measuring different surfaces (tool-binding vs control-flow). Both are genuine blockers in their respective domains; neither subsumes the other. Kept both at blocker.
- **Issue #14 ($VAR) confidence:** Input 3 rates it major/med as a tool-bridge defect; Input 4 explicitly did NOT re-verify the bridge line-by-line and confirms only that the runner side is correct. Confidence held at **med**, scope flagged as tool-bridge-internal. **Flagged, not resolved by code.**
- **No direct factual contradictions** were found between the four streams; Inputs 1 and 4 agree on every shared defect (Input 4 is the adversarial re-confirm and upheld all of Input 1's claims).

---

## 5. E2E Test Gap & Plan

**Does ANY test take a discovered (not hand-coded) OpenClaw plugin, ingest it, select it on a node, and prove it BINDS + EXECUTES inside a LIVE pi via the generated `-e`? NO.** Coverage splits into three islands that never meet (Input 4):

| Island | Proves | Does NOT prove | Evidence |
|---|---|---|---|
| A. Compile/bundle | the `-e` source has the right `registerTool`/flag/bytes | nothing executes; read as a STRING or `new Function`-eval'd with stubs; `buildCommand` returns a `printf` so **pi never spawns** | `runner.test.ts:444-495`; `tools-compile.test.ts:149-188` |
| B. Plugin execute (host path) | a real plugin's execute runs (`memory_get`, `llm-task` via nested pi) | runs through `hostOpenClawTool`, NOT the generated `-e` in a live agent | `openclaw-host-memory-get.test.ts:42-71`; `openclaw-host-llm-task.test.ts:93-208` |
| C. Seed execute (unit) | `calc:add` native execute returns `sum:5` | a direct `def.execute(...)` call, not pi | `catalog.test.ts:87-94` |

The `calc.ts:8` "Proven end-to-end in real pi 0.79.0" is a **manual, uncommitted proof**. Every `runWorkflow`/`runFromConfig` test injects `buildCommand: stubBuilder()` — so blocker #1 is invisible to CI.

**The one live-pi precedent to copy:** `openclaw-host-llm-task.test.ts:78-91,180-207` — `piLiveProbe()` runs `execFileSync('pi', ['--list-models'])` (offline, fast), checks the model is configured, gates the live case with `it.skipIf(!probe.runnable)`. Reuse this exact gating shape.

### Missing-test spec (spec only — do NOT implement)
**File:** `packages/core/test/runner-live-tool-e2e.test.ts` (new; in core because it exercises `runWorkflow` + the real registry + real `defaultPiCommand` — no stub builder).

**Shared gating:** extract `probePi()` → `execFileSync('pi', ['--list-models'], {timeout:20_000})`, `runnable=false` with reason if the binary throws or the chosen model is absent (provider/model from env, default the configured pair the existing test uses). For V1 also require `await import('@piflow/core/seeds/calc')` to resolve. Use `it.skipIf(!probe.runnable)(...)` with a 180_000ms timeout.

**V1 — LOCAL basic (the load-bearing one that catches the blocker):**
- ARRANGE: `const registry = seededRegistry()` (`catalog.ts:58`) — the production-shaped registry carrying `oc.calc:add` that the canonical path FAILS to use. One node: `tools.allow:['oc.calc:add','contract:submit_result']`, sandbox `read`/`write` scoped to out dir, prompt = "Call calc_add with a=2,b=3, then call submit_result with status ok and the sum in summary." `LocalSandboxProvider`. **No `buildCommand`** — let the runner use `defaultPiCommand` so a real `pi -p --mode json … -e _pi/<id>/tools.ts --tools calc_add,submit_result …` spawns.
- ACT: `await runWorkflow(compile(spec), { run:'calc-live', outDir, provider: new LocalSandboxProvider(), registry, providerName: probe.provider, model: probe.model, recordEvents:true, nodeTimeoutMs:120_000 })`.
- ASSERT (must FAIL if the tool didn't bind+execute):
  1. `status.nodes['<id>'].status === 'ok'` (bind miss → `blocked`; exec failure → `error`).
  2. **The tool actually ran** — read `.pi/nodes/<id>/events.jsonl`, assert a `tool_execution_end`/`_start` with `toolName==='calc_add'` AND result text / `details.sum === 5`. (Asserting on the events stream, not just final status, is what proves EXECUTION-via-`-e` rather than the model guessing "5" in prose.)
  3. Staged `_pi/<id>/tools.ts` exists and contains `name: "calc_add"` + the captured native execute (the BIND half).
- WHY this is the gate: the ONLY test where the registry has a non-builtin tool AND pi spawns AND we read the agent's own tool-execution event. It fails today's product if wired through `runFromTemplate`/CLI (no registry) — exactly the blocker.

**V2 — SANDBOXED (same node/registry/assertions, OS-enforced):**
- `provider = new SeatbeltSandboxProvider()` (macOS; mirror `sandbox-seatbelt.test.ts`'s `process.platform === 'darwin'` guard) and/or a Daytona provider behind a second probe (`probeDaytona()` → skip unless `DAYTONA_*` env present). `calc` is keyless → no `secretResolver`/`mcpConfig` needed.
- Same three assertions, PLUS assert the staged `tools.ts` has NO `@piflow/tool-bridge` import line (the inlined-bundle invariant, `runner.test.ts:491-492`) — load-bearing on a cloud VM / seatbelt where up-tree `node_modules` is unavailable.
- Gating: `it.skipIf(!probe.runnable || !seatbeltAvailable)` for seatbelt; separate `it.skipIf(!daytonaProbe.runnable)` for V2-cloud.

**Optional V1b (MCP lane):** register a real local MCP server via `mcpToolsToEntries` into the same `seededRegistry`, pass `mcpConfig.servers`, select `mcp.<srv>:<tool>`, assert `tool_execution_end` for the prefixed bare name. Closes the bridge lane that `tool-bridge-real-servers.e2e.test.ts` proves only in isolation (no live pi `-e`).

---

## 6. Top Issues & Best Practices (summary)

### Top issues (severity-ordered)
| Sev | Issue | One-line |
|---|---|---|
| blocker | Catalog never seeded into CLI run path (#1) | any `oc.*`/`mcp.*` node → `blocked` before pi spawns; `seededRegistry` has 0 non-test callers |
| blocker | Conditional reroute has no authoring surface (#2) | game-omni's QA loop is prose-only; static `deps` DAG can't re-enter an upstream node |
| major | Escalate-with-evidence unported (#4) | legacy reliability core has no per-node surface; `model`/`tier` static-only |
| major | Self-fix cycle counter node-self-managed (#5) | no SDK "retry-while-gate-fails, bounded" mechanism |
| major | Retry can't trigger on a quality-gate verdict (#6) | `io.retries` ignores `gap`/`warn` |
| major | `node.json.mcp` dead (#3); `mcpConfig` never built (#7) | declared MCP servers silently dropped |
| major | No live-pi E2E for bind+execute via `-e` (#8) | blocker #1 invisible to CI |
| major | `Hook[]` unauthorable (#9); `inject` undelivered (#10); `checks.pre` dead (#11) | three runtime-supported surfaces with no working author path |
| major | `union` op dropped (#12); parallel `fold` race (#13) | wrong `index.json`; lost-update on shared file |
| major | tool-bridge `$VAR` expansion unbuilt (#14, med conf) | literal token reaches MCP server |
| minor/nit | `stop`==`block` (#15); vestigial `reads`/`produces` (#16); no preflight node (#17); `merge.run` inline policy (#18); `elidePhases` unverified (#19); no-op'd OpenClaw hook bus (#20); `StringEnum` unenforced (#21); pre-hook outcome hardcoded (#22); stale path (#23); doc drift (#24) | vocabulary / doc / latent-trap items |

### Best practices to apply
| Practice | Source | Apply to |
|---|---|---|
| ingest→schema→bind→execute via one registry → one generated `-e` | Context7 `/earendil-works/pi`, `/openclaw/openclaw`; Input 3/4 | wire `seededRegistry`+`mcpConfig` into `runFromTemplate`/CLI (fixes blocker #1) |
| flat bare-name allowlist; namespace is SDK-only; prefix-on-collision | `registry.ts:1-4,51`; pi `args.ts` | tool selection / conflict guard |
| capture-shim purity gate (absent `api.runtime`) | `openclaw-shim.ts:16` | schema capture for OpenClaw plugins |
| esbuild-bundle the `-e`, externals = pi-injected specifiers | `compile.ts:259-265,303` | sandbox/cloud portability invariant (assert no bridge import) |
| pre-veto vs post-cannot-undo asymmetry, made explicit | git/ClaudeCode exit-2/Airflow/dbt | gate vs rewrite semantics |
| `when: always\|on-success\|on-failure` as a DECLARED knob | GitHub `post-if:always()`, Prefect, dbt | hook/op firing control |
| blocking validation gate + advisory escape hatch | Dagster `@asset_check(blocking=True)` | the missing advisory-check kind (#G9) |
| first-class per-step `RetryPolicy` + idempotency + auto-compensation | Temporal Saga; LangGraph/Dagster RetryPolicy | the missing TA family (#4,#5,#6) |
| typed HITL interrupt with timeout-behavior | LangGraph `interrupt()`/`Command(resume)`; OpenClaw `requireApproval{timeoutMs,timeoutBehavior:"deny"}` | checkpoint (#5) headless behavior |
| conditional edges as the routing primitive | LangGraph | the missing reroute surface (blocker #2) |
| keep hooks deterministic/model-free; promote LLM-on-a-seam to its own node | `node-hooks-best-practices:129-138` | op-protocol design discipline |
| live-pi probe + `it.skipIf` gating | `openclaw-host-llm-task.test.ts:78-91` | the new E2E test (§5) |

---

## 7. Completeness Note

- **Not covered / out of scope:** no live MCP-registry mirror exists in code (the bridge introspects a running server instead — by design, Input 4 §1). The non-core packages (`langgraph`, `tool-bridge`) were assessed only for whether they ADD a node-action surface (they do not; both inherit core's registry-less path); their internals were not exhaustively audited.
- **Low-confidence / unverified items:** Issue #14 (tool-bridge `$VAR` expansion) — Input 4 did not re-verify the bridge line-by-line; confidence **med**, scope is tool-bridge-internal. Issue #19 (`elidePhases` consumption) — no loader/compile consumer was evidenced in the runner/loader-built map; **med**. Issues #20/#21/#24 (no-op'd OpenClaw hook bus, `StringEnum` non-enforcement, `dispose`/`cleanup` drift) — **med**, all flagged safe/harmless today. The generic "a pure shipped OpenClaw tool executes under bare `pi -e`" claim remains empirically open (Input 3 §Halts; the S0–S3 host path supersedes most of it with live proof for `memory_get`/`tavily_search`/`llm-task`, but the generic case is untested).
- **Contradictions left unresolved:** none factual. The only reconciliation needed was scope-framing (Issue #1 is a blocker for `oc.*`/`mcp.*` nodes but latent for the all-native game-omni template; the two "blocker"-class items measure different surfaces — tool-binding vs control-flow — and neither subsumes the other). Both are recorded at blocker severity with explicit scope.
- **Evidence basis:** all four inputs reported "Halts: None" — every file named in each brief was read in full. The one stale cited path (the old `pi-runner/providers/` location for `coding-plan.ts`, real loc `templates/legacy/...`) is logged as Issue #23, not treated as a missing-file halt. Two corroborating artifacts were read but not re-verified line-by-line: the live `.fixcycles-M2.json` (confirms #5) and the tool-bridge internals (informs #14).
