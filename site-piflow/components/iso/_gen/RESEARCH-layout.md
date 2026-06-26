# Shape Placement + Iso Composition for Data-Authored Isometric SVGs

Research target: the layer ABOVE detection — deliberate placement of the SHAPES themselves (line / grid /
sparse-with-spacing) and killing isometric "awkwardness" (tilted / floating / crowded / uneven). Companion
to `RESEARCH-collision.md`, which already covers AABB detection + min-padding + 8-point LABEL placement. We
OWN the geometry: `proj(x,y,z) = [(x−y)·C, (x+y)·S − z]` with `C=cos30≈0.866`, `S=0.5` (`kit.mjs`), we already
compute each solid's screen AABB (`isoBoxAABB`), and we already have `overlaps()` + the collision-aware
`Scene`. Scenes are SMALL (<30 elements) and MUST be DETERMINISTIC (same input → byte-identical SVG; `f2`
rounds every emitted coord to 2dp). No browser / Playwright; rsvg-convert / resvg / magick present.

The thesis from six briefs converges on one sentence: **every graph-layout / constraint / packing engine you
could reach for is either Sugiyama-in-disguise or a stochastic solver — at n<30 you don't import any of them,
you PORT ~80 lines of pure arithmetic over the iso grid, do ALL spacing in grid units, project ONCE, and let
two constants (`RANK_SEP`, `NODE_SEP`) own every gap.** Placement becomes a fourth pipeline stage that runs
BEFORE our existing collision + label passes and hands them frozen, already-spaced shapes.

---

## 1. TL;DR recommendation

- **Place in GRID UNITS, project ONCE; never compute placement in screen px.** The 30° shear makes "looks
  aligned on screen" and "aligned on grid" diverge — equal grid spacing along one iso axis is regular; equal
  *screen* spacing is not. Decide everything in `(x,y,z)` integers, call `proj()` only to emit. (Briefs 2, 3,
  5 all converge here; it is the load-bearing rule.)
- **Collapse every gap in the scene to exactly two constants — `RANK_SEP` and `NODE_SEP` (iso units).** The
  entire dagre/dot/ELK "engineered" read is *uniform* separation: every adjacent pair in a row is the same
  distance, every row step is the same distance. Ad-hoc per-element gaps are the #1 source of "uneven."
  (Brief 1 §D, Brief 5 §E.)
- **Add a deterministic painter depth-sort before emit — the kit does NOT have one yet.** `Scene` currently
  pushes parts in author order, so a far box can paint over a near one. Sort solids by `key = (x+y+z)` at the
  near corner, tie-break by stable id, emit in that order. ~10 lines, kills the #1 "broken 3D" defect.
  (Briefs 3 §1.1, 4 §C, 6 §1.3.)
- **Snap + assert every anchor to an integer grid cell.** Off-grid / fractional-z placement is the canonical
  "floating ambiguously" awkwardness. `snapToGrid` + a `Number.isInteger` assert converts "vaguely placed"
  into "engineered." (Briefs 3 §1.2/M3, 4 §A, 6.)
- **Ship five tiny placement helpers** — `snapToGrid`, `rowLine`, `grid`, `align`, `distribute` — each a pure
  function returning grid anchors, each backed by a named brief, each composing with the existing `Scene`
  (place first, then `Scene.box(...)` the results, then labels). A bounded grid-nudge solver is the optional
  6th, only if a hand-authored scene ever needs auto-declutter. (Briefs 1 §B/C, 2 §b/d, 5 §2.)
- **Equalize center-PITCH, not edge-gaps, for mixed-size boxes.** Equal gaps make a row of differently-sized
  boxes look drunk; equal center-to-center pitch (≥ widest footprint + pad) reads engineered. Only when the
  two ends are pinned by the composition do you equalize *edge* gaps. (Brief 5 §3, Brief 1 §C.)
- **Compose odd masses on a triangle, not N boxes in a line; ≥1 empty grid cell between footprints; one
  orange spark.** 3 primaries is the workhorse; an evenly-spaced line of equal boxes reads as an ambiguous
  picket-fence. Negative space + odd count + the single accent IS the Daytona/aintrum signal. (Briefs 3
  §1.6, 4 §E, 6 §3.)
- **Reject every stochastic engine outright.** Force-directed (`neato`/`fdp`/`sfdp`), Penrose's L-BFGS +
  random sampling, TALA, treemap/circle-pack recursion — all iterative, seed-dependent, organic; the literal
  opposite of calm deterministic iso, and none can produce byte-identical SVG. PORT their *rules*, never their
  loops. (Briefs 1 §A/G, 2 §G, 5 §A/D.)

---

## 2. Iso composition rules — kill "awkward / tilted / floating / uneven" (CHECKLIST)

Each rule is an OBSERVABLE do/don't plus how it maps to `proj()` / the integer grid. These are eye-checkable;
several are also encodable as asserts (flagged **[assert]**).

**C1 — Consistent angle (no tilt).** Our `proj` encodes ONE iso angle by construction: every ground edge
runs at `atan2(S, C) = atan2(0.5, 0.866) = 30°`; every height edge is exactly vertical (changing only `z`
moves only screen-y). **DO** translate solids by integer grid vectors and extrude in `z` only. **DON'T**
ever rotate/skew a solid or hand-emit a 45° / 26.57° edge — a single off-slope line makes the whole scene
read tilted "in a way that's hard to pin down." **[assert]** every non-vertical emitted segment has screen
slope `±S/C ≈ ±0.577`; every height edge has `Δscreenx = 0`. (Briefs 3 §1.5/M6, 6 §1.1.)

