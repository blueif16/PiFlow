# Leg B — code understanding (code-map / function slices) + anti-drift
_started 2026-06-30 • the dedicated design + experiment doc for the WORLD/CODE leg_

> **Relationship to the canon.** `piflow-memory-v1.md` + `piflow-memory-v1.5.md` are really the **optimization
> loop** (gates · four-way triage · scoring · the overlord). The two legs are *context the loop reads*:
> Leg A = self/history (`memory.md`), **Leg B = world/code (`code-map.md`)** — defined cramped in `v1 §5b`.
> This doc PULLS Leg B out to design it on its own: the slice UNIT, what it records, the ANTI-DRIFT machinery,
> and an EXPERIMENT BACKLOG to find which approaches actually work on our own codebase.
> SOTA grounding for anti-drift: `anti-drift-sota-2026-06-30.md`. Reader/consumer (the fixer): `v1.5 §6–§7`.

## 0. Why a separate doc — and one correction
- **Leg B is the least-built leg.** `v1 §11`: the scaffold (`packages/core/src/code-map.ts`) is an EMPTY Tier-0
  stub (headers only, create-if-absent); **nothing reads it yet** — the optimizer's first reader is Leg A
  (`memory.md` recurrence → SKILL bucket, `v1.5 §7`). So Leg B needs its own design before it has a consumer.
- **The unit we actually want is a FUNCTION/VERTICAL LIFECYCLE slice**, not the per-node keyword stub the SDK
  seeds today (§1).
- **Correction (do not repeat):** there is NO "anti-drift tier-3 = external EXA/Reddit research." That was never
  in the design; it was a framing error. The anti-drift cascade is **internal + deterministic-first** (§4). (The
  only "Tier 3" in the canon is `v1.5 §4d` abstain-to-human, part of the SCORING cascade — unrelated.) Web
  research stays a one-off tool for US (it produced `anti-drift-sota-2026-06-30.md`), never a system component.

