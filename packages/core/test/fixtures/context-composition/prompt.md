# gameplay — HARDEN the blueprint

You are the blueprint PRODUCER. Read the SKILL first, then act.

DRIVER-ARTIFACTS: spec/blueprint.json
DRIVER-OWNS: spec/**
DRIVER-READ-SCOPE: /ws/run /ws/templates/genres.json /ws/templates/modules

## Inputs you MUST read
- packages/skills/harden-blueprint/SKILL.md — the method (READ IT FIRST, in full).
- spec/blueprint.json — the seeded blueprint you harden in place.
- spec/gdd.md — the game-design doc it derives from.

## Standing design law
Follow docs/design-rules.md for pacing/rhythm/difficulty. The design-rules.md file is the
contract for how spacing and difficulty must ramp — never violate it. Ramp difficulty over
~5.6 beats using the jump/dash/move verbs; see §5.6 for the rationale.

## Large reference
- spec/bigmap.json — the full placed-coordinate map (page it if large).

Write the hardened blueprint to spec/blueprint.json.
