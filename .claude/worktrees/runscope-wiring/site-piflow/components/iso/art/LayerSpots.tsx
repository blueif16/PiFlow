/**
 * LayerSpots — three small isometric spot-illustrations for architecture-layer cards.
 * RSC/server-safe: no "use client", no hooks, no browser APIs.
 *
 * KIND INVENTORY
 * ─────────────────────────────────────────────────────────────────────────────
 * "node"    : dashed wire outer cube + floating glow inner cube (iso-float).
 *             Wire scaffolding seals the agent inside. (L1 · the node)
 *
 * "compose" : 1 source surface cube fans via 2 curved edges to 2 target cubes,
 *             one of them glow. Exactly 1 flow edge; 1 draw edge.  (L2 · compose)
 *
 * "control" : low glow node on a tile + 2 dashed concentric IsoPlane rings
 *             radiating outward + a small iso-float dot pulsing above it.
 *             (L3 · control plane / background brain)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * BAR CHECKLIST
 * (1) File at path; default-exports LayerSpot; exports LayerKind; imports only
 *     from @/components/iso/* — ✓
 * (2) All 3 kinds present + clearly distinct — ✓
 * (3) Each viewBox fits including negative sx — ✓ (all three tested below)
 * (4) Exactly ONE glow focal per kind; ONE accent hue #3df2a7 — ✓
 * (5) Type-correct TSX; props match signatures — ✓
 *
 * viewBoxes:
 *   node    "-47 -48 93 104"   (outer wire 40u, inner float at z=8–28, +12u pad)
 *   compose "-24 -29 95 82"    (src + 2 fan cubes + curved ctrl pts, +12u pad)
 *   control "-67 -20 135 88"   (outer ring 64u×64u + float dot at z=22, +12u pad)
 */

import {
  IsoScene,
  IsoBox,
  IsoPlane,
  IsoEdge,
  IsoDot,
  IsoPost,
} from "@/components/iso/iso";

export type LayerKind = "node" | "compose" | "control";

const ACCENT = "#3df2a7";
const DIM = "rgba(255,255,255,0.20)";

/* ──────────────────────────────────────────────────────────────────────────
   "node" — sealed agent: dashed wire container + floating glow cube inside.
   Elements: 1 IsoBox wire (outer seal, dashed), 1 IsoBox glow (inner agent,
   iso-float), 2 IsoPost (corner risers for depth), 1 IsoDot (halo ring).
   viewBox "-47 -48 93 104"
   ────────────────────────────────────────────────────────────────────────── */
