// The declarative integrity-check engine — the detection ⊥ consequence half of the unified node
// contract. Pure functions over file BYTES (the fs read is injected), so the predicates are fully
// unit-testable without touching disk. The runner supplies a reader rooted at the host run dir.
//
// A faithful port of `run.mjs` (CHECK_KINDS / runChecks / effectiveChecks / actionForVerdict /
// lastFencedBlock). A check NEVER judges GOODNESS — `count-floor` asserts "≥N items EXIST", never
// "the items are good"; the human-judged quality bar lives in the criteria fixture, not here.

import type { Check, Verdict, Policy, PolicyAction, FailureClass, RetrySpec, IntegrityExpectation, OpSpec, OnFailure } from './types.js';
import type { SchemaValidator } from './runner/schema.js';

/** A file as read for a check: its bytes (null = unreadable/absent) and size. */
export interface FileBytes {
  bytes: string | null;
  size: number;
}

/** Injected capabilities a predicate may consult (kept out of the pure single-file model). Only `json-schema`
 *  reads it (an ajv `validate` seam); every other predicate ignores it, so passing it is always additive. */
export interface EvaluateOpts {
  /** The draft-2020-12 validator seam (`RunOptions.validateSchema`) — `json-schema` validates against it. */
  validate?: SchemaValidator | null;
}

/**
 * Resolve an RFC-6901 JSON pointer against a parsed value. `''` ⇒ the whole document. Returns `undefined`
 * when any segment is absent. Unescapes `~1`→`/` and `~0`→`~` (the pointer token escapes, in that order).
 */
export function resolvePointer(obj: unknown, pointer: string): unknown {
  if (pointer === '') return obj;
  if (!pointer.startsWith('/')) return undefined; // a valid non-empty pointer MUST start with '/'
  const tokens = pointer
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = /^\d+$/.test(t) ? Number(t) : NaN;
      if (Number.isNaN(i) || i < 0 || i >= cur.length) return undefined;
      cur = cur[i];
    } else if (typeof cur === 'object') {
      const rec = cur as Record<string, unknown>;
      if (!Object.hasOwn(rec, t)) return undefined;
      cur = rec[t];
    } else {
      return undefined; // a primitive cannot be descended into
    }
  }
  return cur;
}

/** Structural deep-equal for JSON-shaped values (the `json-pointer-equals` comparator). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
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

/** A predicate: pure fn of a read file (+ its `param`, + injected `opts` only `json-schema` reads) → { ok, reason }. */
type Predicate = (f: FileBytes, param?: unknown, opts?: EvaluateOpts) => { ok: boolean; reason: string };

/**
 * The predicate registry. Each entry is a pure fn of the file's bytes. Mirrors run.mjs CHECK_KINDS
 * exactly; adding a kind here (and to the CheckKind union) is the only change a new check needs.
 */
