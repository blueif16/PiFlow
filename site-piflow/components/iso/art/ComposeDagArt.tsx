/**
 * ComposeDagArt — bespoke isometric illustration of a composed DAG.
 * One GOAL node fans out into 3 parallel work nodes, which converge
 * into a single PUBLISH node — rendered as a layered iso scene on a floor.
 * RSC/server-safe: no "use client", no hooks, no browser APIs.
 *
 * Coverage inventory (bar verification):
 *   IsoGrid   : 1  (faint floor)
 *   Nodes     : 5  total (1 goal + 3 parallel + 1 publish)
 *   IsoPlane  : 5  (platform tile beneath each node box)
 *   IsoBox    : 5  (node volumes; exactly 1 variant="glow" on mid2)
 *   IsoEdge   : 6  (goal→mid1, goal→mid2, goal→mid3, mid1→pub, mid2→pub, mid3→pub)
 *               — 2 touching glow node use className="flow" dash="8 260"
 *               — 4 others use className="draw" with len
 *   IsoDot    : 5  (one per node; glow node has accent ring)
 *   IsoPost   : 3  (risers under mid nodes for floor depth)
 *
 * Coordinate system: x→down-right, y→down-left, z→up (iso units).
 *
 * Layout (iso units):
 *   GOAL     x=0,   y=0,   box w=20 d=20 h=10
 *   MID1     x=60,  y=-30, box w=20 d=20 h=10  (upper-right on screen)
 *   MID2     x=60,  y=0,   box w=20 d=20 h=10  ← glow / running
 *   MID3     x=60,  y=30,  box w=20 d=20 h=10  (lower-left on screen)
 *   PUBLISH  x=120, y=0,   box w=20 d=20 h=10
 *
 * ViewBox: "-72 -53 264 176"
 *   sx range ≈ −43 to +165; sy range ≈ −25 to +95; +28u pad on all sides.
 */

import {
  IsoScene,
  IsoBox,
  IsoPlane,
  IsoGrid,
  IsoEdge,
  IsoDot,
  IsoPost,
} from "@/components/iso/iso";

const ACCENT = "#3df2a7";
const NEUTRAL = "rgba(255,255,255,0.16)";

// ─── Node positions (iso units) ──────────────────────────────────────────────
// Box dimensions shared across all nodes
const BW = 20; // width  (x-axis)
const BD = 20; // depth  (y-axis)
const BH = 10; // height (z-axis)

// Node anchor points (bottom-front corner of each box)
const GOAL    = { x: 0,   y: 0,   z: 0 } as const;
const MID1    = { x: 60,  y: -30, z: 0 } as const; // upper-right fan
const MID2    = { x: 60,  y: 0,   z: 0 } as const; // center fan — glow / running
const MID3    = { x: 60,  y: 30,  z: 0 } as const; // lower-left fan
const PUBLISH = { x: 120, y: 0,   z: 0 } as const;

// Top-center of each node box (edge attachment point)
function topCenter(
  n: { x: number; y: number; z: number },
): [number, number, number] {
  return [n.x + BW / 2, n.y + BD / 2, BH];
}

