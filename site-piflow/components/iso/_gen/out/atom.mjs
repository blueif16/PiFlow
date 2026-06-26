import { writeFileSync } from "node:fs";
import * as K from "../kit.mjs";

/* ATOM — ONE agent node, drawn as a SANDBOX that is a literal GLASS BOX
   wrapping its contents. You SEE the agent INSIDE the case:

     • sandbox   — a translucent glass BOX (floor + 4 walls + top) wrapping all.
     • agent     — the orange core, centered INSIDE the box (the ONE orange spark).
     • hook-pre  — a clean upright CARD inside, screen-LEFT of the agent.
     • hook-post — its mirror CARD inside, screen-RIGHT of the agent.
     • tool-*     — chips OUTSIDE the box, wired IN through a wall (dashed tethers).
     • flow       — a whisper: a faint straight tick on the screen-horizontal.

   Symmetry trick: two grid points at the same (x+y) render at the SAME screen
   height; opposite (x−y) puts one screen-left, one screen-right → a mirrored
   pair. PRE and POST share the same x+y and have opposite x−y.

   NO checkmark / arrow glyphs on the cards (a 2D glyph on a tilted iso face
   never reads right). NO arrowheads, NO curves, NO backward edge. */

const { proj, f2, EDGE, MUTE, ORANGE, SW } = K;

/* ---------- local face helpers (same corner math as kit roundIsoBox, but each
   face is emittable on its own so the BOX can be drawn back-walls → contents →
   front-walls/top for a see-through case). All pure string-builders. ---------- */
const pt = (x, y, z) => { const [a, b] = proj(x, y, z); return `${f2(a)},${f2(b)}`; };
const poly = (corners, fill, { op = 1, stroke = EDGE, sw = SW } = {}) =>
  `<polygon points="${corners.map(([x, y, z]) => pt(x, y, z)).join(" ")}" fill="${fill}" fill-opacity="${op}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
const seg = (x1, y1, z1, x2, y2, z2, { stroke = "#fff", sw = 2, op = 0.5, dash = null } = {}) => {
  const a = proj(x1, y1, z1), b = proj(x2, y2, z2);
  return `<line x1="${f2(a[0])}" y1="${f2(a[1])}" x2="${f2(b[0])}" y2="${f2(b[1])}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
};

/* glass box faces. box spans [x,x+w]×[y,y+d]×[z,z+h].
   BACK  = floor (z) + x=0 wall + y=0 wall  (behind the contents, light fill)
   FRONT = x+w wall + y+d wall + top (z+h)  (translucent glass, in front)      */
const GLASS = "#cdd2dd";
function boxBack(b) {
  const { x, y, z, w, d, h } = b;
  const floor = poly([[x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z]], "#f3f3f6", { op: 1, sw: 1.3 });
  const wallX0 = poly([[x, y, z], [x, y + d, z], [x, y + d, z + h], [x, y, z + h]], "#ececf1", { op: 1, sw: 1.3 });
  const wallY0 = poly([[x, y, z], [x + w, y, z], [x + w, y, z + h], [x, y, z + h]], "#f1f1f5", { op: 1, sw: 1.3 });
  return floor + wallX0 + wallY0;
}
function boxFront(b) {
  const { x, y, z, w, d, h } = b;
  const wallXW = poly([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]], GLASS, { op: 0.16, sw: 1.3 });
  const wallYD = poly([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]], GLASS, { op: 0.16, sw: 1.3 });
  const top = poly([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]], GLASS, { op: 0.22, sw: 1.3 });
  const hi = seg(x + w * 0.16, y + d * 0.08, z + h, x + w * 0.6, y + d * 0.82, z + h, { op: 0.5, sw: 2 });
  return wallXW + wallYD + top + hi;
}

/* a solid little extruded box (a card or the agent), 3 visible faces. */
function solidBox(s, { accent = false } = {}) {
  const { x, y, z, w, d, h } = s;
  const tf = accent ? "#ff5a1f" : "#ffffff";
  const lf = accent ? "#ef6a2c" : "#e7e7ee";
  const rf = accent ? "#d9500f" : "#d8d8e0";
  const rightWall = poly([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]], rf);
  const leftWall = poly([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]], lf);
  const topFace = poly([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]], tf);
  return rightWall + leftWall + topFace;
}

const g = (id, body, layer) => `<g id="part-${id}" data-part="${id}"${layer ? ` data-layer="${layer}"` : ""}>${body}</g>`;

/* =========================== layout (grid units) =========================== */
// agent: centered at (40,40), footprint 28×28, height 30, on the floor.
const AG = { x: 26, y: 26, z: 0, w: 28, d: 28, h: 30 };
// glass box wraps everything: (-6,-6)..(86,86), height a bit above the agent.
const BOX = { x: -6, y: -6, z: 0, w: 92, d: 92, h: 42 };
// cards: PRE thin-in-x (screen-left), POST thin-in-y (screen-right). Same x+y.
const T = 4, L = 26, CH = 28;
const PRE = { x: 10, y: 64 - L / 2, z: 0, w: T, d: L, h: CH };   // center ~ (12, 64), x+y=76
const POST = { x: 64 - L / 2, y: 10, z: 0, w: L, d: T, h: CH };  // center ~ (64, 12), x+y=76

