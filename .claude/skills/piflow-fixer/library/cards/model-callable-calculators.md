---
key: model-callable-calculators
title: Issue calculators from the trace — an answering service, never a judge
domain: execution
status: proven
description: A node hand-derives computable quantities in its thinking (sqrt/ratio text, re-derived report numbers) — issue an answering-service calculator, never a judge.
aliases: [calculator, helper function, answering service, hand-arithmetic, in-head derivation, derive spiral, tool-augmented arithmetic, batch what-if, compute never choose]
tags: [execution, tools, arithmetic, model-in-the-loop]
updated: 2026-07-05
---

# Issue calculators from the trace — an answering service, never a judge

## Trigger
- A trace shows derivation markers in thinking — `sqrt(`, quadratic/formula text, serial coordinate
  arithmetic — for a quantity a pure function could compute.
- The model re-derives a number a validator report already implies (a ratio given without its fix-target
  quantity; a flag given without its location).
- A node stalls in analysis on math, or you catch yourself writing prose telling the model to "be careful
  with the numbers."
- Candidate-shopping: the model derives the same formula for N candidate values in sequence.

## Practice
1. **Issue on necessity, from the trace — never preemptively.** The test: the SAME computable quantity is
   hand-derived ≥2× in one run, or recurs across runs. Build that ONE subcommand. A speculative suite is
   prompt surface + choice noise; the library of helpers grows at its observed failure points.
2. **Structure: one CLI, subcommands over the SAME pure functions any post-hook validators use** — the
   calculator and the report can then never disagree. Args in, JSON out.
3. **Answer format: facts with their coordinates.** Every answer carries (a) the computed quantity, (b) the
   LOCATION/owner ids it belongs to (which gap, which pair — absence forces the model to re-derive WHERE),
   (c) the target number the model would otherwise derive (e.g. the envelope value, not just the ratio),
   (d) a "you decide" note. `exit 0` ALWAYS — an answering service never fails the node.
4. **Compute, never choose.** No suggested edits, no corrected versions, no design choices — measurements
   and violations as data; the model owns every decision above them (else output converges to the
   template the checker implies).
5. **Wire with freed framing.** Present it as "the number the instant you'd otherwise stop to compute it";
   REMOVE any prove-it obligation from the task (obligation measurably suppresses calling); scope the
   shell tool to the calculator alone; allow batch what-if calls or a tiny orchestration snippet for
   candidate-shopping.
6. **Verify issuance worked, from the next trace:** derivation markers →0 for that quantity, call count up,
   turn time down. A surviving derivation names the next subcommand.

## Evidence
- Round-1 live A/B (game-omni cgA/rc1, 2026-07-03): compact reasoning model called the calculator 42×;
  the derive-spiral (`750t²−540t+90=0` class) hit 0 in both arms — refuting "a compact model won't
  reliably choose a mid-run tool."
- Round-2 seeded A/B (rF/rO, commits 0579e10/ffa6aa1): proof-obligation kept → 13 in-head derivations
  WITH the calculator available; obligation removed → 0. Framing, not availability, gates usage.
- rK1 trace dissection (2026-07-05): ~40% of two mega-turns (50k+43k thinking chars) was arithmetic for
  exactly the quantities with NO subcommand (flight-time vs hazard window ×7; bounds-envelope derived 3×
  with 3 different answers; gap-location reconstruction) — the necessity test naming the next helpers.
- Task-specific calculators vs in-head derivation: 5.5–13× accuracy (88% vs 16%), 10,000 trials — Nature
  npj Digital Medicine, 2025.
- Batch/programmatic tool orchestration: ~20% better outcomes (Anthropic + Cloudflare shipped, 2025–26).
- Prompting a compact model to self-verify its math instead is measured NEGATIVE (d −0.14…−0.33,
  AAAI 2026 process-verification study) — the tool call REPLACES self-checking, never supplements it.

## Anti-patterns
- Building the full helper suite up front "to be safe" — unused subcommands are noise, not readiness.
- "Double-check your math" prose in place of (or on top of) the tool — measured harmful on compact models.
- A helper that returns advice ("move it to y≈1880") — that is a judge choosing; creativity caps at the rule.
- A helper that can exit non-zero — the node inherits a failure from its own question.
- Reports carrying ratios/flags without locations or target values — the model re-derives what you withheld.

## Applications
- 2026-07-05 · game-omni gameplay · issuance round from the rK1 necessity list (flight-time window,
  bounds-envelope, gap locations, batch what-if) → dispatched, live verify pending · ref: rK1 dissection.
- 2026-07-05 · game-omni · issuance round landed + advertised (land/bounds/spacing-locations/--cases; 9eb1e99+f99bb1c) → K2.7 chunks think→calc→act (kL1 verified); UNDER-DELIVERY on M3: rL1 shipped 28% fill WITHOUT calling `bounds` — advertisement alone doesn't guarantee the call at the moment of need; pair with a structural ask-at-N-placements cue (see grow-the-artifact) · runs rK2/k27b/kL1/rL1.

- 2026-07-07 · game-omni w1-design · two band-grain answering-service checks issued from the recurrence-4
  M5 miss + the wa11 hook-garnish: assertion_lint gained `checkBandTeachSolo` (a threat kind whose DEBUT band
  contests ≥2 kinds → advisory) + `checkHookRecurrence` (<2 `hook:true` bands → advisory) over a NEW `bands[]`
  fenced tail. Reports the measurement + its location, never the fix (exit 0). The lever that finally
  matched the grain was RESTRUCTURING the artifact (prose→data) so the check could see the defect — not a
  smarter detector. End-to-end proven (fires on a compounded debut, silent on a clean design). ref:
  game-omni docs/fix-cycle-2026-07-07.md.

## See also
[[tool-call-efficiency]] · [[context-composition]] · [[overthinking-and-thinking-caps]] · [[budgets-as-defects]] · [[layered-instruction-homes]]
