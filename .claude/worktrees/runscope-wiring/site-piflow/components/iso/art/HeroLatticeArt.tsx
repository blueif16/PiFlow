/* ================================================================
   HeroLatticeArt — Isometric exploded-lattice hero illustration.

   Coverage:
     Cubes : 11 total (8 wire, 3 glow)        [spec ≥7]
     Posts : 5 IsoPost risers                  [spec ≥4]
     Dots  : 5 IsoDot w/ rings                 [spec ≥4]
     Grid  : 1 IsoGrid floor                   [spec 1]
     Edges : 1 accent IsoEdge (flow class)     [spec 1]
     Float : <g className="iso-float-slow">    [spec ✓]

   Paint order: back→front (highest iso-y first, then iso-x, then z).
   Exploded cube pulled diagonally away from the 2×2 core.
   viewBox computed to include all cubes + grid + 28px padding:
     "-251 -183 489 392"
   ================================================================ */
import {
  IsoScene,
  IsoBox,
  IsoGrid,
  IsoPost,
  IsoDot,
  IsoEdge,
} from "@/components/iso/iso";

const ACCENT = "#3df2a7";
const S = 46;   // cube size (w = d = h = S)
const Z0 = 40;  // base float height above grid

/* Lattice cube definitions — listed in back-to-front paint order.
   Painter's rule: higher iso-y (further "back" in screen) drawn first.
   Within same depth, higher iso-x (further right) drawn before left. */
const CUBES = [
  // ── Layer 1 (z = Z0) ──────────────────────────────────────────
  // Back-right: furthest back, drawn first
  { x: S,        y: S,        z: Z0,          variant: "wire" as const, dash: undefined,  strokeWidth: 0.9  },
  // Exploded cube — pulled diagonally off the back-right corner
  { x: S + 28,   y: S + 28,   z: Z0 + S,      variant: "wire" as const, dash: "3 4",      strokeWidth: 0.85 },
  // Back-left
  { x: 0,        y: S,        z: Z0,          variant: "wire" as const, dash: "3 4",      strokeWidth: 0.9  },
  // Front-right
  { x: S,        y: 0,        z: Z0,          variant: "wire" as const, dash: undefined,  strokeWidth: 0.9  },
  // Front-left BASE — glow (1/3)
  { x: 0,        y: 0,        z: Z0,          variant: "glow" as const, dash: undefined,  strokeWidth: 1.1  },

  // ── Layer 2 (z = Z0 + S) ─────────────────────────────────────
  // Back-right mid — glow (2/3)
  { x: S,        y: S,        z: Z0 + S,      variant: "glow" as const, dash: undefined,  strokeWidth: 1.1  },
  // Back-left mid — dashed wire
  { x: 0,        y: S,        z: Z0 + S,      variant: "wire" as const, dash: "3 4",      strokeWidth: 0.85 },
  // Front-right mid — solid wire
  { x: S,        y: 0,        z: Z0 + S,      variant: "wire" as const, dash: undefined,  strokeWidth: 0.9  },
  // Extra side wing (extends footprint leftward, dashed wire)
  { x: -S,       y: 0,        z: Z0,          variant: "wire" as const, dash: "3 4",      strokeWidth: 0.8  },
  // Front-left mid — dashed wire
  { x: 0,        y: 0,        z: Z0 + S,      variant: "wire" as const, dash: "3 4",      strokeWidth: 0.85 },

  // ── Layer 3 (z = Z0 + 2S) — peak glow cap ───────────────────
  // Top cap — glow (3/3)
  { x: S,        y: 0,        z: Z0 + S * 2,  variant: "glow" as const, dash: undefined,  strokeWidth: 1.2  },
] as const;

export default function HeroLatticeArt({ className }: { className?: string }) {
  return (
    <IsoScene viewBox="-251 -183 489 392" className={className}>

      {/* ── 1. Floor grid (static, behind everything) ─────────── */}
      <IsoGrid
        x={-S - 44}
        y={-36}
        z={0}
        w={S * 3 + 128}
        d={S * 2 + 88}
        step={S}
        color="rgba(255,255,255,0.04)"
        strokeWidth={0.9}
      />

      {/* ── 2. Floor layer: posts + node-dots (outside float group)
              Drawn before the lattice so risers appear to anchor it. ── */}

      {/* Posts — thin dashed risers from floor (z=0) up to lattice base */}
      <IsoPost x={0}      y={0}      z0={0} z1={Z0}      accent={ACCENT} strokeWidth={0.9} />
      <IsoPost x={S * 2}  y={0}      z0={0} z1={Z0}      accent={ACCENT} strokeWidth={0.9} />
      <IsoPost x={0}      y={S * 2}  z0={0} z1={Z0}      accent={ACCENT} strokeWidth={0.9} />
      <IsoPost x={S * 2}  y={S * 2}  z0={0} z1={Z0}      accent={ACCENT} strokeWidth={0.9} />
      <IsoPost x={-S}     y={0}      z0={0} z1={Z0}      accent={ACCENT} strokeWidth={0.75} dash="2 6" />

      {/* Node-dots where posts land on the floor */}
      <IsoDot at={[0,     0,     0]} r={2.5} fill={ACCENT} ring="rgba(61,242,167,0.25)" />
      <IsoDot at={[S * 2, 0,     0]} r={2.5} fill={ACCENT} ring="rgba(61,242,167,0.25)" />
      <IsoDot at={[0,     S * 2, 0]} r={2.5} fill={ACCENT} ring="rgba(61,242,167,0.25)" />
      <IsoDot at={[S * 2, S * 2, 0]} r={2.5} fill={ACCENT} ring="rgba(61,242,167,0.25)" />
      <IsoDot at={[-S,    0,     0]} r={2}   fill={ACCENT} ring="rgba(61,242,167,0.18)" />

      {/* Accent flow edge threading under the lattice */}
      <IsoEdge
        from={[-S, 0, 0]}
        to={[S * 2, S * 2, 0]}
        curved
        lift={22}
        accent={ACCENT}
        strokeWidth={1.0}
        opacity={0.45}
        className="flow"
      />

      {/* ── 3. Floating lattice — wrapped for gentle hover animation ── */}
      <g className="iso-float-slow">

        {/* Render cubes in defined back-to-front order */}
        {CUBES.map((cube, i) => (
          <IsoBox
            key={i}
            x={cube.x}
            y={cube.y}
            z={cube.z}
            w={S}
            d={S}
            h={S}
            variant={cube.variant}
            accent={ACCENT}
            strokeWidth={cube.strokeWidth}
            dash={cube.dash}
          />
        ))}

        {/* Node-dots at key structural joints of the lattice (upper tier) */}
        <IsoDot
          at={[S,     0,     Z0 + S * 2 + S]}
          r={3}
          fill={ACCENT}
          ring="rgba(61,242,167,0.30)"
        />
        <IsoDot
          at={[0,     0,     Z0 + S * 2]}
          r={2.5}
          fill={ACCENT}
          ring="rgba(61,242,167,0.22)"
        />

      </g>

    </IsoScene>
  );
}
