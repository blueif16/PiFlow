---
key: library-maintenance
title: How this library stays honest — track record in, diaries out
domain: knowledge
status: adopted
description: Adding/editing/applying a card in this library — apply the same defect loop the library teaches to itself.
aliases: [card maintenance, library upkeep, memory rot, index hint, MEMORY.md refresh, applications log, under-delivering card, research annex, lookup miss]
tags: [knowledge, memory, self-improvement, maintenance]
updated: 2026-07-03
---

# How this library stays honest — track record in, diaries out

## Trigger
- You are about to write, retitle, or change the status of a card in this (or a similarly-structured) method library.
- You just applied a card's practice somewhere and are deciding whether/how to record that.
- A card has been applied more than once with a mixed or negative outcome and no one has revisited its status.
- A lookup for a problem class comes up empty — no existing card fits.
- You are tempted to append a "correction" paragraph to a card instead of editing its Practice.

## Practice
1. **A card states current truth only — never a diary.** When a practice changes, UPDATE the Practice section
   in place and delete what is disproven; do not append a dated correction paragraph onto old text. The commit
   message, not the card body, is where the "why did this change" story lives — every movement lands as its own
   tagged commit (`card(<key>): <what moved>`), so `git log --grep '^card(<key>)'` is the card's full evolution
   and the file itself never accumulates layers of self-narration.
2. **Every application appends exactly ONE dated outcome line — record failures as readily as wins.** After
   using a card's practice anywhere, add one line to its Applications section: date, system, what was applied,
   the observed outcome (with a number if one exists), and a run/commit ref. An improvement and an
   under-delivery are recorded the same way, in the same section — an outcome that goes unrecorded is a lesson
   the library loses for good, indistinguishable from an outcome that never happened.
3. **An under-delivering card flips its own status and becomes the next fix target.** When the accumulating
   Applications lines show a card's practice failing or under-delivering, set `status: under-delivering`
   immediately — do not delete the card and do not quietly leave it `adopted`. A card in that state is now
   itself a defect to route through the same capture→distill→edit→commit loop this library prescribes for any
   other system: rewrite the Practice against the newer evidence, then flip status back once a fresh Application
   line shows the fix held. The library is not exempt from the loop it teaches — it is the loop's own first
   subject.
4. **The index hint refreshes on every change, in the same commit.** A card's one-line index entry is its
   frontmatter `description`, copied verbatim — never hand-authored separately and never left stale after a
   retitle, a status flip, or a Practice rewrite. If the description changes, the index changes in the same
   commit; an index that lags its card is worse than no index, because it sends the next lookup to the wrong
   place with false confidence.
5. **A lookup MISS is a growth signal, not a dead end.** When no existing card fits the problem class in hand,
   that gap is the trigger to research it, distill the finding into a new card following this same contract,
   and commit it — the library is expected to grow exactly at its failure points, not to be treated as a fixed,
   closed set that a miss simply falls through.
6. **Raw research is an immutable, dated annex — cards cite it, they never absorb it.** Findings from a research
   pass land in a separate, dated, append-only location outside the cards themselves; a card's Evidence section
   points at that record (a source id, or the dated report) rather than pasting its contents in. This keeps each
   card small and keeps the annex as the durable, unedited paper trail behind every claim.
7. **Delete disproven content outright — do not archive it in place.** When a practice is superseded or a claim
   is shown wrong, remove it from the card entirely rather than striking it through or moving it to a "deprecated"
   subsection; version control already holds every prior state, so the current file only ever needs to hold
   current truth.

## Evidence
- FACTS (this session): the library was seeded 2026-07-03 with 18 cards distilled from the piflow research
  corpus plus a two-lane evidence sweep, establishing the card/annex/index split this practice maintains going
  forward.
- The commit-message-as-record move mirrors the 2026 git-native-memory pattern this library's sibling knowledge
  leg already uses in production: Lore (arXiv 2603.15566) restructures commit messages via git-trailers into
  decision records (constraints / rejected-alternatives / directives / verification), and GitOfThoughts (arXiv
  2606.14470) records scores as git-notes on a merge rather than as prose edits to the artifact itself —
  `.claude/skills/memory-slices/SKILL.md`.
- Append/update/retire as discrete deltas — never a full-file rewrite — is the same rule this library's Leg-A
  twin enforces on its own bounded record: ExpeL's insight-pool ADD/EDIT/UPVOTE/DOWNVOTE (arXiv 2308.10144) and
  Mem0's ADD/UPDATE/DELETE with newer-wins (arXiv 2504.19413) are the update-rule this maintenance loop follows;
  full-rewrite consolidation is the documented failure mode it avoids — ACE (arXiv 2510.04618) is cited as the
  study behind that collapse risk — `.claude/skills/memory-slices/SKILL.md`.
- Projectmem's grep-able, append-only event log whose judgment layer is "you tried this before — it failed" is
  the same recurrence-over-diary shape this card's Applications-line rule mirrors at the library level — `.claude/skills/memory-slices/SKILL.md`.
- Zep/Graphiti favors invalidation over deletion for a live retrieval store (arXiv 2501.13956), but this
  library's substrate already has git as its invalidation ledger, so a card can hard-delete disproven content
  without losing the history — `.claude/skills/memory-slices/SKILL.md`.

## Anti-patterns
- Appending a "correction, 2026-07-10: actually X" paragraph instead of rewriting the Practice and committing.
- Applying a card and moving on without an Applications line because the outcome "wasn't interesting enough."
- Leaving a card `adopted` after repeated under-delivery because flipping status feels like admitting failure.
- Hand-editing the MEMORY.md index line separately from the card's `description`, so the two drift apart.
- Pasting a research report's findings into Evidence instead of citing the dated annex; treating a lookup miss
  as "not covered" instead of the signal to write the missing card.

## Applications
- 2026-07-03 · this library · seeded 18 cards under this contract → card/annex/index split holds, no stale index lines · ref: initial commits.

## See also
[[memory-recording-policy]] · [[three-knowledge-legs]]
