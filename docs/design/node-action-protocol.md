# Node Action Protocol — The Unified Node-Op / Trigger-Action / Tool-Wiring Architecture

> **Status:** AS-BUILT / SHIPPED (G11/G12/G13 landed; M0–M7 green on `feat/g12-reroute-unroll`). This document is the as-built ground-truth record — code anchors below are re-verified against the working tree and corrected to their shipped locations (see the Reconciliation log). It supersedes the prose-only correctness story and the three fragmented op grammars; it is the single architecture for **G11 (tool-wiring)**, **G12 (control-flow / trigger-actions)**, and **G13 (the unified op envelope)** — three coupled threads, one principle.
> **Provenance:** distils the investigation `docs/research/2026-06-25-node-action-surface-and-tool-wiring-investigation.md` (24 deduped defects, 2 blockers) through a design brief, three lens-proposals (unification · control-flow · tool-wiring), a scoring judge, and an adversarial critique pass. The fix sequence lives in `docs/specs/node-action-protocol-fix-plan.md`. All code anchors below were independently re-verified against the working tree (branch `feat/g12-reroute-unroll`).
> **Hard constraints (non-negotiable, each pinned):** FROZEN SPINE — additive by default, widening justified (`packages/core/src/types.ts:10-11`, canon `docs/design/l1-node-envelope.md:8,21`); ADDITIVE — a node declaring none of the new fields runs BYTE-IDENTICALLY (the additive optionals `ops?` `types.ts:58`, `checkpoint?` `:66`, and the one new head `op?` `:84`); PRODUCT-AGNOSTIC SDK (`CLAUDE.md:4-5`, the `SecretResolver` seam `types.ts:619,625`); TEST-FIRST — every milestone gated by a test that FAILS when the code is wrong, incl. the live-pi E2E (`packages/core/test/runner-live-tool-e2e.test.ts`).

> **Reconciliation log (2026-06-26)** — the doc was written pre-implementation; these deltas align it to the shipped tree (`old claim → corrected to → evidence`):
> - Status `CONVERGED DESIGN (planned)` → `AS-BUILT / SHIPPED` → M0–M7 green on `feat/g12-reroute-unroll` (`git log`; `595 passed`, the only 7 fails are the relocated game-omni fixture, below).
> - "anchors re-verified against branch `docs/node-action-protocol`" → `feat/g12-reroute-unroll` → current `HEAD`.
> - Lowering "at the loader" → lowering PROPER lives in **`lowerToOps`/`lowerActions`** in the NEW file `workflow/template/lower.ts`, *called from* `loader.ts:120,122` → `lower.ts:44,92`; `loader.ts:120,122`.
> - `reads:[]` hardcode `loader.ts:121` → REPLACED — `io.reads = unique(opReads)` `loader.ts:141`, `io.produces` `loader.ts:143` (derived from injected/op reads+writes) → `loader.ts:126,127,141,143`.
> - `DRIVER-OP` "does NOT exist; extend as an M5 work-item" → SHIPPED (encode + decode) → `contract.ts:130` (encode), `:181` (decode); marker doc `contract.ts:45`.
> - `#15 stop≡block` framed as a pending decision → SHIPPED as the documented alias → `PolicyAction` `types.ts:289` + doc-comment `:285-287`; `RerouteSpec.onFailure` `types.ts:759`; `stop-equals-block.test.ts`.
> - `expandReroute` "inserted in entry.ts:71/:109" → SHIPPED in **`runner/entry.ts`**, immediately after `expandFusion`, in BOTH paths → `entry.ts:95` (`runFromConfig`, after `expandFusion` `:91`) and `entry.ts:140` (`runFromTemplate`, after `expandFusion` `:136`); pass at `workflow/reroute/expand.ts:207`.
> - `expandReroute` chained via `produces ⋈ reads` ONLY (a hidden file-coordination assumption) → now also remaps clone `dependsOn` + converges a deps-coordinated downstream, so **label-coordinated slices (the game-omni shape) chain too** → `expand.ts` `remapIo` dep-remap + `downstreamDepRemap`; `reroute-deps-coord.test.ts` (the file-coordinated suite never caught it).
> - `assembleRunTools` (G11) "new file" → SHIPPED `runner/tool-config.ts:67` (`seededRegistry(...)` build), wired via `resolveRunTools` `runner/entry.ts:31` → `assembleRunTools` call `entry.ts:38`.
> - `runner.ts:1347` (the `DefaultToolRegistry` fall-through) → `runner.ts:1693`.
> - `runner.ts:1018`/`:1017` (blockingChecks/failedChecks) → `runner.ts:1263`/`:1262`; `runner.ts:980` (merge run discard) → call site `runner.ts:1208`; `runner.ts:1543,1589` (stage `Promise.all` / `halted`) → `runner.ts:1892-1893` / `:1938,1944`; `runner.ts:293,306` (watchdog AbortController) → `runner.ts:309,322`; `runner.ts:936` (write-disjoint) → the disjoint-dir discipline is at `runner.ts:1144` and `reroute/expand.ts:133`.
> - `types.ts` anchors: SecretResolver `:478,484` → `:619,625`; `HookWhen` `:286` → `:424`; `retries?` `:277` → `:368`; reserved `PolicyAction` `:200` → `:289`; `policy`/checks⊥policy `:257`/`:179-203` → `Policy` `:292` / `Check` `:309` / the split canon comment `:260-262`. Executor anchors: `seed.ts:42/93` → `resolveSeedTokens` `:42`, `{file:field}` token `:31`, seed lowering note `:86`; `merge.ts:175` (the swallowed `run` op) → `runMerge` `:231`, `spawnSync` `:212`; `promote.ts:23` → `extractPromoteValue` `:79`; `project.ts:184` (`union`) → `applyProjectionOp` `:73`, the `union` op-spec `:49`. `fusion/expand.ts:68` (Expand ONE node) → CORRECT (unchanged). `checks.ts:60-74` (cycle throw) → template `checks.ts:47` (fn) / `:72-74` (throw).
> - `inspect.ts:133` (`DefaultToolRegistry → seededRegistry`) → SHIPPED in **`packages/cli/src/inspect.ts:140`** and the dry-run mirror `packages/cli/src/run.ts:172` (not in core).
> - `#18` merge-`run` exit-code framed as a future ADDITION ("SWALLOWED today") → SHIPPED — the exit now ROUTES through the lowered op's `onFailure` → `runner.ts:1172-1212` (collect), status ladder below. The "swallowed" wording is retained ONLY as the pre-fix baseline.
> - `classifyFailure`/`consultPreamble` "the SDK port stopped" → SHIPPED → `checks.ts:203` (`classifyFailure`), `:228` (`consultPreamble`), wired in `runner.ts:43`.
> - `#14` `@piflow/tool-bridge` `$VAR` expansion framed as "still unbuilt / DEFERRED" → **BUILT** — `expandValue`/`expandServerConfig` ship in `packages/tool-bridge/src/config.ts:33-58` (throws `missing-env` on an unresolved ref). The doc's "deferred" status is updated; **FLAG — the fix-plan tally (`node-action-protocol-fix-plan.md:153,160`) still lists #14 as DEFERRED and is now stale; left for the author since correcting a multi-row tally exceeds a one-line STATUS fix.**
> - game-omni in-repo validation: the template was deliberately RELOCATED out of the SDK (CLAUDE.md data-boundary rule); `.piflow/game-omni/template/` is ABSENT here, so `migrate-game-omni.test.ts` (×6) + `tools-verify.test.ts` (×1) fail on `ENOENT`/`meta.json missing` — a fixture-relocation artifact, NOT a protocol defect (`595 passed`).

---

## 0. Architecture at a glance

**The unified envelope — every old grammar lowers into one `op[]`:**

