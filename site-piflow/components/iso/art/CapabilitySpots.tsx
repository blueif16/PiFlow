/**
 * CapabilitySpots — 7 bespoke isometric spot-illustrations, icon-scale.
 * RSC/server-safe: no "use client", no hooks, no browser APIs.
 *
 * Kind summary (element counts / viewBox):
 *   "improve"  — 2 wire + 1 glow cube, 1 curved flow edge looping back            vB="-52 -28 130 100"
 *   "design"   — 1 source surface + 1 glow + 2 wire cubes, 3 curved fan edges      vB="-58 -32 132 110"
 *   "bind"     — 1 glow focal + 3 surface cubes, 3 short edges + 3 posts           vB="-52 -18 120 100"
 *   "seal"     — 1 dashed wire container + 1 glow cube (iso-float) inside          vB="-48 -30 118 104"
 *   "parallel" — 3 equal cubes in a row, middle glow, slight y-stagger             vB="-72 -18 150  88"
 *   "verify"   — 1 glow cube + 2 IsoEdge tick mark above it                        vB="-36 -38  98  96"
 *   "horizon"  — 4 diminishing cubes along y, nearest glow, flow edge              vB="-36 -18 116  96"
 */

import {
  IsoScene,
  IsoBox,
  IsoPlane,
  IsoEdge,
  IsoDot,
  IsoPost,
} from "@/components/iso/iso";

export type Kind =
  | "improve"
  | "design"
  | "bind"
  | "seal"
  | "parallel"
  | "verify"
  | "horizon";

// ─── Palette ────────────────────────────────────────────────────────────────
const ACCENT = "#3df2a7";
const DIM    = "rgba(255,255,255,0.22)";
const WIRE   = "rgba(255,255,255,0.18)";

// ─── Individual scenes ───────────────────────────────────────────────────────

/**
 * "improve" — a LOOP: two wire cubes bookend a glow cube; a curved IsoEdge
 * arcs all the way back (flow) to signal the improvement cycle.
 *
 * Cubes at x=0, x=24, x=48 along x-axis, y=16, z=0, size 14×14×14.
 * Projected extremes (cos30≈0.866, sin30=0.5):
 *   left-most sx: (0-16)*0.866 ≈ -13.9  →  pad to -52 (loop arc control dips further)
 *   right-most sx: (48+14-16)*0.866 ≈ 40
 *   top sy (arc lift=32 above midpoint): midpoint (x=24,y=16) → sx=6.93, sy=(24+16)*0.5-14=6; arc cy = 6-32 = -26 → pad to -28
 *   bottom sy: (14+16)*0.5-0 = 15 → pad to ~72
 * viewBox: "-52 -28 130 100"
 */
function SceneImprove({ className }: { className?: string }) {
  return (
    <IsoScene viewBox="-52 -28 130 100" className={className}>
      {/* Faint ground plane hint */}
      <IsoPlane x={-2} y={12} z={0} w={54} d={10} fillAlpha={0.04} stroke="none" />

      {/* Left wire cube */}
      <IsoBox x={0} y={14} z={0} w={14} d={14} h={14}
        variant="wire" accent={WIRE} strokeWidth={1.1} dash="3 4" />

      {/* Right wire cube */}
      <IsoBox x={42} y={14} z={0} w={14} d={14} h={14}
        variant="wire" accent={WIRE} strokeWidth={1.1} dash="3 4" />

      {/* Centre glow cube — the focal element */}
      <IsoBox x={21} y={14} z={0} w={14} d={14} h={14}
        variant="glow" accent={ACCENT} strokeWidth={1.6} />

      {/* Forward flow edge: left → centre */}
      <IsoEdge
        from={[14, 21, 14]} to={[21, 21, 14]}
        accent={ACCENT} curved lift={10}
        strokeWidth={1.5} dash="5 8" className="flow" len={80}
      />

      {/* Forward flow edge: centre → right */}
      <IsoEdge
        from={[35, 21, 14]} to={[42, 21, 14]}
        accent={ACCENT} curved lift={10}
        strokeWidth={1.5} dash="5 8" className="flow" len={80}
      />

      {/* Loop-back arc: right → left (curved, flow, accent) */}
      <IsoEdge
        from={[56, 21, 14]} to={[0, 21, 14]}
        accent={ACCENT} curved lift={32}
        strokeWidth={1.7} dash="6 10" opacity={0.80}
        className="flow" len={200}
      />

      {/* Dots at cube tops */}
      <IsoDot at={[7,  21, 14]} r={2} fill={WIRE} />
      <IsoDot at={[28, 21, 14]} r={2.5} fill={ACCENT} ring={ACCENT} />
      <IsoDot at={[49, 21, 14]} r={2} fill={WIRE} />
    </IsoScene>
  );
}

