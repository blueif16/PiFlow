import { describe, it, expect } from "vitest";
import { deriveZones, bbox } from "./zones";
import { NODE_W, nodePosition, type RunView, type RunViewNode } from "./runView";

// deriveZones/bbox read only id, agentType, stageIndex, lane off each node — cast a minimal shape.
function node(id: string, stageIndex: number, lane: number, agentType?: string): RunViewNode {
  return { id, stageIndex, lane, agentType } as unknown as RunViewNode;
}
const view = (nodes: RunViewNode[]): RunView => ({ nodes }) as unknown as RunView;

// The reported cut-off case: a MoA judge `research` + 3 generated siblings across 3 lanes.
const nodes = [
  node("research", 1, 0, "fusion-judge-moa"),
  node("research-p1", 1, 0),
  node("research-p2", 1, 1),
  node("research-p3", 1, 2),
];
const v = view(nodes);

describe("deriveZones — the fusion frame", () => {
  it("emits one Model-Fusion zone spanning the judge + its generated members", () => {
    const zones = deriveZones(v);
    expect(zones).toHaveLength(1);
    expect(zones[0].kind).toBe("fusion");
    expect(zones[0].label).toBe("Model Fusion");
    expect(zones[0].memberIds).toEqual(["research", "research-p1", "research-p2", "research-p3"]);
  });

  it("fully encloses every member card with margin on all sides — no cut-off", () => {
    const box = bbox(nodes.map((n) => n.id), v)!;
    for (const n of nodes) {
      const { x, y } = nodePosition(n.stageIndex, n.lane);
      expect(box.x).toBeLessThan(x); // left margin
      expect(box.y).toBeLessThan(y); // top margin
      expect(box.x + box.width).toBeGreaterThan(x + NODE_W); // right margin (card is NODE_W wide)
      // Bottom must clear the REAL rendered card height, which exceeds the 64px NODE_H min. This fails if the
      // box is measured off NODE_H again (the bug): the lowest lane's card would poke through the frame bottom.
      expect(box.y + box.height).toBeGreaterThan(y + 96);
    }
  });
});
