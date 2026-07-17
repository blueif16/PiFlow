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

  it('carries FAILED POST-OP GATE evidence — the op detail (check output incl. its suggestion) rides the critique', () => {
    // Live 260715-01/gameplay: the merge gates failed with actionable stderr (capability-refs suggestion,
    // distribution details) but the critique never carried it — the retry was told nothing fixable.
    const detail = "merge run failed (exit 1): [capability-refs] '$custom:Bad' at mechanics[4] — closest registered id: 'good-id'";
    const pre = consultPreamble(base({ opFailures: [detail] }));
    expect(pre).toMatch(/failed post-op gate/);
    expect(pre).toContain("closest registered id: 'good-id'");
    expect(pre).toMatch(/Failure class: quality-gap/);
  });

  it('parsedOk true (a claude tail parsed via the driver returnBlock) gets no degenerate class and no "no parseable" complaint', () => {
    // Claude now parses its fenced return tail off the result event's OWN text (claude-code.ts parseResult),
    // so `parsedOk` is genuinely "did a return block parse" for EVERY executor — not neutered true for claude.
    // A node that parsed a tail (whatever its outcome) must never be told it produced nothing parseable.
    const pre = consultPreamble(base({ opFailures: ['merge run failed (exit 1): kind-monotony'], parsedOk: true }));
    const cls = classifyFailure(base({ opFailures: ['merge run failed (exit 1): kind-monotony'], parsedOk: true }));
    expect(cls).not.toBe('degenerate');
    expect(pre).not.toMatch(/no parseable return-protocol block/);
  });

  it('a protocol executor that produced no block still gets the return-protocol demand (pi unchanged)', () => {
    const pre = consultPreamble(base({ parsedOk: false }));
    expect(pre).toMatch(/return-protocol JSON block/);
    expect(pre).toMatch(/Failure class: degenerate/);
  });
});

describe('classifyFailure — op-failure evidence', () => {
  it('classes a failed post-op gate as quality-gap, beating the degenerate fallback', () => {
    expect(classifyFailure(base({ opFailures: ['merge run failed (exit 1)'], parsedOk: false }))).toBe('quality-gap');
  });
});

describe('legacyRetry — io.retries reproduces today exactly (retry on ANY error/blocked)', () => {
  it('maps io.retries into an UNFILTERED budget (no `on` ⇒ every non-halt class, today behavior)', () => {
    // Today's runNodeWithRetries re-ran on ANY error/blocked — so legacy retry must NOT filter by class
    // (a `contract`/missing-artifact blocked retried up to N pre-M4; an `on:[...]` set would regress it).
    expect(legacyRetry(2)).toEqual({ max: 2 });
    expect(legacyRetry(2).on).toBeUndefined();
  });
  it('undefined/0 retries ⇒ max 0 (one attempt, today)', () => {
    expect(legacyRetry(undefined).max).toBe(0);
    expect(legacyRetry(0).max).toBe(0);
  });
});
