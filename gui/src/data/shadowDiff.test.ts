// shadowDiff — the P4 dev-only PARITY GATE (docs/design/observe-live-sse-single-source.md DR7/§8/§11). Before
// the default flips to 'sse', a human must PROVE the SSE-rendered graph is byte-identical to the authoritative
// /run-view — never eyeballed. `shadowDiff(sse, poll)` deep-compares the ENTIRE rendered field key (per-node
// tokens/derived/model/…/lane + the edges set + the stages + tokenTotal) and returns the concrete divergences.
//
// These tests have TEETH: identical views → []; a single perturbed field → EXACTLY that divergence with the
// real sse/poll values; a missing node / an added edge → flagged. A comparator that always returns [] (the
// obvious reward-hack) FAILS every non-empty case, because each asserts a concrete `{scope,id,field,sse,poll}`.
import { describe, it, expect } from "vitest";
import { shadowDiff, type Divergence } from "./shadowDiff";
import type { RunView, RunViewNode, NodeDerived, RunTokens } from "./runView";

const tokens = (over: Partial<RunTokens> = {}): RunTokens => ({
  input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, cost: 0.42, contextPeak: 8000, billable: 1234, ...over,
});

const derived = (contextTone: NodeDerived["context"]["tone"] = "high"): NodeDerived => ({
  cacheHit: { ratio: 0.5, tone: "ok" },
  toolError: { errors: 0, rate: 0, tone: "ok" },
  dominance: { tool: "Bash", ratio: 0.6, dominant: true },
  context: { frac: 0.82, tone: contextTone },
  time: null,
  retries: { count: 0, tone: "ok" },
  topTools: [{ name: "Bash", count: 3, pct: 0.6 }],
  outputs: [{ path: "out.txt", bytes: 12, ok: true }],
});

const node = (over: Partial<RunViewNode> = {}): RunViewNode => ({
  id: "build",
  label: "Build",
  phase: "impl",
  status: "ok",
  model: "sonnet",
  provider: "gw",
  contextWindow: 200_000,
  durationMs: 4200,
  toolCalls: 5,
  toolBreakdown: { Bash: 3, Read: 2 },
  timeline: [{ name: "Bash", tStartMs: 0, durMs: 100, ok: true }],
  reads: [{ path: "/a", displayPath: "a", via: "read", scope: "run" }],
  scopes: [],
  writes: [{ path: "/o", displayPath: "o", verified: true, bytes: 12 }],
  artifacts: [{ path: "/o", displayPath: "o", exists: true, bytes: 12 }],
  bash: [],
  tokens: tokens(),
  retries: 0,
  stopReason: "end_turn",
  truncated: false,
  thinkingChars: 0,
  derived: derived(),
  summary: "built the thing",
  stageIndex: 1,
  lane: 0,
  ...over,
});

const view = (over: Partial<RunView> = {}): RunView => ({
  run: "r1",
  provider: "gw",
  model: "sonnet",
  done: true,
  ok: true,
  tokenTotal: tokens({ billable: 1234, contextPeak: 8000 }),
  stages: [{ index: 1, phase: "impl", parallel: false, nodeIds: ["build"] }],
  edges: [{ from: "a", to: "build", path: "shared.txt" }],
  nodes: [node()],
  ...over,
});

/** A deep clone so the "identical" case compares structurally-equal-but-distinct-reference views. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Find the single divergence for a (scope,field[,id]) — asserts there is EXACTLY one and returns it. */
function only(divs: Divergence[], field: string): Divergence {
  const hits = divs.filter((d) => d.field === field);
  expect(hits).toHaveLength(1);
  return hits[0];
}

