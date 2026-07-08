---
key: context-composition
title: Compose context just-in-time; length alone degrades quality
domain: context
status: adopted
description: Reach for this when a prompt/context is growing to "be safe," a critic shares the producer's history, or context% is climbing — before the window is full.
aliases: [context rot, context bloat, JIT context, just-in-time retrieval, pointer not copy, resolve-at-read, clean-context critic, context-fill, advertised unread, partial read, prune tool history]
tags: [context, retrieval, composition, degradation, telemetry]
updated: 2026-07-06
---

# Compose context just-in-time; length alone degrades quality

## Trigger
- A prompt or standing context keeps growing "just in case it's needed" rather than shrinking to
  what the current step actually reads.
- A reference is embedded as an inline copy (pasted section, duplicated doc) instead of a link
  resolved at the moment it's read.
- A critic/reviewer is given the same context window the producer already accumulated, including
  its dead ends and past tool errors.
- Context-fill is only checked against "is the window full," with no earlier threshold, and
  nobody can say which injected files were actually read or how much of a large file was covered.

## Practice
1. **Treat input length itself as a quality defect, not a cost nit.** Longer context degrades
   output even when every added token is relevant and correctly retrieved (no distractors) — budget
   length reduction as a quality lever, not only a spend lever; "we can afford the tokens" is not a
   defense.
2. **Compose just-in-time: pull the slice a step needs at read time, never front-load standing
   context "to be safe."** Assemble the minimal working set per step from a live index/slice store,
   discarding what the step doesn't need — don't carry the prior step's full context forward by
   default.
3. **Reference by pointer, resolve at read time — never embed a copy.** A cross-reference (a
   lesson, a doc section, a code slice) is a link resolved against its live source when consumed,
   never duplicated inline. An embedded copy has no freshness gate to ride: it goes stale silently,
   and stale material fed back in measurably degrades output — worse than omitting it.
4. **Actively prune accumulated raw tool-call/error history, not just old messages.** Past failed
   attempts, retries, and dead-end tool output sitting in context distract the next reasoning step
   even when clearly labeled past — compress or drop resolved error/retry chains once they've
   served their purpose.
5. **Give critics/reviewers a clean context, not the producer's.** A minimally-seeded context for
   the checking step outperforms handing it the producer's full accumulated context — shared
   context carries the producer's blind spots and attention-budget pollution into the check.
   Instantiate the critic fresh; add back only what it specifically needs to verify against.
6. **Make composition changes measurable, not judged by feel.** Instrument what actually reached
   the model versus what was advertised: track injected-but-never-read material
   ("advertised-unread") and how much of each read file was actually covered ("partial read") as a
   causal-measurement signal — without it, a composition edit has no way to show it changed
   anything real.
7. **Score context-fill percentage as a risk zone starting well before the window is full**, not a
   binary "does it fit." Degradation onset is well under 100% fill, and the failure shape shifts as
   fill rises (early: one irrelevant item already hurts; later: position/recency dominates over
   logical placement) — gate on a fill threshold with headroom, not the hard token ceiling.
8. **Bound even a legitimate re-read of the artifact being grown/edited.** Fixed anchors already in
   context from the one read need no reconfirming re-read; re-read the artifact ONLY to ground the
   next grown element in the previous one already on disk, or immediately after a failed edit to see
   the real current text before retrying — never as a blanket "read before every edit" habit (verified:
   re-reads halved once bounded this way).

## Evidence
- Input length alone degrades quality even with retrieval masked to be perfect (irrelevant tokens
  removed): 13.9%–85% accuracy drops across 5 LLMs on math/QA/coding tasks. → Du et al., EMNLP
  2025 Findings.
- Degradation starts well before the window is full; a single distractor already reduces accuracy;
  shuffled haystacks can beat logically-ordered ones; the classic lost-in-the-middle U-shape holds
  only while context is <50% full, then failure instead follows recency/distance-from-end (18
  models). → "Context Rot," Chroma Research, 2025 (U-shape: Veseli et al., 2025, via Chroma).
