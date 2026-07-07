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

/**
 * (P6) The CANONICAL loop fingerprint both accumulators (pi + Claude) key `loopScore` on: `name + "|" +
 * args-first-100-chars`. DISTINCT from the maxToolRepeat fingerprint (`name|JSON.stringify(args)`, the FULL
 * args): truncating to the first 100 arg chars makes near-identical retries (same command, a different
 * trailing comment/suffix) collapse to ONE key, so a stuck back-to-back loop surfaces where the full-args
 * global peak misses it. Guarded like the full-args fingerprint — non-serializable args fold to the bare name.
 */
export function loopFingerprint(name: string, args: unknown): string {
  let s = '';
  try { s = JSON.stringify(args ?? {}); } catch { s = ''; }
  return `${name}|${s.slice(0, 100)}`;
}

/**
 * (P6) A tiny consecutive-run tracker for `loopScore` — the LONGEST run of back-to-back identical
 * fingerprints. `see(fp)` folds one tool call in order; `.value` is the running longest run. Distinct from a
 * global-peak counter (maxToolRepeat): a repeat only counts if it is IMMEDIATELY after the same fingerprint.
 */
export function createLoopCounter() {
  let prev: string | null = null, run = 0, longest = 0;
  return {
    see(fp: string) {
      run = fp === prev ? run + 1 : 1;
      prev = fp;
      if (run > longest) longest = run;
    },
    get value() { return longest; },
  };
}

// Recursively freeze an object graph — the snapshot() contract is a FROZEN copy so a live consumer can
// hold it across polls without another poll (or a view) mutating it out from under them.
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

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
  /**
   * ADDITIVE per-tool error tally — attempts on `toolBreakdown` that resolved `isError:true` on their
   * `tool_execution_end` (the same read the timeline's `ok` flag already uses). `toolBreakdown` keeps
   * counting every attempt exactly as before; this is a PARALLEL map so a rejected-only tool (e.g. "Tool
   * bash not found") stops looking identical to a real execution in a ranking that reads only the count.
   * A tool absent here had zero errors. Keyed identically to `toolBreakdown` (never a superset of its keys).
   */
  toolErrorCounts: Record<string, number>;
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
  /**
   * (P6) the LONGEST run of CONSECUTIVE back-to-back identical tool calls, keyed on the CANONICAL fingerprint
   * `name + "|" + args-first-100-chars`. DISTINCT from `maxToolRepeat` (a global peak on the FULL-args
   * fingerprint): loopScore catches a STUCK back-to-back loop of near-identical retries that the full-args
   * global peak misses. Computed in BOTH accumulators (pi + Claude) off the same shared fingerprint helper.
   */
  loopScore: number;
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
  /** (P6) consecutive-repeat loop signal — see RichNode.loopScore. */
  loopScore: number;
  retries: number;
  stopReason: string | null;
  truncated: boolean;
  tokens: RichTokens;
}

export interface NodeAccumulator {
  push(e: PiEvent): void;
  /** Current counters WITHOUT closing open tool spans — safe to call any number of times mid-run. */
  metrics(): LiveMetrics;
  /**
   * The live, NON-DESTRUCTIVE twin of `finalize()`: a FROZEN copy of the full rich node (timeline WITH
   * still-open tool spans projected read-only — same `durMs:0/ok:true` shape finalize would synth-close
   * them to — plus toolBreakdown/reads/writes/tokens/retries/stopReason/modelCalls/everything), WITHOUT
   * mutating `open` or any accumulator state. Safe to call any number of times mid-run; a subsequent
   * `finalize()` still closes real open spans correctly. On a SETTLED node (no open spans) it deep-equals
   * `finalize().rich`. This is what the live telemetry stream folds per poll instead of the destructive
   * `finalize()` (which double-pushes timeline spans + drops the real tool_execution_end).
   */
  snapshot(statusRec?: NodeStatusRecordLike): RichNode;
  finalize(statusRec?: NodeStatusRecordLike): { rich: RichNode; io: LeanIo };
}