/**
 * "design" — a FAN: 1 source surface cube at top; 3 fan-out curved edges
 * lead to 2 wire cubes and 1 glow cube (the goal).
 *
 * Source: x=20, y=4, z=0, size 14×14×12
 * Targets spread along y: (4,28,0), (20,28,0), (36,28,0) — size 12×12×12
 * Glow: middle target x=20, y=28.
 * Projected extremes:
 *   sx range: (4-28)*0.866=-20.8 .. (36+12-4)*0.866=38.5
 *   sy top: (20+4)*0.5-12 = 0 → pad to -32 for arc lifts
 *   sy bottom: (36+28+12)*0.5 = 38 → pad +12 = 50
 * viewBox: "-58 -32 132 110"
 */
function SceneDesign({ className }: { className?: string }) {
  return (
    <IsoScene viewBox="-58 -32 132 110" className={className}>
      {/* Source cube (surface) — origin of design */}
      <IsoBox x={16} y={4} z={0} w={14} d={14} h={12}
        variant="surface" strokeWidth={1.2} />
      <IsoDot at={[23, 11, 12]} r={2.5} fill={DIM} />

      {/* Fan edges: source top-front → each target */}
      {/* Left target edge */}
      <IsoEdge
        from={[23, 18, 12]} to={[10, 34, 0]}
        accent={ACCENT} curved lift={14}
        strokeWidth={1.4} dash="4 7" opacity={0.65} className="flow" len={120}
      />
      {/* Centre edge (to glow target) — brighter */}
      <IsoEdge
        from={[23, 18, 12]} to={[26, 34, 0]}
        accent={ACCENT} curved lift={12}
        strokeWidth={1.6} dash="5 7" className="flow" len={120}
      />
      {/* Right target edge */}
      <IsoEdge
        from={[23, 18, 12]} to={[42, 34, 0]}
        accent={ACCENT} curved lift={14}
        strokeWidth={1.4} dash="4 7" opacity={0.65} className="flow" len={120}
      />

      {/* Left wire target */}
      <IsoBox x={4}  y={28} z={0} w={12} d={12} h={12}
        variant="wire" accent={WIRE} strokeWidth={1.1} dash="3 4" />

      {/* Centre GLOW target — the goal */}
      <g className="iso-float">
        <IsoBox x={20} y={28} z={0} w={12} d={12} h={12}
          variant="glow" accent={ACCENT} strokeWidth={1.6} />
        <IsoDot at={[26, 34, 12]} r={2.5} fill={ACCENT} ring={ACCENT} />
      </g>

      {/* Right wire target */}
      <IsoBox x={36} y={28} z={0} w={12} d={12} h={12}
        variant="wire" accent={WIRE} strokeWidth={1.1} dash="3 4" />
    </IsoScene>
  );
}

/**
 * "bind" — central GLOW cube; 3 surface cubes dock in from three sides
 * via short edges and vertical posts.
 *
 * Centre glow: x=18, y=18, z=0, size 16×16×16
 * Satellite cubes at radius ~22 iso-units:
 *   A: x=0,  y=0,  z=0, size 10×10×10  (NW)
 *   B: x=38, y=4,  z=0, size 10×10×10  (NE)
 *   C: x=4,  y=38, z=0, size 10×10×10  (SW)
 * Projected extremes:
 *   sx: (0-0)*0.866=0 .. (38+10-4)*0.866=38.2  → neg via (0-38-10)=-41.6 → -52
 *   sy: min at (0+0)*0.5-10=-10 → -18; max at (4+38+10)*0.5=26 → +10 = 36
 * viewBox: "-52 -18 120 100"
 */
