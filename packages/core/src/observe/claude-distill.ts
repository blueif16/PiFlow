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
// TOKENS/COST/MODEL do NOT ride this reducer — they ride the authoritative `result` event through
// `rec.usage`/`nodeTokenSpine` (runView.ts). This reducer leaves tokens/model/provider/retries zeroed so
// nothing double-sources from the (slimmed) stream: `nodeTokenSpine` prefers `rec.usage` and ignores
// `rich.tokens` for Claude.
//
// It reads ONLY the fields the post-slim events.jsonl preserves (events.ts's executor-aware slim keeps
// `type`, tool_use `id`/`name`/`input`, tool_result `tool_use_id`/`is_error`), so the raw capture and the
// slimmed projection decode identically. Defensive throughout — a missing/absent block never throws.

import type { PiEvent } from '../runner/events.js';
import type {
  NodeAccumulator,
  NodeStatusRecordLike,
  LiveMetrics,
  RichNode,
  RichTokens,
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

const ZERO_TOKENS: RichTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPeak: 0, billable: 0 };

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
  let firstRt: string | null = null, lastRt: string | null = null;
  let eventsSeen = 0;
  const byType: Record<string, number> = {};

  const seeRt = (e: PiEvent) => {
    const rt = e._rt as unknown;
    if (typeof rt === 'string') { if (!firstRt) firstRt = rt; lastRt = rt; }
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
        case 'assistant': {
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
      // Claude token/model/retry telemetry rides rec.usage (the result-event spine), NOT this reducer, so
      // the live metrics carry only what this stream authoritatively knows: the tool-loop signal.
      return {
        model: null, provider: null,
        modelCalls: 0, toolCalls, maxToolRepeat, repeatedTool,
        loopScore: 0, // STUB (P6): real consecutive-first-100 fold not implemented yet.
        retries: 0, stopReason: null,
        truncated: false,
        tokens: { ...ZERO_TOKENS },
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
      // model/provider/api/tokens/retries/stopReason ride rec.usage (nodeTokenSpine), not this stream.
      model: null, provider: null, api: null,
      toolCalls, toolBreakdown: { ...toolBreakdown }, timeline: [...timelineOut],
      reads: [], lists: [], writes: [], bash: [],
      tokens: { ...ZERO_TOKENS },
      retries: 0, stopReason: null, truncated: false, thinkingChars: 0,
      modelCalls: 0, maxToolRepeat, repeatedTool,
      loopScore: 0, // STUB (P6): real consecutive-first-100 fold not implemented yet.
      coverage: { eventsSeen, usageEvents: 0, byType: { ...byType } },
      startedAt, endedAt, durationMs,
    };
    const io = {
      reads: [] as never[], writes: [] as never[], promotes: [] as never[],
      startedAt, endedAt, durationMs,
    };
    return { rich, io };
  }
}
