// Target 10 — budgetGuard: the §7 cost cap as testable code (full-run-e2e-LOCKED.md §"Target 10").
// The live-e2b entrypoints (smoke + matrix runner) call budgetGuard(estimate, PIFLOW_RUN_BUDGET_USD ?? 1.0)
// BEFORE the POST/spawn that boots a paid VM. This L0 unit proves the cap FIRES in code (not just in YAML).
// Pure-function guard; the assertion IS the litmus — an over-cap estimate cannot proceed.
//
// RED-first: packages/cli/src/budget-guard.ts does not exist yet → the import fails → this file reds
// for the RIGHT reason (the capability is absent). The implementer adds the module afterward.
//
// Teeth (verify phase): invert the comparison in budgetGuard (`>` → `>=` OR `>` → `<`) and the
// boundary/over/under cases red — a real code mutation, not YAML.

import { describe, it, expect } from 'vitest';
import { budgetGuard } from '../src/budget-guard.js';

describe('budgetGuard — §7 pre-flight cost cap', () => {
  it('throws budget exceeded when the estimate is over the cap', () => {
    // Observable: the guard rejects a paid call whose estimate exceeds the ceiling.
    expect(() => budgetGuard(1.5, 1.0)).toThrow(/budget exceeded/);
  });

  it('does not throw when the estimate is under the cap', () => {
    // Observable: an in-budget estimate proceeds (no throw).
    expect(() => budgetGuard(0.5, 1.0)).not.toThrow();
  });

  it('does not throw at the exact boundary (estimate equals cap)', () => {
    // Observable boundary: est == cap is allowed (strict `>` only). Killed by `>=` mutation.
    expect(() => budgetGuard(1.0, 1.0)).not.toThrow();
  });
});