**C2 — Grid anchoring (no float).** **DO** require every shape's base `(x,y,z)` ∈ ℤ³; a "floating" object
floats only by an *explicit integer* `z=k`, never an accidental fractional one. **DON'T** let any object sit
at a fractional/implicit z. Maps to: `snapToGrid` before placement + **[assert]** `Number.isInteger` on every
anchor. This single rule converts "vaguely placed" → "engineered." (Briefs 3 §1.2/M3, 4 §A, 6.)

**C3 — Shared ground plane.** **DO** anchor every footprint origin on an integer grid intersection at a
defined `z` (ground = `z=0`). **DON'T** place anchors off the lattice. Already half-true in the kit (boxes
take integer coords); make it a precondition. (Brief 3 §1.2, 4 §A.)

**C4 — Depth / z draw-order (no broken occlusion).** **DO** sort solids back-to-front so near overpaints far;
document order = paint order in SVG. **DON'T** emit in author order or sort by a single naïve centroid (it
breaks when a tall near box overlaps a short far one). Maps to: `depthSort` key `(x+y+z)` at the near corner,
tie-break by id (§3.6). **The kit has NO sort today — this is a real gap.** (Briefs 3 §1.1/M2, 4 §C, 6 §1.3.)

**C5 — Consistent scale (no wrong-size mass).** **DO** keep one grid unit = one screen length everywhere;
feed integer units to a single `proj()` and never per-object scale. Iso has no vanishing point — distance
does not change size. **DON'T** add any distance-based scaling. Free by construction once C2 holds. *Note on
our `proj`:* `S=0.5` foreshortens the ground but `−z` is at scale 1.0, so a `1×1×N` box renders ~2× tall per
z-unit vs a ground unit — author height deliberately (a "cube" look needs `h≈0.5·footprint`, or treat 1
z-unit as half-height). This is a craft caveat, not a bug; do NOT silently rescale `proj` (it would break
every committed SVG and the collision tests). (Brief 3 §0/M1 flags the z-stretch; we keep `proj` and author
around it.) (Briefs 3 §1.5, 4 §B.)

**C6 — Single light source (no implied second light).** **DO** apply the same fixed three-value face ramp to
every solid — `top` lightest, `left` mid, `right` darkest — keyed off face role, never per-object. The kit
already bakes this (`TOP=#fff`, `LEFT=#e7e7ee`, `RIGHT=#d8d8e0`, uniform `EDGE` stroke). **DON'T** vary
shading per object, mix light directions, or crank contrast (high contrast = toy infographic, not editorial).
Keep the ramp narrow — the thin near-black outline carries the form; shading is a whisper. (Briefs 3 §1.4/M5,
4 §F, 6 §1.6.)

**C7 — Even spacing (no uneven gaps).** **DO** make every gap one of two constants (`RANK_SEP` between rows,
`NODE_SEP` within a row), and for mixed-size boxes equalize center-PITCH not edge-gap. **DON'T** hand-pick
per-element gaps or distribute mixed-size boxes by edge gap (looks drunk). Maps to `rowLine` / `grid` /
`distribute` (§3). **[assert]** all adjacent pitches along an axis are equal. (Briefs 1 §C/D, 5 §3.)

**C8 — Negative space + odd masses (no picket fence, no crowd).** **DO** compose an ODD count of primary
masses (3 workhorse, ≤5) on a TRIANGLE, each separated by ≥1 empty grid cell. **DON'T** line N equal boxes
up at equal spacing (ambiguous picket-fence) or pack them edge-to-edge (crowding — the named enemy).
**[assert]** (a) `primaryCount` is odd; (b) primaries are NOT all axis-collinear with constant step + equal
cross-coord; (c) the 3 primary centroids are non-collinear (cross-product of the two edge vectors ≠ 0); (d)
exactly one orange element. (Briefs 3 §1.6/M8, 4 §E, 6 §3.)

**C9 — Symmetry that survives the projection.** **DO** center a group on the canvas iso-axis using the
PROJECTED group AABB (so left/right *screen* extents match), and keep cross-axis offsets palindromic.
**DON'T** center by raw grid midpoint and assume it looks centered — the shear offsets it on screen.
Asymmetric drift is the hallmark of stochastic auto-layout. Maps to `centerGroup` (§3.7). (Briefs 5 §D/§2
symmetry, 2 §a.)

**C10 — Anchoring shadow when floating (no disconnected box).** **DO** cast a flat contact shadow = the base
footprint projected to `z=0` (faint, single light dir) for any object at `z>0`; the kit's `shadow()` /
`guide()` already do this. **DON'T** float a box with no ground anchor — it reads as a placement bug, not a
design choice. For the calm bar prefer a faint contact diamond over a long cast shadow. Pick ONE mode
scene-wide (all grounded, or all floating). (Briefs 3 §1.3/M4, 4 §F, 6 §1.4.)

**C11 — Determinism (no cross-machine diff).** **DO** keep relations in grid space, snap anchors to integers
BEFORE projecting, use the one shared `C` constant, and let `f2` round at emit (already in the kit). **DON'T**
let raw `proj()` floats or a recomputed `cos30` into the SVG, and never use a stochastic placement step
without a seed. (Brief 5 §F — note the kit already satisfies this via `f2`.)

---

## 3. The SHAPE-PLACEMENT layer to add to the Scene

