// The declarative integrity-check engine — the detection ⊥ consequence half of the unified node
// contract. Pure functions over file BYTES (the fs read is injected), so the predicates are fully
// unit-testable without touching disk. The runner supplies a reader rooted at the host run dir.
//
// A faithful port of `run.mjs` (CHECK_KINDS / runChecks / effectiveChecks / actionForVerdict /
// lastFencedBlock). A check NEVER judges GOODNESS — `count-floor` asserts "≥N items EXIST", never
// "the items are good"; the human-judged quality bar lives in the criteria fixture, not here.

import type { Check, Verdict, Policy, PolicyAction, FailureClass, RetrySpec } from './types.js';

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
 * `block | warn | stop | retry | escalate` are honored (M4 widened 3→5; `stop` is the documented
 * `block` alias, §2.4); anything else falls back to `block`. (run.mjs actionForVerdict, generalized.)
 */
export function actionForVerdict(verdict: Exclude<Verdict, 'pass'>, policy?: Policy): PolicyAction {
  const a: string = (policy && policy[verdict]) || (verdict === 'warn' ? 'warn' : 'block');
  return a === 'warn' || a === 'stop' || a === 'retry' || a === 'escalate' ? (a as PolicyAction) : 'block';
}

// ── M4 · the trigger-action runtime — the failure TAXONOMY (ported from run.mjs) ────────────────────
// classifyFailure / consultPreamble / legacyRetry are PURE functions over the signals `runNode` ALREADY
// computes (artifact stat, schema gate, integrity checks, watchdog kills, stderr tail, return parse) —
// NEVER a model self-score. The runner builds a `FailureSignals` from `rec` + `missing` + `result` at
// the verdict point and the retry/escalate lanes filter on the derived `FailureClass`. 100% GENERIC.

/** The EMPIRICAL signals the classifier reads — every field is something `runNode` already computes. */
export interface FailureSignals {
  /** The terminal node status (`error`/`blocked`/`gap`/`ok`). */
  status: string;
  /** The node's accumulated issues (carries the "missing input from upstream" marker). */
  issues: string[];
  /** The node summary (joined with issues for the upstream/missing-input regex). */
  summary?: string;
  /** Required artifacts MISSING on disk (the ground-truth contract breach). */
  missing: string[];
  /** Artifacts present but VIOLATING their declared schema. */
  schemaInvalid: { path: string; errors: string[] }[];
  /** The structured return violated its declared returnSchema (under `required`). */
  returnSchemaInvalid: string[];
  /** Declarative integrity checks that did NOT pass (the #6 quality-verdict signal). */
  failedChecks: { kind: string; path: string | null; reason: string }[];
  killedTimeout: boolean;
  killedStall: boolean;
  /** The node's process exit code (0 = clean). */
  exitCode: number;
  /** The tail of the agent's stderr (matched against the infra-noise regex). */
  stderrTail: string;
  /** Whether a return-protocol block parsed from stdout. */
  parsedOk: boolean;
}

/** Tighten the issues+summary text the upstream/missing-input HALT guard matches against. */
function issueText(n: FailureSignals): string {
  return `${(n.issues || []).join(' ')} ${n.summary || ''}`;
}

/**
 * Classify a node failure into a `FailureClass` over EMPIRICAL signals (run.mjs classifyFailure). The
 * artifact-contract breach is the centerpiece: we don't ask the model "are you sure" — the runner stats
 * the files it was REQUIRED to produce. Order matters: HALT (missing input — escalation can't manufacture
 * one) → schema (G8 repair lane) → contract → quality-gap → infra (transient stderr) → degenerate (no
 * parse) → quality-gap (any other capability miss).
 */
export function classifyFailure(n: FailureSignals): FailureClass {
  // A missing UPSTREAM input is a HALT — escalation cannot manufacture an input that was never produced.
  if ((n.status === 'blocked' || n.status === 'gap') && /upstream|missing input/i.test(issueText(n))) return 'halt';
  // Schema breach (artifact present but malformed) routes FIRST to the G8 in-sandbox repair lane.
  if ((n.schemaInvalid && n.schemaInvalid.length) || (n.returnSchemaInvalid && n.returnSchemaInvalid.length)) return 'schema';
  // Ground-truth contract breach — a required artifact is missing on disk.
  if (n.missing && n.missing.length) return 'contract';
  // A declarative integrity check FAILED on an otherwise-present artifact (#6: a QUALITY verdict).
  if (n.failedChecks && n.failedChecks.length) return 'quality-gap';
  // Watchdog kills → escalate (a same-model retry just loops/stalls the same way) — but stall/timeout
  // are capability/budget misses (escalate), so they fall through to quality-gap below by default.
  if (n.killedStall || n.killedTimeout) return 'quality-gap';
  // Infra noise (rate-limit / connection reset) on a nonzero exit — transient, a same-model retry fixes it.
  if (n.exitCode && n.exitCode !== 0 && /rate.?limit|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|\b429\b|\b5\d\d\b|network/i.test(n.stderrTail || '')) return 'infra';
  // No parseable return block — retry once, then escalate.
  if (!n.parsedOk) return 'degenerate';
  // Any other capability failure.
  return 'quality-gap';
}

/**
 * The consult prefix prepended to the ESCALATION attempt: the cheap attempt's VERIFIED failure evidence
 * (run.mjs consultPreamble) — missing-artifact paths, schema errors, failed-check reasons, stderr tail —
 * NEVER a self-score. The stronger model fixes EXACTLY these facts, inventing nothing.
 */
export function consultPreamble(n: FailureSignals): string {
  const cls = classifyFailure(n);
  const ev: string[] = [];
  if (n.missing && n.missing.length) ev.push(`missing required artifact(s): ${n.missing.join(', ')}`);
  if (n.schemaInvalid && n.schemaInvalid.length) ev.push(`artifact(s) violate the declared schema: ${n.schemaInvalid.map((x) => `${x.path} [${(x.errors || []).slice(0, 3).join('; ')}]`).join(' | ')}`);
  if (n.returnSchemaInvalid && n.returnSchemaInvalid.length) ev.push(`return violates the declared returnSchema: ${n.returnSchemaInvalid.slice(0, 3).join('; ')}`);
  if (n.failedChecks && n.failedChecks.length) ev.push(`failed integrity check(s): ${n.failedChecks.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ')}`);
  if (n.killedStall) ev.push('went silent with no tool running (model stalled)');
  if (n.killedTimeout) ev.push('exceeded the node time budget');
  if (!n.parsedOk) ev.push('produced no parseable return-protocol block');
  if (n.stderrTail) ev.push(`stderr: ${n.stderrTail.slice(-160)}`);
  return [
    'CONSULT — the prior model attempted this node and FAILED; do not repeat its mistake.',
    `Failure class: ${cls}`,
    `Evidence: ${ev.join(' | ') || '(none captured)'}`,
    'Produce EVERY required artifact and end with the return-protocol JSON block.',
    '',
    '',
  ].join('\n');
}

/**
 * Preserve `io.retries` verbatim as a `RetrySpec`: max=retries, classes=['infra','degenerate'] — today's
 * exact semantics (a transient model/timeout failure retries; a real capability/contract breach does not,
 * because today `io.retries` fires only on error/blocked transients). Undefined/0 ⇒ max 0 (one attempt).
 */
export function legacyRetry(retries: number | undefined): RetrySpec {
  return { max: Math.max(0, retries ?? 0), on: ['infra', 'degenerate'] };
}
