// contextComposition.ts — the "element tree": reconstruct EXACTLY what reached the model for one node
// run, as one ordered, honest record. The force-injected context (the staged `prompt.md`) plus every
// agent-read (`read`/`grep`) unified — each op with file · line-range · COVERAGE · version(sha) · order —
// plus the BLIND-SPOT signal (files the prompt NAMED but the agent never read).
//
// It is a PROJECTION over data that already exists uncapped in `events.jsonl` (+ `prompt.md` on disk +
// the run-time `reads-manifest.json`), computed ONCE here in @piflow/core/observe — never in a view.
//
// THE ANTI-FOOTGUN: `events.jsonl` caps a `tool_execution_end.result` preview at 2048 chars (events.ts
// `MAX_RESULT`). That `"truncated": true` is a LOGGING artifact — the model received the FULL content
// (the sibling `turn_end` carries the untruncated result). We NEVER map that flag to `covered:'partial'`.
// Read-level coverage comes from COVERAGE MATH (read ranges ÷ file-on-disk lines), kept strictly separate
// from the cosmetic `logPreviewCapped` note.
//
// pi read semantics (grounds coverage): a `read` returns up to ~2000 lines / 50 KB per call, pageable via
// `args.offset`/`args.limit` (line-based). So a single NO-OFFSET read of a file ≤2000 lines AND ≤50 KB →
// FULL coverage. Coverage math earns its keep on genuinely large files; the dominant signal for most nodes
// is `advertisedUnread`.
//
// Naming aligns to OTel GenAI semconv where a canonical name exists (`gen_ai.tool.call.id` → toolCallId,
// `code.file.path` → path); range/coverage are our extension (no standard carries them).

import fssync from 'node:fs';
import { createHash } from 'node:crypto';
import type { ScopeKind } from './runView.js';

/** pi's per-call read page: ~2000 lines / 50 KB. A no-offset read of a file under BOTH is whole-file. */
const READ_PAGE_LINES = 2000;
const READ_PAGE_BYTES = 50 * 1024;
/** Bounded plaintext cap for the opt-in `preview` (mirrors distill.ts `PREVIEW_CAP`). */
const PREVIEW_CAP = 8000;
/** coverage ≥ this counts as full (floating-point-safe threshold). */
const FULL_THRESHOLD = 0.999;

const READ_OPS = new Set(['read', 'grep']);
/** map a pi toolName → a ContextOp op kind; returns null for a tool we do not surface as context. */
function opKind(toolName: string): ContextOp['op'] | null {
  switch (toolName) {
    case 'read': return 'read';
    case 'grep': return 'grep';
    case 'edit': return 'edit';
    case 'write': return 'write';
    case 'ls': case 'find': return 'list';
    case 'bash': return 'bash';
    default: return null;
  }
}

const baseName = (p: string): string => p.split('/').pop() ?? p;

export interface ContextOp {
  seq: number;                 // chronological index across the node run (0-based)
  tMs: number | null;          // ms since node start (event _t)
  op: 'inject' | 'read' | 'grep' | 'edit' | 'write' | 'list' | 'bash';
  toolCallId: string | null;   // gen_ai.tool.call.id; null for 'inject'
  path: string;                // absolute (inject → the staged prompt.md path)
  displayPath: string;         // via makeDisplayPath
  scope: ScopeKind;            // run|skill|template|package|repo (reuse scopeKind); inject → 'run'
  range: { offset: number; limit: number | null } | null;  // line-based; null = whole-file/no-args; limit:null = offset-only continuation
  fileLines: number | null;    // total lines on disk at build time (or from manifest)
  fileBytes: number | null;    // total bytes
  returnedBytes: number | null; // best-effort actual bytes delivered (non-truncated result; else null)
  coverage: number | null;     // 0..1 union(read ranges)/fileLines ; inject = 1 ; null = unknown
  covered: 'full' | 'partial' | 'unknown';
  sha256: string | null;       // file content hash at RUN time (from reads-manifest; else build-time file)
  logPreviewCapped: boolean;   // cosmetic: the events.jsonl 2048 preview was capped — NOT a model truncation
  preview?: string;            // bounded plaintext (reuse existing PREVIEW_CAP); opt-in
  ok: boolean;
  errorType?: string;
}

