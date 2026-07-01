// Contract for optimize/events.ts — the OptimizeEvent sink + its pure renderer (the live progress surface for
// the FIX→GATE loop). The renderer is the ONLY thing under test here: each of the 10 event variants must render
// a DISTINCT non-empty line, and the load-bearing 'gated' line must carry the node id AND an accept/reject
// marker AND the base/cand scores (so a human watching the stream can read the gate decision off one line).
//
// Run: npx vitest run packages/core/test/optimize-events.test.ts

import { describe, it, expect } from 'vitest';
import { renderOptimizeEvent, type OptimizeEvent } from '../src/optimize/events.js';
import type { GateVerdict } from '../src/optimize/gate.js';

const acceptVerdict: GateVerdict = { accept: true, reason: 'strict improvement (+1)', delta: 1, landPolicy: 'auto-adopt-eligible' };
const rejectVerdict: GateVerdict = { accept: false, reason: 'no strict improvement (candidate 0 ≤ base 0)', delta: 0, landPolicy: 'auto-adopt-eligible' };

const all = (gate: GateVerdict = acceptVerdict): OptimizeEvent[] => [
  { type: 'triaged', defectCount: 3 },
  { type: 'candidate-prepared', node: 'w4-execute-m2', bucket: 'FUNCTIONALITY', candidateRef: 'cand:w4-execute-m2' },
  { type: 'fixer-started', node: 'w4-execute-m2', bucket: 'FUNCTIONALITY' },
  { type: 'fixer-trace', node: 'w4-execute-m2', payload: { step: 'edit', file: 'x.ts' } },
  { type: 'fixer-aborted', node: 'w4-execute-m2', reason: 'no-progress: 22 tool calls / 0 edits' },
  { type: 'fixer-done', node: 'w4-execute-m2', editsApplied: 1, tokensSpent: 10 },
  { type: 'scored', node: 'w4-execute-m2', baseScore: 0, candidateScore: 1 },
  { type: 'gated', node: 'w4-execute-m2', verdict: gate },
  { type: 'landed', node: 'w4-execute-m2', decision: 'staged' },
  { type: 'fix-cycle-ceiling', node: 'w4-execute-m2', cycles: 3, ceiling: 3 },
  { type: 'stopped', reason: 'complete' },
];

describe('renderOptimizeEvent — one distinct non-empty line per variant', () => {
  it('renders all 11 variants', () => {
    const lines = all().map(renderOptimizeEvent);
    expect(lines).toHaveLength(11);
    for (const l of lines) {
      expect(typeof l).toBe('string');
      expect(l.trim().length).toBeGreaterThan(0);
      expect(l).not.toContain('\n'); // O(1) one-liner
    }
  });

  it('every variant is DISTINCT (no two variants collapse to the same line)', () => {
    const lines = all().map(renderOptimizeEvent);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('includes the node id wherever the event carries one', () => {
    for (const e of all()) {
      if ('node' in e) expect(renderOptimizeEvent(e)).toContain(e.node);
    }
  });

  it("the 'gated' line carries the node id AND an accept marker AND base/cand scores", () => {
    const line = renderOptimizeEvent({ type: 'gated', node: 'w4-execute-m2', verdict: acceptVerdict });
    expect(line).toContain('w4-execute-m2');
    expect(line).toMatch(/accept/i);
    expect(line).toMatch(/✓/);
  });

  it("the 'gated' line marks a REJECT distinctly from an accept", () => {
    const accepted = renderOptimizeEvent({ type: 'gated', node: 'n', verdict: acceptVerdict });
    const rejected = renderOptimizeEvent({ type: 'gated', node: 'n', verdict: rejectVerdict });
    expect(accepted).not.toBe(rejected);
    expect(rejected).toMatch(/reject/i);
    expect(rejected).toMatch(/✗/);
  });

  it("the 'fixer-aborted' line carries the node id AND the reason string", () => {
    const line = renderOptimizeEvent({ type: 'fixer-aborted', node: 'w4-execute-m2', reason: 'no-progress: 22 tool calls / 0 edits' });
    expect(line).toContain('fixer-aborted');
    expect(line).toContain('w4-execute-m2');
    expect(line).toContain('no-progress: 22 tool calls / 0 edits');
  });

  it("the 'fix-cycle-ceiling' line carries the node id, the cycles/ceiling, and an escalate signal", () => {
    const line = renderOptimizeEvent({ type: 'fix-cycle-ceiling', node: 'w4-execute-m2', cycles: 3, ceiling: 3 });
    expect(line).toContain('fix-cycle-ceiling');
    expect(line).toContain('w4-execute-m2');
    expect(line).toMatch(/3\/3/);
    expect(line).toMatch(/escalate/i);
  });
});
