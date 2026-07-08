---
key: fail-closed-deterministic-gates
title: A deterministic gate must parse what the system teaches, fail closed on garbage parses, and state its own measurement
domain: execution
status: proven
description: Use when a gate/linter flags artifacts the producer believes correct, repairs don't converge (identical-args tool loops), or a sentinel check can match prose mentions.
aliases: [gate false positive, unconvergeable repair loop, linter grammar mismatch, fail closed, repair-actionable error, sentinel false positive, tool loop, identical args, parse what you teach, gate states its measurement]
tags: [gates, linters, loops, weak-models, anti-drift]
updated: 2026-07-07
---

# A deterministic gate must parse what the system teaches, fail closed on garbage parses, and state its own measurement

## Trigger
- A gate/linter flags an artifact whose producer is staring at its own (correct) declarations, and repeated
  repairs do not converge — telemetry shows the same check tool called N× with identical args.
- The gate's parser recognizes a different declaration format than the one the skill/skeleton/template
  teaches the writer (two halves of one contract, drifted).
- A gate's error detail asserts a violation without showing what the checker itself parsed or measured.
- A sentinel/regex integrity check can match prose that merely MENTIONS the sentinel (scaffolding comments,
  quotes, self-description), not just live occurrences.

## Practice
1. **Parse what you teach.** The gate's grammar must accept exactly the form(s) the teaching surface
   documents — one contract, both sides honor it. Add a round-trip test: the canonical example the skill
   teaches must pass the parser. Never "fix" the mismatch by teaching writers to satisfy the parser's
   accidental grammar — that bends the product contract to a tool bug.
2. **Fail closed on a garbage parse.** Never arm per-item flags off a low-confidence extraction. Decision
   rule: if the extracted reference set shares ZERO members with the checked set (and the checked set is
   non-empty), emit ONE inconclusive report — never N per-item flags. N unconvergeable flags are how
   repair loops start.
3. **State your measurement.** Every flag's detail carries what the tool itself parsed/measured PLUS the
   accepted declaration forms, so a repair converges in one step. A gate that only asserts violation
   produces guess-loops, worst on weak executors.
4. **Keep the artifact pure so strict gates stay valid.** Anything that must disappear from the artifact
   must BE a slot the gate checks; instructions/scaffolding never live outside slots — they provably leak
   into shipped artifacts on strong AND weak executors alike. A pure artifact lets the sentinel check stay
   strict with zero false positives; never weaken the gate instead.
5. **Backstop, don't substitute.** A runtime identical-args tool-loop breaker (kill at N with a first-class
   reason, one detector shared by live + post-hoc telemetry) catches anything that slips through — it is
   the backup plan; the contract fixes above are the fix. A loop detected is a harness defect to
   root-cause, NEVER a case to encode as a test.

## Evidence
- game-omni wa13 (2026-07-07): the assertion_lint key-extractor accepted only backtick/table forms while the
  skeleton taught a bullet `{input, action}` menu → prose backticks harvested as "declared keys" → every
  assertion flagged undeclared → 15 identical lint calls, 20.7M cacheRead tokens, node hand-killed. Fix
  (game-omni e1adc06: taught-form parsing + fail-closed arming + measurement-in-detail) replayed on the
  same artifact: 3 false flags → 0.
- game-omni wa12: the `regex-absent /<FILL:/` integrity gate blocked a COMPLETE 40KB GDD on the seeded
  header comment's prose mention of the sentinel; the purity fix (same merge) removed all non-slot
  scaffolding rather than weakening the gate.
- Leak is executor-independent: instructional comments survived into shipped artifacts of BOTH executors
  (MiniMax-M3 wa12: 4 comments; claude-code wc2: 3) — a contract defect, not a model lapse.
- Frozen-input A/B (wa14 vs wa13/wa12, same prompt/classification/pinned hook): post-fix run completed
  clean at the pre-cycle cost envelope (81k in / 29 calls vs the false-block arm's 179k in), quality HOLD
  9/10 — the gate-contract fixes cost nothing.
- Backstop shipped: piflow 49fc3da — killedToolLoop at N identical-args calls (default 10,
  `RunOptions.toolLoopLimit`, 0=off), reason string shared by the live breaker and post-hoc telemetry
  (one detector, two consumers).

## Applications
- 2026-07-07 game-omni w1-design (assertion_lint + gdd.skeleton.md): full practice applied (steps 1–5);
  wa14 frozen rerun clean, quality HOLD 9/10, loop class and false-block class both eliminated at the
  source. ref: game-omni e1adc06 + piflow 49fc3da.
