// Target 10 — the §7 per-live-run cost cap, as testable code (docs/design/full-run-e2e-LOCKED.md §"Target 10").
//
// CI YAML is not unit-asserted (a `timeout-minutes` typo or a stray retry on the live tier is invisible to a
// grep), so the hard ceiling the user asked for ($1.00/run, pre-flight reject BEFORE the paid call) lives here
// in code, behind a tiny seam both live-e2b entrypoints call: the control-vm smoke and the e2e-live matrix
// runner do `budgetGuard(estimate, Number(process.env.PIFLOW_RUN_BUDGET_USD) || 1.0)` BEFORE the POST/spawn that
// boots a paid VM. An over-cap estimate THROWS (fail-loud) — the run never starts, so a surprise bill can't
// accrue. Pure + deterministic → an L0 unit proves the cap fires (budget-guard.test.ts).
//
// The bound is STRICT `>`: an estimate exactly AT the cap is allowed (spend up to, not past, the ceiling).

/**
 * Reject a paid run whose estimated cost exceeds `cap` (USD). Throws before the caller boots the sandbox.
 * @param estCost estimated USD cost of the run about to start.
 * @param cap     the hard per-run ceiling (USD) — typically `PIFLOW_RUN_BUDGET_USD ?? 1.0` (§7).
 */
export function budgetGuard(estCost: number, cap: number): void {
  if (estCost > cap) {
    throw new Error(
      `budget exceeded: estimated $${estCost} > cap $${cap} — refusing to start a paid run past the ceiling ` +
        `(raise PIFLOW_RUN_BUDGET_USD deliberately if this is intended).`,
    );
  }
}
