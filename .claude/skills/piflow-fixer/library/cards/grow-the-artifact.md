---
key: grow-the-artifact
title: Grow large artifacts one element per edit — conditioned, with a skeleton for global coherence
domain: execution
status: adopted
description: A node authors a large structured artifact (15+ interdependent elements) or its trace shows whole-artifact composition — grow it one element per edit, skeleton-first; small strong-prior artifacts stay single-pass.
aliases: [incremental growth, local growth, one element per edit, decision becomes artifact, plan-then-write, one-shot generation, whole-file rewrite, outline first, skeleton then fill, template stamping, mode collapse, re-litigation]
tags: [execution, authoring, structured-output, incrementality]
updated: 2026-07-06
---

# Grow large artifacts one element per edit — conditioned, with a skeleton for global coherence

## Trigger
- The artifact has ~15+ interdependent fields/elements or accumulates past ~3k tokens of context —
  the zone where single-pass generation measurably loses later-defined fields.
- The trace shows a whole-artifact composition turn (one mega-thinking turn planning every element
  before the first write), or the same decision re-litigated across a long turn.
- A whole-artifact rewrite is being used for a small delta (regeneration cost dominated by
  unchanged content).
- COUNTER-trigger: the artifact is small AND its constraints live in a strong structural prior the
  model already holds (a short schema/config, code where "the structure IS the plan") — stay
  single-pass; per-edit overhead dominates with no coherence payoff.

## Practice
1. **Past the threshold, grow: ONE element per edit, in dependency/traversal order.** Each decision
   becomes on-disk artifact immediately; the next element is placed relative to what is already
   written (read it there — the artifact is the working memory). This targets local-constraint
   tracking and kills re-litigation (decisions in prose get re-decided; decisions on disk get read).
2. **Growth ALWAYS gets a skeleton companion for GLOBAL constraints.** Cross-element invariants
   (coherence, escalation, a variety requirement — "no two elements alike") are exactly what local
   growth drops: without a changing global signal, decoding self-reinforces into repetitive
   template-stamping. Write ONE short intent line/outline first (bounded, overwrite-not-append),
   and re-ground against it periodically. Skeleton-first + growth preserves coherence AND
   diversity; growth alone measurably drifts and stamps.
3. **Pair growth with EXTERNAL validation signal, never self-review loops.** Validate-as-you-go
   only pays when the check carries real external signal (a calculator/validator — see
   [[model-callable-calculators]]); open-loop iterative self-correction confidently repeats the
   same wrong answer while burning the per-turn overhead.
4. **Route by model capability too, not size alone.** Capable models land targeted edits cleanly;
   some models track edit boundaries poorly and do better with whole-section writes — verify which
   edit primitive binds on YOUR model before mandating one.
5. **Verify from the next trace:** largest-turn thinking volume down, per-element edit turns short
   (seconds), AND a variety check on the grown elements — if they stamp (near-identical elements at
   metronomic offsets), rule 2's skeleton/re-grounding is missing, not growth itself wrong.
6. **Keep the skeleton's guide prose quote-safe for edit anchors.** A bare single-word bracket token in
   a placeholder (`<id>`, `<threat>`) gets mangled by some model gateways inside a tool-call argument
   string as XML, splitting the string into objects; a colon-bearing sentinel (`<FILL:`) is proven safe
   — prefer it over a bare-bracket marker.
7. **Design the first-edit forcing function as a LAST-event trip-wire, never a named-read trip-wire.** A
   rule keyed to one specific input read ("the instant the skeleton read returns") fires-and-lapses the
   moment the model reorders its reads, leaving the post-read window ungoverned; key the trigger to
   "your LAST input read, whichever it is," armed at any point after the first read.

## Evidence
- Single-pass degrades with size: schema-violation/field-loss rises sharply at ~15+ fields over
  3k+ token inputs, later fields lost first (Kalviumlabs benchmark, 2026); grammar-constrained JSON
  fails structurally when budget exhausts mid-object (vLLM #8350 + 2026 production reports).
- Local/sequential generation drifts from a global outline over the course of generation
  (outline-conditioned generation, EACL 2024); outline-first + controller beats naive incremental
  drafting by +22.5% plot coherence (DOC, ACL 2023); skeleton+augmentation preserves coherence AND
  diversity together (WritingPath, NAACL-Industry 2025).
- Template-stamping is a decode-time self-reinforcing attractor absent a changing global signal
  (ICML 2025 repeated-token; ACL Findings 2025 self-reinforcement; ICML 2026 mode-collapse) —
  observed live: growth WITHOUT re-grounding produced 11 near-identical threat pairs at metronomic
  spacing on one model (game-omni run rG) while the other model kept varied spacing (k27g).
- Measured on two agentic models, same seed, calculators held constant (game-omni 2026-07-05):
  growth halved the largest planning turn (139k→79k and 45k→26k thinking chars) at equal-or-better
  validator results; combined calc+growth was the best cell (5.7 min, both gates pass, 83% fill).
- Iterative multi-turn correction beats single-turn ONLY with an external verification signal
  (RISE, cited 2026); per-turn validation overhead is a real tax (~5-15k tokens/turn) that dominates
  on small artifacts.
- Practitioner convergence: whole-file rewrite cost scales with file size (18× tokens for a 5-line
  change on a 4.2k-line file, AST-edit benchmark 2026); harnesses enforce incrementality via the
  edit primitive itself; per-model edit-format routing (aider, 2026).
- wa2→wa3 A/B, same model: 1045s→552s, and the 143.6s/27.8k-char mega-think rule 7 targets was
  eliminated entirely (game-omni w1-design P10 bank, 2026-07-06).

## Anti-patterns
- Growth without a skeleton on an artifact with a variety/coherence requirement — the stamping regime.
- Outline-first on a small artifact whose syntax already IS the plan (code/schema) — locks in a plan
  before constraints are discovered, pure overhead.
- "Keep growing is always good" as an unconditioned rule — the condition (size × constraint
  structure × model) is the content of this card.
- Validate-as-you-go where the "validation" is the model re-reading its own output (no external signal).

## Applications
- 2026-07-05 · game-omni gameplay · growth method (one element per edit + short intent line) added on
  top of calculators, A/B'd on MiniMax-M3 + Kimi-K2.7-Code vs calc-only, same gm9 seed → largest turn
  −43%/−42%, best-cell result on K2.7 (5.7 min, gates pass); M3 arm exposed the stamping failure
  (rule 2's re-grounding absent) · runs rG/k27g vs rK2/k27b.
- 2026-07-05 · game-omni · LANDED on the real gameplay template (calc+growth+re-grounding, be8f0e1), stability arms both models → K2.7 VERIFIED (kL1: 4.1 min, gates pass 86%, accelerating wave 640/640/480/320, total think −37%); M3 UNDER-DELIVERY (rL1: 3× faster at 5.1 min BUT 28% fill + uniform 180px gaps) — rule-4 model condition live: RELATIONAL re-grounding doesn't bind on a model that rubber-stamps relational checks; queued fix = closed-form re-grounding (call bounds/spacing every few placements) or route by model · runs kL1/rL1.

## See also
[[model-callable-calculators]] · [[overthinking-and-thinking-caps]] · [[context-composition]] · [[parallel-variants-over-longer-thinking]]
