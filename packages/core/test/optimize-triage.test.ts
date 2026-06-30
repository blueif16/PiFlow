// Contract for optimize/triage.ts — the four-way credit-assignment projector (v1.5 §3, §7). It turns
// NodeScore[] + the run digest into the worklist (Defect[]), deciding {LAPSE, SKILL, FUNCTIONALITY, ARCH}
// from OBSERVABLE signals only, defaulting toward the lowest blast radius (LAPSE) when unsure, and naming
// the missing signal rather than mis-attributing. The headline: a clean node whose Tier-1 outcome FAILED is
// FUNCTIONALITY (the product code is wrong) — NOT the LAPSE default. This is exactly gs01's two findings.
//
// Run: npx vitest run packages/core/test/optimize-triage.test.ts

import { describe, it, expect } from 'vitest';
import { triage } from '../src/optimize/triage.js';
import type { RunDigest, RootCause } from '../src/observe/telemetry.js';
import type { NodeScore, Tier1Result, Tier1Check } from '../src/optimize/types.js';

const cleanTier0 = { anomalies: [] as never[], disqualified: false };
const t1 = (p: Partial<Tier1Result> & { checks: Tier1Check[] }): Tier1Result =>
  ({ milestoneId: 'M', marker: 'VALIDATION_FAILED', passed: false, abstained: false, scalar: 0, ...p });
const digestWith = (rootCauses: RootCause[]): RunDigest =>
  ({ run: 'gs01', done: true, ok: false, durationMs: 1,
    totals: { nodes: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
    nodes: [], anomalies: [], rootCauses });

describe('triage — the four-way projector', () => {
  it('a clean node with a FAILING Tier-1 outcome is FUNCTIONALITY (not the LAPSE default) — the gs01 case', () => {
    const scores: NodeScore[] = [{
      node: 'w4-execute-m2', tier0: cleanTier0, abstained: false, scalar: 0.5,
      tier1: t1({ milestoneId: 'M2', checks: [
        { id: 'M2-A3', gate: 'fidelity', passed: false },
        { id: 'M2-A1', gate: 'fidelity', passed: true },
      ] }),
    }];
    const defects = triage(scores, digestWith([]));
    expect(defects).toHaveLength(1);
    const d = defects[0];
    expect(d.node).toBe('w4-execute-m2');
    expect(d.bucket).toBe('FUNCTIONALITY');
    expect(d.confidence).toBe('high'); // a checkable runtime outcome failed
    expect(d.symptom).toContain('M2-A3');
    expect(d.evidence.join(' ')).toContain('M2-A3');
  });

  it('an ABSTAINED node is NOT a defect (route to re-measure / human, never to a fixer)', () => {
    const scores: NodeScore[] = [{
      node: 'w4-execute-m3', tier0: cleanTier0, abstained: true, scalar: null,
      tier1: t1({ milestoneId: 'M3', abstained: true, checks: [] }),
    }];
    expect(triage(scores, digestWith([]))).toHaveLength(0);
  });

  it('a clean node with a PASSING Tier-1 (and no anomaly) is not a defect', () => {
    const scores: NodeScore[] = [{
      node: 'w4-execute-m1', tier0: cleanTier0, abstained: false, scalar: 1,
      tier1: t1({ milestoneId: 'M1', marker: 'VALIDATION_PASSED', passed: true, scalar: 1, checks: [{ id: 'M1-A1', gate: 'fidelity', passed: true }] }),
    }];
    expect(triage(scores, digestWith([]))).toHaveLength(0);
  });

  it('a self-originating structural failure with no code signal defaults to LAPSE and names the missing signal', () => {
    const scores: NodeScore[] = [{
      node: 'flaky', tier0: { anomalies: ['failed'], disqualified: true, reason: 'failed' }, abstained: false, scalar: 0,
      tier1: null,
    }];
    const [d] = triage(scores, digestWith([{ failed: 'flaky', earliestUpstream: 'flaky', viaPath: '', chain: ['flaky'] }]));
    expect(d.bucket).toBe('LAPSE');
    expect(d.confidence).toBe('low');
    expect(d.needsSignal).toBeTruthy(); // names cross-run recurrence / prose-judge, never mis-attributes SKILL
  });

  it('a failure that originated UPSTREAM (cross-node chain) is ARCH (route up to reconcile)', () => {
    const scores: NodeScore[] = [{
      node: 'downstream', tier0: { anomalies: ['failed'], disqualified: true, reason: 'failed' }, abstained: false, scalar: 0,
      tier1: null,
    }];
    const chain: RootCause = { failed: 'downstream', earliestUpstream: 'upstream', viaPath: 'spec/blueprint.json', chain: ['upstream', 'downstream'] };
    const [d] = triage(scores, digestWith([chain]));
    expect(d.bucket).toBe('ARCH');
    expect(d.evidence.join(' ')).toContain('upstream');
  });
});