```mermaid
flowchart TB
  subgraph AUTH["node.json authoring — deprecated aliases"]
    H["hooks.seed / project / merge / promote"]
    C["checks.pre / post"]
    P["policy.fail / warn"]
    K["Hook[] shell or fn"]
    I["inject[]"]
  end
  subgraph OP["op[] — the ONE envelope (OpSpec)"]
    direction TB
    E["id · when · reads[] · writes[] · onFailure<br/>+ EXACTLY ONE body:"]
    T["transform — DERIVE"]
    R["run — ACT"]
    G["gate — DETECT"]
    A["action — CONTROL"]
    E --- T
    E --- R
    E --- G
    E --- A
  end
  subgraph EXEC["reused executors — UNCHANGED"]
    X1["stageSeed · applyProjectionOp · runMerge · promote"]
    X2["runHooks (shell/fn)"]
    X3["evaluateChecks"]
    X4["retry · escalate · reroute · notify"]
  end
  H --> E
  C --> E
  P --> E
  K --> E
  I --> E
  T --> X1
  R --> X2
  G --> X3
  A --> X4
```

*The lowering PROPER lives in `workflow/template/lower.ts` (`lowerToOps` deprecated-alias→`op[]`, `lowerActions` `action:*` sugar→canonical reroute/retry/escalate) and is CALLED from `loader.ts:120,122`; the per-transform executors are reused unchanged (the envelope changes only the authoring + dispatch frame).*

**Where it plugs into a run — compile pipeline + the per-node lifecycle:**

```mermaid
flowchart TB
  subgraph COMPILE["compile pipeline — entry.ts (runFromTemplate / runFromConfig)"]
    direction LR
    PR["applyProfileByName"] --> EF["expandFusion"] --> ER["expandReroute<br/>NEW · G12"] --> CO["compile → DAG"]
    AT["assembleRunTools<br/>NEW · G11"]
  end
  RW["runWorkflow"]
  subgraph NODE["runNode lifecycle — one pi per node"]
    direction TB
    BC["bind-check (verifyToolBinding)"] --> ST["stage reads + seed"]
    ST --> PRE["PRE ops — gate #11 · run #9 · inject-fold #10"]
    PRE --> TX["stage -e tool ext + _pi/mcp.json"]
    TX --> EX["EXEC headless pi"]
    EX --> CL["collect outputs"]
    CL --> VF["verify — post-gate · artifacts · schema"]
    VF --> PO["POST ops — transform · run · promote"]
    PO --> AC["on-failure — retry #6 · escalate #4 · reroute #2 · notify"]
  end
  CO --> RW
  AT -. "registry + mcpConfig" .-> RW
  RW --> BC
```

*`assembleRunTools` (G11) seeds the catalog into the canonical path; `expandReroute` (G12) unrolls the bounded QA loop; the `op[]` envelope (G13) fires at the PRE / verify / POST / on-failure points of `runNode`.*

**Bounded reroute — refuse the back-edge, unroll it (the QA loop without a cycle):**

```mermaid
flowchart LR
  subgraph BAD["REJECTED — runtime back-edge (cycle, refused by checkCycles)"]
    direction LR
    T0["w4-execute"] --> V0["verify"]
    V0 -. "FAIL: re-enter" .-> T0
  end
  subgraph GOOD["TAKEN — compile-time unroll (bounded k, acyclic)"]
    direction LR
    T1["w4-execute"] --> V1["verify"] --> Q{"PASS?"}
    Q -->|yes| D["downstream"]
    Q -->|"no · attempt &lt; k"| T2["w4__r2 (+evidence)"] --> V2["verify__r2"] --> D
  end
```

*A verify FAIL re-enters an upstream node as compile-time-cloned acyclic stages (the `expandFusion` move), bounded by `k`; `checkCycles` is never modified (design §3-control).*

---

## 1. Problem & convergence

