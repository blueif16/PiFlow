// Contract for the SDK-level fix-cycle ceiling in optimize/driver.ts — the DETERMINISTIC per-node re-attempt
// bound the overlord delegates to. It caps how many times we re-attempt a fix on the SAME node across
// `optimize --fix` invocations, so a structurally-unfixable node ESCALATES (is skipped + surfaced) instead of
// looping forever. The bound is OPTIONAL and product-agnostic: core NEVER persists the counter — it reads/bumps
// through two injected stages (readFixCycles/bumpFixCycles). The persisted file is the ONLY cross-invocation
// state and it lives PRODUCT-SIDE (boundary law: @piflow/core is logic only).
//
// The ten behaviors this pins (RED-first, watch each fail for the right reason):
//   1. a node AT/OVER the ceiling is NOT attempted (no fixer-started), emits fix-cycle-ceiling, and appears
//      in result.skipped.
//   2. a node UNDER the ceiling runs the fixer normally, no fix-cycle-ceiling event.
//   3. a REAL failed fix (non-improving, editsApplied>=1) bumps the counter exactly once; a 0-edit/aborted
//      proposal does NOT bump.
//   4. an ACCEPTED fix does NOT bump.
//   5. persistence across invocations: two sequential runFixGate calls sharing one counter — call 1 bumps,
//      call 2 sees the higher count and skips at the ceiling.
//   6/7 are asserted in the driver-events PURITY test + here (BOUNDARY: core touches no fs for the counter —
//      the injected in-memory counter is the ONLY writer).
//
// Run: npx vitest run packages/core/test/optimize-fix-cycle.test.ts

import { describe, it, expect, vi } from 'vitest';
import { runFixGate, type Fixer, type ReplayScore, type PrepareCandidate, type BaseScore, type FixGateStages } from '../src/optimize/driver.js';
import type { OptimizeEvent } from '../src/optimize/events.js';
import type { Defect } from '../src/optimize/types.js';

const defect = (node: string, bucket: Defect['bucket'] = 'FUNCTIONALITY', symptom = `${node} broke`): Defect =>
  ({ node, bucket, symptom, evidence: [], confidence: 'high' });

const prepareCandidate: PrepareCandidate = async (d) => `cand:${d.node}`;
const base0: BaseScore = () => 0;
const score = (v: number | null): ReplayScore => async () => v;
// a fixer that applies N edits and passes product checks (so ACCEPT is possible on a strict improvement).
const editingFixer = (edits: number): Fixer => async () => ({ editsApplied: edits, candidatePassedProductChecks: true, tokensSpent: 1 });

/** An in-memory per-node counter — the fake the test injects in place of the product's file-backed sidecar. */
function fakeCounter(seed: Record<string, number> = {}) {
  const counts: Record<string, number> = { ...seed };
  return {
    counts,
    readFixCycles: (node: string) => counts[node] ?? 0,
    bumpFixCycles: (node: string) => { counts[node] = (counts[node] ?? 0) + 1; },
  };
}

/** compose the ceiling stages onto the base stages. */
const stagesWithCounter = (
  c: { readFixCycles: (n: string) => number; bumpFixCycles: (n: string) => void },
  replayScore: ReplayScore,
  fixer: Fixer,
): FixGateStages => ({ fixer, replayScore, prepareCandidate, baseScore: base0, readFixCycles: c.readFixCycles, bumpFixCycles: c.bumpFixCycles });