A new author-time stage that runs BEFORE collision + labels. It is **pure**: helpers take items + spacing
constants and RETURN grid anchors; they never draw. The caller then feeds the anchors to `Scene.box(...)`,
which registers obstacle AABBs, after which the existing 8-point label pass runs unchanged. This matches
Penrose's staged-layout discipline (Brief 5 §C): **Stage 1 place shapes (new) → Stage 2 collision (have) →
Stage 3 labels (have)**, each stage treating prior output as immutable.

**Shared types & constants** (iso units):
```
// an item to place: its footprint in grid cells. (id for stable depth-sort tie-break.)
type Item = { id, w, d, h };           // w=+x extent, d=+y extent, h=+z extent
type Anchor = { id, x, y, z, w, d, h };// placed: integer base corner + footprint
export const RANK_SEP = 3;             // gap BETWEEN rows  (the only step size between ranks)
export const NODE_SEP = 3;             // gap WITHIN a row  (between adjacent items in a rank)
```
All helpers return `Anchor[]`; compose with the kit like:
```
const placed = grid(items, 3, { gap: NODE_SEP });          // §3.3
for (const a of placed) scene.box(a.x, a.y, a.z, a.w, a.d, a.h, { r: 6 });
// labels + collision pass run exactly as today
```

### 3.1 `snapToGrid(p)` — the precondition for everything
**Places:** nothing; normalizes a free/derived point onto the integer lattice. **Why:** off-grid anchors are
the "floating/awkward" look (C2/C3). **Backed by:** Briefs 2 §c (iso-snap), 3 §1.2/M3, 4 §A, 6.
```
snapToGrid({x,y,z}) → { x: Math.round(x), y: Math.round(y), z: Math.round(z) }
```
**Screen→grid variant** (only when you must snap a *screen* point, e.g. a computed centroid — exact inverse
of our `proj` at fixed z, from Brief 2 §c):
```
// sx = (x−y)·C ;  sy = (x+y)·S − z   ⇒  solve the 2×2:
x = ( (sy + z)/S + sx/C ) / 2
y = ( (sy + z)/S − sx/C ) / 2
return { x: Math.round(x), y: Math.round(y), z }
```
(With `S=0.5` this is `x = (2(sy+z) + sx/C)/2`, matching Brief 2's specialization. Subtract any scene origin
offset BEFORE inverting — the classic iso off-by-one.) Assert helper: `assertIntegerAnchor(a)` throws if any
of `x,y,z` is non-integer (C2 [assert]).

### 3.2 `rowLine(items, axis, gap)` — a clean even line along one iso axis
**Places:** a sequence in a straight line with identical center-to-center pitch, along ONE iso grid axis
(`'x'`, `'y'`, or `'z'`). This is "place a sequence of nodes in a clean even line" = longest-path rank
(integer index) × fixed pitch. **Why even by construction:** integer index × one constant pitch cannot
produce an uneven line (C7). **Backed by:** Brief 1 §B (longest-path) + §D (rankSep) + R2; Brief 2 §e
(key-object fixed-pitch row); Brief 5 §E (`rank=same` / equal pitch).
```
rowLine(items, axis='x', gap=NODE_SEP, start={x:0,y:0,z:0}):
  // pitch is center-to-center along `axis`: widest footprint on that axis + gap (C7: equal PITCH)
  const ext = (it) => axis==='x'?it.w : axis==='y'?it.d : it.h
  const pitch = Math.max(...items.map(ext)) + gap        // uniform → no awkward line
  const dir   = axis==='x'?[1,0,0] : axis==='y'?[0,1,0] : [0,0,1]
  return items.map((it,i) => ({
    id:it.id, w:it.w, d:it.d, h:it.h,
    x: start.x + dir[0]*i*pitch,
    y: start.y + dir[1]*i*pitch,
    z: start.z + dir[2]*i*pitch,
  }))
```
**Direction-awareness (C1):** `dir` is always one of the three iso axes, so the line projects onto a true
30° (x/y) or vertical (z) screen line — never a skewed screen angle. (Brief 1 R7: the `nodeSep`/`rankSep`
axis-swap.) Use equal *pitch*, not equal gap, so mixed-size items still read engineered (Brief 5 §3).

### 3.3 `grid(items, cols, gap)` — the simple N×M grid (the "grid part")
**Places:** a bundle into a tidy lattice anchored at one corner, marching by a constant pitch on both axes —
"some in a simple grid." **Why:** integer corner + constant integer pitch ⇒ byte-identical, orthogonal, no
per-item drift (C7). **Backed by:** Brief 1 §H/R4 (`pos(i)=(col·pitch,row·pitch)`); Brief 2 §d (Tidy-Up
corner anchor + fixed pitch) + §f (`cols≈round(√N)` keeps the block square); Brief 6 (even-gutter grid).
```
grid(items, cols=Math.round(Math.sqrt(items.length)), gap=NODE_SEP, start={x:0,y:0,z:0}):
  const pitchX = Math.max(...items.map(it=>it.w)) + gap   // +x pitch (constant)
  const pitchY = Math.max(...items.map(it=>it.d)) + gap   // +y pitch (constant)
  return items.map((it,k) => {
    const c = k % cols, r = Math.floor(k / cols)
    return { id:it.id, w:it.w, d:it.d, h:it.h,
             x: start.x + c*pitchX, y: start.y + r*pitchY, z: start.z }
  })
```
`cols = round(√N)` makes the block read square rather than a long thin strip (Brief 2 §f conclusion; skip the
treemap loop — uniform footprints collapse it to √N). To CENTER the block, offset `start` by
`−((cols−1)·pitchX)/2, −((rows−1)·pitchY)/2` (Brief 2 §d). Same `gap` as `rowLine` so a line + a grid in one
scene read as one system (Brief 1 R4).

