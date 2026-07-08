---
key: loop-control-invariants
title: Control invariants for autonomous improvement loops
domain: loops
status: adopted
description: Building/reviewing a self-editing optimize loop — bound it with caps, condition early-stop, a breaker, and delta memory, not just a round count.
aliases: [self-editing loop, optimize loop, sleep loop, autonomous edit loop, edit budget, circuit breaker, early stop, rejected edit buffer, learning rate cap]
tags: [loops, safety, memory, bounding]
updated: 2026-07-03
---

# Control invariants for autonomous improvement loops

## Trigger
- You are designing or reviewing a loop where a model proposes edits to its own prompt/skill/config/code
  across rounds, unattended.
- The only stated bound is "it runs for N rounds" — no other cap, stop condition, or runaway guard exists.
- Memory/context consolidation between rounds is a full rewrite/re-summary rather than discrete deltas.
- A rejected edit gets re-proposed in a later round because nothing recorded that it already failed.

## Practice
1. **Split proposer from decider — never let the model close its own loop.** The model PROPOSES edits and
   SCORES candidates; deterministic code DECIDES accept/reject, enforces every bound below, and performs the
   LAND (commit/stage). The control-flow driver itself must be plain, straight-line code with no LLM call in
   the sequencing path — only the inner stages it calls may be model-driven. Never let the model itself decide
   when to stop, what counts as "improved," or write the live file directly.
2. **Cap more than the round count.** A round-count ceiling alone is a budget, not a safety mechanism. Set hard
   per-round caps up front: an **edit budget** (max edits landed per round — the "learning rate"; keep it a low
   single digit so one bad round can't compound), a **token/spend budget**, and a **lookback window** (each
   round sees only data since the last one — never re-scan the whole history). All caps trip cleanly, not silently.
3. **Stop on a condition, not only the ceiling.** Every round, check **converged** (nothing left to fix → stop,
   success) and **stalled** (K consecutive rounds with zero accepted edits → stop, escalate to a human, don't
   grind to the ceiling on dead rounds — pick K explicitly). The round-count ceiling remains the outer bound if
   neither condition fires.
4. **Add a circuit breaker independent of the per-round caps.** A trip wire fires mid-run on an anomalous
   trajectory (error rate, spend, or spend rate over threshold) — separate from a per-round budget exhausting
   normally. Once tripped, halt and resume ONLY on a deliberate, logged human re-authorization — never on a
   timer or retry.
5. **Gate the accept decision on a held-out score, on a candidate copy, never the live artifact.** Apply the
   edit to a copy, replay/re-score it on a held-out slice untouched by the proposal step, accept only if the
   score strictly beats the pre-edit baseline; reject falls back to the untouched original.
6. **Update memory as incremental deltas, never a full rewrite.** Each round's memory update appends, edits, or
   retires discrete entries under a fixed cap — never regenerates the whole file as a fresh summary.
   Full-rewrite consolidation under pressure is a measured failure mode (context collapse, see Evidence); prefer
   discrete deltas plus a periodic, separate compaction pass that retires lowest-value entries.
7. **Persist rejected edits as a first-class negative-feedback record.** Every rejected candidate is written
   where the next round's proposal step reads it before generating new candidates, so a dead edit is never
   re-proposed — treat this buffer as loop state, not a discardable log line.
8. **Verify the invariants held.** After a run, confirm: zero direct live-file writes outside LAND, every
   accepted edit has a held-out score strictly above baseline, no round exceeded its caps, and any
   stall/converge/breaker event is logged with its trigger reason.

## Evidence
- The model-proposes/code-decides split, gate-on-candidate-copy, and hard per-round caps (edit budget = 4 as
  the "textual learning rate," token budget, lookback window) are the working control structure of a shipped
  night-orchestrator loop, cited file:line (`cycle.py:90`, `gate.py:43-50`, `consolidate.py:112-134,222`,
  `config.py:31,43`) — skillopt-sleep-loop-control-2026-06-29.md.
- That same system has **no** condition-based early-stop or patience mechanism (grep for
  `early.?stop|patience|no_improve` hit nothing but a docstring analogy) — it bounds purely by round count and
  hard caps — skillopt-sleep-loop-control-2026-06-29.md §4.
- Every 2026 flagship loop (OpenAI Codex `/goal`, the Ralph loop, GEPA's Pareto-accept) instead terminates on a
  **verifiable condition** ("done" or "stalled/blocked"), with a separate checker grading completion each turn
  — the gap this card's early-stop rule closes — eval-codex-goalmode-loop-patterns-2026-06.md §3 (P7 contrast).
- Full-rewrite memory consolidation measurably collapses context: one case study went from 18,282 tokens at
  66.7% accuracy to 122 tokens at 57.1% accuracy in a single rewrite step (ACE, arXiv 2510.04618) —
  eval-codex-goalmode-loop-patterns-2026-06.md §2 (P6).
- Rejected edits are written into the human-facing report as explicit negative feedback so they aren't
  re-proposed, and within an epoch the rejected-edit buffer plus its score delta is fed back into the next
  proposal's context verbatim — skillopt-sleep-loop-control-2026-06-29.md §5.
- LoopRails' circuit breaker trips server-side on error-rate/spend/spend-rate/action-volume and resumes only on
  deliberate logged human re-authorization — the runaway guard a multi-hour autonomous loop otherwise lacks —
  eval-codex-goalmode-loop-patterns-2026-06.md §2 (P9).
- A single-incumbent strict-improvement ratchet (accept iff the scalar improves, keep exactly one incumbent)
  is the documented local-optimum failure mode both GEPA and AlphaEvolve independently abandoned; it is
  distinct from — and does not excuse skipping — this card's convergence/stall/breaker bounds
  (eval-codex-goalmode-loop-patterns-2026-06.md §3–4).

## Anti-patterns
- Treating the round-count ceiling as the loop's only safety property ("it'll stop eventually") instead of an
  outer bound layered on top of caps + condition-based stops.
- Letting the model itself decide when the loop is "done" or mark its own work complete/landed.
- Re-summarizing the whole memory file each round "to keep it small" instead of retiring discrete entries.
- Silently dropping rejected candidates instead of recording them where the next proposal step reads them.
- Auto-resuming a tripped circuit breaker on a timer or retry rather than a logged human re-authorization.

## Applications
- 2026-07-01 · piflow · invariants implemented as runOptimizeLoop (thin deterministic driver, injected stages, early-stop + breaker) → shipped, mutation-verified · ref: piflow optimize/loop.ts

## See also
[[outcome-gated-accept]] · [[memory-recording-policy]] · [[retry-escalation-ladder]]
