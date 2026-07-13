// (P3 · MUST-2) The AUTHORING/FANOUT half of the inline hitl gate. A `hitl` gate now INLINES onto its
// producer (it no longer becomes a standalone no-pi checkpoint node): the fanout carries the checkpoint +
// policy (for `node.gate`) AND emits a `retry` op-action so a REJECTED producer re-runs through the SAME
// P2 retry engine (default warm). Plus the H2 budget guard: a producer may NOT carry both a hitl gate and
// an execution retry-gate (they would draw down one shared `retriesLeft`), so that combination is a loud error.

import { describe, it, expect } from 'vitest';
import { fanoutGates, GateListError } from '../src/workflow/gate-list.js';
import type { GateEntry } from '../src/workflow/gate-list.js';

describe('fanoutGates — a hitl gate INLINES (checkpoint + policy + a reject retry action)', () => {
  it('carries the checkpoint (kind/prompt) and the hitl policy for node.gate', () => {
    const gates: GateEntry[] = [
      { type: 'hitl', question: 'Ship it?', checkpointKind: 'confirm', policy: { onFail: 'retry', max: 2, session: 'warm' } },
    ];
    const fan = fanoutGates(gates, 'producer');
    expect(fan.checkpoint?.kind).toBe('confirm');
    expect(fan.checkpoint?.prompt).toBe('Ship it?');
    expect(fan.hitlPolicy?.max, 'the hitl policy rides the fanout for node.gate').toBe(2);
  });

  it('emits a warm `retry` op-action so a rejected producer re-runs via the P2 retry engine', () => {
    const fan = fanoutGates([{ type: 'hitl', question: 'Ship it?' }], 'producer');
    const retry = fan.ops.find((o) => o.action?.kind === 'retry');
    expect(retry, 'a hitl gate must emit a retry action for the reject loop').toBeDefined();
    // Default warm (the P2 hitl default) — the reject re-run RESUMES the producer's own session.
    expect((retry!.action as { session?: string }).session).toBe('warm');
  });

  it('onFail:"block" ⇒ NO retry action (a reject just blocks the node, no re-run) but still an inline checkpoint', () => {
    const fan = fanoutGates([{ type: 'hitl', question: 'Ship it?', policy: { onFail: 'block' } }], 'producer');
    expect(fan.ops.find((o) => o.action?.kind === 'retry')).toBeUndefined();
    expect(fan.checkpoint?.kind).toBe('confirm');
  });
});

describe('fanoutGates — H2: a hitl gate + an execution retry-gate cannot share one node', () => {
  it('throws a loud GateListError (one shared retriesLeft cannot serve both budgets)', () => {
    const gates: GateEntry[] = [
      { type: 'execution', cmd: 'npm', args: ['test'], policy: { onFail: 'retry', max: 1 } },
      { type: 'hitl', question: 'Ship it?', policy: { onFail: 'retry', max: 2 } },
    ];
    expect(() => fanoutGates(gates, 'producer')).toThrow(GateListError);
  });

  it('a hitl gate alongside a NON-retry execution gate is fine — exactly ONE retry action (the hitl budget)', () => {
    const gates: GateEntry[] = [
      { type: 'execution', check: 'non-empty', path: 'out.txt' }, // onFail defaults to block ⇒ no retry action
      { type: 'hitl', question: 'Ship it?', policy: { onFail: 'retry', max: 2 } },
    ];
    const fan = fanoutGates(gates, 'producer');
    const retries = fan.ops.filter((o) => o.action?.kind === 'retry');
    expect(retries, 'exactly ONE retry action (the hitl reject budget)').toHaveLength(1);
    expect((retries[0].action as { max?: number }).max).toBe(2);
  });
});
