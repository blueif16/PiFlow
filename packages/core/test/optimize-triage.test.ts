// Contract for optimize/triage.ts — the four-way credit-assignment projector (v1.5 §3, §7). It turns
// NodeScore[] + the run digest into the worklist (Defect[]), deciding {LAPSE, SKILL, FUNCTIONALITY, ARCH}
// from OBSERVABLE signals only, defaulting toward the lowest blast radius (LAPSE) when unsure, and naming
// the missing signal rather than mis-attributing. The headline: a clean node whose Tier-1 outcome FAILED is
// FUNCTIONALITY (the product code is wrong) — NOT the LAPSE default. This is exactly gs01's two findings.
//
// Run: npx vitest run packages/core/test/optimize-triage.test.ts

import { describe, it, expect } from 'vitest';
import { triage } from '../src/optimize/triage.js';
import type { RunDigest, RootCause, NodeDigest } from '../src/observe/telemetry.js';
import type { NodeScore, Tier1Result, Tier1Check } from '../src/optimize/types.js';

const cleanTier0 = { anomalies: [] as never[], disqualified: false };
const t1 = (p: Partial<Tier1Result> & { checks: Tier1Check[] }): Tier1Result =>
  ({ milestoneId: 'M', marker: 'VALIDATION_FAILED', passed: false, abstained: false, scalar: 0, ...p });
