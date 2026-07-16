import { describe, it, expect } from 'vitest';
import {
  CHECK_KINDS,
  evaluateChecks,
  effectiveChecks,
  actionForVerdict,
  lastFencedBlock,
  escapeRegex,
  resolvePointer,
  integrityToCheck,
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

describe('non-empty — a numeric param is a BYTE FLOOR (the min-bytes integrity kind); no param ⇒ >0', () => {
  it('passes at/above the floor, fails below it', () => {
    // the motivating incident: a silently-empty 205 KB persona (0 bytes) must trip a 200000-byte floor.
    expect(CHECK_KINDS['non-empty']({ bytes: null, size: 0 }, 200000)).toMatchObject({ ok: false });
    expect(CHECK_KINDS['non-empty']({ bytes: 'x'.repeat(200000), size: 200000 }, 200000)).toMatchObject({ ok: true });
    expect(CHECK_KINDS['non-empty']({ bytes: 'x'.repeat(199999), size: 199999 }, 200000)).toMatchObject({ ok: false });
  });
  it('is byte-identical to the pre-integrity predicate when no numeric param is given', () => {
    expect(CHECK_KINDS['non-empty']({ bytes: 'x', size: 1 })).toEqual({ ok: true, reason: '1 bytes' });
    expect(CHECK_KINDS['non-empty']({ bytes: '', size: 0 })).toEqual({ ok: false, reason: '0 bytes' });
    // a non-numeric param (an existing check that happens to pass one) still means ">0", unchanged.
    expect(CHECK_KINDS['non-empty']({ bytes: 'x', size: 1 }, 'ignored')).toMatchObject({ ok: true });
  });
});

describe('resolvePointer — RFC-6901 over parsed JSON', () => {
  const doc = { a: { b: [{ c: 1 }, { c: 2 }] }, 'x/y': 9, 'm~n': 8, ok: false };
  it('resolves object + array segments and the empty (whole-doc) pointer', () => {
    expect(resolvePointer(doc, '/a/b/1/c')).toBe(2);
    expect(resolvePointer(doc, '/a/b/0')).toEqual({ c: 1 });
    expect(resolvePointer(doc, '')).toBe(doc);
    expect(resolvePointer(doc, '/ok')).toBe(false); // a present false value resolves (not "absent")
  });
  it('unescapes ~1 (/) and ~0 (~) in tokens', () => {
    expect(resolvePointer(doc, '/x~1y')).toBe(9);
    expect(resolvePointer(doc, '/m~0n')).toBe(8);
  });
  it('returns undefined for an absent key, an out-of-range index, or a malformed pointer', () => {
    expect(resolvePointer(doc, '/a/z')).toBeUndefined();
    expect(resolvePointer(doc, '/a/b/9')).toBeUndefined();
    expect(resolvePointer(doc, 'no-leading-slash')).toBeUndefined();
  });
});

describe('json-pointer-exists — the pointer resolves to a present, non-empty-array value', () => {
  it('passes when present; fails on absent, null, or an EMPTY array', () => {
    const kp = '{"required_kp_ids":[7,8,9],"empty":[],"nul":null}';
    expect(CHECK_KINDS['json-pointer-exists']({ bytes: kp, size: kp.length }, { pointer: '/required_kp_ids' })).toMatchObject({ ok: true });
    expect(CHECK_KINDS['json-pointer-exists']({ bytes: kp, size: kp.length }, { pointer: '/empty' })).toMatchObject({ ok: false });
    expect(CHECK_KINDS['json-pointer-exists']({ bytes: kp, size: kp.length }, { pointer: '/nul' })).toMatchObject({ ok: false });
    expect(CHECK_KINDS['json-pointer-exists']({ bytes: kp, size: kp.length }, { pointer: '/absent' })).toMatchObject({ ok: false });
  });
  it('accepts a bare pointer STRING param, and fails on unparseable JSON', () => {
    expect(CHECK_KINDS['json-pointer-exists']({ bytes: '{"a":1}', size: 7 }, '/a')).toMatchObject({ ok: true });
    expect(CHECK_KINDS['json-pointer-exists']({ bytes: 'not json', size: 8 }, '/a')).toMatchObject({ ok: false });
  });
});

describe('json-pointer-equals — the pointer resolves and deep-equals the declared value', () => {
  it('passes on a deep-equal match (incl. false), fails on a mismatch or an absent pointer', () => {
    const led = '{"ok":true,"counts":{"kp":7},"tags":["a","b"]}';
    expect(CHECK_KINDS['json-pointer-equals']({ bytes: led, size: led.length }, { pointer: '/ok', value: true })).toMatchObject({ ok: true });
    expect(CHECK_KINDS['json-pointer-equals']({ bytes: led, size: led.length }, { pointer: '/ok', value: false })).toMatchObject({ ok: false });
    expect(CHECK_KINDS['json-pointer-equals']({ bytes: led, size: led.length }, { pointer: '/tags', value: ['a', 'b'] })).toMatchObject({ ok: true });
    expect(CHECK_KINDS['json-pointer-equals']({ bytes: led, size: led.length }, { pointer: '/counts/kp', value: 7 })).toMatchObject({ ok: true });
    expect(CHECK_KINDS['json-pointer-equals']({ bytes: led, size: led.length }, { pointer: '/missing', value: 1 })).toMatchObject({ ok: false });
  });
});

describe('json-schema — validate parsed bytes against an inline schema (ajv seam injected)', () => {
  // a hand fake standing in for the ajv-backed SchemaValidator: rejects when a required key is absent.
  const fakeValidate = (schema: object, data: unknown) => {
    const req = (schema as { required?: string[] }).required ?? [];
    const obj = (data ?? {}) as Record<string, unknown>;
    const missing = req.filter((k) => !(k in obj));
    return { ok: missing.length === 0, errors: missing.map((k) => `missing '${k}'`) };
  };
  const schema = { type: 'object', required: ['ok'] };
  it('passes a conforming doc, fails a non-conforming one', () => {
    expect(CHECK_KINDS['json-schema']({ bytes: '{"ok":true}', size: 11 }, { schema }, { validate: fakeValidate })).toMatchObject({ ok: true });
    expect(CHECK_KINDS['json-schema']({ bytes: '{}', size: 2 }, { schema }, { validate: fakeValidate })).toMatchObject({ ok: false });
  });
  it('fails on unparseable JSON; DEGRADES to pass (never a false breach) when no validator is injected', () => {
    expect(CHECK_KINDS['json-schema']({ bytes: '{bad}', size: 5 }, { schema }, { validate: fakeValidate })).toMatchObject({ ok: false });
    expect(CHECK_KINDS['json-schema']({ bytes: '{"ok":true}', size: 11 }, { schema })).toMatchObject({ ok: true });
  });
});

describe('integrityToCheck — the integrity vocabulary aliases CHECK_KINDS predicates', () => {
  it('maps each integrity kind to its predicate + path, severity fail (consequence is the op onFailure)', () => {
    expect(integrityToCheck({ kind: 'file-exists' }, 'p.md')).toEqual({ kind: 'exists', path: 'p.md', severity: 'fail' });
    expect(integrityToCheck({ kind: 'min-bytes', param: 200000 }, 'p.md')).toEqual({ kind: 'non-empty', path: 'p.md', param: 200000, severity: 'fail' });
    // contains-marker escapes the literal so regex metachars in a marker are matched literally, not as a pattern.
    // Use a marker WITH metacharacters so the escaping is load-bearing (a metachar-free marker would hide a drop).
    const marker = 'required_kp_ids[0].id';
    const mapped = integrityToCheck({ kind: 'contains-marker', param: marker }, 'p.md');
    expect(mapped).toEqual({ kind: 'regex-present', path: 'p.md', param: escapeRegex(marker), severity: 'fail' });
    expect(mapped.param).not.toBe(marker); // the escaped form MUST differ from the raw literal (dots/brackets escaped)
    // and the escaped regex matches the literal, not the metachar interpretation (e.g. NOT "required_kp_idsX.id").
    expect(CHECK_KINDS['regex-present']({ bytes: 'has required_kp_ids[0].id here', size: 30 }, mapped.param)).toMatchObject({ ok: true });
    expect(CHECK_KINDS['regex-present']({ bytes: 'required_kp_idsZ0Z.id', size: 21 }, mapped.param)).toMatchObject({ ok: false });
    expect(integrityToCheck({ kind: 'json-parses' }, 'l.json')).toEqual({ kind: 'json-parses', path: 'l.json', severity: 'fail' });
    expect(integrityToCheck({ kind: 'json-pointer-equals', param: { pointer: '/ok', value: true } }, 'l.json')).toEqual({ kind: 'json-pointer-equals', path: 'l.json', param: { pointer: '/ok', value: true }, severity: 'fail' });
    expect(integrityToCheck({ kind: 'json-schema', param: { schema: { type: 'object' } } }, 'l.json')).toEqual({ kind: 'json-schema', path: 'l.json', param: { schema: { type: 'object' } }, severity: 'fail' });
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