describe("shadowDiff — the full-field-key parity gate", () => {
  it("returns [] for two structurally identical (distinct-reference) RunViews", () => {
    const sse = view();
    const poll = clone(sse);
    expect(shadowDiff(sse, poll)).toEqual([]);
  });

  it("flags a perturbed node tokens.billable with the concrete sse/poll values", () => {
    const sse = view({ nodes: [node({ tokens: tokens({ billable: 9999 }) })] });
    const poll = view(); // poll billable = 1234
    const divs = shadowDiff(sse, poll);
    // the divergence names the node, the token field, and carries BOTH concrete values — a stub-[] comparator dies here
    const d = divs.find((x) => x.scope === "node" && x.id === "build" && x.field.includes("tokens"));
    expect(d).toBeTruthy();
    expect(d!.field).toContain("billable");
    expect(d!.sse).toBe(9999);
    expect(d!.poll).toBe(1234);
  });

  it("flags a perturbed derived tone", () => {
    const sse = view({ nodes: [node({ derived: derived("warn") })] });
    const poll = view(); // poll derived tone = "high"
    const divs = shadowDiff(sse, poll);
    const d = divs.find((x) => x.scope === "node" && x.id === "build" && x.field.includes("derived") && x.field.includes("context"));
    expect(d).toBeTruthy();
    expect(d!.sse).toBe("warn");
    expect(d!.poll).toBe("high");
  });

  it("flags an edge present in one view but not the other", () => {
    const sse = view({ edges: [{ from: "a", to: "build", path: "shared.txt" }, { from: "build", to: "z", path: "out.txt" }] });
    const poll = view(); // one edge only
    const divs = shadowDiff(sse, poll);
    const edgeDiv = divs.find((d) => d.scope === "edge");
    expect(edgeDiv).toBeTruthy();
    // the extra edge is on the sse side, absent on the poll side
    expect(edgeDiv!.sse).toBeTruthy();
    expect(edgeDiv!.poll).toBeUndefined();
  });

  it("flags a perturbed tokenTotal.billable at run scope", () => {
    const sse = view({ tokenTotal: tokens({ billable: 5555 }) });
    const poll = view(); // tokenTotal billable = 1234
    const divs = shadowDiff(sse, poll);
    const d = divs.find((x) => x.scope === "run" && x.field.includes("tokenTotal") && x.field.includes("billable"));
    expect(d).toBeTruthy();
    expect(d!.sse).toBe(5555);
    expect(d!.poll).toBe(1234);
  });

  it("flags a node present in one view but missing from the other", () => {
    const extra = node({ id: "verify", label: "Verify", stageIndex: 2 });
    const sse = view({ nodes: [node(), extra] });
    const poll = view(); // only "build"
    const divs = shadowDiff(sse, poll);
    const d = divs.find((x) => x.scope === "node" && x.id === "verify");
    expect(d).toBeTruthy();
    // present on sse, absent on poll
    expect(d!.sse).toBeTruthy();
    expect(d!.poll).toBeUndefined();
  });

  it("flags a perturbed stages set (a stage nodeIds change)", () => {
    const sse = view({ stages: [{ index: 1, phase: "impl", parallel: true, nodeIds: ["build", "other"] }] });
    const poll = view(); // parallel:false, nodeIds:["build"]
    const divs = shadowDiff(sse, poll);
    expect(divs.some((d) => d.scope === "run" && d.field.includes("stages"))).toBe(true);
  });

  it("flags a perturbed scalar per-node field (durationMs) with concrete values", () => {
    const sse = view({ nodes: [node({ durationMs: 9000 })] });
    const poll = view(); // durationMs 4200
    const divs = shadowDiff(sse, poll);
    const d = only(divs, "durationMs");
    expect(d.scope).toBe("node");
    expect(d.id).toBe("build");
    expect(d.sse).toBe(9000);
    expect(d.poll).toBe(4200);
  });

  it("flags a perturbed toolBreakdown (a deep object field)", () => {
    const sse = view({ nodes: [node({ toolBreakdown: { Bash: 3, Read: 2, Grep: 1 } })] });
    const poll = view();
    const divs = shadowDiff(sse, poll);
    expect(divs.some((d) => d.scope === "node" && d.id === "build" && d.field.includes("toolBreakdown"))).toBe(true);
  });
});

// (G6 inheritance) agentType is RENDERED (face avatar + hover card + basis chip), so it belongs to the parity
// field key: an SSE path that loses it while /run-view carries it is a real rendered divergence and must be
// flagged — not silently passed. FAILS while NODE_FIELDS omits agentType.
describe("shadowDiff — agentType is part of the rendered field key", () => {
  it("flags a node whose agentType differs between the SSE and poll views", () => {
    const sse = view();
    const poll = clone(sse);
    poll.nodes[0].agentType = "coder"; // /run-view carries the identity; the SSE side lost it
    const out = shadowDiff(sse, poll);
    expect(out).toContainEqual(
      expect.objectContaining({ scope: "node", id: poll.nodes[0].id, field: "agentType", poll: "coder" }),
    );
  });
});
