// transcript-pi.ts — the `pi` adapter of the TRANSCRIPT PORT (./transcript.ts).
//
// Decodes pi's OWN event vocabulary natively — flat `tool_execution_start`/`tool_execution_end` pairs,
// `turn_start` turn boundaries, and `message_update.assistantMessageEvent.{thinking,text}_delta` volume —
// into the shared `TranscriptOp`/`TranscriptTurn` records. Nothing is transcoded through another executor's
// schema; this reads pi bytes and emits the vocabulary.
//
// SOURCE POLICY (pi's own — each adapter owns its policy; the port dictates none): the piflow ARCHIVE
// (`.pi/nodes/<id>/events.jsonl`) is authoritative whenever it carries real model activity; a STARVED archive
// (a session-only node whose stdout tee captured no model turn) falls back to pi's NATIVE session file via
// the shipped locator/transcoder in runner/pi-session.ts. This is the exact policy the pre-port readers had,
// so a pi node's verb output is unchanged by the port landing.
//
// CAPABILITIES: pi's stream carries everything — ordered ops with ranges and results, turn boundaries,
// thinking volume, and real per-turn wall-clock — so every capability is declared true.

import {
  parseNodeEventsFile, recoverNodeEvents, eventsHaveModelActivity, locatePiSessionFile,
} from '../runner/pi-session.js';
import { nodeEventsFile, piSessionsDir } from '../runner/layout.js';
import type { PiEvent } from '../runner/events.js';
import {
  ALL_CAPABILITIES, argsPreview, capText, rangeOf,
  type TranscriptCapabilities, type TranscriptOp, type TranscriptOpKind, type TranscriptOrigin,
  type TranscriptReader, type TranscriptSource, type TranscriptTurn,
} from './transcript.js';

/** pi tool name → the port's executor-neutral op kind. An unmapped tool (e.g. `submit_result`) is `other`:
 *  still COUNTED as a tool call, but contributing no read/write signal — the same set the pre-port decoder
 *  surfaced as context (read/grep/edit/write/ls/find/bash), with everything else honestly bucketed. */
function piOpKind(toolName: string): TranscriptOpKind {
  switch (toolName) {
    case 'read': return 'read';
    case 'grep': return 'grep';
    case 'edit': return 'edit';
    case 'write': return 'write';
    case 'ls': case 'find': return 'list';
    case 'bash': return 'bash';
    default: return 'other';
  }
}

interface RawPiEvent {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  args?: { path?: unknown; offset?: unknown; limit?: unknown };
  result?: unknown;
  isError?: unknown;
  _t?: unknown;
  assistantMessageEvent?: { type?: string; delta?: unknown };
  event?: { type?: string; delta?: unknown };
}

/** pi nests a per-token sub-event under `assistantMessageEvent` or (older archives) `event`. */
function inner(ev: RawPiEvent): { type?: string; delta?: unknown } | undefined {
  const a = ev.assistantMessageEvent ?? (ev.type === 'message_update' ? ev.event : undefined);
  return a && typeof a === 'object' ? a : undefined;
}

/** Pull the joined plaintext out of a `{content:[{type:'text',text}]}` tool result (best-effort, bounded). */
function resultTextOf(result: unknown): string | undefined {
  const r = result as { content?: unknown } | null | undefined;
  if (!r || !Array.isArray(r.content)) return undefined;
  const text = (r.content as { type?: string; text?: string }[])
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
  return capText(text);
}

/** Decode pi's flat tool-span events into ordered ops (start opens, the matching end by toolCallId closes). */
function decodeOps(events: RawPiEvent[]): TranscriptOp[] {
  const ops: TranscriptOp[] = [];
  const byId = new Map<string, TranscriptOp>();
  for (const ev of events) {
    if (ev.type === 'tool_execution_start') {
      const toolName = typeof ev.toolName === 'string' ? ev.toolName : '';
      const op: TranscriptOp = {
        seq: ops.length,
        tMs: typeof ev._t === 'number' ? ev._t : null,
        kind: piOpKind(toolName),
        toolName,
        toolCallId: typeof ev.toolCallId === 'string' && ev.toolCallId ? ev.toolCallId : null,
        path: typeof ev.args?.path === 'string' ? ev.args.path : '',
        range: rangeOf(ev.args?.offset, ev.args?.limit),
        ok: true,
        logPreviewCapped: false,
      };
      ops.push(op);
      if (op.toolCallId) byId.set(op.toolCallId, op);
    } else if (ev.type === 'tool_execution_end') {
      const id = typeof ev.toolCallId === 'string' ? ev.toolCallId : '';
      const op = id ? byId.get(id) : undefined;
      if (!op) continue;
      op.ok = !(ev.isError === true);
      // `result.truncated === true` is the ARCHIVE's 2048-char preview cap — a LOGGING artifact, never a
      // model-side truncation. It sets only the cosmetic flag; the delivered payload is left undecodable.
      if ((ev.result as { truncated?: unknown } | undefined)?.truncated === true) {
        op.logPreviewCapped = true;
      }
      const text = resultTextOf(ev.result);
      if (text != null) op.resultText = text;
    }
  }
  return ops;
}

