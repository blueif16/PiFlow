// Tests for the agent-facing telemetry projection (packages/core/src/observe/telemetry.ts). Two modes,
// both PURE/deterministic: projectRunDigest (record) over a hand-built RunView, and telemetryStream over a
// hand-built RunUpdate iterable. Each test asserts a value it can independently justify — a wrong threshold,
// a dropped anomaly, a broken rollup, or a mis-walked failure chain turns a test RED.
//
// Run: npx vitest run packages/core/test/telemetry.test.ts

import { describe, it, expect } from 'vitest';
import { projectRunDigest, telemetryStream, toGenAiAttributes } from '../src/observe/telemetry.js';
import type { RunView, RunViewNode } from '../src/observe/runView.js';
import type { RunUpdate, RunModel, NodeView } from '../src/observe/types.js';
import type { PiEvent } from '../src/runner/events.js';

// ── builders: fill the required RunViewNode/RunView fields so a test states only what it cares about ────
function vnode(p: Partial<RunViewNode> & { id: string }): RunViewNode {
  return {
    label: p.id,
    phase: null,
    status: 'ok',
    toolCalls: 0,
    toolBreakdown: {},
    timeline: [],
    reads: [],
    scopes: [],
    writes: [],
    artifacts: [],
    bash: [],
    retries: 0,
    stopReason: null,
    truncated: false,
    thinkingChars: 0,
    modelCalls: 0,
    maxToolRepeat: 0,
    repeatedTool: null,
    ...p,
  };
}
function rview(nodes: RunViewNode[], extra: Partial<RunView> = {}): RunView {
  return { run: 'r1', stages: [], edges: [], nodes, ...extra };
}

describe('projectRunDigest — anomaly detection', () => {
  it('flags truncated / tool-loop / context-pressure / retries / failed on the right nodes', () => {
    const view = rview([
      vnode({ id: 'clean', status: 'ok', tokens: tok({ input: 10, output: 5 }) }),
      vnode({ id: 'cut', status: 'ok', truncated: true, stopReason: 'max_tokens' }),
      vnode({ id: 'loop', status: 'ok', maxToolRepeat: 4, repeatedTool: 'bash', toolCalls: 4 }),
      vnode({ id: 'ctx', status: 'ok', contextWindow: 100_000, tokens: tok({ contextPeak: 95_000 }) }),
      vnode({ id: 'retry', status: 'ok', retries: 3 }),
      vnode({ id: 'dead', status: 'blocked' }),
    ]);
    const d = projectRunDigest(view);
    const kinds = (id: string) => d.nodes.find((n) => n.id === id)!.anomalies.sort();
    expect(kinds('clean')).toEqual([]);
    expect(kinds('cut')).toEqual(['truncated']);
    expect(kinds('loop')).toEqual(['tool-loop']);
    expect(kinds('ctx')).toEqual(['context-pressure']);
    expect(kinds('retry')).toEqual(['retries']);
    expect(kinds('dead')).toEqual(['failed']);
  });

  it('respects the threshold boundary — repeat 3 trips the default(3) loop, repeat 2 does not', () => {
    const d = projectRunDigest(
      rview([
        vnode({ id: 'two', maxToolRepeat: 2, repeatedTool: 'read' }),
        vnode({ id: 'three', maxToolRepeat: 3, repeatedTool: 'read' }),
      ]),
    );
    expect(d.nodes.find((n) => n.id === 'two')!.anomalies).toEqual([]);
    expect(d.nodes.find((n) => n.id === 'three')!.anomalies).toEqual(['tool-loop']);
  });

  it('slow fires ONLY with cross-run history (priorSamples>0), never vs the run itself', () => {
    const noHist = projectRunDigest(rview([vnode({ id: 'a', durationMs: 9000, expectedMs: 9000, priorSamples: 0 })]));
    expect(noHist.nodes[0].anomalies).toEqual([]); // expectedMs == own duration ⇒ ratio 1, and no history anyway
    const slow = projectRunDigest(rview([vnode({ id: 'a', durationMs: 9000, expectedMs: 3000, priorSamples: 4 })]));
    expect(slow.nodes[0].anomalies).toEqual(['slow']); // 3× the 3-sample mean
  });
});

