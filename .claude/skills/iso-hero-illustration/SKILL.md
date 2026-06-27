---
name: iso-hero-illustration
description: >-
  Method for authoring the piflow hand-authored 2.5D ISOMETRIC hero SVGs (atom = one
  node, substrate = the DAG, protein = the self-improve loop, and any new metaphor) so
  every shape AND decoration is grounded in the canonical design doc and named — never
  decorative, never illogical. TRIGGER before creating or revising ANY iso hero
  illustration under site-piflow/components/iso/: the order is DOC → named component spec
  → CONFIRM with the user → draw. Use when asked to draw/fix the atom, substrate, protein,
  add a metaphor, or when a render "looks terrible / illogical / decorative". Pairs with
  piflow-web-design (brand) + premium-saas-stack (bar); the workspace + kit + research
  live in site-piflow/components/iso/_gen/.
---

# Iso Hero Illustration — meaning-first, grounded in the design doc

These hero SVGs are HAND-AUTHORED 2.5D iso line-art for the piflow site. The recurring
failure is a picture that looks plausible but is ILLOGICAL — shapes and decoration with no
real meaning, the wrong topology (a boundary thing drawn inside the boundary), a label that
isn't the real noun. The cause is always the same: **drawing before grounding in the design
doc.** This skill forces the order so that never happens again.

## The one law
**Every object AND every decoration maps to exactly ONE real, nameable concept from the
canonical design doc.** If you cannot name it and state what it means, it does NOT go in the
picture. Meaning before pixels — decoration is not free, a wall/tether/glow each needs a
meaning or it is cut.

## 0. Setup (before anything visual)
- Load **piflow-web-design** (brand: one orange spark, white/grey light system) and
  **premium-saas-stack** (the premium bar). Load **test-discipline** if you touch the kit/Scene.
- Workspace: `site-piflow/components/iso/_gen/` — `kit.mjs` (the shared iso kit + the
  collision-aware `Scene` + the deterministic shape-placement layer), `RESEARCH-collision.md`
  / `RESEARCH-layout.md` / `RESEARCH-interactivity.md` (the methods), `collide.test.mjs` (gate).
- **Render loop is MANDATORY and you must LOOK:** `cd out && node <name>.mjs && rsvg-convert
  <name>.svg -o <name>.png -b "#f5f5f7"` then Read the PNG. Never trust a description of an
  image (yours or a subagent's) — open it and look.

## 1. Ground in the design doc FIRST (the step whose absence caused every bad render)
Find the canonical doc for the thing (per-node atom → `docs/design/node-action-protocol.md`;
the DAG/loop → their specs). Distill it into a **concise capability overview** — the few
DISTINCTIVE things a viewer should grasp, NOT baseline trivia. Cover an overview of what it
*is* and what it can *do* (a bit of the special capabilities), kept very tight. Delegate the
read-and-summarize to a subagent when the doc is long; verify the summary against the doc.
*(Per-node canonical answer: a node = an **AGENT** + its granted **TOOLS**, sealed in a
**SANDBOX**, guarded by **PRE/POST hooks at the boundary**, with **forward-only** on-failure
control. The whole metaphor is "an agent and its tools, in a sandbox.")*

## 2. Derive the minimal NAMED component set (meaning or cut)
From the overview write the spec — keep it TINY (cap ~5–7 objects):
- **COUNT** — how many components.
- **TOPOLOGY** — what contains what: what is INSIDE the boundary, what is AT the boundary,
  what is OUTSIDE. Get this right (a sandbox WRAPS the agent; hooks sit AT the entry/exit, NOT
  inside; tools are granted from OUTSIDE).
- **EACH SHAPE** — its `part-<slug>`, its one-line meaning, where it sits. Every decoration
  gets a meaning line or is CUT.
- **THE ONE ORANGE** — which single element is the live/agent spark.
Then interrogate it: can I name every object? does each carry a real meaning from the doc? is
the topology logical? Any "no" → fix before step 3.

## 3. CONFIRM the spec with the user BEFORE drawing
Show the concise spec (count · topology · each shape's meaning · the one orange) and get
explicit sign-off. **Do NOT draw until confirmed.** This is the step that prevents another
"terrible" render — it is cheaper to fix a wrong noun in text than in geometry.

## 4. Draw — named groups, through the Scene, render-verified
- Each component = a named group `<g id="part-<slug>" data-part="<slug>">` (clear · provable ·
  clickable — `RESEARCH-interactivity.md` §2).
- Place THROUGH the Scene + placement layer: deterministic collision-clean labels
  (`RESEARCH-collision.md`); shapes placed in GRID UNITS with `depthSort` + projected symmetry
  + equal pitch (`RESEARCH-layout.md`). Additive only — never break the kit's existing exports.
- Draw the actual TOPOLOGY of the concept (a container that WRAPS, a boundary you CROSS) — not
  a generic platform-with-stuff-on-top.
- ONE orange spark; light system (white tops, grey faces, thin near-black edges); minimal/no
  decoration.
- NO fragile stamped glyphs on iso faces (checkmarks/arrows render wrong on a tilted plane);
  NO backward/curved arrows (any flow cue is a tiny straight FORWARD hint — the architecture is
  forward-only); symmetry must survive the 30° shear (mirror via equal `x+y` / opposite `x−y`,
  NOT raw grid midpoints).
- Render and LOOK after EVERY change; iterate by eye.

## 5. Acceptance bar (self-check — all must PASS)
1. Every object + decoration is named and grounded in the doc (no orphan shapes).
2. Topology is semantically correct (boundary things AT the boundary; contained things inside).
3. Exactly one orange = the live/agent element.
4. Intended symmetry holds ON SCREEN; gaps even; nothing crowded; nothing clipped.
5. No stamped face-glyphs; no backward/awkward arrows.
6. Each component is a named `<g id="part-*">` group.
7. `✓ no collisions`; `collide.test` green; kit exports untouched (additive only).

GOOD vs MINIMAL: a MINIMAL pass recolors shapes and stops — it FAILS. A GOOD pass can name and
justify every mark from the design doc, and its topology reads true at a glance.

## Anti-patterns (mistakes we actually shipped — do not repeat)
- Drawing before reading the design doc → illogical, unnameable shapes.
- Decoration to "fill space" (rings, marks) with no concept behind it.
- A boundary element drawn INSIDE the boundary (PRE/POST hooks inside the sandbox).
- A platform-with-a-lid when the concept is a CONTAINER that WRAPS its contents.
- Stamping a 2D checkmark/arrow onto a tilted iso face (always renders wrong) → drop the glyph.
- Grid-symmetric placement that looks asymmetric on screen → use projected symmetry.
- Trusting a subagent's "all pass" self-report → re-render and LOOK yourself.

## References
`site-piflow/components/iso/_gen/{kit.mjs, RESEARCH-collision.md, RESEARCH-layout.md,
RESEARCH-interactivity.md, collide.test.mjs}` · per-node design source
`docs/design/node-action-protocol.md` · session state `docs/design/atom-substrate-protein-svg-HANDOFF.md`
· brand `piflow-web-design` · bar `premium-saas-stack`.
