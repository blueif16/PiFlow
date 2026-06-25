/* ============================================================
   HeroBlocksLight — the hero's isometric block cluster.

   Our angular "game-block" touch, recolored for the LIGHT system:
   white tops, grey shaded faces, thin near-black edges, white
   speed-marks on the grey faces, and a SINGLE orange node (the
   ring at the base) — the only chromatic mark in the whole scene.
   Pure static SVG (RSC-safe); reuses the iso-math projection.
   ============================================================ */
import { boxFaces, p, segPath } from "@/components/iso/iso-math";

const S = 46; // cube footprint / unit height
const EDGE = "#202022"; // thin near-black outline
const SW = 1.1;
const TOP = "#ffffff"; // lit top face
const FRONT = "#e8e8ec"; // left (front) face
const SIDE = "#f2f2f5"; // right face
const SHADE = "#d7d7dc"; // grey shaded face
const ACCENT = "#ff5a1f"; // the one orange spark

type Col = {
  gx: number;
  gy: number;
  h: number; // height in units
  shaded?: boolean; // grey the right face
  mark?: boolean; // white speed-marks on the grey face
};

// Painted back-to-front by ascending (gx + gy); footprints are distinct.
const COLS: Col[] = [
  { gx: 0, gy: 0, h: 2 },
  { gx: 1, gy: 0, h: 3, shaded: true, mark: true },
  { gx: 0, gy: 1, h: 1 }, // front-left → carries the orange ring
  { gx: 2, gy: 0, h: 2, shaded: true, mark: true },
  { gx: 1, gy: 1, h: 1, shaded: true, mark: true },
  { gx: 2, gy: 1, h: 2 },
  { gx: 2, gy: 2, h: 1, shaded: true, mark: true },
];

function Tower({ gx, gy, h, shaded, mark }: Col) {
  const x = gx * S;
  const y = gy * S;
  const hz = h * S;
  const { top, left, right } = boxFaces(x, y, 0, S, S, hz);
  const rightFill = shaded ? SHADE : SIDE;

  // Two white speed-marks on the (grey) right face, near the top.
  const z1 = hz * 0.62;
  const z2 = z1 - 9;
  const ya = y + S * 0.22;
  const yb = y + S * 0.6;

  return (
    <g strokeLinejoin="round">
      <polygon
        points={right}
        fill={rightFill}
        stroke={EDGE}
        strokeWidth={SW}
        vectorEffect="non-scaling-stroke"
      />
      <polygon
        points={left}
        fill={FRONT}
        stroke={EDGE}
        strokeWidth={SW}
        vectorEffect="non-scaling-stroke"
      />
      <polygon
        points={top}
        fill={TOP}
        stroke={EDGE}
        strokeWidth={SW}
        vectorEffect="non-scaling-stroke"
      />
      {mark && shaded ? (
        <g stroke="#ffffff" strokeWidth={3.2} strokeLinecap="round">
          <path d={segPath([x + S, ya, z1], [x + S, yb, z1])} />
          <path d={segPath([x + S, ya, z2], [x + S, yb, z2])} />
        </g>
      ) : null}
    </g>
  );
}

export default function HeroBlocksLight({ className }: { className?: string }) {
  const sorted = [...COLS].sort((a, b) => a.gx + a.gy - (b.gx + b.gy));

  // The front-left riser → orange ring node (the single accent).
  const top = p(0, 2 * S, S); // top-front corner of the front-left cube
  const bot = p(0, 2 * S, 0); // ground corner

  // A quiet structural connector across two tower tops + dark joint dots.
  const jA = p(S, 0, 3 * S);
  const jB = p(2 * S, 0, 2 * S);

  return (
    <svg
      viewBox="-135 -132 272 296"
      className={className}
      fill="none"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      {sorted.map((c, i) => (
        <Tower key={i} {...c} />
      ))}

      {/* back ridge connector + joint dots (neutral) */}
      <path
        d={`M ${jA[0]} ${jA[1]} L ${jB[0]} ${jB[1]}`}
        stroke={EDGE}
        strokeWidth={1}
        strokeDasharray="3 4"
        vectorEffect="non-scaling-stroke"
        opacity={0.55}
      />
      <circle cx={jA[0]} cy={jA[1]} r={2.4} fill={EDGE} />
      <circle cx={jB[0]} cy={jB[1]} r={2.4} fill={EDGE} />

      {/* front-left riser down to the orange ring node — the ONE accent */}
      <path
        d={`M ${top[0]} ${top[1]} L ${bot[0]} ${bot[1]}`}
        stroke={EDGE}
        strokeWidth={1.1}
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={top[0]} cy={top[1]} r={2.4} fill={EDGE} />
      <circle cx={bot[0]} cy={bot[1]} r={7.5} fill="#ffffff" stroke={ACCENT} strokeWidth={2.4} />
      <circle cx={bot[0]} cy={bot[1]} r={2.6} fill={ACCENT} />
    </svg>
  );
}
