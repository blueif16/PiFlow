// agentChips.ts — the basis editor's PURE agent-reassignment model. The load-bearing proof: the rail's
// drag payload is the EXACT AgentChip the write-back path consumes (kind:"agent" + a trimmed agentType),
// a dropped payload that isn't a well-formed agent chip is REJECTED (null, never a partial object), and
// the rail projection is a stable label-sorted view of the catalog. These tests fail if the payload shape
// drifts from the writeback contract or the parse stops rejecting garbage — not coverage theater.
import { describe, it, expect } from "vitest";
import { agentRailEntries, buildAgentChip, parseAgentChip } from "./agentChips";

describe("buildAgentChip — agentType → the drag payload the write-back path consumes", () => {
  it("builds { kind:'agent', agentType } with the id trimmed", () => {
    expect(buildAgentChip("  coder  ")).toEqual({ kind: "agent", agentType: "coder" });
  });
});

describe("parseAgentChip — the drop payload's parse/validate gate (null on ANY garbage)", () => {
  it("round-trips a rail drag payload (JSON.stringify(buildAgentChip(id)))", () => {
    const raw = JSON.stringify(buildAgentChip("reviewer"));
    expect(parseAgentChip(raw)).toEqual({ kind: "agent", agentType: "reviewer" });
  });

  it("trims the agentType of a hand-crafted payload", () => {
    expect(parseAgentChip('{"kind":"agent","agentType":"  plan  "}')).toEqual({ kind: "agent", agentType: "plan" });
  });

  it("rejects non-JSON, wrong kind, and a missing/empty/non-string agentType", () => {
    expect(parseAgentChip("")).toBeNull();
    expect(parseAgentChip("not json {")).toBeNull();
    expect(parseAgentChip('"agent"')).toBeNull(); // JSON, but not an object
    expect(parseAgentChip("[1,2]")).toBeNull(); // an array is not a chip
    expect(parseAgentChip("null")).toBeNull();
    expect(parseAgentChip('{"kind":"judge","agentType":"coder"}')).toBeNull(); // a GATE payload never lands here
    expect(parseAgentChip('{"kind":"agent"}')).toBeNull(); // missing agentType
    expect(parseAgentChip('{"kind":"agent","agentType":"   "}')).toBeNull(); // empty after trim
    expect(parseAgentChip('{"kind":"agent","agentType":42}')).toBeNull(); // non-string
  });
});

describe("agentRailEntries — the catalog → the label-sorted rail rows", () => {
  it("sorts by label (case-insensitive), falling back to the id when a label is absent", () => {
    const rows = agentRailEntries({
      zed: { label: "zeta" },
      scout: {}, // no label → sorts by its id
      author: { label: "The Scribe" },
    });
    expect(rows.map((r) => r.id)).toEqual(["scout", "author", "zed"]); // scout < The Scribe < zeta
    expect(rows[0].label).toBe("scout"); // id fallback IS the label
    expect(rows[1].label).toBe("The Scribe");
  });

  it("carries the branding (icon/color) and derives the hover eyebrow from the prompt's first line", () => {
    const rows = agentRailEntries({
      coder: { label: "The Maker", icon: "spark", color: "#a55", prompt: "\n\nBuild it right.\nSecond line ignored." },
    });
    expect(rows[0]).toMatchObject({ id: "coder", label: "The Maker", icon: "spark", color: "#a55", promptLine: "Build it right." });
  });

  it("truncates a long prompt line and omits the eyebrow when there is no prompt", () => {
    const long = "x".repeat(200);
    const [withPrompt] = agentRailEntries({ a: { prompt: long } });
    expect(withPrompt.promptLine!.length).toBeLessThan(120);
    expect(withPrompt.promptLine!.endsWith("…")).toBe(true);
    const [noPrompt] = agentRailEntries({ b: {} });
    expect(noPrompt.promptLine).toBeUndefined();
  });
});
