// optimize/substrate/trace-metrics.ts — M3.3 of docs/specs/optimize-substrate-plan.md: the built-in trace
// detectors over a node's `.pi/nodes/<id>/events.jsonl`. Generic pi-event parsing, product-agnostic (⇒
// core-legal — no product-specific logic lives here). PURE over a list of raw text lines (never touches
// disk itself; `analyzeTraceFile` is the thin fs-reading wrapper `measure.ts` calls).
//
// EVENT SHAPES (corrected per the live histogram — plan §M3.3, ⚡ verified against a real capture):
//   • `thinking_start`/`thinking_delta`/`thinking_end` are NOT top-level event types — they are
//     `message_update.assistantMessageEvent.type` values (runner/logs.ts:29's `inner()` helper reads the
//     SAME nesting). A span pairs a `thinking_start` line with its `thinking_end` line via `_t` (the
//     recorder's ms-since-open clock, runner/events.ts) — there is no correlation id, so spans are simply
//     FIFO-nested per the enclosing stream (one open span at a time, matching how pi actually emits them).
//   • `tool_execution_start`/`tool_execution_end` carry `toolCallId`/`toolName`/`args`/`result` (identical
//     vocabulary to distill.ts's pi accumulator).
//   • usage lives at `turn_end.message.usage.{input,output,cacheRead,cacheWrite,…}` (NOT `turn_end.usage`) —
//     `message` is the SAME slimmed shape events.ts's `KEEP_MSG_FIELDS` preserves (`role,model,provider,api,
//     usage,stopReason`).
//
// THE 8192-BYTE HARD TRUNCATION (events.ts `MAX_LINE`): a line over the cap is sliced mid-object by the
// recorder, so `JSON.parse` on it throws. This module SKIPS-AND-COUNTS any unparseable line (`truncatedLines`)
// — it never throws — and, when a thinking span was left open across a truncated line, APPROXIMATES that
// span's end from the next PARSEABLE event's `_t` (the closest true signal available), flagging the span
// `approx:true` so a consumer can discount its precision without discarding the data point entirely.

import { readFileSync } from 'node:fs';

/** Config-with-defaults thresholds every detector compares against. All overridable; none required. */
export interface SubstrateThresholds {
  /** Minimum thinking-span duration (ms) to flag a `thinking-stall`. Default 8000 (the tS2 9–13s blocks). */
  thinkingStallMs: number;
  /** Minimum repeat count of a BYTE-IDENTICAL (tool,args) result to flag a `tool-loop`. Default 3. */
  toolLoopRepeat: number;
  /** Minimum (last-turn input / first-turn input) ratio to flag cumulative `token-waste` growth. Default 2. */
  tokenWasteGrowthRatio: number;
}

/** The documented defaults — every field overridable via `RunSubstrateMeasureOpts.thresholds`. */
export const DEFAULT_SUBSTRATE_THRESHOLDS: SubstrateThresholds = {
  thinkingStallMs: 8000,
  toolLoopRepeat: 3,
  tokenWasteGrowthRatio: 2,
};

/** One completed (or approximated) thinking span. */
export interface ThinkingSpan {
  tStartMs: number | null;
  tEndMs: number | null;
  durationMs: number;
  /** accumulated `thinking_delta` char count, OR the full `content` length when the `thinking_end` carries it. */
  chars: number;
  /** true when the span's end was RECONSTRUCTED from a surrounding parseable event (its own closer was
   *  truncated/unparseable, or the stream ended with the span still open). */
  approx: boolean;
}

/** A flagged tool-loop group: `count` byte-identical results for the SAME (toolName, args). */
export interface ToolLoopFlag {
  toolName: string;
  /** `"<name>|<JSON args>"` — the grouping key (mirrors distill.ts's fingerprint). */
  argsKey: string;
  count: number;
}

/** Cumulative input-token growth across `turn_end`s. `null` when fewer than 2 turns were observed. */
export interface TokenWasteSignal {
  turns: number;
  firstTurnInput: number;
  lastTurnInput: number;
  ratio: number;
  flagged: boolean;
}

/** A cache-miss: the provider REPORTS cache fields (so caching is possible) but this turn missed. */
export interface CacheMissFlag {
  turnIndex: number;
  api: string | null;
}

