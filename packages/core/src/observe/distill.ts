// distill.ts — a STREAM REDUCER over one node's pi event stream. THE shared rich per-node aggregator
// for every consumer (GUI HUD, TUI, CLI) — it lives here in @piflow/core/observe, not in any view, so
// GUI + TUI render the SAME numbers from the SAME code (no per-view re-derivation).
//
// THE design (per the io.json architecture): the pi event stream is the SINGLE source, flowing one
// direction. `events.jsonl` and `io.json` are two INDEPENDENT listeners on it — io.json co-listens and
// grabs only the updates it cares about. This reducer IS that listener, identical in two modes:
//   • live  (real SDK): the runner's recorder tee calls push(e) per event as it streams.
//   • replay (post-hoc): read a recorded events.jsonl and push each line (what buildRunView does).
//
// finalize(statusRec) returns { rich, io }: `rich` = everything a HUD wants (model/provider,
// toolBreakdown, per-tool timeline, reads, writes, bash, tokens, timing); `io` = the lean NodeIo ledger.
//
// pi tool vocabulary observed: bash, read, edit, write, grep, ls, find, submit_result.

import type { PiEvent } from '../runner/events.js';

const READ_TOOLS = new Set(['read', 'grep']); // file CONTENT reads → "input files"
const LIST_TOOLS = new Set(['ls', 'find']); // directory listings → scope touches, not file reads
const WRITE_TOOLS = new Set(['edit', 'write']); // file writes → "outputs"

const baseName = (p: unknown): unknown => (typeof p === 'string' ? p.split('/').pop() : p);

export interface RichTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextPeak: number;
  billable: number;
}
export interface RichRead { path: string; via: string; tStartMs: number | null; preview?: string }
export interface RichWrite { path: string; via: string; tStartMs: number | null; verified: boolean; bytes?: number }
export interface TimelineSpan { name: string; tStartMs: number | null; durMs: number; ok: boolean }
export interface BashCall { command: string; tStartMs: number | null }
export interface RichNode {
  model: string | null;
  provider: string | null;
  api: string | null;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  timeline: TimelineSpan[];
  reads: RichRead[];
  lists: { path: string; via: string }[];
  writes: RichWrite[];
  bash: BashCall[];
  tokens: RichTokens;
  /** count of `auto_retry_start` events — provider rate-limit/overload retries, invisible to the model. */
  retries: number;
  /** the assistant's final `message.stopReason` (last seen) — `'max_tokens'`/`'length'` ⇒ truncated. */
  stopReason: string | null;
  /** derived: the output was cut off by the token cap (stopReason `'max_tokens'` or `'length'`). */
  truncated: boolean;
  /** total `thinking_delta` characters — extended-thinking volume for this node. */
  thinkingChars: number;
  /** count of assistant `message_end` completions — how many times the model was invoked (loop signal). */
  modelCalls: number;
  /** the most times ONE tool ran with the SAME args fingerprint (≥3 ⇒ a probable tool loop). 0 = no tools. */
  maxToolRepeat: number;
  /** the tool name behind `maxToolRepeat` (null when no tool was called). */
  repeatedTool: string | null;
  coverage: { eventsSeen: number; usageEvents: number; byType: Record<string, number> };
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}
export interface LeanIo {
  reads: { path: string; via: string }[];
  writes: { path: string; verified: boolean; bytes?: number }[];
  promotes: never[];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

/** A status record (the run.json per-node shape) — only the fields finalize reads. */
export interface NodeStatusRecordLike {
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  artifacts?: { path: string; exists?: boolean; bytes?: number }[];
}

// Pull readable text out of a tool result ({ content:[{type:'text',text}] }), capped — so the HUD's
// "hover a read → see the file" shows the REAL bytes the agent read, not a placeholder.
const PREVIEW_CAP = 8000;
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

/** The live, NON-DESTRUCTIVE per-node read the telemetry stream polls mid-run (no open-span side effect). */
export interface LiveMetrics {
  model: string | null;
  provider: string | null;
  modelCalls: number;
  toolCalls: number;
  maxToolRepeat: number;
  repeatedTool: string | null;
  retries: number;
  stopReason: string | null;
  truncated: boolean;
  tokens: RichTokens;
}

export interface NodeAccumulator {
  push(e: PiEvent): void;
  /** Current counters WITHOUT closing open tool spans — safe to call any number of times mid-run. */
  metrics(): LiveMetrics;
  finalize(statusRec?: NodeStatusRecordLike): { rich: RichNode; io: LeanIo };
}

export function createNodeAccumulator(): NodeAccumulator {
  const reads = new Map<string, RichRead>();
  const lists = new Map<string, { path: string; via: string }>();
  const writes = new Map<string, RichWrite>();
  const bash: BashCall[] = [];
  const toolBreakdown: Record<string, number> = {};
  const open = new Map<string, { name: string; tStartMs: number | null; path: string | null }>();
  const timeline: TimelineSpan[] = [];
  let toolCalls = 0;
  let modelCalls = 0;
  // tool-loop fingerprint: `name|<args-json>` → times seen. maxRepeat/repeatedTool track the running peak.
  const fpCounts = new Map<string, number>();
  let maxToolRepeat = 0, repeatedTool: string | null = null;
  let retries = 0, stopReason: string | null = null, thinkingChars = 0;
  let model: string | null = null, provider: string | null = null, api: string | null = null;
  let firstT: number | null = null, lastT: number | null = null;
  let firstRt: string | null = null, lastRt: string | null = null;
  const tok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPeak: 0 };
  let eventsSeen = 0, usageEvents = 0;
  const byType: Record<string, number> = {};

