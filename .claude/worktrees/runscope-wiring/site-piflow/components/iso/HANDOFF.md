# Pi Flow Illustrations — HANDOFF (paused 2026-06-21)

**Status: PAUSED.** The iso-block illustration direction did **not** meet the bar.
**Decision:** the product is **DAG-centric** → illustrations should be **DAG diagrams**
(nodes · edges · flow), built by a **subagent**, **after the key product functions are
finalized**. Nothing here is deleted — it's kept for reuse.

## Resume trigger
When the key functions are defined, the task is: **"draw a DAG for <flow X>."**
Then: dispatch a subagent with the brief + engine + verify-harness (below) to produce one
bespoke, premium DAG per flow. Don't restart from scratch.

## Reusable assets (keep — do not remove)
- **Engine** `iso.tsx` + `iso-math.ts` — `IsoBox/IsoEdge/IsoDot/IsoPlane/IsoGrid/IsoPost`,
  pure-arithmetic iso projection, RSC-safe. A DAG = `IsoBox` nodes + `IsoEdge` connectors;
  or adapt the math for a **flat/orthogonal** DAG (decide which next time).
- **Motif** `Motif.tsx` — recolor any `/public/motifs/*.svg` via alpha-mask + tint + spin/pulse.
- **Brief (the handles)** `ILLUSTRATION-BRIEF.md` — story-first, per-section spec, animation
  catalog, 6-point self-check. The DAG subagent follows this; keep the METHOD, change the SUBJECT.
- **Verify harness** `/tmp/shot.mjs` — Playwright screenshots of sections at `localhost:3000`.
  ALWAYS screenshot + eyeball; bar = "a stranger can state the concept from the picture."
- **Research** `~/research/piflow-bespoke/leg-{a,b,c,d}.md` — library options. Decision so far:
  zero-dep engine primary; `@elchininet/isometric`, Lottie/dotLottie, AI/kits = reserved accelerators.
- **SVG library — all 298 local SVGs saved** in `public/svg-library/` (from `/Users/tk/Downloads/SVG`).
  Browse `public/svg-library/_contact-sheet.png` + `_index.md`. Families: **GRAPHS** (technical
  plots/schematics) + **MANDALA** (radial/geometric) = useful; **ART** = off-brand, skip. The
  curated in-use subset (recolored) lives in `public/motifs/`. Recolor any of them via `Motif`.

## What was tried + verdict (don't repeat the misses)
| Attempt | Verdict |
|---|---|
| iso-block scenes (Hero / Loop / Node / Compose) | ❌ rejected — too samey, reads as "blocks", not the system's language |
| glossy glow variant (gradient faces + halo) | ◐ ok lift; keep as an option |
| motif backdrops (radar / data / field / substrate) | ◐ secondary; risks reading as decoration — use sparingly or cut |
| story-brief + labeled Loop (describe→deck→serve, Hermes between two flows + memory) | ✅ right METHOD (story-first, our labels, concise, motion=meaning) · ❌ wrong SUBJECT (blocks, not a DAG) |

## The direction for next time
- **DAG diagrams are the primary visual language.** Keep what worked: story-first, our own
  labels, concise, one accent (Hermes/special nodes distinct by treatment), motion = meaning,
  screenshot-verify every illustration.
- **Open questions** (answer when functions are set): flat/orthogonal vs iso DAG; exactly which
  flows to draw; which nodes are "special" (Hermes / debug / background-tracking) and how they read.

## Current site state
- Sections currently wire the iso art + faint motifs (committed, **left in place per request** —
  not reverted). Swap per-section when DAG replacements are ready.
- Branch: `feat/piflow-illustrations`. Last checkpoint commit: `fd2726d`.
