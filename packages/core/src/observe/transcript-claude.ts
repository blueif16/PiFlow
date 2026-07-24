// transcript-claude.ts — the `claude-code` adapter of the TRANSCRIPT PORT (./transcript.ts).
//
// Decodes Claude Code's OWN record natively. Claude does NOT emit pi's flat tool events: one logical turn is
// an `{type:'assistant', message:{content:[…]}}` record whose content blocks carry `thinking` / `text` /
// `tool_use`, and each call is closed by the matching `{type:'user', message:{content:[{type:'tool_result',
// tool_use_id}]}}`. This adapter reads THOSE records and emits the shared vocabulary directly — it does NOT
// transcode them into pi's schema for pi's parser (the explicit no-normalizer rule of the port).
//
// SOURCE POLICY (claude's own — verified against a real run, `.piflow/section-anim/runs/260722-09`):
//   1. NATIVE SESSION FIRST — `<run>/.claude-config/<nodeId>/projects/<cwd-slug>/<sessionId>.jsonl`. It is
//      the COMPLETE record: 16 tool_use / 16 tool_result, the assistant text, and a per-record ISO
//      `timestamp` (so turn spans are real wall-clock).
//   2. ARCHIVE FALLBACK — `.pi/nodes/<id>/events.jsonl`. piflow's capture of the same stream, but LOSSY for
//      this executor by construction: the archive slim keeps ONLY tool content blocks on an assistant/user
//      line (text + thinking are dropped, events.ts `slimClaudeToolContent`) and caps a line at 8192 bytes —
//      which TORE 4 of the 16 tool_result lines in the verified run. So it can answer ops, never turn text.
// Which source won is reported by `origin()`, and the capability set is computed FROM that source — not from
// the executor id — so a fallback node honestly declares the signal it lost instead of reporting zeros.
//
// A DECLARED BLIND SPOT, NOT A ZERO: Claude Code persists `thinking` blocks with the text REDACTED to `""`
// (only the opaque `signature` survives). Per-turn thinking VOLUME is therefore unrecoverable from either
// source, and `turnThinking` is declared FALSE with that reason — so the turn table prints `SKIP: …` rather
// than a `0` a reader would mistake for "this model did not think".

import fssync from 'node:fs';
import path from 'node:path';
import { claudeProjectsDir } from '../runner/layout.js';
import { nodeEventsFile } from '../runner/layout.js';
import { parseNodeEventsFile } from '../runner/pi-session.js';
import {
  argsPreview, capText, rangeOf,
  type TranscriptCapabilities, type TranscriptOp, type TranscriptOpKind, type TranscriptOrigin,
  type TranscriptReader, type TranscriptSource, type TranscriptTurn,
} from './transcript.js';

/** Claude builtin tool name → the port's executor-neutral op kind. Claude's names are capitalised and its
 *  set is its own (`Glob` for listing, `NotebookEdit` for a notebook write, `Task`/`TodoWrite` carrying no
 *  file signal) — mapped HERE, natively, never by round-tripping through pi's lowercase names. */
function claudeOpKind(toolName: string): TranscriptOpKind {
  switch (toolName) {
    case 'Read': case 'NotebookRead': return 'read';
    case 'Grep': return 'grep';
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit';
    case 'Write': return 'write';
    case 'Glob': case 'LS': return 'list';
    case 'Bash': case 'BashOutput': return 'bash';
    default: return 'other';
  }
}

/** A Claude `message.content[]` block — only the fields either source preserves. */
interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  text?: string;
  thinking?: string;
  content?: unknown;
}

/** A Claude transcript/stream record. `timestamp` (ISO) rides the NATIVE record; `_t` (ms since node start)
 *  rides the piflow ARCHIVE — the adapter reads whichever its source carries. */
interface Rec {
  type?: string;
  message?: unknown;
  timestamp?: unknown;
  _t?: unknown;
}

/** A record's content blocks. Claude sometimes carries a bare STRING content (a plain user/assistant text) —
 *  normalised to one text block so a decoder never has to special-case it. */
function blocksOf(message: unknown): Block[] {
  const m = message as { content?: unknown } | null | undefined;
  if (!m || typeof m !== 'object') return [];
  const c = m.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? (c as Block[]).filter((b) => b && typeof b === 'object') : [];
}

/** A tool_result's payload as plaintext — Claude carries either a bare string or `[{type:'text',text}]`. */
function toolResultText(block: Block): string | undefined {
  const c = block.content;
  if (typeof c === 'string') return capText(c);
  if (!Array.isArray(c)) return undefined;
  const text = (c as { type?: string; text?: string }[])
    .filter((x) => x && x.type === 'text' && typeof x.text === 'string')
    .map((x) => x.text as string)
    .join('\n');
  return capText(text);
}

