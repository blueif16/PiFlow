// Tests for the per-turn "reasoning-effort" dissection — the PI ADAPTER's turn segmentation
// (observe/transcript-pi.ts) folded by the executor-neutral rollup (observe/turnDissection.ts). The suite
// drives REAL fixture bytes through the real adapter, exactly as `buildRunView` does, so it fails when
// EITHER half is wrong: turn boundaries drift off turn_start, char sums miscount, or (the mutation this
// suite exists to pin) the mega-think flag drops its "AND zero tool calls" guard and starts flagging
// productive-but-big turns as pure deliberation.
//
// Run: npx vitest run packages/core/test/turn-dissection.test.ts

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildNodeTurns, MEGA_THINK_CHARS, DERIVATION_MARKERS } from '../src/observe/turnDissection.js';
import { piTranscript } from '../src/observe/transcript-pi.js';

/** Stage a synthetic events.jsonl into a real tmp run dir and build the turn dissection off it, THROUGH the
 *  pi transcript adapter (the same path the run-view takes). */
async function buildFrom(lines: unknown[]): Promise<ReturnType<typeof buildNodeTurns>> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'turns-'));
  const nodeDir = path.join(tmp, '.pi', 'nodes', 'n');
  await fs.mkdir(nodeDir, { recursive: true });
  await fs.writeFile(path.join(nodeDir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return buildNodeTurns(piTranscript(tmp, 'n').turns());
}

// ── event builders — the verified live shapes (top-level {type,_t}; message_update wraps assistantMessageEvent) ──
const turnStart = (t: number) => ({ type: 'turn_start', _t: t });
const thinkingDelta = (t: number, delta: string) => ({ type: 'message_update', _t: t, assistantMessageEvent: { type: 'thinking_delta', delta } });
const textDelta = (t: number, delta: string) => ({ type: 'message_update', _t: t, assistantMessageEvent: { type: 'text_delta', delta } });
const toolStart = (t: number, toolName: string, args: unknown) => ({ type: 'tool_execution_start', _t: t, toolCallId: 'c', toolName, args });
const toolEnd = (t: number) => ({ type: 'tool_execution_end', _t: t, toolCallId: 'c' });
const big = (n: number) => 'x'.repeat(n);

describe('buildNodeTurns — turn segmentation', () => {
  it('segments strictly off turn_start, with monotonically increasing turnIndex and startMs relative to the first event', async () => {
    const { turns } = await buildFrom([
      turnStart(1000),
      thinkingDelta(1010, 'hello'),
      turnStart(2000),
      thinkingDelta(2010, 'world'),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].turnIndex).toBe(0);
    expect(turns[0].startMs).toBe(0); // relative to the first event (turn_start@1000)
    expect(turns[1].turnIndex).toBe(1);
    expect(turns[1].startMs).toBe(1000); // 2000 - 1000
  });

  it('durMs spans turn_start to the NEXT turn_start; the final turn spans to the last observed event', async () => {
    const { turns } = await buildFrom([
      turnStart(1000),
      thinkingDelta(1010, 'a'),
      turnStart(2000),
      thinkingDelta(2010, 'b'),
      toolStart(2050, 'read', { path: '/x' }),
      toolEnd(2080),
    ]);
    expect(turns[0].durMs).toBe(1000); // 2000 - 1000 (the NEXT turn_start's own time closes this turn's span)
    expect(turns[1].durMs).toBe(80); // no further turn_start ⇒ spans to the last observed event (toolEnd@2080 - 2000)
  });

  it('events before the first turn_start (session/agent_start) are not attributed to any turn, but DO set the startMs origin', async () => {
    const { turns, summary } = await buildFrom([
      { type: 'session', _t: 5 },
      { type: 'agent_start', _t: 6 },
      turnStart(10),
      thinkingDelta(20, 'abc'),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].startMs).toBe(5); // relative to the FIRST event of the run (session@5), not the first turn_start
    expect(summary.totalThinkChars).toBe(3);
  });
});

describe('buildNodeTurns — char counts + tool calls', () => {
  it('sums thinking_delta and text_delta chars per turn independently', async () => {
    const { turns } = await buildFrom([
      turnStart(0),
      thinkingDelta(1, 'ab'),
      thinkingDelta(2, 'cde'),
      textDelta(3, 'z'),
      textDelta(4, 'yy'),
    ]);
    expect(turns[0].thinkChars).toBe(5); // 'ab'+'cde'
    expect(turns[0].textChars).toBe(3); // 'z'+'yy'
  });

  it('captures each toolCall as {name, argsPreview} — argsPreview capped to 80 chars', async () => {
    const longPath = '/very/long/path/'.repeat(10);
    const { turns } = await buildFrom([
      turnStart(0),
      toolStart(1, 'read', { path: longPath }),
      toolEnd(2),
    ]);
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(turns[0].toolCalls[0].name).toBe('read');
    expect(turns[0].toolCalls[0].argsPreview.length).toBeLessThanOrEqual(80);
    expect(turns[0].toolCalls[0].argsPreview).toBe(JSON.stringify({ path: longPath }).slice(0, 80));
  });

  it('a turn with two distinct tool calls records both, in order', async () => {
    const { turns } = await buildFrom([
      turnStart(0),
      toolStart(1, 'read', { path: '/a' }),
      toolEnd(2),
      toolStart(3, 'bash', { command: 'ls' }),
      toolEnd(4),
    ]);
    expect(turns[0].toolCalls.map((c) => c.name)).toEqual(['read', 'bash']);
  });
});

describe('buildNodeTurns — mega-think detection (the zero-toolCalls AND guard)', () => {
  it('flags a turn as mega-think: thinkChars >= MEGA_THINK_CHARS AND zero tool calls', async () => {
    const hugeThink = big(MEGA_THINK_CHARS);
    const { summary } = await buildFrom([
      turnStart(1000),
      thinkingDelta(1000 + 1, hugeThink),
      turnStart(1000 + 189_000), // ~189s later, matching the real rK1 gameplay shape
    ]);
    expect(summary.megaThinkTurns).toHaveLength(1);
    expect(summary.megaThinkTurns[0].turnIndex).toBe(0);
    expect(summary.megaThinkTurns[0].thinkChars).toBe(MEGA_THINK_CHARS);
    expect(summary.megaThinkTurns[0].durMs).toBe(189_000);
    expect(summary.megaThinkTurns[0].quote).toBe(hugeThink.slice(0, 200));
  });

  it('MUTATION GUARD — a turn with thinkChars >= MEGA_THINK_CHARS that ALSO made a tool call is NOT mega-think', async () => {
    // If the "AND zero toolCalls" condition were dropped, this turn (huge think + a productive tool call)
    // would wrongly be flagged as pure deliberation. It must not be: it acted on its reasoning.
    const hugeThink = big(MEGA_THINK_CHARS);
    const { summary } = await buildFrom([
      turnStart(0),
      thinkingDelta(1, hugeThink),
      toolStart(2, 'bash', { command: 'node calc.mjs' }),
      toolEnd(3),
    ]);
    expect(summary.megaThinkTurns).toHaveLength(0);
  });

  it('a turn just under MEGA_THINK_CHARS with zero tool calls is NOT mega-think (the threshold is a floor, not a suggestion)', async () => {
    const { summary } = await buildFrom([
      turnStart(0),
      thinkingDelta(1, big(MEGA_THINK_CHARS - 1)),
    ]);
    expect(summary.megaThinkTurns).toHaveLength(0);
  });
});

describe('buildNodeTurns — node-level rollup', () => {
  it('totalThinkChars sums across every turn; largestTurn identifies the biggest one', async () => {
    const { summary } = await buildFrom([
      turnStart(0),
      thinkingDelta(1, big(100)),
      turnStart(100),
      thinkingDelta(101, big(9000)),
      turnStart(9200),
      thinkingDelta(9201, big(50)),
    ]);
    expect(summary.totalThinkChars).toBe(100 + 9000 + 50);
    expect(summary.largestTurn).not.toBeNull();
    expect(summary.largestTurn!.turnIndex).toBe(1);
    expect(summary.largestTurn!.thinkChars).toBe(9000);
  });

  it('derivationMarkerCount counts occurrences of sqrt(/discriminant/quadratic across all turns', async () => {
    expect(DERIVATION_MARKERS.length).toBeGreaterThan(0);
    const { summary } = await buildFrom([
      turnStart(0),
      thinkingDelta(1, 'use the quadratic formula: sqrt(discriminant) then sqrt(x)'),
      turnStart(100),
      thinkingDelta(101, 'another sqrt( call here'),
    ]);
    // turn 0: quadratic(1) + sqrt((2) + discriminant(1) = 4; turn 1: sqrt((1) = 1 ⇒ total 5
    expect(summary.derivationMarkerCount).toBe(5);
  });
});

describe('buildNodeTurns — robustness', () => {
  it('skips a malformed/truncated JSON line without throwing and without losing later turns', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'turns-bad-'));
    const nodeDir = path.join(tmp, '.pi', 'nodes', 'n');
    await fs.mkdir(nodeDir, { recursive: true });
    const goodLines = [turnStart(0), thinkingDelta(1, 'ok')].map((l) => JSON.stringify(l));
    const raw = [goodLines[0], '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"unterminated', goodLines[1]].join('\n') + '\n';
    await fs.writeFile(path.join(nodeDir, 'events.jsonl'), raw);
    const { turns } = buildNodeTurns(piTranscript(tmp, 'n').turns());
    expect(turns).toHaveLength(1);
    expect(turns[0].thinkChars).toBe(2); // 'ok' — the corrupted line contributed nothing
  });

  it('a missing events.jsonl file yields an empty dissection, never throws', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'turns-missing-'));
    const { turns, summary } = buildNodeTurns(piTranscript(tmp, 'nope').turns());
    expect(turns).toEqual([]);
    expect(summary).toEqual({ totalThinkChars: 0, largestTurn: null, megaThinkTurns: [], derivationMarkerCount: 0 });
  });
});
