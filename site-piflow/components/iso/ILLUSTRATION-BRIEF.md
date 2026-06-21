# Pi Flow — Illustration Brief (the "handles")

This is the **contract** every illustration (and every subagent that builds one) follows.
The rule above all rules: **an illustration must TELL ITS SECTION'S STORY.** A viewer who
reads nothing should still understand the concept from the picture. We are not decorating —
we are explaining. Borrowed SVG used "to look cool" = failure. The *details* are our design.

---

## 0. The four laws (non-negotiable)

1. **Story first.** Each illustration has ONE concept it must convey (the "story" column below).
   If a viewer can't state the concept from the picture alone, it fails — rebuild it.
2. **Variety by section.** Adjacent sections MUST use a **different primary entity** AND a
   **different signature motion**. No two sections may both be "iso cubes that float."
3. **Concise > complex.** One primary entity + at most one supporting layer + our labels.
   Strip anything that doesn't carry meaning. (The over-built DAG "topology" was wrong.)
4. **Make it ours.** Every piece carries at least one bespoke detail we authored — a data
   label, a stream, a tick, a named block. A recolored stock motif alone is never enough.

One accent only (`#3df2a7`) — distinction comes from **treatment** (glossy-solid vs wire vs
opacity tier), not a second hue. **Exception (sanctioned): the Hermes block** may use one
secondary signal so "the thing that remembers" reads as special — see §4.

---

## 1. The vocabulary (bricks you compose from)

**Iso primitives** (`@/components/iso/iso`, server-safe, author in 3D iso units):
`IsoBox` (variant `glow` = glossy gradient+halo / `wire` = outline, use `dash="3 4"` / `surface`
= neutral solid) · `IsoPlane` (platform/tile) · `IsoEdge` (`curved` connector; `len` for draw-on) ·
`IsoDot` (node marker, `ring`) · `IsoPost` (riser) · `IsoGrid` (faint floor). Math: `project/p/pt`.

**Motifs** (`@/components/iso/Motif`, recolored stock SVG via alpha-mask → accent; `tint` can be a
gradient). Curated catalog in `/public/motifs/` — **each maps to a meaning, never decorative**:
`g9` polar-radar → *listening / watching* · `g11`,`g8` 3D surface → *data / scale* · `g13` scatter
→ *evidence* · `g44` contour → *map / field* · `m4` gear → *engine* · `m6` pinwheel → *cycle* ·
`m25` aperture → *focus / a node* · `m30` hex-lattice → *substrate* · `m13` sun-spiral → *energy*.
(ART family = off-brand, never use.)

**Labels are required on the primary illustrations.** Add real text in the SVG (`<text>` via a
small helper or absolutely-positioned HTML over the scene) — tier names, block names ("Hermes",
"compose"), stream counts. Labels are what turn "a cool shape" into "our system."

---

## 2. The animation catalog (pre-built — pick ONE signature per illustration)

Each is reduced-motion-gated already. **Match the motion to the story; do not reuse the same one
on neighbouring sections.**

| Class | Motion | Use it to say |
|---|---|---|
| `draw` (+`--len`) | edge strokes on with scroll | "it is **designing / wiring** the graph" |
| `flow` | accent pulse travels a path | "**streams / data flowing** through connectors" |
| `iso-float` / `-slow` | gentle bob | "a node is **alive / running**" |
| `spin-slow` / `spin-rev` | slow rotate (motifs) | "**engine / radar / cycle** turning" |
| `pulse-soft` | opacity breathe | "**listening / heartbeat**" |
| `bar-grow` | bars rise on scroll | "**measured** result" (Findings) |

If a section needs a motion we don't have, ADD one class to `globals.css` (gated) and register it
here — don't hand-roll inline keyframes.

---

## 3. Per-section spec — the EXACT story each must tell

Each row is a build contract. **Primary entity** differs row to row; **Motion** differs row to row.

| Section | Story (what the viewer must read) | Primary entity | Signature motion | Required labels | Concise cap |
|---|---|---|---|---|---|
| **Hero** | "Describe a goal → it **builds** the workflow." | one intent → a small graph **assembling** itself | `draw` (edges build on) | none (editor carries copy) | ≤5 nodes, backdrop only |
| **Loop** ⭐ | The full cycle: **one block → a deck of composed blocks → streams flow & serve → Hermes feeds back → repeat.** | a deck of blocks + connectors + streams, with a distinct **Hermes** block | `flow` (streams) + loop-back pulse | "compose · run · improve", "Hermes" | 1 source + deck of 3–4 + 1 Hermes |
| **NodeL1** | "A node is **a full agent sealed in a box**, only the tools you grant." | ONE big sealed cube, tools docking in | tools `draw`-in + seal `iso-float` | "sealed node", 2 tool labels | 1 seal + 1 agent + 3 tools |
| **ComposeL2** | "Hand it a goal; it **draws the graph** — parallel by default." (CONCISE — not a topology) | goal block → 3 nodes via edges that **draw on** | `draw` (the act of designing) | "goal", "parallel" | 1 goal + 3 nodes + 4 edges, no grid clutter |
| **ControlL3** | "A **background brain** watches every run & remembers (Hermes)." | a watched **deck** of running blocks under a radar | `pulse-soft` (listen) + `g9` radar `spin` | "Hermes", "listener" | deck + 1 radar + Hermes distinct |
| **Findings** | "The research is blunt." (data is the story) | the real bar chart (keep) + faint `g11` data motif | `bar-grow` | numbers (have) | leave chart; motif faint |
| **Landscape** | "Where it sits." (positioning map — keep) | the 2-axis map (keep) + faint `g44` field | none (static map) | axis labels (have) | leave map; motif faint |
| **LayerCards** | 3 layers at a glance | `LayerSpot` kind per card (sealed / fan / radar) | each spot its own subtle motion | tier tag (have) | small spot |
| **Capabilities** | 7 capabilities, each legible | `CapabilitySpot` kind per cell | varied per kind | title (have) | small spot |

---

## 4. The Hermes distinction (decision)

Hermes = "the block that remembers what worked" — it should read as **special**. Options:
- **(A) Treatment-only (single accent):** Hermes = brightest glossy-solid cube + extra glow; all
  other blocks wire/surface. Stays on-system.
- **(B) One sanctioned signal hue:** Hermes uses a single warm/white-hot accent (e.g. `#ffd479`)
  ONLY on Hermes, nowhere else. Strongest "differentiator" read; one controlled exception.

Default = **A** unless the brief owner picks B.

---

## 5. Per-illustration self-check (revise every FAIL before shipping)

1. **Story test:** can a stranger state the concept from the picture alone? (If no → fail.)
2. **Distinct:** different primary entity AND different motion than the sections above/below it?
3. **Concise:** is every element load-bearing? Remove the rest.
4. **Ours:** ≥1 authored detail (label / stream / named block) — not a bare borrowed motif?
5. **Motion = meaning:** does the animation reinforce the story (not generic float)?
6. **System:** one accent (+ sanctioned Hermes signal only); hairline discipline; reduced-motion gated.

---

## 6. How a subagent recomposes (best practice)

- Compose iso primitives as DATA arrays; add `<text>`/HTML labels — that's where "ours" lives.
- Pull a motif ONLY when it maps to the concept (see §1 catalog); recolor via `<Motif>`; you may
  crop/scale/tint it and overlay iso primitives + labels on top.
- Pick exactly ONE signature motion from §2 that matches the story.
- Stay within the Concise cap. Then run §5. Return the file + a one-line "story a viewer reads."
