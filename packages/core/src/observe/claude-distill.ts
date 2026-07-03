// claude-distill.ts — the STREAM REDUCER over one node's CLAUDE stream-json event stream (P5 of the
// AgentDriver registry, docs/design/agent-driver-registry.md §4/§4.1). The count-only TWIN of the pi
// reducer in ./distill.ts: same NodeAccumulator surface (push/metrics/snapshot/finalize) producing the
// same RichNode shape, so `assembleNode` (the ONE shared assembler) folds a Claude node exactly like a pi
// node — a blank Claude node becomes a real tool list.
//
// WHY a second reducer: Claude `--output-format stream-json` speaks a DIFFERENT vocabulary from pi. Tool
// calls are NESTED content blocks — `assistant.message.content[].tool_use` opens a call, the matching
// `user.message.content[].tool_result` (same `tool_use_id`) closes it — NOT pi's flat
// `tool_execution_start`/`tool_execution_end` events. Claude carries NO per-tool END timestamp, so a tool
// span's `durMs` is UNRECOVERABLE ⇒ EVERY span is `durMs:0` (the §4.1 count-only ceiling; the driver
// declares `telemetry.perToolTimeline:'count-only'`). We never fake a duration.
//
// TOKENS/MODEL are ALSO accumulated here (Defect E2) as the FALLBACK for a run that carries no authoritative
// `rec.usage` (a LEGACY run — no `result`-derived rollup was ever persisted). `nodeTokenSpine` (runView.ts)
// still PREFERS `rec.usage` when present — this reducer's tokens/model are read only via its `{...rich.tokens}`/
// `rich.model` branch, so a modern run (usage present) never double-sources.
//
// DEDUP BY TURN: one logical model turn is reported across MULTIPLE `assistant` lines as content streams in,
// each repeating the IN-FLIGHT message's usage verbatim (verified against a real legacy capture — see
// claude-stream-json-usage.ndjson) — summing every line would inflate tokens ~2-3x and modelCalls likewise.
// The turn key is `request_id` (the real capture's correlator) falling back to `message.id` (the shape the
// OTHER shipped fixture uses); a repeat of the SAME key is skipped. No cost is derived here — no principled
// per-token price table exists in core for a subscription-flat executor, so cost stays 0 (never hardcoded).
//
// It reads ONLY the fields the post-slim events.jsonl preserves (events.ts's executor-aware slim keeps
// `type`, tool_use `id`/`name`/`input`, tool_result `tool_use_id`/`is_error`), so the raw capture and the
// slimmed projection decode identically. Defensive throughout — a missing/absent block never throws.

import type { PiEvent } from '../runner/events.js';
import { createLoopCounter, loopFingerprint } from './distill.js';
import type {
  NodeAccumulator,
  NodeStatusRecordLike,
  LiveMetrics,
  RichNode,
  TimelineSpan,
} from './distill.js';

/** Recursively freeze the shared reduced node (the snapshot() contract — a FROZEN copy a live consumer can
 *  hold across polls). Mirrors distill.ts's deepFreeze. */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/** A Claude assistant/user `message.content[]` block — only the tool fields the slim projection preserves. */
interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

const contentOf = (message: unknown): ContentBlock[] => {
  const m = message as { content?: unknown } | null | undefined;
  return m && Array.isArray(m.content) ? (m.content as ContentBlock[]) : [];
};

/**
 * A count-only NodeAccumulator over Claude stream-json. Same surface as `createNodeAccumulator`, so both
 * batch replay (runView.ts) and the live tail (watch.ts) drive it identically, and a settled node's
 * snapshot() deep-equals finalize().rich.
 */
