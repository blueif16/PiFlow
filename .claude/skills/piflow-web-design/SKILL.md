---
name: piflow-web-design
description: >
  The design system for the PiFlow marketing site (`site-piflow/`): a white/grey
  editorial field with a HARD-rationed orange accent, Geist type, an ink (not
  orange) action system, the engineering grid, the white passe-partout hero
  frame + imitated top pills, and the light iso-block illustration vocabulary.
  TRIGGER before editing or adding anything visual under `site-piflow/` — a
  section, a color, a button, type, spacing, a card, the hero, or an
  illustration; or when someone asks to "match the brand", "pick a color",
  "style a CTA", or "keep it premium/simple". Source of truth for the tokens is
  `site-piflow/app/globals.css`; this skill is the rules ON TOP of those tokens.
---

# PiFlow site design system — white/grey, orange-rationed, ink-action

The site reads as **calm editorial engineering**: a grey field, white containers,
black ink type, faint graph-paper, and a single orange spark. Reference temperature
= amp / Replicate / Vercel — high contrast, generous whitespace, monochrome
foundation, ONE accent doing all the brand work. Tokens live in
`site-piflow/app/globals.css` (`:root` + `@theme inline`); **always reuse a token,
never hardcode a hex.** This file is the discipline the tokens can't enforce.

## 0. The one law (read first): orange is the scarcest thing on the page
**Almost everything is grey & white. Orange is a spark, never a surface.** Orange
(`--accent` `#ff5a1f`) appears only as: the brand mark, ONE status/charge/active
indicator, the focus ring, and the rare inline link (`--accent-strong` `#c2410c`,
AA-safe). That's the whole budget.
- ✅ GOOD: a 3px orange charge bar; one orange node-ring; an orange focus ring; a
  1.5px orange dot in an eyebrow.
- ❌ FAIL: an orange button fill · an orange headline · an orange section background
  or wash · two+ orange elements competing in one viewport · orange body text.
- **The primary action is INK, not orange** (`--ink` `#171717`, white text, pill).
  This is the premium move; breaking it is the most common way this system goes
  cheap. The black "Start a flow" CTA is the only filled button.

A useful test: screenshot any new view, count the orange pixels. If orange reads as
a *fill* or there's more than ~one orange mark per screen, it's wrong.

## 1. Color tokens (the real values — use the names, not the hexes)
Field & ink — the whole page is built from these:
- `--canvas #f1f1f3` grey field (page floor) · `--canvas-soft #e9e9ec` sunken/wells
- `--fg #171717` ink · `--fg-muted #525252` secondary · `--fg-faint #8a8a8a` labels
- Surfaces (white containers float on the grey field): `--surface-1 #ffffff`
  (cards/panels) · `-2 #fafafa` (hover) · `-3 #f5f5f5` (inner hero panel / wells) ·
  `-4 #ebebeb` (slim tracks, dots)
- Hairlines: `--hairline rgba(0,0,0,.08)` (default line) · `--hairline-2 rgba(0,0,0,.14)`
- Action ink: `--ink #171717` · `--ink-hover #000000`

Accent (rationed per §0):
- `--accent #ff5a1f` marks/status/focus · `--accent-strong #c2410c` inline links/text
  (AA on white) · `--accent-ink #ffffff` text on the rare orange fill ·
  `--accent-subtle #fff1ea` peach wash for a selected row (rare) · `--accent-30/-60/-glow`

Tailwind utilities already wired via `@theme inline`: `bg-canvas`, `bg-canvas-soft`,
`text-fg`, `text-fg-muted`, `text-fg-faint`, `text-accent`, `text-accent-strong`,
`bg-accent`, `bg-accent-subtle`, `bg-surface-1..4`. For hairlines/shadows use the
var directly: `border-[var(--hairline)]`, `shadow-[var(--shadow-md)]`.

> The accent hex is the brand/logo orange and lives in ONE place (`--accent`). To
> retune the logo orange, change that token + `--accent-30/60/glow` — nothing else.

## 2. Typography — one family does the work
Geist Sans (UI/display) + Geist Mono (data/labels), already loaded in `layout.tsx`.
- **Display / headline:** Geist Sans, weight **600 max** (never heavier — Geist
  discipline), negative tracking that tightens with size: `-0.03em` → `-0.04em` at
  hero scale, leading `0.96–1.04`, color `--fg`. Hero title = two short lines,
  `text-6xl sm:text-7xl`.
- **Body:** 400/500, `--fg-muted`, `leading-relaxed`, ~17px; keep it short.
- **Eyebrow / label / telemetry:** Geist **Mono**, UPPERCASE, tracking `0.14–0.18em`,
  `--fg-faint`, ~11px. Mono = "this is data/system" (paths, NODE tags, TIME/CTX).
- Keep copy minimal — this system is type-forward and quiet; let whitespace carry it
  ("take the spacing that feels enough, then double it").

## 3. Buttons & pills
- `.btn-primary` — ink fill, white text, `rounded-full`, soft shadow; hover → `--ink-hover`
  + lift. The ONLY filled button.
- `.btn-ghost` — `--surface-1` fill, `--hairline-2` border, ink text, pill; hover →
  border darkens to `--fg`.
- **Nav pills (the hero pattern):** two white `--shadow-sm` pills, **angular & mirrored**
  (NOT `rounded-full` — see §4): left pill `hud-frame`, right pill `hud-frame-anti`. Left =
  dark logo chip (`bg-[var(--ink)]`, a single-corner notch via `hud-cut-tl`) + 1–2 mono-quiet
  links; right = 1 link + the black CTA nested flush at the right end (a notched key via
  `hud-cut-tr`). Vary the cuts per §4 — don't restamp one bevel across all four.
