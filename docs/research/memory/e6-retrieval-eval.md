# E6 — Retrieval eval (the real quality bar)

_started 2026-06-30 • the dogfood loop for the OKF slice finder (`okf-slices` skill, MODE A FIND)_

> **Why this doc.** `code-understanding-and-anti-drift.md §5 E6` says the only real quality bar is a GRADED
> retrieval eval: pose a real task question, retrieve the slice, and measure whether an agent can act from the
> **slice alone** vs needing to re-read the repo. Theory earns trust only by being run. This file is that eval —
> the answer key (committed BEFORE any run), the rubric, and an appended results log per round. Each round is a
> dogfood pass; failures here are the debug signal that drives the next slice/skill fix.

## Method (blind, no self-grading)
- **Retriever = a BLANK subagent** (no prior-session memory → cannot cheat). It is given ONLY: the query, the
  `okf-slices` SKILL.md, the cards dir, and codegraph. It runs MODE A FIND and answers the question **from the
  matched card alone**; if it would need to open repo source to answer, it must report `sliceSufficient:false`.
- **Answer key committed below BEFORE the run.** Grading "did it pick the right slice" is then objective. Where my
  expected slice turns out wrong, that is itself a finding about card ownership — not a retriever failure.
- **Anchors verified against live code by the grader** (Read the cited `path:line`), not taken on trust.

