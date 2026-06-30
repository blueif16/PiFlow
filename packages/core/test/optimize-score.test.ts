// Contract for optimize/score.ts — the PURE fold: fold(Tier-0 disqualifier × Tier-1 value) → NodeScore[]
// (v1.5 §7). Tests the fold over hand-built RunDigest + Tier-1 inputs (the recorded gs01 .pi trace is 7.8MB
// and not committed; the fold logic is what must fail when wrong). The load-bearing rules under test:
// ABSTAIN ≠ low score, and a Tier-0 disqualifier OVERRIDES a Tier-1 abstain.
//
// Run: npx vitest run packages/core/test/optimize-score.test.ts

import { describe, it, expect } from 'vitest';
import { scoreNodes } from '../src/optimize/score.js';
import type { RunDigest, NodeDigest, AnomalyKind } from '../src/observe/telemetry.js';
import type { Tier1Result } from '../src/optimize/types.js';

// minimal NodeDigest builder — the fold reads only id/outcome/anomalies; the rest is filler.
function dnode(id: string, outcome: string, anomalies: AnomalyKind[] = []): NodeDigest {
  return {
    id, label: id, phase: null, outcome, model: null, provider: null,
    durationMs: null, expectedMs: null, slowRatio: null,
    inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, contextWindow: null, contextPct: null,
    modelCalls: 0, toolCalls: 0, topTools: {}, maxToolRepeat: 0, repeatedTool: null,
    retries: 0, stopReason: null, truncated: false, missing: [], issues: [], anomalies,
  };
}
function digestOf(nodes: NodeDigest[]): RunDigest {
  return {
    run: 'gs01', done: true, ok: true, durationMs: 1,
    totals: { nodes: nodes.length, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
    nodes, anomalies: [], rootCauses: [],
  };
}
const t1 = (p: Partial<Tier1Result>): Tier1Result =>
  ({ milestoneId: 'M', marker: p.passed ? 'VALIDATION_PASSED' : 'VALIDATION_FAILED', passed: false, abstained: false, checks: [], scalar: 0, ...p });

describe('scoreNodes', () => {
  it('a clean node with a FAILING Tier-1 carries the tier-1 scalar, not abstained', () => {
    const digest = digestOf([dnode('w4-execute-m2', 'ok')]);
    const tier1 = new Map([['w4-execute-m2', t1({ milestoneId: 'M2', passed: false, scalar: 0.75 })]]);
    const [s] = scoreNodes({ digest, tier1ByNode: tier1 });
    expect(s.node).toBe('w4-execute-m2');
    expect(s.tier0.disqualified).toBe(false);
    expect(s.abstained).toBe(false);
    expect(s.scalar).toBeCloseTo(0.75, 5);
  });

  it('a node with no Tier-1 and no anomaly is not measured and not a problem (scalar null, not abstained)', () => {
    const digest = digestOf([dnode('w0-classify', 'ok')]);
    const [s] = scoreNodes({ digest, tier1ByNode: new Map() });
    expect(s.scalar).toBeNull();
    expect(s.abstained).toBe(false);
    expect(s.tier0.disqualified).toBe(false);
  });

  it('a structural Tier-0 anomaly disqualifies (scalar 0)', () => {
    const digest = digestOf([dnode('boot', 'error', ['failed'])]);
    const [s] = scoreNodes({ digest, tier1ByNode: new Map() });
    expect(s.tier0.disqualified).toBe(true);
    expect(s.tier0.anomalies).toContain('failed');
    expect(s.scalar).toBe(0);
  });

  it('Tier-1 abstain (measure could not run) ⇒ scalar null + abstained, NEVER a low score', () => {
    const digest = digestOf([dnode('w4-execute-m3', 'ok')]);
    const tier1 = new Map([['w4-execute-m3', t1({ milestoneId: 'M3', passed: false, abstained: true })]]);
    const [s] = scoreNodes({ digest, tier1ByNode: tier1 });
    expect(s.abstained).toBe(true);
    expect(s.scalar).toBeNull();
  });

  it('a Tier-0 disqualifier OVERRIDES a Tier-1 abstain (the disqualifier is real; score is 0, not abstained)', () => {
    const digest = digestOf([dnode('w4-execute-m3', 'error', ['failed'])]);
    const tier1 = new Map([['w4-execute-m3', t1({ milestoneId: 'M3', passed: false, abstained: true })]]);
    const [s] = scoreNodes({ digest, tier1ByNode: tier1 });
    expect(s.abstained).toBe(false);
    expect(s.tier0.disqualified).toBe(true);
    expect(s.scalar).toBe(0);
  });

  it('soft risk signals (slow/retries) do NOT disqualify on their own', () => {
    const digest = digestOf([dnode('slowish', 'ok', ['slow', 'retries'])]);
    const [s] = scoreNodes({ digest, tier1ByNode: new Map() });
    expect(s.tier0.disqualified).toBe(false);
    expect(s.tier0.anomalies).toEqual(['slow', 'retries']);
  });
});
