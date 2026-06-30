// Contract for optimize/driver.ts — the FIX→GATE overlord (v1.5 §6). DETERMINISTIC control flow; the model
// (fixer) + the scorer (replayScore) are INJECTED stages. The driver decides/bounds/records; it NEVER
// mutates the live file (the fixer writes to a candidate COPY ref; physical adopt is land.ts). Invariants
// under test: candidate-copy discipline, strict-improvement accept via the gate, per-target auto-adopt
// (ARCH never auto-adopts; default OFF stages), the rejected-edit buffer, and the edit/token HARD CAPS.
//
// Run: npx vitest run packages/core/test/optimize-driver.test.ts

import { describe, it, expect } from 'vitest';
import { runFixGate, type Fixer, type ReplayScore, type PrepareCandidate, type BaseScore } from '../src/optimize/driver.js';
import type { Defect } from '../src/optimize/types.js';

const defect = (node: string, bucket: Defect['bucket'] = 'FUNCTIONALITY', symptom = `${node} broke`): Defect =>
  ({ node, bucket, symptom, evidence: [], confidence: 'high' });

const prepareCandidate: PrepareCandidate = async (d) => `cand:${d.node}`; // a COPY ref, never 'live'
const okFixer: Fixer = async () => ({ editsApplied: 1, candidatePassedProductChecks: true, tokensSpent: 10 });
const base05: BaseScore = () => 0.5;
const score = (v: number | null): ReplayScore => async () => v;

const stages = (replayScore: ReplayScore, fixer: Fixer = okFixer, baseScore: BaseScore = base05) =>
  ({ fixer, replayScore, prepareCandidate, baseScore });

describe('runFixGate — the deterministic overlord', () => {
  it('an accepted FUNCTIONALITY edit auto-ADOPTS only when the auto_adopt flag is set', async () => {
    const r = await runFixGate([defect('w4-execute-m2')], stages(score(0.9)), { autoAdopt: true });
    expect(r.records[0].landed).toBe('adopted');
    expect(r.records[0].candidateRef).toBe('cand:w4-execute-m2'); // edits went to the COPY, never live
    expect(r.accepted).toBe(1);
  });

  it('with auto_adopt OFF (the default), an accepted edit STAGES for the human', async () => {
    const r = await runFixGate([defect('w4-execute-m2')], stages(score(0.9)));
    expect(r.records[0].landed).toBe('staged');
  });

  it('ARCH never auto-adopts even with the flag on (structural → human)', async () => {
    const r = await runFixGate([defect('downstream', 'ARCH')], stages(score(0.9)), { autoAdopt: true });
    expect(r.records[0].landed).toBe('staged');
  });

  it('a non-improving candidate is DISCARDED and its key enters the rejected-edit buffer', async () => {
    const buffer = new Set<string>();
    const r = await runFixGate([defect('w4-execute-m2')], stages(score(0.4)), { rejectedBuffer: buffer });
    expect(r.records[0].landed).toBe('discarded');
    expect(r.accepted).toBe(0);
    expect(buffer.size).toBe(1);
  });

  it('a defect already in the rejected buffer is SKIPPED (never re-proposed)', async () => {
    const dead = defect('w4-execute-m2');
    const buffer = new Set<string>([`${dead.node}::${dead.bucket}::${dead.symptom}`]);
    const r = await runFixGate([dead, defect('w4-execute-m3')], stages(score(0.9)), { rejectedBuffer: buffer, autoAdopt: true });
    expect(r.records.map((x) => x.node)).toEqual(['w4-execute-m3']); // the dead one never attempted
    expect(r.attempted).toBe(1);
  });

  it('stops at the edit_budget (the cost bound), reporting the reason', async () => {
    const ds = [defect('a'), defect('b'), defect('c')];
    const r = await runFixGate(ds, stages(score(0.9)), { editBudget: 2, autoAdopt: true });
    expect(r.attempted).toBe(2);
    expect(r.records).toHaveLength(2);
    expect(r.stoppedReason).toBe('edit-budget');
  });

  it('stops when the token_budget is exhausted', async () => {
    const ds = [defect('a'), defect('b'), defect('c')];
    const r = await runFixGate(ds, stages(score(0.9), async () => ({ editsApplied: 1, candidatePassedProductChecks: true, tokensSpent: 60 })), { tokenBudget: 100, editBudget: 99 });
    expect(r.attempted).toBe(2); // a:0<100 → 60; b:60<100 → 120; c:120≥100 → stop
    expect(r.stoppedReason).toBe('token-budget');
  });

  it('a FUNCTIONALITY candidate that improves the score but FAILS product checks is discarded (stricter gate)', async () => {
    const failChecks: Fixer = async () => ({ editsApplied: 1, candidatePassedProductChecks: false, tokensSpent: 5 });
    const r = await runFixGate([defect('w4-execute-m2')], stages(score(0.9), failChecks), { autoAdopt: true });
    expect(r.records[0].landed).toBe('discarded');
  });
});
