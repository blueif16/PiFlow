// Tests for `piflowctl telemetry`'s pure render layer (packages/cli/src/telemetry.ts) — specifically the
// turn-dissection additions: the mega-think anomaly icon and the per-node "think:"/"turns" timeline table.
// `renderDigest` takes a hand-built RunDigest directly (no run dir needed) so this proves the RENDERING,
// not the reducer (that's packages/core/test/turn-dissection.test.ts + telemetry.test.ts's job).
//
// Run: npx vitest run packages/cli/test/telemetry.test.ts

import { describe, it, expect } from 'vitest';
import type { NodeDigest, RunDigest, Anomaly } from '@piflow/core';
import { renderDigest } from '../src/telemetry.js';

function ndigest(p: Partial<NodeDigest> & { id: string }): NodeDigest {
  return {
    label: p.id,
    phase: null,
    outcome: 'ok',
    model: 'MiniMax-M3',
    provider: 'mmgw',
    durationMs: null,
    expectedMs: null,
    slowRatio: null,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    contextPeak: 0,
    contextWindow: null,
    contextPct: null,
    modelCalls: 0,
    toolCalls: 0,
    topTools: {},
    maxToolRepeat: 0,
    repeatedTool: null,
    retries: 0,
    stopReason: null,
    truncated: false,
    missing: [],
    issues: [],
    anomalies: [],
    ...p,
  };
}
function rdigest(nodes: NodeDigest[], anomalies: Anomaly[] = []): RunDigest {
  return {
    run: 'r1',
    done: true,
    ok: true,
    durationMs: null,
    totals: { nodes: nodes.length, ok: nodes.length, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
    nodes,
    anomalies,
    rootCauses: [],
  };
}

describe('renderDigest — node detail: reasoning-effort summary', () => {
  it('shows the totalThinkChars + largestTurn summary line ("think:")', () => {
    const d = rdigest([
      ndigest({
        id: 'gameplay',
        totalThinkChars: 154_098,
        largestTurn: { turnIndex: 23, thinkChars: 50_170, durMs: 188_876 },
      }),
    ]);
    const out = renderDigest(d, 'gameplay');
    expect(out).toMatch(/think:\s+154k chars total/);
    expect(out).toMatch(/largest turn #23 \(50k chars\/188\.9s\)/);
  });

  it('omits the "think:" line entirely when the node carries no turn data (undefined, not zero)', () => {
    const out = renderDigest(rdigest([ndigest({ id: 'plain' })]), 'plain');
    expect(out).not.toMatch(/think:/);
  });
});

describe('renderDigest — node detail: the per-turn timeline table', () => {
  it('renders one row per turn: turn · t+s · dur · thinkChars · tools', () => {
    const d = rdigest([
      ndigest({
        id: 'gameplay',
        turns: [
          { turnIndex: 0, startMs: 0, durMs: 3300, thinkChars: 120, textChars: 10, toolCalls: [{ name: 'read', argsPreview: '{"path":"/a"}' }] },
          { turnIndex: 23, startMs: 175_470, durMs: 188_876, thinkChars: 50_170, textChars: 40, toolCalls: [] },
        ],
      }),
    ]);
    const out = renderDigest(d, 'gameplay');
    expect(out).toMatch(/turns \(2\):/);
    // turn 0: 0.0s start, 3.3s dur, thinkChars 120, tool name listed (not the "-" placeholder)
    expect(out).toMatch(/\b0\s+0\.0s\s+3\.3s\s+120\s+read/);
    // turn 23: mega-think shape — ~189s dur, ~50k chars, and NO tool calls ⇒ the "-" placeholder (not blank)
    expect(out).toMatch(/\b23\s+175\.5s\s+188\.9s\s+50k\s+-/);
  });

  it('joins multiple tool calls in a turn with a comma', () => {
    const d = rdigest([
      ndigest({
        id: 'n',
        turns: [{ turnIndex: 0, startMs: 0, durMs: 100, thinkChars: 5, textChars: 0, toolCalls: [{ name: 'read', argsPreview: '' }, { name: 'bash', argsPreview: '' }] }],
      }),
    ]);
    expect(renderDigest(d, 'n')).toMatch(/read,bash/);
  });

  it('omits the turns table when the node carries no turns (empty array, not just undefined)', () => {
    const out = renderDigest(rdigest([ndigest({ id: 'n', turns: [] })]), 'n');
    expect(out).not.toMatch(/turns \(/);
  });
});

describe('renderDigest — run-level worklist: the mega-think icon', () => {
  it('renders the Θ icon for a mega-think anomaly in the worklist', () => {
    const d = rdigest(
      [ndigest({ id: 'gameplay', anomalies: ['mega-think'] })],
      [{ kind: 'mega-think', nodeId: 'gameplay', detail: 'turn 23: 50170 thinking chars over 188.9s, no tool calls' }],
    );
    const out = renderDigest(d);
    expect(out).toMatch(/Θ\s+mega-think\s+gameplay/);
  });
});
