// liveModelToRunView — the P3 adapter that lets a LIVE SSE model render through the SAME graph pipeline as a
// loaded run-view (docs/design/observe-live-sse-single-source.md P3). The contract: a value the SERVER
// streamed onto a node (billable tokens, a `derived` tone) must reach a rendered FlowNode UNCHANGED — the GUI
// re-derives nothing. These tests FAIL if the adapter drops/rewrites a streamed field, or if `toFlowGraph`
// throws because the adapter left a required field undefined. Not coverage theater: they assert the exact
// streamed billable count and the exact tone concretely on `data.rv`.
import { describe, it, expect } from "vitest";
import { liveModelToRunView, toFlowGraph } from "./runView";
import { foldTokenTotal } from "./runStream";
import type { LiveModel, LiveNode } from "./runStream";
import type { NodeDerived, RunTokens } from "./runView";

const tokens = (billable: number): RunTokens => ({
  input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, cost: 0.42, contextPeak: 8000, billable,
});

const derived = (contextTone: NodeDerived["context"]["tone"]): NodeDerived => ({
  cacheHit: { ratio: 0.5, tone: "ok" },
  toolError: { errors: 0, rate: 0, tone: "ok" },
  dominance: { tool: "Bash", ratio: 0.6, dominant: true },
  context: { frac: 0.82, tone: contextTone },
  time: null,
  retries: { count: 0, tone: "ok" },
  topTools: [{ name: "Bash", count: 3, pct: 0.6 }],
  outputs: [{ path: "out.txt", bytes: 12, ok: true }],
});

const liveNode = (p: Partial<LiveNode>): LiveNode => ({
  id: "n", label: "n", phase: null, status: "running", stageIndex: 1, lane: 0, ...p,
});

const model = (nodes: LiveNode[]): LiveModel => ({
  run: "r", done: false, ok: null, durationMs: null, provider: "gw", model: "sonnet",
  totals: null, tokenTotal: foldTokenTotal(nodes), nodes,
  edges: [{ from: "a", to: "b", path: "shared.txt" }],
});

describe("liveModelToRunView → toFlowGraph — a streamed value reaches the rendered FlowNode", () => {
  it("carries a node's streamed tokens.billable and derived tone through to data.rv EXACTLY", () => {
    const node = liveNode({ id: "build", label: "Build", status: "running", tokens: tokens(1234), derived: derived("high") });
    const view = liveModelToRunView(model([node]));
    const { nodes } = toFlowGraph(view);

    const rv = nodes[0].data.rv;
    expect(rv).toBeTruthy();
    // the EXACT streamed billable count reaches the rendered node (not a recomputed / dropped value)
    expect(rv?.tokens?.billable).toBe(1234);
    // the EXACT streamed derived tone reaches the rendered node — the surface computed it, the GUI renders it
    expect(rv?.derived?.context.tone).toBe("high");
    // the derived object is the SAME reference the server sent (passthrough, no client recompute)
    expect(rv?.derived).toBe(node.derived);
  });

  it("maps live edges → RunViewEdges and carries the folded tokenTotal", () => {
    const a = liveNode({ id: "a", label: "A", status: "ok", tokens: tokens(100), stageIndex: 1, lane: 0 });
    const b = liveNode({ id: "b", label: "B", status: "running", tokens: tokens(50), stageIndex: 2, lane: 0 });
    const view = liveModelToRunView(model([a, b]));

    // tokenTotal folds billable (sum) and contextPeak (max) across nodes — mirrors buildRunView.
    expect(view.tokenTotal?.billable).toBe(150);
    expect(view.tokenTotal?.contextPeak).toBe(8000);

    const { edges } = toFlowGraph(view);
    expect(edges).toEqual([{ id: "a->b", source: "a", target: "b" }]);
  });

  it("defaults every RunViewNode field a lean live node lacks so toFlowGraph never throws", () => {
    // a bare live node (only identity/placement) — no enriched fields yet
    const bare = liveNode({ id: "x", label: "X", status: "pending" });
    const view = liveModelToRunView(model([bare]));
    // toFlowGraph reads rv.toolCalls, rv.reads.length, rv.writes.map(...) — all must be defined, not undefined
    expect(() => toFlowGraph(view)).not.toThrow();
    const rv = toFlowGraph(view).nodes[0].data.rv;
    expect(rv?.toolCalls).toBe(0);
    expect(rv?.reads).toEqual([]);
    expect(rv?.writes).toEqual([]);
    expect(rv?.derived).toBeUndefined(); // not fabricated for a bare node
  });
});

// (G6 inheritance over SSE) A LIVE node's base-agent identity must reach the rendered FlowNode exactly as a
// settled run-view node's does — the wire (core NodeView, read.ts) carries `agentType` verbatim; if the client
// adapter drops it, a RUNNING run renders every node "bespoke · no base" (no face, empty hover card) until it
// settles. This FAILS when the adapter or toFlowGraph loses the id on the live path.
describe("liveModelToRunView — base-agent identity on the live path", () => {
  it("carries a live node's agentType through to data.agentType and resolves its catalog entry", () => {
    const node = liveNode({ id: "explore", label: "explore", status: "running", agentType: "explore" });
    const view = liveModelToRunView(model([node]));
    const entry = { label: "Explore", icon: "compass", prompt: "Read-only scout." };
    const { nodes } = toFlowGraph(view, { explore: entry });
    expect(nodes[0].data.agentType).toBe("explore");
    expect(nodes[0].data.agentPreset).toBe(entry);
  });
});