## 1. The unit — a function/vertical lifecycle slice
A slice traces ONE functionality along its **spine** — from its ORIGIN (where it's declared/defined) to its
TERMINAL EFFECT (where its consequence lands: a rendered pixel, a jailed syscall, a committed edit, a written
artifact). It is NOT a symbol lookup, and the stages are **emergent per vertical, NOT a fixed template.**
`define→…→render` fits a *presentation* feature like `base-agent-types`, but `optimize` ends at a committed edit
(SCORE→TRIAGE→GATE→LAND), `sandbox` at a jailed process (SCOPE→PLAN→ENFORCE), `memory-leg` at *nothing yet*
(DEFINED→SEEDED→CONSUMED-**absent**). Trace the spine wherever it goes — "render" is one possible terminal, not
a law. Three slice grains exist; we are building the **middle** one:

| Grain | What | Status |
|---|---|---|
| per-node Tier-0 `code-map.md` | one node's scope, self-contained | scaffolded stub (`code-map.ts`), no reader |
| **per-vertical lifecycle slice** (subsystem) | a feature traced along its spine (origin→terminal effect) | **the target — unbuilt in piflow** |
| product-global OKF index (Tier-1) | all verticals + codegraph anchors | hand-built only in game-omni (`.agents/okf/`) |

**Worked example — `base-agent-types` (traced live on piflow 2026-06-30).** The lifecycle spans 4 verticals:
```
DEFINED        core/src/workflow/agent-preset.ts:23  AgentPreset (shape)
               core/src/workflow/agent-preset.ts:64  mergePreset() — PURE author-time expansion
               core/src/workflow/fusion/presets.ts:24 FUSION_PRESETS — built-in presets
DERIVED@start  core/src/workflow/template/schema/node.schema.ts:55  agentType field on node.json
               core/src/workflow/agent-preset.ts:214 loadAgentPreset() — read ~/.piflow/agents/<id>.md
CONSUMED       core/src/workflow/template/loader.ts:159  → NodeIntent.agentType
               core/src/runner/node-lifecycle.ts:778     stamps node.agentType into NodeConfig
PASSED THROUGH core/src/observe/runView.ts:291            agentType → RunViewNode
RENDERED       gui/src/data/runView.ts:371  toFlowGraph() resolves agentType → icon/color off AgentCatalog
               gui/src/components/NodeModeStrip.tsx:85    renders the base-agent chip
verticals: core · (cli) · observe · gui
```
**Two findings from this trace:** (a) a REAL drift — project memory said presets live in `packages/core/src/seeds/`,
but that dir holds only `calc.ts`; real home is `packages/core/src/workflow/fusion/presets.ts` + `~/.piflow/agents/`.
(b) a FALSE drift, now corrected — the trace (run on branch `feat/optimize-prove-landing`, ~62 commits behind `main`)
"found only the node.json field" and flagged the memories' `piflowctl --agent-type` flag as unbacked. It is in fact
backed on `main` (`packages/cli/src/scaffold.ts:623`, merged `fc73095`); the memories were right and the trace was
branch-stale. **Lesson (the slice-vs-branch confound):** a slice's anchors track the branch it was derived on — an
"absent capability" must be checked against `main` before being called drift; tier-0 (§4) resolves symbols within a
tree, it does not reconcile branches.

## 2. Slice discovery — the repeatable, per-repo procedure (confident sources, no guessing)
**The slice set is a PROJECTION of the live graph, not a hand-guess** — each slice traces to a place a human
DECLARED a unit. Which source answers which question (validated on piflow 2026-06-30):

| Question | Authoritative source | NOT |
|---|---|---|
| Which slices exist NOW? (membership) | codegraph: files **reachable from the live entry points** (each package `index.ts`/`bin` + each app `main`) | git history — it remembers dead concerns forever |
| How important? (ranking) | codegraph: current cross-file **centrality** (fan-in) | git CUMULATIVE commit count (over-weights historically-troubled-but-now-dead code; cf. CodeScene) |
| What's it named? | the commit **scope** / spec that last touched the cluster | — |
| Live or dormant? | git **recency** (last-touched) per slice | git **frequency** |

**Procedure (deterministic, per repo):** ① **Roots** = every entry point from the manifests (`*/src/index.ts`
exports, each `bin`, each app `main`). ② **Membership** = codegraph reachability closure (BFS along outgoing
edges) from roots — removed code can't be reached, so it drops out automatically (proven: `transformWorkflow`
is gone → absent; its 17 commits never resurrect it). ③ **Cluster** = bucket reachable files by module/dir (the
authored boundary); a file referenced across many modules = a cross-cutting **thread** slice (base-agent-types,
the op protocol), the rest = **subsystem** slices. ④ **Rank** by summed centrality. ⑤ **Name** by the scope/spec
that last touched it. ⑥ **Liveness** = git last-touched → old = dormant flag (never auto-include by churn).

**Validated candidate set (piflow SDK, by live centrality, 2026-06-30):** core/(root, split) · core/runner(26f) ·
core/workflow(30f) · core/tools · core/optimize · core/observe · core/sandbox · core/catalog · core/names ·
core/memory · core/hooks · pkg/{cli,tool-bridge,e2b,daytona,langgraph}. This GROUNDED list replaces the hand-guess
— it shows `runner`+`workflow` need splitting into sub-slices and surfaced modules the guess missed (`names`, `hooks`).