The investigation found one disease with three organs. **(a) Tool-wiring was built but unreachable** — `seededRegistry()`/`loadCatalog()` had ZERO non-test callers, so every canonical run fell through to `registry: opts.registry ?? new DefaultToolRegistry()` (`packages/core/src/runner/runner.ts:1693`), a builtins-only registry; any `oc.*`/`mcp.*` node was `blocked` before `pi` spawned (BLOCKER #1; the fall-through line still exists as the explicit-caller default — `assembleRunTools` now feeds it the seeded registry, §4). **(b) Conditional control-flow lived in prose** — a verify FAIL had no authoring surface to re-enter an upstream node, and the loader rejects cycles outright (`checkCycles`, Kahn topo-sort, `packages/core/src/workflow/template/checks.ts:47` — the under-processed throw at `:72-74`) (BLOCKER #2). **(c) The op surface was fragmented** — ~8 op grammars, 6 I/O declaration styles, and 5 inline consequence encodings, against exactly ONE clean decision⊥consequence factoring in the whole codebase: `checks` (detection) ⊥ `policy` (consequence) (`Check` `types.ts:309`, `Policy` `:292`, the split canon comment `:260-262`). The convergence is to **extend that one good factoring to the whole surface** rather than invent a parallel one: every op DETECTS, DERIVES, ACTS, or CONTROLS, and every outcome routes through ONE shared consequence vocabulary; the tool catalog is seeded into the canonical run path once; and the bounded QA loop is UNROLLED at compile time exactly as `expandFusion` already unrolls a fusion node into a bounded acyclic sub-DAG (`packages/core/src/workflow/fusion/expand.ts:68`, with `expandReroute` inserted immediately after `expandFusion` in `runFromConfig` at `packages/core/src/runner/entry.ts:95` and in `runFromTemplate` at `:140`). The three organs are sequenced G11 → G12 → G13 (foundation → control-flow → grammar); see §5 and the fix plan.

---

## 2. The unified node action/op protocol

### 2.1 The envelope — `OpSpec`

One discriminated record. A node carries an ordered `op[]`; every existing grammar is a **profile** of this one shape, and the per-transform executors (`seed.ts`/`project.ts`/`merge.ts`/`promote.ts`/`checks.ts`) are reused UNCHANGED — the envelope changes only the authoring + dispatch frame, never the transform logic.

```ts
// packages/core/src/types.ts — the ONE node-op envelope (G13). Additive; see §5 for the spine accounting.
export type OpWhen   = 'pre' | 'post' | 'on-success' | 'on-failure' | 'always';   // types.ts:90 — extends HookWhen (types.ts:424)
export type OnFailure = PolicyAction;  // types.ts:97 — PolicyAction generalized to every op (= 'block'|'warn'|'stop'|'retry'|'escalate', types.ts:289; §2.4)

export interface OpSpec {              // types.ts:104
  id?: string;            // ledger key + resume key + the reroute target (#2). SDK-fills a slug if omitted.
  when?: OpWhen;          // firing phase/condition. Default 'post'. (the dbt-#1-pain `when` knob, made explicit)
  reads?: string[];       // files READ — fold into DAG edge inference AND (for pre ops) into the realized prompt
  writes?: string[];      // files WRITTEN — the produced set the next node's `reads` draws an edge from
  onFailure?: OnFailure;  // the consequence of THIS op failing. Default 'block'. (the checks⊥policy split, universal)
  idempotent?: boolean;   // skip when outputs fresh. Default true. (carried from Hook.idempotent)

  // EXACTLY ONE body (the discriminator; the loader rejects a multi-body op — the `mergeHook` oneOf precedent):
  transform?: TransformBody; // DERIVE — declarative data transform (seed/project/merge/promote/projectRegistry)
  run?: RunBody;             // ACT — deterministic shell/fn side-effect (the ported, now-authorable Hook.run). Never an LLM.
  gate?: GateBody;           // DETECT — pure predicate over `reads` emitting a verdict (the Check family)
  action?: ActionBody;       // CONTROL — model-free control action (retry/escalate/notify/rerouteTo) — the G12 family
}
```

The four bodies (the op **classes**) — `types.ts:130-148`:

```ts
export type TransformBody =
  | { kind: 'seed';      from: string }                                                // PRE  (resolveSeedTokens seed.ts:42, {file:field} token :31)
  | { kind: 'project';   ops?: Record<string, unknown>[]; from?: string | string[] }   // POST (copy|assemble|merge|union; as-built: ops optional, +from)
  | { kind: 'merge';     ops: Record<string, unknown>[] }                              // POST (fold|concat|reconcile; `run` op routes via RunBody.onFailure)
  | { kind: 'promote';   from: string; to: string; reducer?: Reducer }                 // POST (state lift, extractPromoteValue promote.ts:79)
  | { kind: 'projectRegistry'; source: string; mapRef: string; key: string };          // POST (registry projections; union path project.ts:73)

export type RunBody  = { cmd: string; args?: string[]; cwd?: string } | { fn: string };
export type GateBody = { kind: CheckKind | string; path?: string; param?: unknown; advisory?: boolean }; // advisory = Dagster blocking=False
export type ActionBody =                                                  // G12 owns the runtime; G13 owns the SLOT
  | { kind: 'retry';     onVerdict?: 'fail' | 'warn'; max?: number }      // #6
  | { kind: 'escalate';  via: string; evidence?: string[] }              // #4 — `via` resolves through model-routing.ts
  | { kind: 'notify';    channel: string; payload?: string[] }           // §4 — `channel` is a host-seam key (Escalator)
  | { kind: 'rerouteTo'; node: string; max: number; evidence?: string[] }; // #2 — compile-time unrolled (§3-control)
```
*(as-built; the design intended `TransformBody.project` as `{ ops: Record<string,unknown>[] }` — the shipped variant makes `ops` optional and adds `from?: string|string[]`, the project-source ref.)*

### 2.2 The migration table — every existing grammar → one `OpSpec`

The right column is the report issue each row closes. Most rows are byte-identical lowerings; **two rows (4 and 9) are deliberate behavior ADDITIONS, marked ⊕** — a today-swallowed or today-dead surface that gains a real effect. The old authoring keys (`hooks`/`ops`/`checks`/`policy`) remain SUPPORTED `@deprecated` aliases the loader lowers into `op[]`, so every existing template compiles + runs identically (Constraint #2).

| # | Today (grammar · file:line) | Unified `OpSpec` | Reused executor | Closes |
|---|---|---|---|---|
| 1 | `hooks.seed:[{to,from}]` (`seed.ts` `driverSeed:23`) | `{when:'pre', writes:[to], transform:{kind:'seed',from}}` | `stageSeed` | — (preserve) |
| 2 | `hooks.project:[{to,from}]` | `{when:'post', writes:[to], reads:from, transform:{kind:'project',ops}}` | `applyProjectionOp` (`project.ts:73`) | — |
| 3 | `hooks.merge:{ops}` (`applyMergeOp` `merge.ts:58`) | `{when:'post', transform:{kind:'merge',ops}}` | `applyMergeOp` | — |
| 4 ⊕ | `hooks.merge` **`run` op** (`runMerge` `merge.ts:231`, `spawnSync` body `:212`) — exit code was **SWALLOWED pre-fix** (`await runMerge(...)` return DISCARDED; the node only blocked if its missing output tripped the existence gate) | `{when:'post', run:{cmd,args,cwd}, onFailure:'block'\|'warn'}` — the exit code now ROUTES to status (**SHIPPED**, `runner.ts:1208-1212`) | `spawnSync` body → `RunBody` | **#18** (ADDITION — shipped) |
| 5 | `hooks.promote:[{from,to,merge}]` (`extractPromoteValue` `promote.ts:79`, `parsePromote:69`) | `{when:'post', transform:{kind:'promote',from,to,reducer}}` | `extractPromoteValue`+`barrierMerge` | — |
| 6 | `hooks.registryProject` | `{when:'post', transform:{kind:'projectRegistry',…}}` | `runProjection` (incl. `union`, `project.ts:73`/op-spec `:49`) | **#12** |
| 7 | `NodeSpec.hooks.pre/post:Hook[]` (`types.ts:48`, unauthorable) | `{when, reads, writes, run:{cmd}\|{fn}, onFailure}` | `runHooks` | **#9**, **#22** |
| 8 | `checks.post:[Check]` | `{when:'post', gate:{kind,path,param}, onFailure:<from policy>}` | `evaluateChecks` (`checks.ts:117`) | — |
| 9 ⊕ | `checks.pre:[Check]` (DEAD pre-fix — flattened pre→post in `render.ts:20` `collectChecks`, never fired before the model) | `{when:'pre', gate:{…}, onFailure}` run BEFORE the model | `evaluateChecks` | **#11** (ADDITION — shipped) |
| 10 | `policy:{fail,warn}` (`Policy` `types.ts:292`) | folded into each `gate`'s `onFailure` | `actionForVerdict` (`checks.ts:154`) | **#15** (§2.4) |
| 11 ⊕ | `inject:[path]` — `io.reads` was hardcoded `[]` (pre-fix `loader.ts:121`), so injected reads NEVER folded into the prompt; now `io.reads = unique(opReads)` (`loader.ts:141`, derived from the lowered ops' reads) | `{when:'pre', reads:[path]}` whose `reads` IS folded into the prompt (`render.ts:71-72` realizes the `DRIVER-INJECT` line) | new pre-fold step (a new behavior) | **#10**, **#16** (ADDITION — shipped) |
| 12 | `contract.artifacts` existence (inline) | stays in `io.artifacts`; `gate{kind:'exists'}` is the generalization, artifacts the required-output sugar | `runner.ts` artifact stat | — |
| 13 | `returnSchema` breach (inline) | stays in `io`; `returnMode:'required'` is sugar for `gate{kind:'json-schema',onFailure:'block'}` | `runner.ts` return parse | — |

`project` and `merge` stay as two `transform.kind`s (porting fidelity, investigation §2): the envelope unifies the FRAME `{when,reads,writes,transform}` while keeping the two op-vocabularies (`copy|assemble|merge|union` vs `fold|concat|reconcile`) as the `kind` discriminator — zero behavior change for the transform itself, "8 grammars" become "one envelope with a typed `kind`."

### 2.3 The 6 I/O styles collapse into one (`reads[]`/`writes[]`)

The 6 conventions (`io.reads`/`io.produces` · `contract.artifacts` · sandbox `read`/`write` · `seed{to,from}` · per-op source/dest · `Hook[]{inputs,outputs}`) collapse because **every op declares its own `reads[]`/`writes[]` in ONE vocabulary**, and the loader DERIVES the node-level sets from the union — replacing the long-stale hard-coded `reads: []` (the root of #16 and #10). The lowered ops come from `lowerToOps(n.def)` (`loader.ts:120`), and the as-built derivation in `toNodeIntent` is:

```ts
// loader.ts:126-127,141-143 — derived from the lowered ops (replaces the `reads:[]` hardcode at the old :121):
const opReads  = (op ?? []).flatMap((o) => (o.reads  ?? []).map(runRel));   // {{RUN}}-relative injected/op reads
const opWrites = (op ?? []).flatMap((o) => (o.writes ?? []).map(runRel));
// inside the NodeIntent.io literal:
reads:    unique(opReads),                          // :141 — #10/#16: edges from io + folds into the prompt
produces: unique([...c.artifacts, ...opWrites]),    // :143 — #16: produces = artifacts ∪ op writes
```

*(as-built; the design sketch above prepended a separate `injectReads` set — in the shipped loader the injected forced-reads are already lowered INTO `op[]` by `lowerToOps`, so `opReads` alone carries them, `runRel`-normalized via the leading-`{{RUN}}/` strip at `loader.ts:111`.)*

Sandbox `read`/`write` (`types.ts` SandboxSpec) is NOT unified away — it is OS-enforcement scope (concern #1), a different axis (security, not data-flow); the loader keeps deriving it from `contract.readScope`/`owns`. The four inner value-extraction token grammars (`seed {file:field}` `seed.ts:31` resolved by `resolveSeedTokens:42`, `promote <art>:<field>` `promote.ts:79`, project bare paths, `checks.path`) keep their resolvers — they are value-extraction INSIDE a body, not I/O declaration; unifying them touches three executors for zero behavior gain and is an explicit non-goal (§7).

### 2.4 The extended decision ⊥ consequence model

`checks` ⊥ `policy` is the ONE clean split (the split canon comment `types.ts:260-262`; `Check` `:309`, `Policy` `:292`). The protocol generalizes it three-way — **detection ⊥ consequence ⊥ control** — and makes `onFailure` the single consequence vocabulary that the runner's status ladder reads uniformly (a hard-coded cascade where `blockingChecks` is filtered by `actionForVerdict(...) !== 'warn'`, `packages/core/src/runner/runner.ts:1263`, `failedChecks` at `:1262`):

| Inline consequence | file:line | Reality | Routes through |
|---|---|---|---|
| `merge.run` exit code | `runMerge` `merge.ts:231`, call site `runner.ts:1208` | **SHIPPED (was SWALLOWED pre-fix)** — the `{failed,exit}` return now ROUTES via the lowered op's `onFailure` (`runner.ts:1208-1212`); pre-fix it was discarded and only a missing output blocked the node | `RunBody` op's `onFailure` (default `block`; author sets `warn`) — **#18 (ADDITION)** |
| `Hook.failure:'block'\|'warn'` | `types.ts` Hook | unauthorable (`hooks.pre/post` not author-reachable) | op `onFailure` (lowered) — **#9** |
| artifact existence | `runner.ts` | live (the existence gate) | `gate{kind:'exists'}` or `io.artifacts` sugar |
| `returnSchema` breach | `runner.ts` | live under `returnMode:'required'` | `gate{kind:'json-schema'}` under `returnMode:'required'` |
| check verdict → `policy` | `checks.ts:154` (`actionForVerdict`) | live (the one clean split) | `onFailure` is `actionForVerdict` promoted to a per-op field |

**On `stop` vs `block` (#15) — corrected against the runner as it actually executes.** The earlier framing ("`block` halts fast mid-stage; `stop` lets siblings drain") rested on a mid-stage abort that DOES NOT EXIST. The runner runs each stage with `Promise.all(s.nodeIds.map(...))` (`runner.ts:1892-1893`) and sets `halted = true` only AFTER every lane resolves (`runner.ts:1938,1944`); the sole `AbortController` (`runner.ts:309`, `ac.abort()` at `:322`) is the per-node watchdog, NOT a stage-cancel. **So `block` ALREADY drains all same-stage siblings to completion and only then halts before the next stage** — there is no "halt-now" behavior to contrast `stop` against. Two honest options exist, and the protocol takes (B), **SHIPPED**:

- **(A) — REJECTED:** give `block` a NEW mid-stage sibling-cancel (drive `ac.abort()` across the stage's other lanes on first failure) so `stop` becomes the graceful contrast. This CHANGES `block`'s observable behavior for every existing block-policy template (a sibling that completes today would be cancelled tomorrow) → it BREAKS additivity (Constraint #2) and is out of scope.
- **(B) — TAKEN (shipped):** `stop` is a DOCUMENTED ALIAS of `block` (both: fail the node, drain same-stage siblings, halt before the next stage — the unchanged semantics; `PolicyAction` `types.ts:289`, doc-comment `:285-287`; the reroute clone's final consequence is `'block'|'stop'` at `RerouteSpec.onFailure` `types.ts:759`) and the name is RESERVED for a future graceful-cancel primitive once a stage-cancel exists. The `stop-equals-block.test.ts` gate pins the IDENTICAL halt record + sibling-completion set. #15 is closed as "documented-equivalence + the verdict→consequence split is unified through `onFailure`," NOT as "`stop` gains a distinct mid-stage effect."

`retry`/`escalate` gain real, distinct effect via the `action` family (§3-control), NOT by overloading `policy` — keeping `policy` pure verdict→consequence and `action` the control layer.

---

## 3. The trigger-action vocabulary (G12)

The legacy `run.mjs` had the whole family working (`runNodeWithEscalation`/`classifyFailure`/`consultPreamble`); the pre-M4 SDK port stopped at `io.retries` (error/blocked only) and `actionForVerdict` (collapses to `block`). **M4 SHIPPED the port** — `classifyFailure` (`checks.ts:203`) and `consultPreamble` (`checks.ts:228`) are wired into the retry loop (imported at `runner.ts:43`). The protocol restores six verbs — each is a model-free `action` op (or its canonical `NodeIO`/`NodeIntent` field), with semantics + an authoring example + the framework precedent it ports.

**retry-by-failure-class** — re-run THIS node (a fresh attempt: re-seed + re-exec) up to a bound, FILTERED by the failure class the runner DERIVES (it stats the files the node was required to produce — it does not ask the model "are you sure"). Canonical field: `io.retry?: RetrySpec { max, on?: FailureClass[] }` (`types.ts:374`/`RetrySpec` `:402`); `io.retries` (`types.ts:368`) is preserved as the `legacyRetry(io.retries)` alias (`checks.ts:256`; max=retries, classes=`['infra','degenerate']` ≈ today's error/blocked). Precedent: Temporal `RetryPolicy` per-failure-type backoff; LangGraph/Dagster per-node `RetryPolicy`. Closes **#6**.
```jsonc
"checks": { "post": [{ "kind": "fenced-tail", "param": { "minItems": 3 }, "severity": "fail" }] },
"policy": { "fail": "retry" },
"retry":  { "max": 1, "on": ["quality-gap", "degenerate"] }
```

> **The `schema`/`degenerate-output` failure-class lane composes G8 (SHIPPED design `docs/specs/wiring-g8-repair-loop.md`).** When the DERIVED class is a SCHEMA miss (the node `block`ed SOLELY on `schema.invalid`/`returnSchemaBreach`), the runner FIRST runs G8's bounded `contract.maxRepairAttempts` repair — a CHEAP re-prompt INSIDE the still-alive sandbox built from `{previousOutput, ajvErrors, schema}` — BEFORE spending a `retry`-class FULL re-run. A repair is NOT a retry: it reuses the live sandbox + in-hand failing output (G8 §"Recommendation"), where retry-by-failure-class re-seeds a fresh sandbox. Order within the node: schema miss → G8 in-sandbox repair (≤`maxRepairAttempts`) → still failing → full node `retry`/`escalate`. This is the SAME `classifyFailure` taxonomy: `degenerate`/`schema` is the class that routes to the cheap in-sandbox lane first. The repair loop itself is specced in full by G8 (do NOT re-spec it here); the protocol only places it as the FIRST consequence of the schema class.

**escalate-with-evidence** — when the retry budget is spent (or immediately on an escalable class), re-run on a STRONGER model fed the verified failure facts (`consultPreamble` — missing-artifact paths, check verdicts, stderr tail; never a self-score). Canonical field: `io.escalate?: EscalateSpec { after?, model?, tier?, on? }` (`types.ts:381`/`EscalateSpec` `:410`). *(as-built; the design listed an `evidence?` key on `EscalateSpec` — the shipped type omits it: the evidence is the `consultPreamble` the runner assembles from already-computed signals, not an author-declared list. The author-declared `evidence?` lives on the `escalate` ACTION body and on `RerouteSpec`, not on `EscalateSpec`.)* **This is the core of #4, closed IN FULL by M4** (`notify` below is a §1.6 best-practice add, NOT a sub-part of #4). The stronger-model target resolves through `packages/core/src/runner/model-routing.ts` precedence (`escalate.tier`/`escalate.model` → `resolveNodeModel` `:66`), NOT a new config home; legacy `ESCALATE_MODEL`/`ESCALATE_PROVIDER` env retired for the strictly-more-expressive per-node `escalate.tier`. Precedent: Temporal activity-retry-to-different-worker; LangGraph conditional-edge → fallback-node. Closes **#4**.
```jsonc
"escalate": { "after": "retry", "tier": "deep", "evidence": true }
```

**bounded reroute (conditional reroute)** — a verify FAIL re-enters an upstream `target` node as a COMPILE-TIME-CLONED stage, never a runtime back-edge (§3-control below). Canonical field: `NodeIntent.reroute?: RerouteSpec { onFail, max, evidence?, onFailure? }` (`types.ts:813`/`RerouteSpec` `:751`) where `evidence?: string[]` (array — agrees with the `rerouteTo` action body; see the §6 examples) and the as-built `onFailure?: 'block'|'stop'` (`:759`) sets the FINAL clone's consequence. Precedent: LangGraph `add_conditional_edges` made acyclic by unrolling; Dagster `@asset_check(blocking=True)` + bounded op retry. Closes **#2 (blocker)**, **#5**, **#17**.
```jsonc
"reroute": { "onFail": "w4-execute-m1", "max": 3, "evidence": ["verify/m1-report.json"] }
```

**bounded self-fix** — the SAME `expandReroute` pass with the re-entry target being the node itself / its fix-instruction; the bound is `reroute.max`, the SDK-owned cycle counter that RETIRES the node-self-managed `.fixcycles-M2.json` (#5). Precedent: LangGraph cyclic graph with recursion-limit; Dagster bounded retry. Closes **#5**.

**notify** — a user-facing notification (`PolicyAction:'warn'` exists; the channel binding is the `Escalator` host seam, §4). This is a NEW best-practice surface (a §1.6 add), NOT a sub-part of #4. Precedent: Airflow `on_failure_callback` → Slack; Prefect Automations; n8n Error Trigger.
```jsonc
"op": [{ "when": "on-failure", "action": { "kind": "notify", "channel": "ops-alerts" } }]
```

**compensate** — a cleanup/rollback side-effect that fires on failure: `op` with `when:'on-failure'` + a `run` body (the now-authorable `Hook`, #9). Precedent: Temporal Saga compensation; Prefect `on_rollback`; GitHub Actions `post: if: always()`. The trigger is G12; the authorable `run` body rides #9 in G13.
```jsonc
"op": [{ "when": "on-failure", "run": { "cmd": "scripts/rollback.sh" } }]
```

The existence-gate / resume-preflight surface (#17) is not a separate feature — it is the zero-pi node that `expandReroute` EMITS between attempts (stat → short-circuit), so closing #2 closes #17 by construction (§3-control).

**ORTHOGONAL to G12/G13 (control-flow inventory completeness):** G7 detach (SHIPPED design `docs/specs/wiring-g7-detach.md`) is a CLI-only `checkpointReply:'default'` thread that flows through the existing `RunOptions` into `runWorkflow` — it adds NO node-action surface, NO `op`/`reroute`/`action` field, and touches NO compile pass; it changes only HOW the console launches a run (background, never park on a checkpoint), not WHAT a node may do. It composes with this protocol but is not part of it.

### 3-control. Conditional reroute fits the ACYCLIC DAG — compile-time UNROLL

The DAG is forward-only and the loader rejects cycles (`checkCycles`, Kahn topo-sort: `processed < ids.length ⇒ "cycle detected"`, `packages/core/src/workflow/template/checks.ts:47` — the under-processed check + throw at `:72-74`). A reroute is a back-edge; **we refuse the back-edge and UNROLL the bounded loop into N acyclic stages at compile time** — the exact `expandFusion` move (`packages/core/src/workflow/fusion/expand.ts:68`, "Expand ONE fusion-activated node into `[obligations?, ...siblings, judge]`", returns the spec unchanged when no node activates `:196`, throws `FusionConfigError` loudly `:25`), at the exact insertion points (`runFromConfig` `entry.ts:95`; `runFromTemplate` `entry.ts:140`). The pure pass `packages/core/src/workflow/reroute/expand.ts` (`expandReroute`, the exported entry at `:207`) is SHIPPED and slots IMMEDIATELY after `expandFusion`:

```
profile → subworkflow → fusion → reroute → compile      (the compile-time expand-pass pipeline)
runFromConfig:   profile(:87)  → [expandSubworkflow?] → expandFusion(:91)  → expandReroute(:95)  → compile(:99)
runFromTemplate: profile(:134) → [expandSubworkflow?] → expandFusion(:136) → expandReroute(:140) → compile(:146)
```
*(as-built; the `[expandSubworkflow?]` slot is bracketed because G9 subworkflow-expansion is a separate shipped pass that, when present, runs FIRST among the expands — the entry shown here wires profile → fusion → reroute → compile directly.)*

**`expandReroute` MIRRORS `expandSubworkflow` (SHIPPED design `docs/specs/wiring-g9-subworkflow.md`) and `expandFusion` — it is the SAME compile-time sub-DAG-inlining family, not a parallel mechanism.** All three are pure pre-compile spec→spec passes that share ONE discipline: id-namespacing of cloned/child labels so downstream edges survive; disjoint top-level artifact dirs (the parallel-collect write-disjoint pattern, the disjoint-dir discipline at `runner.ts:1144` + `reroute/expand.ts:133`) — the as-built reroute dir is `reroute-${ns}-r${i}/` (`ns` = slug of `V`'s label), fusion's `fusion-${ns}-…/`, G9's `subwf-${ns}-…/`; in-memory realized-prompt carriage on the generated `NodeIntent` (NO `.pi/nodes/<id>/` folder is materialized — G9 §"THE ONE WRINKLE"); a referentially-unchanged early return when no node activates the block (`RerouteConfigError` `expand.ts:29`, `expandReroute` `:207`); a LOUD `*ConfigError` (`RerouteConfigError` mirrors `FusionConfigError`/`SubworkflowConfigError`); and `stagesOf` as the shared acyclicity backstop. **Insertion ORDER is load-bearing: profile → subworkflow → fusion → reroute → compile.** `expandSubworkflow` runs FIRST among the expands (G9 §4c — so a fusion-activated node INSIDE a loaded sub-template still expands, and a parent profile can elide a node before its sub-DAG loads); `expandReroute` runs LAST (it clones already-expanded slices, so a reroute target that lives inside a sub-DAG or a fusion judge is cloned correctly). The one structural delta: `expandSubworkflow` is `async` because it LOADS a template (`loadTemplate`); `expandFusion`/`expandReroute` stay sync (they only rewrite in-spec nodes, loading nothing). The `[expandSubworkflow?]` slot is bracketed because it applies to the template path only (G9 §Risks — the literal-spec `runFromConfig` path likely has no on-disk refs).

For a verify node `V` with `reroute:{ onFail: T, max: k, evidence: E }`, where `S = [T, …, V]` is the path slice, `expandReroute` clones `S` as `S__r{i}` for `i` in `2..k+1` (as-built: i = 2..max, where `max` is total attempts incl. the original):
- each clone's `reads`/`writes` are NAMESPACED into a per-attempt dir `reroute-${ns}-r${i}/…` (the write-disjoint discipline fusion uses to dodge the parallel-collect race, `reroute/expand.ts:133` sibling dirs);
- the re-entry clone `T__r{i}` additionally READS the prior attempt's evidence `E` and gets a `consultPreamble` prompt prefix ("the prior attempt FAILED these checks: {evidence}; fix them");
- the final clone `V__r{k+1}` has `onFailure:'block'` (or `'stop'`, which is its documented alias, §2.4); non-final clones gate the next clone's existence via the inferred edge.

The chaining is forward-only: `V → T__r2 → V__r2 → T__r3 → V__r3 → downstream(V)`, every edge drawn by `inferEdges` from the namespaced `produces ⋈ reads` **and the clone-remapped `dependsOn`** — **no back-edge, no cycle, bounded by `k`**. Coordination-agnostic: a file-coordinated slice chains through the namespaced reads/produces; a **label-coordinated slice** (the game-omni shape — `io.dependsOn` set, empty `io.reads`) chains because the clone remaps each in-slice `dependsOn` to the same-attempt clone slug and re-points a deps-coordinated downstream onto the last attempt (`expand.ts` `remapIo`/`downstreamDepRemap`; the file-only assumption was the original `expandReroute`'s blind spot, now closed). A PASS short-circuits: each clone's entry is a zero-pi existence-gate preflight node (#17) — the as-built `RerouteGate` marker (`types.ts:772`) the runner consumes via `runRerouteGate` (`runner.ts:889`) — that stat()s the canonical artifact and finishes `ok` WITHOUT spawning pi AND without spawning the cloned `T__r{i}…V__r{i}` body (the test asserts a zero call-count for the cloned ids, §M3). `checkCycles` is NEVER modified; `stagesOf` (the final acyclicity backstop) PROVES every unroll produced a DAG. A `reroute.onFail` that is not an ancestor of `V`, or `max < 1`, is a loud `RerouteConfigError` (mirroring `FusionConfigError`). In G13 terms this is `expandActions` unrolling an `action:rerouteTo` op — same pass, same insertion point; the `op.action:rerouteTo` form is sugar that lowers to the canonical `NodeIntent.reroute`, and like `fusion?` it NEVER reaches the dense `NodeSpec`.

---

## 4. The tool-wiring canon (G11)

The ingest → schema → bind → execute pipeline is fully built as pure functions; pre-G11 it never reached the canonical run path (investigation §3a). The runner SIDE is correct and proven; the defect was the call sites that build a `RunOptions` and fall through to `registry: opts.registry ?? new DefaultToolRegistry()` (`packages/core/src/runner/runner.ts:1693`) — that line remains as the explicit-caller default, now fed the seeded registry by `assembleRunTools`.

**`assembleRunTools` — the ONE pure builder (SHIPPED).** New file `packages/core/src/runner/tool-config.ts` (`assembleRunTools` body, `seededRegistry([SUBMIT_RESULT_TOOL, ...mcpRows, ...extraEntries])` at `:67`): assembles the run's registry (the persisted `seededRegistry()` = builtins + `oc.calc:add` seed + curated catalog + the first-party `submit_result` contract tool, PLUS ingested MCP rows, PLUS host `extraEntries`) and the merged `mcpConfig` (the UNION of every node's authored `mcp.servers`; a duplicate server key across nodes must be byte-identical-or-throw, never silently last-wins). Wired into BOTH entries AFTER `expandFusion` via the `resolveRunTools` helper (`entry.ts:31`, `assembleRunTools` call at `:38`): `runFromConfig` (`entry.ts:98`, after `expandReroute` `:95`) and `runFromTemplate` (`entry.ts:144`, after `expandReroute` `:140`), with an explicit-caller-wins guard (`runOpts.registry || runOpts.mcpConfig ? …explicit : assembleRunTools(...)`, `entry.ts:35-39`) so every existing `runner.test.ts` keeps full control. The CLI `runTemplate` delegates to `runFromTemplate` and self-assembles; `packages/cli/src/inspect.ts:140` and the `run.ts` dry-run mirror (`packages/cli/src/run.ts:172`) switch `new DefaultToolRegistry()` → `seededRegistry([SUBMIT_RESULT_TOOL])` so the free preview stops falsely reporting `oc.*`/`mcp.*` as UNRESOLVED. Closes **#1 (blocker)**, **#7**.

**Per-node tool + creds authoring (SHIPPED).** `node.json.mcp` already exists in the schema (`node.schema.ts:62`) and the loader's view type but was silently dropped (#3 — the loader read `n.def.tools` but never `n.def.mcp`). The fix: one additive loader line `if (n.def.mcp) intent.mcp = n.def.mcp;` (`loader.ts:191`) carries it onto `NodeIntent.mcp?` (`types.ts:820`) beside the `checkpoint`/`fusion` carry — authoring per-node, never on the dense `NodeSpec`. A node authors `tools.allow` and `mcp.servers` in the same file; `assembleRunTools` reads it off the spec. Closes **#3**.

**The secret allowlist (OQ4 resolution).** **Authoring (per-node, committable):** `node.json.mcp.servers` carries `$VAR`/`${VAR}` REFERENCES in every secret-bearing value — never a literal secret (the loader check `checkMcpSecrets` `workflow/template/checks.ts:266` rejects literal-secret patterns). **Resolution (run-level, host-supplied):** the runner forwards ONLY the declared allowlist — the exact `$VAR` names the staged config references (`referencedEnvVars`), each resolved through `SecretResolver` (`types.ts:619`, default `process.env` `:625`), and on cloud DELETES anything outside that set ("never full `process.env`", the runner's documented invariant). `SecretResolver` stays the single host seam (core owns the `$VAR` vocabulary + allowlist contract, never the binding). Composition with **#14** (NOW BUILT — see Open Questions): the runner stages the `$VAR`-bearing config verbatim and injects the resolved env vars; the `$VAR`→value expansion happens in the `@piflow/tool-bridge` child (`expandServerConfig`/`expandValue` `packages/tool-bridge/src/config.ts:33-58`). V1 (calc, keyless) does not depend on #14.

**Provider-credential parity — ONE `SecretResolver` for BOTH tool creds AND the pi gateway key (checked 2026-06-26).** A focused check of the question "does the one resolver cover everything a cloud node needs?", recorded as the M1 contract. The credential-ORGANIZATION layer this implies (the store, typed schema, DAG required-cred surfacing, GUI input, cloud mint-scoped-token, and the n8n/Windmill provenance) is specced in `docs/design/credential-architecture.md` (two homes — provider keys in pi's `~/.pi/agent/auth.json`, tool/MCP `$VAR`s in `~/.piflow/credentials.json` — one resolver):
- **Tool/MCP creds — DONE.** `SecretResolver` (`types.ts:626`, default `process.env` `:632`) is wired into ONE site, `mcpEnvAdditions` (`runner.ts:481`, called `:955`): it resolves ONLY the `$VAR` names a node's `mcp.servers` references (`referencedEnvVars` `:444`), injects them as `CreateOpts.env`, and on cloud (`CLOUD_KINDS={daytona,e2b}` `:430`) forwards EXACTLY that allowlist, DELETING anything else (`:495-499`) — the VM never inherits host `process.env`. The per-tool secret path is the single allowlisted, cloud-safe seam.
- **The pi agent's OWN provider/gateway credential — NOT yet on that seam (the gap).** `defaultPiCommand` (`command.ts:61`) stamps `--provider`/`--model` but NO key; `pi` reads its gateway credential from its environment. A LOCAL child inherits `process.env` so it works today; a CLOUD VM does NOT (daytona exec merges only `{...this.env,...opts.env}` `daytona.ts:261`; the VM env is `{PI_RUN}` `:518`). Nothing injects the gateway key into the VM ⇒ a cloud node would boot `pi` with no model credential.
- **Verdict on the hypothesis (the pi provider creds and the tool creds share one resolver): RIGHT design, not yet wired.** The fix routes the gateway var(s) through the SAME `SecretResolver`+allowlist — the gateway env name joins the cloud env additions exactly as an MCP `$VAR` does (the resolver already gets `{nodeId,isCloud}` `:472`, so it can mint a per-node, cloud-only SCOPED token). ONE seam for both; no second mechanism, no provider-key config home in core.
- **M1 wiring (next step, NOT done):** the CLI has no `daytona` branch — `run.ts:359-369` handles `local`/`danger-full-access`/`inmemory` only and threads no `secretResolver`. M1 = add the `daytona` case (`createDaytonaProvider(vmDefaults)`) + a cloud `secretResolver` that mints the scoped gateway token and adds its var to the forwarded allowlist. The image (M0) is built + smoke-verified (`deploy/daytona/`, `pi --version` → `0.80.2` in-VM); the toolchain floor is present, credential injection is the one remaining piece for a real one-node cloud run.

**`StringEnum` enforcement (#21, SHIPPED).** A pure normalization pass in `src/tools/compile.ts` (`:156`, `paramsNeedStringEnum`/`STRING_ENUM_PREAMBLE` at `:230-233`): any `{ "enum": [...] }` of all-strings in a generated param schema renders as `StringEnum` (via a tiny generated-preamble helper), not `Type.Union` — Gemini-safe on every provider family. Authoring unchanged; the compiler produces the safe form. Closes **#21**.

**The live-pi E2E invariant (#8, the milestone gate).** `packages/core/test/runner-live-tool-e2e.test.ts`, written FIRST. The LOAD-BEARING blocker gate routes through `runFromTemplate`/`runTemplate` with NO explicit registry, so on the pre-M1 self-assembling path the registry was `new DefaultToolRegistry()` (`runner.ts:1693`) and the `oc.*` node `block`ed — a genuine RED bar that flipped GREEN when M1 wired `assembleRunTools` in. (A direct `runWorkflow(compile(spec), { registry: seededRegistry() })` call is kept as a SEPARATE bind smoke test — it passes today and does NOT guard the blocker, so it must not be the load-bearing gate.) The gate uses NO stub `buildCommand` (real `defaultPiCommand` spawns a real `pi … -e _pi/calc/tools.ts --tools calc_add,submit_result`), gated by `it.skipIf(!probePi().runnable)`. It asserts on the agent's OWN event stream — `events.jsonl` `tool_execution_end{toolName:'calc_add'}` with the sum — proving EXECUTION via the generated `-e`, not the model guessing "5" in prose. V2 (sandboxed + the no-`@piflow/tool-bridge`-import bundle invariant), V1b (MCP lane, proves `stageMcp` + the cred path end-to-end). Closes **#8**.

---

## 4b. Per-node read-scope data permissions (sandbox concern #1) — enforcement status

> **Status (2026-06-26):** SHIPPED for `local`/macOS — per-node `contract.readScope` is now OS-kernel-enforced BY DEFAULT on the real-run path (`feat(sandbox): default-on read-scope jail`, merged to `feat/fusion-example-and-gui-toggle`). This is the **sandbox** spine concern (#1, `l1-node-envelope.md:21`), ORTHOGONAL to §4's tool-wiring (which tool a node may CALL) and to §2.3's data-flow `reads[]` (which file draws a DAG edge): `readScope` is WHICH PATHS the node's processes — INCLUDING its shell/bash children — may actually `open()`. Provenance + gap audit: `docs/research/2026-06-26-sandbox-readscope-isolation-best-practice.md`, `…-piflow-readscope-enforcement-gap-audit.md`; memory `sandbox-readscope-default-on`.

**The model (whom we jail).** UNLIKE Codex (which jails the shell SUB-COMMANDS an agent runs, network-off), piflow wraps the WHOLE per-node `pi` agent exec in the jail, so every tool call AND every `bash` grandchild inherits it. The jail is now SYMMETRIC: reads deny-all-then-`readScope`-allow, **and writes deny-all-then-allow-{workdir, `owns`/`writeScope`, toolchain scratch}** (the writable set adopted from Codex's `workspace-write` profile). **`process-exec` and network stay OPEN** — the agent IS the jailed process and MUST run tools + reach its model gateway. So a node's `bash` can neither read nor write outside its declared lane, but can still run programs and use the network.

**Per-provider enforcement matrix (as-built):**

| Provider | readScope (reads) | write-scope (`owns`) | network | bash-breach (read outside scope) | evidence |
|---|---|---|---|---|---|
| `inmemory` (dry) | ignored — no model runs | n/a | n/a | n/a | `sandbox/index.ts:49` |
| `local` (real run) | **KERNEL-ENFORCED on darwin** (deny-reads → allow scope+toolchain) | **KERNEL-ENFORCED on darwin** (deny-writes → allow workdir+`owns`+scratch) | open | **EPERM** (read AND write) on darwin; **bwrap-enforced on Linux** (argv shipped, runtime verify PENDING; bwrap-missing ⇒ warn+bare) | `sandbox/local.ts` `exec` → `localJailPlan` (OS dispatcher: darwin seatbelt · linux bwrap) |
| `seatbelt` (SDK, throwaway-temp) | KERNEL-ENFORCED on darwin | KERNEL-ENFORCED on darwin | open | EPERM (darwin) | `sandbox/seatbelt.ts` `exec` |
| `worktree` | NOT enforced (bare spawn) | NOT enforced | open | open | `sandbox/worktree.ts` `exec` |
| `daytona` (cloud VM) | isolated BY CONSTRUCTION — agent runs in a REMOTE VM; only uploaded files exist there; cannot see the host FS at all. No per-node OS jail INSIDE the VM (nodes are subtree-namespaced under one shared VM). | n/a (separate machine) | per-VM | host-FS breach impossible; node↔node inside VM NOT OS-jailed | `sandbox/daytona.ts` |
| `e2b` | not implemented (throws) | — | — | — | `sandbox/index.ts:118` |

**The uniform seam.** One `seatbeltExecPlan(cmd,{workdir,readScope,profileDir})` (`sandbox/seatbelt.ts`) renders the per-exec SBPL profile (`sandbox/read-scope.sb`) and returns `sandbox-exec -f <profile> sh -c <cmd>`, or `null` off-darwin. BOTH `SeatbeltSandbox.exec` and the in-place `LocalSandbox.exec` call it — ONE jail implementation; a Linux `bwrap` backend slots in by returning `bwrap … sh -c <cmd>` from the SAME `{workdir,readScope}` policy (so `local` is "run on this machine, OS-isolated, backend dispatched by OS" — `seatbelt` is the macOS backend, not a sibling choice). Per-node `readScope` flows authored `contract.readScope` → `node.sandbox.read` (`loader.ts:163`) → `CreateOpts.readScope` → the profile's `@SCOPE_ALLOWS@`. Toolchain auto-grants (resolved node-binary dir + `NVM_DIR`/`FNM_DIR`/`MISE_DATA_DIR`/`VOLTA_HOME`/`PNPM_HOME` + `~/.piflow`) keep `pi` bootable under the jail. Overhead ≈ 7 ms/exec — negligible vs a node's LLM time. CLI is secure-by-default: `--sandbox local` ⇒ `LocalSandboxProvider({enforceReadScope:true})`; `--sandbox danger-full-access` ⇒ the named bypass; an unknown value errors loudly.

**Open gaps (NOT closed — tracked here):**
- ~~Writes are NOT jailed~~ **CLOSED (2026-06-26, `feat(sandbox): bound writes too`):** writes are now bound symmetrically — `(deny file-write*)` then allow workdir + `owns`/`writeScope` + Codex-derived toolchain scratch. `process-exec` + network remain open by design (the agent must run tools + reach its gateway). Daytona cloud-integration design: `docs/design/daytona-cloud-integration.md`.
- **Linux enforcement — bwrap backend SHIPPED, runtime verify PENDING** (`feat/bwrap-linux-sandbox`): `local` now dispatches via `localJailPlan` (`sandbox/jail.ts`: darwin→`seatbeltExecPlan`, linux→`bwrapExecPlan` `sandbox/bwrap.ts`) — NOT a separate provider, the SAME `local` OS-dispatched. The bind-mount argv is unit-tested cross-platform (`sandbox-bwrap.test.ts`; all 7 sandbox suites green, 49 passed); kernel enforcement is unverified on a real Linux host, and a missing `bwrap` ⇒ warn-once + bare spawn (`jail.ts:35`).
- **Provider-credential injection into a cloud VM** (separate axis from the FS jail) — the pi gateway key has no cloud injection path yet; tracked as the §4 M1 contract (route it through the SAME `SecretResolver`+allowlist as tool creds).
- **`worktree` + `daytona`** don't OS-jail per-node reads (worktree bare-spawns; daytona leans on the VM boundary + subtree namespacing, no node↔node jail inside the VM).
- **`inject ⊆ readScope` is unvalidated** (`checks.ts` checks only that an injected path has a producer) — an injected-but-out-of-scope forced read silently EPERMs under the jail.

---

## 5. Spine reconciliation

The named five concerns (work · sandbox · tools · hooks · contract, `l1-node-envelope.md:21`) are UNCHANGED. The in-code accounting is precise: `hooks?`=concern 3 (`types.ts:48`), `io`=4 (`:50`), `ops?`=5 (`:58`), `checkpoint?`=6 (`:66`); `ops`/`checkpoint` are ADDITIVE EXTENSIONS BEYOND the named five, not heads of concern 3.

**Resolution of the alias-retention ambiguity (the load-bearing spine decision).** The deprecated keys `hooks`/`ops`/`checks`/`policy` are lowered to `op[]` **at the loader/authoring layer ONLY** — exactly like the `fusion?`/`checkpoint?` carry, consumed BEFORE the dense `NodeSpec` is built. They do NOT survive as redundant fields on the dense `NodeSpec`. Therefore the dense `NodeSpec` gains EXACTLY ONE new field (`op?`) and SHEDS the two prior extension fields' density (the old keys live only in the authored `node.json` + the loader's view type, never the runtime spec). This is an honest "re-org of two additive extensions into one head" because nothing redundant is retained on the dense type — the alternative ("one cleaner head" AND "aliases retained on `NodeSpec`") is self-contradictory and is explicitly rejected.

| Element | Spine impact | Justification |
|---|---|---|
| **G11** `assembleRunTools`, registry/mcpConfig/secretResolver wiring | **ZERO `NodeSpec` change** | Pre-existing `RunOptions` fields; callers stop dropping them. `seededRegistry ⊇ DefaultToolRegistry` for builtins ⇒ byte-identical native run. |
| **G11** `NodeIntent.mcp?` carrier | **Additive — authoring layer only** | The `fusion?`/`checkpoint?` precedent: consumed before `compile`, NEVER reaches dense `NodeSpec`. |
| **G12** `io.retry?` / `io.escalate?` | **Additive optionals on `NodeIO` (concern 4)** | The `retries?` precedent (`types.ts:368`; `retry?` `:374`, `escalate?` `:381`); absent ⇒ `legacyRetry(io.retries)`, today's exact semantics. |
| **G12** `NodeIntent.reroute?` | **Additive — authoring layer only** | The `fusion?` precedent: consumed by `expandReroute` pre-`compile`, never on dense `NodeSpec`. |
| **G12** `PolicyAction` 3→5 members | **One type-level change, FLAGGED** | The shipped union is `'block'\|'warn'\|'stop'\|'retry'\|'escalate'` (`types.ts:289`); a superset, old policies untouched. `stop` is a documented alias of `block` (§2.4), not a new effect. |
| **G12** `Escalator` seam | **Horizontal seam type + `runWorkflow` option** | Mirrors `SecretResolver`/`registry`; not a node field. |
| **G13** `op?: OpSpec[]` on `NodeSpec` | **WIDEN by EXACTLY ONE field (justified spine touch)** | A new top-level field that UNIFIES the two already-additive extension fields `hooks?` (concern 3-ext) and `ops?` (concern 5) into one cleaner head; the old keys lower to `op[]` AT THE LOADER (never retained on the dense `NodeSpec`). Justified against `types.ts:10-11`: providers/tools/hooks plug in WITHOUT a new CONCERN; the named five are unchanged; every old key still compiles + runs byte-identically (the `ops?`/`checkpoint?` additive template). **Flagged as a spine touch, NOT claimed as net-zero.** |

Net: G11 and G12 are zero-dense-spine. G13 is the one justified widen — the dense `NodeSpec` gains exactly one field and does not add a sixth NAMED concern.

---

## 6. Worked `node.json` examples (before / after)

**A verify node — NEW unified shape** (pre-gate staged input, run a deterministic check, post-gate the output, retry-on-quality-verdict, escalate-on-exhaustion):
```jsonc
{
  "id": "verify-2", "phase": "verify", "deps": ["w4-execute"],
  "prompt": { "file": "prompt.md" },
  "contract": { "artifacts": ["verify/report.json"], "owns": ["verify/**"], "readScope": ["spec/**"] },
  "op": [
    { "when": "pre",  "reads": ["spec/blueprint.json"],
      "gate": { "kind": "json-parses", "path": "spec/blueprint.json" }, "onFailure": "block" },     // #11
    { "when": "post", "writes": ["verify/report.json"],
      "run": { "cmd": "node", "args": ["scripts/lint.mjs"] }, "onFailure": "warn" },                // #9/#18
    { "when": "post", "reads": ["verify/report.json"],
      "gate": { "kind": "fenced-tail", "param": { "minItems": 3 } }, "onFailure": "retry" },        // #6
    { "when": "on-failure", "action": { "kind": "rerouteTo", "node": "w4-execute", "max": 3, "evidence": ["verify/report.json"] } }, // #2 unrolled
    { "when": "on-failure", "action": { "kind": "escalate", "via": "deep", "evidence": ["verify/report.json"] } } // #4
  ]
}
```

**SAME node — OLD shape, STILL valid, lowered to the identical `op[]`** (no migration forced):
```jsonc
{
  "id": "verify-2", "phase": "verify", "deps": ["w4-execute"],
  "prompt": { "file": "prompt.md" },
  "contract": { "artifacts": ["verify/report.json"], "owns": ["verify/**"], "readScope": ["spec/**"] },
  "checks": { "post": [{ "kind": "fenced-tail", "param": { "minItems": 3 } }] },     // → op gate
  "policy": { "fail": "block" },                                                     // → op onFailure
  "hooks":  { "promote": [{ "from": "verify/report.json:status", "to": "verdict" }] } // → transform op
}
```

**A tool-using node — G11 authoring** (per-node tools + `$VAR`-ref MCP creds):
```jsonc
{
  "id": "triage", "phase": "research", "deps": [],
  "prompt": { "file": "prompt.md" },
  "tools": { "allow": ["fs:read", "fs:write", "mcp.github:create_issue", "oc.calc:add", "contract:submit_result"] },
  "mcp": { "servers": { "github": {
    "transport": "http", "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer $GITHUB_TOKEN" }   // $VAR REF — never a literal
  } } },
  "contract": { "artifacts": ["triage.json"], "owns": ["triage.json"], "readScope": ["."] }
}
```
A node with NO `mcp` block, NO new op fields, all-native tools (game-omni) compiles and runs byte-identically (Constraint #2).

---

## 7. Non-goals

- **Unifying the inner value-extraction token grammars** (`seed {file:field}`, `promote <art>:<field>`, project bare paths, `checks.path`) — they stay per-executor resolvers inside a body; unifying touches three executors for zero behavior gain and risks Constraint #2.
- **A runtime cyclic / re-entry primitive** — explicitly rejected; reroute is compile-time UNROLL only, `checkCycles` is never modified.
- **A mid-stage sibling-cancel for `block`** — explicitly rejected (it would break additivity for every existing block-policy template, §2.4 option A); `stop` is a documented alias of `block` reserved for a future graceful-cancel primitive.
- **A new config home for the stronger-model target or notify channel** — escalate resolves through `model-routing.ts`; notify binds through the `Escalator` host seam; neither adds a config home.
- **Product vocabulary in core** — no Slack URL, no model-tier NAME, no product noun in `packages/core`; the SDK owns the action VOCABULARY, the host owns the BINDING (`CLAUDE.md:4-5`).
- **Nested/unbounded reroute** — G12 scopes single-level bounded reroute (the game-omni #2 demand); a run-level total-node cap for nested reroute is deferred to G13's global op-protocol bound.
- **The `#14` bridge `$VAR` expansion** — a one-line fix in `@piflow/tool-bridge`, OUT of core; G11 wires the runner side completely. #14 is DEFERRED, never counted as closed.

## Open questions / deferred

- **Codec round-trip of the `op[]` shape — RESOLVED (shipped in M5).** `contract.ts` now carries a `DRIVER-OP` marker (encode `:130`, decode `:181`, marker doc `:45`) alongside the prior `DRIVER-CHECKS-PREPOST` (`:120-121`), so a node authored in the new `op[]` shape round-trips losslessly through `markersFromNode`/`nodeFromMarkers` (`op-codec-roundtrip.test.ts`). No caveat remains — this is no longer an open question.
- **#15 `stop` is closed as documented-equivalence, not a new effect (declined option A).** Giving `block` a real mid-stage abort so `stop` could be the graceful contrast was DECLINED because it changes `block`'s observable behavior and breaks additivity (§2.4). `stop≡block` today; the name is reserved.
- **#14 bridge `$VAR` expansion is deferred to `@piflow/tool-bridge`, not core** — tracked as a follow-on issue, proven by V1b once fixed; never counted in the "24 closed" tally.