export default function ComposeDagArt({ className }: { className?: string }) {
  return (
    <IsoScene viewBox="-72 -53 264 176" className={className}>

      {/* ── 1. Faint iso floor grid ────────────────────────────────────── */}
      <IsoGrid
        x={-8} y={-40} z={0}
        w={150} d={80}
        step={24}
      />

      {/* ── 2. Platform planes (iso tiles under each node) ─────────────── */}
      {/* GOAL platform */}
      <IsoPlane
        x={GOAL.x - 2} y={GOAL.y - 2} z={0}
        w={BW + 4} d={BD + 4}
        accent={ACCENT}
        fillAlpha={0.03}
        stroke={NEUTRAL}
        strokeWidth={1.1}
        dash="3 5"
      />
      {/* MID1 platform */}
      <IsoPlane
        x={MID1.x - 2} y={MID1.y - 2} z={0}
        w={BW + 4} d={BD + 4}
        accent={ACCENT}
        fillAlpha={0.03}
        stroke={NEUTRAL}
        strokeWidth={1.1}
        dash="3 5"
      />
      {/* MID2 platform — slightly stronger fill for the running node */}
      <IsoPlane
        x={MID2.x - 2} y={MID2.y - 2} z={0}
        w={BW + 4} d={BD + 4}
        accent={ACCENT}
        fillAlpha={0.07}
        stroke={ACCENT}
        strokeWidth={1.1}
      />
      {/* MID3 platform */}
      <IsoPlane
        x={MID3.x - 2} y={MID3.y - 2} z={0}
        w={BW + 4} d={BD + 4}
        accent={ACCENT}
        fillAlpha={0.03}
        stroke={NEUTRAL}
        strokeWidth={1.1}
        dash="3 5"
      />
      {/* PUBLISH platform */}
      <IsoPlane
        x={PUBLISH.x - 2} y={PUBLISH.y - 2} z={0}
        w={BW + 4} d={BD + 4}
        accent={ACCENT}
        fillAlpha={0.04}
        stroke={NEUTRAL}
        strokeWidth={1.1}
        dash="3 5"
      />

      {/* ── 3. Vertical posts under mid nodes (depth cue) ──────────────── */}
      <IsoPost
        x={MID1.x + BW / 2} y={MID1.y + BD / 2}
        z0={0} z1={BH}
        accent={NEUTRAL}
        strokeWidth={1}
        dash="2 4"
      />
      <IsoPost
        x={MID2.x + BW / 2} y={MID2.y + BD / 2}
        z0={0} z1={BH}
        accent={ACCENT}
        strokeWidth={1}
        dash="2 4"
      />
      <IsoPost
        x={MID3.x + BW / 2} y={MID3.y + BD / 2}
        z0={0} z1={BH}
        accent={NEUTRAL}
        strokeWidth={1}
        dash="2 4"
      />

      {/* ── 4. Fan-out edges: GOAL → each MID ─────────────────────────── */}
      {/* goal → mid1 : draw (not touching glow node directly) */}
      <IsoEdge
        from={topCenter(GOAL)}
        to={topCenter(MID1)}
        accent={NEUTRAL}
        curved
        lift={22}
        strokeWidth={1.4}
        className="draw"
        len={145}
        opacity={0.7}
      />
      {/* goal → mid2 (glow): flow — the active edge */}
      <IsoEdge
        from={topCenter(GOAL)}
        to={topCenter(MID2)}
        accent={ACCENT}
        curved
        lift={22}
        strokeWidth={1.6}
        dash="8 260"
        className="flow"
      />
      {/* goal → mid3 : draw */}
      <IsoEdge
        from={topCenter(GOAL)}
        to={topCenter(MID3)}
        accent={NEUTRAL}
        curved
        lift={22}
        strokeWidth={1.4}
        className="draw"
        len={155}
        opacity={0.7}
      />

      {/* ── 5. Converge edges: each MID → PUBLISH ──────────────────────── */}
      {/* mid1 → publish : draw */}
      <IsoEdge
        from={topCenter(MID1)}
        to={topCenter(PUBLISH)}
        accent={NEUTRAL}
        curved
        lift={22}
        strokeWidth={1.4}
        className="draw"
        len={150}
        opacity={0.7}
      />
      {/* mid2 (glow) → publish : flow — the active outgoing edge */}
      <IsoEdge
        from={topCenter(MID2)}
        to={topCenter(PUBLISH)}
        accent={ACCENT}
        curved
        lift={22}
        strokeWidth={1.6}
        dash="8 260"
        className="flow"
      />
      {/* mid3 → publish : draw */}
      <IsoEdge
        from={topCenter(MID3)}
        to={topCenter(PUBLISH)}
        accent={NEUTRAL}
        curved
        lift={22}
        strokeWidth={1.4}
        className="draw"
        len={155}
        opacity={0.7}
      />

      {/* ── 6. Node boxes ──────────────────────────────────────────────── */}
      {/* GOAL — wire style, entry node */}
      <IsoBox
        x={GOAL.x} y={GOAL.y} z={GOAL.z}
        w={BW} d={BD} h={BH}
        variant="wire"
        accent={NEUTRAL}
        strokeWidth={1.1}
        dash="3 5"
      />
      {/* MID1 — surface, idle */}
      <IsoBox
        x={MID1.x} y={MID1.y} z={MID1.z}
        w={BW} d={BD} h={BH}
        variant="surface"
        strokeWidth={1.1}
      />
      {/* MID2 — glow, the single "running" node (exactly 1) */}
      <IsoBox
        x={MID2.x} y={MID2.y} z={MID2.z}
        w={BW} d={BD} h={BH}
        variant="glow"
        accent={ACCENT}
        strokeWidth={1.4}
        topAlpha={0.28}
      />
      {/* MID3 — surface, idle */}
      <IsoBox
        x={MID3.x} y={MID3.y} z={MID3.z}
        w={BW} d={BD} h={BH}
        variant="surface"
        strokeWidth={1.1}
      />
      {/* PUBLISH — wire, convergence point */}
      <IsoBox
        x={PUBLISH.x} y={PUBLISH.y} z={PUBLISH.z}
        w={BW} d={BD} h={BH}
        variant="wire"
        accent={NEUTRAL}
        strokeWidth={1.1}
        dash="3 5"
      />

      {/* ── 7. Node marker dots (one per node) ─────────────────────────── */}
      {/* GOAL dot — neutral */}
      <IsoDot
        at={topCenter(GOAL)}
        r={3}
        fill={NEUTRAL}
      />
      {/* MID1 dot — neutral */}
      <IsoDot
        at={topCenter(MID1)}
        r={3}
        fill={NEUTRAL}
      />
      {/* MID2 dot — accent with ring (running node) */}
      <IsoDot
        at={topCenter(MID2)}
        r={4}
        fill={ACCENT}
        ring={ACCENT}
      />
      {/* MID3 dot — neutral */}
      <IsoDot
        at={topCenter(MID3)}
        r={3}
        fill={NEUTRAL}
      />
      {/* PUBLISH dot — neutral */}
      <IsoDot
        at={topCenter(PUBLISH)}
        r={3}
        fill={NEUTRAL}
      />

    </IsoScene>
  );
}