  const seeT = (e: PiEvent) => {
    const t = e._t as unknown, rt = e._rt as unknown;
    if (typeof t === 'number') { if (firstT == null || t < firstT) firstT = t; if (lastT == null || t > lastT) lastT = t; }
    if (typeof rt === 'string') { if (!firstRt) firstRt = rt; lastRt = rt; }
  };

  // pi reports per-call cost as an OBJECT {input,output,cacheRead,cacheWrite,total} (some providers a
  // scalar, some 0). Reduce to ONE number so `cost += …` can never string-concat to "0[object Object]".
  const costScalar = (c: unknown): number => {
    if (typeof c === 'number') return c;
    if (c && typeof c === 'object') {
      const o = c as Record<string, number>;
      return typeof o.total === 'number' ? o.total : (o.input || 0) + (o.output || 0) + (o.cacheRead || 0) + (o.cacheWrite || 0);
    }
    return 0;
  };
  const seeModel = (m: unknown) => {
    const msg = m as { role?: string; model?: string; provider?: string; api?: string } | undefined;
    if (msg && msg.role === 'assistant' && !model && msg.model) { model = msg.model; provider = msg.provider ?? provider; api = msg.api ?? api; }
  };
  // input/output/cache* are per-call → SUM; totalTokens is the per-call context size → MAX (contextPeak).
  const addUsage = (u: unknown) => {
    if (!u || typeof u !== 'object') return;
    const usage = u as Record<string, number>;
    usageEvents += 1;
    tok.input += usage.input || 0; tok.output += usage.output || 0;
    tok.cacheRead += usage.cacheRead || 0; tok.cacheWrite += usage.cacheWrite || 0;
    tok.cost += costScalar(usage.cost);
    if ((usage.totalTokens || 0) > tok.contextPeak) tok.contextPeak = usage.totalTokens;
  };