- Every interactive element needs visible hover + `:focus-visible` (orange ring, global)
  + active (`translateY(0)`); never ship a flat state-less control.

## 4. Surfaces, shadows, radius, grid — and the angular HUD geometry
- **Containers are white on the grey field**, separated by Geist *shadow-as-border*
  (`--shadow-sm/md/lg` carry a `0 0 0 1px` ring + soft drop). Don't use heavy drop
  shadows or borders alone.
- Radius ladder (curves, for soft chrome): cards `rounded-2xl` (1rem) · small chrome
  `rounded-md`. Most of the hero is now cut ANGULAR instead (below) — keep curves and
  cuts deliberate, not mixed at random.

**Angular / game-UI geometry — we obey the GUI flowmap (`packages/gui`).** Calm editorial
field, but the *surfaces and chrome are cut like a sci-fi HUD*, not soft SaaS cards. This is
BORDER/SHAPE only — the white/grey/orange color system is untouched.
- **Sci-fi rectangle.** A surface is **hard right angles with a beveled diagonal**. Utility
  `.hud-frame` (+ Tailwind `[--hud-bevel:Npx]`) bevels **top-right + bottom-left**;
  `.hud-frame-anti` bevels the **other** diagonal (TL + BR); `.hud-cut-tr|tl|br|bl` bevel a
  **single** corner. All are `border-radius:0` with a `corner-shape:bevel` enhancement that
  degrades to a hard rectangle. **Never `clip-path` a chamfer** — it eats the shadow-ring + border.
- **Vary the cut — don't stamp one mold.** This is the rule the system cares about most: give
  *neighbouring* elements different silhouettes so the chrome reads versatile. The reference
  set in `Hero.tsx`: outer frame `hud-frame` 28px · inner stage `hud-frame` 20px + brackets ·
  left nav pill `hud-frame` 14px ↔ right nav pill `hud-frame-anti` 14px (mirrored) · logo chip
  `hud-cut-tl` 7px · ink CTA `hud-cut-tr` 10px · eyebrow tag `hud-frame` 8px · code-window 12px.
  Pills/chips are NOT all `rounded-full` and NOT all the same bevel — mirror the diagonals,
  mix in single-corner notches, scale the bevel to the element. One deliberately-round element
  as a change-up is fine; a row of identical cuts is the FAIL.
- **Targeting brackets** (`.hud-corner--tl` / `--br`) ride the two SQUARE corners only — the
  beveled diagonal carries the cut, so a bracket there reads as clipped. Brackets are **INK**
  (`--fg-muted`, ~0.5 opacity), **never orange**; an *accent* bracket is reserved for a single
  focal/active element (mirrors the GUI: accent bracket = selected/running).
- Bevel scale tracks the surface (big frame → small chip), and nested frames stay roughly
  concentric. The ink button is still the only filled action (§3) even when it's a notched key.
- ✅ GOOD: a beveled frame, ink corner brackets, and a nav whose two pills mirror each other
  with a notched logo chip and a notched CTA between them. ❌ FAIL: every corner identical ·
  a `clip-path` chamfer that clips the shadow · orange brackets competing with the one spark.

- **The engineered field:** `.gridpaper` (72px graph-paper cells, masked vignette) is
  the signature texture — put it behind hero/section content, never as a loud overlay.
  `.grain` is a near-invisible paper tooth; `.aurora` is a *whisper* of warmth, not an
  orange wash. If in doubt, less.

## 5. The hero layout pattern (reference-matched) + iso illustration
Hero = grey page → **white passe-partout frame** (`max-w-[1200px] hud-frame
[--hud-bevel:28px] bg-white p-3/4 shadow-lg`) → **inner light-grey panel** (`hud-frame
[--hud-bevel:20px] bg-[var(--surface-3)]` + the two corner brackets) holding: top pills
(§3, angular & varied per §4), the iso illustration upper-right, the coding panel
lower-right, and a two-line title lower-left. See `app/_sections/Hero.tsx`.

Illustrations reuse the iso kit (`components/iso/*`, RSC-safe, author as DATA not paths).
Light recolor convention (see `HeroBlocksLight.tsx`): white tops, grey shaded sides
(`#d7d7dc`), thin near-black edges (`#202022`, `vectorEffect="non-scaling-stroke"`),
white speed-marks on the grey faces, neutral dark joint dots — and **exactly one orange
node** (the ring), per §0. Motion via the gated CSS classes (`iso-float`, `draw`, `flow`,
`blur-in`), never inline keyframes; everything must survive `prefers-reduced-motion`.

## 6. Definition of done — run this before shipping any UI change
Audit the change; every line must PASS (revise any FAIL):
1. **Orange budget:** ≤ ~1 orange mark per viewport; orange is never a fill/wash/headline;
   the primary action is ink. (§0)
2. **Tokens only:** no raw hex / no off-ladder grey — every color is a `--token`. (§1)
3. **Type:** display ≤ weight 600 with negative tracking; labels are Geist Mono uppercase;
   copy is concise. (§2)
4. **Containers:** white surface on the grey field, separated by the shadow ladder +
   hairline; surfaces are cut angular and the cuts VARY (no restamped bevel); brackets
   are ink on the square corners. (§4)
5. **States:** interactive elements have hover + focus-visible + active. (§3)
6. **Motion:** reduced-motion-safe; ambient effects stay faint. (§4–5)
7. **Contrast:** body/links meet AA (use `--accent-strong`, not `--accent`, for orange text).

GOOD vs MINIMAL: a MINIMAL change recolors to grey/white and stops — that's only half.
A GOOD change also *rations the one orange spark deliberately, keeps the action ink, and
earns its whitespace.* If the result could be any generic light SaaS theme, it failed the
brand; the editorial restraint + the single orange spark is the whole identity.
