// Tests for the shared per-node stream reducer (`createNodeAccumulator`, packages/core/src/observe/
// distill.ts). The reducer moved here from the GUI; its only prior test was archived in
// `gui/scripts/legacy/distill.test.mjs` against the dead copy. This ports the SYNTHETIC-EVENT cases:
// each test hand-builds a `PiEvent[]`, pushes it, and asserts the `finalize()` output exactly — so a
// wrong event read, a double-count, a mis-aggregation, or a dropped timeline span turns a test RED.
//
// Run: npx vitest run packages/core/test/distill.test.ts

import { describe, it, expect } from 'vitest';
import { createNodeAccumulator } from '../src/observe/distill.js';
import type { PiEvent } from '../src/runner/events.js';

/** Push a hand-built event list through a fresh accumulator and return its `rich` finalize output. */
function reduce(events: PiEvent[]) {
  const acc = createNodeAccumulator();
  for (const e of events) acc.push(e);
  return acc.finalize().rich;
}

describe('createNodeAccumulator — token aggregation', () => {
  // Per-call usage lives on assistant `message_end`. input/output/cache* are per-call → SUM.
  it('SUMS per-call input/output across assistant message_end events', () => {
    const rich = reduce([
      { type: 'message_end', message: { role: 'assistant', usage: { input: 10, output: 1 } } },
      { type: 'message_end', message: { role: 'assistant', usage: { input: 20, output: 2 } } },
    ]);
    expect(rich.tokens.input).toBe(30); // 10 + 20, not max, not last-wins
    expect(rich.tokens.output).toBe(3);
    expect(rich.tokens.billable).toBe(33); // input + output
  });

  // totalTokens is the per-call CONTEXT size → MAX (contextPeak), never a sum.
  it('takes contextPeak = MAX(totalTokens), not the sum', () => {
    const rich = reduce([
      { type: 'message_end', message: { role: 'assistant', usage: { totalTokens: 100 } } },
      { type: 'message_end', message: { role: 'assistant', usage: { totalTokens: 250 } } },
      { type: 'message_end', message: { role: 'assistant', usage: { totalTokens: 80 } } },
    ]);
    expect(rich.tokens.contextPeak).toBe(250); // MAX(100,250,80) — NOT 430
  });

  // The double-count guard: `message_end` AND `turn_end` carry an IDENTICAL usage rollup. The reducer
  // reads message_end ONLY; a turn_end with usage must NOT change any total. Delete that guard → RED.
  it('IGNORES turn_end usage (the double-count guard)', () => {
    const rich = reduce([
      { type: 'message_end', message: { role: 'assistant', usage: { input: 10, output: 1, totalTokens: 100 } } },
      // pi re-emits the same usage on turn_end; reading it would double the totals.
      { type: 'turn_end', message: { role: 'assistant', usage: { input: 10, output: 1, totalTokens: 100 } } },
      { type: 'turn_end', usage: { input: 10, output: 1, totalTokens: 100 } },
    ]);
    expect(rich.tokens.input).toBe(10); // still just the one message_end, not 20/30
    expect(rich.tokens.output).toBe(1);
    expect(rich.tokens.contextPeak).toBe(100);
  });

  // cost arrives as an OBJECT {total} for some providers; it must reduce to a scalar, never "0[object Object]".
  it('reduces an object-shaped cost to a scalar number', () => {
    const rich = reduce([
      { type: 'message_end', message: { role: 'assistant', usage: { cost: { total: 0.5 } } } },
      { type: 'message_end', message: { role: 'assistant', usage: { cost: { total: 0.25 } } } },
    ]);
    expect(typeof rich.tokens.cost).toBe('number');
    expect(rich.tokens.cost).toBeCloseTo(0.75, 10);
  });
});

