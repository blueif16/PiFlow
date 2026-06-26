/* ============================================================
   Tests for the collision-detection + auto-spacing Scene utility.
   TEST-FIRST: these import symbols (boxAABB, labelAABB, overlaps,
   Scene) that the kit must export. Run `node --test` and watch
   them FAIL (red) before the Scene exists, then implement to green.

   A test here is meaningful ONLY if it fails when the code is wrong.
   The load-bearing test (auto-placement) proves it tests the FIX by
   first asserting the PREFERRED (unplaced) position WOULD overlap.
   ============================================================ */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  overlaps, labelAABB, boxAABB, Scene,
  // shape-placement layer (RESEARCH-layout.md §3)
  snapToGrid, assertIntegerAnchor, isoCorners, rowLine, grid, align,
  centerGroup, depthSort, NODE_SEP,
} from "./kit.mjs";

/* ---- overlaps(a,b,pad): the core AABB predicate ---- */
test("overlaps: true for overlapping rects", () => {
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const b = { minX: 5, minY: 5, maxX: 15, maxY: 15 };
  assert.equal(overlaps(a, b, 0), true);
});

test("overlaps: false for clearly separated rects", () => {
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const b = { minX: 50, minY: 50, maxX: 60, maxY: 60 };
  assert.equal(overlaps(a, b, 0), false);
});

test("overlaps: padding turns a near-miss into a hit", () => {
  // 4px gap on x. overlaps() flags pairs CLOSER than `pad`, so pad must
  // EXCEED the gap (4) to trip. pad 3 (< 4) does not; pad 5 (> 4) does.
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const b = { minX: 14, minY: 0, maxX: 24, maxY: 10 };
  assert.equal(overlaps(a, b, 0), false, "no pad: 4px gap is separated");
  assert.equal(overlaps(a, b, 3), false, "pad 3 < 4px gap: still separated");
  assert.equal(overlaps(a, b, 5), true, "pad 5 > 4px gap: now within the required clearance");
});

/* ---- labelAABB: monospace analytic box ---- */
test("labelAABB: width grows with char count", () => {
  const size = 10;
  const w3 = labelAABB(0, 0, "ABC", { anchor: "start", size });
  const w6 = labelAABB(0, 0, "ABCDEF", { anchor: "start", size });
  const width3 = w3.maxX - w3.minX, width6 = w6.maxX - w6.minX;
  assert.ok(width6 > width3, "6 chars wider than 3");
  // exact: charW = size*0.6 -> 3 chars = 18, 6 chars = 36
  assert.equal(width3, 3 * size * 0.6);
  assert.equal(width6, 6 * size * 0.6);
});

test("labelAABB: text-anchor shifts the box x-origin", () => {
  const size = 10, text = "ABCD"; // textW = 4*10*0.6 = 24
  const ax = 100;
  const start = labelAABB(ax, 0, text, { anchor: "start", size });
  const middle = labelAABB(ax, 0, text, { anchor: "middle", size });
  const end = labelAABB(ax, 0, text, { anchor: "end", size });
  assert.equal(start.minX, ax, "start: box begins at anchor");
  assert.equal(middle.minX, ax - 24 / 2, "middle: box centered on anchor");
  assert.equal(end.maxX, ax, "end: box ends at anchor");
});

test("labelAABB: vertical box straddles the baseline (ascent up, descent down)", () => {
  const size = 10, ay = 100;
  const b = labelAABB(0, ay, "X", { anchor: "start", size });
  assert.ok(b.minY < ay, "top of glyphs above baseline");
  assert.ok(b.maxY > ay, "descenders below baseline");
});

/* ---- THE LOAD-BEARING TEST: auto-placement removes a known collision ----
   A shape obstacle sits where the label's PREFERRED side would land. The
   Scene must relocate the label to a candidate that does NOT overlap the
   shape AND stays inside the viewBox. We first PROVE the unplaced/preferred
   box overlaps (so the test exercises the fix, not a no-op). */