export interface NodeComposition {
  injectedBytes: number;       // staged prompt.md size
  readFiles: number;           // distinct files read
  advertised: string[];        // display paths the injected prompt + DRIVER-* markers NAME
  advertisedUnread: string[];  // advertised but 0 reads  ← THE blind-spot
  partialReads: string[];      // files with coverage < 1 (model saw only a slice)
}

export interface NodeContext { context: ContextOp[]; composition: NodeComposition }

/** One reads-manifest.json entry — the run-time size/version snapshot of a read file. */
export interface ReadsManifestEntry {
  sha256?: string | null;
  bytes?: number | null;
  lines?: number | null;
  mtime?: number | string | null;
}
export type ReadsManifest = Record<string, ReadsManifestEntry>;

/**
 * The per-node build context. `buildNodeContext` reads the ordered `events.jsonl` itself; the caller
 * supplies the run-scoped closures + the already-read prompt + the manifest (so this stays a pure
 * projection over data the caller loaded once).
 */
export interface ContextBuildCtx {
  /** strip an absolute path to a clean display path (reuse `makeDisplayPath` from runView.ts). */
  displayPath: (abs: unknown) => string;
  /** classify an absolute path + its display path to a scope bucket (compose `underRun` + `scopeKind`). */
  scopeOf: (abs: string, displayPath: string) => ScopeKind;
  /** the staged prompt.md text (`.pi/nodes/<id>/prompt.md`), or null when absent. */
  promptText: string | null;
  /** the absolute path of the staged prompt.md (the `inject` op's path). */
  promptPath: string | null;
  /** the run-time reads-manifest (`.pi/nodes/<id>/reads-manifest.json`), or null → fall back to on-disk. */
  manifest: ReadsManifest | null;
  /** opt-in: attach a bounded `preview` to each read op (kept off by default so the view stays lean). */
  includePreview?: boolean;
}

interface RawEvent {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  args?: { path?: unknown; offset?: unknown; limit?: unknown };
  result?: unknown;
  isError?: unknown;
  _t?: unknown;
}

/** A parsed tool_execution_start awaiting its matching _end. */
interface PendingOp {
  seq: number; // provisional order among tool ops (before the inject prepend)
  op: ContextOp['op'];
  toolCallId: string;
  toolName: string;
  path: string;
  tMs: number | null;
  range: { offset: number; limit: number | null } | null;
  ok: boolean;
  logPreviewCapped: boolean;
  returnedBytes: number | null;
  preview?: string;
  errorType?: string;
}

/** Pull the joined plaintext out of a `{content:[{type:'text',text}]}` result (best-effort, bounded). */
function resultText(result: unknown): string | undefined {
  const r = result as { content?: unknown } | null | undefined;
  if (!r || !Array.isArray(r.content)) return undefined;
  const text = (r.content as { type?: string; text?: string }[])
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
  if (!text) return undefined;
  return text.length > PREVIEW_CAP ? text.slice(0, PREVIEW_CAP) : text;
}

/** Extract the path-like tokens the injected prompt (incl. its DRIVER-* marker lines — same text) NAMES as
 *  FILES: a token ending in a real file extension, with optional leading `/` + path segments. Product-agnostic
 *  (an extension whitelist, no per-repo vocabulary). Deliberately EXCLUDES globs (`spec/**`), bare directories
 *  (`templates/modules`), decimals / section refs (`5.6`, `v1.6`, `§5.6`) and slash-prose (`jump/dash/move`) —
 *  none of which are files the model was told to READ, so they must never pollute the blind-spot. The optional
 *  leading `/` captures absolute DRIVER-scope paths WHOLE so they can be display-stripped. First-seen, de-duped. */
function advertisedTokens(promptText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // A path whose final segment ends in a whitelisted (ALPHABETIC → excludes `5.6`) file extension.
  const re = /\/?(?:[\w@~.{}-]+\/)*[\w@~.{}-]+\.(?:md|mdx|json|jsonl|mjs|cjs|jsx?|tsx?|mts|cts|txt|ya?ml|toml|html?|css|scss|py|sh)(?![A-Za-z0-9])/g;
  for (const m of promptText.matchAll(re)) {
    const tok = m[0];
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/** Count newline-terminated lines of a UTF-8 buffer (a final unterminated line still counts). */
function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === 0x0a) n++;
  // a trailing partial line (no final \n) is still a line the model saw
  if (data[data.length - 1] !== 0x0a) n++;
  return n;
}