export const CHECK_KINDS: Record<string, Predicate> = {
  exists: (f) => ({ ok: f.bytes != null, reason: f.bytes != null ? 'present' : 'missing' }),
  'non-empty': (f, p) => {
    // A numeric `param` is a BYTE FLOOR (the `min-bytes` integrity kind rides this predicate — op-integrity §1);
    // any non-number param (or none) means the pre-integrity ">0" check, byte-identical to before.
    const min = typeof p === 'number' && p > 0 ? p : 1;
    const size = f.size || 0;
    return { ok: size >= min, reason: min > 1 ? `${size} bytes (min ${min})` : `${size} bytes` };
  },
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
  // ── structured-data predicates (op-integrity · manifest convention) — assert over parsed JSON, never prose ──
  'json-pointer-exists': (f, p) => {
    const pointer = typeof p === 'string' ? p : (p as { pointer?: string } | null)?.pointer;
    if (typeof pointer !== 'string') return { ok: false, reason: 'json-pointer-exists: no pointer declared' };
    let doc: unknown;
    try {
      doc = JSON.parse(f.bytes ?? '');
    } catch {
      return { ok: false, reason: 'unparseable JSON' };
    }
    const v = resolvePointer(doc, pointer);
    const ok = v != null && !(Array.isArray(v) && v.length === 0);
    return { ok, reason: ok ? `${pointer} present` : v === undefined ? `${pointer} absent` : Array.isArray(v) ? `${pointer} empty array` : `${pointer} null` };
  },
  'json-pointer-equals': (f, p) => {
    const param = (p ?? {}) as { pointer?: string; value?: unknown };
    if (typeof param.pointer !== 'string') return { ok: false, reason: 'json-pointer-equals: no pointer declared' };
    let doc: unknown;
    try {
      doc = JSON.parse(f.bytes ?? '');
    } catch {
      return { ok: false, reason: 'unparseable JSON' };
    }
    const v = resolvePointer(doc, param.pointer);
    const ok = deepEqual(v, param.value);
    return { ok, reason: ok ? `${param.pointer} == ${JSON.stringify(param.value)}` : `${param.pointer} = ${JSON.stringify(v)} (want ${JSON.stringify(param.value)})` };
  },
  'json-schema': (f, p, opts) => {
    const schema = (p as { schema?: unknown } | null)?.schema;
    if (schema == null || typeof schema !== 'object') return { ok: false, reason: 'json-schema: no inline schema declared' };
    // Degrade (never a false breach) when no validator is injected or the schema will not compile — the
    // schema gate's degrade-don't-brick contract (runner/schema.ts). ajv IS a @piflow/core dep, so this is edge-only.
    if (!opts?.validate) return { ok: true, reason: 'json-schema: skipped (no validator)' };
    let data: unknown;
    try {
      data = JSON.parse(f.bytes ?? '');
    } catch (e) {
      return { ok: false, reason: `invalid JSON: ${(e as Error).message}` };
    }
    try {
      const r = opts.validate(schema as object, data);
      return { ok: r.ok, reason: r.ok ? 'valid vs schema' : `schema violation: ${(r.errors ?? []).slice(0, 3).join('; ') || 'invalid'}` };
    } catch (e) {
      return { ok: true, reason: `json-schema: skipped (uncompilable: ${(e as Error).message})` };
    }
  },
};

/**
 * (op-integrity §1) Translate ONE integrity expectation for ONE resolved path into a `Check` the CHECK_KINDS
 * engine runs — the alias layer that keeps `expect` authoring integrity-facing while reusing the predicates.
 * severity is always `fail` (the CONSEQUENCE — block vs warn — is the op's `onFailure`, applied by the runner,
 * NOT the check severity). `json-schema` param is passed through resolved (the runner reads a `schemaPath`).
 */
export function integrityToCheck(exp: IntegrityExpectation, path: string): Check {
  const base = { path, severity: 'fail' as const };
  switch (exp.kind) {
    case 'file-exists':
      return { kind: 'exists', ...base };
    case 'min-bytes':
      return { kind: 'non-empty', param: exp.param, ...base };
    case 'contains-marker':
      // A literal marker → an ESCAPED regex-present so metachars in the marker match literally (never a pattern).
      return { kind: 'regex-present', param: escapeRegex(String(exp.param)), ...base };
    case 'json-parses':
      return { kind: 'json-parses', ...base };
    case 'json-pointer-exists':
      return { kind: 'json-pointer-exists', param: exp.param, ...base };
    case 'json-pointer-equals':
      return { kind: 'json-pointer-equals', param: exp.param, ...base };
    case 'json-schema':
      return { kind: 'json-schema', param: exp.param, ...base };
    default:
      // An unknown integrity kind rides through verbatim — evaluateChecks degrades it to a warn (skipped).
      return { kind: exp.kind, param: exp.param, ...base };
  }
}

/**
 * Run a check list, reading each referenced file ONCE via the injected `read`. Returns one
 * CheckResult per check (in order). An unknown kind degrades to a `warn` (never a hard fail).
 */