**Rolling maintenance (why it's lifecycle, not one-shot):** re-run post-merge / on a cadence — a cluster that
LEAVES the reachable set → **retire** (human-gated); a new reachable cluster + fresh scope → **add**;
reachable-but-old → **dormant flag**. Membership (reachability) and liveness (recency) are the SAME primitives the
anti-drift cascade (§4) uses → discovery and maintenance are ONE machinery at two moments; the slice set tracks
the architecture by construction.

**PROVEN vs NOT-YET (record only what works):** ✅ reachability-membership + centrality-rank + module-cluster +
scope-name + recency-liveness — on **TS/SDK** code (computed clean above). ⚠️ KNOWN LIMIT (proven failure):
codegraph traces TS import/call graphs but **not React/JSX composition** — every `gui/src/components/*` showed
false-"unreachable" (gui centrality 4); for frontends, root from the app `main`/html and fall back to
directory-as-cluster, and remember reachability is only as complete as the ROOT SET (a missing entry = false
dead-code). The SOTA audit (`sota-verification-2026-06-30.md` P2) generalizes this: reachability under-counts ALL
dynamic/framework-wired dispatch (DI, glob-import, reflection, lifecycle hooks), not just JSX — so prefer a
confidence tier (safe / likely / **review**) over a binary in/out. And a NUANCE on liveness: only CUMULATIVE
frequency is the rear-view trap — *recent* churn among already-LIVE slices is a positive importance signal (churn is
the best-validated defect-risk predictor, Nagappan & Ball ICSE'05), so use recency as a liveness/importance signal,
never as a negative. 🔬 NOT-YET: sub-directory community detection, auto-split of the big buckets, auto-retire (today
= human-gated flag).

**Repo-agnostic:** every step reads only manifests + codegraph + git — no piflow-specific knowledge — so the same
procedure stands up the slice set for ANY repo; the slices live in that repo's `.agents/okf/` (the SDK stays
product-agnostic, per [[sdk-data-boundaries]]).

## 3. What a slice records (two halves)
Same shape as game-omni's working cards (`_generate.mjs`): a curated half an agent authors, an auto-derived half
the substrates fill. Curated is the *understanding*; derived is the *evidence*.
- **Curated:** frontmatter (`key`, `aliases`, `seeds`, `symbols`, `tracks?`, `resource`) + prose (Why / how the
  lifecycle works / Invariant / Gotchas) + an **Anchors** list (`path:line — symbol — role`, grouped by stage).
- **Derived (below an `auto` marker):** evolution arc (git), file set (seeds or grep touch-frequency), memory
  lessons (hub cluster), code anchors / blast-radius (codegraph), and a `Freshness` line = the §4 drift signals.
- **Law (from `v1 §5b`):** pointers + semantics, NEVER a copy; **OPTIMIZER-FACING, never injected into a node's
  runtime prompt**; one OKF reader serves Tier-0 (one slice) and Tier-1 (indexed) — codegraph is a pure upgrade.

## 4. Anti-drift — internal, deterministic-first cascade
Detect cheap & often (machine); author expensive & gated (agent); NEVER auto-rewrite curated prose. Each tier
maps to a different substrate; only tier 0 is a hard gate, tiers 1–2 are advisory flags that batch into the
optimizer's between-run review (`v1.5 §6`). Grounded in `anti-drift-sota-2026-06-30.md` (mechanism #s cited).

| Tier | Detector | Substrate | Trigger | Status · SOTA grounding |
|---|---|---|---|---|
| 0 · anchor resolution | every seed exists AND every anchor `path:line:symbol` resolves — def-anchor `line ∈ symbol span`, call-site/field symbol-present-in-file | git tree + codegraph `query` (spans) | pre-commit (blocking) | ✅ **BUILT** (`_generate.mjs --check`) · #8 Staleguard L1 |
| 1 · content/provenance | `slice@sha` ≠ HEAD, or tracked **method-body AST-hash** changed | git + tree-sitter | post-merge | 🔬 designed (E4) · #1/#4/#10 docdrift, agents-remember, Cursor merkle |
| 2 · dependency | change's blast-radius hits the slice's anchors (outside its own seeds) | codegraph `impact`/`affected` | post-merge (graph sync) | 🔬 designed (E5) · #5 Glean fanout, vitest-affected |
| (advisory) | LLM finds a *quotable* prose↔code contradiction; silent otherwise | LLM, evidence-gated | only on slices past 0–2 | 🔬 designed · #11 Doc-Drift, Staleguard L2 |

Two lessons that shape this (SOTA): **deterministic-first** — every battle-tested doc tool puts a zero-false-
positive layer first and demotes the LLM to a hint; **don't front-load** — static context rots mid-session, so
the fixer pulls the slice just-in-time and validates after (matches "never injected into the runtime prompt").

### 4.1 When are slices maintained, and how accurate is the blast? (the granularity ladder)
Two questions decide the maintenance lifecycle: **WHEN** a slice is re-checked, and at **WHAT granularity** its
"blast" is measured. They are not one thing — blast is a **ladder**, each rung matched to a cadence, deterministic-
first. What is BUILT today vs DESIGNED (record-only-proven):

| Granularity | "Blast" = | Cadence | Catches | Status |
|---|---|---|---|---|
| **file-existence** | a referenced file is gone | pre-commit | deleted/renamed file | ✅ built (was the only check) |
| **symbol-in-file + line∈span** | an anchor's symbol left its file, or a *definition* anchor's line fell outside the symbol's span | pre-commit (blocking) | renamed · moved-to-another-file · def-anchor line drift | ✅ **built** — `--check` now resolves each anchor via codegraph `query` spans; call-site/field anchors fall back to symbol-present-in-file (zero-FP on the semantic-anchor convention where the cited line is a body line, not the decl) |
| **method-body / paragraph** | the AST-hash of a *tracked function* (`mergePreset`, `resolveNodeModel`) changed — ignoring formatting | post-merge (advisory) | the semantics a slice DESCRIBES shifted, even with no file/line move | 🔬 designed = E4 (needs tree-sitter + a `slice@sha`/body-hash pin; neither exists yet) — **this is the "accurate to paragraph of code" rung** |
| **symbol-impact (call graph)** | a change's blast-radius reaches a slice's anchors via a dependency *outside its own seeds* | post-merge (advisory) | upstream-type changes a file/line/body check structurally can't see | 🔬 designed = E5 (codegraph `impact` exists; not wired as a trigger — the per-symbol caller list IS already rendered into each card, descriptive only) |
| **coverage** | a product file that no card owns is either churn-hot (**UNCOVERED-HOT**) or high fan-in / architecturally central (**UNCOVERED-CENTRAL**) | post-merge (advisory) | a mapping GAP — a hot OR a central file with no slice | ✅ built (`--reconcile`) — HOT = git-log churn; CENTRAL = §2's fan-in centrality (`codegraph node <f> --symbols-only` → "used by N files" ≥ `CENTRALITY_MIN_INDEGREE`), so a NEW central low-churn file the churn heuristic is blind to is still surfaced. Instrument paths excluded by rule |

So the answer to "accurate to paragraph or just filename?": **today the gate is symbol-accurate — file + `line∈span`
for definition anchors, symbol-in-file for call-sites — strictly more than filename, but NOT yet paragraph.**
Paragraph-accuracy is the method-body-hash rung (E4), deliberately advisory/post-merge for COST/CADENCE reasons —
it carries tree-sitter parse cost and a body change does NOT strictly imply the prose is now wrong (a behavior-
preserving refactor re-triggers it). The AST-hash itself is a CLEAN, formatting-insensitive signal, not a noisy one
(corrected per the SOTA audit — `sota-verification-2026-06-30.md` P4; docdrift/sem/symtrace all use it as a *low*-FP
detector). Why the ladder and not one rung: a slice like `runner` spans
27 files — a filename-level trigger would re-flag it on nearly every commit (cry-wolf), whereas a method-body hash
over its ~8 anchored functions fires only when the spine it describes actually shifts. **Coarse granularity is why
a drift gate gets ignored; matching granularity to cadence is what keeps it trusted.** Maintenance IS partly
blast-determined — tiers 1–2 are literally "did this commit's blast reach the slice" — but only the pre-commit
existence/resolution rung is wired today; the post-merge re-derive (a flagged slice → the optimizer's between-run
review re-authors the curated half) and the rolling §2 re-discovery (add/retire/dormant) remain DESIGNED.

## 5. Build + experiment backlog — "which way works best"
Each is a HYPOTHESIS with a falsifiable success bar (test-discipline: the check must fail when the approach is
wrong). The hand-trace in §1 is our **ground truth** for base-agent-types. Status: [ ] todo · [~] running · [x] done.

- [x] **E0 · Coverage / dogfood.** DONE. The 11 first-pass cards were RECONCILED to the §2 set (14 cards):
  `checks-hooks`→`node-action-protocol` (absorbs the one-file `core/hooks`); `runtime-core` split into
  `workflow-compile` (template→DAG) + `runner` (DAG→artifacts) at the `Workflow` seam; added `names` and
  `per-node-routing-and-fusion` (the graph-flagged 128-fan-in `runner/model-routing.ts`, prior uncovered). The
  generator ran git-only (E0) and WITH codegraph (E2 = a per-symbol caller/blast section git-only lacks). **Win
  met:** every reachable high-centrality module maps to a slice AND the upgraded `--check` is green (the 5 reconciled
  cards clean; the only remaining flags were the loose prose-path FPs the §4.1 gate upgrade then eliminated).
  *The "grasp of all functionalities" deliverable.*
- [ ] **E1 · Slice grain.** per-node Tier-0 code-map vs per-vertical lifecycle slice, for the base-agent-types
  scope. **Win:** a fixer-agent answers "where do I change X?" correctly from ONLY the slice; compare which grain
  yields fewer wrong/again-read-the-repo answers.
- [ ] **E2 · Derivation substrate.** git-only (`OKF_NO_CODEGRAPH`) vs codegraph-anchored. Build the
  base-agent-types slice both ways; diff derived file-set + anchors against §1 ground truth. **Win:**
  precision/recall of files surfaced; quantifies what codegraph adds for a *lifecycle thread* (def→use).
- [x] **E3 · Tier-0 detector.** SHIPPED as `piflowctl understand --check` (pre-commit `--staged` blocking + CI no-index HEALTH pass). `_generate.mjs --check` was UPGRADED from filename-existence to line:symbol
  resolution (def-anchor `line ∈ codegraph span`; call-site/field symbol-in-file; degrades to symbol-in-file
  without codegraph). **Win demonstrated:** ZERO false positives on the 14 real cards (incl. the semantic-anchor
  convention where the cited line is a body line), and synthetic drift caught in all three classes — renamed symbol
  (`symbol not found`), wrong definition line (`line ∈ span` violated), moved-to-another-file (codegraph locates it).
  Cost: a full `--check` ≈ 30s (a codegraph `query` per significant token, memoized). REMAINING: reproduce a real
  historical drift (`run.mjs→legacy/`), decide pre-commit-hook vs CI placement, and whether to adopt `Staleguard`
  for tier-1 rather than extend this. The "run --write" advice is wrong for a stale curated anchor (re-author it).
- [x] **E4 · Tier-1 granularity.** SHIPPED (commit `272e29d`) as the `--reconcile` **SEMANTIC?** rung — an anchored symbol's body span-hash changed → re-read the prose; live-fired cleanly on a real body edit. file-level `slice@sha` vs tree-sitter **method-body hash** (docdrift).
  Formatting-only change vs semantic change to `mergePreset`. **Win:** method-body hash fires ONLY on the
  semantic change (fewer false re-derive triggers). SOTA note (audit P4): compute the hash at the AST-NODE level with
  incremental subtree reuse (symtrace BLAKE3 / tree-sitter `InputEdit`), NOT a from-scratch pass — cheaper than the
  current ~30s `--check`. *(The shipped rung is a symbol-span/body-hash; the AST-node-level incremental form remains
  an OPEN refinement.)*
- [ ] **E8 · Stable-symbol anchors (the headline SOTA upgrade — audit P5).** Anchor each card entry on a STABLE
  symbol id (SCIP/LSIF descriptor, or codegraph's qualified name) and DERIVE `:line` as a re-rendered hint, instead of
  storing+validating `file:line`. **Why:** line numbers are the fragile part — the whole `line ∈ span` gate exists to
  absorb line drift a symbol id never suffers; SCIP was designed expressly to "limit the blast radius of off-by-one
  indexer bugs," and its alias-chain rename detection beats our `symbol-present-in-file` fallback (free rename
  tracking). **Win:** zero line-drift near-FPs + rename detection, measured against the current `line ∈ span` gate on a
  refactor that moves a symbol's lines without changing its body. Mature tooling exists (scip-typescript/python/java,
  rust-analyzer emits SCIP natively).