export function createNodeAccumulator(): NodeAccumulator {
  const reads = new Map<string, RichRead>();
  const lists = new Map<string, { path: string; via: string }>();
  const writes = new Map<string, RichWrite>();
  const bash: BashCall[] = [];
  const toolBreakdown: Record<string, number> = {};
  const toolErrorCounts: Record<string, number> = {};
  const open = new Map<string, { name: string; tStartMs: number | null; path: string | null }>();
  const timeline: TimelineSpan[] = [];
  let toolCalls = 0;
  let modelCalls = 0;
  // tool-loop fingerprint: `name|<args-json>` → times seen. maxRepeat/repeatedTool track the running peak.
  const fpCounts = new Map<string, number>();
  let maxToolRepeat = 0, repeatedTool: string | null = null;
  // (P6) loopScore: longest run of CONSECUTIVE calls sharing the canonical (first-100) fingerprint.
  const loop = createLoopCounter();
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
          // (P6) fold the CANONICAL (first-100) fingerprint into the consecutive-run tracker — DISTINCT
          // from maxToolRepeat's full-args global peak.
          loop.see(loopFingerprint(name, args ?? {}));
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
            const isError = !!(e.isError as boolean);
            timeline.push({ name: span.name, tStartMs: span.tStartMs, durMs, ok: !isError });
            // same isError read as the timeline's `ok` flag above — tallied per tool name, additively.
            if (isError) toolErrorCounts[span.name] = (toolErrorCounts[span.name] || 0) + 1;
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
        modelCalls, toolCalls, maxToolRepeat, repeatedTool,
        loopScore: loop.value,
        retries, stopReason,
        truncated: stopReason === 'max_tokens' || stopReason === 'length',
        tokens: { ...tok, billable: tok.input + tok.output },
      };
    },

    snapshot(statusRec: NodeStatusRecordLike = {}): RichNode {
      // NON-DESTRUCTIVE: project each still-open span read-only (same durMs:0/ok:true shape finalize
      // synth-closes them to) onto a THROWAWAY timeline copy — never touch the real `timeline`/`open`,
      // so this is safe to call any number of times mid-run and a later real tool_execution_end still
      // produces the correct closed span.
      const projected = [...timeline];
      for (const span of open.values()) projected.push({ name: span.name, tStartMs: span.tStartMs, durMs: 0, ok: true });
      return deepFreeze(assembleRich(statusRec, projected).rich);
    },

    finalize(statusRec: NodeStatusRecordLike = {}) {
      // close any tool spans that never saw an _end (killed mid-call) so timeline stays 1:1 with calls
      for (const span of open.values()) timeline.push({ name: span.name, tStartMs: span.tStartMs, durMs: 0, ok: true });
      open.clear();
      return assembleRich(statusRec, timeline);
    },
  };

  // Assemble the { rich, io } pair from current accumulator state + the timeline to project (finalize
  // passes the mutated-in-place real timeline; snapshot passes a throwaway copy with open spans appended).
  // The result is DEEP-FROZEN so no consumer can mutate the shared reduced node.
  function assembleRich(statusRec: NodeStatusRecordLike, timelineOut: TimelineSpan[]): { rich: RichNode; io: LeanIo } {
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
      toolCalls, toolBreakdown: { ...toolBreakdown }, toolErrorCounts: { ...toolErrorCounts }, timeline: [...timelineOut],
      reads: [...reads.values()].map((r) => ({ ...r })),
      lists: [...lists.values()].map((l) => ({ ...l })),
      writes: writeArr,
      bash: bash.map((b) => ({ ...b })),
      tokens: { ...tok, billable: tok.input + tok.output },
      retries, stopReason,
      truncated: stopReason === 'max_tokens' || stopReason === 'length',
      thinkingChars,
      modelCalls, maxToolRepeat, repeatedTool,
      loopScore: loop.value,
      coverage: { eventsSeen, usageEvents, byType: { ...byType } },
      startedAt, endedAt, durationMs,
    };
    const io: LeanIo = {
      reads: [...reads.values()].map((r) => ({ path: r.path, via: r.via })),
      writes: writeArr.map((w) => ({ path: w.path, verified: w.verified, bytes: w.bytes })),
      promotes: [],
      startedAt, endedAt, durationMs,
    };
    return { rich, io };
  }
}