describe('projectRunDigest — rollup + context %', () => {
  it('sums tokens/cost and counts ok vs failed', () => {
    const d = projectRunDigest(
      rview([
        vnode({ id: 'a', status: 'ok', tokens: tok({ input: 100, output: 20, cost: 0.1, contextPeak: 1000 }) }),
        vnode({ id: 'b', status: 'reused', tokens: tok({ input: 50, output: 10, cost: 0.05, contextPeak: 4000 }) }),
        vnode({ id: 'c', status: 'blocked' }),
      ]),
    );
    expect(d.totals.inputTokens).toBe(150);
    expect(d.totals.outputTokens).toBe(30);
    expect(d.totals.cost).toBeCloseTo(0.15, 10);
    expect(d.totals.contextPeak).toBe(4000); // MAX across nodes, not a sum
    expect(d.totals.ok).toBe(2); // ok + reused
    expect(d.totals.failed).toBe(1);
  });

  it('computes contextPct = peak / window', () => {
    const d = projectRunDigest(rview([vnode({ id: 'a', contextWindow: 200_000, tokens: tok({ contextPeak: 50_000 }) })]));
    expect(d.nodes[0].contextPct).toBeCloseTo(0.25, 10);
  });
});

describe('projectRunDigest — failure-onset localization (the file-flow DAG advantage)', () => {
  // A(blocked) → B(blocked): B's failure originates UPSTREAM at A, reached via the shared file.
  it('walks back to the earliest failed upstream node', () => {
    const view = rview(
      [
        vnode({ id: 'A', status: 'blocked', stageIndex: 1 }),
        vnode({ id: 'B', status: 'blocked', stageIndex: 2 }),
      ],
      { edges: [{ from: 'A', to: 'B', path: 'spec/x.json' }] },
    );
    const d = projectRunDigest(view);
    const rcB = d.rootCauses.find((r) => r.failed === 'B')!;
    expect(rcB.earliestUpstream).toBe('A'); // NOT B — the chain started at A
    expect(rcB.chain).toEqual(['A', 'B']);
    expect(rcB.viaPath).toBe('spec/x.json');
  });

  // A clean upstream means the failure originates at the node itself (self-origin).
  it('a failure with no failed ancestor localizes to itself', () => {
    const view = rview(
      [
        vnode({ id: 'A', status: 'ok', stageIndex: 1 }),
        vnode({ id: 'B', status: 'blocked', stageIndex: 2 }),
      ],
      { edges: [{ from: 'A', to: 'B', path: 'spec/x.json' }] },
    );
    const d = projectRunDigest(view);
    const rcB = d.rootCauses.find((r) => r.failed === 'B')!;
    expect(rcB.earliestUpstream).toBe('B'); // A is ok ⇒ B is its own onset
    expect(rcB.chain).toEqual(['B']);
  });

  it('a clean run produces no rootCauses', () => {
    expect(projectRunDigest(rview([vnode({ id: 'A', status: 'ok' })])).rootCauses).toEqual([]);
  });
});