- [x] **E5 · Tier-2 dependency.** SHIPPED (commit `272e29d`) as the `--reconcile` **IMPACT?** rung — diff-hunk
  change-site symbols traced through codegraph `impact` into card deps outside the change set; live-fire-proofed on a
  real `RunModel` change → 3 correct traces. change an UPSTREAM type `mergePreset` depends on (outside the slice's seeds);
  run `codegraph impact`. **Win:** the base-agent-types slice is flagged — proving git-log-of-seeds would miss it
  and the graph catches it.
- [x] **E6 · Retrieval eval (the real quality bar).** SHIPPED — FIND-vs-EXPLORE harness + golden set in
  `.agents/okf/eval/` (commit `bc2204c`); ranker work (`3ffbdc6`) moved phrase-query pass 0/5→3/5 and total positive
  77%→91%. See also the hand-run `e6-retrieval-eval.md`. ~8 real questions per vertical ("how does the Claude-
  executor node work — which files, what contract?"). **Win:** an agent answers correctly from the slice ALONE
  vs needing the repo. Graded eval, not an assertion.
- [ ] **E7 · Codegraph proof-before-promote** (`v1 §10.6`). Measure tokens/tool-calls to answer E6 with Tier-0
  (git slice) vs Tier-1 (codegraph). **Win:** a measured token/latency delta that justifies (or kills) Tier-1 on
  piflow — the gate for promoting codegraph from opt-in to default.

## 6. Decisions pending (forks to resolve as experiments land)
1. **One-off dogfood vs port into the SDK.** Reuse game-omni's `_generate.mjs` in a scratch dir first, or build
   `piflowctl understand --check|--rebuild` into `@piflow/core` with tests? (RESOLVED: shipped `piflowctl understand`
   as a THIN CLI wrapper over the repo-local `_generate.mjs` — one engine, no TS port to drift from the hook.)
2. **Build vs adopt** the drift gate: port `_generate.mjs --check`, or take `docdrift`/`Staleguard` as deps
   (E3/E4 decides). (RESOLVED: BUILT — our own `_generate.mjs --check`/`--reconcile`, no `docdrift`/`Staleguard` dep.)
3. **Codegraph on piflow:** `codegraph init` over this repo to unlock E2/E5/E7 (one command; ~100MB index).
   (RESOLVED: codegraph is init'd as a LOCAL gitignored artifact; E5 IMPACT? rides it, degrades gracefully when absent.)
4. **Who consumes the slice:** wire Leg B as the fixer's scope-context in `v1.5 §6` FIX stage (today Leg B has no
   reader). This is the bridge back to the optimizer loop. (RESOLVED: shipped `3ffbdc6` — `findSliceForDefect`/
   `resolveSlice` inject the owning slice at ownership strength ≥45, explicit lesson pointers win.)

## References
- `piflow-memory-v1.md §5b` — the original Leg-B / Tier-0↔Tier-1 definition (this doc supersedes its design depth).
- `piflow-memory-v1.5.md §6–§7` — the optimizer loop that will CONSUME these slices (the fixer's scope-context).
- `anti-drift-sota-2026-06-30.md` — the SOTA survey grounding §3 (11 mechanisms · merkle/docdrift/Staleguard scaffolds).
- game-omni `.agents/okf/` + `topics/_generate.mjs` — the working Tier-1 reference implementation we port from.
