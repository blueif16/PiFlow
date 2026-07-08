---
key: memory-recording-policy
title: Lessons are short current-truth blocks; history lives in git
domain: knowledge
status: proven
description: A lesson/memory file is turning into a hand-appended diary, growing unbounded, or its git-tag pointer convention is unenforced.
aliases: [memory recording policy, lesson format, memory rot, hand-append diary, signature dedupe, recurrence count, cap and retire, git-native memory, memory validator]
tags: [memory, knowledge, self-editing, format-enforcement, git-native]
updated: 2026-07-03
---

# Lessons are short current-truth blocks; history lives in git

## Trigger
- A lesson/memory entry is turning into a multi-paragraph diary ("FIXED → CORRECTION → RE-ENABLED → CORRECTION").
- The same failure signature is about to get a brand-new lesson block instead of updating an existing one.
- A recurrence count was typed by a model from impression rather than computed from traces/git.
- `git log --grep` for a lesson's cited commit-tag convention returns zero hits — the pointer is dead prose.
- A compaction pass is about to summarize the whole memory file, or get injected into a worker's runtime prompt.

## Practice
Treat the memory/lesson store as bounded STANDING STATE, never a log. Enforce all of the following
mechanically (a validator + a compactor that run on every write), not as a prose contract a writer is
trusted to honor:

1. **Fixed shape, hard cap.** Every lesson is exactly: Symptom · a stable Signature · `recurrence: N` ·
   Root (one line) · Prevention (one line) — a few lines, no more. Cap the whole store at a small
   constant; nothing else is allowed to live in it as prose.

2. **Dedupe by signature, never append a sibling.** Derive a stable, controlled-vocabulary signature
   for the incoming failure (the failing check id / error class / artifact field — not free text), then
   look it up against existing lessons: match → UPDATE the existing block (increment `recurrence`,
   sharpen the prevention); no match → APPEND one new lesson with `recurrence: 1`. A repeat failure must
   never create a second block for the same signature.

3. **Recurrence is DERIVED, never hand-incremented.** Compute the count by scanning the run trail
   (traces, prior reports) and the commit log for the signature; a model may write the prose but never
   asserts the number. Nothing matches → recurrence is 0, say so, don't invent a count.

4. **Current-truth only; corrections REWRITE, they don't accumulate.** When a lesson's root or
   prevention goes stale or wrong, rewrite that block in place — never append a dated "CORRECTION"
   paragraph under it. Every write lands in a commit tagged by ONE grep-able convention per unit
   (node/component), so `git log --grep '<tag>'` reconstructs that unit's whole evolution. The file
   holds only the current conclusion; the story lives in commit messages — and only in commits that
   actually carry the tag, or the pointer is decorative.

5. **Cap + retire, never full-rewrite-consolidate.** When the store exceeds its cap, an out-of-band
   compaction pass RETIRES the discrete lowest-value lessons one at a time (age × non-recurrence ×
   already-fixed-in-code) — a delete of individual entries, never an LLM re-summarization of the whole
   file. Full-rewrite consolidation is the single move this practice exists to forbid.

6. **Optimizer-facing only.** Read and written by the out-of-band optimizer/maintainer process only —
   never injected into the worker's own runtime prompt, and never left on a path the worker's own
   context assembly sweeps; a unit that sees its own failure history hedges instead of executing.

7. **Enforce, don't ask.** A rule or a header comment saying "don't hand-append" will not stop a diary
   under deadline pressure — it has already failed once. Ship a validator that rejects a write
   violating shape/cap/dedupe, and a compactor that runs the retire step at the cap boundary; treat a
   dead grep-pointer or an oversized entry as a FAILED check, never a warning a maintainer can ignore.

## Evidence
- Full-rewrite consolidation measurably causes context collapse rather than compression — accuracy fell
  66.7%→57.1% in one step (ACE, arXiv 2510.04618) — why rule 5 forbids re-summarizing the whole file.
- Append/update/retire mirrors an established insight-pool operation set (ADD/EDIT/UPVOTE/DOWNVOTE,
  ExpeL arXiv 2308.10144, where `recurrence` is that scheme's vote weight) and Mem0's ADD/UPDATE/DELETE
  with newer-wins (arXiv 2504.19413) — both incremental-delta, never a bulk rewrite.
- Recalled memory only helps when the new case is >0.8 similar to a past one (GitOfThoughts,
  arXiv 2606.14470) — why dedupe keys on a strict SIGNATURE match, not loose similarity.
- game-omni format audit, 2026-07-03: machine-written lesson blocks held to 5 lines each, but one
  hand-maintained block grew to 5.3KB across 4 sessions of appended FIXED→CORRECTION→RE-ENABLED→
  CORRECTION updates — 88% of its file, breaking its own ~40-line contract by prose alone.
- Same audit: the git-offload pointer convention (grep a commit tag) matched ZERO commits in 5 of 6
  populated files — writers re-embedded raw commit SHAs instead of tagging commits, so the "git holds
  the story" half of the design went unenforced even though the convention itself was correct.

## Anti-patterns
- Appending a dated "CORRECTION" paragraph under a lesson instead of rewriting the block in place.
- Letting a model type a recurrence count from impression rather than a grep/trace-derived one.
- A compaction pass that "cleans up" by LLM-summarizing the whole file — this collapses signal, not size.
- Writing memory onto a path the worker itself reads at runtime "so it learns from its mistakes."
- Trusting a git-tag pointer convention with no grep check that it resolves to real commits.

## Applications
- 2026-07-03 · game-omni · format audit → SDK writer lean (5-line blocks, sig-dedupe, derived recurrence); hand-append diary + dead git pointers are the failure mode; enforcement (not warnings) adopted as the fix · ref: game-omni template memory.md audit
- 2026-07-01 · piflow · cap/retire compactor shipped as delete-not-resummarize (8-lesson cap, lowest-recurrence first) · ref: piflow optimize/compact.ts

## See also
[[three-knowledge-legs]] · [[library-maintenance]] · [[four-way-triage]]
