// (SA-E) gatePipelineLabels — the pure projection of a node's authored `op[]` lane onto the compact
// gate-chip labels the node badge surfaces (the badge WIDEN). This is the badge's correctness contract:
// an op.run reads "exec", an op.gate reads "floor:<kind>", a rerouteTo action reads "judge", and a G5
// `checkpoint` reads "human" — IN op[] ORDER (the pipeline is ordered). A test here FAILS if the badge
// would mislabel or drop a gate, or scramble the order — not coverage theater.
import { describe, it, expect } from "vitest";
import { digestLiveSig, gatePipelineLabels, sandboxSkin, effectiveSandbox, toFlowGraph, type AuthoredNodeConfig, type RunView, type RunViewNode } from "./runView";
import type { LiveModel, LiveNode } from "./runStream";

describe("gatePipelineLabels — op[] → badge chip labels", () => {
  it("an unconfigured node (no op[], no checkpoint) has an empty pipeline", () => {
    expect(gatePipelineLabels({ id: "n" })).toEqual([]);
    expect(gatePipelineLabels(null)).toEqual([]);
    expect(gatePipelineLabels(undefined)).toEqual([]);
  });

  it("maps each op body to its chip label, preserving op[] ORDER", () => {
    const cfg: AuthoredNodeConfig = {
      id: "build",
      op: [
        { when: "post", run: { cmd: "npm test" } },
        { when: "post", gate: { kind: "non-empty" } },
        { when: "on-failure", action: { kind: "rerouteTo", node: "build" } },
      ],
    };
    // exec (run) → floor:<kind> (gate) → judge (rerouteTo) — in authored order.
    expect(gatePipelineLabels(cfg)).toEqual(["exec", "floor:non-empty", "judge"]);
  });

  it("a human gate (G5 checkpoint) appends 'human' to the pipeline", () => {
    const cfg: AuthoredNodeConfig = { id: "build", op: [{ when: "post", run: { cmd: "tsc" } }], checkpoint: { kind: "confirm", prompt: "ok?" } };
    expect(gatePipelineLabels(cfg)).toEqual(["exec", "human"]);
  });

  it("a non-reroute action keeps its kind as the label (e.g. retry)", () => {
    const cfg: AuthoredNodeConfig = { id: "n", op: [{ when: "on-failure", action: { kind: "retry" } }] };
    expect(gatePipelineLabels(cfg)).toEqual(["retry"]);
  });
});

// (P5) digestLiveSig — the PURE trigger signature RunDigestPanel refetches on UNDER SSE. It returns null in
// poll-mode (sseLive off / no model) so the panel keeps its 3 s fallback timer; otherwise a stable string over
// the per-node statuses + a COARSE billable bucket, so it CHANGES exactly when the digest would (a status flip
// = verdict/anomalies, or billable crossing a ~5000-token bucket = cost-spine freshness) and is STABLE while the
// run is idle (no wasted refetch). These tests FAIL if the sig ignores status, ignores billable, or isn't stable.
describe("digestLiveSig — event-driven digest refetch trigger", () => {
  const liveNode = (p: Partial<LiveNode>): LiveNode => ({
    id: "n", label: "n", phase: null, status: "running", stageIndex: 1, lane: 0, ...p,
  });
  const model = (p: Partial<LiveModel> & { nodes: LiveNode[] }): LiveModel => ({
    run: "r", done: false, ok: null, durationMs: null, totals: null, ...p,
  });

  it("returns null in poll-mode (sseLive false) and when the model is null", () => {
    expect(digestLiveSig(false, model({ nodes: [liveNode({ id: "a" })] }))).toBeNull();
    expect(digestLiveSig(true, null)).toBeNull();
  });

  it("is STABLE across two calls with an unchanged model (idle ⇒ no refetch)", () => {
    const m = model({ nodes: [liveNode({ id: "a", status: "running" })] });
    expect(digestLiveSig(true, m)).toBe(digestLiveSig(true, m));
  });

  it("CHANGES when a node's status flips (running → ok = a verdict/anomaly change)", () => {
    const before = digestLiveSig(true, model({ nodes: [liveNode({ id: "a", status: "running" })] }));
    const after = digestLiveSig(true, model({ nodes: [liveNode({ id: "a", status: "ok" })] }));
    expect(after).not.toBe(before);
  });

  it("CHANGES across a billable bucket boundary (0 → 6000) but is STABLE within a bucket (100 → 200)", () => {
    const withBillable = (billable: number) =>
      model({ nodes: [liveNode({ id: "a", status: "running" })], tokenTotal: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPeak: 0, billable } });
    // crosses the ~5000-token bucket → the cost spine is stale → refetch
    expect(digestLiveSig(true, withBillable(6000))).not.toBe(digestLiveSig(true, withBillable(0)));
    // a sub-bucket jump stays in bucket 0 → no wasted refetch
    expect(digestLiveSig(true, withBillable(200))).toBe(digestLiveSig(true, withBillable(100)));
  });
});

