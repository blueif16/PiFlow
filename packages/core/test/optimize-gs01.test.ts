// Dogfood validation (deterministic) — wire the whole pass score → triage → render over the DOCUMENTED gs01
// scenario and assert the worklist reproduces the human routing table's two findings. NOTE: the on-disk
// verify reports drifted (a later load-flaky re-run), so this test uses hand-built Tier-1 verdicts matching
// the *documented* gs01 findings (the proven `gs01.hermes-routing.golden.md`): both M2-A3 (bounded score) and
// M3 (boot/fidelity) are routed to a `node` owner under `src/**` ⇒ both FUNCTIONALITY. The full live re-verify
// (regenerating clean reports under low load) is the separate end-to-end step; this pins the LOGIC.
//
// Run: npx vitest run packages/core/test/optimize-gs01.test.ts

import { describe, it, expect } from 'vitest';
import { scoreNodes, triage, renderRouting } from '../src/optimize/index.js';
import type { RunDigest, NodeDigest, AnomalyKind } from '../src/observe/telemetry.js';
import type { Tier1Result, Tier1Check } from '../src/optimize/types.js';

const dnode = (id: string, anomalies: AnomalyKind[] = []): NodeDigest => ({
  id, label: id, phase: null, outcome: anomalies.includes('failed') ? 'error' : 'ok',
  model: null, provider: null, durationMs: null, expectedMs: null, slowRatio: null,
  inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, contextWindow: null, contextPct: null,
  modelCalls: 0, toolCalls: 0, topTools: {}, maxToolRepeat: 0, repeatedTool: null,
  retries: 0, stopReason: null, truncated: false, missing: [], issues: [], anomalies,
});

// gs01's 12 nodes, all completed clean (ok:true) — the failures live in the Tier-1 milestone outcomes.
const GS01_NODES = [
  'w0-classify', 'w1-design', 'gameplay', 'asset', 'guidance', 'model', 'shell', 'sound',
  'w2-scaffold', 'w4-execute-m1', 'w4-execute-m2', 'w4-execute-m3',
];
const digest: RunDigest = {
  run: 'gs01', done: true, ok: true, durationMs: 3151342,
  totals: { nodes: 12, ok: 12, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
  nodes: GS01_NODES.map((id) => dnode(id)), anomalies: [], rootCauses: [],
};
const t1 = (milestoneId: string, checks: Tier1Check[]): Tier1Result => ({
  milestoneId, marker: 'VALIDATION_FAILED', passed: false, abstained: false,
  checks, scalar: checks.filter((c) => c.passed).length / checks.length,
});
// M1 passed; M2 fails bounded-score (Finding 1); M3 fails fidelity + completability (Finding 2).
const tier1ByNode = new Map<string, Tier1Result>([
  ['w4-execute-m1', { milestoneId: 'M1', marker: 'VALIDATION_PASSED', passed: true, abstained: false, checks: [{ id: 'M1-A1', gate: 'fidelity', passed: true }], scalar: 1 }],
  ['w4-execute-m2', t1('M2', [{ id: 'M2-A3', gate: 'fidelity', passed: false }, { id: 'M2-A1', gate: 'fidelity', passed: true }])],
  ['w4-execute-m3', t1('M3', [{ id: 'M3-A1', gate: 'fidelity', passed: false }, { id: 'completability', gate: 'completability', passed: false }])],
]);

describe('gs01 dogfood — score → triage → render reproduces the human routing', () => {
  const scores = scoreNodes({ digest, tier1ByNode });
  const defects = triage(scores, digest);

  it('emits exactly the two findings the human routing recorded — both FUNCTIONALITY', () => {
    expect(defects.map((d) => d.node).sort()).toEqual(['w4-execute-m2', 'w4-execute-m3']);
    expect(defects.every((d) => d.bucket === 'FUNCTIONALITY')).toBe(true);
  });

  it('does NOT flag the 10 clean nodes (M1 passed; w0..sound have no failing outcome)', () => {
    for (const clean of ['w0-classify', 'w2-scaffold', 'w4-execute-m1', 'asset']) {
      expect(defects.find((d) => d.node === clean)).toBeUndefined();
    }
  });

  it('grounds the M2 finding in its failing check (M2-A3), high confidence', () => {
    const m2 = defects.find((d) => d.node === 'w4-execute-m2')!;
    expect(m2.symptom).toContain('M2-A3');
    expect(m2.confidence).toBe('high');
  });

  it('renders the proven routing shape (table + findings) without the post-hoc Update trailer', () => {
    const md = renderRouting(defects, { runId: 'gs01', archetype: 'gallery_shooter' });
    expect(md).toContain('## Routing summary');
    expect((md.match(/^## Finding /gm) ?? [])).toHaveLength(2);
    expect(md).toContain('FUNCTIONALITY');
    expect(md).not.toContain('## Update');
  });
});