### 3.4 `align(items, axis, mode)` — share an axis (collinear row / shared edge)
**Places:** nothing new; overwrites ONE coordinate of each item to a shared value so they line up — the
`rank=same` / VPSC-alignment / Penrose-`collinear` primitive. **Why:** explicit alignment beats letting
spacing drift; the shared line is the "row" reading. **Backed by:** Brief 2 §a (VPSC block = weighted-average
axis, then snap); Brief 5 §2.4 (`alignedRow`, anchor = first declared); Brief 1 §E (barycenter as a
*centering* helper only, never a reorder).
```
align(items, axis='y', mode='first'):
  const coord = (it)=> it[axis]
  const shared =
     mode==='first' ? coord(items[0])                                  // declared anchor (ordering=out)
   : mode==='mean'  ? Math.round(items.reduce((s,it)=>s+coord(it),0)/items.length) // VPSC block avg, snapped
   : /* 'min' */      Math.min(...items.map(coord))                    // shared near edge
  return items.map(it => ({ ...it, [axis]: shared }))                  // other coords untouched
```
`mode:'first'` keeps it deterministic and author-controlled (Brief 5: anchor = first declared, like
`ordering=out`). `mode:'mean'` uses the VPSC weighted-average line "where the mass is" then `round`s to the
lattice (Brief 2 §a) — never leave a non-integer shared coord (C2). For a *screen* shared baseline of
differently-tall boxes (visually level despite shear), align on the projected AABB edge instead and back-solve
z: `z += (screenY_i − target)` since +z moves screen-y by −1 (Brief 2 §a, Brief 6 elevation rule).

### 3.5 `distribute(items, axis, gap)` — equal spacing between pinned ends
**Places:** redistributes items so spacing is equal, with the two extreme items as fixed anchors (Figma
boundary-preservation). **Why:** use when the two ends are pinned by the composition (vs `rowLine` when you
own the count). **Backed by:** Brief 2 §b (Figma distribute, equalize gaps on the *screen* AABB); Brief 5 §3
(prefer equal PITCH for mixed sizes). Two modes — `'pitch'` (default, engineered) and `'gap'` (Figma, for
pinned ends with similar sizes):
```
distribute(items, axis='x', mode='pitch'):
  const sorted = items.slice().sort((a,b)=> a[axis]-b[axis])          // stable by axis coord
  const ext = (it)=> axis==='x'?it.w : axis==='y'?it.d : it.h
  const lo = sorted[0][axis], hi = sorted[sorted.length-1][axis]
  if (mode==='pitch') {                                               // equal center pitch (C7)
    const pitch = Math.round((hi - lo) / (sorted.length - 1))
    return sorted.map((it,i)=> ({ ...it, [axis]: lo + i*pitch }))
  }
  // mode==='gap': equal edge-to-edge gap between fixed ends (Figma; only for similar sizes)
  const span = hi + ext(sorted[sorted.length-1]) - lo
  const totalExt = sorted.reduce((s,it)=> s+ext(it), 0)
  const g = Math.round((span - totalExt) / (sorted.length - 1))       // round → lattice (C2)
  let cur = lo
  return sorted.map((it)=> { const out = { ...it, [axis]: cur }; cur += ext(it) + g; return out })
```
**Gotcha (C7):** `'gap'` equalizes edge-to-edge, which for mixed-size boxes makes centers look uneven —
default to `'pitch'`. If a `'gap'` result would go below `NODE_SEP`, the footprint is overflowed: REFUSE and
fall back to `grid` or widen the frame, never auto-shrink the gap (Brief 2 §e NFDH area-lemma rule; crowding
is the enemy). Equal-gap math operates on extents in GRID units here (one axis), which is safe; only a
*screen-horizontal* row would need projected-AABB widths (Brief 2 §b) — we don't, because our rows run along
iso axes.

### 3.6 `depthSort(solids)` — deterministic painter order (THE missing kit piece)
**Places:** nothing; returns the solids in back-to-front DRAW order so near overpaints far. **Why:** `Scene`
emits in author order today, so a far box can paint over a near one — the #1 "broken 3D" defect. **Backed
by:** Brief 3 §1.1/M2 (topological occlusion as the source of truth; `(x+y)−z` as the stable seed key),
Brief 4 §C / R3 (`x+y+z`), Brief 6 §1.3 (near-corner key for multi-cell footprints + tie-break by z then id).
```
depthSort(solids):                         // solids: { id, x, y, z, w, d, h, svg }
  const key = (s) => (s.x + s.w - 1) + (s.y + s.d - 1) - s.z   // near-bottom corner; smaller = farther
  return solids.slice().sort((a,b) =>
        key(a) - key(b)                     // farther first (drawn first, overpainted by nearer)
     || a.z - b.z                           // tie: lower z drawn first
     || String(a.id).localeCompare(String(b.id)))   // stable → byte-identical
```
Two corrections from practitioners baked in: **multi-cell footprints sort on the near corner** (`+w−1`,
`+d−1`, Brief 6) not the origin; **ties break by z then stable id** (byte-identical, C11). For the rare
*cyclic* occlusion (A in front of B in front of C in front of A) this scalar can't resolve — at <30
deliberately-placed solids cycles shouldn't arise; if paranoid, port the §1.1 pairwise `isInFront` +
topological sort as the source of truth and use this key only as the tie-break seed (Brief 3 §1.1). **Wire
point:** call inside `Scene.emit()` over the registered solids before joining parts (keep deco/labels in
their current relative order). This is the one *new behavior* (not just a helper) and the highest-leverage
single change.

