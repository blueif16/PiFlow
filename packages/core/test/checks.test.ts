import { describe, it, expect } from 'vitest';
import {
  CHECK_KINDS,
  evaluateChecks,
  effectiveChecks,
  actionForVerdict,
  lastFencedBlock,
  escapeRegex,
  type FileBytes,
} from '../src/checks.js';
import type { Check } from '../src/types.js';

/** A reader fake: serve canned bytes per path; an unknown path reads as absent. */
function reader(files: Record<string, string>): (p: string) => FileBytes {
  return (p) => (p in files ? { bytes: files[p], size: Buffer.byteLength(files[p]) } : { bytes: null, size: 0 });
}

describe('CHECK_KINDS — the pure predicates', () => {
  it('regex-absent: fails when the pattern is present, passes when absent', () => {
    expect(CHECK_KINDS['regex-absent']({ bytes: 'speed = <FILL:number>', size: 21 }, '<FILL:')).toMatchObject({ ok: false });
    expect(CHECK_KINDS['regex-absent']({ bytes: 'speed = 220', size: 11 }, '<FILL:')).toMatchObject({ ok: true });
  });

  it('count-floor: fails below min, passes at/above, fails on unparseable JSON', () => {
    expect(CHECK_KINDS['count-floor']({ bytes: '{"items":[1,2]}', size: 15 }, { path: 'items', min: 3 })).toMatchObject({ ok: false });
    expect(CHECK_KINDS['count-floor']({ bytes: '{"items":[1,2,3]}', size: 17 }, { path: 'items', min: 3 })).toMatchObject({ ok: true });
    expect(CHECK_KINDS['count-floor']({ bytes: 'not json', size: 8 }, { path: 'items', min: 1 })).toMatchObject({ ok: false });
  });

  it('fenced-tail: passes a parseable tail meeting minItems; fails when missing/unparseable/short', () => {
    expect(CHECK_KINDS['fenced-tail']({ bytes: 'prose\n```json\n[1,2,3]\n```', size: 24 }, { minItems: 2 })).toMatchObject({ ok: true });
    expect(CHECK_KINDS['fenced-tail']({ bytes: 'prose, no fence', size: 15 }, { minItems: 1 })).toMatchObject({ ok: false });
    expect(CHECK_KINDS['fenced-tail']({ bytes: '```json\n{bad json}\n```', size: 22 }, { minItems: 1 })).toMatchObject({ ok: false });
    expect(CHECK_KINDS['fenced-tail']({ bytes: '```json\n{"milestones":[{}]}\n```', size: 31 }, { field: 'milestones', minItems: 1 })).toMatchObject({ ok: true });
  });

  it('field-present / json-parses / non-empty cover the basics', () => {
    expect(CHECK_KINDS['field-present']({ bytes: '{"a":{"b":1}}', size: 13 }, 'a.b')).toMatchObject({ ok: true });
    expect(CHECK_KINDS['field-present']({ bytes: '{"a":{}}', size: 8 }, 'a.b')).toMatchObject({ ok: false });
    expect(CHECK_KINDS['json-parses']({ bytes: '{"ok":true}', size: 11 })).toMatchObject({ ok: true });
    expect(CHECK_KINDS['json-parses']({ bytes: '{nope}', size: 6 })).toMatchObject({ ok: false });
    expect(CHECK_KINDS['non-empty']({ bytes: 'x', size: 1 })).toMatchObject({ ok: true });
    expect(CHECK_KINDS['non-empty']({ bytes: '', size: 0 })).toMatchObject({ ok: false });
  });
});

describe('escapeRegex — sentinels are matched literally, not as regex', () => {
  it('treats regex metacharacters as literals', () => {
    // Unescaped, "a.b" would match "axb"; escaped, the dot is literal so only "a.b" matches.
    expect(CHECK_KINDS['regex-absent']({ bytes: 'axb', size: 3 }, escapeRegex('a.b'))).toMatchObject({ ok: true });
    expect(CHECK_KINDS['regex-absent']({ bytes: 'a.b', size: 3 }, escapeRegex('a.b'))).toMatchObject({ ok: false });
  });
});

describe('lastFencedBlock', () => {
  it('returns the LAST parseable fenced block, undefined when none, null when unparseable', () => {
    expect(lastFencedBlock('```json\n{"a":1}\n```\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(lastFencedBlock('no fences here')).toBeUndefined();
    expect(lastFencedBlock('```json\n{bad}\n```')).toBeNull();
  });
});

describe('evaluateChecks — runs the list against an injected reader', () => {
  it('reports pass/fail per check with the declared severity, in order', () => {
    const checks: Check[] = [
      { kind: 'non-empty', path: 'good.txt' },
      { kind: 'regex-absent', path: 'bad.json', param: '<FILL:' },
    ];
    const out = evaluateChecks(checks, reader({ 'good.txt': 'hi', 'bad.json': 'x=<FILL:n>' }));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'non-empty', verdict: 'pass' });
    expect(out[1]).toMatchObject({ kind: 'regex-absent', verdict: 'fail', severity: 'fail' });
  });

  it("honors a check's severity:'warn' (a failing warn-check yields verdict 'warn', not 'fail')", () => {
    const out = evaluateChecks([{ kind: 'non-empty', path: 'empty.txt', severity: 'warn' }], reader({ 'empty.txt': '' }));
    expect(out[0]).toMatchObject({ verdict: 'warn', severity: 'warn' });
  });

  it('degrades an unknown check kind to a warn (never a hard fail)', () => {
    const out = evaluateChecks([{ kind: 'no-such-kind', path: 'x' }], reader({ x: 'data' }));
    expect(out[0]).toMatchObject({ verdict: 'warn', reason: expect.stringContaining('unknown check kind') });
  });
});

describe('effectiveChecks — explicit ∪ the auto fill-sentinel completeness check', () => {
  it('adds a regex-absent check (escaped sentinel) per artifact, BEFORE the explicit checks', () => {
    const explicit: Check[] = [{ kind: 'count-floor', path: 'spec.json', param: { path: 'm', min: 3 } }];
    const out = effectiveChecks(explicit, '<FILL:', ['a.json', 'b.json']);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ kind: 'regex-absent', path: 'a.json', param: escapeRegex('<FILL:'), severity: 'fail' });
    expect(out[1]).toMatchObject({ kind: 'regex-absent', path: 'b.json' });
    expect(out[2]).toBe(explicit[0]); // explicit checks preserved, after the auto ones
  });

  it('adds nothing when no fill sentinel is declared', () => {
    expect(effectiveChecks([{ kind: 'exists', path: 'x' }], undefined, ['a.json'])).toEqual([{ kind: 'exists', path: 'x' }]);
    expect(effectiveChecks(undefined, undefined, ['a.json'])).toEqual([]);
  });
});

describe('actionForVerdict — verdict→action policy (detection ⊥ consequence)', () => {
  it('defaults fail→block and warn→warn with no policy', () => {
    expect(actionForVerdict('fail')).toBe('block');
    expect(actionForVerdict('warn')).toBe('warn');
  });

  it('lets a policy downgrade fail→warn or escalate to stop, and floors unknown actions to block', () => {
    expect(actionForVerdict('fail', { fail: 'warn' })).toBe('warn');
    expect(actionForVerdict('fail', { fail: 'stop' })).toBe('stop');
    // an unrecognized action (e.g. the reserved retry-once) falls back to block
    expect(actionForVerdict('fail', { fail: 'retry-once' as unknown as 'block' })).toBe('block');
  });
});
