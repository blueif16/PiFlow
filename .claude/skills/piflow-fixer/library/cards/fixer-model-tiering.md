---
key: fixer-model-tiering
title: The deepest tier is not the best fixer — route by job, verify by edits landed
domain: execution
status: proven
description: Reach for this when picking/auditing a fixer's model tier, or a deep-tier fixer diagnoses well but never commits an edit.
aliases: [fixer tier, model tiering, deep tier, opus fixer, model routing, tier default, over-deliberation, edits landed, commit rate]
tags: [execution, fixer, model-routing, tiering, verification]
updated: 2026-07-03
---

# The deepest tier is not the best fixer — route by job, verify by edits landed

## Trigger
- A fixer/editor loop keeps producing long, articulate diagnoses across repeated runs but the
  diff stays empty — nothing gets committed.
- A model-tier default was set to "deepest available" on the assumption that more reasoning
  capacity means a better fix, with no measurement of edits actually landed.
- Budget/prompt tweaks are being tried repeatedly against a stuck fixer instead of questioning
  the tier itself.
- A config/default audit has not been re-run since the last tier finding — the known-bad default
  may have silently reasserted itself.

## Practice
1. **Route by job shape, never by "biggest model available."** For a bounded, edit-committing
   job — apply a scoped fix, land a patch, close a well-specified gap — route to a mid tier that
   reliably acts. Reserve the deepest/frontier tier for genuinely open-ended, hardest-reasoning
   work (root-causing an unfamiliar failure class, redesigning a subgraph) where the extra
   deliberation has room to pay off. Never default a fixer to the deepest tier as a blanket
   choice; that default must be an explicit, job-justified pick, not a heuristic that "more
   reasoning is strictly better."
2. **Treat a heterogeneous, role-matched fleet as the target shape, not a single "best" model
   run everywhere.** Pair each role (bulk edit-commit vs. hardest-reasoning triage) with the
   tier/model that role rewards; a joint choice of model + strategy per role beats deploying the
   single highest-rated model uniformly, on both accuracy and cost. Re-derive the per-role best
   tier per job class — the best tier for one role is not the best tier for another.
3. **Verify a tier choice by edits landed / gate accepts — never by the eloquence or apparent
   thoroughness of its diagnosis.** A fixer that writes a compelling root-cause analysis and
   commits nothing has failed the job regardless of how sound the analysis reads. Track, per
   tier: attempts run, edits committed, gate-accept rate. A tier with a near-zero commit rate is
   disqualified for that job even if its per-attempt reasoning quality looks superior.
4. **When a tier under-delivers on a job, swap the tier before touching the prompt or the
   budget.** Exhausting every prompt/budget lever against a fixer that still commits nothing is a
   signal the tier itself is mismatched to the job, not that the prompt needs another pass.
5. **Audit the configured default on a cadence, independent of whether the finding "feels"
   settled.** A tier finding that lives only in a run log or a memory note does not change the
   product's actual default; explicitly check the deployed config against the finding and correct
   it. A known-bad default left unfixed is an under-delivery of the feedback loop, not of the
   underlying practice — record it as such and re-close it.

## Evidence
- Jointly routing model choice + reasoning strategy beats the single best model on BOTH accuracy
  and token cost (>60% fewer tokens at higher accuracy). → "Route to Reason," arXiv:2505.19435,
  2025.
- Heterogeneous, role-matched model assignment occupies the cost-accuracy Pareto frontier that
  homogeneous single-model teams do not reach, with pairwise synergy up to +44% when each model
  fills its better role; the per-role best model differs from the per-task best model in 4 of 5
  benchmarks. → "Specialize Roles, Mix Deployments," arXiv:2606.20629, 2026 (cited via piflow
  `docs/research/2026-06-27-expert-representations-worker-types.md`).
- Raising a model's own "reasoning effort" knob monotonically LOWERED accuracy for several 2026
  frontier models on research tasks (GPT-5 low/med/high = 49.6/48.6/48.1%; Gemini 3 Flash
  low/high = 49.9/47.9%); only one of the tested frontier models improved with more effort.
  → FutureSearch blog, 2026, Deep Research Bench (blog-level; cited via
  `research/2026-07-03-external-objective-shape-evidence.md` Q1.7).
- Directly measured, live: a deep/frontier-tier fixer ran 6 fix attempts across every budget and
  prompt lever tried and committed 0 edits; the same job re-run on a mid tier committed edits and
  landed the run's only gate ACCEPT (+0.1 score). → game-omni, `GAME_OMNI_FIXER_MODEL` runs,
  `runs/run01` staging manifest, 2026-07-02 (FACTS block).
- A subsequent config audit found the product's configured fixer default still resolved to the
  known-bad deep tier despite the above finding — the finding had not been folded back into the
  default. → game-omni, `~/.piflow/model-tiers.json` audit, 2026-07-03 (FACTS block).

## Anti-patterns
- Assuming "deepest tier available" is a safe default because it can only help — over-deliberation
  can suppress the commit action entirely, not just add latency (see [[overthinking-and-thinking-caps]]).
- Judging a stuck fixer by re-reading its diagnosis for quality instead of counting edits landed.
- Burning repeated budget/prompt tuning cycles against a tier mismatch instead of swapping tiers.
- Recording a tier finding in a run log or memory note and treating that as equivalent to fixing
  the deployed default.

## Applications
- 2026-07-02 · game-omni · fixer re-run on Sonnet tier after 6×0-edit opus runs → edits committed + the only gate ACCEPT landed (+0.1) · ref: GAME_OMNI_FIXER_MODEL runs, runs/run01 staging manifest
- 2026-07-03 · game-omni · default audit → deep→opus still the configured fixer default despite the finding (under-delivery of the feedback loop, not of the practice) · ref: ~/.piflow/model-tiers.json audit

## See also
[[overthinking-and-thinking-caps]] · [[parallel-variants-over-longer-thinking]] · [[skill-system-construction]]
