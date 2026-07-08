---
key: optimization-objective-shape
title: What a self-improving system optimizes for (quality floor, efficiency pressure)
domain: objectives
status: adopted
description: Reach for this when designing/reviewing an accept gate or optimizer score — quality gates, efficiency is a scored defect class, never fuse them.
aliases: [accept gate design, quality vs cost, objective function, scoring shape, weighted scalar, lexicographic gate, budget as defect]
tags: [objectives, accept-gate, efficiency, scoring, pareto]
updated: 2026-07-03
---

# What a self-improving system optimizes for (quality floor, efficiency pressure)

## Trigger
- You are designing or reviewing what an optimizer/fixer scores a candidate on, or what the
  accept gate compares before landing an edit.
- Someone proposes folding cost/tokens/latency into the same number as task quality
  ("weight quality 0.7, cost 0.3" or similar).
- A run is green (task succeeded) but burned an outsized token/tool-call/context budget, and
  the question is whether that alone should open a fix ticket.
- An efficiency-motivated edit is on the table and it's unclear what has to hold true to land it.

## Practice
1. **Quality is the only accept authority.** A candidate edit lands iff a checkable task outcome
   (execution success, held-out score, verifier pass) is at least as good as the baseline. Never
   let an efficiency number alone authorize an accept.
2. **Declare efficiency budgets per node/stage (time, tokens, context-fill, tool-call count)
   and treat any breach as a DEFECT, not just telemetry** — file it into the same fix worklist a
   quality bug would go into, even when the run is green. Efficiency defects are quality risks:
   excess reasoning length, bloated context, and redundant tool calls each independently degrade
   the checkable outcome, not merely its cost — so an unaddressed budget breach is a live quality
   risk sitting in the backlog, not a footnote.
3. **Gate efficiency-motivated edits lexicographically, never with a blended score:** land iff
   (a) quality is not worse than baseline, AND (b) the specific breached budget metric strictly
   improves. Do not require every metric to improve — only the one the edit targets — but never
   trade quality for it.
4. **Never build a fused quality×cost scalar** (e.g. `0.7*quality + 0.3*efficiency`). Scalarization
   collapses distinguishable trade-offs into one brittle number that shifts arbitrarily when a
   metric's scale changes, and no shipped self-optimizer uses this shape. If you need to compare
   more than one axis, keep them as separate dimensions (a Pareto set, or the lexicographic gate
   in rule 3) — never sum them.
5. **Feed efficiency signals into candidate generation and selection, not just gating.** When
   producing or picking among candidates (prompt variants, edit proposals, routed model/effort
   choices), prefer the candidate with a smaller footprint (shorter reasoning, less context,
   fewer tool calls) among those that already clear the quality bar — this is a generation-time
   preference, separate from the binary accept decision in rules 1–3.
6. Reserve hard floors for the accept/deployment gate only. Do not try to bake a quality floor
   into the search/generation objective itself — let generation explore freely and prefer
   efficient candidates, then gate strictly on quality + the targeted budget at accept time.

## Evidence
- No shipped self-optimizer folds efficiency into its accept score: SkillOpt gates on
  `cand_score > current_score` (held-out outcome only; ALFWorld 68.6%→81.4% selection,
  70.9%→85.8% test-hard); GEPA's Pareto pool diversifies over task subsets, not quality-vs-cost
  (arXiv:2507.19457, ICLR 2026 oral); AlphaEvolve's efficiency objective bounds the optimizer's
  own search compute, not the candidate's accept criterion. → internal corpus audit,
  `docs/research/memory/eval-trajectory-process-scoring-2026-06.md` +
  `gap-analysis-optimizer-substrate-2026-06-29.md`.
- Excess reasoning, bloated context, and redundant tool calls each independently degrade task
  quality, not just cost: picking the less-overthinking of two SWE-bench candidates raised
  success ~30% while cutting compute 43% (arXiv:2502.08235); capping tokens at 1,024 collapsed
  accuracy 72%→44% on a math task (arXiv:2507.04023); a repeated tool-sequence ≥10 corresponds to
  89% trajectory-failure probability (arXiv:2504.21798, "SWE-smith").
- Cutting efficiency signals often IMPROVES quality (why budget breaches are real defects, not
  noise): entropy-guided "stop when confident" cut tokens 50.80% while raising accuracy 1.10%
  (NeurIPS 2025, "Think or Not?"); a difficulty-aware router cut tokens up to 52.7% with minimal
  quality loss (arXiv:2603.07915, "Ares"); DART raised accuracy up to +22.5pt while cutting
  tokens 51–63% (arXiv:2606.23181).
- Scalarized (weighted-sum) objectives are measurably worse than keeping axes separate:
  Pareto-dominance beat scalarization on Hypervolume with far less cross-setting variance,
  because scalarization is brittle to metric-scale changes (ParetoPrompt, ICLR 2025, OpenReview
  HGCk5aaSvE).
- Decision locked 2026-07-03 in the piflow planning session after a two-lane evidence sweep (the
  two research annex files ARE that sweep).

## Anti-patterns
- A single fused `quality*w1 + efficiency*w2` accept score — brittle to metric-scale changes and
  hides which axis actually failed.
- Treating a green-but-over-budget run as "done" because task quality passed — the budget breach
  is an unaddressed defect, not a rounding error.
- Requiring an efficiency-motivated edit to improve EVERY metric before landing — that's a
  disguised scalarization; only the targeted metric needs to improve, quality only needs to hold.
- Baking a quality floor into the generation/search objective itself instead of the accept gate —
  over-constrains exploration; let generation prefer efficient candidates, gate on quality after.

## Applications
- 2026-07-03 · piflow · objective shape locked from the two-lane evidence sweep → adopted; gate extension + budget declarations not yet implemented · ref: this library research/ annex.

## See also
[[budgets-as-defects]] · [[outcome-gated-accept]] · [[overthinking-and-thinking-caps]] · [[parallel-variants-over-longer-thinking]]