describe('telemetryStream — live deltas', () => {
  it('emits run-start, node-open, the crossed anomaly, node-close, and a failed run-end', async () => {
    const updates: RunUpdate[] = [
      { kind: 'snapshot', model: rmodel([mnode({ id: 'n1', status: 'pending' })]) },
      { kind: 'node-status', id: 'n1', status: 'running' },
      // a truncated assistant completion ⇒ the 'truncated' anomaly must fire exactly once
      { kind: 'node-event', id: 'n1', event: ev({ type: 'message_end', message: { role: 'assistant', stopReason: 'max_tokens', usage: { input: 5, output: 1 } } }) },
      { kind: 'node-event', id: 'n1', event: ev({ type: 'message_end', message: { role: 'assistant', stopReason: 'max_tokens', usage: { input: 3, output: 1 } } }) },
      { kind: 'node-status', id: 'n1', status: 'blocked' },
      { kind: 'done' },
    ];
    const out = await collect(telemetryStream(toAsync(updates)));
    const kinds = out.map((e) => e.kind);
    expect(kinds[0]).toBe('run-start');
    expect(out.some((e) => e.kind === 'node-open' && e.nodeId === 'n1')).toBe(true);
    const anoms = out.filter((e) => e.kind === 'anomaly') as Extract<typeof out[number], { kind: 'anomaly' }>[];
    expect(anoms.filter((a) => a.anomaly.kind === 'truncated')).toHaveLength(1); // edge-triggered: once, not twice
    expect(anoms.some((a) => a.anomaly.kind === 'failed')).toBe(true);
    const close = out.find((e) => e.kind === 'node-close') as Extract<typeof out[number], { kind: 'node-close' }> | undefined;
    expect(close?.digest.id).toBe('n1');
    expect(close?.digest.inputTokens).toBe(8); // 5 + 3 folded from the stream
    const end = out.at(-1);
    expect(end).toEqual({ kind: 'run-end', ok: false }); // n1 blocked ⇒ run failed
  });

  it('verbose mode surfaces per-call events; important mode does not', async () => {
    const updates: RunUpdate[] = [
      { kind: 'snapshot', model: rmodel([mnode({ id: 'n1', status: 'running' })]) },
      { kind: 'node-event', id: 'n1', event: ev({ type: 'message_end', message: { role: 'assistant', usage: { input: 1 } } }) },
      { kind: 'done' },
    ];
    const quiet = await collect(telemetryStream(toAsync(updates)));
    expect(quiet.some((e) => e.kind === 'call')).toBe(false);
    const loud = await collect(telemetryStream(toAsync(updates), { verbosity: 'verbose' }));
    expect(loud.some((e) => e.kind === 'call' && e.op === 'chat')).toBe(true);
  });
});

describe('telemetryStream — DRIVER-SELECTED accumulator (Claude stream-json is not folded through pi)', () => {
  // The anomaly stream is a SEPARATE fold from the observe/SSE path: it drives its OWN per-node accumulator.
  // It must select that accumulator by the node's driver (the SAME machinery buildRunView/watchRun use) —
  // pi ⇒ createNodeAccumulator, claude-code ⇒ the count-only stream-json decoder. Folding a Claude node
  // through pi's reducer no-ops on the assistant/user/system vocabulary (distill.ts `default: break`) ⇒
  // 0 tokens, 0 tool calls, no tool-loop — the bug these tests pin. Each Claude assistant line carries one
  // `tool_use` block (opens a call) + usage; three identical Bash calls trip the tool-loop threshold (3).
  const cAssistant = (
    reqId: string,
    tokens: { input: number; output: number },
    tool: { id: string; name: string; input: unknown },
  ): PiEvent =>
    ev({
      type: 'assistant',
      request_id: reqId,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        usage: { input_tokens: tokens.input, output_tokens: tokens.output },
        content: [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }],
      },
    });
  const bashLoop: PiEvent[] = ['r1', 'r2', 'r3'].map((r, i) =>
    cAssistant(r, { input: 100, output: 5 }, { id: `t${i}`, name: 'Bash', input: { cmd: 'ls' } }),
  );

  it('selects the Claude accumulator from the snapshot-stamped executor — tokens + tool-loop light up', async () => {
    const updates: RunUpdate[] = [
      { kind: 'snapshot', model: rmodel([mnode({ id: 'cc', status: 'running', executor: 'claude-code' })]) },
      { kind: 'node-event', id: 'cc', event: ev({ type: 'system', subtype: 'init' }) },
      ...bashLoop.map((event) => ({ kind: 'node-event', id: 'cc', event }) as RunUpdate),
      { kind: 'node-status', id: 'cc', status: 'ok' },
      { kind: 'done' },
    ];
    const out = await collect(telemetryStream(toAsync(updates)));
    const anoms = out.filter((e) => e.kind === 'anomaly') as Extract<typeof out[number], { kind: 'anomaly' }>[];
    // three identical Bash calls trip the tool-loop threshold — impossible if the claude stream no-ops through pi.
    expect(anoms.filter((a) => a.anomaly.kind === 'tool-loop')).toHaveLength(1);
    const close = out.find((e) => e.kind === 'node-close') as Extract<typeof out[number], { kind: 'node-close' }>;
    expect(close.digest.toolCalls).toBe(3);
    expect(close.digest.maxToolRepeat).toBe(3);
    expect(close.digest.inputTokens).toBe(300); // 3 turns × 100 (deduped by request_id) — 0 through the pi reducer
  });

  it('a Claude node that starts AFTER attach (no snapshot executor) self-corrects via event detection', async () => {
    // pending at attach ⇒ no stamped executor in the snapshot; the leading `system` line is unsniffable, so the
    // fold starts provisional-pi and must FLIP to the claude reducer the moment an `assistant` line appears
    // (DriverTable.detectUnstamped over the retained log — the SAME format-detect the batch/live seeds use).
    const updates: RunUpdate[] = [
      { kind: 'snapshot', model: rmodel([mnode({ id: 'cc', status: 'pending' })]) },
      { kind: 'node-status', id: 'cc', status: 'running' },
      { kind: 'node-event', id: 'cc', event: ev({ type: 'system', subtype: 'init' }) },
      ...bashLoop.map((event) => ({ kind: 'node-event', id: 'cc', event }) as RunUpdate),
      { kind: 'node-status', id: 'cc', status: 'ok' },
      { kind: 'done' },
    ];
    const out = await collect(telemetryStream(toAsync(updates)));
    const anoms = out.filter((e) => e.kind === 'anomaly') as Extract<typeof out[number], { kind: 'anomaly' }>[];
    expect(anoms.filter((a) => a.anomaly.kind === 'tool-loop')).toHaveLength(1);
    const close = out.find((e) => e.kind === 'node-close') as Extract<typeof out[number], { kind: 'node-close' }>;
    expect(close.digest.toolCalls).toBe(3);
    expect(close.digest.inputTokens).toBe(300);
  });

  it('a pi node is unaffected — pi vocabulary still folds through createNodeAccumulator', async () => {
    // regression guard: the default/unstamped path stays byte-identical to today (pi's message_end fold).
    const updates: RunUpdate[] = [
      { kind: 'snapshot', model: rmodel([mnode({ id: 'p', status: 'running', executor: 'pi' })]) },
      { kind: 'node-event', id: 'p', event: ev({ type: 'message_end', message: { role: 'assistant', usage: { input: 7, output: 2 } } }) },
      { kind: 'node-status', id: 'p', status: 'ok' },
      { kind: 'done' },
    ];
    const out = await collect(telemetryStream(toAsync(updates)));
    const close = out.find((e) => e.kind === 'node-close') as Extract<typeof out[number], { kind: 'node-close' }>;
    expect(close.digest.inputTokens).toBe(7);
    expect(close.digest.modelCalls).toBe(1);
  });
});

