/* ============================================================
   piflow iso-kit — the SHARED primitive library for the three
   metaphor illustrations (atom · substrate · protein).
   ALL three SVGs import THIS file so they read as one family.
   Light system: white tops, grey faces, thin near-black edges,
   ONE orange spark. Pure string-builder (node), renders via rsvg.

   USAGE (a scene is: compose `parts`, then emit):
     import * as K from "./kit.mjs";
     const P = [];
     P.push(K.shadow(55,55,94,46));
     P.push(K.roundIsoBox(0,0,0,110,110,16,{r:11}));            // a slab
     P.push(K.roundIsoBox(40,40,16,30,30,16,{r:6,accent:true})); // orange box
     P.push(K.label(55,128,0,"SANDBOX",{fill:K.EDGE}));
     writeFileSync("x.svg", K.emit("-175 -82 360 292", P));
   API (all coords are iso units: x=down-right, y=down-left, z=up):
     roundIsoBox(x,y,z,w,d,h,{r,top,left,right,accent})  rounded extruded box
     bolt(x,y,z)            a sealed-screw dot on a top face
     guide(x,y,z,w,d)       a dashed ground rhombus (landing zone / ghost)
     shadow(x,y,rx,ry,op)   soft contact shadow on the ground
     glass(x,y,z,w,d)       translucent sealed-chamber lid
     nucleus(cx,cy,gz,r)    faint orange shell-ring on a plane (atom cue)
     flow([[x,y,z]...],{accent,op})  dashed path + arrowhead (a moving task)
     gate(x,y,{d,h,mark})   a thin standing check-panel a flow passes through
     toolChip(x,y,z,[dx,dy,dz])  a tool cube wired into a face
     label(x,y,z,txt,{anchor,fill,dy,size})  a geist-mono label
     emit(viewBox,parts,{w,bg})  wrap into a full <svg> with defs
   ============================================================ */

export const C = Math.cos(Math.PI / 6), S = 0.5;
export const proj = (x, y, z) => [(x - y) * C, (x + y) * S - z];
export const f2 = (n) => Number(n.toFixed(2));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };

/* palette — DO NOT introduce other hues. orange is the only accent. */
export const EDGE = "#1f1f24", SW = 1.5;
export const TOP = "#ffffff", LEFT = "#e7e7ee", RIGHT = "#d8d8e0";
export const GUIDE = "#1f1f24", ORANGE = "#ff5a1f", MUTE = "#6b6b73";
const O_TOP = "#ff5a1f", O_LEFT = "#ef6a2c", O_RIGHT = "#d9500f";

export function roundPath(pts, r) {
  const n = pts.length, tan = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const rr = Math.min(r, len(sub(p0, p1)) / 2, len(sub(p2, p1)) / 2);
    tan.push([add(p1, mul(norm(sub(p0, p1)), rr)), add(p1, mul(norm(sub(p2, p1)), rr))]);
  }
  let d = "";
  for (let i = 0; i < n; i++) {
    const [t1, t2] = tan[i], p1 = pts[i];
    d += (i === 0 ? `M ${f2(t1[0])} ${f2(t1[1])} ` : `L ${f2(t1[0])} ${f2(t1[1])} `);
    d += `Q ${f2(p1[0])} ${f2(p1[1])} ${f2(t2[0])} ${f2(t2[1])} `;
  }
  return { d: d + "Z", tan };
}

