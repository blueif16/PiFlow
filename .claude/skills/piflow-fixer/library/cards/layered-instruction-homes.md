---
key: layered-instruction-homes
title: Every kind of knowledge has ONE home — process in the skill, field contract in the template, craft in the variant module
domain: knowledge
status: adopted
description: Use when a shared skill/prompt accumulates variant-specific rules, field-emission guidance, or failure vignettes — re-home each kind (process/contract/craft/failures) and gate with a zero-mention census.
aliases: [genre leakage, archetype-agnostic skill, skill is process only, template is the contract, field emission rules, per-variant craft, design-rules, FILL hints, instruction layering, knowledge homes]
tags: [knowledge, skills, templates, contracts, layering, anti-drift]
updated: 2026-07-05
---

# Every kind of knowledge has ONE home — process in the skill, field contract in the template, craft in the variant module

## Trigger
- A SHARED skill or wiring prompt (loaded on every run) names specific variants (genres, archetypes,
  product lines, locales) or carries rules that only apply to one of them.
- The skill prose tells the executor WHICH fields to emit/omit — knowledge a staged template/schema
  already encodes (or should).
- Failure vignettes / historical run references accumulate in a runtime-injected surface.
- A variant list in the shared layer has drifted from the real variant catalog (dead entries, missing ones).

## Practice
Declare ONE home per KIND of knowledge, and route every future edit to its home:
1. **Shared skill + wiring prompt = UNIVERSAL PROCESS only.** The steps, the laws, the self-critique
   PROCEDURE. Zero variant names, zero field-emission rules, zero failure vignettes. Concise — every extra
   line loads into every run of every variant.
2. **The staged template/skeleton + schema = the FIELD CONTRACT.** The executor learns WHAT to fill, its
   type, and conditional emission from the per-variant skeleton's FILL hints — a rule like "emit X only
   when meta.Y=='z'" rides the FILL hint of the templates that stage X, never skill prose.
3. **The per-variant module (design-rules/craft file, reached via the skill's read chain) = ALL implementing
   detail.** Math, recipes, worked examples, floor/audit items, pitfalls, tool cribs for that variant's
   physics. The shared skill routes to it by role ("your variant's craft file names your feasibility
   subcommands"), never by name.
4. **Failures live in the optimizer-facing memory + git**, never in any runtime-injected surface. The
   lesson's durable RULE may be distilled into a home above; the incident stays out.
5. **Gate it deterministically:** `grep -i '<variant names>' <shared skill+prompt>` must return 0; re-run
   the census after any edit. Variant lists in shared layers are banned outright — route by "your
   variant's module", so the catalog can't drift.

## Evidence
- game-omni harden-blueprint audit (2026-07-05): the always-injected wiring prompt advertised a
  platformer-only jump-physics calculator to all 8 archetypes; SKILL.md carried per-archetype formulas, a
  platformer worked example, 2D/3D field-emission rules, 9 historical run-id citations, and archetype lists
  drifted from the module catalog (2 dead entries, 5 real archetypes unlisted). Re-homing per this card cut
  the SKILL 999→768 lines with zero content loss (everything moved to its variant module or FILL hint);
  template dry-run compile stayed green (306bae0..f9633f6).
- Root cause generalizes: every fix lands in the ONE always-loaded file because it is the nearest surface;
  without declared homes, variant knowledge monotonically leaks into the shared layer as the system grows
  past its first variant.

## Anti-patterns
- "Syncing" the variant list in the shared skill to the current catalog — the list itself is the defect;
  route by role instead.
- Teaching field emission in skill prose ("for 3D variants also emit layout.X") — the skeleton stages the
  field; the hint carries the condition.
- Recording failure vignettes ("seen live: run X did Y") in a runtime surface as teaching aids — the
  executor doesn't need the history, and it bloats + ages.
- Moving craft OUT of the run's reach entirely — the variant module must be ON the executor's read chain,
  or the move silently deletes capability.

## Applications
- 2026-07-05 game-omni gameplay node: full re-home landed (9 commits); dry-run compile green; live
  verification (one platformer arm + one non-platformer arm on K2.7) PENDING — behavior parity not yet
  proven, recorded here honestly.
- 2026-07-07 game-omni w1-design: the escalation curve moved OUT of the shared skill's prose + the
  always-visible `## Playability` FILL hint (the nearest surface it had leaked into) and INTO the staged
  tail's FIELD CONTRACT (`bands[]`), with its readers (HARDEN, assertion_lint) re-pointed at the data and
  the always-visible `prompt.md` untouched (net standing ≤ 0). A clean case of the field contract belonging
  to the staged template, not skill prose. ref: game-omni docs/fix-cycle-2026-07-07.md.
- 2026-07-07 game-omni w1-design skeleton purity — a SHARPENING of the homes law: the ARTIFACT itself is a
  NON-home even for instructional comments. The skeleton's HTML comments (header + 3 in-body) provably
  leaked verbatim into SHIPPED GDDs of both executor tiers (M3 wa12: 4; claude-code wc2: 3) — nothing makes
  a non-slot disappear. All guidance re-homed to SKILL/prompt or INTO `<FILL:>` slot text (the one
  sanctioned in-artifact channel: slots disappear by contract, gate-enforced). wa14 rerun = first fully pure
  artifact, quality HOLD 9/10. ref: game-omni e1adc06; twin card [[fail-closed-deterministic-gates]].

## See also
- [[skill-system-construction]] — corpus retrieval/authoring discipline (the sibling: how skills are found
  and safely evolved; this card is WHERE knowledge lives).
- [[three-knowledge-legs]] — the memory/code/method legs this layering feeds.