export function createClaudeAccumulator(): NodeAccumulator {
  const toolBreakdown: Record<string, number> = {};
  // open tool-use span keyed by tool_use `id`; tStartMs stays null — the stream carries no per-tool start,
  // and one assistant line can batch many tool_use blocks (so never attribute the line's `_t`).
  const open = new Map<string, { name: string }>();
  const timeline: TimelineSpan[] = [];
  let toolCalls = 0;
  // tool-loop fingerprint: `name|<args-json>` → times seen (identical to distill.ts:231-235).
  const fpCounts = new Map<string, number>();
  let maxToolRepeat = 0, repeatedTool: string | null = null;
  // (P6) loopScore: longest run of CONSECUTIVE tool_use blocks sharing the canonical (first-100) fingerprint
  // — the SAME shared helper the pi accumulator uses, so the signal is per-executor-consistent.
  const loop = createLoopCounter();
  let firstRt: string | null = null, lastRt: string | null = null;
  let eventsSeen = 0;
  const byType: Record<string, number> = {};

  // (Defect E2) tokens/model/modelCalls — the FALLBACK source when a run carries no `rec.usage`.
  let model: string | null = null;
  let modelCalls = 0;
  const tok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPeak: 0 };
  // dedup key of the last COUNTED turn — repeats of the SAME key (a chunk of the same in-flight message)
  // are skipped; `undefined` on both sides never matches itself (see accumulateUsage), so an assistant line
  // with neither correlator always counts as its own turn.
  let lastTurnKey: string | undefined;

  const seeRt = (e: PiEvent) => {
    const rt = e._rt as unknown;
    if (typeof rt === 'string') { if (!firstRt) firstRt = rt; lastRt = rt; }
  };

  // One assistant line's usage, DEDUPED by turn. A single logical model turn is reported across MULTIPLE
  // `assistant` lines as content streams in, each repeating the IN-FLIGHT message's usage verbatim (verified
  // against a real legacy capture) — so only the FIRST line of a turn is counted. The turn key is the event's
  // top-level `request_id` (the real capture's correlator), falling back to `message.id` (the OTHER shipped
  // fixture's shape); with NEITHER present, `turnKey` is always a fresh unique string, so nothing collapses.
  let anonSeq = 0;
  const accumulateUsage = (e: PiEvent, msg: { model?: string; id?: string; usage?: unknown }): void => {
    if (!model && typeof msg.model === 'string') model = msg.model;
    const requestId = (e as { request_id?: unknown }).request_id;
    const turnKey = typeof requestId === 'string' ? requestId
      : typeof msg.id === 'string' ? msg.id
      : `__anon_${anonSeq++}`;
    if (turnKey === lastTurnKey) return; // a repeated chunk of the SAME turn — already counted
    lastTurnKey = turnKey;
    modelCalls += 1;
    const u = msg.usage;
    if (!u || typeof u !== 'object') return;
    const usage = u as Record<string, number>;
    tok.input += usage.input_tokens || 0;
    tok.output += usage.output_tokens || 0;
    tok.cacheRead += usage.cache_read_input_tokens || 0;
    tok.cacheWrite += usage.cache_creation_input_tokens || 0;
    // "context in the window" for this call — same shape as nodeTokenSpine's rec.usage contextPeak formula.
    const peak = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    if (peak > tok.contextPeak) tok.contextPeak = peak;
    // no principled per-token price for a subscription-flat executor in core — cost stays 0, never hardcoded.
  };

  return {
    push(e: PiEvent) {
      if (!e || typeof e !== 'object') return;
      eventsSeen += 1;
      const type = e.type as string;
      byType[type] = (byType[type] || 0) + 1;
      seeRt(e);
      switch (type) {
        // assistant line: each `tool_use` content block OPENS a tool span (counts + fingerprints; the
        // matching user tool_result closes it). An assistant line may carry text/thinking blocks too — ignored.
        // (Defect E2) role==='assistant' also feeds the token/model FALLBACK accumulation, deduped by turn.
        case 'assistant': {
          const msg = (e as { message?: unknown }).message as { role?: string; model?: string; id?: string; usage?: unknown } | undefined;
          if (msg && msg.role === 'assistant') accumulateUsage(e, msg);
          for (const block of contentOf((e as { message?: unknown }).message)) {
            if (!block || block.type !== 'tool_use') continue;
            const name = block.name as string;
            if (typeof name !== 'string') continue;
            toolCalls += 1;
            toolBreakdown[name] = (toolBreakdown[name] || 0) + 1;
            // fingerprint the call (name + exact args) so N identical calls surface as a loop — guarded
            // like distill.ts (non-serializable args fold to the bare name, still counting repeats).
            let fp = name;
            try { fp = `${name}|${JSON.stringify(block.input ?? {})}`; } catch { /* keep bare name */ }
            const seen = (fpCounts.get(fp) ?? 0) + 1;
            fpCounts.set(fp, seen);
            if (seen > maxToolRepeat) { maxToolRepeat = seen; repeatedTool = name; }
            // (P6) fold the CANONICAL (first-100) fingerprint into the consecutive-run tracker — DISTINCT
            // from maxToolRepeat's full-args global peak (same shared helper as the pi accumulator).
            loop.see(loopFingerprint(name, block.input ?? {}));
            const id = block.id;
            if (typeof id === 'string') open.set(id, { name });
          }
          break;
        }
        // user line: each `tool_result` block CLOSES its span (matched by tool_use_id) with durMs:0
        // (count-only) and ok = !is_error. A result with no matching open span is tolerated (dropped).
        case 'user': {
          for (const block of contentOf((e as { message?: unknown }).message)) {
            if (!block || block.type !== 'tool_result') continue;
            const id = block.tool_use_id;
            if (typeof id !== 'string') continue;
            const span = open.get(id);
            if (!span) continue;
            timeline.push({ name: span.name, tStartMs: null, durMs: 0, ok: block.is_error !== true });
            open.delete(id);
          }
          break;
        }
        // result/system + everything else: no tool decode (tokens/model ride rec.usage, not this stream).
        default: break;
      }
    },

    metrics(): LiveMetrics {
      // Claude retry/stopReason telemetry rides rec.usage (the result-event spine), NOT this reducer — those
      // stay zeroed/null. tokens/model/modelCalls (Defect E2) are the FALLBACK accumulation for a run with no
      // rec.usage, so the live metrics report them here too (not just at finalize/snapshot).
      return {
        model, provider: null,
        modelCalls, toolCalls, maxToolRepeat, repeatedTool,
        loopScore: loop.value,
        retries: 0, stopReason: null,
        truncated: false,
        tokens: { ...tok, billable: tok.input + tok.output },
      };
    },

    snapshot(statusRec: NodeStatusRecordLike = {}): RichNode {
      // NON-DESTRUCTIVE: project each still-open span read-only (durMs:0/ok:true — the SAME shape finalize
      // synth-closes them to) onto a THROWAWAY timeline copy; never mutate `timeline`/`open`, so a later
      // real tool_result still closes correctly and this is safe to call any number of times mid-run.
      const projected = [...timeline];
      for (const span of open.values()) projected.push({ name: span.name, tStartMs: null, durMs: 0, ok: true });
      return deepFreeze(assembleRich(statusRec, projected).rich);
    },

    finalize(statusRec: NodeStatusRecordLike = {}) {
      // close any tool spans that never saw a result (killed mid-call) so timeline stays 1:1 with calls.
      for (const span of open.values()) timeline.push({ name: span.name, tStartMs: null, durMs: 0, ok: true });
      open.clear();
      return assembleRich(statusRec, timeline);
    },
  };

  // Assemble the { rich, io } pair. finalize passes the mutated real timeline; snapshot passes a throwaway
  // copy with open spans appended — so a settled node's snapshot deep-equals finalize().rich.
  function assembleRich(statusRec: NodeStatusRecordLike, timelineOut: TimelineSpan[]): { rich: RichNode; io: { reads: never[]; writes: never[]; promotes: never[]; startedAt?: string; endedAt?: string; durationMs?: number } } {
    const startedAt = statusRec.startedAt || firstRt || undefined;
    const endedAt = statusRec.endedAt || lastRt || undefined;
    const durationMs = statusRec.durationMs;

    const rich: RichNode = {
      // provider/api/retries/stopReason ride rec.usage (nodeTokenSpine) when present, not this stream — those
      // stay null/zeroed. model/tokens/modelCalls (Defect E2) are the FALLBACK accumulation nodeTokenSpine
      // reads via `{...rich.tokens}`/`rich.model` when a run carries no rec.usage (a legacy run).
      model, provider: null, api: null,
      toolCalls, toolBreakdown: { ...toolBreakdown }, timeline: [...timelineOut],
      reads: [], lists: [], writes: [], bash: [],
      tokens: { ...tok, billable: tok.input + tok.output },
      retries: 0, stopReason: null, truncated: false, thinkingChars: 0,
      modelCalls, maxToolRepeat, repeatedTool,
      loopScore: loop.value,
      coverage: { eventsSeen, usageEvents: modelCalls, byType: { ...byType } },
      startedAt, endedAt, durationMs,
    };
    const io = {
      reads: [] as never[], writes: [] as never[], promotes: [] as never[],
      startedAt, endedAt, durationMs,
    };
    return { rich, io };
  }
}