// (per-node-full-access §4/§7) The node skin is a PURE projection of node config — three modes
// flat | cloud | unlocked. Precedence: cloud backend → "cloud"; else config.fullAccess → "unlocked";
// else "flat" (INCLUDING a programmatic node — it has no sandbox to unlock, so it stays flat). The skin
// reads ONLY node.config.fullAccess (a per-node value); there is NO run-level field. A test here FAILS
// if the precedence inverts, if a programmatic node mislabels as "unlocked", or if cloud loses to fullAccess.
describe("sandboxSkin — node config → flat | cloud | unlocked", () => {
  const node = (config?: RunViewNode["config"]): RunViewNode =>
    ({ id: "n", label: "n", phase: null, status: "ok", config, toolCalls: 0, toolBreakdown: {}, timeline: [], reads: [], scopes: [], writes: [], artifacts: [], bash: [], retries: 0, stopReason: null, truncated: false, thinkingChars: 0 });
  const view = (sandbox?: RunView["sandbox"]): RunView =>
    ({ run: "r", sandbox, stages: [], edges: [], nodes: [] });

  it("returns 'unlocked' when the node's config.fullAccess is set", () => {
    const v = view("local");
    const n = node({ fullAccess: true });
    expect(sandboxSkin(effectiveSandbox(v, n), n)).toBe("unlocked");
  });

  it("returns 'cloud' for a cloud backend (daytona / e2b), winning over fullAccess", () => {
    for (const backend of ["daytona", "e2b"] as const) {
      const v = view(backend);
      // even if fullAccess is set, the cloud backend takes precedence (a no-op in cloud).
      const n = node({ fullAccess: true });
      expect(sandboxSkin(effectiveSandbox(v, n), n)).toBe("cloud");
    }
  });

  it("returns 'flat' for a plain local node (no fullAccess)", () => {
    const v = view("local");
    expect(sandboxSkin(effectiveSandbox(v, node()), node())).toBe("flat");
  });

  it("returns 'flat' for a programmatic node — it has no sandbox to unlock", () => {
    // a programmatic node is host-local (effectiveSandbox → "local") and never carries fullAccess.
    const v = view("local");
    const n = node({ programmatic: true });
    expect(sandboxSkin(effectiveSandbox(v, n), n)).toBe("flat");
  });
});

// RENDER-ONLY CONTRACT: the observe surface stamps `derived` on every run-view node (core buildRunView →
// deriveNode); the GUI RENDERS it and re-derives NOTHING. `toFlowGraph` must pass `derived` through UNTOUCHED.
// This FAILS the moment anyone reintroduces a browser-side recompute (which allocates a new object, breaking
// the reference identity), and FAILS if the GUI fabricates `derived` for a node the surface left bare.
describe("toFlowGraph — renders the surface's `derived`, computes nothing", () => {
  const node = (p: Partial<RunViewNode>): RunViewNode => ({
    id: "n", label: "n", phase: null, status: "ok",
    toolCalls: 0, toolBreakdown: {}, timeline: [], reads: [], scopes: [], writes: [], artifacts: [],
    bash: [], retries: 0, stopReason: null, truncated: false, thinkingChars: 0, ...p,
  });

  it("passes the surface-stamped `derived` through by reference (never re-derives)", () => {
    const derived: RunViewNode["derived"] = {
      cacheHit: null,
      toolError: { errors: 0, rate: 0, tone: "ok" },
      dominance: { tool: null, ratio: 0, dominant: false },
      context: { frac: 0, tone: "ok" },
      time: null,
      retries: { count: 0, tone: "ok" },
      topTools: [],
      outputs: [],
    };
    const view: RunView = { run: "r", stages: [], edges: [], nodes: [node({ id: "a", derived })] };
    const { nodes } = toFlowGraph(view);
    expect(nodes[0].data.rv?.derived).toBe(derived); // the SAME object — not a recomputed copy
  });

  it("does not fabricate `derived` for a node the surface left bare", () => {
    const view: RunView = { run: "r", stages: [], edges: [], nodes: [node({ id: "a" })] };
    const { nodes } = toFlowGraph(view);
    expect(nodes[0].data.rv?.derived).toBeUndefined();
  });
});