  return {
    push(e: PiEvent) {
      if (!e || typeof e !== 'object') return;
      eventsSeen += 1;
      const type = e.type as string;
      byType[type] = (byType[type] || 0) + 1;
      seeT(e);
      switch (type) {
        case 'message_start':
          seeModel(e.message);
          break;
        // message_end carries the per-call FINAL usage. `turn_end` carries an IDENTICAL rollup, so
        // reading it too would DOUBLE-count — we deliberately ignore turn_end for usage.
        case 'message_end': {
          seeModel(e.message);
          const msg = e.message as { role?: string; usage?: unknown; stopReason?: unknown } | undefined;
          if (msg && msg.role === 'assistant') {
            modelCalls += 1; // one assistant completion = one model invocation (the cheapest loop signal)
            addUsage(msg.usage);
            // stopReason='max_tokens'/'length' ⇒ the output was truncated by the token cap.
            if (typeof msg.stopReason === 'string') stopReason = msg.stopReason;
          }
          break;
        }
        // provider rate-limit/overload retry (429/overload) — counted, invisible to the model.
        case 'auto_retry_start':
          retries += 1;
          break;
        // extended-thinking volume: sum the delta string lengths (the TUI reads this event too).
        case 'thinking_delta':
          if (typeof e.delta === 'string') thinkingChars += e.delta.length;
          break;
        case 'tool_execution_start': {
          toolCalls += 1;
          const name = e.toolName as string;
          toolBreakdown[name] = (toolBreakdown[name] || 0) + 1;
          const args = e.args as { path?: string; command?: string } | undefined;
          // fingerprint the call (name + exact args) so N identical calls surface as a loop. JSON.stringify
          // is guarded — a non-serializable args object just folds to the tool name (still counts repeats).
          let fp = name;
          try { fp = `${name}|${JSON.stringify(args ?? {})}`; } catch { /* keep bare name */ }
          const seen = (fpCounts.get(fp) ?? 0) + 1;
          fpCounts.set(fp, seen);
          if (seen > maxToolRepeat) { maxToolRepeat = seen; repeatedTool = name; }
          const p = args && args.path;
          open.set(e.toolCallId as string, { name, tStartMs: (e._t as number) ?? null, path: READ_TOOLS.has(name) && p ? p : null });
          if (READ_TOOLS.has(name) && p) { if (!reads.has(p)) reads.set(p, { path: p, via: name, tStartMs: (e._t as number) ?? null }); }
          else if (LIST_TOOLS.has(name) && p) { if (!lists.has(p)) lists.set(p, { path: p, via: name }); }
          else if (WRITE_TOOLS.has(name) && p) { if (!writes.has(p)) writes.set(p, { path: p, via: name, tStartMs: (e._t as number) ?? null, verified: false }); }
          else if (name === 'bash' && args && args.command) bash.push({ command: args.command, tStartMs: (e._t as number) ?? null });
          break;
        }
        case 'tool_execution_end': {
          const span = open.get(e.toolCallId as string);
          if (span) {
            const t = e._t as number | undefined;
            const durMs = (t != null && span.tStartMs != null) ? Math.max(0, t - span.tStartMs) : 0;
            timeline.push({ name: span.name, tStartMs: span.tStartMs, durMs, ok: !(e.isError as boolean) });
            if (span.path && reads.has(span.path) && !reads.get(span.path)!.preview) {
              const preview = resultText(e.result);
              if (preview) reads.get(span.path)!.preview = preview;
            }
            open.delete(e.toolCallId as string);
          }
          break;
        }
        default: break;
      }
    },

    metrics(): LiveMetrics {
      return {
        model, provider,
        modelCalls, toolCalls, maxToolRepeat, repeatedTool, retries, stopReason,
        truncated: stopReason === 'max_tokens' || stopReason === 'length',
        tokens: { ...tok, billable: tok.input + tok.output },
      };
    },

    finalize(statusRec: NodeStatusRecordLike = {}) {
      // close any tool spans that never saw an _end (killed mid-call) so timeline stays 1:1 with calls
      for (const span of open.values()) timeline.push({ name: span.name, tStartMs: span.tStartMs, durMs: 0, ok: true });
      open.clear();

      // verified-not-trusted: a write is "verified" only if a real on-disk artifact matches it.
      const artByBase = new Map((statusRec.artifacts || []).map((a) => [baseName(a.path), a]));
      const writeArr: RichWrite[] = [...writes.values()].map((w) => {
        const a = artByBase.get(baseName(w.path));
        return { path: w.path, via: w.via, tStartMs: w.tStartMs, verified: !!(a && a.exists), bytes: a ? a.bytes : undefined };
      });

      const startedAt = statusRec.startedAt || firstRt || undefined;
      const endedAt = statusRec.endedAt || lastRt || undefined;
      const durationMs = statusRec.durationMs ?? ((firstT != null && lastT != null) ? lastT - firstT : undefined);

      const rich: RichNode = {
        model, provider, api,
        toolCalls, toolBreakdown, timeline,
        reads: [...reads.values()],
        lists: [...lists.values()],
        writes: writeArr,
        bash,
        tokens: { ...tok, billable: tok.input + tok.output },
        retries, stopReason,
        truncated: stopReason === 'max_tokens' || stopReason === 'length',
        thinkingChars,
        modelCalls, maxToolRepeat, repeatedTool,
        coverage: { eventsSeen, usageEvents, byType },
        startedAt, endedAt, durationMs,
      };
      const io: LeanIo = {
        reads: [...reads.values()].map((r) => ({ path: r.path, via: r.via })),
        writes: writeArr.map((w) => ({ path: w.path, verified: w.verified, bytes: w.bytes })),
        promotes: [],
        startedAt, endedAt, durationMs,
      };
      return { rich, io };
    },
  };
}