/** Segment pi's stream into turns: strictly `turn_start` → the NEXT `turn_start` (pi emits `turn_end` only
 *  sometimes, so it is not a reliable boundary). A turn's span runs to the next turn's own start, so every
 *  ms of the run belongs to exactly one turn (tool-dispatch latency included). */
function decodeTurns(events: RawPiEvent[]): TranscriptTurn[] {
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

  for (const ev of events) {
    const t = typeof ev._t === 'number' ? ev._t : null;
    if (firstT == null && t != null) firstT = t;

    if (ev.type === 'turn_start') {
      if (cur && t != null) cur.lastT = t;
      close();
      const startAbsT = t ?? (firstT ?? 0);
      cur = {
        index: turns.length, startMs: 0, durMs: 0, thinkChars: 0, textChars: 0, thinkText: '', text: '',
        toolCalls: [], startAbsT, lastT: startAbsT,
      };
      continue;
    }

    // CONTENT events only ever belong to a turn. A stream whose deltas/tool calls arrive with NO enclosing
    // `turn_start` (a driver that never emits one, a capture that began mid-turn) opens an IMPLICIT turn
    // here rather than dropping them — losing them would silently zero a node's text and tool tally, which
    // is the exact class of false-empty this port exists to eliminate. Non-content bookkeeping events
    // (`session`/`agent_start`) never open a turn: they only set the run's time origin.
    const a = ev.type === 'message_update' ? inner(ev) : undefined;
    const isThink = a?.type === 'thinking_delta' && typeof a.delta === 'string';
    const isText = a?.type === 'text_delta' && typeof a.delta === 'string';
    const isTool = ev.type === 'tool_execution_start';
    if (!isThink && !isText && !isTool) {
      if (cur && t != null) cur.lastT = t;
      continue;
    }
    if (!cur) {
      const startAbsT = t ?? (firstT ?? 0);
      cur = {
        index: turns.length, startMs: 0, durMs: 0, thinkChars: 0, textChars: 0, thinkText: '', text: '',
        toolCalls: [], startAbsT, lastT: startAbsT,
      };
    }
    if (t != null) cur.lastT = t;

    if (isThink) {
      cur.thinkChars += (a!.delta as string).length;
      cur.thinkText += a!.delta as string;
    } else if (isText) {
      cur.textChars += (a!.delta as string).length;
      cur.text += a!.delta as string;
    } else {
      cur.toolCalls.push({ name: typeof ev.toolName === 'string' ? ev.toolName : '', argsPreview: argsPreview(ev.args) });
    }
  }
  close();
  return turns;
}

/**
 * The `pi` transcript adapter. Reads once at construction (archive, falling back to pi's native session when
 * the archive is starved) and decodes lazily on first `ops()`/`turns()`.
 */
export const piTranscript: TranscriptReader = (runDir, nodeId, ref = {}) => {
  const archivePath = nodeEventsFile(runDir, nodeId);
  const archive = parseNodeEventsFile(archivePath) as unknown as RawPiEvent[];

  let events = archive;
  let origin: TranscriptOrigin = { kind: 'archive', path: archivePath };
  if (!eventsHaveModelActivity(archive as unknown as PiEvent[])) {
    const recovered = recoverNodeEvents(runDir, ref, nodeId) as unknown as RawPiEvent[] | null;
    if (recovered) {
      events = recovered;
      const dir = ref.sessionDir?.trim() ? ref.sessionDir : piSessionsDir(runDir);
      origin = { kind: 'native-session', path: locatePiSessionFile(dir, ref.sessionId ?? nodeId) };
    } else if (archive.length === 0) {
      origin = { kind: 'none', path: null };
    }
  }

  let opsCache: TranscriptOp[] | null = null;
  let turnsCache: TranscriptTurn[] | null = null;
  const caps: TranscriptCapabilities = { ...ALL_CAPABILITIES };

  return {
    executorId: 'pi',
    origin: () => origin,
    capabilities: () => caps,
    limitation: () => null, // every capability is true — pi's stream carries the full signal
    ops: () => (opsCache ??= decodeOps(events)),
    turns: () => (turnsCache ??= decodeTurns(events)),
  } satisfies TranscriptSource;
};
