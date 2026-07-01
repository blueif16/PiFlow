// Contract for the A2 driver-thread: the fixer's traced root cause (`CandidateEdit.foundRoot`) must reach the
// FixGateRecord as a PASSIVE pass-through — the driver COPIES it edit→record with zero interpretation (invariant
// "the model PROPOSES/SCORES; code DECIDES/BOUNDS/LANDS"). It bridges the fixer→distiller gap: distill.ts already
// reads `foundRoot`, the CLI seam threads it into the distiller, and this test pins the one type-thread in between.
//
// The thread is CONDITIONAL: a fixer that reports no root produces a record with the `foundRoot` KEY ABSENT (not a
// present-but-empty field), so records stay byte-identical for the (common) no-root case. That absence is the load-
// bearing assertion here (`'foundRoot' in record` is false), and the mutation-verify target.
//
// Run: npx vitest run packages/core/test/optimize-distill-wire.test.ts

import { describe, it, expect } from 'vitest';
import { runFixGate, type Fixer, type ReplayScore, type PrepareCandidate, type BaseScore } from '../src/optimize/driver.js';
import type { Defect } from '../src/optimize/types.js';

const defect = (node: string, bucket: Defect['bucket'] = 'FUNCTIONALITY', symptom = `${node} broke`): Defect =>
  ({ node, bucket, symptom, evidence: [], confidence: 'high' });

const prepareCandidate: PrepareCandidate = async (d) => `cand:${d.node}`;
const base05: BaseScore = () => 0.5;
const score = (v: number | null): ReplayScore => async () => v;

const stages = (fixer: Fixer) =>
  ({ fixer, replayScore: score(0.9), prepareCandidate, baseScore: base05 });

describe('runFixGate — threads the fixer\'s foundRoot onto the record (passive pass-through)', () => {
  it('a fixer that reports foundRoot surfaces it verbatim on the record', async () => {
    const withRoot: Fixer = async () => ({ editsApplied: 1, candidatePassedProductChecks: true, tokensSpent: 3, foundRoot: 'traced: empty artifact before the write barrier' });
    const r = await runFixGate([defect('w4-execute-m2')], stages(withRoot), { autoAdopt: true });
    expect(r.records[0].foundRoot).toBe('traced: empty artifact before the write barrier');
  });

  it('a fixer that reports NO foundRoot leaves the key ABSENT on the record (not empty — records stay byte-identical when unused)', async () => {
    const noRoot: Fixer = async () => ({ editsApplied: 1, candidatePassedProductChecks: true, tokensSpent: 3 });
    const r = await runFixGate([defect('w4-execute-m2')], stages(noRoot), { autoAdopt: true });
    expect('foundRoot' in r.records[0]).toBe(false);
  });

  it('foundRoot rides EVERY landing decision, not just adopted (a discarded record still carries what the fixer found)', async () => {
    // a non-improving candidate (0.4 < base 0.5) → discarded; foundRoot is still a durable trace of the attempt.
    const discardedWithRoot: Fixer = async () => ({ editsApplied: 1, candidatePassedProductChecks: true, tokensSpent: 3, foundRoot: 'traced: race on the shared lock' });
    const r = await runFixGate([defect('w4-execute-m2')], { ...stages(discardedWithRoot), replayScore: score(0.4) });
    expect(r.records[0].landed).toBe('discarded');
    expect(r.records[0].foundRoot).toBe('traced: race on the shared lock');
  });
});