describe('toGenAiAttributes — OTel gen_ai.* bridge', () => {
  it('maps the cost spine and tags error.type on a failed node', () => {
    const d = projectRunDigest(rview([vnode({ id: 'n', status: 'blocked', model: 'MiniMax-M3', provider: 'mmgw', stopReason: 'max_tokens', tokens: tok({ input: 12, output: 4 }) })]));
    const a = toGenAiAttributes(d.nodes[0]);
    expect(a['gen_ai.operation.name']).toBe('invoke_agent');
    expect(a['gen_ai.request.model']).toBe('MiniMax-M3');
    expect(a['gen_ai.provider.name']).toBe('mmgw');
    expect(a['gen_ai.usage.input_tokens']).toBe(12);
    expect(a['gen_ai.response.finish_reasons']).toEqual(['max_tokens']);
    expect(a['error.type']).toBe('blocked');
  });
});

// ── tiny helpers ──────────────────────────────────────────────────────────────────────────────────────
function tok(p: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextPeak: number; billable: number }>) {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPeak: 0, billable: 0, ...p };
}
function mnode(p: Partial<NodeView> & { id: string }): NodeView {
  return { label: p.id, phase: null, status: 'pending', reported: 'pending', artifactsVerified: 0, artifactsTotal: 0, missing: [], stageIndex: 1, lane: 0, ...p } as NodeView;
}
function rmodel(nodes: NodeView[]): RunModel {
  return { run: 'r1', done: false, ok: null, durationMs: null, stage: null, totals: null, nodes, stages: [], edges: [] };
}
function ev(e: Record<string, unknown>): PiEvent {
  return e as PiEvent;
}
async function* toAsync<T>(xs: T[]): AsyncIterable<T> {
  for (const x of xs) yield x;
}
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
