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

// The bug this section pins: toolBreakdown counts every tool_execution_start regardless of outcome, so a
// tool REJECTED every time (isError:true on tool_execution_end, e.g. "Tool bash not found") renders
// identically to a real execution — the real wgt1 forensics case ("bash: 2" from two rejected attempts,
// read as a sandbox leak until disproved). toolErrorCounts is the ADDITIVE per-tool error tally, using the
// same isError read tool_execution_end already does for the timeline's `ok` flag (line ~293).
describe('createNodeAccumulator — per-tool error counts (toolErrorCounts)', () => {
  it('distinguishes a rejected call from a successful one — toolBreakdown unchanged, toolErrorCounts new', () => {
    const rich = reduce([
      { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'a', args: { command: 'ls' }, _t: 0 },
      { type: 'tool_execution_end', toolCallId: 'a', _t: 1, isError: true }, // rejected: "Tool bash not found"
      { type: 'tool_execution_start', toolName: 'read', toolCallId: 'b', args: { path: '/p/a' }, _t: 2 },
      { type: 'tool_execution_end', toolCallId: 'b', _t: 3 }, // real, successful read
    ]);
    // attempts are counted exactly as before — no existing consumer's numbers change.
    expect(rich.toolBreakdown).toEqual({ bash: 1, read: 1 });
    // the new surface distinguishes them: bash's one attempt was rejected, read's was not.
    expect(rich.toolErrorCounts).toEqual({ bash: 1 });
  });

  it('the wgt1 case: 2 rejected bash attempts, 0 successes — errors match attempts, not silently 0', () => {
    const rich = reduce([
      { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'a', args: { command: 'x' }, _t: 0 },
      { type: 'tool_execution_end', toolCallId: 'a', _t: 1, isError: true },
      { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'b', args: { command: 'y' }, _t: 2 },
      { type: 'tool_execution_end', toolCallId: 'b', _t: 3, isError: true },
    ]);
    expect(rich.toolBreakdown).toEqual({ bash: 2 }); // attempts: unchanged
    expect(rich.toolErrorCounts).toEqual({ bash: 2 }); // every attempt rejected — a real run would show 0
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

// ── loop signals — the one capture the rich reducer was missing, needed for the tool-loop anomaly ───
describe('createNodeAccumulator — loop signals (modelCalls, maxToolRepeat)', () => {
  // modelCalls = how many times the model completed in this node (one per assistant message_end). A node
  // that should be one-shot but shows 12 model calls is looping — the cheapest loop signal there is.
  it('counts modelCalls = assistant message_end completions (non-assistant ignored)', () => {
    const rich = reduce([
      { type: 'message_end', message: { role: 'assistant', usage: { input: 1 } } },
      { type: 'message_end', message: { role: 'assistant', usage: { input: 1 } } },
      { type: 'message_end', message: { role: 'user' } }, // not an assistant completion ⇒ not counted
    ]);
    expect(rich.modelCalls).toBe(2);
  });

  // maxToolRepeat = the most times ONE tool ran with the SAME args. ≥3 of the identical call is the
  // classic agent loop (call tool, get nothing useful, call the exact same tool again).
  it('maxToolRepeat = max count of the SAME tool+args fingerprint', () => {
    const rich = reduce([
      { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'a', args: { command: 'ls' }, _t: 0 },
      { type: 'tool_execution_end', toolCallId: 'a', _t: 1 },
      { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'b', args: { command: 'ls' }, _t: 2 },
      { type: 'tool_execution_end', toolCallId: 'b', _t: 3 },
      { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'c', args: { command: 'ls' }, _t: 4 },
      { type: 'tool_execution_end', toolCallId: 'c', _t: 5 },
    ]);
    expect(rich.maxToolRepeat).toBe(3);
    expect(rich.repeatedTool).toBe('bash');
  });

  // DIFFERENT args are legitimate work, not a loop — they must NOT inflate the counter (no false alarm).
  it('distinct args do NOT inflate maxToolRepeat', () => {
    const rich = reduce([
      { type: 'tool_execution_start', toolName: 'read', toolCallId: 'a', args: { path: '/p/a' }, _t: 0 },
      { type: 'tool_execution_end', toolCallId: 'a', _t: 1 },
      { type: 'tool_execution_start', toolName: 'read', toolCallId: 'b', args: { path: '/p/b' }, _t: 2 },
      { type: 'tool_execution_end', toolCallId: 'b', _t: 3 },
    ]);
    expect(rich.maxToolRepeat).toBe(1); // two distinct reads ⇒ no repeat
  });

  it('a tool-free node reads maxToolRepeat 0 and repeatedTool null', () => {
    const rich = reduce([{ type: 'message_end', message: { role: 'assistant', usage: { input: 1 } } }]);
    expect(rich.maxToolRepeat).toBe(0);
    expect(rich.repeatedTool).toBeNull();
  });
});

// metrics() is the NON-DESTRUCTIVE live read the telemetry stream uses mid-run — unlike finalize() it
// must NOT close still-open tool spans (calling it repeatedly can't corrupt later state).
describe('createNodeAccumulator — metrics() (live, non-destructive)', () => {
  it('reflects current counters without consuming open spans', () => {
    const acc = createNodeAccumulator();
    acc.push({ type: 'message_end', message: { role: 'assistant', usage: { input: 5, output: 2, totalTokens: 40 } } });
    acc.push({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'x', args: { command: 'ls' }, _t: 0 });
    // tool 'x' is still OPEN here — metrics() must read live state without finalizing it.
    const m1 = acc.metrics();
    expect(m1.modelCalls).toBe(1);
    expect(m1.toolCalls).toBe(1);
    expect(m1.tokens.input).toBe(5);
    expect(m1.tokens.contextPeak).toBe(40);
    // a second metrics() call returns the same live view (no double-close side effect)…
    expect(acc.metrics().toolCalls).toBe(1);
    // …and finalize() afterward still produces exactly ONE timeline span for the open call.
    const rich = acc.finalize().rich;
    expect(rich.timeline).toHaveLength(1);
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

// snapshot() is the live, NON-DESTRUCTIVE twin of finalize() the telemetry stream folds per poll (it
// cannot call finalize(), which is destructive — synth-closes open spans then clears them, corrupting a
// still-live node's timeline). These tests pin the P0a contract: on a settled node it equals finalize();
// it is idempotent AND leaves the accumulator terminal-ready; and with an OPEN span it projects read-only
// so a LATER real tool_execution_end still yields the correct closed span (a finalize-based path fails).
describe('createNodeAccumulator — snapshot() (non-destructive twin of finalize)', () => {
  // (a) On a SETTLED node (every tool span closed), snapshot() deep-equals finalize()'s rich — the
  // non-destructive read reproduces the terminal shape exactly (model/tokens/timeline/tools/reads/writes).
  it('on a settled node, snapshot(rec) deep-equals finalize(rec).rich', () => {
    const rec = { startedAt: 's', endedAt: 'e', durationMs: 42, artifacts: [{ path: '/p/out.js', exists: true, bytes: 7 }] };
    const events: PiEvent[] = [
      { type: 'message_start', message: { role: 'assistant', model: 'm1', provider: 'cp', api: 'anthropic-messages' } },
      { type: 'message_end', message: { role: 'assistant', usage: { input: 30, output: 6, cacheRead: 4, totalTokens: 120 }, stopReason: 'end_turn' } },
      { type: 'tool_execution_start', toolName: 'read', toolCallId: 'a', args: { path: '/p/in.txt' }, _t: 0 },
      { type: 'tool_execution_end', toolCallId: 'a', _t: 5, result: { content: [{ type: 'text', text: 'file body' }] } },
      { type: 'tool_execution_start', toolName: 'write', toolCallId: 'b', args: { path: '/p/out.js' }, _t: 10 },
      { type: 'tool_execution_end', toolCallId: 'b', _t: 18 },
    ];
    // snapshot on one accumulator, finalize on a fresh IDENTICAL one — same events, no shared state.
    const snapAcc = createNodeAccumulator();
    for (const e of events) snapAcc.push(e);
    const snap = snapAcc.snapshot(rec);

    const finAcc = createNodeAccumulator();
    for (const e of events) finAcc.push(e);
    const fin = finAcc.finalize(rec).rich;

    expect(snap).toEqual(fin);
    // and it is the real, populated shape — not a coincidental empty deep-equal.
    expect(snap.tokens.billable).toBe(36);
    expect(snap.timeline).toHaveLength(2);
    expect(snap.reads[0]?.preview).toBe('file body');
    expect(snap.writes[0]?.verified).toBe(true); // artifact matched on disk
  });

  // (b) snapshot() is idempotent (two calls deep-equal) AND non-destructive: a subsequent finalize()
  // still closes correctly. If snapshot() mutated `open`/`timeline`, the second call or the finalize
  // would diverge (double-pushed spans).
  it('is idempotent and leaves finalize() still correct', () => {
    const acc = createNodeAccumulator();
    acc.push({ type: 'message_end', message: { role: 'assistant', usage: { input: 5, output: 2, totalTokens: 40 } } });
    acc.push({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'a', args: { path: '/p/a' }, _t: 0 });
    acc.push({ type: 'tool_execution_end', toolCallId: 'a', _t: 3 });

    const s1 = acc.snapshot();
    const s2 = acc.snapshot();
    expect(s2).toEqual(s1); // two calls agree — no accumulating side effect
    expect(s1.timeline).toHaveLength(1); // the closed span, exactly one

    // finalize() afterward still yields the same terminal timeline (snapshot did not consume state).
    const fin = acc.finalize().rich;
    expect(fin.timeline).toHaveLength(1);
    expect(fin.timeline[0]).toMatchObject({ name: 'read', durMs: 3, ok: true });
  });

  // (c) THE live-path contract: with an OPEN tool span, snapshot() projects it read-only (durMs:0,
  // ok:true) WITHOUT closing it, so a LATER real tool_execution_end still produces the correctly-closed
  // span with its real durMs. A finalize()-based live path fails this — finalize would synth-close the
  // span at durMs:0 and DROP the real _end, freezing the span wrong forever.
  it('projects an open span read-only; a later real _end still closes it correctly', () => {
    const acc = createNodeAccumulator();
    acc.push({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'x', args: { command: 'sleep 1' }, _t: 100 });

    // mid-run snapshot: the still-open span is projected read-only at durMs 0, ok true.
    const mid = acc.snapshot();
    expect(mid.timeline).toHaveLength(1);
    expect(mid.timeline[0]).toMatchObject({ name: 'bash', durMs: 0, ok: true });
    expect(mid.toolCalls).toBe(1);

    // the REAL end arrives AFTER the snapshot — because snapshot() never touched `open`, this closes
    // the original span with its true duration (not the projected 0).
    acc.push({ type: 'tool_execution_end', toolCallId: 'x', _t: 350 });
    const after = acc.snapshot();
    expect(after.timeline).toHaveLength(1); // still ONE span (not the projection PLUS a close)
    expect(after.timeline[0]).toMatchObject({ name: 'bash', durMs: 250, ok: true });

    // finalize() agrees — one span, real duration, nothing double-pushed.
    const fin = acc.finalize().rich;
    expect(fin.timeline).toHaveLength(1);
    expect(fin.timeline[0]).toMatchObject({ name: 'bash', durMs: 250, ok: true });
  });

  // the frozen-copy contract: a consumer holding a snapshot can't mutate it (and a next poll is unaffected).
  it('returns a deep-frozen copy', () => {
    const acc = createNodeAccumulator();
    acc.push({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'a', args: { path: '/p/a' }, _t: 0 });
    acc.push({ type: 'tool_execution_end', toolCallId: 'a', _t: 2 });
    const snap = acc.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.timeline)).toBe(true);
    expect(Object.isFrozen(snap.tokens)).toBe(true);
  });
});
