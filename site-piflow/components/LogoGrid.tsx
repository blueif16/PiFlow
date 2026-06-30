"use client";

/* ============================================================
   LogoGrid — the hero's right-half mark, alive. The PiFlow glyph
   is built from grid MODULES (mostly 2×2 cells) — 8 ink rects for
   the stem + bar + counter, plus the play-triangle. On a loop the
   modules scatter to other grid-aligned arrangements and reassemble
   into the logo: a self-morph back to the mark.

   The triangle is a 4-point polygon: at the logo its apex point is
   doubled (a triangle); when scattering, that apex SPLITS into a
   flat right edge so it becomes a plain 2×2 block like the others —
   so it only ever reads as the play-triangle when reformed into the
   logo. Corner radius also "breathes": sharp (rx 0) at the crisp
   logo, rounded as fluid modules.

   Same faint hairline lattice + left-edge fade + 720×1080 / cell-45
   geometry as before, so the left HoverGrid stays matched. GSAP
   context auto-cleans on unmount and the whole thing collapses to a
   clean static logo under prefers-reduced-motion.
   ============================================================ */

import { useEffect, useRef } from "react";
import gsap from "gsap";

// Board geometry (viewBox units). Grid spans the whole viewBox; the
// modules pose on the centered 12×12 board.
const VB_W = 720;
const VB_H = 1080;
const C = 45; // cell
const ORIGIN_X = 90; // board left  (= (VB_W - 540) / 2)
const ORIGIN_Y = 270; // board top  (= (VB_H - 540) / 2)

const EDGE_FADE = "linear-gradient(to right, transparent 0%, #000 32%, #000 100%)";

type Pose = [col: number, row: number, w: number, h: number, rot: number];
type Frame = Pose[]; // 8 rect modules

// Frame 0 = THE LOGO: 8 cell-snapped modules tiling the glyph.
//   3× top bar · 3× stem · 1× top-right block (C2) · 1× mid arm.
//   The P-counter (cols 6–7, rows 4–5) is left untiled. Frames 1–4 =
//   other grid arrangements the modules morph through.
const POSES: Frame[] = [
  [
    [4, 2, 2, 2, 0], [6, 2, 2, 2, 0], [8, 2, 2, 2, 0], // top bar
    [4, 4, 2, 2, 0], [4, 6, 2, 2, 0], [4, 8, 2, 2, 0], // stem
    [8, 4, 2, 2, 0],                                    // C2 block
    [6, 6, 2, 2, 0],                                    // mid arm
  ],
  [
    [1, 1, 2, 2, 0], [5, 0, 3, 2, 0], [9, 2, 2, 2, 0], [2, 4, 2, 2, 0],
    [6, 4, 3, 2, 0], [0, 8, 3, 2, 0], [5, 7, 2, 3, 0], [9, 7, 2, 2, 0],
  ],
  [
    [2, 2, 3, 2, 0], [8, 1, 2, 2, 0], [0, 4, 2, 3, 0], [4, 5, 3, 2, 0],
    [9, 5, 2, 2, 0], [2, 9, 2, 2, 0], [6, 8, 3, 2, 0], [10, 9, 2, 2, 0],
  ],
  [
    [0, 0, 2, 2, 0], [3, 1, 3, 2, 0], [7, 0, 2, 3, 0], [10, 2, 2, 2, 0],
    [1, 4, 2, 2, 0], [4, 6, 3, 2, 0], [8, 5, 2, 2, 0], [10, 8, 2, 3, 0],
  ],
  [
    [3, 0, 2, 2, 0], [6, 1, 3, 2, 0], [10, 0, 2, 2, 0], [0, 3, 2, 3, 0],
    [4, 3, 2, 2, 0], [8, 4, 2, 3, 0], [2, 7, 3, 2, 0], [6, 7, 2, 2, 0],
  ],
];

// The play element, as a 4-point polygon per frame (TL, TR, BR, BL order).
// Frame 0 is the triangle (apex doubled into TR≡BR); the rest are 2×2 blocks
// that drop into an empty cell, so it splits open into a block while in transit.
const TRI_PTS = [
  "540,540 675,630 675,630 540,720", // logo — the play-triangle
  "495,450 585,450 585,540 495,540", // block @ cell (9,4)
  "360,360 450,360 450,450 360,450", // block @ cell (6,2)
  "135,630 225,630 225,720 135,720", // block @ cell (1,8)
  "495,630 585,630 585,720 495,720", // block @ cell (9,8)
];

// rx is 0 at the logo (crisp), rounded elsewhere (fluid modules).
const rxFor = (frame: number) => (frame === 0 ? 0 : 14);