function SceneBind({ className }: { className?: string }) {
  return (
    <IsoScene viewBox="-52 -18 120 100" className={className}>
      {/* Posts grounding satellite cubes */}
      <IsoPost x={5}  y={5}  z0={0} z1={4} accent={WIRE} strokeWidth={1} />
      <IsoPost x={43} y={9}  z0={0} z1={4} accent={WIRE} strokeWidth={1} />
      <IsoPost x={9}  y={43} z0={0} z1={4} accent={WIRE} strokeWidth={1} />

      {/* Satellite A — NW */}
      <IsoBox x={0}  y={0}  z={0} w={10} d={10} h={10}
        variant="surface" strokeWidth={1.1} />

      {/* Satellite B — NE */}
      <IsoBox x={38} y={4}  z={0} w={10} d={10} h={10}
        variant="surface" strokeWidth={1.1} />

      {/* Satellite C — SW */}
      <IsoBox x={4}  y={38} z={0} w={10} d={10} h={10}
        variant="surface" strokeWidth={1.1} />

      {/* Docking edges: satellite → central glow face */}
      <IsoEdge from={[5,  5,  10]} to={[18, 18, 8]}
        accent={ACCENT} curved lift={8}
        strokeWidth={1.4} dash="4 5" opacity={0.70} className="flow" len={100}
      />
      <IsoEdge from={[43, 9,  10]} to={[34, 18, 8]}
        accent={ACCENT} curved lift={8}
        strokeWidth={1.4} dash="4 5" opacity={0.70} className="flow" len={100}
      />
      <IsoEdge from={[9,  43, 10]} to={[18, 34, 8]}
        accent={ACCENT} curved lift={8}
        strokeWidth={1.4} dash="4 5" opacity={0.70} className="flow" len={100}
      />

      {/* Central GLOW cube — the bind focal */}
      <IsoBox x={18} y={18} z={0} w={16} d={16} h={16}
        variant="glow" accent={ACCENT} strokeWidth={1.6} />

      {/* Dots at satellite tops */}
      <IsoDot at={[5,  5,  10]} r={2} fill={DIM} />
      <IsoDot at={[43, 9,  10]} r={2} fill={DIM} />
      <IsoDot at={[9,  43, 10]} r={2} fill={DIM} />
    </IsoScene>
  );
}

/**
 * "seal" — a DASHED WIRE container cube with a small glow cube floating
 * inside it (iso-float). The container is the seal; the glow is the node.
 *
 * Container: x=4, y=4, z=0, size 36×36×36, wire dash
 * Inner glow: x=14, y=14, z=10, size 16×16×16, iso-float
 * Projected extremes (container):
 *   sx: (4-4)*0.866=0 .. negative: (4-40)*0.866=-31.2  → -48
 *   sx right: (40-4)*0.866=31.2
 *   sy top: (4+4)*0.5-36=-32 → -30 pad
 *   sy bottom: (40+40)*0.5=40 → pad +12 = 74
 * viewBox: "-48 -30 118 104"
 */
function SceneSeal({ className }: { className?: string }) {
  return (
    <IsoScene viewBox="-48 -30 118 104" className={className}>
      {/* Outer SEAL — dashed wire container */}
      <IsoBox x={4} y={4} z={0} w={36} d={36} h={36}
        variant="wire"
        stroke="rgba(255,255,255,0.28)"
        strokeWidth={1.2}
        dash="3 4"
      />

      {/* Subtle glow plane under inner cube */}
      <IsoPlane x={12} y={12} z={10} w={20} d={20}
        fillAlpha={0.08} stroke="none" />

      {/* Inner GLOW cube — floating (iso-float bobs it) */}
      <g className="iso-float">
        <IsoBox x={14} y={14} z={10} w={16} d={16} h={16}
          variant="glow" accent={ACCENT} strokeWidth={1.6} />
        <IsoDot at={[22, 22, 26]} r={2.5} fill={ACCENT} ring={ACCENT} />
      </g>
    </IsoScene>
  );
}

