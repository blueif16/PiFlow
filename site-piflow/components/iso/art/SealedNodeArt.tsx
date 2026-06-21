/**
 * SealedNodeArt — isometric illustration of a sealed agent node.
 *
 * Element counts (coverage floor):
 *   ✓ 1  IsoGrid            (faint floor)
 *   ✓ 1  IsoBox wire+dash   (the Seal — dashed wireframe container)
 *   ✓ 1  IsoBox glow        (the Agent — floating inside the Seal, iso-float)
 *   ✓ 1  IsoDot ring        (glow halo under the Agent)
 *   ✓ 4  IsoBox surface/glow (docking tool cubes, outside the Seal)
 *   ✓ 4  IsoDots            (one per tool cube top-center)
 *   ✓ 4  IsoEdge connectors  (tool → Seal face, mix accent / dim)
 *   ✓ 4  IsoPost risers     (grounding each tool to the floor)
 *   Exactly ONE accent hue: #3df2a7
 *
 * viewBox="-198 -62 395 286"  (computed from all point extremes + 24u padding)
 * Scene layout (iso units):  Grid 0..200 × 0..200 at z=0
 *   Seal:  x=54, y=54, z=0,  w=92, d=92, h=92
 *   Agent: x=70, y=70, z=20, w=52, d=52, h=52  ← visibly inside Seal
 *   Tool NW (granted): x=4,  y=4,   z=0, w=28, d=28, h=28
 *   Tool NE (neutral): x=164,y=4,   z=0, w=28, d=28, h=28
 *   Tool SW (neutral): x=4,  y=164, z=0, w=28, d=28, h=28
 *   Tool SE (granted): x=164,y=164, z=0, w=28, d=28, h=28
 */

import {
  IsoScene,
  IsoBox,
  IsoGrid,
  IsoEdge,
  IsoDot,
  IsoPost,
} from "@/components/iso/iso";

const ACCENT = "#3df2a7";
const DIM = "rgba(255,255,255,0.22)";

export default function SealedNodeArt({ className }: { className?: string }) {
  return (
    <IsoScene viewBox="-198 -62 395 286" className={className}>
      {/* ── Floor grid ─────────────────────────────────────────── */}
      <IsoGrid x={0} y={0} z={0} w={200} d={200} step={24} />

      {/* ── Tool-to-Seal connectors (behind everything) ─────────
          NW granted  → Seal NW corner
          NE neutral  → Seal NE face corner
          SW neutral  → Seal SW face corner
          SE granted  → Seal SE corner                           */}

      {/* NW granted tool → Seal (accent, curved) */}
      <IsoEdge
        from={[18, 18, 28]}
        to={[54, 54, 0]}
        accent={ACCENT}
        curved
        lift={20}
        strokeWidth={1.2}
        dash="4 3"
        opacity={0.75}
        className="draw"
        len={120}
      />

      {/* NE neutral tool → Seal (dim, straight) */}
      <IsoEdge
        from={[178, 18, 28]}
        to={[146, 54, 0]}
        accent={DIM}
        strokeWidth={1.0}
        dash="3 4"
        opacity={0.45}
      />

      {/* SW neutral tool → Seal (dim, straight) */}
      <IsoEdge
        from={[18, 178, 28]}
        to={[54, 146, 0]}
        accent={DIM}
        strokeWidth={1.0}
        dash="3 4"
        opacity={0.45}
      />

      {/* SE granted tool → Seal (accent, curved) */}
      <IsoEdge
        from={[178, 178, 28]}
        to={[146, 146, 0]}
        accent={ACCENT}
        curved
        lift={16}
        strokeWidth={1.2}
        dash="4 3"
        opacity={0.75}
        className="draw"
        len={120}
      />

      {/* ── IsoPost risers: ground each tool cube ───────────────── */}
      <IsoPost x={18} y={18} z0={0} z1={4}  accent={ACCENT} strokeWidth={1} />
      <IsoPost x={178} y={18} z0={0} z1={4} accent={DIM}    strokeWidth={1} dash="2 4" />
      <IsoPost x={18} y={178} z0={0} z1={4} accent={DIM}    strokeWidth={1} dash="2 4" />
      <IsoPost x={178} y={178} z0={0} z1={4} accent={ACCENT} strokeWidth={1} />

      {/* ── Docking tool cubes ─────────────────────────────────── */}

      {/* NW — GRANTED (glow, accent) */}
      <IsoBox
        x={4} y={4} z={0}
        w={28} d={28} h={28}
        variant="glow"
        accent={ACCENT}
        strokeWidth={1.1}
      />
      <IsoDot at={[18, 18, 28]} r={2.5} fill={ACCENT} ring={ACCENT} />

      {/* NE — ungranted (surface, dim) */}
      <IsoBox
        x={164} y={4} z={0}
        w={28} d={28} h={28}
        variant="surface"
        strokeWidth={1.1}
      />
      <IsoDot at={[178, 18, 28]} r={2.5} fill={DIM} />

      {/* SW — ungranted (surface, dim) */}
      <IsoBox
        x={4} y={164} z={0}
        w={28} d={28} h={28}
        variant="surface"
        strokeWidth={1.1}
      />
      <IsoDot at={[18, 178, 28]} r={2.5} fill={DIM} />

      {/* SE — GRANTED (glow, accent) */}
      <IsoBox
        x={164} y={164} z={0}
        w={28} d={28} h={28}
        variant="glow"
        accent={ACCENT}
        strokeWidth={1.1}
      />
      <IsoDot at={[178, 178, 28]} r={2.5} fill={ACCENT} ring={ACCENT} />

      {/* ── THE SEAL — dashed wireframe container ───────────────── */}
      <IsoBox
        x={54} y={54} z={0}
        w={92} d={92} h={92}
        variant="wire"
        stroke="rgba(255,255,255,0.28)"
        strokeWidth={1.1}
        dash="3 4"
      />

      {/* ── THE AGENT — glowing cube floating inside the Seal ───── */}
      {/* Ring glow halo at agent floor level */}
      <IsoDot
        at={[96, 96, 20]}
        r={18}
        fill="none"
        ring={ACCENT}
      />

      {/* Floating inner agent cube — iso-float bobs it gently */}
      <g className="iso-float">
        <IsoBox
          x={70} y={70} z={22}
          w={52} d={52} h={52}
          variant="glow"
          accent={ACCENT}
          topAlpha={0.28}
          strokeWidth={1.3}
        />
        {/* Dot cap on agent top face center */}
        <IsoDot
          at={[96, 96, 74]}
          r={3}
          fill={ACCENT}
          ring={ACCENT}
        />
      </g>
    </IsoScene>
  );
}
