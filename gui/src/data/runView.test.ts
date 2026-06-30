// (SA-E) gatePipelineLabels — the pure projection of a node's authored `op[]` lane onto the compact
// gate-chip labels the node badge surfaces (the badge WIDEN). This is the badge's correctness contract:
// an op.run reads "exec", an op.gate reads "floor:<kind>", a rerouteTo action reads "judge", and a G5
// `checkpoint` reads "human" — IN op[] ORDER (the pipeline is ordered). A test here FAILS if the badge
// would mislabel or drop a gate, or scramble the order — not coverage theater.
import { describe, it, expect } from "vitest";
import { gatePipelineLabels, sandboxSkin, effectiveSandbox, type AuthoredNodeConfig, type RunView, type RunViewNode } from "./runView";

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