/* =========================== scene =========================== */
const VIEWBOX = "-215 -116 390 290";
const S = K.Scene({ viewBox: VIEWBOX, padding: 4, margin: 8, labelSize: 8.5 });

/* 1. ground shadow (deco) */
S.shadow(40, 40, 96, 50, 0.07);

/* 2+3. sandbox BACK (floor + back walls) — before contents */
S.raw(`<g id="part-sandbox" data-part="sandbox" data-layer="sandbox-back">${boxBack(BOX)}</g>`);

/* 4. CONTENTS inside the box, back→front: PRE (back-left), agent, POST (front-right) */
S.raw(g("hook-pre", solidBox(PRE)));
S.raw(g("agent", solidBox(AG, { accent: true })));
S.raw(g("hook-post", solidBox(POST)));

/* register obstacle AABBs so labels avoid the contents (raw deco isn't tracked) */
const noFill = { top: "transparent", left: "transparent", right: "transparent", stroke: "transparent", sw: 0 };
S.box(AG.x, AG.y, AG.z, AG.w, AG.d, AG.h, noFill);
S.box(PRE.x, PRE.y, PRE.z, PRE.w, PRE.d, PRE.h, noFill);
S.box(POST.x, POST.y, POST.z, POST.w, POST.d, POST.h, noFill);

/* 5+6. sandbox FRONT (translucent walls + top) — agent shows THROUGH.
   NOTE: the glass box is NOT registered as a label obstacle — it is see-through,
   so the ATOM / SANDBOX / tool labels may sit over the glass (dark text on light
   glass reads fine), letting ATOM sit right above the agent rather than escaping
   the whole box silhouette. */
S.raw(`<g data-part="sandbox" data-layer="sandbox-front">${boxFront(BOX)}</g>`);

/* 7. flow — a whisper: a mirrored pair of faint ticks on the screen-HORIZONTAL
   (grid direction (+1,−1,0) keeps screen-y constant), just outside the box at
   the agent's band: left = task in, right = verified out. No arrowhead/curve. */
S.raw(`<g id="part-flow" data-part="flow" data-layer="decor">` +
  seg(-15, 95, 0, -9, 89, 0, { stroke: EDGE, sw: 1.4, op: 0.34 }) +
  seg(95, -15, 0, 89, -9, 0, { stroke: EDGE, sw: 1.4, op: 0.34 }) +
  `</g>`);

/* tools — chips OUTSIDE the box (front), wired IN through the front (y+d) wall. */
const toolRow = [
  { id: "tool-openclaw", label: "OPENCLAW", x: 4 },
  { id: "tool-mcp", label: "MCP", x: 28 },
  { id: "tool-shell", label: "SHELL", x: 52 },
];
const CY = 106, CW = 13, CD = 13, CHp = 9;
for (const t of toolRow) {
  const chip = { x: t.x, y: CY, z: 0, w: CW, d: CD, h: CHp };
  const a = proj(t.x + CW / 2, CY, CHp);                  // chip back-top corner
  const dock = proj(t.x + CW / 2, BOX.y + BOX.d, 8);      // into the front wall
  const tether = `<path d="M ${f2(a[0])} ${f2(a[1])} L ${f2(dock[0])} ${f2(dock[1])}" fill="none" stroke="${EDGE}" stroke-width="1.1" opacity="0.4" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>`;
  S.raw(g(t.id, tether + solidBox(chip)));
  S.box(t.x, CY, 0, CW, CD, CHp, noFill);
}

/* 8. labels (Scene appends the placed <text> after all parts; we wrap them in
   a single #part-labels group via a post-pass below). */
S.label([40, 40, AG.h], "ATOM", { fill: ORANGE, side: "top", gap: 12 });
S.label([BOX.x + BOX.w, BOX.y + BOX.d, BOX.z], "SANDBOX", { fill: EDGE, side: "bottom", gap: 14 });
S.label([PRE.x, PRE.y + PRE.d, PRE.h / 2], "PRE", { fill: MUTE, side: "left", gap: 10 });
S.label([POST.x + POST.w, POST.y, POST.h / 2], "POST", { fill: MUTE, side: "right", gap: 10 });
S.label([toolRow[0].x + 6, CY + 6, CHp], "OPENCLAW", { fill: MUTE, side: "bottom", gap: 9 });
S.label([toolRow[1].x + 6, CY + 6, CHp], "MCP", { fill: MUTE, side: "bottom", gap: 9 });
S.label([toolRow[2].x + 6, CY + 6, CHp], "SHELL", { fill: MUTE, side: "bottom", gap: 9 });

/* wrap the Scene-appended label <text> elements in one named #part-labels group
   (Scene emits them as trailing top-level <text>; they are the only <text> here). */
let svg = S.emit({ w: 1000 });
const first = svg.indexOf("<text");
if (first !== -1) {
  const last = svg.lastIndexOf("</text>") + "</text>".length;
  svg = svg.slice(0, first) +
    `<g id="part-labels" data-part="labels" data-layer="decor" pointer-events="none">` +
    svg.slice(first, last) + `</g>` + svg.slice(last);
}
writeFileSync("atom.svg", svg);
console.log("atom.svg written");
