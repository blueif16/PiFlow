---
key: budgets-as-defects
title: Declared budgets turn "never satisfied" into typed defects
domain: objectives
status: candidate
description: Reach for this when a green run is slow/costly and unrecorded, or killed for an undeclared "too long" — declare budgets that file defects, never grades.
aliases: [budget, ceiling, wall-clock ceiling, token ceiling, context-fill budget, tool-call budget, edit budget, learning rate, stalled misdiagnosis, efficiency defect]
tags: [objectives, budgets, efficiency, disqualifier, optimizer-bounds]
updated: 2026-07-03
---

# Declared budgets turn "never satisfied" into typed defects

## Trigger
- A run is scored/graded "good" yet burned an outlier amount of wall-clock, tokens, context, or
  tool calls versus peer units — and nothing records that fact anywhere.
- A unit gets killed or flagged "stalled/hung/runaway" mid-execution with no declared threshold
  it actually crossed — the kill time was picked ad hoc.
- The same efficiency complaint ("too slow", "too expensive", "too much context") recurs across
  review cycles because it lives only in a human's memory, not in config.
- An optimizer/fixer loop's OWN edit count or token spend is unbounded across rounds.
- Cost/time/context/tool-call telemetry exists and is displayed, but nothing ever turns a bad
  reading into a work item.

## Practice
1. **Declare an explicit intolerance per cost axis, as config on the unit — never tribal
   knowledge.** Minimum set: wall-clock ceiling, output-token ceiling, context-fill %, tool-call
   count, edit-to-read ratio. Condition the ceiling on the unit's known difficulty/phase (a
   long-but-normal phase gets a higher ceiling than a short one) — a single global number for all
   units mislabels routine variance as a defect.
2. **Wire a breach to the SAME worklist a functional failure uses.** Crossing a declared ceiling
   files a DEFECT even when the run's task-level outcome is green (gate passed, task succeeded).
   This is the mechanism that makes efficiency pressure permanent and self-renewing — once
   declared, no human has to repeat the complaint; every future breach re-raises it automatically.
3. **Never fold a budget into the accept/quality score.** A breach is a RISK TRIGGER (route to
   triage) and, past a harder second ceiling, a DISQUALIFIER (auto-reject/kill) — but never a
   graded dimension of quality. Efficiency is non-monotonic and difficulty-conditioned: less time
   or fewer tokens can mean under-thought exactly as often as more means stuck, so scoring
   "cheaper = better" directly rewards degenerate shortcuts. Keep the two decisions on separate
   axes: the outcome gate decides accept/reject; the budget decides route-to-triage/kill.
4. **Give the optimizer/fixer its own, separate budgets — distinct from the unit it edits.** An
   edit-count ceiling per round bounds how much drift one round may introduce (the loop's
   "learning rate"); a token/spend ceiling bounds the loop's own compute. Enforce both even when
   every budget on the thing being fixed is clean — an unbounded fixer is its own defect class.
5. **Treat "no declared budget" as a distinct, checkable root cause of misdiagnosis.** Before
   labeling a run stalled/hung/runaway, check whether a ceiling was ever declared for that phase.
   If none was declared, the fix is to declare one — not to hard-code an arbitrary kill time and
   not to keep killing the next run at the same arbitrary cut.

## Evidence
- Token-budget non-monotonicity: negative "flip" ratio (right→wrong) dominates past ~7K tokens,
  but the crossover is difficulty-conditioned — ~2K for easy problems vs ~8K for hard ones on the
  same task family, so one fixed ceiling misjudges both ends. → arXiv:2604.10739, 2026 (cited via
  piflow `docs/research/memory/eval-trajectory-process-scoring-2026-06.md`).
- Tool-call/loop budget as a triage trigger, not a grade: same tool+args repeated ≥2× warns,
  ≥3× is critical; cost-efficiency warns at 2× a unit's own historical mean; one unbounded loop
  reached $47k before a breaker existed. → piflow `docs/research/telemetry-observability-2026.md`.
- Optimizer-self budgets are a separate, explicit config in shipped systems: SkillOpt bounds its
  own per-round edit_budget=4 (its "learning rate") plus a token budget and lookback window,
  independent of the target's own thresholds (`config.py:31-43`). → piflow
  `docs/research/memory/piflow-memory-v1.5.md` §6.
- Undeclared-budget misdiagnosis, directly observed: a gameplay node ran 914s (~15 min) with no
  declared ceiling and nothing flagged it as a defect; separately, earlier runs on the same
  workflow were killed at ~4 min as "stalled" while still inside a normal long phase, because no
  ceiling had been declared to tell the difference. → game-omni, 2026-07 session (FACTS block).
- Retry/tool-call budgets as disqualifiers, not grades: 90.8% of retries in a 200-task benchmark
  were spent on non-retryable errors; the corrective is a bounded-recovery ceiling (~3
  retries/call, ~2 replans/turn) that then escalates, rather than scoring retry count itself.
  → tianpan.co, 2026-04 (cited via piflow `eval-trajectory-process-scoring-2026-06.md`).

## Anti-patterns
- Scoring a run lower purely for taking longer/using more tokens — folds a non-monotonic,
  difficulty-conditioned signal into the accept scalar (see [[optimization-objective-shape]]).
- One global wall-clock/token ceiling for every unit regardless of known phase length — manufactures
  false "stalled" defects out of ordinary long phases.
- Silently auto-killing on breach without filing a defect record — loses the efficiency pressure
  the moment the process exits; nothing accumulates for the optimizer to act on next round.
- Bounding the thing being optimized but leaving the optimizer/fixer loop itself unbounded.

## Applications
- (none yet — practice adopted from evidence, no recorded application)

## See also
[[optimization-objective-shape]] · [[supervision-and-wake-policies]] · [[retry-escalation-ladder]]
