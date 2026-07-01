---
"@piflow/core": minor
"@piflow/cli": patch
---

Add an SDK-level fix-cycle CEILING to the FIX→GATE driver — a deterministic, portable per-node re-attempt
bound so a structurally-unfixable node ESCALATES instead of looping across `optimize --fix` invocations.

The bound is additive and OPT-IN; absent its inputs the driver is byte-for-byte backward-compatible.

- `FixGateStages` gains two OPTIONAL stages — `readFixCycles?(node): number` and `bumpFixCycles?(node): void`.
  `@piflow/core` persists NOTHING for the counter (boundary law: the SDK is logic only) — the product injects a
  file-backed counter; core only reads/bumps it through these stages.
- `FixGateOpts` gains an optional `fixCycleCeiling?: number`. The ceiling activates ONLY when it AND both
  counter stages are present; otherwise it is a no-op.
- `runFixGate` skips (does NOT attempt) a node whose `readFixCycles(node) >= fixCycleCeiling` — no `fixer-started`,
  no edit/token budget spend — surfaces it on the new `FixGateResult.skipped: FixCycleSkip[]`, and emits a new
  `{ type: 'fix-cycle-ceiling'; node; cycles; ceiling }` OptimizeEvent. The counter is bumped ONLY after a REAL
  failed fix (a rejected verdict with >=1 edit applied); an accept, a 0-edit, or an aborted proposal does not
  consume budget.
- `renderOptimizeEvent` handles the new variant (`fix-cycle-ceiling [node] cycles/ceiling — escalate`); the
  `--watch` CLI renderer needs no change (it delegates to `renderOptimizeEvent` / `JSON.stringify`).
- CLI: a new `--fix-cycle-ceiling <n>` flag threads the bound + the binding's optional counter stages into
  `runFixGate`. A binding WITHOUT the counter port still validates and runs (the ceiling stays inert).