describe('createNodeAccumulator — tool calls & timeline', () => {
  // toolBreakdown is a name→count map; toolCalls is the total.
  it('counts toolBreakdown {read:2,bash:1} and toolCalls===3', () => {
    const rich = reduce([
      { type: 'tool_execution_start', toolName: 'read', toolCallId: 'a', args: { path: '/p/a' }, _t: 0 },
      { type: 'tool_execution_end', toolCallId: 'a', _t: 5 },
      { type: 'tool_execution_start', toolName: 'read', toolCallId: 'b', args: { path: '/p/b' }, _t: 10 },
      { type: 'tool_execution_end', toolCallId: 'b', _t: 12 },
      { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'c', args: { command: 'ls' }, _t: 20 },
      { type: 'tool_execution_end', toolCallId: 'c', _t: 25 },
    ]);
    expect(rich.toolBreakdown).toEqual({ read: 2, bash: 1 });
    expect(rich.toolCalls).toBe(3);
  });

  // The timeline must stay 1:1 with tool calls — even when a node is killed mid-call (a start with no
  // matching _end). finalize() closes the dangling span so it still produces one timeline entry.
  it('produces one timeline span per call — an unterminated start still closes (killed mid-call)', () => {
    const rich = reduce([
      { type: 'tool_execution_start', toolName: 'read', toolCallId: 'a', args: { path: '/p/a' }, _t: 0 },
      { type: 'tool_execution_end', toolCallId: 'a', _t: 8 },
      // node dies here — this bash start NEVER sees its _end:
      { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'b', args: { command: 'sleep 99' }, _t: 10 },
    ]);
    expect(rich.timeline).toHaveLength(2); // 1:1 with the 2 calls
    expect(rich.timeline[0]).toMatchObject({ name: 'read', durMs: 8 });
    const dangling = rich.timeline.find((t) => t.name === 'bash')!;
    expect(dangling).toBeTruthy();
    expect(dangling.durMs).toBe(0); // closed with zero duration, not dropped
  });
});

describe('createNodeAccumulator — model capture', () => {
  // model/provider/api are recovered from the FIRST assistant message in the stream (first-wins).
  it('captures model from the first assistant message, ignoring later ones', () => {
    const rich = reduce([
      { type: 'message_start', message: { role: 'assistant', model: 'MiniMax-M3', provider: 'mmgw', api: 'anthropic-messages' } },
      { type: 'message_end', message: { role: 'assistant', model: 'OTHER', provider: 'x', usage: { input: 1 } } },
    ]);
    expect(rich.model).toBe('MiniMax-M3'); // first assistant message, not overwritten
    expect(rich.provider).toBe('mmgw');
    expect(rich.api).toBe('anthropic-messages');
  });
});

// ── Task 2: new intakes — retries · stopReason/truncation · thinking ──────────────────────────────
describe('createNodeAccumulator — retries (auto_retry_start)', () => {
  it('counts each auto_retry_start ⇒ retries===2', () => {
    const rich = reduce([
      { type: 'auto_retry_start' },
      { type: 'message_end', message: { role: 'assistant', usage: { input: 1 } } },
      { type: 'auto_retry_start' },
    ]);
    expect(rich.retries).toBe(2);
  });

  it('a clean node has retries===0 and stopReason null', () => {
    const rich = reduce([{ type: 'message_end', message: { role: 'assistant', usage: { input: 1 } } }]);
    expect(rich.retries).toBe(0);
    expect(rich.stopReason).toBeNull();
  });
});

describe('createNodeAccumulator — stopReason / truncation', () => {
  it("stopReason 'max_tokens' ⇒ truncated===true", () => {
    const rich = reduce([
      { type: 'message_end', message: { role: 'assistant', stopReason: 'max_tokens', usage: { input: 1 } } },
    ]);
    expect(rich.stopReason).toBe('max_tokens');
    expect(rich.truncated).toBe(true);
  });

  it("stopReason 'end_turn' ⇒ truncated===false", () => {
    const rich = reduce([
      { type: 'message_end', message: { role: 'assistant', stopReason: 'end_turn', usage: { input: 1 } } },
    ]);
    expect(rich.stopReason).toBe('end_turn');
    expect(rich.truncated).toBe(false);
  });

  it("stopReason 'length' also counts as truncated", () => {
    const rich = reduce([
      { type: 'message_end', message: { role: 'assistant', stopReason: 'length', usage: { input: 1 } } },
    ]);
    expect(rich.truncated).toBe(true);
  });
});

describe('createNodeAccumulator — thinking chars', () => {
  it('sums thinking_delta string lengths ⇒ "ab"+"cde" = 5', () => {
    const rich = reduce([
      { type: 'thinking_delta', delta: 'ab' },
      { type: 'thinking_delta', delta: 'cde' },
    ]);
    expect(rich.thinkingChars).toBe(5);
  });

  it('ignores a non-string delta (no NaN/length crash)', () => {
    const rich = reduce([
      { type: 'thinking_delta', delta: 'ab' },
      { type: 'thinking_delta' }, // no delta field
      { type: 'thinking_delta', delta: 42 },
    ]);
    expect(rich.thinkingChars).toBe(2);
  });
});
