// skillChips.ts — the skill marketplace's PURE model: the draggable skill-card payload (the EXACT SkillChip
// the write-back path consumes — kind:"skill" + a trimmed skill id) and `marketFilter`, the panel's search +
// ring-narrowing projection. The load-bearing proofs: build/parse round-trip AND parse rejects ANY garbage
// (null, never a partial), and marketFilter narrows by query (over id+name+description, case-insensitive) AND
// ring while PRESERVING input order. These fail if the payload drifts from the writeback contract or the filter
// stops searching a field / stops narrowing / re-sorts — not coverage theater.
import { describe, it, expect } from "vitest";
import { SKILL_CHIP_DND_MIME, buildSkillChip, parseSkillChip, marketFilter } from "./skillChips";
import type { MarketSkill } from "./runView";

describe("SKILL_CHIP_DND_MIME", () => {
  it("is the distinct skill MIME (a gate/agent drag never lands on a skill slot)", () => {
    expect(SKILL_CHIP_DND_MIME).toBe("application/x-piflow-skill-chip");
    expect(SKILL_CHIP_DND_MIME).not.toBe("application/x-piflow-agent-chip");
  });
});

describe("buildSkillChip — skill id → the drag payload the write-back path consumes", () => {
  it("builds { kind:'skill', skill } with the id trimmed", () => {
    expect(buildSkillChip("  harden-blueprint  ")).toEqual({ kind: "skill", skill: "harden-blueprint" });
  });
});

describe("parseSkillChip — the drop payload's parse/validate gate (null on ANY garbage)", () => {
  it("round-trips a market-card drag payload (JSON.stringify(buildSkillChip(id)))", () => {
    const raw = JSON.stringify(buildSkillChip("okf-slices"));
    expect(parseSkillChip(raw)).toEqual({ kind: "skill", skill: "okf-slices" });
  });

  it("trims the skill of a hand-crafted payload", () => {
    expect(parseSkillChip('{"kind":"skill","skill":"  memory-slices  "}')).toEqual({ kind: "skill", skill: "memory-slices" });
  });

  it("rejects non-JSON, wrong kind, and a missing/empty/non-string skill", () => {
    expect(parseSkillChip("")).toBeNull();
    expect(parseSkillChip("not json {")).toBeNull();
    expect(parseSkillChip('"skill"')).toBeNull();                    // JSON, but not an object
    expect(parseSkillChip("[1,2]")).toBeNull();                       // an array is not a chip
    expect(parseSkillChip("null")).toBeNull();
    expect(parseSkillChip('{"kind":"agent","skill":"coder"}')).toBeNull(); // an AGENT payload never lands here
    expect(parseSkillChip('{"kind":"skill"}')).toBeNull();                 // missing skill
    expect(parseSkillChip('{"kind":"skill","skill":"   "}')).toBeNull();   // empty after trim
    expect(parseSkillChip('{"kind":"skill","skill":42}')).toBeNull();      // non-string
  });
});

// A deterministic 50-entry catalog across BOTH rings, with "harden" only in some NAMEs and "mcp" only in some
// DESCRIPTIONs — so a filter that ignores a field, drops the ring narrowing, or re-sorts is caught at scale.
function genEntries(n: number): MarketSkill[] {
  const out: MarketSkill[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `skill-${i}`,
      ring: i % 2 === 0 ? "workspace" : "installed",
      name: i % 5 === 0 ? `Harden ${i}` : `Skill ${i}`,
      description: i % 3 === 0 ? `wires an MCP catalog (${i})` : `plain helper ${i}`,
      requires: [],
      allowed: [],
      mcpRequires: [],
      provisioned: true,
    });
  }
  return out;
}

describe("marketFilter — the panel's search/filter projection (over 50 entries)", () => {
  const entries = genEntries(50);

  it("an empty query returns EVERY entry in INPUT order (stable, no re-sort)", () => {
    const out = marketFilter(entries, "");
    expect(out).toHaveLength(50);
    expect(out.map((e) => e.id)).toEqual(entries.map((e) => e.id));
  });

  it("a whitespace-only query is treated as empty (returns all)", () => {
    expect(marketFilter(entries, "   ")).toHaveLength(50);
  });

  it("the ring narrows to that half, preserving order", () => {
    const ws = marketFilter(entries, "", "workspace");
    expect(ws).toHaveLength(25);
    expect(ws.every((e) => e.ring === "workspace")).toBe(true);
    expect(ws.map((e) => e.id)).toEqual(entries.filter((e) => e.ring === "workspace").map((e) => e.id));
  });

  it("a query matches the NAME field, case-insensitively", () => {
    const byName = marketFilter(entries, "HARDEN");
    expect(byName.map((e) => e.id)).toEqual(entries.filter((e) => e.name.toLowerCase().includes("harden")).map((e) => e.id));
    expect(byName).toHaveLength(10); // i%5===0 over 0..49
    expect(byName.every((e) => e.name.toLowerCase().includes("harden"))).toBe(true);
  });

  it("a query matches the DESCRIPTION field (a term that appears ONLY there)", () => {
    const byDesc = marketFilter(entries, "mcp");
    expect(byDesc.length).toBeGreaterThan(0);
    expect(byDesc.map((e) => e.id)).toEqual(entries.filter((e) => e.description!.toLowerCase().includes("mcp")).map((e) => e.id));
    expect(byDesc.every((e) => e.description!.toLowerCase().includes("mcp"))).toBe(true);
  });

  it("a query matches the ID field", () => {
    expect(marketFilter(entries, "skill-7").map((e) => e.id)).toEqual(["skill-7"]);
  });

  it("query + ring COMPOSE (both narrow) and the result stays in input order", () => {
    const out = marketFilter(entries, "skill", "installed");
    const expected = entries.filter(
      (e) => e.ring === "installed" && `${e.id} ${e.name} ${e.description}`.toLowerCase().includes("skill"),
    );
    expect(out.map((e) => e.id)).toEqual(expected.map((e) => e.id));
    expect(out.every((e) => e.ring === "installed")).toBe(true);
  });

  it("a query that matches nothing returns []", () => {
    expect(marketFilter(entries, "zzz-nonexistent")).toEqual([]);
  });
});
