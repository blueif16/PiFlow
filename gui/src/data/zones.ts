// zones.ts — the GUI's "frame channel": a non-interactive backdrop box drawn BEHIND a cluster of related
// nodes to signal "these belong together". Membership is DERIVED from node identity on the GUI side (zero
// core/SDK change). Each zone becomes its OWN React Flow node (type:'zone') — NOT parentId reparenting —
// because WorkflowCanvas rebuilds the whole nodes array from `toFlowGraph` every poll and a node carries
// exactly one parentId; a flat zone node recomputes cleanly each poll alongside the real cards.
//
// v1 draws ONE frame variant: the FUSION cluster (judge + its generated siblings/obligations). A neutral
// TEMPLATE-frame variant of the SAME primitive exists but self-suppresses today (single-namespace
// workflows draw nothing). fusion vs template differ ONLY by hue/stroke (in zones.css), never geometry.
import type { Node } from "@xyflow/react";
import type { RunView, RunViewNode } from "./runView";
import { COL, NODE_W, NODE_H, nodePosition } from "./runView";

export type ZoneKind = "fusion" | "template";

/** A derived backdrop region: which member cards it spans, its absolute box, and its hue/label. */
export interface Zone {
  id: string;
  kind: ZoneKind;
  /** the member node ids this frame sits behind (judge + generated members, for fusion). */
  memberIds: string[];
  /** the mono UPPERCASE label tab (e.g. "Model Fusion" / "best-of-N"); omitted ⇒ no tab. */
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The React Flow node `data` a `type:'zone'` node carries (consumed by `ZoneNode`). */
export interface ZoneData extends Record<string, unknown> {
  kind: ZoneKind;
  label?: string;
  width: number;
  height: number;
}

export type ZoneFlowNode = Node<ZoneData, "zone">;

/** fusion-GENERATED members — a `${judgeId}-p<n>` sibling or `${judgeId}-obl` obligations node (matches
 *  `NodeFusionToggle`'s GENERATED regex). The judge keeps the activated node's original id. */
const GENERATED = /-(p\d+|obl)$/;

/** Padding inset around a cluster's tight member box → the frame breathes around the cards. */
const PAD = 30;

/** Effective card height for the box's VERTICAL extent. NODE_H (64) is the card MIN-height used for lane
 *  stride, but the REAL rendered card (header + body + underline, and a fusion-toggle row on the judge) is
 *  taller — so measuring the box off NODE_H left the frame's bottom cutting through the lowest card. CARD_H is
 *  a generous real-height estimate so the frame fully clears the cards. (Width is exact: cards are a fixed
 *  NODE_W, so the horizontal extent still uses NODE_W.) */
const CARD_H = 104;

/** Inflate a set of member ids into one absolute box. Mirrors `toFlowGraph` placement: each member's top-left
 *  anchor is `nodePosition(stageIndex, lane)`; the box spans from the min anchor to the max anchor + the card
 *  size (NODE_W wide, CARD_H tall — the real rendered height, not the NODE_H min), then insets by PAD on all
 *  sides. Multi-lane / multi-stage clusters are handled by the min/max over every member; absent members skip. */
export function bbox(memberIds: string[], view: RunView): { x: number; y: number; width: number; height: number } | null {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of memberIds) {
    const n = byId.get(id);
    if (!n) continue;
    const { x, y } = nodePosition(n.stageIndex, n.lane);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + NODE_W);
    maxY = Math.max(maxY, y + CARD_H);
  }
  if (minX === Infinity) return null; // no member resolved
  return { x: minX - PAD, y: minY - PAD, width: maxX - minX + 2 * PAD, height: maxY - minY + 2 * PAD };
}

/** The label tab text for a fusion judge, matching the on-screen mode labels (NodeFusionToggle). */
function fusionLabel(agentType: string | undefined): string | undefined {
  if (agentType === "fusion-judge-moa") return "Model Fusion";
  if (agentType === "fusion-judge-best-of-n") return "best-of-N";
  return undefined;
}

/** Bucket nodes by their subworkflow id-namespace (G9, types.ts). STUB: today every workflow is a single
 *  namespace, so this returns ONE bucket → the template loop self-suppresses (it only draws when there is
 *  more than one bucket). The code path exists so the neutral template frame lights up the moment a run
 *  carries multiple namespaces, with no further wiring. */
function groupByTemplateNamespace(nodes: RunViewNode[]): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  buckets.set("__single__", nodes.map((n) => n.id));
  return buckets;
}

/** Derive every backdrop zone for a run-view. Pure: no React, no side effects.
 *  - FUSION: each judge (`agentType` === fusion-judge-*) anchors a cluster = [judgeId, ...its `-p<n>`/`-obl`
 *    members]. A cluster with < 2 members is SKIPPED (a lone judge frames nothing).
 *  - TEMPLATE (dormant): one neutral frame per namespace bucket, but ONLY when there is more than one bucket
 *    — single-namespace runs (every run today) draw no template frame. */
export function deriveZones(view: RunView): Zone[] {
  const zones: Zone[] = [];

  // FUSION clusters (the only frame that draws today).
  for (const judge of view.nodes) {
    const label = fusionLabel(judge.agentType);
    if (!label) continue; // not a fusion judge
    const members = view.nodes.filter((n) => n.id !== judge.id && n.id.startsWith(`${judge.id}-`) && GENERATED.test(n.id));
    const memberIds = [judge.id, ...members.map((m) => m.id)];
    if (memberIds.length < 2) continue; // a lone judge frames nothing
    const box = bbox(memberIds, view);
    if (!box) continue;
    zones.push({ id: `zone:fusion:${judge.id}`, kind: "fusion", memberIds, label, ...box });
  }

  // TEMPLATE buckets (dormant — suppressed while there is a single namespace).
  const buckets = groupByTemplateNamespace(view.nodes);
  if (buckets.size > 1) {
    for (const [ns, memberIds] of buckets) {
      if (memberIds.length < 2) continue;
      const box = bbox(memberIds, view);
      if (!box) continue;
      zones.push({ id: `zone:template:${ns}`, kind: "template", memberIds, label: ns.toUpperCase(), ...box });
    }
  }

  return zones;
}

/** Build the `type:'zone'` React Flow node for a zone: absolute position, the card size carried in `data`
 *  (so the custom node can size itself), and z-order/interaction locks. A fusion zone paints at zIndex:-1
 *  (under every real card, which defaults to 0); a template zone sits at -2 so a fusion frame nests ABOVE it.
 *  Non-interactive: NOT draggable/selectable/connectable/deletable (v12 has no node-level `focusable`, so the
 *  rest of the non-focus contract — pointer-events:none, aria-hidden, tabIndex:-1 — lives on `ZoneNode`). */
export function toZoneFlowNode(zone: Zone): ZoneFlowNode {
  return {
    id: zone.id,
    type: "zone",
    position: { x: zone.x, y: zone.y },
    data: { kind: zone.kind, label: zone.label, width: zone.width, height: zone.height },
    zIndex: zone.kind === "fusion" ? -1 : -2,
    draggable: false,
    selectable: false,
    connectable: false,
    deletable: false,
  };
}
