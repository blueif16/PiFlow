// ── tui/test/status-signals.test.mjs ──────────────────────────────────
// The STATUS-COVERAGE oracle: every KEY signal the shared observe surface exposes must reach the screen.
// Two halves, mirroring the data path:
//   • CARRY — `overlayRichTelemetry` must copy each rich `RunViewNode` health/gate field onto the view
//     node (a field dropped at the adapter can never render). Reddens if a field is missing from the copy.
//   • RENDER — `DetailCol`/`NodeSub` must DRAW them: the `awaiting-input` glyph (⏸), the checkpoint prompt,
//     the anomaly line (truncated · retries · tool-loop), the missing-artifact list, and the context %.
//     Reddens if the glyph map lacks `awaiting-input` or a print site is missing.
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { adaptModel, overlayRichTelemetry } from '../model.mjs';
import { DetailCol, GLYPH } from '../components.mjs';

const plain = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('overlayRichTelemetry carries the KEY health + gate signals onto the view node', () => {
  it('copies retries · stopReason · truncated · loop · checkpoint · agentType · summary · issues', () => {
    // A lean snapshot (readRunModel shape) with one node — no health fields, like a real lean read.
    const lean = {
      run: 't', done: true, ok: true, provider: 'mmgw', model: null,
      nodes: [{ id: 'a', label: 'A', status: 'ok', stageIndex: 1, lane: 0, artifactsVerified: 0, artifactsTotal: 0, missing: [] }],
      stages: [{ index: 1, phase: null, parallel: false, nodeIds: ['a'] }], edges: [],
    };
    const view = adaptModel(lean, 't');
    // before the overlay the health fields are at their inert defaults (proves the overlay does the work).
    expect(view.nodes['a'].truncated).toBe(false);
    expect(view.nodes['a'].checkpoint).toBe(null);

    const rich = {
      stages: [], edges: [], nodes: [{
        id: 'a', status: 'ok', truncated: true, stopReason: 'max_tokens', retries: 3,
        modelCalls: 5, maxToolRepeat: 4, repeatedTool: 'Read', thinkingChars: 120,
        summary: 'did the thing', issues: ['watch out'], agentType: 'researcher',
        expectedMs: 1000, priorSamples: 2, contextWindow: 1000000, tokens: { contextPeak: 950000, billable: 1 },
        checkpoint: { status: 'pending', kind: 'confirm', prompt: 'Approve?' },
      }],
    };
    overlayRichTelemetry(view, rich);
    const a = view.nodes['a'];
    expect(a.truncated).toBe(true);
    expect(a.stopReason).toBe('max_tokens');
    expect(a.retries).toBe(3);
    expect(a.modelCalls).toBe(5);
    expect(a.maxToolRepeat).toBe(4);
    expect(a.repeatedTool).toBe('Read');
    expect(a.thinking?.chars).toBe(120);
    expect(a.summary).toBe('did the thing');
    expect(a.issues).toContain('watch out');
    expect(a.agentType).toBe('researcher');
    expect(a.contextWindow).toBe(1000000);
    expect(a.checkpoint?.prompt).toBe('Approve?');
  });
});

// ── render half: a synthetic model exercising each KEY signal, drawn through the real DetailCol/NodeSub ──
const mkNode = (id, status, over = {}) => ({
  id, label: id, phase: null, agentType: null, hasSchema: false, stageIndex: 1, lane: 0,
  status, reported: status, durationMs: 1000, startMs: null, endMs: null,
  tokens: null, contextWindow: null, toolCalls: 0, toolBreakdown: null, thinking: null, eventCount: 0,
  retries: 0, stopReason: null, truncated: false, modelCalls: 0, maxToolRepeat: 0, repeatedTool: null,
  expectedMs: null, priorSamples: null, checkpoint: null,
  artifactsVerified: 0, artifactsTotal: 0, missing: [], issues: [], summary: null, pipelineFindings: [],
  io: { description: null, skill: null, inputs: [], outputs: [], produced: [], owns: [] },
  ...over,
});

function modelWith(nodes) {
  const ids = nodes.map((n) => n.id);
  return {
    run: { id: 'demo', done: true, ok: false, provider: 'mmgw', model: 'MiniMax-M3', durationMs: 1000, elapsedMs: null },
    stages: [{ index: 1, phase: null, parallel: false, nodeIds: ids }],
    stageTimes: [], timeline: { t0: 0, t1: 1, rows: [] },
    totals: { nodes: ids.length, toolCalls: 0, tokensBillable: 0, cost: 0 },
    pathways: { halted: false, haltNode: null, reused: [], pending: [], running: [], escalated: [] },
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
  };
}

const frameFor = async (model, di) => {
  const thread = { statusPath: 'k' };
  const detail = { key: 'k', model, tail: null, tick: 0 };
  const { lastFrame, unmount } = render(DetailCol(thread, detail, di, 2, 40, 0, 'list', 84));
  await sleep(30);
  const out = plain(lastFrame());
  unmount();
  return out;
};

describe('DetailCol/NodeSub render the KEY status signals', () => {
  it('awaiting-input has a glyph in the map and draws ⏸ for the node', async () => {
    expect(GLYPH['awaiting-input']).toBeTruthy(); // the map MUST cover the status (else undefined → blank)
    const model = modelWith([mkNode('gate', 'awaiting-input', { checkpoint: { status: 'pending', kind: 'confirm', prompt: 'Approve this output?' } })]);
    const out = await frameFor(model, 0);
    expect(out).toContain(GLYPH['awaiting-input']);     // ⏸ in the list row
    expect(out).toContain('Approve this output?');      // the gate's question reaches the inspector
  });

  it('draws the anomaly line for a truncated/looping/rate-limited node + the context %', async () => {
    const model = modelWith([mkNode('hot', 'ok', {
      truncated: true, stopReason: 'max_tokens', retries: 2, maxToolRepeat: 4, repeatedTool: 'Read',
      tokens: { contextPeak: 950000, billable: 1 }, contextWindow: 1000000,
    })]);
    const out = await frameFor(model, 0);
    expect(out).toMatch(/truncated/);
    expect(out).toMatch(/retry/);
    expect(out).toMatch(/loop/);
    expect(out).toContain('Read');
    expect(out).toMatch(/95%/);   // context pressure surfaced as peak/window %
  });

  it('lists the missing declared artifacts of a blocked node', async () => {
    const model = modelWith([mkNode('bad', 'blocked', { missing: ['spec/x.json', 'public/y.md'] })]);
    const out = await frameFor(model, 0);
    expect(out).toMatch(/missing/);
    expect(out).toContain('spec/x.json');
  });
});