/**
 * "parallel" — 3 EQUAL cubes in a row along x-axis, same z=0,
 * slight y-stagger for readability. Middle cube is glow.
 *
 * A: x=0,  y=18, size 14×14×18
 * B: x=18, y=14, size 14×14×18 ← GLOW
 * C: x=36, y=18, size 14×14×18
 * Projected extremes:
 *   sx negative: (0-18-14)*0.866 ≈ -27.8 → -72 (with iso-float bob margin)
 *   sx right: (50-14)*0.866 ≈ 31.2
 *   sy top: (18+0)*0.5-18=-9 → -18 pad
 *   sy bot: (36+18+14)*0.5=34 → +12 = 46
 * viewBox: "-72 -18 150 88"
 */
function SceneParallel({ className }: { className?: string }) {
  return (
    <IsoScene viewBox="-72 -18 150 88" className={className}>
      {/* Faint ground plane */}
      <IsoPlane x={-2} y={12} z={0} w={54} d={10} fillAlpha={0.04} stroke="none" />

      {/* Left surface cube */}
      <IsoBox x={0}  y={18} z={0} w={14} d={14} h={18}
        variant="surface" strokeWidth={1.2} />

      {/* Middle GLOW cube — focal, slightly taller to dominate */}
      <IsoBox x={18} y={14} z={0} w={14} d={14} h={20}
        variant="glow" accent={ACCENT} strokeWidth={1.6} />

      {/* Right surface cube */}
      <IsoBox x={36} y={18} z={0} w={14} d={14} h={18}
        variant="surface" strokeWidth={1.2} />

      {/* Horizontal alignment edges (faint, straight) */}
      <IsoEdge
        from={[14, 21, 18]} to={[18, 21, 18]}
        accent={ACCENT} strokeWidth={1.0} opacity={0.45}
      />
      <IsoEdge
        from={[32, 21, 18]} to={[36, 21, 18]}
        accent={ACCENT} strokeWidth={1.0} opacity={0.45}
      />

      {/* Dots at cube tops — centre of each */}
      <IsoDot at={[7,  25, 18]} r={2}   fill={DIM} />
      <IsoDot at={[25, 21, 20]} r={2.5} fill={ACCENT} ring={ACCENT} />
      <IsoDot at={[43, 25, 18]} r={2}   fill={DIM} />
    </IsoScene>
  );
}

/**
 * "verify" — a GLOW cube with a bold accent "check / tick" drawn via two
 * IsoEdges above/beside it. The tick forms a classic ✓ shape in iso-space.
 *
 * Glow cube: x=10, y=10, z=0, size 16×16×16
 * Tick: two edges in iso-3D above the cube (z≈22..30):
 *   Downstroke: [14,4,30] → [18,12,22]   (short down-left segment)
 *   Upstroke:   [18,12,22] → [30,2,34]   (long up-right sweep)
 * Projected extremes:
 *   sx neg: (10-26)*0.866 ≈ -13.9 → -36
 *   sx pos: (30-2)*0.866 ≈ 24.2
 *   sy top: tick up-stroke top: (30+2)*0.5-34=-18 → -38 pad
 *   sy bot: (26+26)*0.5-0=26 → +12=38
 * viewBox: "-36 -38 98 96"
 */
function SceneVerify({ className }: { className?: string }) {
  return (
    <IsoScene viewBox="-36 -38 98 96" className={className}>
      {/* Faint post grounding */}
      <IsoPost x={18} y={18} z0={0} z1={4} accent={WIRE} strokeWidth={1} />

      {/* GLOW cube — the verified node */}
      <IsoBox x={10} y={10} z={0} w={16} d={16} h={16}
        variant="glow" accent={ACCENT} strokeWidth={1.6} />

      {/* Tick mark — downstroke (short, thin) */}
      <IsoEdge
        from={[14, 4,  30]} to={[18, 12, 22]}
        accent={ACCENT} strokeWidth={2.2} opacity={0.9}
      />

      {/* Tick mark — upstroke (long, bolder) */}
      <IsoEdge
        from={[18, 12, 22]} to={[30, 2, 34]}
        accent={ACCENT} strokeWidth={2.2} opacity={0.9}
      />

      {/* Dot at cube top centre */}
      <IsoDot at={[18, 18, 16]} r={2.5} fill={ACCENT} ring={ACCENT} />
    </IsoScene>
  );
}