test("Scene auto-placement: moves a label out of a known shape collision", () => {
  const viewBox = "0 0 200 200";
  const s = Scene({ viewBox, padding: 2, margin: 4, labelSize: 10 });

  // a tracked solid obstacle near screen-center. roundIsoBox at iso origin;
  // we read its registered AABB back to construct the proof.
  s.box(40, 40, 0, 40, 40, 20, { r: 4 });
  const obstacles = s.obstacles();
  assert.equal(obstacles.length, 1, "exactly one tracked obstacle registered");
  const shape = obstacles[0];

  // Anchor the label at the shape's CENTER and force its preferred side to
  // "right" with a tiny gap so the preferred box lands ON the shape.
  const cx = (shape.minX + shape.maxX) / 2, cy = (shape.minY + shape.maxY) / 2;

  // PROOF the test is meaningful: the preferred-position box (no search) overlaps.
  const preferredGap = 2;
  const preferred = labelAABB(cx + preferredGap, cy, "LABEL", { anchor: "start", size: 10 });
  assert.equal(overlaps(preferred, shape, 2), true,
    "precondition: the preferred (un-searched) label position DOES overlap the shape");

  // Now queue the label via the Scene at that same anchor/side and let emit() place it.
  s.label([cx, cy], "LABEL", { side: "right", size: 10, gap: preferredGap, anchorScreen: true });
  s.emit({ w: 200 });

  const placed = s.placedLabels();
  assert.equal(placed.length, 1);
  const box = placed[0].box;

  // (1) placed label must NOT overlap the shape (with padding)
  assert.equal(overlaps(box, shape, 2), false,
    "after placement the label no longer overlaps the shape");
  // (2) placed label must be inside the viewBox margin
  const [vx, vy, vw, vh] = viewBox.split(/\s+/).map(Number);
  assert.ok(box.minX >= vx + 4 && box.minY >= vy + 4 &&
            box.maxX <= vx + vw - 4 && box.maxY <= vy + vh - 4,
            "placed label is inside the viewBox margin");
  // (3) the residual-collision report is empty
  assert.deepEqual(s.collisions(), [], "no residual collisions after placement");
});

/* ---- deco does not become an obstacle ---- */
test("Scene: deco draws (shadow/nucleus ring/flow) do NOT register obstacles", () => {
  const s = Scene({ viewBox: "0 0 200 200", padding: 2, margin: 4, labelSize: 10 });
  s.shadow(50, 50, 30, 15);
  s.nucleus(50, 50, 0, 30, 15);
  s.flow([[0, 0, 0], [40, 40, 0]]);
  assert.equal(s.obstacles().length, 0, "no obstacle registered by pure deco");
});

/* ============================================================
   SHAPE-PLACEMENT LAYER (RESEARCH-layout.md §3) — deterministic
   helpers that PLACE the shapes in grid units BEFORE collision +
   labels. Each test is constructed to FAIL when the placement math
   is wrong (verified by mutating the impl — see the §4 self-check).
   ============================================================ */

test("snapToGrid: rounds each coord onto the integer lattice (the anti-float precondition)", () => {
  assert.deepEqual(snapToGrid({ x: 2.4, y: 3.6, z: -0.2 }), { x: 2, y: 4, z: 0 });
  assert.deepEqual(snapToGrid({ x: 5, y: 5 }), { x: 5, y: 5, z: 0 }, "z defaults to 0");
});

test("assertIntegerAnchor: throws on a non-integer coord, passes on integers", () => {
  assert.throws(() => assertIntegerAnchor({ id: "a", x: 1.5, y: 0, z: 0 }), /non-integer/);
  assert.doesNotThrow(() => assertIntegerAnchor({ id: "a", x: 1, y: 2, z: 3 }));
});

test("rowLine: equal CENTER-PITCH along one iso axis = max footprint + gap (even by construction, C7)", () => {
  const items = [{ id: "a", w: 4, d: 4, h: 4 }, { id: "b", w: 6, d: 4, h: 4 }, { id: "c", w: 2, d: 4, h: 4 }];
  const out = rowLine(items, "x", 3, { x: 0, y: 5, z: 0 });
  const pitch = 6 + 3; // max(w)=6 + gap=3  (NOT per-item width — that would drift)
  assert.deepEqual(out.map((a) => a.x), [0, pitch, 2 * pitch], "x marches by a constant pitch");
  assert.ok(out.every((a) => a.y === 5 && a.z === 0), "cross-axis coords are constant (a true straight line)");
  const steps = out.slice(1).map((a, i) => a.x - out[i].x);
  assert.ok(steps.every((s) => s === pitch), "every adjacent pitch is identical (no uneven gap)");
});

