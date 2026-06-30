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
  in the design; it was a framing error. The anti-drift cascade is **internal + deterministic-first** (§3). (The
  only "Tier 3" in the canon is `v1.5 §4d` abstain-to-human, part of the SCORING cascade — unrelated.) Web
  research stays a one-off tool for US (it produced `anti-drift-sota-2026-06-30.md`), never a system component.

## 1. The unit — a function/vertical lifecycle slice
A slice traces ONE functionality across its whole lifecycle, not a symbol lookup. Three slice grains exist; we
are building the **middle** one:

| Grain | What | Status |
|---|---|---|
| per-node Tier-0 `code-map.md` | one node's scope, self-contained | scaffolded stub (`code-map.ts`), no reader |
| **per-vertical lifecycle slice** (subsystem) | a feature traced def→derive→consume→observe→render | **the target — unbuilt in piflow** |
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
**Two drifts this trace already caught (the anti-drift case-in-point):** (a) project memory said presets live in
`packages/core/src/seeds/`, but that dir holds only `calc.ts` — real home is `fusion/presets.ts` + `~/.piflow/
agents/`; (b) two memories claim a `piflowctl --agent-type` CLI flag, but the trace found only the `node.json`
field — a claimed capability the code may no longer back (verify).

## 2. What a slice records (two halves)
Same shape as game-omni's working cards (`_generate.mjs`): a curated half an agent authors, an auto-derived half
the substrates fill. Curated is the *understanding*; derived is the *evidence*.
- **Curated:** frontmatter (`key`, `aliases`, `seeds`, `symbols`, `tracks?`, `resource`) + prose (Why / how the
  lifecycle works / Invariant / Gotchas) + an **Anchors** list (`path:line — symbol — role`, grouped by stage).
- **Derived (below an `auto` marker):** evolution arc (git), file set (seeds or grep touch-frequency), memory
  lessons (hub cluster), code anchors / blast-radius (codegraph), and a `Freshness` line = the §3 drift signals.
- **Law (from `v1 §5b`):** pointers + semantics, NEVER a copy; **OPTIMIZER-FACING, never injected into a node's
  runtime prompt**; one OKF reader serves Tier-0 (one slice) and Tier-1 (indexed) — codegraph is a pure upgrade.

## 3. Anti-drift — internal, deterministic-first cascade
Detect cheap & often (machine); author expensive & gated (agent); NEVER auto-rewrite curated prose. Each tier
maps to a different substrate; only tier 0 is a hard gate, tiers 1–2 are advisory flags that batch into the
optimizer's between-run review (`v1.5 §6`). Grounded in `anti-drift-sota-2026-06-30.md` (mechanism #s cited).

| Tier | Detector | Substrate | Trigger | SOTA grounding |
|---|---|---|---|---|
| 0 · existence | every anchor path/symbol the slice cites resolves | git tree + codegraph resolve | pre-commit (blocking) | #8 Staleguard L1, `_generate.mjs` health |
| 1 · content/provenance | `slice@sha` ≠ HEAD, or tracked **method-body AST-hash** changed | git + tree-sitter | post-merge | #1/#4/#10 docdrift, agents-remember, Cursor merkle |
| 2 · dependency | change's blast-radius hits the slice's anchors (outside its own seeds) | codegraph `impact`/`affected` | post-merge (graph sync) | #5 Glean fanout, vitest-affected |
| (advisory) | LLM finds a *quotable* prose↔code contradiction; silent otherwise | LLM, evidence-gated | only on slices past 0–2 | #11 Doc-Drift, Staleguard L2 |

Two lessons that shape this (SOTA): **deterministic-first** — every battle-tested doc tool puts a zero-false-
positive layer first and demotes the LLM to a hint; **don't front-load** — static context rots mid-session, so
the fixer pulls the slice just-in-time and validates after (matches "never injected into the runtime prompt").

