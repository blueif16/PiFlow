// (SA-B · expert-representations) Gate authoring → op[] — the RED-BAR tests.
//
// Each test is written against a SPECIFIC behavior this surface introduces. Every test FAILS if the
// surface is absent or wrong:
//
//   1. A judge gate lowers to a materialized judge node + a rerouteTo action op on the producer.
//   2. A retry action op defaults `scope:'feedback'` (not undefined — the default is load-bearing).
//   3. Cost-ladder ordering: deterministic (floor/execution) before judge before human.
//   4. An execution gate lowers to `op.run` + `onFailure:'block'` (the gate policy default).
//   5. A floor gate lowers to `op.gate` with the correct check kind + path.
//   6. A human gate lowers to a checkpointPatch (NO op[] entries).
//   7. `lowerGates` on a mixed list applies cost-ladder ordering then concatenates ops correctly.
//
// test-discipline contract: each assertion is a behavior claim that would FAIL if `gate-authoring.ts`
// were deleted, or if the types were wrong. No coverage gate; only behavioral correctness.

import { describe, it, expect } from 'vitest';
import {
  lowerGate,
  lowerGates,
  costLadderOrder,
  type GateAuthorSpec,
  type JudgeGate,
  type ExecutionGate,
  type FloorGate,
  type HumanGate,
} from '../src/workflow/gate-authoring.js';
import type { ActionBody } from '../src/types.js';

// ── 1 · Judge gate auto-expansion ────────────────────────────────────────────

describe('lowerGate — judge', () => {
  const judgeGate: JudgeGate = {
    kind: 'judge',
    judgeTier: 'deliberate',
    rubric: 'The output must be a complete, well-structured analysis with at least three sections.',
    threshold: 'pass',
    policy: { onFail: 'retry', retryMax: 2, retryScope: 'feedback' },
  };

  it('emits a materialized judge node (not hidden — explicit in the DAG)', () => {
    const { judgeNode } = lowerGate(judgeGate, 'produce');
    expect(judgeNode, 'judge gate MUST materialize a judge node').toBeDefined();
    expect(judgeNode!.agentType).toBe('judge');
    expect(judgeNode!.tier).toBe('deliberate');
    expect(judgeNode!.label).toContain('produce');
  });

  it('embeds the rubric and threshold in the judge node prompt', () => {
    const { judgeNode } = lowerGate(judgeGate, 'produce');
    expect(judgeNode!.prompt).toContain(judgeGate.rubric);
    expect(judgeNode!.prompt).toContain('pass');
  });

  it('emits a rerouteTo action op targeting the producer', () => {
    const { ops } = lowerGate(judgeGate, 'produce');
    const rerouteOp = ops.find((o) => o.action?.kind === 'rerouteTo');
    expect(rerouteOp, 'judge gate MUST emit a rerouteTo action op').toBeDefined();
    const action = rerouteOp!.action as Extract<ActionBody, { kind: 'rerouteTo' }>;
    expect(action.node).toBe('produce');
    expect(action.max).toBe(2); // from policy.retryMax
  });

  it('does NOT emit op.run or op.gate entries (judge is a separate node, not an op predicate)', () => {
    const { ops } = lowerGate(judgeGate, 'produce');
    expect(ops.every((o) => !o.run && !o.gate)).toBe(true);
  });
});

// ── 2 · retry.scope defaults to 'feedback' ───────────────────────────────────

describe('ActionBody retry.scope — default feedback', () => {
  it('an execution gate with retry policy emits scope:"feedback" by default', () => {
    const gate: ExecutionGate = {
      kind: 'execution',
      cmd: 'npm',
      args: ['test'],
      policy: { onFail: 'retry', retryMax: 1 }, // no retryScope set
    };
    const { ops } = lowerGate(gate, 'executor');
    const retryOp = ops.find((o) => o.action?.kind === 'retry');
    expect(retryOp, 'retry action op must be emitted').toBeDefined();
    const action = retryOp!.action as Extract<ActionBody, { kind: 'retry' }>;
    // The default MUST be 'feedback' — if scope is undefined the SA-D warm-resume wiring would
    // default incorrectly (missing the contractual default).
    expect(action.scope).toBe('feedback');
  });

  it('an execution gate with explicit scope:"fix" preserves it (L2 stub seam)', () => {
    const gate: ExecutionGate = {
      kind: 'execution',
      cmd: 'cargo',
      args: ['test'],
      policy: { onFail: 'retry', retryMax: 1, retryScope: 'fix' },
    };
    const { ops } = lowerGate(gate, 'executor');
    const retryOp = ops.find((o) => o.action?.kind === 'retry');
    const action = retryOp!.action as Extract<ActionBody, { kind: 'retry' }>;
    expect(action.scope).toBe('fix');
  });

  it('ActionBody retry type accepts scope field (type-level: would be a compile error without the field)', () => {
    // This tests the TYPE, not just the runtime. The cast would fail at compile time if the field
    // doesn't exist on the retry variant — vitest runs tsc via the build step.
    const retryAction: ActionBody = { kind: 'retry', max: 2, scope: 'feedback' };
    expect(retryAction).toMatchObject({ kind: 'retry', scope: 'feedback' });
  });
});

// ── 3 · Cost-ladder ordering ─────────────────────────────────────────────────

