---
key: four-way-triage
title: Route every defect to a SIDE, not just a place
domain: loops
status: adopted
description: Triaging a post-run defect before editing anything — bucket it LAPSE→SKILL→FUNCTIONALITY→ARCH top-down, default to LAPSE when unsure.
aliases: [four-way triage, credit assignment, blame routing, execution lapse, skill defect, functionality defect, coordination defect, default-to-lapse, blast radius routing]
tags: [triage, credit-assignment, self-editing, loop-control, blast-radius]
updated: 2026-07-03
---

# Route every defect to a SIDE, not just a place

## Trigger
- A post-run defect surfaced and you're about to edit something (prompt, skill, code, or wiring) in response.
- You're tempted to edit guiding prose right after a single one-off failed run.
- An optimizer/fixer needs to pick which gate governs its own edit before making it.
- The same failure signature has now shown up more than once for the same unit.
- The candidate fix would touch a different unit's contract or a shared wiring point.

## Practice
Before editing anything, run ONE top-down discrimination test, cheapest bucket first, and STOP at
the first YES. Never invent a fifth bucket, and never skip a cheaper bucket to reach a favorite fix.

**① EXECUTION_LAPSE** — test: *does a correct rule already exist (in the executor's prompt/contract)
that, if followed, would have prevented this?* YES → this bucket. It is also the **DEFAULT when the
answer is unclear** — always resolve ambiguity toward this cheapest bucket to protect the corpus.
- Do NOT edit the prose; it is already correct — editing a correct rule over a one-off slip is how a
  corpus rots.
- Fix is a short reminder in a protected, append-only note region (never the body) or a routing change
  (bump model/tier/provider) — a lapse is usually a weak-tier/transient symptom, not a content gap.

**② SKILL_DEFECT** — test (only if ① is NO): the guiding prose is wrong, missing, or underspecified.
- Edit the envelope (prompt/skill/contract), not product code.
- Match the edit FORM to the failure TYPE: shaping → a positive worked recipe; omission → a new
  required-output slot; conditional → a rule keyed to an observable predicate; discipline lapse → an
  explicit prohibition.
- Gate: a human review of the edit is enough (cheap, reversible), plus the outcome/accept gate once a
  comparable score exists.

**③ FUNCTIONALITY_DEFECT** — test (only if ①–② are NO): the prose is fine; the code/artifact the unit
operates on is what's wrong.
- Edit code, confined to the unit's own owned/read scope.
- Gate is STRICTER than ②: the edit must additionally pass the product's own tests/typecheck/build — a
  human eye alone is not sufficient. Treat "no external precedent for this bucket" as a reason to gate
  harder, never as a reason to skip the bucket.

**④ ARCH/COORDINATION** — test (only if ①–③ are all NO): the fix cannot be made inside this unit's
scope — it needs a new/rewired unit, touches another unit's contract, or is a hand-off flaw.
- Route UP; do not patch around it locally.
- Gate: an explicit human structural sign-off — never auto-land a scope-escaping fix.

**Recurrence flips the verdict.** If a defect assigned to ① reappears for the same unit across
separate runs, that repetition IS the signal it was never a lapse — reclassify it to ②. A true lapse
does not recur; a lapse that keeps recurring is a hole in the prose. Track occurrences per
(unit, failure-signature) and re-triage on the next hit instead of re-applying ①'s no-edit fix forever.

## Evidence
- The working discrimination rubric this is built on ships with an explicit default-toward-LAPSE rule
  (SkillOpt `optimizer/skill_aware.py:61-91`, test at `:75-78`; paper arXiv:2605.23904) — a two-way
  version of ①/②.
- LAPSE fixes route to a protected `APPENDIX`/`SLOW_UPDATE` region the fast edit loop cannot touch
  (`optimizer/skill.py:27-30,94`) — the mechanism guarantee behind "do not edit correct prose."
- The accept gate for a ②/③ edit is strict-improvement on a held-out score, never self-assessment
  (`evaluation/gate.py:123`, `cand_score > current_score`).
- Edits are capped per round rather than rewritten wholesale (`optimizer/clip.py:25,54`,
  `config.py:31-43`; default learning-rate budget = 4 edits/step) — the discipline ②/③ edits inherit.
- Neither SkillOpt nor Mastra ever edits product/application code (vendor digest §6 `[GAP]`) — bucket
  ③ has no external prior art, which is why its gate is stricter than ②'s, not skipped.
- piflow shipped the four-way projector with default-when-unsure = LAPSE and a cross-run recurrence
  reader that flips LAPSE → SKILL from per-node memory (2026-06-30) — the mechanism that operationalizes
  "recurrence is the signal."

## Anti-patterns
- Editing prompt/skill prose after a single one-off failure — that's ① territory, not ②; it rots the corpus.
- Jumping straight to ④ to avoid owning a fix, instead of checking ①–③ first.
- Applying ②'s human-eye gate to a ③ edit — code changes need the product's own tests, not just a read.
- Leaving a recurring ① defect classified as a lapse forever because no one checks cross-run recurrence.

## Applications
- 2026-06-30 · piflow · shipped the four-way projector (default-when-unsure=LAPSE) → cross-run recurrence reader now flips LAPSE→SKILL on repeat · optimize/triage.ts + recurrence.ts

## See also
[[outcome-gated-accept]] · [[memory-recording-policy]] · [[skill-system-construction]]