test("grid: N items into cols with a constant pitch on BOTH axes (the 'simple grid' case)", () => {
  const items = [0, 1, 2, 3].map((i) => ({ id: "n" + i, w: 4, d: 4, h: 4 }));
  const out = grid(items, 2, 2, { x: 0, y: 0, z: 0 });
  const p = 4 + 2;
  assert.deepEqual(out.map((a) => [a.x, a.y]), [[0, 0], [p, 0], [0, p], [p, p]], "row-major c*pitchX, r*pitchY");
});

test("align: 'first' shares the anchor coord, 'min' the near edge, 'mean' the snapped average; other axis untouched", () => {
  const items = [
    { id: "a", x: 0, y: 10, z: 0, w: 1, d: 1, h: 1 },
    { id: "b", x: 5, y: 3, z: 0, w: 1, d: 1, h: 1 },
    { id: "c", x: 9, y: 7, z: 0, w: 1, d: 1, h: 1 },
  ];
  assert.ok(align(items, "y", "first").every((a) => a.y === 10), "first = items[0].y");
  assert.ok(align(items, "y", "min").every((a) => a.y === 3), "min = shared near edge");
  assert.ok(align(items, "y", "mean").every((a) => a.y === Math.round((10 + 3 + 7) / 3)), "mean snapped to lattice");
  assert.deepEqual(align(items, "y", "first").map((a) => a.x), [0, 5, 9], "the OTHER axis is left alone");
});

test("depthSort: far-to-near draw order, independent of input order, deterministic tie-break", () => {
  // near = larger near-corner key (x+w-1)+(y+d-1)-z; it must sort LAST (painted on top).
  const near = { id: "near", x: 8, y: 8, z: 0, w: 2, d: 2, h: 2 };
  const far = { id: "far", x: 0, y: 0, z: 0, w: 2, d: 2, h: 2 };
  assert.deepEqual(depthSort([near, far]).map((s) => s.id), ["far", "near"], "near drawn last");
  assert.deepEqual(depthSort([far, near]).map((s) => s.id), ["far", "near"], "order independent of input order");
  const t1 = { id: "b", x: 0, y: 0, z: 0, w: 1, d: 1, h: 1 };
  const t2 = { id: "a", x: 0, y: 0, z: 0, w: 1, d: 1, h: 1 };
  assert.deepEqual(depthSort([t1, t2]).map((s) => s.id), ["a", "b"], "equal keys → stable id tie-break (byte-identical)");
});

test("centerGroup: the group's PROJECTED extent centers on the viewBox axis (symmetry that survives the shear, C9)", () => {
  const vb = [-200, -120, 400, 320]; // x,y,w,h → screen-x mid = 0
  const anchors = [
    { id: "a", x: 20, y: 0, z: 0, w: 6, d: 6, h: 6 },
    { id: "b", x: 30, y: 0, z: 0, w: 6, d: 6, h: 6 },
  ];
  const cornersOf = (as) => as.flatMap((a) => isoCorners(a.x, a.y, a.z, a.w, a.d, a.h));
  const before = boxAABB(cornersOf(anchors));
  const beforeOff = Math.abs((before.minX + before.maxX) / 2 - (vb[0] + vb[2] / 2));
  assert.ok(beforeOff > 10, "precondition: the group starts clearly off-center ON SCREEN (so this exercises the fix)");

  const centered = centerGroup(anchors, vb, "x");
  const after = boxAABB(cornersOf(centered));
  const afterOff = Math.abs((after.minX + after.maxX) / 2 - (vb[0] + vb[2] / 2));
  assert.ok(afterOff <= 1.0, `centered within ~1px of the screen axis (got ${afterOff})`);
  assert.ok(Math.abs(after.minY - before.minY) < 1e-9 && Math.abs(after.maxY - before.maxY) < 1e-9,
    "screen-y extent unchanged — the move is a pure +screen-x shift (x+=k, y-=k)");
  centered.forEach(assertIntegerAnchor); // stays on the integer lattice
});