export function evaluateChecks(checks: Check[], read: (path: string) => FileBytes, opts?: EvaluateOpts): CheckResult[] {
  if (!checks || !checks.length) return [];
  return checks.map((c) => {
    const severity: 'fail' | 'warn' = c.severity || 'fail';
    const fn = CHECK_KINDS[c.kind];
    if (!fn) {
      return { kind: c.kind, path: c.path ?? null, verdict: 'warn', reason: `unknown check kind '${c.kind}' (skipped)`, severity: 'warn' };
    }
    const file = c.path ? read(c.path) : { bytes: null, size: 0 };
    const r = fn(file, c.param, opts);
    return { kind: c.kind, path: c.path ?? null, verdict: r.ok ? 'pass' : severity, reason: r.reason, severity };
  });
}

/** One op's integrity violation, in the shape the runner pushes onto its `opFailures` channel (op-integrity §1/§2).
 *  `integrity` carries EVERY expect verdict for the op (ok + failing); `detail` summarizes the FAILING ones. */
export interface IntegrityFailure {
  detail: string;
  onFailure: OnFailure;
  integrity: { kind: string; ok: boolean; detail: string }[];
}

/**
 * (op-integrity WS-I1) Evaluate every op's `expect` post-conditions over its writes — the SINGLE, pure home for
 * the integrity pass (both the pi lane `node-lifecycle.ts` and the no-pi lane `node-lanes.ts` call this; the
 * OKF DRIFT NOTE requires those parallel run-op loops to move together). Each expectation is aliased to a
 * CHECK_KIND via `integrityToCheck` and run through `evaluateChecks` (no parallel engine). An expectation with
 * no `path` fans out over the op's `writes`. `json-schema` resolves a `param.schemaPath` via the SAME injected
 * reader before the pure predicate runs. Returns ONE entry per op that has ≥1 FAILING expectation (a fully
 * passing op is SILENT); the consequence is the op's `onFailure` DEFAULTING TO `warn` (loud+early, not block).
 */