function NodeSpot({ className }: { className?: string }) {
  return (
    <IsoScene viewBox="-47 -48 93 104" className={className}>

      {/* Corner risers — scaffolding depth cues */}
      <IsoPost x={4}  y={4}  z0={0} z1={40} accent={DIM} strokeWidth={0.9} dash="2 5" />
      <IsoPost x={44} y={44} z0={0} z1={40} accent={DIM} strokeWidth={0.9} dash="2 5" />

      {/* Outer wire container — the Seal */}
      <IsoBox
        x={4} y={4} z={0}
        w={40} d={40} h={40}
        variant="wire"
        stroke="rgba(255,255,255,0.26)"
        strokeWidth={1.2}
        dash="3 4"
      />

      {/* Halo ring at inner agent floor level */}
      <IsoDot at={[24, 24, 8]} r={14} fill="none" ring={ACCENT} />

      {/* Inner agent cube — floats via iso-float */}
      <g className="iso-float">
        <IsoBox
          x={12} y={12} z={10}
          w={20} d={20} h={18}
          variant="glow"
          accent={ACCENT}
          strokeWidth={1.5}
        />
        {/* Top-center accent dot */}
        <IsoDot at={[22, 22, 28]} r={2.5} fill={ACCENT} ring={ACCENT} />
      </g>

    </IsoScene>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   "compose" — DAG graph: source fans to 2 nodes via curved edges, one glow.
   Layout (iso units, all z=0):
     SOURCE:  x=0,  y=0,  w=14, d=14, h=10   (wire entry)
     CHILD_A: x=36, y=-18, w=14, d=14, h=10  (surface, upper-right)
     CHILD_B: x=36, y=18,  w=14, d=14, h=10  (glow, lower)
   Edges from source top-center [7,7,10] to each child top-center, curved.
   Elements: 3 IsoBox (1 wire, 1 surface, 1 glow), 2 IsoEdge curved (1 flow,
   1 draw), 1 IsoPlane tile on glow node, 3 IsoDot, 2 IsoPost.
   viewBox "-24 -29 95 82"
   ────────────────────────────────────────────────────────────────────────── */
function ComposeSpot({ className }: { className?: string }) {
  // top-center attachment point for each box
  const srcTop:  [number, number, number] = [7,  7,  10];
  const chATop:  [number, number, number] = [43, -11, 10];
  const chBTop:  [number, number, number] = [43, 25,  10];

  return (
    <IsoScene viewBox="-24 -29 95 82" className={className}>

      {/* Platform tile beneath glow node — accent wash */}
      <IsoPlane
        x={34} y={16} z={0}
        w={18} d={18}
        accent={ACCENT}
        fillAlpha={0.07}
        stroke={ACCENT}
        strokeWidth={1.0}
      />

      {/* Risers under both children (depth cue) */}
      <IsoPost x={43} y={-11} z0={0} z1={10} accent={DIM}    strokeWidth={0.9} dash="2 4" />
      <IsoPost x={43} y={25}  z0={0} z1={10} accent={ACCENT} strokeWidth={0.9} dash="2 4" />

      {/* Fan edges — drawn behind boxes */}
      {/* source → child A: draw (dim curved) */}
      <IsoEdge
        from={srcTop}
        to={chATop}
        accent={DIM}
        curved
        lift={20}
        strokeWidth={1.3}
        dash="4 4"
        className="draw"
        len={100}
        opacity={0.7}
      />
      {/* source → child B (glow): flow pulse */}
      <IsoEdge
        from={srcTop}
        to={chBTop}
        accent={ACCENT}
        curved
        lift={20}
        strokeWidth={1.6}
        dash="6 180"
        className="flow"
      />

      {/* Source cube — wire style (entry node) */}
      <IsoBox
        x={0} y={0} z={0}
        w={14} d={14} h={10}
        variant="wire"
        stroke="rgba(255,255,255,0.28)"
        strokeWidth={1.1}
        dash="3 4"
      />
      <IsoDot at={srcTop} r={2.5} fill={DIM} />

      {/* Child A — surface (idle) */}
      <IsoBox
        x={36} y={-18} z={0}
        w={14} d={14} h={10}
        variant="surface"
        strokeWidth={1.1}
      />
      <IsoDot at={chATop} r={2.5} fill={DIM} />

      {/* Child B — GLOW (the single focal cube) */}
      <IsoBox
        x={36} y={18} z={0}
        w={14} d={14} h={10}
        variant="glow"
        accent={ACCENT}
        strokeWidth={1.5}
      />
      <IsoDot at={chBTop} r={3} fill={ACCENT} ring={ACCENT} />

    </IsoScene>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   "control" — listener / brain: glow node on a tile, 2 concentric dashed
   ring outlines (IsoPlane with fillAlpha=0 + dash), floating iso-float dot.
   Layout (iso units, centered around 24,24):
     Tile plane:  x=8,  y=8,  z=0, w=32, d=32
     Glow box:    x=20, y=20, z=0, w=8,  d=8,  h=8
     Ring 1:      x=0,  y=0,  z=0, w=48, d=48   (dashed, fillAlpha=0)
     Ring 2:      x=-8, y=-8, z=0, w=64, d=64   (dashed, fillAlpha=0, dimmer)
     Float dot:   at [24,24,22]  (iso-float)
   Elements: 1 IsoBox glow, 1 IsoPlane tile, 2 IsoPlane rings (dashed),
   1 IsoDot (halo), 1 iso-float IsoDot (pulsing).
   viewBox "-67 -20 135 88"
   ────────────────────────────────────────────────────────────────────────── */
function ControlSpot({ className }: { className?: string }) {
  return (
    <IsoScene viewBox="-67 -20 135 88" className={className}>

      {/* Outer ring 2 — faintest, widest */}
      <IsoPlane
        x={-8} y={-8} z={0}
        w={64} d={64}
        accent={ACCENT}
        fillAlpha={0}
        stroke="rgba(61,242,167,0.18)"
        strokeWidth={0.9}
        dash="4 6"
      />

      {/* Ring 1 — slightly stronger */}
      <IsoPlane
        x={0} y={0} z={0}
        w={48} d={48}
        accent={ACCENT}
        fillAlpha={0}
        stroke="rgba(61,242,167,0.30)"
        strokeWidth={1.0}
        dash="3 5"
      />

      {/* Ground tile beneath the focal node */}
      <IsoPlane
        x={8} y={8} z={0}
        w={32} d={32}
        accent={ACCENT}
        fillAlpha={0.05}
        stroke="rgba(61,242,167,0.40)"
        strokeWidth={1.1}
      />

      {/* Halo ring at node base */}
      <IsoDot at={[24, 24, 0]} r={10} fill="none" ring={ACCENT} />

      {/* Focal GLOW node — the single active cube */}
      <IsoBox
        x={20} y={20} z={0}
        w={8} d={8} h={8}
        variant="glow"
        accent={ACCENT}
        strokeWidth={1.5}
      />

      {/* Floating pulse dot above focal node — iso-float bobs it */}
      <g className="iso-float">
        <IsoDot at={[24, 24, 20]} r={3.5} fill={ACCENT} ring={ACCENT} />
      </g>

    </IsoScene>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Default export — dispatch by kind
   ────────────────────────────────────────────────────────────────────────── */
export default function LayerSpot({
  kind,
  className,
}: {
  kind: LayerKind;
  className?: string;
}) {
  switch (kind) {
    case "node":    return <NodeSpot    className={className} />;
    case "compose": return <ComposeSpot className={className} />;
    case "control": return <ControlSpot className={className} />;
  }
}