export function roundIsoBox(x, y, z, w, d, h, { r = 8, top, left, right, stroke = EDGE, sw = SW, accent = false } = {}) {
  const tf = top ?? (accent ? O_TOP : TOP), lf = left ?? (accent ? O_LEFT : LEFT), rf = right ?? (accent ? O_RIGHT : RIGHT);
  const A = proj(x, y, z + h), B = proj(x + w, y, z + h), Cc = proj(x + w, y + d, z + h), D = proj(x, y + d, z + h);
  const { d: topD, tan } = roundPath([A, B, Cc, D], r);
  const down = (p) => [p[0], p[1] + h];
  const B_fromC = tan[1][1], C_fromB = tan[2][0], C_fromD = tan[2][1], D_fromC = tan[3][0];
  const rightWall = [B_fromC, C_fromB, down(C_fromB), down(B_fromC)].map(p => `${f2(p[0])},${f2(p[1])}`).join(" ");
  const leftWall = [C_fromD, D_fromC, down(D_fromC), down(C_fromD)].map(p => `${f2(p[0])},${f2(p[1])}`).join(" ");
  return `<polygon points="${rightWall}" fill="${rf}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  <polygon points="${leftWall}" fill="${lf}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  <path d="${topD}" fill="${tf}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
}

export const bolt = (x, y, z) => { const [px, py] = proj(x, y, z); return `<circle cx="${f2(px)}" cy="${f2(py)}" r="2.8" fill="#fff" stroke="${EDGE}" stroke-width="1.1" vector-effect="non-scaling-stroke"/><circle cx="${f2(px)}" cy="${f2(py)}" r="1" fill="${MUTE}"/>`; };

export const guide = (x, y, z, w, d) => {
  const pts = [proj(x, y, z), proj(x + w, y, z), proj(x + w, y + d, z), proj(x, y + d, z)].map(p => `${f2(p[0])},${f2(p[1])}`).join(" ");
  return `<polygon points="${pts}" fill="none" stroke="${GUIDE}" stroke-width="1" stroke-dasharray="4 4" opacity="0.26" vector-effect="non-scaling-stroke"/>`;
};

export const shadow = (x, y, rx, ry, op = 0.09) => { const [px, py] = proj(x, y, 0); return `<ellipse cx="${f2(px)}" cy="${f2(py)}" rx="${rx}" ry="${ry}" fill="#1f1f24" opacity="${op}" filter="url(#blur)"/>`; };

export function glass(x, y, z, w, d) {
  const A = proj(x, y, z), B = proj(x + w, y, z), Cc = proj(x + w, y + d, z), D = proj(x, y + d, z);
  const { d: gd } = roundPath([A, B, Cc, D], 7);
  const h1 = proj(x + w * 0.22, y + d * 0.12, z), h2 = proj(x + w * 0.55, y + d * 0.8, z);
  return `<path d="${gd}" fill="#cdd2dd" fill-opacity="0.35" stroke="${EDGE}" stroke-width="1.2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  <path d="${gd}" fill="url(#glassgrad)" fill-opacity="0.6"/>
  <line x1="${f2(h1[0])}" y1="${f2(h1[1])}" x2="${f2(h2[0])}" y2="${f2(h2[1])}" stroke="#fff" stroke-width="3" opacity="0.5" stroke-linecap="round"/>`;
}

export const nucleus = (cx, cy, gz, rx = 30, ry = 15) => { const [px, py] = proj(cx, cy, gz); return `<ellipse cx="${f2(px)}" cy="${f2(py)}" rx="${rx}" ry="${ry}" fill="none" stroke="${ORANGE}" stroke-width="1" opacity="0.35"/>`; };

export function flow(ptsXYZ, { accent = EDGE, op = 0.5, sw = 1.6 } = {}) {
  const Pp = ptsXYZ.map(([x, y, z]) => proj(x, y, z ?? 0));
  let d = `M ${f2(Pp[0][0])} ${f2(Pp[0][1])} `;
  for (let i = 1; i < Pp.length; i++) d += `L ${f2(Pp[i][0])} ${f2(Pp[i][1])} `;
  const a = Pp[Pp.length - 2], b = Pp[Pp.length - 1], dir = norm(sub(b, a)), per = [-dir[1], dir[0]];
  const base = add(b, mul(dir, -7)), l = add(base, mul(per, 4)), r = add(base, mul(per, -4));
  const head = `<polygon points="${f2(b[0])},${f2(b[1])} ${f2(l[0])},${f2(l[1])} ${f2(r[0])},${f2(r[1])}" fill="${accent}" opacity="${op + 0.25}"/>`;
  return `<path d="${d}" fill="none" stroke="${accent}" stroke-width="${sw}" stroke-dasharray="2 4" stroke-linecap="round" opacity="${op}" vector-effect="non-scaling-stroke"/>${head}`;
}

export function gate(x, y, { d = 30, h = 24, mark = MUTE } = {}) {
  const box = roundIsoBox(x, y, 0, 5, d, h, { r: 2, top: "#f3f3f6", left: "#e1e1e8", right: "#d2d2da" });
  const c0 = proj(x, y + d * 0.34, h * 0.44), c1 = proj(x, y + d * 0.5, h * 0.32), c2 = proj(x, y + d * 0.74, h * 0.64);
  const chk = `<path d="M ${f2(c0[0])} ${f2(c0[1])} L ${f2(c1[0])} ${f2(c1[1])} L ${f2(c2[0])} ${f2(c2[1])}" fill="none" stroke="${mark}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  return box + chk;
}

export function toolChip(x, y, z, dockXYZ, { lit = false } = {}) {
  const b = roundIsoBox(x, y, z, 11, 11, 9, { r: 2.5, accent: lit, top: lit ? undefined : "#fafafa", left: lit ? undefined : "#e4e4ea", right: lit ? undefined : "#d4d4dc" });
  const a = proj(x + 5.5, y + 5.5, z + 9), dk = proj(...dockXYZ);
  return `<path d="M ${f2(a[0])} ${f2(a[1])} L ${f2(dk[0])} ${f2(dk[1])}" fill="none" stroke="${EDGE}" stroke-width="1.1" opacity="0.45" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>${b}`;
}

export const label = (x, y, z, text, { anchor = "middle", fill = MUTE, dy = 0, size = 8.5 } = {}) => {
  const [px, py] = proj(x, y, z);
  return `<text x="${f2(px)}" y="${f2(py + dy)}" font-family="ui-monospace,monospace" font-size="${size}" letter-spacing="0.7" text-anchor="${anchor}" fill="${fill}">${text}</text>`;
};

export function emit(viewBox, parts, { w = 1000, bg = "#f5f5f7" } = {}) {
  const [vx, vy, vw, vh] = viewBox.split(/\s+/).map(Number);
  const h = Math.round(w * vh / vw);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}">
  <defs>
    <linearGradient id="glassgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.7"/><stop offset="1" stop-color="#cfd3de" stop-opacity="0.06"/></linearGradient>
    <filter id="softglow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.2"/></filter>
  </defs>
  <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${bg}"/>
  ${parts.join("\n  ")}
</svg>`;
}

/* ============================================================
   COLLISION + AUTO-SPACING — additive Scene API (does NOT touch
   any export above; the functional kit keeps working byte-identically).

   Geometry we OWN: every solid is an iso-projected box, so its screen
   AABB is min/max over the 8 projected cube corners. Labels are
   monospace, so their advance width is the closed form n*size*0.6
   (empirically verified: 10 "M" glyphs @20px ink to 119px vs analytic
   120px — within 1px, and over-estimating = the safe, conservative
   direction; padding makes it conservative without a font parser).

   See RESEARCH-collision.md §2 (boxes from corners + the monospace
   formula) and §3a (candidate-position greedy 8-point placement with
   a viewBox-margin edge clamp).
   ============================================================ */

/* monospace metrics (calibrated empirically against ui-monospace via the
   rasterizer; no font parser available, install forbidden). */
export const CHAR_W = 0.6;     // advance ratio per em (monospace standard; verified ~119/120)
export const ASCENT = 0.78;    // cap/ascender height above baseline, per fontSize
export const DESCENT = 0.25;   // descender depth below baseline, per fontSize

/* boxAABB(points): tight axis-aligned box over projected screen points. */
export function boxAABB(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/* isoBoxAABB(x,y,z,w,d,h): the screen AABB of an iso box = boxAABB over its
   8 projected cube corners. (The silhouette extremes are always at corners.) */
export function isoBoxAABB(x, y, z, w, d, h) {
  const pts = [];
  for (const dx of [0, w]) for (const dy of [0, d]) for (const dz of [0, h])
    pts.push(proj(x + dx, y + dy, z + dz));
  return boxAABB(pts);
}

/* labelAABB(ax,ay,text,{anchor,size}): the screen box of a monospace <text>.
   ay is the BASELINE (SVG semantics); anchor adjusts the x-origin. */
export function labelAABB(ax, ay, text, { anchor = "middle", size = 8.5 } = {}) {
  const textW = String(text).length * size * CHAR_W;
  const x0 = anchor === "start" ? ax : anchor === "end" ? ax - textW : ax - textW / 2;
  return {
    minX: x0,
    minY: ay - size * ASCENT,
    maxX: x0 + textW,
    maxY: ay + size * DESCENT,
  };
}

/* overlaps(a,b,pad): AABB overlap with a min-padding gap. Each side is
   inflated by `pad`, so it returns true when the rects are closer than pad. */
export function overlaps(a, b, pad = 0) {
  return a.minX - pad < b.maxX && a.maxX + pad > b.minX &&
         a.minY - pad < b.maxY && a.maxY + pad > b.minY;
}

/* overlapArea(a,b): area of the AABB intersection (0 if disjoint). Used to
   rank candidates when no zero-overlap position exists (least-overlap wins). */
function overlapArea(a, b) {
  const ix = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const iy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return ix > 0 && iy > 0 ? ix * iy : 0;
}

/* insideViewBox(box, vb, margin): is the box fully inside the inset viewBox? */
function insideViewBox(box, vb, margin) {
  const [vx, vy, vw, vh] = vb;
  return box.minX >= vx + margin && box.minY >= vy + margin &&
         box.maxX <= vx + vw - margin && box.maxY <= vy + vh - margin;
}

/* Scene: tracks geometry so labels can be auto-placed clear of every tracked
   shape + already-placed label, deterministically. Solid draws (box/gate/
   toolChip) register an obstacle; deco draws pass through. Labels are queued
   and placed at emit() via the 8-point greedy search. */
export function Scene({ viewBox, padding = 3, margin = 6, labelSize = 8.5 } = {}) {
  const vb = String(viewBox).split(/\s+/).map(Number);
  const parts = [];            // raw SVG strings in draw order
  const _obstacles = [];       // tracked shape AABBs (labels avoid these)
  const _queued = [];          // labels awaiting placement
  const _placed = [];          // { text, box, side, ... } after emit()

  function pushObstacle(svg, aabb) { parts.push(svg); _obstacles.push(aabb); return aabb; }

  const api = {
    /* ---- tracked SOLIDS (register an obstacle AABB) ---- */
    box(x, y, z, w, d, h, opts = {}) {
      return pushObstacle(roundIsoBox(x, y, z, w, d, h, opts), isoBoxAABB(x, y, z, w, d, h));
    },
    gate(x, y, opts = {}) {
      const { d = 30, h = 24 } = opts;
      // gate() draws a 5-wide x d-deep x h-tall panel at z=0.
      return pushObstacle(gate(x, y, opts), isoBoxAABB(x, y, 0, 5, d, h));
    },
    toolChip(x, y, z, dockXYZ, opts = {}) {
      // toolChip cube footprint is 11x11x9 at (x,y,z); the dashed tether is deco.
      return pushObstacle(toolChip(x, y, z, dockXYZ, opts), isoBoxAABB(x, y, z, 11, 11, 9));
    },

    /* ---- untracked DECO (pass through; never an obstacle) ---- */
    shadow(...a) { parts.push(shadow(...a)); return api; },
    guide(...a) { parts.push(guide(...a)); return api; },
    glass(...a) { parts.push(glass(...a)); return api; },
    nucleus(...a) { parts.push(nucleus(...a)); return api; },
    flow(...a) { parts.push(flow(...a)); return api; },
    bolt(...a) { parts.push(bolt(...a)); return api; },
    raw(svg) { parts.push(svg); return api; },   // arbitrary deco (orange arc, rings, wires)

    /* ---- LABELS (queued; auto-placed at emit) ----
       anchor3d: [x,y,z] iso point the label names (or screen [px,py] if
       anchorScreen). side: preferred candidate direction. */
    label(anchor3d, text, { side = "right", fill = MUTE, size = labelSize, gap = 8, anchorScreen = false } = {}) {
      const [ax, ay] = anchorScreen ? anchor3d : proj(anchor3d[0], anchor3d[1], anchor3d[2] ?? 0);
      _queued.push({ ax, ay, text: String(text), side, fill, size, gap });
      return api;
    },

    /* ---- introspection (testable) ---- */
    obstacles() { return _obstacles.slice(); },
    placedLabels() { return _placed.slice(); },

    /* collisions(): residual label-vs-shape / label-vs-label overlaps. */
    collisions() {
      const out = [];
      for (let i = 0; i < _placed.length; i++) {
        for (const ob of _obstacles)
          if (overlaps(_placed[i].box, ob, padding))
            out.push({ kind: "label-shape", label: _placed[i].text });
        for (let j = i + 1; j < _placed.length; j++)
          if (overlaps(_placed[i].box, _placed[j].box, padding))
            out.push({ kind: "label-label", a: _placed[i].text, b: _placed[j].text });
      }
      return out;
    },

    /* place(): run the 8-point greedy over queued labels (stable order). */
    place() {
      _placed.length = 0;
      // deterministic order: by anchor y then x (research §3a).
      const order = _queued
        .map((l, idx) => ({ l, idx }))
        .sort((p, q) => (p.l.ay - q.l.ay) || (p.l.ax - q.l.ax) || (p.idx - q.idx));
      const liveLabelBoxes = [];
      for (const { l } of order) {
        const placed = placeOne(l, _obstacles, liveLabelBoxes, vb, margin, padding);
        liveLabelBoxes.push(placed.box);
        _placed.push(placed);
      }
      return api;
    },

    /* emit(): place, print a report, return the SVG. */
    emit({ w = 1000, bg = "#f5f5f7" } = {}) {
      api.place();
      const labelSvgs = _placed.map(renderPlacedLabel);
      const cols = api.collisions();
      if (cols.length === 0) {
        process.stderr.write("✓ no collisions\n");
      } else {
        process.stderr.write("COLLISION REPORT (" + cols.length + " residual):\n");
        for (const c of cols)
          process.stderr.write(c.kind === "label-shape"
            ? `  - label "${c.label}" overlaps a shape\n`
            : `  - label "${c.a}" overlaps label "${c.b}"\n`);
      }
      return emit(viewBox, [...parts, ...labelSvgs], { w, bg });
    },
  };
  return api;
}

/* the 8 candidate offsets, in aesthetic preference order, keyed by `side`.
   Each entry is the (dx,dy) of the label's chosen edge relative to the anchor,
   in screen px, scaled by the per-label gap g. We try the preferred side's
   list first (its own direction leads), escalating the gap if all 8 collide. */
const SIDES = {
  right: [["R", 1, 0], ["TR", 1, -1], ["BR", 1, 1], ["T", 0, -1], ["B", 0, 1], ["L", -1, 0], ["TL", -1, -1], ["BL", -1, 1]],
  left: [["L", -1, 0], ["TL", -1, -1], ["BL", -1, 1], ["T", 0, -1], ["B", 0, 1], ["R", 1, 0], ["TR", 1, -1], ["BR", 1, 1]],
  top: [["T", 0, -1], ["TR", 1, -1], ["TL", -1, -1], ["R", 1, 0], ["L", -1, 0], ["B", 0, 1], ["BR", 1, 1], ["BL", -1, 1]],
  bottom: [["B", 0, 1], ["BR", 1, 1], ["BL", -1, 1], ["R", 1, 0], ["L", -1, 0], ["T", 0, -1], ["TR", 1, -1], ["TL", -1, -1]],
};

/* candidate label box: given an anchor and a direction, where does the box go?
   The directional unit (ux,uy) chooses which CORNER/EDGE of the label box sits
   against the gap-offset anchor, so the text reads on the side it points to. */
function candidateBox(l, dirX, dirY, g) {
  // anchor pushed out by gap along the direction, then the box is laid so its
  // near edge meets that pushed point.
  const px = l.ax + dirX * g;
  const py = l.ay + dirY * g;
  const textW = l.text.length * l.size * CHAR_W;
  const asc = l.size * ASCENT, desc = l.size * DESCENT;
  // x-origin so the box sits to the dir-x side of px
  const x0 = dirX > 0 ? px : dirX < 0 ? px - textW : px - textW / 2;
  // baseline so the box sits to the dir-y side of py
  const ay = dirY > 0 ? py + asc : dirY < 0 ? py - desc : py + (asc - desc) / 2;
  const box = { minX: x0, minY: ay - asc, maxX: x0 + textW, maxY: ay + desc };
  return { box, baseline: ay };
}

/* placeOne: candidate-position greedy. Try the preferred side's 8 positions at
   escalating gaps; first zero-overlap & inside-viewBox wins; else least-overlap. */
function placeOne(l, shapeObstacles, labelBoxes, vb, margin, padding) {
  const order = SIDES[l.side] || SIDES.right;
  let best = null, bestPenalty = Infinity;
  // Escalate the gap geometrically until a clean spot is found. The cap is the
  // viewBox diagonal so an anchor buried INSIDE a shape can still be pushed
  // fully clear (e.g. a label anchored at a slab's center). Bounded + stable.
  const [, , vw, vh] = vb;
  const gapCap = Math.hypot(vw, vh);
  const gaps = [];
  for (let g = l.gap; g <= gapCap; g *= 1.5) gaps.push(g);
  for (const g of gaps) {
    for (const [, dirX, dirY] of order) {
      const c = candidateBox(l, dirX, dirY, g);
      const inside = insideViewBox(c.box, vb, margin);
      let penalty = 0;
      for (const ob of shapeObstacles) penalty += overlapArea(inflate(c.box, padding), ob);
      for (const lb of labelBoxes) penalty += overlapArea(inflate(c.box, padding), lb);
      if (!inside) penalty += 1e6;               // off-canvas is worse than any overlap
      if (penalty === 0) {
        return finalize(l, c, dirX, dirY, g);
      }
      if (penalty < bestPenalty) { bestPenalty = penalty; best = { c, dirX, dirY, g }; }
    }
  }
  return finalize(l, best.c, best.dirX, best.dirY, best.g);
}

function inflate(b, p) { return { minX: b.minX - p, minY: b.minY - p, maxX: b.maxX + p, maxY: b.maxY + p }; }

function finalize(l, c, dirX, dirY, g) {
  // the screen x to feed <text> depends on text-anchor: start->box.minX,
  // end->box.maxX, middle->box center.
  const anchor = dirX > 0 ? "start" : dirX < 0 ? "end" : "middle";
  const drawX = anchor === "start" ? c.box.minX : anchor === "end" ? c.box.maxX : (c.box.minX + c.box.maxX) / 2;
  return { text: l.text, box: c.box, side: l.side, fill: l.fill, size: l.size, anchor, drawX, baseline: c.baseline };
}

function renderPlacedLabel(p) {
  return `<text x="${f2(p.drawX)}" y="${f2(p.baseline)}" font-family="ui-monospace,monospace" font-size="${p.size}" letter-spacing="0.7" text-anchor="${p.anchor}" fill="${p.fill}">${p.text}</text>`;
}

/* ============================================================
   SHAPE-PLACEMENT LAYER — deliberate placement of the SHAPES
   themselves (line / grid / align / depth-order): the stage ABOVE
   the collision + label passes. PURE: every helper takes items +
   spacing constants and RETURNS grid anchors (integers); none of
   them DRAW. The author then feeds the anchors to `Scene.box(...)`,
   which registers obstacle AABBs, after which the existing 8-point
   label pass runs unchanged.  Stage 1 place (new) → Stage 2 collide
   (have) → Stage 3 labels (have).

   The load-bearing rule (RESEARCH-layout.md §1): decide EVERYTHING in
   (x,y,z) integer grid units, project ONCE at emit. Equal grid spacing
   along an iso axis reads regular; equal SCREEN spacing does not (the
   30° shear). Every gap is one of two constants. See RESEARCH-layout.md
   §2 (composition rules C1–C11) and §3 (these helper signatures).
   Additive — touches nothing above; existing renders are byte-identical.
   ============================================================ */

/* the only two gap sizes in a scene (iso units): rows vs within-a-row (C7). */
export const RANK_SEP = 3;   // gap BETWEEN rows / ranks
export const NODE_SEP = 3;   // gap WITHIN a row, between adjacent items

/* snapToGrid(p): normalize a free/derived point onto the integer lattice —
   the precondition for everything (C2/C3: off-grid z is the "floating" look).
   `_round0` collapses -0 → 0 so anchors compare/serialize cleanly (C11). */
const _round0 = (v) => { const n = Math.round(v); return n === 0 ? 0 : n; };
export const snapToGrid = ({ x, y, z = 0 }) => ({ x: _round0(x), y: _round0(y), z: _round0(z) });

/* assertIntegerAnchor(a): throw if any of x,y,z is non-integer (the anti-float
   guard, C2). Call after any derived placement before drawing. */
export function assertIntegerAnchor(a) {
  for (const k of ["x", "y", "z"]) {
    if (!Number.isInteger(a[k])) throw new Error(`anchor ${a.id ?? ""} has non-integer ${k}=${a[k]} — snapToGrid first`);
  }
  return a;
}

/* isoCorners(x,y,z,w,d,h): the 8 projected SCREEN corners of an iso box
   (the same corner set isoBoxAABB min/maxes over). Exposed for centerGroup
   and any caller needing the projected silhouette. */
export function isoCorners(x, y, z, w, d, h) {
  const pts = [];
  for (const dx of [0, w]) for (const dy of [0, d]) for (const dz of [0, h])
    pts.push(proj(x + dx, y + dy, z + dz));
  return pts;
}

/* an item to place carries its footprint {id,w,d,h}; helpers return Anchor
   {id,x,y,z,w,d,h}. */
const _ext = (it, axis) => (axis === "x" ? it.w : axis === "y" ? it.d : it.h);

/* rowLine(items, axis, gap, start): a clean even line along ONE iso axis.
   Center-PITCH = max footprint on that axis + gap → uniform by construction
   (an integer index × one constant pitch cannot drift), and equal PITCH (not
   equal edge-gap) keeps mixed-size items reading engineered (C7). The line
   projects onto a true 30° (x/y) or vertical (z) screen line, never a skew. */
export function rowLine(items, axis = "x", gap = NODE_SEP, start = { x: 0, y: 0, z: 0 }) {
  const pitch = Math.max(...items.map((it) => _ext(it, axis))) + gap;
  const dir = axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
  return items.map((it, i) => ({
    id: it.id, w: it.w, d: it.d, h: it.h,
    x: start.x + dir[0] * i * pitch,
    y: start.y + dir[1] * i * pitch,
    z: start.z + dir[2] * i * pitch,
  }));
}

/* grid(items, cols, gap, start): a tidy N×M lattice anchored at a corner,
   marching by a constant pitch on both axes (the "some in a simple grid"
   case). cols defaults to round(√N) so the block reads square, not a strip. */
export function grid(items, cols = Math.round(Math.sqrt(items.length)), gap = NODE_SEP, start = { x: 0, y: 0, z: 0 }) {
  const c = Math.max(1, cols);
  const pitchX = Math.max(...items.map((it) => it.w)) + gap;
  const pitchY = Math.max(...items.map((it) => it.d)) + gap;
  return items.map((it, k) => {
    const col = k % c, row = Math.floor(k / c);
    return { id: it.id, w: it.w, d: it.d, h: it.h, x: start.x + col * pitchX, y: start.y + row * pitchY, z: start.z };
  });
}

/* align(items, axis, mode): overwrite ONE coord of every item to a shared
   value so they line up (the rank=same / collinear primitive). The OTHER
   coords are untouched. mode: 'first' (declared anchor — deterministic,
   author-controlled) | 'min' (shared near edge) | 'mean' (mass-average,
   snapped to the lattice so the shared coord stays integer, C2). */
export function align(items, axis = "y", mode = "first") {
  const co = (it) => it[axis];
  const shared =
    mode === "first" ? co(items[0]) :
    mode === "mean" ? Math.round(items.reduce((s, it) => s + co(it), 0) / items.length) :
    Math.min(...items.map(co));   // 'min'
  return items.map((it) => ({ ...it, [axis]: shared }));
}

/* centerGroup(anchors, viewBox, axis): shift a whole group so its PROJECTED
   extent centers on the canvas axis — symmetry that SURVIVES the shear (C9).
   Centering by raw grid midpoint looks off-center on screen; we measure the
   projected AABB and translate by the grid move (x+=k, y-=k) whose projection
   is a pure +screen-x shift of 2C per unit (holding screen-y), snapped to the
   lattice so anchors stay integer. (`axis` reserved; x is the screen axis.) */
export function centerGroup(anchors, viewBox, axis = "x") {
  const vb = Array.isArray(viewBox) ? viewBox : String(viewBox).split(/\s+/).map(Number);
  const bb = boxAABB(anchors.flatMap((a) => isoCorners(a.x, a.y, a.z, a.w, a.d, a.h)));
  const screenMid = vb[0] + vb[2] / 2;
  const groupMid = (bb.minX + bb.maxX) / 2;
  const dGrid = Math.round((screenMid - groupMid) / (2 * C));
  return anchors.map((a) => ({ ...a, x: a.x + dGrid, y: a.y - dGrid }));
}

/* depthSort(solids): back-to-front DRAW order so near overpaints far — the
   painter's order the Scene does NOT compute today (it emits in author order,
   so a far box can paint over a near one — the #1 "broken 3D" defect). Key =
   the near-bottom corner (x+w-1)+(y+d-1)-z (smaller = farther → drawn first);
   ties break by z then stable id so output is byte-identical (C11). Use at
   authoring time: depthSort the solids, then draw each (with its attached deco)
   in the returned order. solids: {id,x,y,z,w,d,h,...}. */
export function depthSort(solids) {
  const key = (s) => (s.x + s.w - 1) + (s.y + s.d - 1) - s.z;
  return solids.slice().sort((a, b) =>
    (key(a) - key(b)) || (a.z - b.z) || String(a.id).localeCompare(String(b.id)));
}