/**
 * "horizon" — a RECEDING ROW of 4 cubes diminishing along the y-axis
 * (each further/smaller), the nearest (lowest y) is glow.
 * A flow edge runs along the chain hinting at progress toward the horizon.
 *
 * Cubes at x=16, varying y (near→far) with decreasing h:
 *   Cube A: y=0,  h=18  ← GLOW (nearest)
 *   Cube B: y=18, h=14  surface
 *   Cube C: y=34, h=10  surface
 *   Cube D: y=48, h=7   wire (faintest, farthest)
 * All x=16, z=0, w/d shrink: 14,12,10,8
 * Projected extremes:
 *   sx neg: (16-0-14)*0.866 ≈ 1.7 .. negative via y: (16-56-8)*0.866=-41.6 → -36
 *   sx pos: (30-0)*0.866 ≈ 26  (near cube right face)
 *   sy top: (16+0)*0.5-18=-10 → -18
 *   sy bot: (24+56)*0.5=40 → pad +12=52
 * viewBox: "-36 -18 116 96"
 */
function SceneHorizon({ className }: { className?: string }) {
  return (
    <IsoScene viewBox="-36 -18 116 96" className={className}>
      {/* Receding ground hint */}
      <IsoPlane x={14} y={-2} z={0} w={2} d={60} fillAlpha={0.04} stroke={WIRE} strokeWidth={0.8} />

      {/* Flow edge connecting all cubes (curved, horizon accent) */}
      <IsoEdge
        from={[23, 7,  18]} to={[22, 25, 14]}
        accent={ACCENT} curved lift={10}
        strokeWidth={1.4} dash="5 7" opacity={0.80} className="flow" len={120}
      />
      <IsoEdge
        from={[22, 25, 14]} to={[21, 41, 10]}
        accent={ACCENT} curved lift={8}
        strokeWidth={1.2} dash="5 8" opacity={0.60} className="flow" len={100}
      />
      <IsoEdge
        from={[21, 41, 10]} to={[20, 54, 7]}
        accent={ACCENT} curved lift={6}
        strokeWidth={1.0} dash="5 9" opacity={0.40} className="flow" len={80}
      />

      {/* Cube D — farthest, smallest, faint wire */}
      <IsoBox x={16} y={48} z={0} w={8}  d={8}  h={7}
        variant="wire" accent={WIRE} strokeWidth={0.9} dash="3 5" />

      {/* Cube C — mid-far, surface */}
      <IsoBox x={15} y={34} z={0} w={10} d={10} h={10}
        variant="surface" strokeWidth={1.0} />

      {/* Cube B — mid-near, surface */}
      <IsoBox x={14} y={18} z={0} w={12} d={12} h={14}
        variant="surface" strokeWidth={1.1} />

      {/* Cube A — NEAREST, glow focal */}
      <IsoBox x={16} y={0}  z={0} w={14} d={14} h={18}
        variant="glow" accent={ACCENT} strokeWidth={1.6} />

      {/* Dots: near cubes only */}
      <IsoDot at={[23, 7,  18]} r={2.5} fill={ACCENT} ring={ACCENT} />
      <IsoDot at={[21, 24, 14]} r={2}   fill={DIM} />
      <IsoDot at={[20, 39, 10]} r={1.5} fill={DIM} />
    </IsoScene>
  );
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export default function CapabilitySpot({
  kind,
  className,
}: {
  kind: Kind;
  className?: string;
}) {
  switch (kind) {
    case "improve":  return <SceneImprove  className={className} />;
    case "design":   return <SceneDesign   className={className} />;
    case "bind":     return <SceneBind     className={className} />;
    case "seal":     return <SceneSeal     className={className} />;
    case "parallel": return <SceneParallel className={className} />;
    case "verify":   return <SceneVerify   className={className} />;
    case "horizon":  return <SceneHorizon  className={className} />;
  }
}