/** Size/version for a read path — prefer the run-time manifest, else stat+read the current on-disk file. */
function fileMeta(abs: string, manifest: ReadsManifest | null): { lines: number | null; bytes: number | null; sha256: string | null } {
  const m = manifest?.[abs];
  if (m && (m.lines != null || m.bytes != null || m.sha256 != null)) {
    return { lines: m.lines ?? null, bytes: m.bytes ?? null, sha256: m.sha256 ?? null };
  }
  // Fallback: the manifest is absent for this path → read the CURRENT on-disk file (may be stale vs the
  // run; the version drift is inherent without a manifest). Best-effort; a missing file → all null.
  try {
    const st = fssync.statSync(abs);
    if (!st.isFile()) return { lines: null, bytes: null, sha256: null };
    const data = fssync.readFileSync(abs);
    return { lines: countLines(data), bytes: st.size, sha256: 'sha256:' + createHash('sha256').update(data).digest('hex') };
  } catch {
    return { lines: null, bytes: null, sha256: null };
  }
}

/** pi `truncateHead` cutoff — the 0-indexed EXCLUSIVE end line a NO-LIMIT read starting at 0-indexed `start`
 *  delivers: pi keeps complete lines up to min(READ_PAGE_LINES lines, READ_PAGE_BYTES bytes) from `start`
 *  (core/tools/truncate.js). Without per-line bytes we estimate the byte cap proportionally — accurate enough
 *  for the full/partial verdict AND, crucially, for recognizing a paged continuation (adjacent unions still
 *  meet at EOF regardless of the exact head-cutoff line). */
function truncateCutoff(start: number, fileLines: number, fileBytes: number | null): number {
  const lineCap = Math.min(start + READ_PAGE_LINES, fileLines);
  if (fileBytes == null || fileBytes <= 0) return lineCap;
  const remainingBytes = (fileBytes * (fileLines - start)) / fileLines;
  if (remainingBytes <= READ_PAGE_BYTES) return lineCap; // the whole remainder from `start` fits in one page
  const avgBytesPerLine = fileBytes / fileLines;
  return Math.min(lineCap, start + Math.max(1, Math.floor(READ_PAGE_BYTES / avgBytesPerLine)));
}

/**
 * Union the delivered line-set for ONE file across all its read ops → coverage 0..1 (null when size unknown).
 * Each read delivers [start, end): `start` from its (1-indexed) `offset` (null = from the top); `end` from an
 * explicit `limit` (the model asked for exactly that many lines) OR — for a NO-LIMIT read — pi's truncateHead
 * cutoff. This is what makes an offset-only CONTINUATION read (`offset=N`, no limit) correctly extend coverage
 * to EOF instead of being mis-read as a second whole-file read (the pagination bug this fixes).
 */
function coverageForPath(
  ranges: ({ offset: number; limit: number | null } | null)[],
  fileLines: number | null,
  fileBytes: number | null,
): { coverage: number | null; covered: ContextOp['covered'] } {
  if (fileLines == null || fileLines <= 0) return { coverage: null, covered: 'unknown' };
  const intervals: [number, number][] = [];
  for (const r of ranges) {
    // pi read `offset` is 1-indexed; a null offset reads from the top (line 1).
    const start = r && r.offset != null ? Math.max(0, Math.min(r.offset - 1, fileLines)) : 0;
    const end = r && r.limit != null
      ? Math.min(start + r.limit, fileLines)              // explicit limit → exactly that many lines
      : truncateCutoff(start, fileLines, fileBytes);       // no limit → truncateHead-capped from `start`
    intervals.push([start, Math.max(start, end)]);
  }
  intervals.sort((x, y) => x[0] - y[0]);
  let coveredLines = 0;
  let curEnd = -1;
  for (const [a, b] of intervals) {
    const s = Math.max(a, curEnd);
    if (b > s) coveredLines += b - s;
    if (b > curEnd) curEnd = b;
  }
  const coverage = Math.min(1, coveredLines / fileLines);
  return { coverage, covered: coverage >= FULL_THRESHOLD ? 'full' : 'partial' };
}

/**
 * Reconstruct the ordered per-op context for one node run.
 * Reads `.pi/nodes/<id>/events.jsonl` line-by-line PRESERVING ORDER (NOT the distill accumulator, which
 * dedups reads first-seen — this needs every op, in order). One ContextOp per `tool_execution_start`,
 * paired with its `tool_execution_end` (by toolCallId) for ok/returnedBytes/logPreviewCapped. Prepends one
 * `op:'inject'` for the staged prompt.md.
 */