/** Claude's per-tool file argument. `Read`/`Write`/`Edit` use `file_path`; `Grep`/`Glob` use `path`. */
function pathOf(input: unknown): string {
  const i = input as Record<string, unknown> | null | undefined;
  if (!i || typeof i !== 'object') return '';
  const fp = i.file_path ?? i.path ?? i.notebook_path;
  return typeof fp === 'string' ? fp : '';
}

/** Parse a JSONL file into records, skipping torn/unparseable lines (the archive tears at its 8192 cap). */
function parseJsonl(file: string): Rec[] {
  let raw: string;
  try { raw = fssync.readFileSync(file, 'utf8'); } catch { return []; }
  const out: Rec[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Rec); } catch { /* torn line — skip, never throw */ }
  }
  return out;
}

/**
 * Locate a node's native Claude session transcript. Claude roots it at
 * `<CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<sessionId>.jsonl`, where the slug is Claude's OWN encoding of the
 * cwd — so we LOCATE (scan the one `projects/` dir) rather than reconstruct it, mirroring
 * `locatePiSessionFile`. Prefers the file named for the run-recorded `sessionId`; with no id (or no match) it
 * falls back to the most recently modified `.jsonl` under `projects/`, so a run whose id was never captured
 * is still readable. Returns null when the jail dir is absent (a pi node, or a cleaned run).
 */
