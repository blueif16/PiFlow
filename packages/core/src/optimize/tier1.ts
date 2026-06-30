// optimize/tier1.ts — project a game-omni `verify-milestone` report (the standalone, model-free six-gate
// harness output) into a Tier1Result. This is the OUTCOME/checkable quality signal the accept gate keys on
// (v1.5 §4d, §7). Pure: a parsed report object → Tier1Result. NO disk, NO browser — the live re-verify
// (runMilestoneVerify2) is a SEPARATE source that emits the same shape for the later GATE step.
//
// THE MAPPING (the test pins it; see optimize-tier1.test.ts): FLATTEN the four six-gate arrays into
// `checks[]` — fidelity[] (one each), completability (one iff ran), invariants[] (one each), perturbation
// (one iff ran) — and DROP the legacy top-level `assertions[]` (it duplicates fidelity[], double-counting it
// would inflate the denominator). `scalar` = passed/total over the checks that ran; a degraded report with no
// per-check arrays has no checks, so scalar falls back to the marker (1 on PASSED, 0 on FAILED).
//
// THE LOAD-BEARING RULE: `abstained` (the measure could NOT run) is re-tagged here even though the harness
// itself marks boot-fail / missing declaredRanges / design-escalation as VALIDATION_FAILED. ABSTAIN ≠ low
// score (v1.5 §7) — the fold must never penalize a build whose quality was never measured. We abstain on:
// bootFailed===true, fixOutcome==='boot_failed', perturbation.ran===false (missing declaredRanges → the
// anti-gaming gate could not draw), or any `escalation` (design-defect). A degraded "self-fix exhausted"
// re-run (M2: just fixOutcome:'exhausted', no per-check arrays) is a REAL fail — it measured and lost.
//
// Input is `unknown` (the caller already JSON.parse'd it); we narrow defensively — a missing or wrong-typed
// field is treated as ABSENT, never a throw.

import type { Tier1Result, Tier1Check, Tier1Gate } from './types.js';

// ── defensive narrowing helpers (a malformed field is absent, never a throw) ────────────────────────────
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Project a parsed verify-milestone report object → the Tier1Result the fold consumes. */
export function readVerifyReport(report: unknown, opts: { reportPath?: string } = {}): Tier1Result {
  const r = isObject(report) ? report : {};

  const milestoneId = str(r.milestoneId) ?? '';
  const marker: Tier1Result['marker'] = r.marker === 'VALIDATION_PASSED' ? 'VALIDATION_PASSED' : 'VALIDATION_FAILED';
  const passed = r.passed === true;

  // ── flatten the four six-gate arrays; the legacy top-level assertions[] is DROPPED (duplicates fidelity) ─
  const checks: Tier1Check[] = [];

  for (const f of asArray(r.fidelity)) {
    if (!isObject(f)) continue;
    checks.push(check(str(f.id) ?? '', 'fidelity', f.status === 'pass', str(f.describe), str(f.message)));
  }

  if (isObject(r.completability) && r.completability.ran === true) {
    checks.push(check('completability', 'completability', r.completability.status === 'pass', undefined, str(r.completability.message)));
  }

  for (const inv of asArray(r.invariants)) {
    if (!isObject(inv)) continue;
    checks.push(check(str(inv.name) ?? '', 'invariant', inv.held === true));
  }

  if (isObject(r.perturbation) && r.perturbation.ran === true) {
    checks.push(check('perturbation', 'perturbation', r.perturbation.invariant === true));
  }

  // ── scalar: passed/total over checks that RAN; fall back to the marker when no checks ran (degraded report) ─
  const scalar =
    checks.length > 0
      ? checks.filter((c) => c.passed).length / checks.length
      : marker === 'VALIDATION_PASSED'
        ? 1
        : 0;

  // ── abstain re-tag: measure-could-not-run (boot-fail / missing declaredRanges / design escalation) ──────
  const abstained =
    r.bootFailed === true ||
    r.fixOutcome === 'boot_failed' ||
    (isObject(r.perturbation) && r.perturbation.ran === false) ||
    (r.escalation != null && r.escalation !== false);

  return {
    milestoneId,
    marker,
    passed,
    abstained,
    checks,
    scalar,
    ...(opts.reportPath !== undefined ? { reportPath: opts.reportPath } : {}),
  };
}

function check(id: string, gate: Tier1Gate, passed: boolean, describe?: string, message?: string): Tier1Check {
  const c: Tier1Check = { id, gate, passed };
  if (describe !== undefined) c.describe = describe;
  if (message !== undefined) c.message = message;
  return c;
}