export function buildNodeContext(runDir: string, nodeId: string, ctx: ContextBuildCtx): NodeContext {
  const evFile = `${runDir}/.pi/nodes/${nodeId}/events.jsonl`;
  let raw = '';
  try { raw = fssync.readFileSync(evFile, 'utf8'); } catch { raw = ''; }

  const pending: PendingOp[] = [];
  const byId = new Map<string, PendingOp>();
  let toolSeq = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let ev: RawEvent;
    try { ev = JSON.parse(s) as RawEvent; } catch { continue; }
    if (ev.type === 'tool_execution_start') {
      const toolName = typeof ev.toolName === 'string' ? ev.toolName : '';
      const op = opKind(toolName);
      if (!op) continue; // a tool we do not surface as context (e.g. submit_result)
      const argPath = ev.args?.path;
      const p = typeof argPath === 'string' ? argPath : '';
      const offset = typeof ev.args?.offset === 'number' ? ev.args.offset : null;
      const limit = typeof ev.args?.limit === 'number' ? ev.args.limit : null;
      // Record the range whenever EITHER offset or limit is present. CRITICAL: an offset-only read
      // (`offset=N`, no limit) is pi's CANONICAL pagination continuation ("Use offset=N to continue") — it
      // must NOT be dropped to null (that mis-counts it as a second whole read and erases the paging).
      // offset defaults to 1 (pi read.js: `startLine = offset ?? 1`).
      const range = (offset != null || limit != null) ? { offset: offset ?? 1, limit } : null;
      const rec: PendingOp = {
        seq: toolSeq++,
        op,
        toolCallId: typeof ev.toolCallId === 'string' ? ev.toolCallId : '',
        toolName,
        path: p,
        tMs: typeof ev._t === 'number' ? ev._t : null,
        range,
        ok: true,
        logPreviewCapped: false,
        returnedBytes: null,
      };
      pending.push(rec);
      if (rec.toolCallId) byId.set(rec.toolCallId, rec);
    } else if (ev.type === 'tool_execution_end') {
      const id = typeof ev.toolCallId === 'string' ? ev.toolCallId : '';
      const rec = id ? byId.get(id) : undefined;
      if (!rec) continue;
      rec.ok = !(ev.isError === true);
      // ANTI-FOOTGUN: `result.truncated === true` is the events.jsonl 2048 preview cap — a LOGGING note,
      // NOT a model truncation. It sets ONLY the cosmetic `logPreviewCapped`; coverage stays range-derived.
      const result = ev.result as { truncated?: unknown } | undefined;
      if (result && result.truncated === true) {
        rec.logPreviewCapped = true;
      } else if (rec.ok) {
        // A SUCCESSFUL, non-capped result carries the real content → best-effort actual bytes delivered.
        // (A FAILED read's `result` is an error message, NOT file content — never report it as delivered.)
        const text = resultText(ev.result);
        if (text != null) rec.returnedBytes = Buffer.byteLength(text, 'utf8');
        if (ctx.includePreview && text) rec.preview = text;
      }
      if (!rec.ok && rec.errorType == null) {
        const text = resultText(ev.result);
        // e.g. "EPERM: operation not permitted ..." → "EPERM"
        const code = text?.match(/^([A-Z][A-Za-z0-9_]+)/)?.[1];
        rec.errorType = code ?? 'error';
      }
    }
  }

  // Per-distinct-path coverage: union every read op's range for that path (only read/grep count as coverage).
  const rangesByPath = new Map<string, ({ offset: number; limit: number | null } | null)[]>();
  const metaByPath = new Map<string, { lines: number | null; bytes: number | null; sha256: string | null }>();
  for (const rec of pending) {
    if (!READ_OPS.has(rec.toolName) || !rec.path) continue;
    // meta (size/version) is for DISPLAY — compute it for every read path, whether the read succeeded or not.
    if (!metaByPath.has(rec.path)) metaByPath.set(rec.path, fileMeta(rec.path, ctx.manifest));
    // A FAILED read (EPERM/denied/missing) delivered NOTHING to the model: it contributes no coverage and is
    // NOT a "read" for the blind-spot — a file whose ONLY read failed correctly stays advertisedUnread /
    // covered:'unknown'. This keeps the "exactly what reached the model" contract honest.
    if (!rec.ok) continue;
    let arr = rangesByPath.get(rec.path);
    if (!arr) { arr = []; rangesByPath.set(rec.path, arr); }
    arr.push(rec.range);
  }
  const coverageByPath = new Map<string, { coverage: number | null; covered: ContextOp['covered'] }>();
  for (const [p, ranges] of rangesByPath) {
    const meta = metaByPath.get(p)!;
    coverageByPath.set(p, coverageForPath(ranges, meta.lines, meta.bytes));
  }

  const context: ContextOp[] = [];

  // seq 0 — the FORCE-INJECTED prompt.md (the staged context the model always receives, whole).
  if (ctx.promptText != null && ctx.promptPath) {
    const m = ctx.manifest?.[ctx.promptPath];
    const injectedBytes = m?.bytes ?? Buffer.byteLength(ctx.promptText, 'utf8');
    const sha = m?.sha256 ?? 'sha256:' + createHash('sha256').update(ctx.promptText).digest('hex');
    const dp = ctx.displayPath(ctx.promptPath);
    context.push({
      seq: 0,
      tMs: 0,
      op: 'inject',
      toolCallId: null,
      path: ctx.promptPath,
      displayPath: dp,
      scope: 'run',
      range: null,
      fileLines: m?.lines ?? null,
      fileBytes: injectedBytes,
      returnedBytes: injectedBytes,
      coverage: 1,
      covered: 'full',
      sha256: sha,
      logPreviewCapped: false,
      ok: true,
    });
  }

  const injectOffset = context.length; // 1 if an inject op was prepended, else 0
  for (const rec of pending) {
    const meta = rec.path && READ_OPS.has(rec.toolName) ? metaByPath.get(rec.path) : undefined;
    const cov = rec.path && READ_OPS.has(rec.toolName) ? coverageByPath.get(rec.path) : undefined;
    const dp = rec.path ? ctx.displayPath(rec.path) : '';
    const op: ContextOp = {
      seq: rec.seq + injectOffset,
      tMs: rec.tMs,
      op: rec.op,
      toolCallId: rec.toolCallId || null,
      path: rec.path,
      displayPath: dp,
      scope: rec.path ? ctx.scopeOf(rec.path, dp) : 'run',
      range: rec.range,
      fileLines: meta?.lines ?? null,
      fileBytes: meta?.bytes ?? null,
      returnedBytes: rec.returnedBytes,
      coverage: cov ? cov.coverage : null,
      covered: cov ? cov.covered : 'unknown',
      sha256: meta?.sha256 ?? null,
      logPreviewCapped: rec.logPreviewCapped,
      ok: rec.ok,
      ...(rec.errorType ? { errorType: rec.errorType } : {}),
      ...(rec.preview ? { preview: rec.preview } : {}),
    };
    context.push(op);
  }

  // ── Composition (the roll-up + the blind-spot) ──────────────────────────────────────────────────
  const readPathSet = new Set(rangesByPath.keys());
  const readBasenames = new Set([...readPathSet].map((p) => baseName(p)));

  const advertised: string[] = [];
  const advSeen = new Set<string>();
  if (ctx.promptText != null) {
    for (const tok of advertisedTokens(ctx.promptText)) {
      // display an ABSOLUTE marker path run-relative; a bare token (e.g. `spec/blueprint.json`) stays as-is.
      const dp = tok.startsWith('/') ? ctx.displayPath(tok) : tok;
      if (advSeen.has(dp)) continue;
      advSeen.add(dp);
      advertised.push(dp);
    }
  }
  const advertisedUnread = advertised.filter((a) => !readBasenames.has(baseName(a)));

  const partialReads: string[] = [];
  const partialSeen = new Set<string>();
  for (const [p, cov] of coverageByPath) {
    if (cov.covered === 'partial') {
      const dp = ctx.displayPath(p);
      if (!partialSeen.has(dp)) { partialSeen.add(dp); partialReads.push(dp); }
    }
  }

  const injectedBytes = context[0]?.op === 'inject' ? (context[0].fileBytes ?? 0) : 0;
  const composition: NodeComposition = {
    injectedBytes,
    readFiles: readPathSet.size,
    advertised,
    advertisedUnread,
    partialReads,
  };

  return { context, composition };
}