## 4. Build + experiment backlog — "which way works best"
Each is a HYPOTHESIS with a falsifiable success bar (test-discipline: the check must fail when the approach is
wrong). The hand-trace in §1 is our **ground truth** for base-agent-types. Status: [ ] todo · [~] running · [x] done.

- [ ] **E0 · Coverage / dogfood.** Enumerate piflow's verticals (runtime · optimize · observe · memory+code-map ·
  sandbox · catalog · tools/tool-bridge · checks/hooks · cli · gui · cloud · base-agent-types). Author one
  lifecycle slice each. **Win:** `--check` green (every anchor resolves) AND the slice set names every vertical
  with no gap. *This is the "grasp of all functionalities" deliverable.*
- [ ] **E1 · Slice grain.** per-node Tier-0 code-map vs per-vertical lifecycle slice, for the base-agent-types
  scope. **Win:** a fixer-agent answers "where do I change X?" correctly from ONLY the slice; compare which grain
  yields fewer wrong/again-read-the-repo answers.
- [ ] **E2 · Derivation substrate.** git-only (`OKF_NO_CODEGRAPH`) vs codegraph-anchored. Build the
  base-agent-types slice both ways; diff derived file-set + anchors against §1 ground truth. **Win:**
  precision/recall of files surfaced; quantifies what codegraph adds for a *lifecycle thread* (def→use).
- [ ] **E3 · Tier-0 detector.** port `_generate.mjs --check` vs adopt `Staleguard`. Move a real anchored file
  (reproduce the `run.mjs→legacy/` drift). **Win:** drift caught, ZERO false positives on an unrelated commit.
- [ ] **E4 · Tier-1 granularity.** file-level `slice@sha` vs tree-sitter **method-body hash** (docdrift).
  Formatting-only change vs semantic change to `mergePreset`. **Win:** method-body hash fires ONLY on the
  semantic change (fewer false re-derive triggers).
- [ ] **E5 · Tier-2 dependency.** change an UPSTREAM type `mergePreset` depends on (outside the slice's seeds);
  run `codegraph impact`. **Win:** the base-agent-types slice is flagged — proving git-log-of-seeds would miss it
  and the graph catches it.
- [ ] **E6 · Retrieval eval (the real quality bar).** ~8 real questions per vertical ("how does the Claude-
  executor node work — which files, what contract?"). **Win:** an agent answers correctly from the slice ALONE
  vs needing the repo. Graded eval, not an assertion.
- [ ] **E7 · Codegraph proof-before-promote** (`v1 §10.6`). Measure tokens/tool-calls to answer E6 with Tier-0
  (git slice) vs Tier-1 (codegraph). **Win:** a measured token/latency delta that justifies (or kills) Tier-1 on
  piflow — the gate for promoting codegraph from opt-in to default.

## 5. Decisions pending (forks to resolve as experiments land)
1. **One-off dogfood vs port into the SDK.** Reuse game-omni's `_generate.mjs` in a scratch dir first, or build
   `piflowctl okf build|check` into `@piflow/core` with tests? (Recommend: dogfood E0–E3 first, then port.)
2. **Build vs adopt** the drift gate: port `_generate.mjs --check`, or take `docdrift`/`Staleguard` as deps
   (E3/E4 decides).
3. **Codegraph on piflow:** `codegraph init` over this repo to unlock E2/E5/E7 (one command; ~100MB index).
4. **Who consumes the slice:** wire Leg B as the fixer's scope-context in `v1.5 §6` FIX stage (today Leg B has no
   reader). This is the bridge back to the optimizer loop.

## References
- `piflow-memory-v1.md §5b` — the original Leg-B / Tier-0↔Tier-1 definition (this doc supersedes its design depth).
- `piflow-memory-v1.5.md §6–§7` — the optimizer loop that will CONSUME these slices (the fixer's scope-context).
- `anti-drift-sota-2026-06-30.md` — the SOTA survey grounding §3 (11 mechanisms · merkle/docdrift/Staleguard scaffolds).
- game-omni `.agents/okf/` + `topics/_generate.mjs` — the working Tier-1 reference implementation we port from.
