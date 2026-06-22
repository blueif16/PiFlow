// The declarative integrity-check engine — the detection ⊥ consequence half of the unified node
// contract. Pure functions over file BYTES (the fs read is injected), so the predicates are fully
// unit-testable without touching disk. The runner supplies a reader rooted at the host run dir.
//
// A faithful port of `run.mjs` (CHECK_KINDS / runChecks / effectiveChecks / actionForVerdict /
// lastFencedBlock). A check NEVER judges GOODNESS — `count-floor` asserts "≥N items EXIST", never
// "the items are good"; the human-judged quality bar lives in the criteria fixture, not here.

import type { Check, Verdict, Policy, PolicyAction } from './types.js';

/** A file as read for a check: its bytes (null = unreadable/absent) and size. */
export interface FileBytes {
  bytes: string | null;
  size: number;
}

/** The result of running one check (the per-node `checks` record + control-flow input). */
export interface CheckResult {
  kind: string;
  path: string | null;
  verdict: Verdict;
  reason: string;
  severity: 'fail' | 'warn';
}

/** Escape a string for safe interpolation into a `RegExp` (used to build the auto fill-sentinel check). */
export function escapeRegex(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve a dotted path (`a.b.c`) into a parsed object; null-safe at every hop. */
function fieldAt(obj: unknown, dotted: string): unknown {
  return String(dotted)
    .split('.')
    .reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), obj);
}

/**
 * Extract + parse the LAST fenced ```<lang> block in `text`. Returns `undefined` when there is no
 * such block, `null` when the block does not parse, else the parsed value. (run.mjs lastFencedBlock.)
 */
export function lastFencedBlock(text: string, lang?: string): unknown {
  const re = new RegExp('```' + (lang || 'json') + '\\s*([\\s\\S]*?)```', 'g');
  let m: RegExpExecArray | null;
  let last: string | undefined;
  while ((m = re.exec(text || ''))) last = m[1];
  if (last == null) return undefined;
  try {
    return JSON.parse(last.trim());
  } catch {
    return null;
  }
}

/** A predicate: pure fn of a read file (+ its `param`) → { ok, reason }. */
type Predicate = (f: FileBytes, param?: unknown) => { ok: boolean; reason: string };

/**
 * The predicate registry. Each entry is a pure fn of the file's bytes. Mirrors run.mjs CHECK_KINDS
 * exactly; adding a kind here (and to the CheckKind union) is the only change a new check needs.
 */
export const CHECK_KINDS: Record<string, Predicate> = {
  exists: (f) => ({ ok: f.bytes != null, reason: f.bytes != null ? 'present' : 'missing' }),
  'non-empty': (f) => ({ ok: (f.size || 0) > 0, reason: `${f.size || 0} bytes` }),
  'regex-absent': (f, p) => {
    const hit = new RegExp(String(p)).test(f.bytes || '');
    return { ok: !hit, reason: hit ? `/${String(p)}/ present (incomplete)` : `/${String(p)}/ absent` };
  },
  'regex-present': (f, p) => {
    const hit = new RegExp(String(p)).test(f.bytes || '');
    return { ok: hit, reason: hit ? `/${String(p)}/ present` : `/${String(p)}/ absent` };
  },
  'json-parses': (f) => {
    try {
      JSON.parse(f.bytes ?? '');
      return { ok: true, reason: 'valid JSON' };
    } catch (e) {
      return { ok: false, reason: `invalid JSON: ${(e as Error).message}` };
    }
  },
  'field-present': (f, p) => {
    let v: unknown;
    try {
      v = fieldAt(JSON.parse(f.bytes ?? ''), String(p));
    } catch {
      return { ok: false, reason: 'unparseable JSON' };
    }
    return { ok: v != null, reason: v != null ? `${String(p)} present` : `${String(p)} missing` };
  },
  'count-floor': (f, p) => {
    const param = (p ?? {}) as { path: string; min: number };
    let v: unknown;
    try {
      v = fieldAt(JSON.parse(f.bytes ?? ''), param.path);
    } catch {
      return { ok: false, reason: 'unparseable JSON' };
    }
    const n = Array.isArray(v) ? v.length : -1;
    return { ok: n >= param.min, reason: `${param.path}: ${n} (min ${param.min})` };
  },
  'fenced-tail': (f, p) => {
    const param = (p ?? {}) as { lang?: string; field?: string; minItems?: number };
    const o = lastFencedBlock(f.bytes ?? '', param.lang);
    if (o === undefined) return { ok: false, reason: `no fenced ${param.lang || 'json'} block` };
    if (o === null) return { ok: false, reason: 'fenced tail does not parse' };
    const v = param.field ? (o as Record<string, unknown>)[param.field] : o;
    const n = Array.isArray(v) ? v.length : v != null ? 1 : -1;
    const min = param.minItems ?? 1;
    return { ok: n >= min, reason: `${param.field || 'tail'}: ${n} (min ${min})` };
  },
};

/**
 * Run a check list, reading each referenced file ONCE via the injected `read`. Returns one
 * CheckResult per check (in order). An unknown kind degrades to a `warn` (never a hard fail).
 */
export function evaluateChecks(checks: Check[], read: (path: string) => FileBytes): CheckResult[] {
  if (!checks || !checks.length) return [];
  return checks.map((c) => {
    const severity: 'fail' | 'warn' = c.severity || 'fail';
    const fn = CHECK_KINDS[c.kind];
    if (!fn) {
      return { kind: c.kind, path: c.path ?? null, verdict: 'warn', reason: `unknown check kind '${c.kind}' (skipped)`, severity: 'warn' };
    }
    const file = c.path ? read(c.path) : { bytes: null, size: 0 };
    const r = fn(file, c.param);
    return { kind: c.kind, path: c.path ?? null, verdict: r.ok ? 'pass' : severity, reason: r.reason, severity };
  });
}

/**
 * The EFFECTIVE check list = the explicit `checks` ∪ the AUTO fill-sentinel completeness check. When a
 * `fillSentinel` is declared, every required artifact gets a `regex-absent` check for the (escaped)
 * sentinel — so an artifact that STILL contains the sentinel is incomplete (fail). This makes
 * "contract satisfied" mean USABLE (not merely present), which is what lets the return handshake be
 * advisory for an artifact-backed node without losing the real-corruption catch.
 */
export function effectiveChecks(
  explicit: Check[] | undefined,
  fillSentinel: string | undefined,
  artifactPaths: string[],
): Check[] {
  const auto: Check[] = fillSentinel
    ? artifactPaths.map((path) => ({ kind: 'regex-absent', path, param: escapeRegex(fillSentinel), severity: 'fail' as const }))
    : [];
  return [...auto, ...(explicit ?? [])];
}

/**
 * Map a non-pass verdict → an engine action via the node's policy. Default: fail→block, warn→warn.
 * Only `block | warn | stop` are honored; anything else (incl. the reserved retry-once/subagent-fix)
 * falls back to `block`. (run.mjs actionForVerdict.)
 */
export function actionForVerdict(verdict: Exclude<Verdict, 'pass'>, policy?: Policy): PolicyAction {
  const a: string = (policy && policy[verdict]) || (verdict === 'warn' ? 'warn' : 'block');
  return a === 'warn' || a === 'stop' ? a : 'block';
}
