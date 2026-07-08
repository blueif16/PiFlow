---
key: scoring-cascade
title: Tiered scoring: deterministic first, judgment last, abstain to the human
domain: objectives
status: adopted
description: Use when scoring a run or gating an edit-accept — cascade deterministic checks before any judge, and abstain to a human rather than guess quality.
aliases: [scoring cascade, tiered scoring, accept gate score, quality score design, judge tiering, abstain to human]
tags: [scoring, objectives, judge, abstain, accept-gate]
updated: 2026-07-03
---

# Tiered scoring: deterministic first, judgment last, abstain to the human

## Trigger
- You need an accept/reject signal for an edit and the only candidate signal is a model judging its own or another model's output.
- A run "looks fine" per an LLM judge but there is no checkable outcome behind that verdict.
- A judge is being asked for an absolute score (1–10 / good-bad) instead of a comparison.
- Telemetry (tokens, retries, loop count) is being read directly as a quality grade instead of a pre-filter.
- Work that could not be measured (missing artifact, non-terminal run, broken harness) is about to be scored as low/failing rather than flagged unmeasurable.

## Practice
Score in four tiers, cheapest-and-most-trustworthy first; never let a later tier override an earlier one's verdict, and never collapse "unmeasurable" into a low score at any tier.

**Tier 0 — deterministic trace disqualifier (never a grade).** Before judging quality, scan the raw tool-call/telemetry trace for structural failure patterns: loops (same action repeated), retry storms, ungrounded tool use, runaway or non-monotonic token growth, missing termination. This tier only (a) disqualifies a run as structurally broken and (b) routes blame to the stage/side that owns the failure — it is a pre-filter, not a score. Treat token count / time-spent as a difficulty-conditioned *risk* flag only, never as a positive or negative quality term: the relationship is non-monotonic, so "took longer" is not "worse" or "better" in isolation.

**Tier 1 — checkable outcome (THE accept signal).** For whatever fraction of the artifact is checkable, score it there: tests pass, schema validates, authored checks against a declared behavior, render-and-diff or symbolic grounding for visuals with ground truth. This is deterministic and carries no false confidence — it is what an accept/reject gate keys on. Wherever a checkable outcome exists for a piece of the artifact, it fully replaces judgment for that piece; do not additionally poll a judge to "confirm" a passing check. Only the residual with no checkable outcome proceeds to Tier 2.

**Tier 2 — hardened judgment, residual only.** When nothing is checkable, use judgment but harden it three ways: (a) score pairwise against a golden/reference sample, never an absolute rating — judges rank far more reliably than they score; (b) decompose "is this good?" into an explicit rubric of small, checkable attributes rather than one holistic question; (c) the critic must be a separate model/node from the producer, ideally with grounded evidence to check against — a producer that reviews itself verifies only at its own generation accuracy and cannot see its own blind spot. Tier 2 output feeds reflection and candidate ranking; it never alone accepts an edit.

**Tier 3 — abstain to the human.** Trigger abstention on *consistency*, never on the model's self-reported confidence — verbalized confidence stays near-maximal even on wrong verdicts, so it cannot gate anything. Concretely: run the Tier-2 comparison both ways (A-vs-golden and golden-vs-A); if the verdict flips, ABSTAIN rather than average or pick one. Abstain is a distinct third state, structurally separate from "scored low" or "failed" — route it to a human decision, and never let a downstream fold, average, or gate treat "could not be measured" as equivalent to "measured and bad."

**Fold rule:** combine tiers as `fold(tier0-disqualifier × tier1-value)`, with Tier 2 filling only where Tier 1 is undefined. Tier 3 is not a numeric fold member — it is a routing state that suspends the fold and waits on a human verdict before the edit can accept or reject.

## Evidence
- Deterministic trace checks catch real inefficiency cheaply: agents traverse ~22× more functions than necessary before editing — universal across models (TRAJEVAL, arXiv 2603.24631, 2026).
- Token/time is genuinely non-monotonic, never a grade: negative flips (right→wrong) overtake positive flips beyond ~7K tokens, and the crossover threshold itself is difficulty-dependent (~2K tokens easy vs ~8K hard) (arXiv 2604.10739, ACL Findings 2026).
- A deterministic rule-based verifier beats a learned judge even on the same signal: +6.5% F1 over a verifiable outcome reward, up to +20% over SOTA neural process scorers (VPRM, arXiv 2601.17223, ACL Findings 2026).
- Judges rank far more reliably than they score absolutely: pairwise-vs-golden lifts rank correlation Spearman 0.36→0.86 (GenArena, arXiv 2602.06013), while absolute scoring alone reaches only 32–34% agreement (arXiv 2604.25235).
- Rubric decomposition is the best-evidenced judgment hardener: +17.7 points on JudgeBench (RRD, arXiv 2602.05125); rubric conditioning lifts a 3B verifier from 20.4%→92.8% (Srivastava et al., OpenReview 4jnJjSgQC1).
- Self-reported confidence cannot gate abstention: verbalized confidence saturates near 0.999 (ECE 0.443) even on wrong answers, and logprobs saturate 99.4–100%; the reliable trigger is position-swap consistency instead (Verdi, arXiv 2605.11334; swap-consistency framing, arXiv 2606.18451).
- The abstain-worthy residual is structural, not incidental: ~59% of judge errors are internally consistent yet wrong — invisible to any post-hoc confidence signal (Verdi, arXiv 2605.11334).
- Shipped: piflow's optimize layer implements this as scoreRun's Tier0×Tier1 fold with abstain represented as `null`, so the accept gate can never auto-accept an unmeasured node (piflow optimize/ merge a634f58, 2026-06-30).

## Anti-patterns
- Letting a producer grade its own edit — self-verification checks out at only its own generation accuracy, not the ground truth.
- Asking a judge for an absolute 1–10 score instead of a pairwise-vs-golden comparison.
- Reading token count or latency directly as a quality term ("this run took long, mark it down").
- Coercing "could not measure" into a 0/fail so it silently drags down an average or auto-rejects at the gate.

## Applications
- 2026-06-30 · piflow · cascade implemented as scoreRun Tier0×Tier1 fold with abstain-as-null → gate refuses to auto-accept unmeasured nodes · ref: piflow optimize/ merge a634f58.

## See also
[[judge-reliability]] · [[outcome-gated-accept]] · [[optimization-objective-shape]]
