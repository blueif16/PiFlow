---
key: tool-call-efficiency
title: Tool thrash predicts failure; tripwire it, do not tolerate it
domain: execution
status: proven
description: Reach for this when a run repeats calls, burns calls with zero progress, or over-searches — wire deterministic tripwires; don't rely on judgment to notice.
aliases: [tool loop, tool thrash, repeated tool calls, no-progress budget, over-search, tool-call ceiling, meta-tool, tool-call tripwire, watchdog, no-edit budget, dependency rabbit hole]
tags: [execution, tool-calls, tripwire, watchdog, efficiency]
updated: 2026-07-03
---

# Tool thrash predicts failure; tripwire it, do not tolerate it

## Trigger
- A trajectory repeats the same tool call, or a short call sequence, several times in a row with
  no new information gained.
- A candidate/fixer agent has burned many tool calls with zero file edits or zero verifiable
  task-relevant progress.
- An agent keeps reading into dependency/vendor/library code instead of returning to its own target.
- Total tool calls for a task run far past what the task's difficulty should require, and nothing
  bounds or flags it.
- A run gets killed only at an arbitrary wall-clock backstop, because no call-based signal caught
  the thrash earlier.

## Practice
1. Treat repeated tool-sequence length as a LEADING failure predictor, not a cosmetic quirk —
   successful runs consistently use fewer steps than failed ones. Tripwire it in two stages: WARN
   at 2 consecutive repeats of the same call/sequence, ABORT/CRITICAL at 3.
2. Set a no-progress budget — N tool calls with zero edits or zero verifiable progress — as a hard
   abort, not a soft warning. Tune N from observed behavior; a blind wall-clock backstop is not a
   substitute — it lets a stuck agent burn the whole allotted time before anything fires.
3. Set a dependency-rabbit-hole budget: a small, single-digit cap on reads into dependency/vendor
   code before the agent must return to its own target — a distinct, checkable class, not a
   generic "too many reads" number.
4. Set a per-task tool-call ceiling independent of the other triggers, to catch diffuse thrash that
   no single repeated pattern or dependency detour explains.
5. Run all four as a DETERMINISTIC REFLEX that fires unconditionally and first, before any
   judgment layer. A supervising agent reads the tripwire's typed reason off the event stream and
   decides the next action (rerun with one changed variable, nudge, escalate) — it never
   re-implements the threshold logic in prose, and never waits on its own judgment to catch what
   the reflex must catch immediately.
6. A tripwire may abort a DISPOSABLE or off-critical-path agent (a candidate/fixer copy, a control
   node) mid-stream, SIGTERM and all — that is exactly when a mid-run kill is safe. It must NOT
   abort a live producer mid-run; queue the same signal to the next node boundary instead. Every
   abort must carry a TYPED reason (which tripwire, on what evidence) — never a bare kill — so the
   next layer can choose rerun-with-a-steer over a blind identical retry.
7. Where the redundancy is systemic rather than one run's runaway, remove it at the source instead
   of only capping it: compile repeated call sequences into a reusable meta-tool, or suppress a
   call a lightweight necessity check already flags as unneeded. Both cut call volume WHILE
   raising success — a genuine double win, not a quality-for-cost trade — so prefer source-removal
   over capping alone once the same redundancy recurs across runs.
8. Track over-search (calls made vs. what a minimal solve needs) as its own diagnostic, separate
   from raw call count — a trajectory can look call-cheap in absolute terms yet still be wildly
   over-search relative to the task, and the two symptoms call for different fixes (a ceiling vs a
   meta-tool/suppression).

## Evidence
- A repeated tool-sequence of length ≥10 ≈ 89% trajectory-failure probability; resolved
  trajectories average fewer steps (24.9–25.6) than unresolved; a weaker model shows the pattern in
  >25% of trajectories vs <4% for Claude 3.7 Sonnet on the same scaffold. → SWE-smith,
  arXiv:2504.21798, NeurIPS 2025.
- Agents over-search ~22× more functions than a minimal solve needs; the diagnostic is actionable
  (+2.2–4.6pp accuracy, −20–31% cost). → TRAJEVAL, arXiv:2603.24631, 2026.
- Outcome-only RL drives tool-call turns 2.2→6.8 with no matching benefit; a knowledge-aware fix
  cuts over-use 82.8% while improving accuracy 3%. → "The Tool-Overuse Illusion," arXiv:2604.19749,
  2026.
- A necessity probe (AUROC 0.89–0.96) predicts unneeded calls; suppressing them cuts calls 48% at
  1.7% accuracy cost, and −20–56% API calls on Search-o1 with no loss. → arXiv:2605.09252, 2026
  (verified directly).
- Compiling redundant sequences into meta-tools cuts calls 5.6–11.9% WHILE raising success up to
  4.2pp. → arXiv:2601.22037, 2026.
- Zero tool calls drops accuracy 81.3%→66.7%; fewer call turns correlates with higher accuracy, not
  worse. → "Scaling Agents via Continual Pre-training," arXiv:2509.13310, 2025.
- Unchecked tool storms burn $50–200/10min, one retry runaway spiked cost 1,700%; shipped
  production tripwires cap ~10–15 calls/task. → Towards Data Science, 2025 (practitioner report).
- game-omni's watchdog (`noEditToolBudget=22`, `depReadBudget=3`) was tuned only after a live fixer
  ran 40 tool-calls/0 edits to a blind ~600s backstop. → piflow-overlord SKILL.md, 2026-07.

## Anti-patterns
- A blind wall-clock backstop instead of a call-based signal — the whole budget is gone by the
  time it trips.
- Killing a live producer mid-run off the same tripwire that safely kills a disposable candidate.
- Aborting with no typed reason — the next layer can't choose rerun-with-a-steer from escalate.
- Capping call volume without removing the systemic redundancy — the pattern re-trips forever.

## Applications
- 2026-07-02 · game-omni · behavioural watchdog (no-progress 22, dep-rabbit-hole 3) wired into the fixer binding → corrupting candidates now abort with a typed reason instead of burning the full backstop · ref: game-omni packages/verify/optimize/binding-live.mjs.

## See also
[[budgets-as-defects]] · [[retry-escalation-ladder]] · [[context-composition]]