### 3.7 `centerGroup(anchors, viewBox, axis)` — symmetry that survives projection (C9)
**Places:** nothing; shifts a whole group of anchors so its PROJECTED extent is centered on the canvas axis.
**Why:** centering by raw grid midpoint looks off-center on screen because of the shear. **Backed by:** Brief
5 §2 (symmetry objective: `v=|canvasMid − groupMid|`, nudge to zero), Brief 2 §a, Brief 3 §1.6 (triangle/
balance).
```
centerGroup(anchors, viewBox, axis='x'):
  const corners = anchors.flatMap(a => isoCorners(a))   // 8 projected corners each (use isoBoxAABB internals)
  const bb = boxAABB(corners)                            // kit export
  const [vx,,vw] = viewBox; const screenMid = vx + vw/2
  const groupMid = (bb.minX + bb.maxX)/2
  const dScreenX = screenMid - groupMid
  // translate along a single iso axis so the move stays on-grid (C1). +x screen-shift Δ ⇒ grid x+=Δ/(2C):
  const dGrid = Math.round(dScreenX / (2*C))            // snap the shift to the lattice (C2)
  return anchors.map(a => ({ ...a, x: a.x + dGrid, y: a.y - dGrid }))  // pure +x screen translation
```
(`x+=k, y−=k` is the grid move whose projection is a pure +screen-x shift, holding screen-y — from inverting
`proj`'s x-row. Snap to integer so the group stays on-grid.) For a row, additionally require the multiset of
cross-axis offsets to be palindromic (Brief 5).

### 3.8 (OPTIONAL) `nudgeSolids(anchors, pad, K)` — bounded grid declutter
**Only if** a hand-authored scene ever needs auto-spacing of shapes (we author deliberately, so this should
rarely fire). A FIXED-iteration coordinate descent on the integer grid — NOT a solver, NO randomness — the
deterministic replacement for Penrose's L-BFGS + random sampling. **Backed by:** Brief 5 §2 (the explicit
deterministic solver), Brief 1 §F (slack/balance idea), collision §3c (the nudge it mirrors, but grid-snapped).
```
nudgeSolids(anchors, pad=NODE_SEP, K=8):
  for (let pass=0; pass<K; pass++) {                    // bounded → always terminates
    let moved = false
    for (const a of anchors) {                          // declared order (deterministic)
      for (const ax of ['x','y','z']) {                 // fixed axis order
        for (const step of [+1,-1]) {                   // one grid unit each way
          const before = totalOverlap(a, anchors, pad)
          a[ax] += step
          const after = totalOverlap(a, anchors, pad)
          if (after < before) { moved = true; break }   // accept only strict improvement
          a[ax] -= step                                 // revert
        }
      }
    }
    if (!moved) break
  }
  return anchors   // already integers → snap is a no-op
```
`totalOverlap` sums `overlapArea(isoBoxAABB(...), ...)` (kit). Deterministic (declared order, fixed axis/step
order, integer grid, strict-improvement accept) ⇒ byte-identical. This is the exterior-point insight (satisfied
pairs contribute zero) without the stochastic sampling or autodiff (Brief 5 §B). **Default: leave it OFF** —
prefer `grid`/`rowLine` construction-by-formula; reach for this only as a fixer pass.

