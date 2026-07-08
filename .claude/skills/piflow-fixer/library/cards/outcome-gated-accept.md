---
key: outcome-gated-accept
title: The across-run accept gate — candidate copy, held-out score, strict improvement
domain: loops
status: proven
description: Use before any self-editing loop auto-lands a change — gate on a held-out score with strict improvement, never let round count alone be the safety.
aliases: [accept gate, held-out gate, outcome gate, strict-improvement gate, candidate copy, VAL slice, auto-adopt, staging manifest, self-editing drift]
tags: [self-improvement, gating, evaluation, staging, drift-prevention]
updated: 2026-07-03
---

# The across-run accept gate — candidate copy, held-out score, strict improvement

## Trigger
- A loop lets an agent edit its own prompt/skill/config/code across runs (a "self-improvement" or "sleep" cycle).
- You're about to test an edit against the same data it was derived from, or against the live file itself.
- An edit "looks better" by inspection/judge opinion but nothing measured it against a baseline.
- Round count (N iterations) is the only thing described as bounding the loop.
- An edit is about to auto-land with no explicit staging/adopt step.

## Practice
1. **Never trust round count as safety.** Autonomous self-editing with no outcome gate measurably drifts to
   ≈0 net gain even after many rounds — bounding by iteration count alone does not prevent regression. The
   accept/reject gate, not the loop's size, is what keeps the system from drifting.
2. **Edit a CANDIDATE COPY, never the live artifact.** Apply every proposed edit to a duplicate of the
   prompt/skill/config/code under test. Only the candidate is scored. On reject, discard the candidate and
   fall back to the unedited original — the live artifact is never touched mid-evaluation.
3. **Score the candidate on a held-out VAL slice that is never polluted.** Tag every task/example TRAIN or
   VAL at data-creation time (deterministic split, not ad hoc). Anything mined, replayed, or recalled during
   the loop may only enlarge TRAIN; VAL is fixed and never re-derived from what the loop just saw, and TEST
   (if it exists) must never silently stand in for VAL.
4. **Accept iff the score STRICTLY improves — no ties, no "not worse."** The accept predicate is
   `candidate_score > baseline_score` on VAL, evaluated by deterministic code from a model-produced score —
   the model proposes and measures, code decides. A candidate that merely matches baseline is a reject.
5. **Scale the land policy to blast radius; unmeasurable score never auto-accepts.** A prompt/config edit
   gates on the held-out score alone. A code edit must ADDITIONALLY pass the product's own tests/typecheck/
   build before it is eligible to land — higher blast radius gets a harder gate, not the same one. A
   structural/architectural change (rewires a contract, crosses a component boundary) always stages for an
   explicit human yes regardless of score. If the artifact has no checkable outcome and only a subjective
   judgment exists, that judgment alone must never auto-accept — route it to the human-review path instead.
6. **Land = write a staging manifest, not a live overwrite.** Every accepted candidate is written to a
   staging location with a manifest describing what changed and why, backing up what it would replace.
   Auto-adopt (staged → live with no human step) is a per-target policy flag, defaulting OFF; it may only
   fire when the gate accepted AND that policy is explicitly enabled for that target. Everything else waits
   for an explicit human adopt step.

## Evidence
- Autonomous self-editing without a curation/outcome gate measured **≈+0.0pp** net gain across rounds
  (Library-Drift finding, cited in `piflow-memory-v1.5.md` §6) — the round-count-only framing is unsafe.
- `skillopt_sleep`'s gate predicate is exactly `cand_score > current_score` (`skillopt_sleep/gate.py:43`,
  vendored from `evaluation/gate.py:123`; cited in `vendor-skillopt-mastra-2026-06-29.md` §6 and
  `skillopt-sleep-loop-control-2026-06-29.md` §2); candidates are produced from `apply_edits` on a copy,
  never the live doc (`consolidate.py:112-134`).
- Default held-out fraction is **`val_fraction=0.34`**, `test_fraction=0.0` — VAL is never used as TEST and
  is never repopulated from replay/recall, which only enlarges TRAIN (`config.py:35-37`, `dream.py:120-131`,
  cited in `skillopt-sleep-loop-control-2026-06-29.md` §2).
- `auto_adopt` defaults to **`False`**; adoption fires only when `accepted AND auto_adopt` is true
  (`cycle.py:286-288`, `config.py:58`, cited in `skillopt-sleep-loop-control-2026-06-29.md` §3) — the
  staging manifest (`staging.py:39-72`) is written regardless, the live-overwrite step is the separate,
  opt-in one.
- Live run01 (2026-07-02): a candidate on a code-touching node ACCEPTED at **+0.1** strict improvement on
  the held-out slice and was staged, not landed live; a separate 0-edit candidate on gs01 was REJECTED
  outright ("no edit applied") — both verdicts read from the staging manifest, not agent self-report
  (see Applications).

## Anti-patterns
- Testing an edit on the same examples that produced it (no TRAIN/VAL split at all).
- Accepting on "no regression detected" or a tie — that is not strict improvement.
- Editing the live prompt/skill/code file in place, then evaluating "in production."
- Letting a subjective judge's opinion alone flip an artifact to accepted with no checkable outcome behind it.
- Treating "we ran N rounds" as evidence of safety instead of evidence of budget consumed.

## Applications
- 2026-07-02 · game-omni · full FIX→GATE→LAND pass on w4-execute-m3 → 1 ACCEPT staged (+0.1 strict improvement), prior 0-edit candidate correctly rejected · ref: runs/run01 + runs/gs01 optimize/staging/manifest.json.

## See also
[[loop-control-invariants]] · [[four-way-triage]] · [[scoring-cascade]]
