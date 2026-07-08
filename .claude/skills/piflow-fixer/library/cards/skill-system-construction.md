---
key: skill-system-construction
title: Building a skill corpus that agents can find, trust, and safely evolve
domain: knowledge
status: proven
description: Reach for this when authoring/splitting a skill, writing its description, wiring cross-refs, or editing corpus prose after a failure.
aliases: [skill corpus, skill authoring, skill description, trigger contract, skillsys, corpus protection, one skill one job, skill index, appendix consolidation]
tags: [knowledge, skills, corpus, retrieval, self-editing]
updated: 2026-07-03
---

# Building a skill corpus that agents can find, trust, and safely evolve

## Trigger
- Authoring a new skill and it's unclear whether it covers one job or several bundled ones.
- A skill's description reads like a topic summary and retrieval keeps missing it, or misfires.
- Two related skills in the same family (create/run/improve, or similar) don't point at each
  other, so an agent picks the wrong one, duplicates a sibling, or solves a problem the corpus
  already covers without checking an index first.
- About to edit a skill's prose in response to a single failed run, or unsure whether the prose
  or the executor was actually at fault.
- A skill edit is about to land uncommitted, untagged, bundled with unrelated changes, or as a
  structural change (new skill, reordered step, changed contract) without a human sign-off.

## Practice
1. **Size each skill to one independently-triggerable job.** If a skill's trigger list reads as
   "do A, or do B, or do C" for unrelated intents, split it — one skill per job, cross-referenced.
   A skill that keeps growing new unrelated trigger bullets is a signal to split, not append.
2. **Write the description as a TRIGGER CONTRACT, not a topic label.** Name observable symptoms,
   verbs, and intents an agent will actually have in hand ("output keeps missing X", "about to
   edit Y after a failure") — never a summary of the skill's internals; a workflow-summary
   description becomes a shortcut agents follow instead of opening the skill, and a topic label is
   exactly what retrieval silently misses. Retrieval quality lives or dies at this one line.
3. **Cross-reference sibling skills explicitly, by name.** Skills in the same family (create / run
   / improve, or any create-then-operate-then-fix triad) must each name the others so an agent
   lands on the right one instead of duplicating it. Cite a reference/method card by pointer for
   the parts it borrows rather than absorbing that content wholesale — a copy has no update path
   to ride, so the corpus silently forks the moment the source changes.
4. **Maintain one INDEX, and check it before re-deriving.** Before solving a problem from scratch,
   check the index for a skill/card that already covers it. A lookup miss is itself a signal:
   research the gap, distill it into the corpus, then proceed — never silently re-solve what the
   index should have surfaced.
5. **Protect the corpus: never edit a correct rule over a one-off slip.** Before touching a
   skill's body, ask "does a rule already exist that, if followed, would have prevented this
   failure?" Yes → the executor slipped, not the prose — route the fix to a small, protected
   append-only reminder region (consolidated into the body only past a set occurrence threshold),
   never a body rewrite. When genuinely unsure which side is at fault, default to blaming the
   executor — that asymmetry is what keeps a working corpus from rotting under pressure.
6. **Every edit is atomic, revertible, and tagged.** One edit = one fix, committed under a single
   grep-able convention keyed to the unit it touches, carrying why/lesson/what-was-rejected —
   never batched with an unrelated change. A structural change (a new skill, a reordered step, a
   changed contract) additionally requires an explicit human sign-off; atomicity and revertibility
   are necessary but not sufficient for a structural change.
7. **Match the edit's FORM to the failure's TYPE.** Wrong-shaped output → a positive worked
   recipe, never a list of prohibitions (prohibitions measurably backfire on shaping). Omitted
   element → a new required-output slot, not a reminder. Conditional behavior → a rule keyed to an
   observable predicate, no nuance/exemption clause (exemptions don't scope). Discipline lapse (a
   step skipped under pressure) → an explicit prohibition plus a table of the rationalizations
   that lead to skipping it.

## Evidence
- The corpus survived aggressive iteration at scale under this exact discipline: 241 tagged
  `skillsys(...)` commits accumulated repo-wide with no rot event recorded (live `git log --grep`
  count 2026-07-03, game-omni).
- The default-toward-the-executor rule ("does a rule exist that would have prevented this? yes →
  executor slipped; when unsure, default to the executor") is a working, shipped rubric
  (`optimizer/skill_aware.py:61-91`, test `:75-78`, default `:77`; SkillOpt arXiv:2605.23904),
  backed by a protected region step-edits cannot write to, consolidated past a threshold
  (`optimizer/skill.py:27-30,94`; `skill_aware.py:164`).
- Edits are capped per round rather than rewritten wholesale — the top-`edit_budget` ranked edits
  only (`optimizer/clip.py:25,54`) — the "smallest durable edit" discipline rule 6 asks for.
- The mutable unit is kept deliberately small (300–2000 tokens per skill document, README.md:46)
  — corroborating rule 1's "one job, one skill" sizing floor.
- The shape-matched edit-form rule (positive recipe for shaping vs. prohibition-only backfiring)
  and "description states WHEN, never a workflow summary" are both load-bearing laws of the
  shipped stewardship method this card distills (`hermes-skill-system/SKILL.md`, laws 4–5;
  provenance: Nous Research Hermes Agent research, 2026-06-08).

## Anti-patterns
- A description that reads "this skill does X, Y, Z" instead of "reach for this when you see
  symptom A" — the exact failure mode retrieval silently dies to.
- Rewriting a skill's body the first time it fails once, without checking whether a correct rule
  already existed and the executor just missed it.
- Landing a structural skill change on "it's revertible" alone, skipping the separate human
  sign-off structural changes require.

## Applications
- 2026-06-17 · game-omni (pre-SDK era) · the full capture→route→edit→verify→approve→commit loop run by hand across the skill corpus → 247 tagged commits; the corpus survived aggressive iteration without rot · ref: git log --grep skillsys, game-omni.

## See also
[[four-way-triage]] · [[memory-recording-policy]] · [[fixer-model-tiering]]