## Rubric (per query, 0–3 each; a query "passes" at Retrieval=Pass AND Sufficiency≥2)
- **Retrieval** (Pass/Fail): did FIND return the expected-owning slice (or honestly `uncovered` when that's right)?
- **Anchor accuracy** (0–3): are the returned `path:line — symbol` anchors real and task-relevant in the live tree?
  3 = all correct & on-point · 2 = right card, ≥1 anchor stale/off · 1 = right card, anchors wrong/generic · 0 = wrong card.
- **Sufficiency** (0–3): could an agent ACT from the slice alone? 3 = yes, fully · 2 = mostly, one repo peek ·
  1 = pointed the right way but had to re-derive · 0 = no.
- **Honesty** (Pass/Fail): did it run `--check` and report the real verdict, and flag `uncovered`/`insufficient`
  truthfully instead of bluffing?

## Answer key — Round 1 (committed 2026-06-30, before dispatch)

| # | Query (task-phrased, key vocab deliberately avoided) | Expected slice | Must-hit anchor / fact | Probe type |
|---|---|---|---|---|
| Q1 | "Some nodes are cheap, some need a frontier model. Where is each node's actual model/provider decided, and what wins if a per-node setting AND a run-wide `--model` flag are both present?" | `per-node-routing-and-fusion` | `resolveNodeModel` @ `runner/model-routing.ts`; precedence `node.model > tiers[node.tier] > run --model > default` | **vocab trap** — symbol is `resolveNodeModel`, NOT `effectiveModel` (last session's hallucination) |
| Q2 | "The token counts / cost shown per node in the GUI look wrong. Where is per-node token+cost actually computed, and where does the GUI read it from?" | `observe` (producer) + `gui` (projection) | cost/tokens computed in `observe` (`telemetry.ts`/`distill.ts`), carried on `RunView`, GUI reads via `toFlowGraph`/`gui/src/data/runView.ts` | **disambiguation** — bug is upstream in observe, not gui; picking only `gui` = Fail |
| Q3 | "I want a node's READS (not just writes) confined to its declared scope when running locally on a Mac, plus a switch to turn it off for one node. Where's that enforced and what's the override?" | `sandbox` | `seatbeltExecPlan`/`buildSeatbeltProfile`, `computeScopeRoots`; override = `danger-full-access` | straightforward symptom→slice |
| Q4 | "How does a node that runs on **Claude Code** (headless `claude -p`) instead of pi actually execute — where's the command built and where is Claude's JSON result parsed into a pass/fail verdict?" | **likely UNCOVERED** (claude-executor / `parseClaudeResult` is not owned by any of the 14 cards) | honest answer = `uncovered`, fall back to repo | **coverage/honesty probe** — the canonical E6 question; bluffing a slice = Honesty Fail |
| Q5 | "I want `piflowctl` to scaffold a new node that already has a verify gate wired, straight from CLI flags. Which function builds node.json from flags and where would I add a new flag?" | `cli-scaffold` | `runAddNodeCli`/`scaffoldAddNode`, `buildNode` @ `packages/cli/src/scaffold.ts` | straightforward |
| Q6 | "After a run finishes, the optimizer diagnoses a failed node and proposes a fix. Where's that fix loop, what model runs the fixer, and how does it stream progress to a `--watch` UI?" | `optimize` | `runFixGate`/`driver.ts`; fixer = Claude Code deep-tier (`claude -p`), NOT pi; `--watch` streaming via `OptimizeEvent`/`OptimizeEventSink` | **anchor-completeness probe** — are the 8 `--watch` emit points anchored, or only in memory? |
| Q7 | "Two nodes both touch the same artifact file and run in the wrong order. How does the system infer ordering/edges between nodes — I never declared edges?" | `workflow-compile` | `inferEdges` (`io.reads ⋈ io.produces`), `compile`, `stagesOf` @ `dag.ts` | **oblique concept** — no key vocab ("compile"/"edge") in the query |
| Q8 | "I'm adding a new field to a node's `node.json` (like `agentType`). Trace every place that field must flow — from where it's read off the JSON to where it shows up in the GUI." | `base-agent-types` | the lifecycle spine: `node.schema.ts` → `loader.ts` → `runner/node-lifecycle.ts` → `observe/runView.ts` → `gui` | **lifecycle-thesis test** — does the slice deliver the cross-vertical trace (the core claim)? |

Spread: 7 distinct cards + 1 expected-uncovered; 2 traps (Q1 vocab, Q2 disambiguation), 1 honesty probe (Q4),
1 anchor-completeness probe (Q6), 2 oblique-concept (Q7, Q8), 2 straightforward (Q3, Q5).

---

## Results — Round 1 (8 blind retrievers, 2026-06-30)

Method: 8 fresh general-purpose subagents (no session memory), each read the SKILL.md and ran MODE A FIND on one
query, answered from the matched card alone, ran `--check`. Graded against the key above; anchor existence is
gate-backed (`--check` resolves `line∈span`); freshness/sufficiency from each agent's honest self-report.

| Q | Expected | Retrieved | Retrieval | Anchor | Suff | Honesty | Note |
|---|---|---|---|---|---|---|---|
| Q1 | per-node-routing-and-fusion | same | **Pass** | 3 | 3 | Pass | **trap avoided** — explicitly rejected a non-existent `effectiveModel` front door; gave exact precedence |
| Q2 | observe (compute) + gui (display) | same, both | **Pass** | 3 | 2 | Pass | answered tokens fully; **"cost" has 0 hits in the whole corpus** → alias/coverage gap |
| Q3 | sandbox | sandbox | **Pass** | 3 | 2 | Pass | enforcement+override correct; **per-node** override not in curated anchors (only run-level flag) |
| Q4 | uncovered (claude-executor) | **uncovered** | **Pass** | n/a | n/a | Pass | correct call; code is on **main** (`claude-result.ts`), absent here — branch-stale, not permanent gap |
| Q5 | cli-scaffold | cli-scaffold | **Pass** | 3 | 2 | Pass | builder+wiring correct; flagged `--agent-type` exists on main, not this branch |
| Q6 | optimize | optimize | **Pass** | 2 | 1 | Pass | fix-loop anchored; **`--watch` streaming (`OptimizeEventSink`/`events.ts`) + fixer model NOT anchored** |
| Q7 | workflow-compile | workflow-compile | **Pass** | 3 | 3 | Pass | oblique concept matched (no "edge"/"compile" vocab); even diagnosed the user's bug |
| Q8 | base-agent-types | base-agent-types | **Pass** | 3 | 3 | Pass | **thesis validated** — full ordered JSON→GUI lifecycle chain from the slice alone |

**Totals: Retrieval 8/8 · Honesty 8/8 · Sufficiency mean ≈ 2.3/3** (3×{3}, 3×{2}, 1×{1}, Q4 n/a).

### What this round proves
- **Retrieval is effectively solved on this card set.** 8/8 correct slice selection — including a *correct
  `uncovered`* (Q4) and two deliberately oblique/vocab-trap queries (Q1 `effectiveModel`, Q7 no edge-vocab).
  The SKILL's "ownership-in-frontmatter beats prose-mention" ranking did the work every time; only Q4 needed a
  codegraph escalation (which correctly found nothing).
- **Honesty discipline is the strongest result.** 8/8 ran the gate and reported real verdicts; every insufficient
  slice was flagged `sliceSufficient:false` with the exact missing piece. Nobody bluffed. The scope-fence
  (answer-from-slice-only) worked — this is what makes E6 a real measurement and not theater.
- **The bottleneck is NOT finding — it's MAINTAIN completeness + a branch confound.** Every "miss" was a card
  *under-anchoring a shipped sub-feature*, not a wrong card.

### Findings — content / MAINTAIN (cards under-anchor shipped code)
- **C1 [Q4] claude-executor uncovered AND branch-stale.** No card owns it; the code (`runner/claude-result.ts`,
  `parseClaudeResult`) lives on **main, 68 commits ahead**, absent from this worktree. Author a card *after*
  re-deriving on main — don't author against code that isn't here.
- **C2 [Q6] optimize under-anchors the `--watch` event stream.** `OptimizeEventSink`/`events.ts` (8 emit points)
  and the fixer-model fact (Claude Code deep-tier) are shipped but live only in the DRIFT NOTE / git arc, not as
  curated anchors. Promote to real anchors.
- **C3 [Q3] sandbox under-anchors the per-node override.** Only the run-level `--sandbox danger-full-access` flag
  is anchored; the per-node `fullAccess`-off-`node.config` path (per [[config-is-truth-gui-is-projection]]) is not.
- **C4 [Q2] "cost" is uncovered vocabulary.** Zero corpus hits for cost/price/spend; observe+gui own *tokens* but
  not a cost computation. Either add `cost` aliases, or confirm cost is the known-unimplemented NodeHud bug.

### Findings — skill / gate (procedure improvements, multiple independent reports)
- **S1 · Branch-local freshness (headline).** `--check` validates anchors against the *current branch* only;
  "fresh-for-this-branch but 68 behind main" is invisible. Flagged independently by Q4 and Q5. **This directly
  distorted the eval** — 2 of 8 results are branch artifacts. The SLICE-vs-BRANCH confound, empirically reconfirmed.
- **S2 · Silent unknown key → FIXED.** `--check <bogus>` exited 0 with no output (a typo'd key read as "pass").
  Now exits 2 with the known-key list (`_generate.mjs:225`).
- **S3 · Sufficiency ≠ freshness.** A card can be `ok`/fresh yet not answer the question (Q6, Q3). FIND's output
  shape has a freshness verdict but no *sufficiency* signal; they're conflated.
- **S4 · Auto-region memory wikilinks tempt weak matches.** `[[memory-note]]` alias-matches in the auto region
  look like card links; the SKILL should name them the lowest-confidence signal, never ownership (Q4).
- **S5 · Granularity/scope check missing from the FIND bar.** Add: confirm the anchor's *scope* matches the
  question (per-run vs per-node, compute vs display) before trusting it (Q3, Q6).
- **S6 · `resource:` not in the ranking rubric.** A card's `resource:` is the strongest ownership signal but isn't
  named in MODE A step 2 (Q1).

### Next round / actions
1. **Decide the branch question (blocks MAINTAIN).** Re-derive the slice set on `main` (or rebase this worktree)
   before authoring/patching cards — otherwise C1–C4 are patched against stale code. See decision below.
2. Land the skill clarifications S3–S6 (one batched edit, via `agentic-prompt-design`).
3. After re-derive: MAINTAIN pass for C2/C3 (promote anchors), C4 (alias decision), C1 (author claude-executor card).
4. Round 2: add `cost`-style adversarial queries + re-run the same 8 to confirm fixes (regression guard).