**Composition contract (how the layer plugs in):**
1. Author picks a structure per scene (line / grid / triangle — NOT one default; Brief 5 §D, TALA "don't
   impose a hierarchy that isn't there").
2. Call the relevant helper(s) → `Anchor[]`; optionally `align` / `centerGroup` / (rarely) `nudgeSolids`.
3. `assertIntegerAnchor` every anchor (C2).
4. `scene.box(...)` each anchor → registers obstacle AABBs (existing).
5. `scene.label(...)` per shape → existing 8-point greedy places them clear (`RESEARCH-collision.md` §3a).
6. `scene.emit()` runs `depthSort` over registered solids (§3.6), then joins parts, then `f2`-rounds (C11).

---

## 4. Library / technique VERDICT TABLE

Covers every notable tool/technique surfaced across the six briefs. "Zero-dep?" = usable as PORTED pure
arithmetic in our Node string-builder (we never import these).

| Technique / tool | What it gives | Zero-dep / deterministic? | Verdict | Why for us |
|---|---|---|---|---|
| **Sugiyama 4-pass skeleton** (dagre / ELK-layered / Graphviz `dot` / mermaid / d2) | layer → order → coordinate spacing geometry | Skeleton ports as arithmetic; engines are DOM/JS | **PORT** (passes 2+4 only) | Tiny hand-DAGs: keep the spacing geometry, skip cycle-break + crossing-min |
| **Longest-path layering** | `rank=1+max(pred ranks)` → "which line am I on" | Yes, O(V+E), no iteration | **PORT** | Exactly `rowLine`'s integer rank index → even line by construction |
| **d3-dag `coordCenter`** | spread by separation + center each layer, no solver | Yes, ~10 lines | **PORT** | The even-gap-then-center primitive behind `rowLine`/`distribute` |
| **`nodesep`/`ranksep` model** (dagre/ELK/mermaid) | two-knob direction-aware separation | Yes (two constants) | **PORT** (params) | Our `NODE_SEP`/`RANK_SEP`; every gap is one of two numbers (C7) |
| **Barycenter/median crossing-reduction** | reorder a rank to cut crossings | Heuristic; tie-breaks nondeterministic | **REFERENCE** (skip reorder) | We fix author order (`ordering=out`); keep barycenter only as a 1-line *centering* helper |
| **Network-simplex rank + balance** (Graphviz `dot`) | min-cost rank assignment + pull-up-by-slack | Solver; the *rule* is portable | **REFERENCE** | Borrow "balance ranks / no stray floating box"; skip the simplex |
| **Reingold–Tilford / Buchheim tidy tree** (d3-hierarchy) | contour-tracked branching layout | Yes, deterministic | **REFERENCE / SKIP** | Overkill for line+grid; PORT only if a metaphor is a genuine fan-out tree |
| **Graphviz `osage` / d2 grid** | pack cells in a rectangle | Trivially | **PORT** | `grid(items,cols,gap)` — the simple N×M part |
| **Force-directed** (`neato`/`fdp`/`sfdp`, FR/KK springs) | organic energy-minimized layout | Iterative + stochastic | **SKIP** | Non-deterministic, organic, tilted blobs — the literal enemy |
| **VPSC / WebCola** | QP separation+alignment constraint solver | Iterative; "soft" (silently violates) | **REFERENCE** | PORT only "align = overwrite one coord to a weighted-avg line"; skip the solver |
| **Figma Distribute** (boundary-preservation) | equal gaps between pinned ends | Yes (sort + arithmetic) | **PORT** | `distribute` `'gap'` mode; but default to equal *pitch* (C7) |
| **Figma Tidy-Up** | 2D grid snap, top-left anchor | Yes | **PORT** | The corner-anchor + constant-pitch rule in `grid` |
| **Illustrator Align-to-Key-Object** | explicit-value fixed-pitch distribute | Yes, byte-identical | **PORT** | The most editorial row: `rowLine` fixed pitch, you set the rhythm |
| **d3 treemap (squarified `worst`)** | aspect-ratio test for tidy rows | Test is portable; recursion fills space | **REFERENCE** | Borrow only `cols≈√N` conclusion; drop the space-filling recursion |
| **NFDH / shelf bin-packing** | sort-by-height shelves, area lemma | Yes, O(n log n) | **REFERENCE** | Only for mixed-footprint rows; the area-lemma = "refuse, don't shrink the gap" |
| **d3.pack (front-chain + Welzl)** | organic circle packing | Order-dependent, organic | **SKIP** | Rotation-y clusters; opposite of orthogonal iso; we already have AABBs |
| **Penrose penalty primitives** (`disjoint`/`contains`/`equal`/`collinear`/`distribute`/`repel`) | closed-form constraint scalars | Each is a one-line scalar | **PORT** (primitives) | `align`/`distribute`/min-gap come straight from these |
| **Penrose runtime** (L-BFGS + random sampling + exterior-point) | the optimizer | Stochastic (random configs) | **SKIP** | Violates determinism; overkill at n<30 — use the bounded grid-nudge instead |
| **Penrose staged layout (freeze)** | order stages, freeze prior vars | Discipline, free to adopt | **PORT** | Our Stage-1 shapes → Stage-2 collision → Stage-3 labels contract (§3) |
| **Exterior-point hinge `max(0,·)²`** | satisfied constraints contribute 0 | Rule, portable | **REFERENCE** | "objectives first, hard constraints last"; one-sided so satisfied pairs go silent |
| **D2 / TALA** | structure-detecting whiteboard layout | Closed-source, per-seed random | **SKIP** (engine) / **REFERENCE** (rules) | Port "prefer symmetry" + "don't impose a hierarchy" (§C9, per-scene structure) |
| **Graphviz aesthetic levers** (`rank=same`, `ranksep …equally`, `ordering=out`, `splines=ortho`) | explicit alignment/spacing/order knobs | Rules, portable | **REFERENCE → encode** | `align`, equal-pitch `distribute`, stable declared order, ortho-by-grid |
| **Topological occlusion sort** (Shaun LeBron / IsometricBlocks) | provably-correct back-to-front order | Yes, ~40 lines, deterministic | **PORT** (or as `depthSort` source-of-truth) | Correct occlusion; our scalar key is the fast tie-break seed |
| **`(x+y+z)` painter key** (tile engines) | cheap depth scalar | Yes | **PORT** | `depthSort` near-corner key — the missing kit piece (C4) |
| **Anchoring / contact shadow** (IBM / Screaming Brain) | ground a floating box | Yes; kit `shadow()`/`guide()` exist | **PORT** (option) | Kills "floating"; faint contact diamond for the calm bar (C10) |
| **3-value face ramp + one light** (IBM / Wikibooks / Pixel Parmesan) | engineered-hardware shading | Yes; kit already bakes it | **PORT** (have it) | `TOP/LEFT/RIGHT` + uniform `EDGE`; keep ramp narrow (C6) |
| **Integer-lattice placement** (Isoflow / FossFLOW / tile engines) | nothing off-grid, ever | Model is pure data | **PORT** | `snapToGrid` + integer assert (C2/C3) — the anti-float discipline |
| **obelisk.js / footprint library** | bounded primitive set, 3-tone | Renderer is canvas; philosophy ports | **REFERENCE** | Compose from a closed footprint set (`1×1×1`, `2×1×1`, …) — engineered look |
| **SSR / JointJS face transform** (`rotate→skew→scale(1,0.86062)`) | flat motif onto an iso face | Deterministic SVG attr | **REFERENCE** (face decals only) | We get solids from `proj()` directly; use only to drop a logo/texture on a face |
| **Rule-of-Odds + triangular anchoring** (photographic canon) | odd masses on a triangle, one accent | Eye-checkable + assertable | **REFERENCE** (encode) | C8 asserts: odd count, non-collinear centroids, one orange, no picket-fence |
| **Premium-hero restraint** (Stripe/Vercel/Daytona teardown) | sparse + modular + one accent | Composition rule | **REFERENCE** | Cap primaries ~3–5, ≥1 empty cell, single spark — the brand IS restraint |
| **SVGO `floatPrecision`/`cleanupNumericValues`** | round coords for stable bytes | Rule, zero-dep | **PORT** (have it) | The kit's `f2` (2dp at emit) already is this — don't add SVGO (C11) |
| **Modeldraw fixer-pass / scoring** | post-pass even-gutter + de-overlap | A*/scoring is heuristic | **REFERENCE** | The "place then deterministic fixer" shape = our optional `nudgeSolids`; skip scoring |

---

## 5. Sources

Auto-layout engines (Sugiyama family, force, tree, grid):
- Gansner et al., *A Technique for Drawing Directed Graphs* (TSE93 — `dot`: network-simplex rank, slack/tight edges, balance, median, coordinate aux graph): https://www.graphviz.org/documentation/TSE93.pdf
- Wikipedia — *Layered graph drawing* (Sugiyama 4 steps): https://en.wikipedia.org/wiki/Layered_graph_drawing
- The Sugiyama Method (disy blog, barycenter/median step-by-step): https://blog.disy.net/sugiyama-method/
- dagre wiki (phases, ranker types, nodesep/ranksep/edgesep, Brandes–Köpf): https://github.com/dagrejs/dagre/wiki
- Brandes & Köpf — *Fast and Simple Horizontal Coordinate Assignment*: https://arxiv.org/pdf/2008.01252
- ELK — `nodeNodeBetweenLayers` spacing: https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-spacing-nodeNodeBetweenLayers.html
- ELK — `considerModelOrder.strategy` (fix input order / determinism): https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-considerModelOrder-strategy.html
- d3-dag README (layering longestPath/simplex/topological; **coordCenter** "spreads every node apart by separation and centers each layer"): https://app.unpkg.com/d3-dag@0.3.3/files/README.md
- Tamassia (ed.), *Handbook of Graph Drawing* ch.13 — longest-path layering φ(v)=max φ(u)+1: https://cs.brown.edu/people/rtamassi/gdhandbook/chapters/hierarchical.pdf
- d3-hierarchy `tree.js` (Reingold–Tilford–Buchheim firstWalk/secondWalk): https://github.com/d3/d3-hierarchy/blob/main/src/tree.js ; docs https://d3js.org/d3-hierarchy/tree
- Graphviz `neato`/`fdp` spring-model manpages (force-directed = stochastic): https://manpages.debian.org/stretch/graphviz/neato.1.en.html
- d2 layouts (dagre default vs ELK; grid as a separate system): https://d2lang.com/tour/layouts/
- Mermaid flowchart syntax/config (`nodeSpacing`/`rankSpacing`): https://mermaid.js.org/syntax/flowchart.html

Constraint + grid/packing placement:
- WebCola / cola.js (alignment, separation, soft-constraint caveat): https://ialab.it.monash.edu/webcola/ and https://github.com/tgdwyer/WebCola
- VPSC + block active-set solver (`∑wᵢ(vᵢ−dᵢ)²`, `u+gap≤v`, merge/split): https://github.com/tgdwyer/WebCola/wiki/What-is-VPSC%3F and https://www.adaptagrams.org/documentation/libvpsc.html
- Dwyer, Marriott, Stuckey — *Fast Node Overlap Removal* (block weighted-average position): https://people.eng.unimelb.edu.au/pstuckey/papers/gd2005b.pdf
- Figma Align/Distribute/Tidy-Up (boundary-preservation, top-left anchor, mode-spacing): https://help.figma.com/hc/en-us/articles/360039956914-Adjust-alignment-rotation-position-and-dimensions and https://stevekinney.com/courses/figma/aligning-objects
- Illustrator align/distribute + Key-Object precise spacing: https://iamsteve.me/blog/illustrator-quick-tip-equally-space-objects
- d3 treemap squarified (`alpha/beta/minRatio/newRatio` source): https://github.com/d3/d3-hierarchy/blob/main/src/treemap/squarify.js ; Squarified Treemaps (van Wijk et al.): https://vanwijk.win.tue.nl/stm.pdf
- NFDH / shelf bin-packing (sort-by-height, area lemma, 2·OPT+1): https://sharmaeklavya2.github.io/theoremdep/nodes/packing/geometric/nfdh/algo.html
- d3.pack front-chain + Welzl (why SKIP — order-dependent): https://d3js.org/d3-hierarchy/pack and https://observablehq.com/@d3/d3-packenclose
- Isometric grid math — screen↔grid inverse + snap, off-by-one: https://yal.cc/understanding-isometric-grids/ and https://clintbellanger.net/articles/isometric_math/

Iso projection theory + composition craft:
- Shaun LeBron — *Drawing isometric boxes in the correct order* (pairwise occlusion + topological sort): https://shaunlebron.github.io/IsometricBlocks/
- Pikuma — *Isometric Projection in Game Development*: https://pikuma.com/blog/isometric-projection-in-games
- Significant Bits — *A Layman's Guide To Projection in Videogames* (true-iso vs 2:1 dimetric): https://significant-bits.com/a-laymans-guide-to-projection-in-videogames/
- Wikipedia — *Isometric video game graphics* (30° vs 26.57° axis math): https://en.wikipedia.org/wiki/Isometric_video_game_graphics
- Wikipedia — *Painter's algorithm* (depth order = topological sort of an occlusion DAG; cyclic-overlap): https://en.wikipedia.org/wiki/Painter%27s_algorithm
- IBM Design Language — *Isometric style* (grid-snap-to-intersection, single light, floating = "airiness"): https://www.ibm.com/design/language/illustration/isometric-style/design/
- Pixel Parmesan — *Fundamentals of Isometric Pixel Art* (2:1 line rule, equal foreshortening, verticals stay vertical): https://pixelparmesan.com/blog/fundamentals-of-isometric-pixel-art
- Wikibooks — *Isometric Pixel Art / Shading the Box* (top lightest, left mid, right darkest): https://en.wikibooks.org/wiki/Isometric_Pixel_Art/Shading_the_Box
- Screaming Brain Studios — *Isometric Lighting / Shadows*: https://screamingbrainstudios.com/isometric-lighting/ and https://screamingbrainstudios.com/isometric-shadows/
- Wikipedia — *Isometric projection* (0.816 true foreshortening vs 0.577=tan30): https://en.wikipedia.org/wiki/Isometric_projection
- Digital Photography School — *The Rule of Odds*: https://digital-photography-school.com/the-rule-of-odds-in-photography-an-easy-trick-for-better-compositions/

Iso illustration tools + premium-hero teardown:
- Isoflow / FossFLOW grid + snapping model: https://ostechnix.com/fossflow-create-isometric-diagrams/ and https://isoflow.io/
- obelisk.js primitive library + 1:2 pixel projection: https://github.com/nosir/obelisk.js/
- Isometric tile→screen formula + draw order: https://nick-aschenbach.github.io/blog/2015/02/25/isometric-tile-engine/ and https://excaliburjs.com/docs/isometric/
- Iso transform math (rotate/skew/scale 0.86062) — JointJS: https://www.jointjs.com/blog/isometric-diagrams ; Illustrator SSR: https://design.tutsplus.com/tutorials/how-to-create-advanced-isometric-illustrations-using-the-ssr-method--vector-1058
- SVG `transform` reference: https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/transform
- Premium-hero restraint (Vercel grid, Rauno Freiberg): https://rauno.me/craft/vercel
- Common iso mistakes: https://www.technostructacademy.com/blog/common-mistakes-to-avoid-in-isometric-drawings/

Constraint/optimization synthesis (Penrose / D2) + clean SVG:
- Penrose SIGGRAPH 2020: https://www.cs.cmu.edu/~kmcrane/Projects/Penrose/Penrose_SIGGRAPH.pdf and https://www.cs.cmu.edu/~jssunshi/assets/pdf/penrose.pdf
- Penrose — Writing Constraints & Objectives (verbatim `disjoint`/`contains`/`equal`/`repel`): https://penrose.gitbook.io/penrose/tutorial-4-writing-constraints-and-objectives and https://penrose.cs.cmu.edu/docs/ref/constraints
- Penrose — Style Function Library (constraint/objective catalog): https://penrose.cs.cmu.edu/docs/ref/style/functions
- Penrose — Diagram Layout in Stages (staged/freeze): https://penrose.cs.cmu.edu/blog/staged-layout
- TALA — Terrastruct AutoLayout: https://terrastruct.com/tala/ and https://d2lang.com/tour/tala/
- Graphviz — Attributes (rank=same/ranksep/nodesep/ordering): https://graphviz.org/doc/info/attrs.html and https://graphviz.org/docs/attrs/ranksep/
- SVGO — cleanupNumericValues / convertPathData: https://svgo.dev/docs/plugins/cleanupNumericValues/ and https://svgo.dev/docs/plugins/convertPathData/

Practitioner pitfalls of auto-generated iso:
- Ankillous — *Isometric Depth Sorting* (near-corner key, multi-cell): https://www.ankillous.blog/article/isometric-depth-sorting
- Lumitree — *Isometric Art with Code*: https://lumitree.art/blog/isometric-art-2d5-worlds
- DEV.to (earthbound_misfit) — *Don't make the agent do the geometry*: https://dev.to/earthbound_misfit/dont-make-the-agent-do-the-geometry-4dh1
- Towards AI (Konrad Jelen) — *Stop Fixing Your AI SVGs*: https://pub.towardsai.net/stop-fixing-your-ai-svgs-715df70ccca0
- DEV.to (Martin Staufcik) — *Technical Challenges of Auto-Layout Algorithms*: https://dev.to/martin-staufcik/the-technical-challenges-of-auto-layout-algorithms-in-diagramming-tools-5a23
- Pixnote — *Isometric Pixel Art Guide (2:1)*: https://pixnote.net/en/learn/isometric/
- QWE AI Academy — *Isometric Illustrations with AI* (angle-drift failure): https://www.qwe.edu.pl/tutorial/how-to-create-isometric-illustrations-ai/
- Hacker News — *Isobuild* thread (no grid snapping = useless): https://news.ycombinator.com/item?id=22654183
- Clint Bellanger — *Isometric Tiles Introduction* (footprints, base tile sizes): https://clintbellanger.net/articles/isometric_intro/
- Laura Coyle Creative — *Isometric Illustration Tips* (even-increment spacing, locked grid): https://www.lauracoylecreative.com/illustrator-tips/isometric-illustration-tips-adobe-illustrator