/** The full detector report for one node's event stream. */
export interface TraceMetricsReport {
  /** parseable, non-blank event lines seen. */
  eventsSeen: number;
  /** non-blank lines that failed `JSON.parse` (the 8192-byte hard-truncation case, or any other corruption). */
  truncatedLines: number;
  thinkingSpans: ThinkingSpan[];
  /** the subset of `thinkingSpans` at/above `thresholds.thinkingStallMs`. */
  thinkingStalls: ThinkingSpan[];
  toolLoops: ToolLoopFlag[];
  tokenWaste: TokenWasteSignal | null;
  cacheMisses: CacheMissFlag[];
}

type Ev = Record<string, unknown>;
type ParsedLine = { ok: true; ev: Ev } | { ok: false };

function innerOf(ev: Ev): Ev | undefined {
  const a = ev.assistantMessageEvent;
  return a && typeof a === 'object' ? (a as Ev) : undefined;
}
function tOf(ev: Ev): number | null {
  return typeof ev._t === 'number' ? (ev._t as number) : null;
}
/** Stable stringify for a tool-loop grouping key; a non-serializable value folds to the bare name (still
 *  counts repeats — mirrors distill.ts's guarded fingerprint). */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return String(v);
  }
}

/**
 * Analyze a node's raw event lines (as read from `.pi/nodes/<id>/events.jsonl`, one JSON object per line) —
 * PURE, never throws, never touches disk. `thresholds` overrides `DEFAULT_SUBSTRATE_THRESHOLDS` per key.
 */
