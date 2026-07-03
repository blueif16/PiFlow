// runViewToLiveModel — the DR6 reconcile-net inverse of `liveModelToRunView`
// (docs/design/observe-live-sse-single-source.md DR6). When a backgrounded/throttled tab returns to the
// foreground, the reconcile net fetches the AUTHORITATIVE `/run-view` and MODEL-REPLACEs the live model with it;
// this adapter maps that `RunView` back down onto the `LiveModel` the SSE stream carries so the graph re-bases to
// ground truth. The contract has teeth: a re-based model MUST render IDENTICALLY to `/run-view` — i.e.
// round-tripping it back through `liveModelToRunView` reproduces the view over the ENTIRE shadow-diff field key
// (zero divergence). If this adapter drops or rewrites ANY rendered field on the way down, a reconcile would
// silently CORRUPT the graph instead of healing it — and `shadowDiff` (the same oracle the P4 cutover used) turns
// these tests red. Not coverage theater: the round-trip is asserted against the real parity gate, and the
// concrete-field test pins exact streamed values.
import { describe, it, expect } from "vitest";
import { runViewToLiveModel, liveModelToRunView } from "./runView";
import { shadowDiff } from "./shadowDiff";
import type { RunView, RunViewNode, NodeDerived, RunTokens } from "./runView";

const tokens = (billable: number, contextPeak = 8000): RunTokens => ({
  input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, cost: 0.42, contextPeak, billable,
});

const derived = (contextTone: NodeDerived["context"]["tone"]): NodeDerived => ({
  cacheHit: { ratio: 0.5, tone: "ok" },
  toolError: { errors: 1, rate: 0.1, tone: "warn" },
  dominance: { tool: "Bash", ratio: 0.6, dominant: true },
  context: { frac: 0.82, tone: contextTone },
  time: { ratio: 1.2, tone: "warn" },
  retries: { count: 1, tone: "ok" },
  topTools: [{ name: "Bash", count: 3, pct: 0.6 }],
  outputs: [{ path: "out.txt", bytes: 12, ok: true }],
});

// A fully-placed, enriched RunViewNode — every shadow-diff field defined, mirroring what buildRunView stamps on a
// real (authoritative) run-view node so the round-trip has no undefined-vs-default nits.
const rvNode = (p: Partial<RunViewNode>): RunViewNode => ({
  id: "n", label: "n", phase: null, status: "ok",
  toolCalls: 0, toolBreakdown: {}, timeline: [], reads: [], scopes: [], writes: [], artifacts: [], bash: [],
  retries: 0, stopReason: null, truncated: false, thinkingChars: 0, stageIndex: 1, lane: 0, ...p,
});

const view = (nodes: RunViewNode[], tokenTotal: RunTokens): RunView => ({
  run: "r", provider: "gw", model: "sonnet", done: false, ok: null, durationMs: 12000,
  totals: { nodes: nodes.length, ok: 1, failed: 0 },
  tokenTotal,
  stages: [{ index: 1, phase: "build", parallel: false, nodeIds: ["a"] },
           { index: 2, phase: "verify", parallel: true, nodeIds: ["b"] }],
  edges: [{ from: "a", to: "b", path: "shared.txt" }],
  nodes,
});

describe("runViewToLiveModel — the DR6 reconcile MODEL-REPLACE source", () => {
  it("round-trips an authoritative run-view with ZERO divergence over the shadow-diff field key", () => {
    const a = rvNode({
      id: "a", label: "A", status: "ok", stageIndex: 1, lane: 0,
      tokens: tokens(100), derived: derived("ok"), model: "sonnet", provider: "gw", contextWindow: 200000,
      toolCalls: 3, toolBreakdown: { Bash: 3 },
      reads: [{ path: "/repo/x", displayPath: "x", via: "read", scope: "run" }],
      writes: [{ path: "/repo/y", displayPath: "y", verified: true, bytes: 20 }],
      artifacts: [{ path: "/repo/z", displayPath: "z", exists: true, bytes: 10 }],
      retries: 1, stopReason: "end_turn", truncated: false, durationMs: 4200, summary: "did a thing",
    });
    const b = rvNode({
      id: "b", label: "B", status: "running", stageIndex: 2, lane: 1,
      tokens: tokens(50, 12000), derived: derived("high"), model: "sonnet", provider: null,
      contextWindow: 200000, toolCalls: 1, toolBreakdown: { Read: 1 }, durationMs: null,
    });
    const v = view([a, b], tokens(150, 12000));

    // The reconcile path: RunView (authoritative) → LiveModel (MODEL REPLACE) → RunView (rendered). It must be a
    // no-op over everything the graph renders. shadowDiff returns [] iff every rendered field survived the trip.
    const roundTripped = liveModelToRunView(runViewToLiveModel(v));
    expect(shadowDiff(roundTripped, v)).toEqual([]);
  });

  it("carries the drift-relevant fields (status / tokens / derived / toolCalls) onto the live model EXACTLY", () => {
    const a = rvNode({ id: "a", status: "error", tokens: tokens(777), derived: derived("high"), toolCalls: 5 });
    const v = view([a], tokens(777));
    const m = runViewToLiveModel(v);

    // a reconcile that missed a status flip / stale token count is exactly the drift this net exists to heal —
    // so these are the fields it must carry verbatim from the authoritative view (independently justified values).
    expect(m.nodes[0].status).toBe("error");
    expect(m.nodes[0].tokens?.billable).toBe(777);
    expect(m.nodes[0].derived?.context.tone).toBe("high");
    expect(m.nodes[0].toolCalls).toBe(5);
    // the run-level rollup is ADOPTED from the authoritative view (not recomputed client-side — MODEL REPLACE).
    expect(m.tokenTotal).toEqual(v.tokenTotal);
    // the resolved stage spine and edges are carried so the re-based model lays out identically.
    expect(m.stages).toEqual(v.stages);
    expect(m.edges).toEqual([{ from: "a", to: "b", path: "shared.txt" }]);
  });
});

// (G6 inheritance) The DR6 reconcile must not STRIP a node's base-agent identity: a reconcile that drops
// `agentType` would blank every face/hover card the moment a backgrounded tab returns. Round-trip a view whose
// node carries an agentType; the parity gate (which includes agentType in the field key) must see zero divergence.
describe("runViewToLiveModel — base-agent identity survives the reconcile", () => {
  it("round-trips agentType with ZERO divergence over the shadow-diff field key", () => {
    const a = rvNode({ id: "a", status: "ok", agentType: "coder", tokens: tokens(10), derived: derived("ok") });
    const v = view([a], tokens(10));
    const roundTripped = liveModelToRunView(runViewToLiveModel(v));
    expect(shadowDiff(roundTripped, v)).toEqual([]);
    expect(roundTripped.nodes[0].agentType).toBe("coder");
  });
});
