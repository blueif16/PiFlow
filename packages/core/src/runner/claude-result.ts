// parseClaudeResult — parse the stdout of a headless `claude -p --output-format stream-json --verbose`
// run into a normalized result + telemetry object (docs/design/agent-executor-interface.md).
//
// `nodeUsageFromClaude` projects that result into the agent-neutral `NodeUsage` spine the run record
// persists — the seam that lets the observe surface source Claude's token/cost/context from the ONE
// authoritative `result` event instead of the (pi-only, blank-for-Claude) events.jsonl replay.

import type { NodeUsage } from './status.js';
//
// The stream is NDJSON: a `system` init, `assistant`/`user`/`rate_limit_event` turns, exactly one
// `result` event, then possibly MORE trailing `system` events (e.g. hook_response). The `result` event
// is NOT necessarily the last line, so we SCAN every line for `type==="result"` — never `tail -1`.
// Pure function: tolerates blank/malformed lines (stream noise) without throwing.

export interface ClaudeRunResult {
  ok: boolean;          // subtype === 'success' && is_error !== true
  isError: boolean;     // is_error === true (or no result event found)
  subtype?: string;     // e.g. 'success' | 'error_max_turns' | 'error_during_execution'
  sessionId?: string;   // session_id
  text?: string;        // the `result` summary text
  model?: string;       // the single key of `modelUsage` (the model that actually ran), if present
  numTurns?: number;    // num_turns — the REAL invocation count (NOT the count of `assistant` lines)
  durationMs?: number;  // duration_ms
  ttftMs?: number;      // ttft_ms — time-to-first-token, native on the result event
  stopReason?: string;  // stop_reason (e.g. 'end_turn') — the model-turn stop, distinct from `subtype`
  contextWindow?: number; // modelUsage[model].contextWindow — the per-run context cap the model actually had
  cost?: { usd?: number; inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheCreation?: number };
}

export function parseClaudeResult(stdout: string): ClaudeRunResult {
  const result = findResultEvent(stdout);
  if (!result) return { ok: false, isError: true };

  const isError = result.is_error === true;
  const subtype = typeof result.subtype === 'string' ? result.subtype : undefined;
  const out: ClaudeRunResult = {
    ok: subtype === 'success' && !isError,
    isError,
  };

  if (subtype !== undefined) out.subtype = subtype;
  if (typeof result.session_id === 'string') out.sessionId = result.session_id;
  if (typeof result.result === 'string') out.text = result.result;
  if (typeof result.num_turns === 'number') out.numTurns = result.num_turns;
  if (typeof result.duration_ms === 'number') out.durationMs = result.duration_ms;
  if (typeof result.ttft_ms === 'number') out.ttftMs = result.ttft_ms;
  if (typeof result.stop_reason === 'string') out.stopReason = result.stop_reason;

  const modelUsage = result.modelUsage;
  if (modelUsage && typeof modelUsage === 'object') {
    const keys = Object.keys(modelUsage as Record<string, unknown>);
    if (keys.length > 0) {
      out.model = keys[0];
      // the per-run context cap the model actually had — the authoritative denominator for context-pressure.
      const mu = (modelUsage as Record<string, unknown>)[keys[0]];
      if (mu && typeof mu === 'object' && typeof (mu as Record<string, unknown>).contextWindow === 'number') {
        out.contextWindow = (mu as Record<string, unknown>).contextWindow as number;
      }
    }
  }

  const cost = buildCost(result);
  if (cost) out.cost = cost;

  return out;
}

/**
 * Project a parsed Claude result into the agent-neutral `NodeUsage` spine (the run-record field observe
 * reads). Returns undefined when the run produced no telemetry (no `result` event) so the caller leaves
 * `rec.usage` unset. Sources tokens/cost/turns from the `result` event ONLY — never a per-`assistant` sum.
 */
export function nodeUsageFromClaude(cv: ClaudeRunResult): NodeUsage | undefined {
  const u: NodeUsage = {
    ...(cv.cost?.inputTokens != null ? { inputTokens: cv.cost.inputTokens } : {}),
    ...(cv.cost?.outputTokens != null ? { outputTokens: cv.cost.outputTokens } : {}),
    ...(cv.cost?.cacheRead != null ? { cacheRead: cv.cost.cacheRead } : {}),
    ...(cv.cost?.cacheCreation != null ? { cacheCreation: cv.cost.cacheCreation } : {}),
    ...(cv.cost?.usd != null ? { cost: cv.cost.usd } : {}),
    ...(cv.contextWindow != null ? { contextWindow: cv.contextWindow } : {}),
    ...(cv.ttftMs != null ? { ttftMs: cv.ttftMs } : {}),
    ...(cv.numTurns != null ? { numTurns: cv.numTurns } : {}),
    ...(cv.stopReason != null ? { stopReason: cv.stopReason } : {}),
  };
  return Object.keys(u).length > 0 ? u : undefined;
}

// Scan ALL NDJSON lines; select the object with type === "result". Skip blank lines and any line that
// is not valid JSON (stream noise) — never throw on a bad line. Ignores order and trailing events.
function findResultEvent(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj && typeof obj === 'object' && (obj as Record<string, unknown>).type === 'result') {
      return obj as Record<string, unknown>;
    }
  }
  return undefined;
}

function buildCost(result: Record<string, unknown>): ClaudeRunResult['cost'] | undefined {
  const usage = (result.usage && typeof result.usage === 'object'
    ? (result.usage as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const cost: NonNullable<ClaudeRunResult['cost']> = {};
  if (typeof result.total_cost_usd === 'number') cost.usd = result.total_cost_usd;
  if (typeof usage.input_tokens === 'number') cost.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') cost.outputTokens = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === 'number') cost.cacheRead = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === 'number') cost.cacheCreation = usage.cache_creation_input_tokens;
  return Object.keys(cost).length > 0 ? cost : undefined;
}
