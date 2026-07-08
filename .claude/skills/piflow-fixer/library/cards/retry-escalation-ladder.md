---
key: retry-escalation-ladder
title: Bounded retries, one variable changed, exhaust the ladder before giving up
domain: execution
status: adopted
description: A failure gets retried blindly/identically, or an agent settles/escalates too soon — classify first, bound retries, change one variable, exhaust the ladder.
aliases: [retry, retry budget, escalation ladder, bounded retry, identical rerun, give up early, premature surrender, nudge, diagnosing forever, non-retryable error]
tags: [execution, retries, escalation, budgets, supervision]
updated: 2026-07-06
---

# Bounded retries, one variable changed, exhaust the ladder before giving up

## Trigger
- A call/node just failed and the reflex is "try again" with no check on whether the error class is
  even retryable.
- A retry log shows the SAME input/prompt/args as the previous failed attempt — nothing changed.
- A trace shows tool-calls climbing while edits/commits sit at zero — the agent is diagnosing, not acting.
- Work is escalated to a human on the first failure, with no steer/research/alternative attempted, or
  with no evidence attached ("I'm stuck" instead of the failing artifact).
- An agent settles for a degraded/poor output rather than pushing through the remaining ladder rungs.

## Practice
1. **Classify before retrying at all.** Decide whether the failure is retryable (transient: rate-limit,
   timeout, flaky tool/network) or non-retryable (wrong approach, missing capability, malformed request,
   permission/auth). Retrying a non-retryable error burns budget for zero yield — most real-world retries
   are exactly this waste, so classification is the single highest-leverage step, before any retry logic.
2. **Bound retries to a small fixed number (~3 per call, ~2 replans per turn), then stop and move up the
   ladder.** A retry count is not itself an escalation path — once the bound is hit, the next rung fires,
   not a 4th identical attempt.
3. **Never repeat an attempt identically.** Every retry must change exactly ONE variable versus the prior
   attempt: a budget/timeout, injected evidence (an error log, stack trace, new observation), or an
   explicit steer. If there is nothing left to change, that itself is the signal to stop retrying and
   escalate — not to run the same thing again "to see if it works this time." This applies to an
   edit-tool anchor too: two identical validation failures on the SAME anchor means change the anchor
   text itself, never resubmit the identical call a third time (observed: 3 byte-identical resubmits of
   a mangled payload).
4. **Exhaust the full ladder before handing off to a human, in order:** (a) retry once more with a sharp
   steer, (b) research the problem yourself — read the docs, search the web, inspect the failing artifact
   — rather than guessing again, (c) if research doesn't resolve it, generate and attempt at least one
   genuinely alternative approach, not a repeat of the failed one, (d) only then escalate, and escalate
   WITH evidence (the failing artifact/log/diff attached) — never with just a claim of being stuck.
   Skipping a rung to escalate early is a policy violation, not a shortcut.
5. **Detect the opposite failure mode and correct it differently.** An agent that keeps diagnosing without
   ever committing a fix (tool-calls rising, edits staying at zero) is not stuck for lack of budget — it
   does not get more retries or more turns. It gets a NUDGE: force a commit ("the fix is at X — edit
   now"), because the fix is already found and the agent just won't act on it.
6. **Treat "settled for it" as equal in severity to "looped forever."** Accepting a poor/degenerate output,
   or escalating before climbing the ladder, is exactly as much a defect as an unbounded retry loop —
   verify the ladder was actually climbed (each rung attempted, in order) before accepting an escalation
   as legitimate, rather than taking "I tried" at face value.

## Evidence
- 90.8% of retries in a 200-task benchmark were spent on non-retryable errors — classification before
  retrying is the highest-leverage fix, not a nicety (tianpan.co, 2026-04).
- The bounded-recovery consensus across studied agent systems: ~3 retries per call, ~2 replans per turn,
  then escalate — the numeric anchor for "bounded," not "until it works" (tianpan.co, 2026-04).
- The bounded-persistence half is already deterministic, shipped code, not just an agent habit: a
  failure-class retry ladder with an `escalate.after` bound (`runNodeWithRetries`) — proof this is
  buildable, not aspirational (piflow-overlord SKILL.md, `retry.ts`).
- The diagnosing-forever mode is observed directly: a fixer ran 40 tool-calls with 0 edits before a
  no-progress watchdog existed for it; the tuned default now trips that watchdog at 22 tool-calls / 0
  edits, with a NUDGE-resume as the follow-up move, not the watchdog's own action (piflow-overlord
  SKILL.md, game-omni M3 case).

## Anti-patterns
- Retrying with byte-identical input/prompt "to see if it works this time."
- Escalating to a human on the very first failure, with no steer, research, or alternative attempted.
- Giving a diagnosing-forever agent more budget/turns/retries instead of a NUDGE to commit.
- Quietly accepting a degraded/poor output as "good enough" rather than climbing the remaining rungs.
- Escalating with only a claim of being stuck and no failing artifact/log/diff attached as evidence.

## Applications
- 2026-07-03 · piflow/game-omni · bounded retry + escalation ladder shipped in the runner (failure-class ladder) → the never-give-up half remains supervisor policy, enforced manually, not yet automated · piflow runner retry.ts + overlord skill.

## See also
[[supervision-and-wake-policies]] · [[tool-call-efficiency]] · [[loop-control-invariants]]
