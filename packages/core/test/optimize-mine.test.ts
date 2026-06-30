// Contract for optimize/mine.ts — the default trace task-miner (piflow-memory-v1.5 §5.1, "mine a checkable
// task from a node's run trace"). This is the MINING half of the game-omni replay binding; the FOLDING half is
// makeReplayStages (replay.ts). It mirrors score.ts's established pattern: a PRODUCT-AGNOSTIC mechanism with a
// game-omni DEFAULT config, injectable. The miner reads the incumbent's recorded report from the trace
// (verify/report.M{k}.json — the SAME layout score.ts's readRecordedVerifyReports already owns) and emits a
// CheckableTask; it does NOT import game-omni code (the live oracle does that). oracleInput carries only
// { milestoneId } — blueprint + assertions are re-read by the oracle from the candidate copy, so no
// blueprint-path knowledge accretes here.
//
// LOAD-BEARING: the `split` tag the miner stamps is what the gate's VAL-hygiene keys on — a mined task flows
// into makeReplayStages and a 'train' tag must make baseScore refuse (proven below).
//
// Run: npx vitest run packages/core/test/optimize-mine.test.ts

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mineTaskFromTrace, gameOmniNodeToMilestone } from '../src/optimize/mine.js';
import { makeReplayStages, type ReplayOracle, type CopyScope } from '../src/optimize/replay.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GS01 = path.join(HERE, 'fixtures', 'optimize', 'gs01'); // real trace: verify/report.M{1,2,3}.json

// doubles for the parts the miner does NOT exercise (baseScore reads the mined baseReport, never the oracle).
const deadOracle: ReplayOracle = async () => { throw new Error('oracle must not be called by baseScore'); };
const copyScope: CopyScope = async (node) => `cand:${node}`;

describe('gameOmniNodeToMilestone — the node→milestone map (inverse of score.ts gameOmniMilestoneToNode)', () => {
  it('maps a w4-execute milestone node to its milestone id', () => {
    expect(gameOmniNodeToMilestone('w4-execute-m2')).toBe('M2');
  });
  it('returns null for a node that produces no milestone', () => {
    expect(gameOmniNodeToMilestone('w0-classify')).toBeNull();
  });
});

describe('mineTaskFromTrace — the default trace task-miner', () => {
  it('mines a val CheckableTask for a mapped node with a recorded report', () => {
    const task = mineTaskFromTrace(GS01)('w4-execute-m2');
    expect(task).not.toBeNull();
    expect(task!.id).toBe('gs01:M2');
    expect(task!.node).toBe('w4-execute-m2');
    expect(task!.split).toBe('val'); // game-omni's prompt-suites are held-out by convention → val
    expect(task!.oracleInput).toEqual({ milestoneId: 'M2' }); // blueprint/assertions re-read by the oracle, not serialized here
    // baseReport is the PARSED recorded report (the real degraded gs01 M2), not a path.
    expect((task!.baseReport as { marker: string }).marker).toBe('VALIDATION_FAILED');
  });

  it('returns null for a node with no milestone mapping (nothing to replay)', () => {
    expect(mineTaskFromTrace(GS01)('w0-classify')).toBeNull();
  });

  it('returns null for a mapped node whose recorded report is absent (no incumbent to gate against)', () => {
    expect(mineTaskFromTrace(GS01)('w4-execute-m9')).toBeNull(); // no verify/report.M9.json in the trace
  });

  it('honors a custom nodeToMilestone override (other products inject their own)', () => {
    const task = mineTaskFromTrace(GS01, { nodeToMilestone: (n) => (n === 'build' ? 'M3' : null) })('build');
    expect(task!.oracleInput).toEqual({ milestoneId: 'M3' });
    expect(task!.node).toBe('build');
  });

  it('a custom split classifier flows onto the mined task', () => {
    const task = mineTaskFromTrace(GS01, { split: () => 'train' })('w4-execute-m2');
    expect(task!.split).toBe('train');
  });
});

describe('mined task → makeReplayStages (the binding mining half, end to end on a real trace)', () => {
  it('baseScore folds the incumbent report MINED from the real gs01 trace (degraded M2 → 0)', () => {
    const { baseScore } = makeReplayStages({ oracle: deadOracle, mineTask: mineTaskFromTrace(GS01), copyScope });
    expect(baseScore('w4-execute-m2')).toBe(0); // the real recorded M2 (self-fix exhausted) → marker fallback 0
    expect(baseScore('w0-classify')).toBeNull(); // unmapped node → nothing to score
  });

  it('a train-tagged mined task makes baseScore throw VAL-hygiene (the split flows from mining to the gate)', () => {
    const { baseScore } = makeReplayStages({ oracle: deadOracle, mineTask: mineTaskFromTrace(GS01, { split: () => 'train' }), copyScope });
    expect(() => baseScore('w4-execute-m2')).toThrow(/val/i);
  });
});
