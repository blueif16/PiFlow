// gates.ts — the compose editor's PURE gate-authoring model. The load-bearing proof: the drop card's
// natural-language text is mapped to a valid GateChip payload for EACH kind, and the ONE field that was
// silently omitted before (judge → rubric — the reason every judge drop 400'd, compose-gate-audit.md §4.1)
// now rides the chip VERBATIM. These tests fail if the mapping drops/renames a required field or stops
// gating an empty required input — not coverage theater.
import { describe, it, expect } from "vitest";
import {
  buildGateChip,
  canCreateGate,
  gateNeedsText,
  JUDGE_DEFAULT_TIER,
  DEFAULT_HUMAN_QUESTION,
  RAIL_KINDS,
} from "./gates";

describe("buildGateChip — natural-language text → the per-kind GateChip payload", () => {
  it("execution → { cmd, onFailure:block }, command trimmed", () => {
    const chip = buildGateChip("execution", "  npm test  ");
    expect(chip).toEqual({ kind: "execution", cmd: "npm test", onFailure: "block" });
  });

  it("agentic check (judge) → carries the pasted text VERBATIM as the rubric + system defaults", () => {
    const paragraph =
      "A good output names each file it changed and quotes the exact line it edited, with no invented paths.";
    const chip = buildGateChip("judge", paragraph);
    // the rubric is the reason the old palette drop 400'd (it was omitted); it must be present + verbatim.
    expect(chip.rubric).toBe(paragraph);
    expect(chip.kind).toBe("judge");
    expect(chip.judgeTier).toBe(JUDGE_DEFAULT_TIER);
    expect(chip.threshold).toBe("pass");
    expect(chip.retryMax).toBe(1);
  });

  it("agentic check preserves internal whitespace/newlines in the rubric (truly verbatim)", () => {
    const multiline = "Line one.\n\nLine two, indented:\n  - a bullet";
    expect(buildGateChip("judge", multiline).rubric).toBe(multiline);
  });

  it("human → a confirm checkpoint carrying the question, trimmed", () => {
    expect(buildGateChip("human", "  Ship it?  ")).toEqual({
      kind: "human",
      checkpointKind: "confirm",
      question: "Ship it?",
    });
  });

  it("human with empty text falls back to the default question (question is optional)", () => {
    expect(buildGateChip("human", "   ").question).toBe(DEFAULT_HUMAN_QUESTION);
  });
});

describe("canCreateGate / gateNeedsText — required-field gating (per-kind)", () => {
  it("execution + judge REQUIRE non-empty text; human does not", () => {
    expect(gateNeedsText("execution")).toBe(true);
    expect(gateNeedsText("judge")).toBe(true);
    expect(gateNeedsText("human")).toBe(false);
  });

  it("rejects empty/whitespace-only text for a kind that needs it", () => {
    expect(canCreateGate("judge", "")).toBe(false);
    expect(canCreateGate("judge", "   ")).toBe(false);
    expect(canCreateGate("execution", "\n\t")).toBe(false);
  });

  it("accepts any non-empty text for a needs-text kind, and always accepts human", () => {
    expect(canCreateGate("judge", "looks right")).toBe(true);
    expect(canCreateGate("execution", "pytest")).toBe(true);
    expect(canCreateGate("human", "")).toBe(true);
  });
});

describe("RAIL_KINDS — the three authorable kinds surfaced on the rail", () => {
  it("exposes exactly execution / judge / human, each with user-facing (non-jargon) copy", () => {
    const kinds = RAIL_KINDS.map((r) => r.kind).sort();
    expect(kinds).toEqual(["execution", "human", "judge"]);
    for (const r of RAIL_KINDS) {
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.desc.length).toBeGreaterThan(0);
      expect(r.placeholder.length).toBeGreaterThan(0);
      // never leak internal jargon into user-facing copy
      expect(`${r.name} ${r.desc} ${r.placeholder}`.toLowerCase()).not.toContain("judgetier");
      expect(`${r.name} ${r.desc} ${r.placeholder}`.toLowerCase()).not.toContain("rubric");
    }
  });
});
