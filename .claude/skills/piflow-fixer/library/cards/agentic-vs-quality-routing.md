---
key: agentic-vs-quality-routing
title: Two-axis defect routing — agentic (mechanism) vs quality (judged output)
domain: loops
status: candidate
description: Classify each flaw agentic (trace-detected mechanism) vs quality (judge-detected output) BEFORE fixing — each axis owns its detector, fix leg, verifier; the routing protocol now lives in the piflow-fixer skill, this card retains its grounding evidence.
aliases: [agentic vs quality, mechanism vs quality, efficiency vs quality routing, two-axis routing, which library for this fix, quality decline after optimization]
tags: [triage, routing, quality, efficiency, goodhart]
updated: 2026-07-06
---

# Two-axis defect routing — agentic (mechanism) vs quality (judged output)

## Trigger
- A trace-analysis session yields a pile of mixed findings — tool errors, think-spikes, AND weak output — with entangled causes.
- A mechanically clean run (zero tool errors, on-budget) still scores low against the quality criteria — or you don't know whether it would.
- A proposed fix's home is unclear: prompt vs skill vs tool vs knowledge doc.
- An efficiency edit is suspected of degrading output quality, or a quality edit of bloating cost.

## Practice
The routing PROTOCOL — how to divide a flaw by its detector (a trace instrument ⇒ the agentic/harness foot;
a blind judge vs criteria + gold ⇒ the quality foot), pick the strongest binding form off the compilation
menu, and verify against the gate — is now an operational protocol in the **`piflow-fixer` skill**
(`.claude/skills/piflow-fixer/`, also the substrate fixer's staged playbook). Follow it there. This card is
retained for the Evidence + Applications that ground that routing.

## Evidence
- Axes are independent: one campaign moved the agentic axis 1045s/9 tool errors → 441s/0 errors while a blind
  judge scored the end state 6/10 vs an 8/10 strong-tier control → game-omni runs wa2→wa8 vs wc1, 2026-07-06.
- Anti-correlation is real: an anti-spin device (first-fit hook tie-break, game-omni 43d2d6e) — a pure agentic
  fix — caused the creativity mark failure; confirmed by blind judging + hook-section diff.
- Cross-axis coupling: injecting a 98KB skill (knowledge content) into standing context to lift quality
  worsened both axes (66 calls, 191k think chars) → game-omni wa7 arm.
- The two-model diff bought the whole routing for one control run: depth failed on BOTH tiers (knowledge gap —
  the endless-discipline reference had zero coupling content) while three other marks failed weak-tier-only
  (scaffold gaps) → game-omni wa8/wc1 judge pass, 2026-07-06.
- Quality is invisible to trace instruments: the campaign's best run on every mechanism signal was its
  quality low-scorer; only the criteria fixture exposed it → game-omni wa8.

## Anti-patterns
- Consulting the mechanism library to close a judge-detected gap (form fix for a content gap) — or pouring
  knowledge prose into standing context to fix a trace-level defect.
- Injecting the criteria or the gold exemplar into the producer to "raise quality" — teaches to the test and
  voids the judge.
- Reading traces to conclude "quality is fine" — traces carry mechanism signals only.
- Verifying a change on one axis only, letting an efficiency win land a quality regression unnoticed.
- Averaging the two axes into one score — they gate independently.

## Applications
- 2026-07-06 · game-omni w1-design · first outcome (wa9): the two STRUCTURAL fixes flipped their marks on run
  one (M1 via menu-as-data, M8 via depth floor — judge-confirmed, mechanism N=1); the PROSE fix (subversion
  beat) did not bite; two orthogonal marks regressed (M7/M10) → verify-both-axes-and-whole-board confirmed.
  Historical blind re-judge (wa1–wa6 = 4,4,8,4,6,9) added the corollary: quality-LEVEL claims need N≥3;
  only mark-specific mechanism flips are honest at N=1 · game-omni c182fc2.
- 2026-07-06 · game-omni w1-design · first application: routed 4 judge-detected mark failures to
  knowledge/scaffold fixes (hook-menu-as-data, endless depth floor, teach-solo lint advisory, subversion beat),
  each dual-checked Goodhart+cost · brief: game-omni docs/w1-design-quality-brief-2026-07-06.md.

## See also
[[judge-reliability]] · [[optimization-objective-shape]] · [[layered-instruction-homes]] · [[context-composition]] · [[three-knowledge-legs]]