function centerOf([col, row, w, h, r]: Pose) {
  return {
    x: ORIGIN_X + (col + w / 2) * C,
    y: ORIGIN_Y + (row + h / 2) * C,
    w: w * C,
    h: h * C,
    r: r || 0,
  };
}

export default function LogoGrid({ className = "" }: { className?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const blocks = gsap.utils.toArray<SVGGElement>(svg.querySelectorAll(".lg-block"));
    const rects = blocks.map((b) => b.querySelector("rect") as SVGRectElement);
    const tri = svg.querySelector(".lg-tri") as SVGPolygonElement | null;

    const setPose = (frame: number) => {
      const f = POSES[frame];
      const rx = rxFor(frame);
      blocks.forEach((block, i) => {
        const p = centerOf(f[i]);
        gsap.set(block, { x: p.x, y: p.y, rotation: p.r, transformOrigin: "50% 50%" });
        gsap.set(rects[i], { attr: { x: -p.w / 2, y: -p.h / 2, width: p.w, height: p.h, rx, ry: rx } });
      });
      if (tri) gsap.set(tri, { attr: { points: TRI_PTS[frame] } });
    };

    const ctx = gsap.context(() => {
      setPose(0);

      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      // soft intro, then the morph loop
      gsap.from([...blocks, tri].filter(Boolean), {
        opacity: 0,
        scale: 0.85,
        duration: 0.7,
        ease: "power2.out",
        stagger: { each: 0.04, from: "start" },
        transformOrigin: "50% 50%",
      });

      const tl = gsap.timeline({ repeat: -1, defaults: { ease: "expo.inOut" } });
      tl.to({}, { duration: 1.2 }); // hold the crisp logo before the first morph
      const SEQ = [1, 2, 3, 4, 0]; // wander the grid arrangements, then reform the logo
      SEQ.forEach((s) => {
        const next = POSES[s].map(centerOf);
        const rx = rxFor(s);

        // glide + light position/scale jitter while in transit
        tl.to(blocks, {
          duration: 1.4,
          x: (i: number) => next[i].x,
          y: (i: number) => next[i].y,
          rotation: (i: number) => next[i].r + gsap.utils.random(-6, 6),
          scaleX: () => gsap.utils.random(0.95, 1.05),
          scaleY: () => gsap.utils.random(0.95, 1.05),
          stagger: { each: 0.03, from: "random" },
        });
        tl.to(rects, {
          duration: 1.4,
          attr: {
            x: (i: number) => -next[i].w / 2,
            y: (i: number) => -next[i].h / 2,
            width: (i: number) => next[i].w,
            height: (i: number) => next[i].h,
            rx,
            ry: rx,
          },
          stagger: { each: 0.02, from: "random" },
        }, "<");
        if (tri) tl.to(tri, { duration: 1.4, attr: { points: TRI_PTS[s] } }, "<");
        // settle the jitter to the exact pose
        tl.to(blocks, {
          duration: 0.4,
          rotation: (i: number) => next[i].r,
          scaleX: 1,
          scaleY: 1,
          ease: "power2.out",
          stagger: { each: 0.015, from: "center" },
        }, "-=0.3");
        // hold — longer when reformed into the logo
        tl.to({}, { duration: s === 0 ? 1.5 : 0.45 });
      });
    }, svg);

    return () => ctx.revert();
  }, []);

  const vlines = Array.from({ length: Math.floor(VB_W / C) + 1 }, (_, i) => i * C);
  const hlines = Array.from({ length: Math.floor(VB_H / C) + 1 }, (_, i) => i * C);

  return (
    <div className={className} style={{ WebkitMaskImage: EDGE_FADE, maskImage: EDGE_FADE }} aria-hidden>
      <svg ref={svgRef} viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMidYMid slice" className="h-full w-full">
        {/* faint engineering grid — the field behind the mark */}
        <g style={{ stroke: "var(--hairline)" }} strokeWidth={1} fill="none">
          {vlines.map((x) => (
            <line key={`v${x}`} x1={x} y1={0} x2={x} y2={VB_H} vectorEffect="non-scaling-stroke" />
          ))}
          {hlines.map((y) => (
            <line key={`h${y}`} x1={0} y1={y} x2={VB_W} y2={y} vectorEffect="non-scaling-stroke" />
          ))}
        </g>

        {/* the mark — 8 ink modules + the morphing play element */}
        <g style={{ fill: "var(--ink)" }}>
          {POSES[0].map((_, i) => (
            <g className="lg-block" key={i}>
              <rect />
            </g>
          ))}
          {/* the tracked play element — brand orange in both states: the
              logo's play-triangle and the roaming square mid-morph */}
          <polygon className="lg-tri" points={TRI_PTS[0]} style={{ fill: "var(--accent)" }} />
        </g>
      </svg>
    </div>
  );
}