describe('runFixGate — fix-cycle ceiling (per-node re-attempt bound)', () => {
  it('1. a node AT the ceiling is NOT attempted: no fixer-started, emits fix-cycle-ceiling, appears in result.skipped', async () => {
    const c = fakeCounter({ 'w4-execute-m2': 3 }); // already at the ceiling
    const events: OptimizeEvent[] = [];
    const spyFixer = vi.fn(editingFixer(1));
    const r = await runFixGate(
      [defect('w4-execute-m2')],
      stagesWithCounter(c, score(0), spyFixer),
      { fixCycleCeiling: 3, onEvent: (e) => events.push(e) },
    );

    expect(spyFixer).not.toHaveBeenCalled(); // the fixer never ran
    expect(events.some((e) => e.type === 'fixer-started')).toBe(false);
    const ceil = events.find((e) => e.type === 'fix-cycle-ceiling');
    expect(ceil).toBeDefined();
    if (ceil && ceil.type === 'fix-cycle-ceiling') {
      expect(ceil.node).toBe('w4-execute-m2');
      expect(ceil.cycles).toBe(3);
      expect(ceil.ceiling).toBe(3);
    }
    expect(r.skipped).toEqual([{ node: 'w4-execute-m2', cycles: 3, ceiling: 3 }]);
    expect(r.records).toHaveLength(0);   // no candidate record for a skip
    expect(r.attempted).toBe(0);         // a skip does not consume the edit budget
  });

  it('1b. a node OVER the ceiling is also skipped', async () => {
    const c = fakeCounter({ n: 5 });
    const spyFixer = vi.fn(editingFixer(1));
    const r = await runFixGate([defect('n')], stagesWithCounter(c, score(0), spyFixer), { fixCycleCeiling: 3 });
    expect(spyFixer).not.toHaveBeenCalled();
    expect(r.skipped).toEqual([{ node: 'n', cycles: 5, ceiling: 3 }]);
  });

  it('2. a node UNDER the ceiling runs the fixer normally, no fix-cycle-ceiling event', async () => {
    const c = fakeCounter({ 'w4-execute-m2': 2 }); // under 3
    const events: OptimizeEvent[] = [];
    const spyFixer = vi.fn(editingFixer(1));
    await runFixGate([defect('w4-execute-m2')], stagesWithCounter(c, score(1), spyFixer), { fixCycleCeiling: 3, onEvent: (e) => events.push(e) });
    expect(spyFixer).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'fixer-started')).toBe(true);
    expect(events.some((e) => e.type === 'fix-cycle-ceiling')).toBe(false);
  });

  it('3. a REAL failed fix (non-improving, editsApplied>=1) bumps the counter exactly once', async () => {
    const c = fakeCounter(); // starts at 0
    // score 0 vs base 0 → no strict improvement → reject; the fixer applied 1 real edit → a consumed attempt.
    await runFixGate([defect('n')], stagesWithCounter(c, score(0), editingFixer(1)), { fixCycleCeiling: 3 });
    expect(c.counts.n).toBe(1);
  });

  it('3b. a 0-edit proposal does NOT bump the counter (no real attempt was spent)', async () => {
    const c = fakeCounter();
    await runFixGate([defect('n')], stagesWithCounter(c, score(0), editingFixer(0)), { fixCycleCeiling: 3 });
    expect(c.counts.n ?? 0).toBe(0);
  });

  it('3c. an ABORTED (0-edit) fixer does NOT bump the counter', async () => {
    const c = fakeCounter();
    const abortingFixer: Fixer = async () => ({ editsApplied: 0, aborted: { reason: 'no-progress' } });
    await runFixGate([defect('n')], stagesWithCounter(c, score(0), abortingFixer), { fixCycleCeiling: 3 });
    expect(c.counts.n ?? 0).toBe(0);
  });

  it('4. an ACCEPTED fix does NOT bump the counter (only a failed fix consumes budget)', async () => {
    const c = fakeCounter();
    // score 1 vs base 0 → strict improvement, FUNCTIONALITY passes product checks → accept.
    const r = await runFixGate([defect('n')], stagesWithCounter(c, score(1), editingFixer(1)), { fixCycleCeiling: 3 });
    expect(r.accepted).toBe(1);
    expect(c.counts.n ?? 0).toBe(0);
  });

  it('5. persistence across invocations: call 1 bumps, call 2 (sharing the counter) skips at the ceiling', async () => {
    const c = fakeCounter({ n: 2 }); // one failed fix away from the ceiling
    const spy1 = vi.fn(editingFixer(1));
    await runFixGate([defect('n')], stagesWithCounter(c, score(0), spy1), { fixCycleCeiling: 3 });
    expect(spy1).toHaveBeenCalledTimes(1);     // ran (2 < 3), failed, bumped → 3
    expect(c.counts.n).toBe(3);

    const spy2 = vi.fn(editingFixer(1));
    const events: OptimizeEvent[] = [];
    const r2 = await runFixGate([defect('n')], stagesWithCounter(c, score(0), spy2), { fixCycleCeiling: 3, onEvent: (e) => events.push(e) });
    expect(spy2).not.toHaveBeenCalled();       // now at the ceiling → skipped
    expect(events.some((e) => e.type === 'fix-cycle-ceiling')).toBe(true);
    expect(r2.skipped).toEqual([{ node: 'n', cycles: 3, ceiling: 3 }]);
  });

  it('6. INACTIVE when the ceiling is set but the stages are absent (both stages required to activate)', async () => {
    // ceiling set, but NO readFixCycles/bumpFixCycles stages → 100% backward-compatible: the fixer runs.
    const spyFixer = vi.fn(editingFixer(1));
    const r = await runFixGate(
      [defect('n')],
      { fixer: spyFixer, replayScore: score(0), prepareCandidate, baseScore: base0 },
      { fixCycleCeiling: 3 },
    );
    expect(spyFixer).toHaveBeenCalledTimes(1);
    expect(r.skipped).toEqual([]);
  });

  it('6b. INACTIVE when the stages are present but no ceiling is set (opt-in requires the ceiling)', async () => {
    const c = fakeCounter({ n: 99 }); // way over any plausible ceiling
    const spyFixer = vi.fn(editingFixer(1));
    await runFixGate([defect('n')], stagesWithCounter(c, score(1), spyFixer), {}); // no fixCycleCeiling
    expect(spyFixer).toHaveBeenCalledTimes(1); // no ceiling ⇒ the counter is never consulted
  });

  it('7. BOUNDARY: core touches no fs for the counter — the injected bump is the ONLY writer', async () => {
    // Two-pronged boundary check (boundary law: @piflow/core is logic only — it must never persist the counter):
    // (a) BEHAVIOURAL — a full active-ceiling round (skip on n1, bump on n2) mutates ONLY the injected in-memory
    //     counter; the counter file lives product-side, so core has nothing to write.
    const c = fakeCounter({ n1: 3 }); // n1 at ceiling → skip; n2 under → run + failed → bump
    await runFixGate(
      [defect('n1'), defect('n2')],
      stagesWithCounter(c, score(0), editingFixer(1)),
      { fixCycleCeiling: 3 },
    );
    expect(c.counts.n1).toBe(3);          // untouched (skipped, no bump)
    expect(c.counts.n2).toBe(1);          // the injected bump fired exactly once

    // (b) STRUCTURAL — the driver module source imports nothing from node:fs / node:path (it is pure logic).
    //     This is the load-bearing guard: it goes RED the instant someone makes core read/write a counter file.
    const src = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../src/optimize/driver.ts', import.meta.url), 'utf8'));
    expect(src).not.toMatch(/from ['"]node:fs['"]/);
    expect(src).not.toMatch(/from ['"]node:path['"]/);
  });
});