describe('costLadderOrder', () => {
  it('deterministic gates come before judge before human (fail fast, spend a person last)', () => {
    const gates: GateAuthorSpec[] = [
      { kind: 'human', question: 'Approve?' },
      { kind: 'judge', judgeTier: 'deliberate', rubric: 'is it good?' },
      { kind: 'floor', check: 'non-empty' },
      { kind: 'execution', cmd: 'npm', args: ['test'] },
    ];
    const ordered = costLadderOrder(gates);
    const kinds = ordered.map((g) => g.kind);
    // floor and execution (both deterministic) must precede judge, which must precede human.
    const judgeIdx = kinds.indexOf('judge');
    const humanIdx = kinds.indexOf('human');
    const floorIdx = kinds.indexOf('floor');
    const execIdx = kinds.indexOf('execution');
    expect(floorIdx).toBeLessThan(judgeIdx);
    expect(execIdx).toBeLessThan(judgeIdx);
    expect(judgeIdx).toBeLessThan(humanIdx);
  });

  it('stable sort: same-tier gates keep authored order', () => {
    const gates: GateAuthorSpec[] = [
      { kind: 'floor', check: 'non-empty', path: 'a.txt' },
      { kind: 'floor', check: 'json-parses', path: 'b.json' },
    ];
    const ordered = costLadderOrder(gates);
    expect((ordered[0] as FloorGate).path).toBe('a.txt');
    expect((ordered[1] as FloorGate).path).toBe('b.json');
  });
});

// ── 4 · Execution gate lowering ──────────────────────────────────────────────

describe('lowerGate — execution', () => {
  it('lowers to op.run with cmd/args and onFailure:block (default policy)', () => {
    const gate: ExecutionGate = { kind: 'execution', cmd: 'pytest', args: ['tests/'] };
    const { ops, judgeNode, checkpointPatch } = lowerGate(gate, 'coder');
    expect(judgeNode).toBeUndefined();
    expect(checkpointPatch).toBeUndefined();
    expect(ops).toHaveLength(1);
    expect(ops[0].run).toEqual({ cmd: 'pytest', args: ['tests/'] });
    expect(ops[0].onFailure).toBe('block');
    expect(ops[0].when).toBe('post');
  });

  it('passes cwd when provided', () => {
    const gate: ExecutionGate = { kind: 'execution', cmd: 'npm', args: ['test'], cwd: '/workspace' };
    const { ops } = lowerGate(gate, 'coder');
    expect((ops[0].run as { cwd?: string }).cwd).toBe('/workspace');
  });
});

// ── 5 · Floor gate lowering ───────────────────────────────────────────────────

describe('lowerGate — floor', () => {
  it('lowers to op.gate with the correct check kind and path', () => {
    const gate: FloorGate = { kind: 'floor', check: 'fenced-tail', path: 'out/result.md' };
    const { ops } = lowerGate(gate, 'writer');
    expect(ops).toHaveLength(1);
    expect(ops[0].gate?.kind).toBe('fenced-tail');
    expect(ops[0].gate?.path).toBe('out/result.md');
    expect(ops[0].when).toBe('post');
  });

  it('sets advisory flag when floor gate is non-blocking', () => {
    const gate: FloorGate = { kind: 'floor', check: 'non-empty', advisory: true };
    const { ops } = lowerGate(gate, 'writer');
    expect(ops[0].gate?.advisory).toBe(true);
  });
});

// ── 6 · Human gate lowering ───────────────────────────────────────────────────

describe('lowerGate — human', () => {
  it('lowers to a checkpointPatch and NO op[] entries (human gate = G5 checkpoint)', () => {
    const gate: HumanGate = { kind: 'human', question: 'Does this output meet the bar?', checkpointKind: 'confirm' };
    const { ops, judgeNode, checkpointPatch } = lowerGate(gate, 'producer');
    expect(ops).toHaveLength(0);
    expect(judgeNode).toBeUndefined();
    expect(checkpointPatch).toBeDefined();
    expect(checkpointPatch!.kind).toBe('confirm');
    expect(checkpointPatch!.prompt).toBe('Does this output meet the bar?');
  });

  it('passes choices through for select checkpoints', () => {
    const gate: HumanGate = {
      kind: 'human',
      question: 'Approve or revise?',
      checkpointKind: 'select',
      choices: ['approve', 'revise'],
    };
    const { checkpointPatch } = lowerGate(gate, 'producer');
    expect(checkpointPatch!.choices).toEqual(['approve', 'revise']);
  });
});

// ── 7 · lowerGates (mixed pipeline) ──────────────────────────────────────────

describe('lowerGates — mixed gate pipeline', () => {
  it('cost-ladder orders then concatenates ops; emits one judgeNode + one checkpointPatch', () => {
    const gates: GateAuthorSpec[] = [
      // Authored in "wrong" order — human first, then judge, then floor.
      { kind: 'human', question: 'Final approval?' },
      {
        kind: 'judge',
        judgeTier: 'deliberate',
        rubric: 'Is the analysis complete?',
        policy: { onFail: 'retry', retryMax: 1 },
      },
      { kind: 'floor', check: 'json-parses', path: 'out/report.json' },
    ];

    const result = lowerGates(gates, 'analyst');

    // judgeNode and checkpointPatch must both be present.
    expect(result.judgeNode).toBeDefined();
    expect(result.checkpointPatch).toBeDefined();

    // The ops must contain: floor op.gate + judge rerouteTo action. Human has no ops.
    const gateOps = result.ops.filter((o) => o.gate);
    const actionOps = result.ops.filter((o) => o.action?.kind === 'rerouteTo');
    expect(gateOps).toHaveLength(1);
    expect(gateOps[0].gate?.kind).toBe('json-parses');
    expect(actionOps).toHaveLength(1);

    // Cost-ladder: floor op must precede the rerouteTo (judge) action op.
    const floorIdx = result.ops.findIndex((o) => o.gate?.kind === 'json-parses');
    const rerouteIdx = result.ops.findIndex((o) => o.action?.kind === 'rerouteTo');
    expect(floorIdx).toBeLessThan(rerouteIdx);
  });
});
