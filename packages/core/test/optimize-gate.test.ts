// Contract for optimize/gate.ts — the across-run ACCEPT gate (v1.5 §2, §6). PURE arithmetic over
// model-produced scores; this gate (not the round count) is what stops drift. The invariants it encodes,
// verbatim from SkillOpt's working loop:
//   • accept = "≥1 edit applied AND candidate > base" — STRICT improvement only.
//   • FUNCTIONALITY carries a STRICTER gate (v1.5 §3 ③): the product's own build/tests MUST also pass.
//   • NEVER judge-gated: an unmeasurable/abstained score cannot auto-accept → routes to the human.
//   • per-target LAND policy: ARCH (structural) always routes to the heavyweight human gate.
//
// One case is grounded in the REAL gs01 M2 report (base) so the gate is validated on game-omni Tier-1 data.
//
// Run: npx vitest run packages/core/test/optimize-gate.test.ts

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGate } from '../src/optimize/gate.js';
import { readVerifyReport } from '../src/optimize/tier1.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const m2 = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'optimize', 'gs01', 'verify', 'report.M2.json'), 'utf8'));

describe('evaluateGate — the strict-improvement accept gate', () => {
  it('accepts a strict improvement on a FUNCTIONALITY fix whose product checks pass', () => {
    const v = evaluateGate({ bucket: 'FUNCTIONALITY', base: 0.5, candidate: 0.8, editsApplied: 1, candidatePassedProductChecks: true });
    expect(v.accept).toBe(true);
    expect(v.delta).toBeCloseTo(0.3, 5);
    expect(v.landPolicy).toBe('auto-adopt-eligible');
  });

  it('rejects an EQUAL score — improvement must be STRICT (the anti-drift ratchet)', () => {
    expect(evaluateGate({ bucket: 'SKILL', base: 0.5, candidate: 0.5, editsApplied: 1 }).accept).toBe(false);
  });

  it('rejects a regression', () => {
    expect(evaluateGate({ bucket: 'SKILL', base: 0.8, candidate: 0.5, editsApplied: 1 }).accept).toBe(false);
  });

  it('rejects when no edit was applied (even if the score looks better)', () => {
    expect(evaluateGate({ bucket: 'SKILL', base: 0.5, candidate: 0.9, editsApplied: 0 }).accept).toBe(false);
  });

  it('FUNCTIONALITY: a score improvement is NOT enough — the product build/tests must also pass', () => {
    const v = evaluateGate({ bucket: 'FUNCTIONALITY', base: 0.5, candidate: 0.9, editsApplied: 1, candidatePassedProductChecks: false });
    expect(v.accept).toBe(false);
    expect(v.reason.toLowerCase()).toContain('product');
  });

  it('SKILL: a strict improvement accepts with no product-check requirement', () => {
    expect(evaluateGate({ bucket: 'SKILL', base: 0.4, candidate: 0.6, editsApplied: 1 }).accept).toBe(true);
  });

  it('ARCH: even an accepted improvement routes to the human (structural gate)', () => {
    const v = evaluateGate({ bucket: 'ARCH', base: 0.4, candidate: 0.9, editsApplied: 1 });
    expect(v.accept).toBe(true);
    expect(v.landPolicy).toBe('stage-for-human');
  });

  it('an unmeasurable/abstained score cannot auto-accept — it routes to the human (never judge-gated)', () => {
    const v = evaluateGate({ bucket: 'FUNCTIONALITY', base: null, candidate: 0.9, editsApplied: 1, candidatePassedProductChecks: true });
    expect(v.accept).toBe(false);
    expect(v.landPolicy).toBe('stage-for-human');
  });

  it('grounded on real gs01: base=M2 (degraded fail, scalar 0) → a fixed candidate (scalar 1) is accepted', () => {
    const base = readVerifyReport(m2).scalar; // the real recorded M2 = 0
    expect(base).toBe(0);
    const fixed = readVerifyReport({ milestoneId: 'M2', marker: 'VALIDATION_PASSED', passed: true, fidelity: [{ id: 'M2-A3', status: 'pass' }, { id: 'M2-A1', status: 'pass' }] }).scalar; // = 1
    expect(fixed).toBe(1);
    const v = evaluateGate({ bucket: 'FUNCTIONALITY', base, candidate: fixed, editsApplied: 1, candidatePassedProductChecks: true });
    expect(v.accept).toBe(true);
    expect(v.delta).toBe(1);
  });
});
