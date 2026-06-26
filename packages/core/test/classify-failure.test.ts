import { describe, it, expect } from 'vitest';
import { classifyFailure, consultPreamble, legacyRetry } from '../src/checks.js';
import type { FailureSignals } from '../src/checks.js';

// ── classifyFailure — the failure TAXONOMY over signals the runner already computes (M4 · #6/#4) ──────
// A port of run.mjs classifyFailure: ONE classifier over EMPIRICAL signals (artifact-contract breach,
// schema breach, failed integrity check, stall/timeout, infra-noise stderr, degenerate output) — NEVER
// model self-confidence. The defect it closes (#6): today `io.retries` fires ONLY on `error`/`blocked`,
// so a QUALITY verdict (a failed `checks` verdict on an otherwise-present artifact) can never trigger a
// retry. The classifier DERIVES a `FailureClass` the retry/escalate lanes filter on. 100% GENERIC.

const base = (over: Partial<FailureSignals> = {}): FailureSignals => ({
  status: 'blocked',
  issues: [],
  summary: '',
  missing: [],
  schemaInvalid: [],
  returnSchemaInvalid: [],
  failedChecks: [],
  killedTimeout: false,
  killedStall: false,
  exitCode: 0,
  stderrTail: '',
  parsedOk: true,
  ...over,
});

describe('classifyFailure — the failure-class taxonomy (model-free)', () => {
  it('returns quality-gap on a FAILED CHECK verdict (the #6 core: a quality verdict, not error/blocked)', () => {
    // The artifact exists (no missing, no schema breach) but a declarative integrity check FAILED.
    // run.mjs called this ESCALATE; the SDK names the CLASS `quality-gap` so the retry/escalate lanes
    // can filter on it. This is the discriminating case — today `io.retries` ignores it entirely.
    const cls = classifyFailure(base({ status: 'blocked', failedChecks: [{ kind: 'fenced-tail', path: 'r.json', reason: 'tail: 1 (min 3)' }] }));
    expect(cls).toBe('quality-gap');
  });

  it('returns contract on a MISSING required artifact (the ground-truth stat breach)', () => {
    const cls = classifyFailure(base({ status: 'blocked', missing: ['verify/report.json'] }));
    expect(cls).toBe('contract');
  });

  it('returns infra on an ECONN-class stderr with a nonzero exit (transient, NOT a capability miss)', () => {
    const cls = classifyFailure(base({ status: 'error', exitCode: 1, stderrTail: 'fetch failed: ECONNRESET tunneling socket' }));
    expect(cls).toBe('infra');
  });

  it('returns schema on a schema-invalid artifact (routes to the G8 repair lane first)', () => {
    const cls = classifyFailure(base({ status: 'blocked', schemaInvalid: [{ path: 'r.json', errors: ['/x must be string'] }] }));
    expect(cls).toBe('schema');
  });

  it('returns degenerate when the model produced NO parseable return block', () => {
    const cls = classifyFailure(base({ status: 'error', exitCode: 0, parsedOk: false }));
    expect(cls).toBe('degenerate');
  });

  it('an UPSTREAM/missing-input failure classifies HALT — escalation cannot manufacture a missing input', () => {
    const cls = classifyFailure(base({ status: 'blocked', issues: ['contract breach — missing input from upstream node'] }));
    expect(cls).toBe('halt');
  });
});

describe('consultPreamble — the escalation feeds VERIFIED evidence, never a self-score', () => {
  it('names the failure class and the concrete evidence (missing artifact path)', () => {
    const pre = consultPreamble(base({ status: 'blocked', missing: ['verify/report.json'] }));
    expect(pre).toMatch(/CONSULT/);
    expect(pre).toMatch(/Failure class: contract/);
    expect(pre).toMatch(/verify\/report\.json/);
  });
});

describe('legacyRetry — io.retries reproduces today exactly', () => {
  it('maps io.retries into { max, on:[infra,degenerate] } (today: retry on error/blocked transients)', () => {
    expect(legacyRetry(2)).toEqual({ max: 2, on: ['infra', 'degenerate'] });
  });
  it('undefined/0 retries ⇒ max 0 (one attempt, today)', () => {
    expect(legacyRetry(undefined).max).toBe(0);
    expect(legacyRetry(0).max).toBe(0);
  });
});
