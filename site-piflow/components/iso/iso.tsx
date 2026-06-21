/* ============================================================
   Isometric SVG primitive kit — RSC/server-safe (pure static SVG).
   Author a bespoke illustration as DATA + a few primitives; new
   art costs ~5–10 lines, never a hand-drawn path. Motion is added
   by reusing the .draw / .flow / .iso-float CSS classes (globals.css)
   so everything stays reduced-motion-gated and JS-free.
   ============================================================ */
import type { ReactNode } from "react";
import { boxFaces, planePoints, segPath, curvePath, p } from "./iso-math";

const ACCENT = "#3df2a7";

/** hex → rgba with alpha (so faces can be translucent accent washes). */
function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/* ---- Shared glossy face gradients (objectBoundingBox → one
        definition works for every cube; identical across scenes). - */
function IsoDefs() {
  return (
    <defs>
      <linearGradient id="iso-top" x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0" stopColor="#d2ffee" stopOpacity="0.55" />
        <stop offset="0.4" stopColor={ACCENT} stopOpacity="0.34" />
        <stop offset="1" stopColor={ACCENT} stopOpacity="0.12" />
      </linearGradient>
      <linearGradient id="iso-right" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={ACCENT} stopOpacity="0.3" />
        <stop offset="1" stopColor={ACCENT} stopOpacity="0.06" />
      </linearGradient>
      <linearGradient id="iso-left" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={ACCENT} stopOpacity="0.15" />
        <stop offset="1" stopColor={ACCENT} stopOpacity="0.03" />
      </linearGradient>
    </defs>
  );
}

/* ---- Scene wrapper ---------------------------------------- */
export function IsoScene({
  viewBox,
  className,
  children,
}: {
  viewBox: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox={viewBox}
      className={className}
      fill="none"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <IsoDefs />
      {children}
    </svg>
  );
}

/* ---- The cube/box — three visible faces ------------------- */
type Variant = "glow" | "wire" | "surface";

export function IsoBox({
  x = 0, y = 0, z = 0, w, d, h,
  variant = "glow",
  accent = ACCENT,
  stroke,
  strokeWidth = 1.6,
  dash,
  topAlpha,
  className,
}: {
  x?: number; y?: number; z?: number; w: number; d: number; h: number;
  variant?: Variant;
  accent?: string;
  stroke?: string;
  strokeWidth?: number;
  dash?: string;
  topAlpha?: number;
  className?: string;
}) {
  const { top, left, right } = boxFaces(x, y, z, w, d, h);
  const s = stroke ?? (variant === "surface" ? hexA("#ffffff", 0.16) : accent);

  let fTop = "none", fLeft = "none", fRight = "none";
  if (variant === "glow") {
    if (accent === ACCENT) {
      // glossy: per-face gradients with a glassy top highlight
      fTop = "url(#iso-top)";
      fLeft = "url(#iso-left)";
      fRight = "url(#iso-right)";
    } else {
      fTop = hexA(accent, topAlpha ?? 0.28);
      fLeft = hexA(accent, 0.08);
      fRight = hexA(accent, 0.16);
    }
  } else if (variant === "surface") {
    fTop = hexA("#ffffff", 0.06);
    fLeft = "rgba(0,0,0,0.30)";
    fRight = "rgba(0,0,0,0.16)";
  }

  const cls = [className, variant === "glow" ? "iso-glow" : ""].filter(Boolean).join(" ");
  return (
    <g className={cls || undefined} strokeLinejoin="round" vectorEffect="non-scaling-stroke">
      <polygon points={right} fill={fRight} stroke={s} strokeWidth={strokeWidth} strokeDasharray={dash} />
      <polygon points={left} fill={fLeft} stroke={s} strokeWidth={strokeWidth} strokeDasharray={dash} />
      <polygon points={top} fill={fTop} stroke={s} strokeWidth={strokeWidth} strokeDasharray={dash} />
    </g>
  );
}

/* ---- Flat rhombus — a platform top or floating tile -------- */
export function IsoPlane({
  x, y, z = 0, w, d,
  accent = ACCENT,
  fillAlpha = 0.05,
  stroke,
  strokeWidth = 1.1,
  dash,
  className,
}: {
  x: number; y: number; z?: number; w: number; d: number;
  accent?: string; fillAlpha?: number; stroke?: string;
  strokeWidth?: number; dash?: string; className?: string;
}) {
  return (
    <polygon
      className={className}
      points={planePoints(x, y, z, w, d)}
      fill={hexA(accent, fillAlpha)}
      stroke={stroke ?? accent}
      strokeWidth={strokeWidth}
      strokeDasharray={dash}
      strokeLinejoin="round"
    />
  );
}

/* ---- Faint isometric floor grid --------------------------- */
export function IsoGrid({
  x = 0, y = 0, z = 0, w, d, step = 24,
  color = "rgba(255,255,255,0.055)",
  strokeWidth = 1,
}: {
  x?: number; y?: number; z?: number; w: number; d: number; step?: number;
  color?: string; strokeWidth?: number;
}) {
  const lines: string[] = [];
  for (let gx = x; gx <= x + w + 0.01; gx += step) lines.push(segPath([gx, y, z], [gx, y + d, z]));
  for (let gy = y; gy <= y + d + 0.01; gy += step) lines.push(segPath([x, gy, z], [x + w, gy, z]));
  return (
    <g>
      {lines.map((dd, i) => (
        <path key={i} d={dd} stroke={color} strokeWidth={strokeWidth} />
      ))}
    </g>
  );
}

/* ---- Connector edge (straight or bowed); add className="draw"
        for scroll draw-on or "flow" for a traveling pulse. ---- */
export function IsoEdge({
  from, to,
  accent = ACCENT,
  curved = false,
  lift = 18,
  strokeWidth = 1.7,
  dash,
  opacity = 1,
  className,
  len,
}: {
  from: [number, number, number];
  to: [number, number, number];
  accent?: string; curved?: boolean; lift?: number;
  strokeWidth?: number; dash?: string; opacity?: number;
  className?: string; len?: number;
}) {
  const d = curved ? curvePath(from, to, lift) : segPath(from, to);
  return (
    <path
      className={className}
      style={len ? ({ ["--len" as string]: len } as React.CSSProperties) : undefined}
      d={d}
      stroke={accent}
      strokeWidth={strokeWidth}
      strokeDasharray={dash}
      strokeLinecap="round"
      fill="none"
      opacity={opacity}
    />
  );
}

/* ---- Node marker dot at a 3D point ------------------------ */
export function IsoDot({
  at, r = 3, fill = ACCENT, ring,
}: {
  at: [number, number, number]; r?: number; fill?: string; ring?: string;
}) {
  const [cx, cy] = p(...at);
  return (
    <>
      {ring ? <circle cx={cx} cy={cy} r={r + 3} fill="none" stroke={ring} strokeWidth={1} /> : null}
      <circle cx={cx} cy={cy} r={r} fill={fill} />
    </>
  );
}

/* ---- Vertical riser: a thin post from ground to a height --- */
export function IsoPost({
  x, y, z0 = 0, z1, accent = ACCENT, strokeWidth = 1, dash = "2 4",
}: {
  x: number; y: number; z0?: number; z1: number;
  accent?: string; strokeWidth?: number; dash?: string;
}) {
  return (
    <path
      d={segPath([x, y, z0], [x, y, z1])}
      stroke={accent}
      strokeWidth={strokeWidth}
      strokeDasharray={dash}
      opacity={0.5}
    />
  );
}