const digestWith = (rootCauses: RootCause[], nodes: NodeDigest[] = []): RunDigest =>
  ({ run: 'gs01', done: true, ok: false, durationMs: 1,
    totals: { nodes: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
    nodes, anomalies: [], rootCauses });

/** A minimal NodeDigest carrying only `id` + `issues` (the fields the structural-signal reader needs). */
const nodeDigest = (id: string, issues: string[]): NodeDigest => ({
  id, label: id, phase: null, outcome: 'error', model: null, provider: null,
  durationMs: null, expectedMs: null, slowRatio: null, inputTokens: 0, outputTokens: 0, cost: 0,
  contextPeak: 0, contextWindow: null, contextPct: null, modelCalls: 0, toolCalls: 0, topTools: {},
  maxToolRepeat: 0, repeatedTool: null, retries: 0, stopReason: null, truncated: false,
  missing: [], issues, anomalies: ['failed'],
});

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

  it('surfaces the Tier-1 consoleErrors into a FUNCTIONALITY defect evidence (so the fixer sees the runtime crash)', () => {
    // The masking-crash signal lives in consoleErrors, not the per-check arrays. Without this the fixer patches
    // the wrong thing (gs01 M3: 7 candidates, all 0.5455, none fixed the actual TypeError).
    const scores: NodeScore[] = [{
      node: 'w4-execute-m3', tier0: cleanTier0, abstained: false, scalar: 0.55,
      tier1: t1({ milestoneId: 'M3',
        checks: [{ id: 'M3-A1', gate: 'fidelity', passed: false }],
        consoleErrors: ["TypeError: Cannot read properties of undefined (reading 'entries')"] }),
    }];
    const [d] = triage(scores, digestWith([]));
    expect(d.bucket).toBe('FUNCTIONALITY');
    expect(d.evidence.join('\n')).toContain("TypeError: Cannot read properties of undefined (reading 'entries')");
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

  it('a RECURRING signature flips LAPSE→SKILL (the recurrence signal is now present)', () => {
    const scores: NodeScore[] = [{
      node: 'flaky', tier0: { anomalies: ['failed'], disqualified: true, reason: 'failed' }, abstained: false, scalar: 0,
      tier1: null,
    }];
    const recurrence = new Map([
      ['flaky::failed', { count: 1, lesson: { prevention: 'guard the null case', okfSlice: 'runner' } }],
    ]);
    const [d] = triage(
      scores,
      digestWith([{ failed: 'flaky', earliestUpstream: 'flaky', viaPath: '', chain: ['flaky'] }]),
      { recurrence },
    );
    expect(d.bucket).toBe('SKILL');
    expect(d.confidence).toBe('medium');
    const ev = d.evidence.join('\n');
    expect(ev).toContain('recurrence:1');
    expect(ev).toContain('guard the null case');
    expect(ev).toContain('[[runner]]');
    expect(d.needsSignal).toBeUndefined(); // the signal is present now — no mis-attribution deferral
  });

  it('a SKILL defect carries a STRUCTURED scope — recurrence + lesson + the [[okf-slice]] POINTER (not just evidence strings)', () => {
    // The fixer reads the lesson as first-class data, not by re-parsing `code-map: [[key]]` out of evidence.
    // Core PINS the pointer here (the okfSlice KEY, un-bracketed); the CLI resolves it to the code-map body
    // downstream (resolve-at-read, never a stored copy) — so `codeMap` stays undefined at this boundary.
    const scores: NodeScore[] = [{
      node: 'flaky', tier0: { anomalies: ['failed'], disqualified: true, reason: 'failed' }, abstained: false, scalar: 0,
      tier1: null,
    }];
    const recurrence = new Map([
      ['flaky::failed', { count: 3, lesson: { root: 'unguarded null on the destroyed-group read', prevention: 'guard the null case', okfSlice: 'runner' } }],
    ]);
    const [d] = triage(
      scores,
      digestWith([{ failed: 'flaky', earliestUpstream: 'flaky', viaPath: '', chain: ['flaky'] }]),
      { recurrence },
    );
    expect(d.bucket).toBe('SKILL');
    expect(d.scope).toBeDefined();
    expect(d.scope?.recurrence).toBe(3);
    expect(d.scope?.root).toBe('unguarded null on the destroyed-group read');
    expect(d.scope?.prevention).toBe('guard the null case');
    expect(d.scope?.okfSlice).toBe('runner'); // the PINNED pointer — the KEY, no [[ ]] wrapping
    expect(d.scope?.codeMap).toBeUndefined(); // core pins the pointer; the CLI resolves the body (boundary)
  });

  it('a signature BELOW the recurrence threshold stays LAPSE (count:0)', () => {
    const scores: NodeScore[] = [{
      node: 'flaky', tier0: { anomalies: ['failed'], disqualified: true, reason: 'failed' }, abstained: false, scalar: 0,
      tier1: null,
    }];
    const recurrence = new Map([['flaky::failed', { count: 0 }]]);
    const [d] = triage(
      scores,
      digestWith([{ failed: 'flaky', earliestUpstream: 'flaky', viaPath: '', chain: ['flaky'] }]),
      { recurrence },
    );
    expect(d.bucket).toBe('LAPSE');
    expect(d.needsSignal).toBeTruthy();
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

  // ── STRUCTURAL COVERAGE — a self-originating failure whose OWN recorded issues name a code/contract-level
  // cause (a skill-staging race, a schema breach, a skipped schema gate, a watchdog kill) must NOT collapse
  // into the generic "no code-level signal" LAPSE default — it is a concrete, actionable signal the fixer can
  // act on directly. Proven gap: this exact combination (status:error + a staging-failure issue) was previously
  // invisible in the worklist (bucketed LAPSE with no trace of the actual cause).
  it('a staging-race failure (status:error + a staging issue string) is FUNCTIONALITY, not the LAPSE default', () => {
    const scores: NodeScore[] = [{
      node: 'stage-skill', tier0: { anomalies: ['failed'], disqualified: true, reason: 'failed' }, abstained: false, scalar: 0,
      tier1: null,
    }];
    const digest = digestWith([], [nodeDigest('stage-skill', ['node failed: ENOENT staging skill dir — race with a concurrent stage'])]);
    const [d] = triage(scores, digest);
    expect(d.bucket).not.toBe('LAPSE');
    expect(['FUNCTIONALITY', 'ARCH']).toContain(d.bucket);
    expect(d.evidence.join('\n')).toContain('staging');
    expect(d.needsSignal).toBeUndefined(); // a concrete signal is present — no mis-attribution deferral
  });

  it('a schema-contract breach issue is FUNCTIONALITY, not the LAPSE default', () => {
    const scores: NodeScore[] = [{
      node: 'bad-artifact', tier0: { anomalies: ['failed'], disqualified: true, reason: 'failed' }, abstained: false, scalar: 0,
      tier1: null,
    }];
    const digest = digestWith([], [nodeDigest('bad-artifact', ['contract breach — artifact(s) violate the declared schema: out.json [must be object]'])]);
    const [d] = triage(scores, digest);
    expect(d.bucket).toBe('FUNCTIONALITY');
    expect(d.evidence.join('\n')).toContain('contract breach');
  });

  it('a watchdog-killed node (killedStall/killedTimeout issue text) is FUNCTIONALITY, not the LAPSE default', () => {
    const scores: NodeScore[] = [{
      node: 'stuck', tier0: { anomalies: ['failed'], disqualified: true, reason: 'failed' }, abstained: false, scalar: 0,
      tier1: null,
    }];
    const digest = digestWith([], [nodeDigest('stuck', ['killed: silent stall'])]);
    const [d] = triage(scores, digest);
    expect(d.bucket).toBe('FUNCTIONALITY');
    expect(d.evidence.join('\n')).toContain('killed: silent stall');
  });

  it('a bare structural failure with NO recorded issue text still defaults to LAPSE (no regression)', () => {
    // Same shape as the "defaults to LAPSE" test above, but now digest.nodes carries an entry with NO
    // structural-signal text — proves the new reader does not over-fire on an unrelated/empty issues list.
    const scores: NodeScore[] = [{
      node: 'flaky', tier0: { anomalies: ['failed'], disqualified: true, reason: 'failed' }, abstained: false, scalar: 0,
      tier1: null,
    }];
    const digest = digestWith(
      [{ failed: 'flaky', earliestUpstream: 'flaky', viaPath: '', chain: ['flaky'] }],
      [nodeDigest('flaky', [])],
    );
    const [d] = triage(scores, digest);
    expect(d.bucket).toBe('LAPSE');
    expect(d.needsSignal).toBeTruthy();
  });
});
