<!--
  GENERIC gdd.md SKELETON — the W1 Spec node's pre-staged FILL target (DRIVER-SEED).
  This is the §6 prose-body SPINE only: the section headers in canonical order + the empty
  milestones fence. It is GENRE-, ARCHETYPE-, and goalModel-AGNOSTIC (win-lose | open-ended |
  creative-objective) — STRUCTURE, never CONTENT. It MUST NOT pre-decide or bias any design choice.

  HOW TO USE THIS FILE (W1): this is a READ-ONLY STRUCTURE reference — the section ORDER to follow,
  NOT a file you edit in place. READ it once for the outline, COMPOSE the design against it, then
  WRITE the COMPLETE filled gdd.md in ONE whole-file write that OVERWRITES this skeleton (replace
  each `<FILL: …>` guide with the real PROSE — reason-first: the WHY, then the committed value —
  delete THIS comment, and fill the milestones fence). The whole filled doc FITS in one turn; emit it
  as ONE atomic write — your write tool OVERWRITES (it does not append), so each write must carry the
  COMPLETE document, never a section fragment.
  The headers below are the REQUIRED §6 order; keep every one. Some sections are goalModel-
  conditional — fill the branch your `meta.goalModel` selects and write "none" (with one line of
  why) for an inapplicable one; never drop a header. No `<FILL:` guide may survive in the written
  file — a leftover one means the doc is unfinished. The final fenced ```json block carries ONLY
  { "milestones": [ … ] } (3–5), the one structured part HARDEN formalizes + the driver reads.
-->
# <FILL: game title>

## Meta
<FILL: archetype · goalModel (win-lose | open-ended | creative-objective) + its one-line rationale · objective (ONLY when goalModel == creative-objective) · coreLoop · coreVerb · coreFantasy · failModel · scoringModel (+ maxScore when != none) · artStyle (global medium + palette + mood, subject-free) · atmosphere (when the theme implies one). Reason each, then commit.>

## Hook
<FILL: §2.5 — the ONE selected signature hook (a buildable recombination of registered capabilities that creates a DECISION the prompt's nouns did not already name) + one line of why + the palette pieces it recombines. Placed right after Meta so it frames every choice below.>

## Entities
<FILL: the component selection — each entity (player first), its role, a one-line description, and its behaviors[] BOUND to resolving capabilities.json ids (honoring roles) or a "$custom:<id>" gap.>

## Mechanics
<FILL: each interaction, the capability id it binds to, and the kind=effect ids it fires.>

## Controls
<FILL: the {input, action} menu — DOM/Phaser key names.>

## Win / Lose
<FILL: each condition with its __GAME__ observable; status-model coherent. open-ended AND creative-objective: both description "none" (creative-objective ALSO records its non-fail completion observable + threshold here).>

## Config
<FILL: the tuning numbers; keys drawn ONLY from kind=config-key ids.>

## AssetList
<FILL: every primary visible object KIND as a simple SUBJECT line + view direction — NOT a full image prompt.>

## Playability
<FILL: goalModel-branched. win-lose: WIN-PATH · LEGIBILITY · ONBOARDING · CHALLENGE — the §3.5 richness + difficulty-floor coupling (the >=3 distinct escalating beats with the threat-on-path per reward/goal, the coordinates/extent). open-ended: WORLD-CONSISTENCY · BUILDING-INVITATION · VERB-AFFORDANCE (the §3.5b component set + seed world + observable verb changes). creative-objective: the §3.5b world floor PLUS the named meta.objective + the non-fail completion observable & threshold derived from real world state (§3.5c).>

## Scoring
<FILL: §3.6 — win-lose only (declare maxScore + idempotent rewards, or no score); open-ended AND creative-objective declare NO score.>

## Level Ladder
<FILL: §4.5 — LEVEL_ORDER: ['Level1Scene'] by default (ONE rich level; escalation is WITHIN it). Extra entries ONLY if the prompt explicitly asked for multiple levels.>

## Scope IN / OUT
<FILL: respect classification.scopeCut — what is in, what is deliberately cut.>

```json
{
  "milestones": []
}
```