export function analyzeEvents(rawLines: string[], thresholds: Partial<SubstrateThresholds> = {}): TraceMetricsReport {
  const th: SubstrateThresholds = { ...DEFAULT_SUBSTRATE_THRESHOLDS, ...thresholds };
  const nonBlank = rawLines.map((l) => l.trim()).filter((l) => l.length > 0);
  const parsed: ParsedLine[] = nonBlank.map((s) => {
    try {
      return { ok: true, ev: JSON.parse(s) as Ev };
    } catch {
      return { ok: false };
    }
  });

  let eventsSeen = 0;
  let truncatedLines = 0;
  const thinkingSpans: ThinkingSpan[] = [];
  let openStartT: number | null = null;
  let openChars = 0;
  let lastParsedT: number | null = null;

  // tool-loop bookkeeping: toolCallId -> {name, argsKey} while open; completed calls accumulate for grouping.
  const openTools = new Map<string, { name: string; argsKey: string }>();
  const completed: { name: string; argsKey: string; resultKey: string }[] = [];

  // token-waste + cache-miss bookkeeping (turn_end events, in order).
  const turnInputs: number[] = [];
  const cacheMisses: CacheMissFlag[] = [];
  let turnIdx = 0;

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (!p.ok) {
      truncatedLines++;
      // an OPEN thinking span whose closer just failed to parse: approximate its end from the NEXT
      // parseable event's `_t` (the closest true signal available) rather than dropping the data point.
      if (openStartT != null) {
        let approxT: number | null = null;
        for (let j = i + 1; j < parsed.length; j++) {
          const nxt = parsed[j];
          if (nxt.ok) {
            approxT = tOf(nxt.ev);
            break;
          }
        }
        if (approxT != null) {
          thinkingSpans.push({
            tStartMs: openStartT,
            tEndMs: approxT,
            durationMs: Math.max(0, approxT - openStartT),
            chars: openChars,
            approx: true,
          });
        }
        openStartT = null;
        openChars = 0;
      }
      continue;
    }

    const ev = p.ev;
    eventsSeen++;
    const t = tOf(ev);
    if (t != null) lastParsedT = t;

    if (ev.type === 'message_update') {
      const inner = innerOf(ev);
      const kind = inner?.type;
      if (kind === 'thinking_start') {
        openStartT = t;
        openChars = 0;
      } else if (kind === 'thinking_delta') {
        if (typeof inner?.delta === 'string') openChars += (inner.delta as string).length;
      } else if (kind === 'thinking_end') {
        // the `thinking_end` sub-event may carry the FULL accumulated content — prefer it over the summed
        // deltas (it is the authoritative final length; a truncated stream may have missed some deltas).
        if (typeof inner?.content === 'string') openChars = (inner.content as string).length;
        if (openStartT != null) {
          thinkingSpans.push({
            tStartMs: openStartT,
            tEndMs: t,
            durationMs: t != null ? Math.max(0, t - openStartT) : 0,
            chars: openChars,
            approx: false,
          });
        }
        openStartT = null;
        openChars = 0;
      }
    } else if (ev.type === 'tool_execution_start') {
      const id = ev.toolCallId;
      const name = String(ev.toolName ?? '?');
      const argsKey = `${name}|${safeJson(ev.args)}`;
      if (typeof id === 'string') openTools.set(id, { name, argsKey });
    } else if (ev.type === 'tool_execution_end') {
      const id = ev.toolCallId;
      const open = typeof id === 'string' ? openTools.get(id) : undefined;
      if (open) {
        completed.push({ name: open.name, argsKey: open.argsKey, resultKey: safeJson(ev.result) });
        openTools.delete(id as string);
      }
    } else if (ev.type === 'turn_end') {
      const msg = ev.message as Ev | undefined;
      const usage = msg?.usage as Record<string, unknown> | undefined;
      const api = typeof msg?.api === 'string' ? (msg.api as string) : null;
      if (usage) {
        const input = typeof usage.input === 'number' ? usage.input : 0;
        turnInputs.push(input);
        // cache-miss fires ONLY when the provider REPORTS cache fields at all (`'cacheRead' in usage`) — a
        // provider/api that never reports cache (e.g. openai-completions) never trips this, by construction.
        if ('cacheRead' in usage && usage.cacheRead === 0) cacheMisses.push({ turnIndex: turnIdx, api });
      }
      turnIdx++;
    }
  }

  // a trailing OPEN span (stream ended, no truncation, no thinking_end ever arrived): approximate its end
  // at the last parseable event's `_t` rather than leaving it dangling.
  if (openStartT != null) {
    const endT = lastParsedT;
    thinkingSpans.push({
      tStartMs: openStartT,
      tEndMs: endT,
      durationMs: endT != null ? Math.max(0, endT - openStartT) : 0,
      chars: openChars,
      approx: true,
    });
  }

  const thinkingStalls = thinkingSpans.filter((s) => s.durationMs >= th.thinkingStallMs);

  // tool-loop: group completed calls by (argsKey -> resultKey -> count); flag a (name,args) whose result was
  // BYTE-IDENTICAL >= toolLoopRepeat times. Identical args with DIFFERENT results across calls never flags
  // (the tool did legitimately different work each time).
  const nameByArgsKey = new Map<string, string>();
  const byArgsKey = new Map<string, Map<string, number>>();
  for (const c of completed) {
    nameByArgsKey.set(c.argsKey, c.name);
    if (!byArgsKey.has(c.argsKey)) byArgsKey.set(c.argsKey, new Map());
    const byResult = byArgsKey.get(c.argsKey)!;
    byResult.set(c.resultKey, (byResult.get(c.resultKey) ?? 0) + 1);
  }
  const toolLoops: ToolLoopFlag[] = [];
  for (const [argsKey, byResult] of byArgsKey) {
    for (const count of byResult.values()) {
      if (count >= th.toolLoopRepeat) toolLoops.push({ toolName: nameByArgsKey.get(argsKey) ?? '?', argsKey, count });
    }
  }

  // token-waste: ratio of the LAST turn's input to the FIRST — the simplest falsifiable cumulative-growth
  // signal (a real context-bloat loop keeps re-sending an ever-larger history). Needs >= 2 turns to have a
  // ratio at all.
  let tokenWaste: TokenWasteSignal | null = null;
  if (turnInputs.length >= 2) {
    const first = turnInputs[0];
    const last = turnInputs[turnInputs.length - 1];
    const ratio = first > 0 ? last / first : last > 0 ? Infinity : 1;
    tokenWaste = { turns: turnInputs.length, firstTurnInput: first, lastTurnInput: last, ratio, flagged: ratio >= th.tokenWasteGrowthRatio };
  }

  return { eventsSeen, truncatedLines, thinkingSpans, thinkingStalls, toolLoops, tokenWaste, cacheMisses };
}

/** Read `eventsFile` (best-effort — absent/unreadable degrades to no lines) and run `analyzeEvents` over it. */
export function analyzeTraceFile(eventsFile: string, thresholds: Partial<SubstrateThresholds> = {}): TraceMetricsReport {
  let raw = '';
  try {
    raw = readFileSync(eventsFile, 'utf8');
  } catch {
    raw = '';
  }
  return analyzeEvents(raw.split('\n'), thresholds);
}