- Active pruning of accumulated raw tool-output/error history recovers quality and cuts spend:
  22.7% token reduction on SWE-bench Lite (Claude Haiku 4.5), addressing "distraction by irrelevant
  past errors." → "Active Context Compression" (Focus), arXiv:2601.07190, 2026.
- Clean-context review outperforms a critic sharing the producer's context: a reviewer with no
  prior context with the coder catches ~2 bugs/PR (~58% severe), attributed to avoiding
  attention-budget pollution from the producer's accumulated context. → Cognition (cited via
  piflow internal audit of `docs/research/substrate-multiagent-and-runtime-2026-06-21.md`).
- Stale-only retrieval (the failure a pointer+resolve-at-read design prevents) poisons output: up
  to +88 percentage points of obsolete code introduced versus fresh retrieval. → "When Retrieval
  Hurts" (cited via piflow internal audit of `docs/research/sota-verification-2026-06-30.md`).
- Long-context retrieval degrades sharply well short of the advertised window: 11/13 models score
  under 50% of their short-context baseline at 32K tokens. → NoLiMa (cited via piflow internal
  audit of `docs/research/sota-verification-2026-06-30.md`).

## Anti-patterns
- Front-loading everything that might be relevant "to be safe" instead of pulling the needed slice
  when a step actually reads it.
- Embedding a pasted copy of a reference instead of a pointer resolved at read time — the copy has
  no freshness gate and rots invisibly.
- Handing a critic the producer's full accumulated context ("it already saw everything") — this
  collapses the independent-check benefit.
- Judging a composition edit by feel instead of an advertised-unread/partial-read measurement.

## Applications
- 2026-07-01 · piflow · fixer context switched to pointer+resolve-at-read (a lesson's slice link dereferenced to the drift-gated code slice at fix time; embedded-copy design explicitly rejected) → freshness rides the slice gate · ref: piflow DefectScope/enrichCodeMap
- 2026-07-03 · piflow · advertised-unread / partial-read instrument designed as the measurement seam for composition edits → spec landed, not yet run against a live edit · ref: piflow docs/design/context-composition-telemetry.md
- 2026-07-05 · game-omni · kind-collapse fix: enum SEMANTICS surfaced JIT at the decision point (FILL-slot hint + read-chain craft doc, not more skill prose) → seeded rerun rK1 first distribution PASS (75%, correct kinds, compound beats) · ref: game-omni 13bff39. LIBRARY MISS noted: no card owns "surface option semantics at the choice point" — this card was the nearest; candidate new card if it recurs.
- 2026-07-07 · game-omni · w4-execute inject-⊄-readScope: the card's advertised-unread signal correctly
  fingered the defect (prompt+SKILL advertise `{{WORKSPACE}}/templates/genres.json`, readScope jails it →
  p09 `find /` ×11); fix took GRANT over the card-preferred TRIM (landed 8f375e3) — verify INCONCLUSIVE
  across 3 frozen arms (0 hunts everywhere, but no arm ever read genres.json: a fully-BUILT copied run dir
  reads {{RUN}}/src and never resolves runtimeShape, so the hunt condition doesn't reproduce; prior anti-hunt
  fence d34a9a7 present in all arms). LESSON for this card: a frozen verification arm must reproduce the
  FAILURE CONDITION, not just the inputs — seed from the pre-failure stage (post-scaffold, pre-build) + keep
  a no-grant control. TRIM remains the deferred durable fix. LIBRARY MISS confirmed: no card owns
  "inject ⊆ readScope / advertised reads must be inside the sandbox jail". ref: game-omni 8f375e3 + 805a4d3.

## See also
[[three-knowledge-legs]] · [[memory-recording-policy]] · [[tool-call-efficiency]]
