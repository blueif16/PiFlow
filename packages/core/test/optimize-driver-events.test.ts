// Contract for the OptimizeEventSink wiring in optimize/driver.ts (v1.5 §6). runFixGate must emit a LIVE
// progress event at every phase boundary of the FIX→GATE loop, in a fixed order, WITHOUT changing the
// control flow / gate / caps / land policy. Three properties pin the seam:
//   1. ORDER — for one accepted defect whose fixer emits two sub-traces, the emitted type sequence is EXACTLY
//      triaged → candidate-prepared → fixer-started → (fixer-trace × 2, BETWEEN started and done) → fixer-done
//      → scored → gated → landed → stopped, and scored carries base 0 / cand 1.
//   2. PURITY — running with vs without onEvent yields a deep-equal FixGateResult (the sink is fire-and-forget).
//   3. ROBUSTNESS — a sink that THROWS does not throw out of runFixGate (the loop is never broken by stdout).
//
// Run: npx vitest run packages/core/test/optimize-driver-events.test.ts

import { describe, it, expect } from 'vitest';
import { runFixGate, type Fixer, type ReplayScore, type PrepareCandidate, type BaseScore } from '../src/optimize/driver.js';
import type { OptimizeEvent } from '../src/optimize/events.js';
import type { Defect } from '../src/optimize/types.js';

const defect = (node: string, bucket: Defect['bucket'] = 'FUNCTIONALITY', symptom = `${node} broke`): Defect =>
  ({ node, bucket, symptom, evidence: [], confidence: 'high' });

const prepareCandidate: PrepareCandidate = async (d) => `cand:${d.node}`;
// the fixer emits TWO opaque sub-traces through ctx.emit, then reports one edit.
const tracingFixer: Fixer = async (_d, ctx) => {
  ctx.emit?.({ step: 'plan' });
  ctx.emit?.({ step: 'edit', file: 'x.ts' });
  return { editsApplied: 1, candidatePassedProductChecks: true, tokensSpent: 10 };
};
const base0: BaseScore = () => 0;
const score = (v: number | null): ReplayScore => async () => v;
const stages = (replayScore: ReplayScore, fixer: Fixer = tracingFixer, baseScore: BaseScore = base0) =>
  ({ fixer, replayScore, prepareCandidate, baseScore });

