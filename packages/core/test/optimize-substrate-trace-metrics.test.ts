// Tests for packages/core/src/optimize/substrate/trace-metrics.ts (M3.3 of
// docs/specs/optimize-substrate-plan.md) — the built-in trace detectors over a node's `.pi/nodes/<id>/events.jsonl`.
// Pure, over hand-built synthetic event lines (the corrected shapes: `thinking_start`/`thinking_end` are
// `message_update.assistantMessageEvent.type` values; usage lives at `turn_end.message.usage`). Every test
// asserts a value it can independently justify — a wrong threshold or a dropped flag turns it RED.
//
// Run: npx vitest run packages/core/test/optimize-substrate-trace-metrics.test.ts

import { describe, it, expect } from 'vitest';
import { analyzeEvents, DEFAULT_SUBSTRATE_THRESHOLDS } from '../src/optimize/substrate/trace-metrics.js';

const line = (o: unknown): string => JSON.stringify(o);

describe('analyzeEvents — thinking-stall span detection', () => {
  it('flags a thinking span whose duration meets the threshold', () => {
    const lines = [
      line({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' }, _t: 0 }),
      line({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' }, _t: 100 }),
      line({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end' }, _t: 9000 }),
    ];
    const report = analyzeEvents(lines);
    expect(report.thinkingSpans).toHaveLength(1);
    expect(report.thinkingSpans[0].durationMs).toBe(9000);
    expect(report.thinkingStalls).toHaveLength(1);
  });

  it('does NOT flag a short thinking span (below the default threshold)', () => {
    const lines = [
      line({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' }, _t: 0 }),
      line({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' }, _t: 100 }),
      line({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end' }, _t: 500 }),
    ];
    const report = analyzeEvents(lines);
    expect(report.thinkingSpans).toHaveLength(1);
    expect(report.thinkingSpans[0].durationMs).toBe(500);
    expect(report.thinkingStalls).toHaveLength(0);
  });

  it('respects a custom threshold override', () => {
    const lines = [
      line({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' }, _t: 0 }),
      line({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end' }, _t: 3000 }),
    ];
    expect(analyzeEvents(lines, { thinkingStallMs: 5000 }).thinkingStalls).toHaveLength(0);
    expect(analyzeEvents(lines, { thinkingStallMs: 2000 }).thinkingStalls).toHaveLength(1);
  });
});

describe('analyzeEvents — tool-loop detection', () => {
  function toolCall(id: string, name: string, args: unknown, result: unknown): string[] {
    return [
      line({ type: 'tool_execution_start', toolCallId: id, toolName: name, args }),
      line({ type: 'tool_execution_end', toolCallId: id, result }),
    ];
  }

  it('flags >= N (default 3) byte-identical results for the SAME (tool,args)', () => {
    const lines = [
      ...toolCall('1', 'bash', { command: 'ls' }, { ok: true, out: 'a b c' }),
      ...toolCall('2', 'bash', { command: 'ls' }, { ok: true, out: 'a b c' }),
      ...toolCall('3', 'bash', { command: 'ls' }, { ok: true, out: 'a b c' }),
    ];
    const report = analyzeEvents(lines);
    expect(report.toolLoops).toHaveLength(1);
    expect(report.toolLoops[0]).toMatchObject({ toolName: 'bash', count: 3 });
  });

  it('does NOT flag identical args with DIFFERENT results (legitimately distinct work)', () => {
    const lines = [
      ...toolCall('1', 'bash', { command: 'ls' }, { ok: true, out: 'a' }),
      ...toolCall('2', 'bash', { command: 'ls' }, { ok: true, out: 'b' }),
      ...toolCall('3', 'bash', { command: 'ls' }, { ok: true, out: 'c' }),
    ];
    expect(analyzeEvents(lines).toolLoops).toHaveLength(0);
  });

  it('handles a `result.truncated:true` shape without throwing, still grouping identical truncated results', () => {
    const truncResult = { truncated: true, preview: 'x'.repeat(50) };
    const lines = [
      ...toolCall('1', 'read', { path: 'big.txt' }, truncResult),
      ...toolCall('2', 'read', { path: 'big.txt' }, truncResult),
      ...toolCall('3', 'read', { path: 'big.txt' }, truncResult),
    ];
    expect(() => analyzeEvents(lines)).not.toThrow();
    const report = analyzeEvents(lines);
    expect(report.toolLoops).toHaveLength(1);
    expect(report.toolLoops[0].count).toBe(3);
  });

  it('does not flag below the repeat threshold (2 repeats, default N=3)', () => {
    const lines = [
      ...toolCall('1', 'bash', { command: 'ls' }, { ok: true }),
      ...toolCall('2', 'bash', { command: 'ls' }, { ok: true }),
    ];
    expect(analyzeEvents(lines).toolLoops).toHaveLength(0);
  });
});

describe('analyzeEvents — token-waste (cumulative input growth) + cache-miss', () => {
  function turnEnd(input: number, extra: Record<string, unknown> = {}): string {
    return line({ type: 'turn_end', message: { usage: { input, output: 10, ...extra } } });
  }

  it('flags cumulative input growth at/above the default ratio (2x)', () => {
    const lines = [turnEnd(1000), turnEnd(1500), turnEnd(5000)];
    const report = analyzeEvents(lines);
    expect(report.tokenWaste).not.toBeNull();
    expect(report.tokenWaste!.flagged).toBe(true);
    expect(report.tokenWaste!.ratio).toBe(5);
  });

  it('does NOT flag mild input growth below the ratio', () => {
    const lines = [turnEnd(1000), turnEnd(1100), turnEnd(1200)];
    const report = analyzeEvents(lines);
    expect(report.tokenWaste!.flagged).toBe(false);
  });

  it('flags a cache-miss ONLY when the provider reports cache fields at all (cacheRead present, ===0)', () => {
    const lines = [
      line({ type: 'turn_end', message: { api: 'anthropic', usage: { input: 100, output: 10, cacheRead: 0 } } }),
    ];
    const report = analyzeEvents(lines);
    expect(report.cacheMisses).toHaveLength(1);
    expect(report.cacheMisses[0].api).toBe('anthropic');
  });

  it('never flags a cache-miss for a provider that does not report cache fields at all (openai-completions)', () => {
    const lines = [
      line({ type: 'turn_end', message: { api: 'openai-completions', usage: { input: 100, output: 10 } } }),
    ];
    expect(analyzeEvents(lines).cacheMisses).toHaveLength(0);
  });
});

describe('analyzeEvents — the 8192-byte hard-truncated line', () => {
  it('parses a truncated (invalid-JSON) line without throwing, counting it', () => {
    // Simulate events.ts's own MAX_LINE=8192 hard cut: a big thinking_end line sliced mid-object.
    const big = line({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: 'x'.repeat(9000) } });
    const truncated = big.slice(0, 8192);
    expect(() => JSON.parse(truncated)).toThrow(); // sanity: the fixture really is invalid JSON

    const lines = [
      line({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' }, _t: 0 }),
      truncated,
      line({ type: 'tool_execution_start', toolCallId: '1', toolName: 'bash', args: {} , _t: 12000 }),
    ];
    expect(() => analyzeEvents(lines)).not.toThrow();
    const report = analyzeEvents(lines);
    expect(report.truncatedLines).toBe(1);
    // the open thinking span's end is APPROXIMATED from the next parseable event (_t: 12000).
    expect(report.thinkingSpans).toHaveLength(1);
    expect(report.thinkingSpans[0].approx).toBe(true);
    expect(report.thinkingSpans[0].durationMs).toBe(12000);
  });

  it('counts a blank line as neither an event nor a truncation', () => {
    const lines = ['', '  ', line({ type: 'turn_end', message: { usage: { input: 1, output: 1 } } })];
    const report = analyzeEvents(lines);
    expect(report.truncatedLines).toBe(0);
    expect(report.eventsSeen).toBe(1);
  });
});

describe('DEFAULT_SUBSTRATE_THRESHOLDS', () => {
  it('is a stable, documented default set', () => {
    expect(DEFAULT_SUBSTRATE_THRESHOLDS).toEqual({
      thinkingStallMs: 8000,
      toolLoopRepeat: 3,
      tokenWasteGrowthRatio: 2,
    });
  });
});