export function locateClaudeSessionFile(runDir: string, nodeId: string, sessionId?: string): string | null {
  const projects = claudeProjectsDir(runDir, nodeId);
  let slugs: string[];
  try { slugs = fssync.readdirSync(projects); } catch { return null; }
  const candidates: { file: string; mtimeMs: number }[] = [];
  for (const slug of slugs) {
    let files: string[];
    const dir = path.join(projects, slug);
    try { files = fssync.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      if (sessionId && f === `${sessionId}.jsonl`) return file;
      try { candidates.push({ file, mtimeMs: fssync.statSync(file).mtimeMs }); } catch { /* raced away */ }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.file ?? null;
}

/** ms-since-first-record clock: NATIVE records carry an ISO `timestamp`, ARCHIVE records a numeric `_t`. */
function clockOf(r: Rec): number | null {
  if (typeof r._t === 'number') return r._t;
  if (typeof r.timestamp === 'string') {
    const ms = Date.parse(r.timestamp);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** Decode Claude's NESTED tool blocks into ordered ops: an assistant `tool_use` opens a call, the matching
 *  user `tool_result` (same `tool_use_id`) closes it. A call with no result (killed mid-flight, or a result
 *  line the archive tore) stays `ok:true` with no payload — counted, never silently dropped. */
function decodeOps(recs: Rec[]): TranscriptOp[] {
  const ops: TranscriptOp[] = [];
  const byId = new Map<string, TranscriptOp>();
  let firstT: number | null = null;
  for (const r of recs) {
    const t = clockOf(r);
    if (firstT == null && t != null) firstT = t;
    if (r.type === 'assistant') {
      for (const b of blocksOf(r.message)) {
        if (b.type !== 'tool_use' || typeof b.name !== 'string') continue;
        const input = b.input as Record<string, unknown> | undefined;
        const op: TranscriptOp = {
          seq: ops.length,
          tMs: t != null && firstT != null ? t - firstT : null,
          kind: claudeOpKind(b.name),
          toolName: b.name,
          toolCallId: typeof b.id === 'string' ? b.id : null,
          path: pathOf(b.input),
          range: rangeOf(input?.offset, input?.limit),
          ok: true,
          logPreviewCapped: false,
        };
        ops.push(op);
        if (op.toolCallId) byId.set(op.toolCallId, op);
      }
    } else if (r.type === 'user') {
      for (const b of blocksOf(r.message)) {
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        const op = byId.get(b.tool_use_id);
        if (!op) continue;
        op.ok = b.is_error !== true;
        const text = toolResultText(b);
        if (text != null) op.resultText = text;
      }
    }
  }
  return ops;
}

/** Segment Claude's stream into turns. Claude has no `turn_start` event — ONE `assistant` record IS one turn
 *  (its content blocks are that turn's thinking/text/tool calls), and the turn's span runs to the next
 *  assistant record's timestamp, so the tool round-trip between them is attributed to the turn that caused it. */
function decodeTurns(recs: Rec[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let firstT: number | null = null;
  let cur: (TranscriptTurn & { startAbsT: number; lastT: number }) | null = null;

  const close = () => {
    if (!cur) return;
    const { startAbsT, lastT, ...rec } = cur;
    rec.startMs = startAbsT - (firstT ?? startAbsT);
    rec.durMs = Math.max(0, lastT - startAbsT);
    turns.push(rec);
  };

  for (const r of recs) {
    const t = clockOf(r);
    if (firstT == null && t != null) firstT = t;
    if (r.type === 'assistant') {
      if (cur && t != null) cur.lastT = t;
      close();
      const startAbsT = t ?? firstT ?? 0;
      cur = {
        index: turns.length, startMs: 0, durMs: 0, thinkChars: 0, textChars: 0, thinkText: '', text: '',
        toolCalls: [], startAbsT, lastT: startAbsT,
      };
      for (const b of blocksOf(r.message)) {
        if (b.type === 'thinking' && typeof b.thinking === 'string') {
          cur.thinkChars += b.thinking.length; // 0 in practice — the persisted text is redacted
          cur.thinkText += b.thinking;
        } else if (b.type === 'text' && typeof b.text === 'string') {
          cur.textChars += b.text.length;
          cur.text += b.text;
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          cur.toolCalls.push({ name: b.name, argsPreview: argsPreview(b.input) });
        }
      }
      continue;
    }
    if (cur && t != null) cur.lastT = t; // a tool round-trip belongs to the turn that dispatched it
  }
  close();
  return turns;
}

/** The reason `turnThinking` is false for EVERY claude-code source — a property of the executor's record. */
const THINKING_REDACTED =
  "claude-code persists `thinking` blocks with the text redacted to \"\" (signature only) — per-turn thinking volume is not in the record";
/** The reasons the ARCHIVE fallback loses signal the native transcript carries. */
const ARCHIVE_NO_TEXT =
  'read from the slimmed events.jsonl archive, which keeps only tool blocks on a claude assistant/user line (text is dropped) — read the native session transcript for turn text';
const NO_SOURCE = 'no claude-code record found for this node (neither the native session transcript nor an events.jsonl archive)';

/**
 * The `claude-code` transcript adapter. Picks its source at construction (native transcript, else the
 * archive), computes its capability declaration FROM that source, and decodes lazily.
 */
export const claudeTranscript: TranscriptReader = (runDir, nodeId, ref = {}) => {
  const nativePath = locateClaudeSessionFile(runDir, nodeId, ref.sessionId);
  const nativeRecs = nativePath ? parseJsonl(nativePath) : [];

  let recs: Rec[];
  let origin: TranscriptOrigin;
  let fromNative: boolean;
  if (nativeRecs.length) {
    recs = nativeRecs;
    origin = { kind: 'native-session', path: nativePath };
    fromNative = true;
  } else {
    const archivePath = nodeEventsFile(runDir, nodeId);
    recs = parseNodeEventsFile(archivePath) as unknown as Rec[];
    fromNative = false;
    origin = recs.length ? { kind: 'archive', path: archivePath } : { kind: 'none', path: null };
  }

  const hasSource = recs.length > 0;
  const caps: TranscriptCapabilities = {
    ops: hasSource,
    opRanges: hasSource,
    // The archive caps a tool_use `input` at 512 bytes and TEARS long tool_result lines at 8192, so it
    // cannot be trusted to carry delivered payloads; the native transcript carries them whole.
    opResults: hasSource && fromNative,
    turns: hasSource,
    // Never true on either source — the record itself redacts the thinking text (see THINKING_REDACTED).
    turnThinking: false,
    turnDurations: hasSource,
  };
  const reasons: Record<keyof TranscriptCapabilities, string | null> = {
    ops: hasSource ? null : NO_SOURCE,
    opRanges: hasSource ? null : NO_SOURCE,
    opResults: hasSource ? (fromNative ? null : ARCHIVE_NO_TEXT) : NO_SOURCE,
    turns: hasSource ? null : NO_SOURCE,
    turnThinking: hasSource ? (fromNative ? THINKING_REDACTED : `${THINKING_REDACTED}; additionally ${ARCHIVE_NO_TEXT}`) : NO_SOURCE,
    turnDurations: hasSource ? null : NO_SOURCE,
  };

  let opsCache: TranscriptOp[] | null = null;
  let turnsCache: TranscriptTurn[] | null = null;

  return {
    executorId: 'claude-code',
    origin: () => origin,
    capabilities: () => caps,
    limitation: (cap) => reasons[cap],
    ops: () => (opsCache ??= decodeOps(recs)),
    turns: () => (turnsCache ??= decodeTurns(recs)),
  } satisfies TranscriptSource;
};
