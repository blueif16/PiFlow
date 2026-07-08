---
key: supervision-and-wake-policies
title: Supervise as an event-woken sentinel enforcing a standing policy
domain: supervision
status: adopted
description: A human keeps babysitting a stream or re-judging runs by hand — replace it with an event-woken sentinel enforcing one written policy.
aliases: [wake policy, event-woken, sentinel, control plane, supervisor, babysitting a stream, intervention seam, wake seam, decision record, standing policy, automated human]
tags: [supervision, control-plane, wake-policy, judgment, gating]
updated: 2026-07-03
---

# Supervise as an event-woken sentinel enforcing a standing policy

## Trigger
- A human is watching a run/loop stream live and re-deciding the same calls each session ("did this
  actually finish", "should I kill it", "is this good enough") instead of a policy deciding once.
- A supervisor sits in a blocking loop over every stream event instead of being invoked only when
  something is owed judgment.
- A process is killed or steered mid-execution on the critical path, risking corruption of a live,
  non-disposable unit.
- A supervisor re-implements a timeout / retry-count / budget check in prose instead of reading a
  deterministic verdict the system already emits.
- A decision is made from a node's or agent's own claim of success/completion rather than an artifact,
  log, or gate verdict.

## Practice
1. **Model supervision as an event-woken sentinel, never a stream reader.** Do not hold a live
   subscription open turn after turn "babysitting" it — a deterministic reflex layer already consumes
   every event and reacts to what it can react to (retry, timeout, kill). The supervisor runs ONE cycle
   per invocation — woken → adjudicate a one-shot digest → act → sleep — and otherwise does not exist.
2. **Write the wake condition as a declarative policy, not ad hoc judgment.** Define a disjunction of
   typed predicates over fields the event stream already exposes (status, anomaly kind, terminal-event
   kind). The policy adds no detection logic of its own — it only decides which of the reflex's
   already-detected events deserve judgment. Keep it closed-vocabulary: a predicate over existing
   fields/thresholds, never free-form code, so it stays auditable and cannot silently diverge from what
   the reflex actually emits.
3. **Separate WAKE from ACT, and grain the policy by what you can safely touch.** Being woken is cheap
   and should fire on any event that might matter; acting (abort, steer, replace) is not, so gate it on
   the target's disposability. For a live, non-disposable, critical-path unit register a COARSE
   wake-policy — wake only on terminal/blocking states and anomalies — and queue any action to the next
   safe boundary, never mid-flight. For a disposable, off-critical-path candidate (nothing depends on it
   surviving) register a FINE wake-policy — every decision-grade boundary is a legal wake-AND-act point,
   since acting immediately there costs nothing and the wake point and the act point coincide. Before any
   immediate kill or steer, confirm the target really is off the critical path; if it is not, hold the
   action for the boundary instead.
4. **Delegate every deterministic bound to code; keep only judgment for yourself.** Timeouts, retry
   counts and their ladder, budgets (edits/tokens/rounds), and hard ceilings must be enforced by code
   that fires without you — read its verdict as a signal, never re-derive it in prose. Reserve yourself
   for calls that need judgment: is this converging, should one variable change, is this the same defect
   recurring, is this architectural, should this land. Keep your decision vocabulary a small closed set —
   continue, abort, rerun-with-one-change, nudge, escalate, land — never a bespoke action invented in
   the moment.
5. **Emit one record per decision, and verify before you write it.** Every decision names: the exact
   observable signal that triggered it (quoted, not paraphrased), desired vs observed state, the
   decision itself, the action taken (or "none — observing"), and what artifact/log/verdict you checked
   it against. A node's or agent's own claim of success or completion is never sufficient evidence on
   its own — check the artifact, log, or gate verdict it actually produced.
6. **Author the standing policy as the automated human; handle only the residual.** Everything a human
   currently re-explains every session — the objectives, the intolerable behaviors, "never retry
   identically," "never settle for a degraded result," "never tear down a disposable multi-round loop
   over one routine rejection" — gets written ONCE into this policy (the wake predicates, the closed
   decision table, the delegated bounds) instead of repeated as live commentary. The human's residual job
   is authoring and revising that policy and receiving the escalations it produces, not re-judging every
   run by hand.

## Evidence
- A fixer ran **40** tool-calls with **0** edits before a no-progress reflex existed to catch it; the
  tuned default now trips that same reflex at **22** tool-calls / 0 edits, and a rabbit-hole reflex trips
  at a default **3**-read threshold — both are deterministic bounds the sentinel reads, not re-derives
  (piflow-overlord SKILL.md, worked M3 case). Their grounding: plan-violation/stagnation detection at
  "≥N steps, 0 edits" (arXiv 2512.02393) and separate-evaluator course-correction (arXiv 2509.02360),
  cited so the threshold is a tunable default, never an invented magic number.
- Autonomous self-editing loops measured **+0.0pp** net gain across rounds when bounded only by round
  count with no accept/reject gate — round count alone is not a safety mechanism, which is exactly why
  judgment, not iteration count, must decide accept/reject and escalation (piflow-memory-v1.5.md §6,
  "Library-Drift").

## Anti-patterns
- Sitting in a blocking loop over every stream event instead of waking on a policy match.
- Killing or steering a live, non-disposable unit mid-flight instead of at the next safe boundary.
- Re-implementing a timeout/retry/budget check in prose instead of reading the deterministic verdict.
- Treating a node's or agent's own "done"/"fixed" claim as evidence.
- Tearing down a disposable multi-round loop over one routine rejection instead of adjudicating in-band
  and letting it continue.
- Letting round count alone stand in for a safety bound.

## Applications
- 2026-07-02 · game-omni · the M3 fixer case run manually per the contract (observe stream → tune watchdog → rerun with one variable → gate verdict) → the loop the policy will automate · ref: piflow-overlord SKILL.md worked example.

## See also
[[retry-escalation-ladder]] · [[budgets-as-defects]] · [[outcome-gated-accept]]