export function opIntegrityFailures(ops: OpSpec[] | undefined, read: (path: string) => FileBytes, opts?: EvaluateOpts): IntegrityFailure[] {
  const out: IntegrityFailure[] = [];
  for (const o of ops ?? []) {
    if (!o.expect?.length) continue;
    const pairs: { kind: string; path: string; check: Check }[] = [];
    for (const exp of o.expect) {
      const targets = exp.path ? [exp.path] : o.writes ?? [];
      for (const rel of targets) {
        let ex = exp;
        if (exp.kind === 'json-schema') {
          const pr = (exp.param ?? {}) as { schema?: unknown; schemaPath?: string };
          if (pr.schema == null && typeof pr.schemaPath === 'string') {
            const sf = read(pr.schemaPath);
            let schemaObj: unknown = null;
            try {
              schemaObj = sf.bytes != null ? JSON.parse(sf.bytes) : null;
            } catch {
              schemaObj = null;
            }
            ex = { ...exp, param: { schema: schemaObj } };
          }
        }
        pairs.push({ kind: String(exp.kind), path: rel, check: integrityToCheck(ex, rel) });
      }
    }
    if (!pairs.length) continue;
    const results = evaluateChecks(pairs.map((p) => p.check), read, opts);
    const integrity = results.map((r, i) => ({ kind: pairs[i].kind, ok: r.verdict === 'pass', detail: `${pairs[i].path}: ${r.reason}` }));
    const failing = integrity.filter((v) => !v.ok);
    if (!failing.length) continue; // a fully-passing op is silent
    const onFailure: OnFailure = o.onFailure ?? 'warn';
    const label = failing.map((v) => `${v.kind} ${v.detail}`).join('; ');
    out.push({ detail: `op ${o.id ?? '?'} integrity — ${label}`, onFailure, integrity });
  }
  return out;
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
  /** The deterministic tool-loop breaker killed the node (one tool run with identical args past the limit). */
  killedToolLoop?: boolean;
  /** The request-level idle watchdog exhausted its in-place re-execs (the pi request stayed silent). */
  killedIdle?: boolean;
  /** The node's process exit code (0 = clean). */
  exitCode: number;
  /** The tail of the agent's stderr (matched against the infra-noise regex). */
  stderrTail: string;
  /** Whether a return-protocol block parsed from stdout. */
  parsedOk: boolean;
  /**
   * (P3 · inline hitl) A human reviewer REJECTED this node at its inline checkpoint — set the node `error`.
   * `rejectReason` is the reviewer's free-text WHY, surfaced by `consultPreamble` so the warm re-run fixes
   * EXACTLY what the human flagged. `humanReject` is the discriminator the retry engine reads to force the
   * re-attempt RETRY-ONLY (never escalate to a stronger model — a human "no" is a quality call, not a
   * capability gap). Both absent on every non-hitl failure (byte-identical classification there).
   */
  rejectReason?: string;
  humanReject?: boolean;
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
  // A request-level idle EXHAUSTION (every in-place re-exec stayed silent) is a TRANSIENT gateway hang, not a
  // model capability gap — a fresh same-model re-run is the right fix (a stronger model can't un-hang a
  // gateway), so it classes as INFRA (retry), NOT quality-gap (escalate). Checked before the stall/timeout arm.
  if (n.killedIdle) return 'infra';
  // Watchdog kills → escalate (a same-model retry just loops/stalls the same way) — but stall/timeout
  // are capability/budget misses (escalate), so they fall through to quality-gap below by default. A
  // deterministic tool-loop kill is the same class: a same-model retry would loop identically → escalate.
  if (n.killedStall || n.killedTimeout || n.killedToolLoop) return 'quality-gap';
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
  // (P3 · inline hitl) A human REJECTION is the primary signal when present — surface the reviewer's WHY
  // FIRST so the warm re-run addresses exactly what the human flagged (never an empty critique).
  if (n.rejectReason) ev.push(`a human reviewer REJECTED the output: ${n.rejectReason}`);
  if (n.missing && n.missing.length) ev.push(`missing required artifact(s): ${n.missing.join(', ')}`);
  if (n.schemaInvalid && n.schemaInvalid.length) ev.push(`artifact(s) violate the declared schema: ${n.schemaInvalid.map((x) => `${x.path} [${(x.errors || []).slice(0, 3).join('; ')}]`).join(' | ')}`);
  if (n.returnSchemaInvalid && n.returnSchemaInvalid.length) ev.push(`return violates the declared returnSchema: ${n.returnSchemaInvalid.slice(0, 3).join('; ')}`);
  if (n.failedChecks && n.failedChecks.length) ev.push(`failed integrity check(s): ${n.failedChecks.map((c) => `${c.kind} ${c.path || ''}: ${c.reason}`).join(' | ')}`);
  if (n.killedStall) ev.push('went silent with no tool running (model stalled)');
  if (n.killedIdle) ev.push('the request went silent past the idle window and every in-place re-exec stayed silent (gateway hang)');
  if (n.killedTimeout) ev.push('exceeded the node time budget');
  if (n.killedToolLoop) ev.push('looped: called one tool repeatedly with identical args (deterministic tool-loop kill)');
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
 * Preserve `io.retries` verbatim as a `RetrySpec`: today's `runNodeWithRetries` re-ran on ANY `error`/
 * `blocked` verdict up to N times, so legacy retry is UNFILTERED (`on: undefined` ⇒ every non-`halt`
 * class). The only refinement over the pre-M4 loop is the `halt` guard (a missing UPSTREAM input —
 * escalation/retry cannot manufacture one), a strict safety improvement that never spins uselessly.
 * Undefined/0 ⇒ max 0 (one attempt, today's exact behavior).
 */
export function legacyRetry(retries: number | undefined): RetrySpec {
  return { max: Math.max(0, retries ?? 0) };
}
