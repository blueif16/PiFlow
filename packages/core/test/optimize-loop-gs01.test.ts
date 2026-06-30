// Dry end-to-end (deterministic) — the v1.5 §6 loop shape composed over the gs01 worklist:
//   SCORE (scoreNodes) → TRIAGE (four-way) → FIX→GATE (runFixGate, injected stub stages).
// Proves the control plane composes and obeys the gate: a fixer that improves the held-out score lands
// (auto_adopt) / stages (default); a fixer that does not is discarded and never re-proposed. The fixer +
// scorer are STUBS here — the live fixer (a context-isolated subagent editing the gallery_shooter module)
// and the live re-verify (runMilestoneVerify2 on a held-out slice) wire behind these same interfaces.
//
// Run: npx vitest run packages/core/test/optimize-loop-gs01.test.ts

import { describe, it, expect } from 'vitest';
import { scoreNodes, triage, runFixGate } from '../src/optimize/index.js';
import type { Fixer, ReplayScore, PrepareCandidate, BaseScore } from '../src/optimize/driver.js';
import type { RunDigest, NodeDigest } from '../src/observe/telemetry.js';
import type { Tier1Result, Tier1Check, NodeScore } from '../src/optimize/types.js';

const dnode = (id: string): NodeDigest => ({
  id, label: id, phase: null, outcome: 'ok', model: null, provider: null,
  durationMs: null, expectedMs: null, slowRatio: null, inputTokens: 0, outputTokens: 0, cost: 0,
  contextPeak: 0, contextWindow: null, contextPct: null, modelCalls: 0, toolCalls: 0, topTools: {},
  maxToolRepeat: 0, repeatedTool: null, retries: 0, stopReason: null, truncated: false, missing: [], issues: [], anomalies: [],
});
const digest: RunDigest = {
  run: 'gs01', done: true, ok: true, durationMs: 1,
  totals: { nodes: 2, ok: 2, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
  nodes: [dnode('w4-execute-m2'), dnode('w4-execute-m3')], anomalies: [], rootCauses: [],
};
const t1 = (milestoneId: string, checks: Tier1Check[]): Tier1Result =>
  ({ milestoneId, marker: 'VALIDATION_FAILED', passed: false, abstained: false, checks, scalar: checks.filter((c) => c.passed).length / checks.length });
const tier1ByNode = new Map<string, Tier1Result>([
  ['w4-execute-m2', t1('M2', [{ id: 'M2-A3', gate: 'fidelity', passed: false }, { id: 'M2-A1', gate: 'fidelity', passed: true }])],
  ['w4-execute-m3', t1('M3', [{ id: 'M3-A1', gate: 'fidelity', passed: false }, { id: 'completability', gate: 'completability', passed: false }])],
]);

// the SCORE→TRIAGE prefix is shared by every case below.
const scores: NodeScore[] = scoreNodes({ digest, tier1ByNode });
const defects = triage(scores, digest);
const baseScore: BaseScore = (node) => scores.find((s) => s.node === node)?.scalar ?? null;
const prepareCandidate: PrepareCandidate = async (d) => `cand:${d.node}`;

describe('the FIX→GATE loop over the gs01 worklist', () => {
  it('triage hands FIX two FUNCTIONALITY defects (the score→triage prefix holds)', () => {
    expect(defects.map((d) => d.node).sort()).toEqual(['w4-execute-m2', 'w4-execute-m3']);
    expect(defects.every((d) => d.bucket === 'FUNCTIONALITY')).toBe(true);
  });

  it('a fixer that lifts the held-out score (and passes product checks) ADOPTS under auto_adopt', async () => {
    const fixer: Fixer = async () => ({ editsApplied: 1, candidatePassedProductChecks: true, tokensSpent: 100 });
    const replayScore: ReplayScore = async () => 1.0; // the candidate now passes its milestone
    const r = await runFixGate(defects, { fixer, replayScore, prepareCandidate, baseScore }, { autoAdopt: true });
    expect(r.accepted).toBe(2);
    expect(r.records.every((x) => x.landed === 'adopted')).toBe(true);
    expect(r.records.every((x) => x.candidateRef.startsWith('cand:'))).toBe(true); // edits hit the COPY, never live
    expect(r.records.every((x) => (x.verdict.delta ?? 0) > 0)).toBe(true);
  });

  it('a fixer that does NOT improve the score is discarded and buffered (no drift)', async () => {
    const fixer: Fixer = async () => ({ editsApplied: 1, candidatePassedProductChecks: true, tokensSpent: 100 });
    const replayScore: ReplayScore = async (node) => baseScore(node); // same score → no strict improvement
    const buffer = new Set<string>();
    const r = await runFixGate(defects, { fixer, replayScore, prepareCandidate, baseScore }, { autoAdopt: true, rejectedBuffer: buffer });
    expect(r.accepted).toBe(0);
    expect(r.records.every((x) => x.landed === 'discarded')).toBe(true);
    expect(buffer.size).toBe(2); // both dead edits remembered
  });
});