describe('runFixGate — OptimizeEventSink wiring', () => {
  it('emits the events in EXACTLY the phase order, with the two fixer-traces between started and done', async () => {
    const events: OptimizeEvent[] = [];
    await runFixGate([defect('w4-execute-m2')], stages(score(1)), { onEvent: (e) => events.push(e) });

    expect(events.map((e) => e.type)).toEqual([
      'triaged', 'candidate-prepared', 'fixer-started', 'fixer-trace', 'fixer-trace', 'fixer-done',
      'scored', 'gated', 'landed', 'stopped',
    ]);
  });

  it("the 'scored' event carries baseScore 0 and candidateScore 1", () => {
    return (async () => {
      const events: OptimizeEvent[] = [];
      await runFixGate([defect('w4-execute-m2')], stages(score(1)), { onEvent: (e) => events.push(e) });
      const scored = events.find((e) => e.type === 'scored');
      expect(scored).toBeDefined();
      if (scored && scored.type === 'scored') {
        expect(scored.baseScore).toBe(0);
        expect(scored.candidateScore).toBe(1);
      }
    })();
  });

  it('the fixer-trace events carry the node id and the opaque payload the fixer passed', async () => {
    const events: OptimizeEvent[] = [];
    await runFixGate([defect('w4-execute-m2')], stages(score(1)), { onEvent: (e) => events.push(e) });
    const traces = events.filter((e) => e.type === 'fixer-trace');
    expect(traces).toHaveLength(2);
    for (const t of traces) if (t.type === 'fixer-trace') expect(t.node).toBe('w4-execute-m2');
    if (traces[1].type === 'fixer-trace') expect(traces[1].payload).toEqual({ step: 'edit', file: 'x.ts' });
  });

  it('PURITY: the FixGateResult is byte-identical with vs without onEvent', async () => {
    const defects = [defect('a'), defect('b', 'ARCH'), defect('c')];
    const withSink = await runFixGate(defects, stages(score(1)), { onEvent: () => {}, autoAdopt: true });
    const without = await runFixGate(defects, stages(score(1)), { autoAdopt: true });
    expect(withSink).toEqual(without);
  });

  it('BACKWARD-COMPAT: with no ceiling stages/opt, the fix-cycle surface is inert (skipped is always [])', async () => {
    // The additive fix-cycle ceiling must not perturb the default path: absent the stages + opts.fixCycleCeiling,
    // every run reports an EMPTY skipped[] and never emits a fix-cycle-ceiling event.
    const events: OptimizeEvent[] = [];
    const r = await runFixGate([defect('a'), defect('b'), defect('c')], stages(score(0)), { onEvent: (e) => events.push(e) });
    expect(r.skipped).toEqual([]);
    expect(events.some((e) => e.type === 'fix-cycle-ceiling')).toBe(false);
  });

  it('ROBUSTNESS: an onEvent that THROWS does not break the loop', async () => {
    const r = await runFixGate([defect('w4-execute-m2')], stages(score(1)), {
      onEvent: () => { throw new Error('sink blew up'); },
    });
    // the loop completed normally despite the throwing sink.
    expect(r.records).toHaveLength(1);
    expect(r.stoppedReason).toBe('complete');
  });

  it("a discarded (non-improving) defect still emits gated + landed='discarded'", async () => {
    const events: OptimizeEvent[] = [];
    await runFixGate([defect('w4-execute-m2')], stages(score(0)), { onEvent: (e) => events.push(e) });
    const landed = events.find((e) => e.type === 'landed');
    expect(landed && landed.type === 'landed' ? landed.decision : null).toBe('discarded');
  });

  it("an ABORTED fixer emits a first-class 'fixer-aborted' event carrying the reason — and the loop still completes", async () => {
    // The fixer reports the watchdog/timeout cutoff STRUCTURALLY (a typed return field), not smuggled in summary.
    // The driver surfaces it as its OWN portable event so the control plane keys on it without sniffing the
    // opaque emit payload. An aborted fixer is just a 0-edit proposal: the loop must still score/gate/stop.
    const abortReason = 'no-progress: 22 tool calls / 0 edits';
    const abortingFixer: Fixer = async () => ({ editsApplied: 0, aborted: { reason: abortReason } });
    const events: OptimizeEvent[] = [];
    await runFixGate([defect('w4-execute-m2')], stages(score(0), abortingFixer), { onEvent: (e) => events.push(e) });

    // (a) the portable abort event fired, BEFORE fixer-done, carrying node + the product-specific reason string.
    const aborted = events.find((e) => e.type === 'fixer-aborted');
    expect(aborted).toBeDefined();
    if (aborted && aborted.type === 'fixer-aborted') {
      expect(aborted.node).toBe('w4-execute-m2');
      expect(aborted.reason).toBe(abortReason);
    }
    const types = events.map((e) => e.type);
    expect(types.indexOf('fixer-aborted')).toBeLessThan(types.indexOf('fixer-done'));
    // (b) the loop still completed all the way to stopped (an aborted fixer is a 0-edit proposal the gate rejects).
    expect(types).toContain('stopped');
    expect(types).toContain('gated');
    expect(types).toContain('landed');
  });

  it("a NON-aborted fixer emits NO 'fixer-aborted' event (the signal is absent unless the fixer set it)", async () => {
    const events: OptimizeEvent[] = [];
    await runFixGate([defect('w4-execute-m2')], stages(score(1)), { onEvent: (e) => events.push(e) });
    expect(events.some((e) => e.type === 'fixer-aborted')).toBe(false);
  });
});
