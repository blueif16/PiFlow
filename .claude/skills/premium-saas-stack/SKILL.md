---
name: premium-saas-stack
description: >-
  Build a premium, dark, "Linear/Vercel/daytona"-grade SaaS or dev-tool frontend by composing from a
  BOUNDED MENU of vetted choices — a few locked-in premium picks per layer (tokens, type, layout,
  background effects, motion/scroll, component idioms, particles, cursor, kinetic text, optional 3D) so
  that any recomposition stays in-scope and premium and never drifts into generic. Use when someone wants
  to make a landing page / marketing site / product hero "feel premium / cool / expensive", replicate the
  dark dev-tool aesthetic, pick the right animation / shader / particle / scroll library, or stand up the
  whole stack. Triggers: "make it look premium", "dark SaaS landing page", "Linear/Vercel vibe", "which
  animation library", "premium hero", "particle background", "the entire stack", "replicate this site's feel".
---

# Premium SaaS Stack — the bounded menu

**One-line model:** "Premium" is **~70% token discipline, 20% layout, 10% effects** — no library sells you
the vibe (Linear/Vercel ship *zero* 3D and almost no effects). So this skill **locks a small vetted menu per
layer**. You COMPOSE from the menus; the union of menus IS the scope. Stay inside → output is premium by
construction. Step outside → that's drift, and it's a gated decision, not a default.

This is a capability registry for *taste*, not code: the menus are the registry, the scope fence is the
drift-gate. Lead with Layer 0 (tokens) — skipping it and reaching for effects is the #1 way "premium" collapses
into "generic dark theme with a glow on it."

## When to use / when not
- **Use** for: dark/premium marketing or product-marketing surfaces (landing, hero, feature sections, pricing),
  picking the animation/shader/particle/scroll stack, or auditing a build for "why doesn't this feel premium."
- **Not** for: light-mode/illustrative brand sites, dashboards/app UI (different rules — no smooth-scroll, no
  ambient effects), copywriting/conversion strategy, or the harvest/scraper tooling (that's a separate concern;
  scraped assets are reference only — **never ship third-party SVG/Lottie verbatim; clean-rebuild**).

## The one law (the scope fence — load-bearing)
**Compose only from the locked menus below. Introducing any library, font, effect, or color outside a menu is
DRIFT — stop and treat it as a registry change (justify it, then add it to the menu), never a silent one-off.**
A second hard rule: **restraint budgets are part of the menu** (e.g. one accent, ≤2 ambient effects per
viewport). Exceeding a budget is the same as escaping scope. This is what keeps "recompose freely" from
degrading into "kitchen-sink and generic."

## Decision procedure (the output)
Produce a concrete stack by resolving, in order:
1. **Pick the genre tier** — gates which layers are even allowed:
   - **Tier 1 · Restraint/Editorial** (Linear, Vercel, Resend): tokens + type + whitespace + grain. NO 3D, ≤1
     ambient effect, reserved motion. *Hardest to copy — it's discipline.*
   - **Tier 2 · Atmospheric** (daytona, Supabase, most YC dev tools): Tier 1 **+** one ambient background + a
     couple component idioms (animated diagram, marquee, count-up) + scroll reveals. **Default target.**
   - **Tier 3 · Immersive/3D** (awwwards/agency/launch): Tier 2 **+** WebGL shaders or Three.js/Spline + heavier
     scrollytelling. Highest wow, easiest to over-do.
2. **Pick the framework** — the deciding fork (each menu is tagged `[agnostic]` HTML/CSS/JS or `[react]`):
   - **Agnostic (HTML/CSS/SVG/JS)** — the default lean; ~90% of Tier 1–2 is reachable in pure CSS+SVG.
   - **React/Next** — unlocks the shadcn/Magic UI/Aceternity copy-paste ecosystem.
3. **Fill each layer slot** from its menu (respecting the tier gate + budgets).
4. **Run the Premium self-check** (the observable gate at the bottom). Revise every FAIL before shipping.

When in doubt, ship **Tier 2 · Agnostic** — it's the daytona target and the safest premium default.

---

## Layer 0 — Tokens & type (ALL tiers · the real source of premium)
Non-negotiable. This layer alone separates "expensive" from "generic." Lock:

| Token | Locked rule | Picks |
|-------|-------------|-------|
| **Canvas** | near-black, **never `#000`** | `#0a0a0a` (warm-neutral) **or** `#010102` (blue-cast, Linear) |
| **Accent** | **exactly one** saturated hue, used ONLY on CTA / status dot / focus ring | violet `#5e6ad2` · electric green · cyan. No second chromatic color. |
| **Elevation** | **surface ladder, not drop shadows** — 4 steps | `#0f1011 → #141516 → #18191a → #191a1b` |
| **Borders** | hairlines at **white 6–10% opacity** — present but weightless | — |
| **Type** | **one tight grotesque + one mono sibling**; negative tracking `-0.02 to -0.04em` on display | Geist + Geist Mono (free) · Inter Display + JetBrains Mono |
| **Space** | 8pt grid; **96–128px** section padding (generous = confident) | — |
| **Radius** | sharp or minimal | 0–8px (one pill scale for CTAs is allowed) |

Token starter files (paste-ready hex/font/spacing): `shadcn.io/design/linear` and `/design/vercel` (`DESIGN.md`).

## Layer 1 — Layout (ALL tiers)
- **Hero — pick ONE:** product-UI-as-hero (choreographed app UI) · code-snippet hero (dev tools) ·
  interactive-demo hero (live query/command). Must load < 1s; one primary CTA.
- **Features:** **bento grid** — size = hierarchy (one 2×2 hero cell, 1×1 supporting); uniform gutters;
  reflow-don't-shrink on mobile. `[agnostic]` CSS grid · `[react]` Magic UI / Aceternity blocks.
- **Optional (Tier 2+):** ONE scrollytelling sticky-canvas moment — used sparingly (it torches Core Web Vitals
  if overused).
- Pricing = 3 columns, minimal. Logo cloud above the fold.
- Reference galleries: Land-Book, SaaS Pages, SaaSFrame.

## Layer 2 — Background / surface effects (Tier 1: grain only · Tier 2+: grain + ONE ambient)
**Budget: ≤ 2 ambient effects per viewport. Grain is the always-on premium texture; everything else is one pick.**

| Slot | Pick | Framework |
|------|------|-----------|
| **Grain/noise** (always-on) | inline `<svg feTurbulence>` data-URI, `mix-blend-mode:overlay`, opacity ~0.03 | `[agnostic]` · `[react]` shadcn Grain |
| **ONE ambient bg** (Tier 2+) | mesh-gradient **`@paper-design/shaders`** (vanilla **and** react, zero-dep) · OR aurora (layered `radial-gradient`, animate *transform* not stops) · OR dot/retro grid | `[agnostic]`+`[react]` |
| **Card depth** | surface-ladder + hairline (Tier 1) · OR glass (`backdrop-filter:blur` + 1px chroma border) | `[agnostic]` · `[react]` Glin UI |
| **Accent glow** | conic/radial gradient in OKLCH, low opacity | `[agnostic]` |

## Layer 3 — Motion & scroll (ALL tiers)
**Rule: reserved motion. Spring physics, NOT default `ease`/linear (the Linear signature). Always gate on
`prefers-reduced-motion`.**

| Slot | Pick | Framework |
|------|------|-----------|
| **Smooth scroll** | **Lenis** (~4kb) — marketing pages only, never dashboards | `[agnostic]` (+ `lenis/react`) |
| **Scroll-bound** | **GSAP ScrollTrigger** (now free) for pin/scrub/reveal · OR native **CSS scroll-driven animations** for simple fade/parallax | `[agnostic]` |
| **Component motion** | **Motion** (ex-Framer-Motion) — spring transitions, layout animations | `[react]` |

Sync note: when using Lenis + GSAP, drive Lenis from `gsap.ticker` and `lenis.on('scroll', ScrollTrigger.update)`.

## Layer 4 — Component idioms (Tier 2+ · the "daytona vocabulary")
Pick only the idioms the page actually needs. Each: `[react]` = Magic UI / Aceternity; `[agnostic]` = rebuild
with GSAP/CSS + SVG (an animated beam is just an SVG cubic-bezier + a traveling gradient).

| Idiom | `[react]` | `[agnostic]` |
|-------|-----------|--------------|
| Animated connector / beam | Magic UI **AnimatedBeam** | SVG bezier + gradient-flow CSS, or GSAP MotionPath |
| Orbiting icons / integration hub | **OrbitingCircles** | CSS orbital |
| Logo marquee | **Marquee** | CSS keyframe marquee |
| Terminal / code window | **Terminal** (typewriter) | GSAP SplitText typewriter |
| Count-up metric | **NumberTicker** | small JS lerp |
| Node graph / DAG | **React Flow** (`@xyflow/react`) | **VizCraft** / Svelte Flow |
| Globe + arcs | Aceternity Globe | **cobe** / **three-globe** |
| SVG draw-on / morph | — | **GSAP DrawSVG / MorphSVG** (free) · Vivus · anime.js v4 |

## Layer 5 — Particles · cursor · kinetic text (the most-used families)
**Budgets: ≤ 1 particle field per page (FPS-capped); cursor effects gated on `pointer:fine`; one signature
text reveal, not on every heading.**

| Slot | Pick | Framework |
|------|------|-----------|
| **Particles (2D ambient / confetti)** | **tsParticles** — canvas, `@tsparticles/slim` default; presets: `links`/`confetti`/`fireworks`/`ribbons` | `[agnostic]` (+ `@tsparticles/react`) |
| **Particles (GPU 3D field)** → Tier 3 only | R3F + shaders (bufferGeometry/FBO) · **Three-VFX** / threeparticles (WebGPU) | `[react]`/`[agnostic]` |
| **Cursor / micro-interaction** | **mouse-animations** (<5kb: magnetic, tilt, spotlight, trail, parallax) | `[agnostic]` |
| **Magnetic (React)** | **use-magnetic** (1.3kb, a11y-first) · shadcn tilt/spotlight buttons | `[react]` |
| **Kinetic text** | **GSAP SplitText** (free, the standard; masking, autoSplit) · **Griffo** (kerning-aware) · Motion `splitText` (0.7kb) | `[agnostic]`/`[react]` |

Pick a *small* set of reveal styles (fade · blur · clip-mask stagger) and reuse them — variety reads as noise.

## Layer 6 — 3D / WebGL (Tier 3 ONLY · max 1–2 per page)
- **2.5D shader background** (mid-weight, high ROI — the "wow" without 3D models): **`@paper-design/shaders`**
  `[agnostic+react]` · **Unicorn Studio** (no-code WebGL, layer editor) · **Vanta.js** (quick 3D bg).
- **Full 3D scene** (heavy): **Three.js / React Three Fiber + Drei**, authored visually in **Spline**
  (exports React/vanilla/iframe). Cap pixel ratio (`dpr=[1,1.5]`), lazy-load, provide a CSS fallback.
- **Honesty rule:** full 3D is a *different genre*, not what makes Linear/Vercel/daytona premium. Don't reach
  for Tier 3 to rescue a weak Tier-1/2 surface — fix the tokens first.

---

## The two locked default stacks (canonical compositions)
**Agnostic · Tier 2 (the daytona default):** Geist + Geist Mono · CSS-var tokens · CSS bento · `feTurbulence`
grain + `paper-design/shaders` mesh · Lenis + GSAP (ScrollTrigger / SplitText / DrawSVG) · tsParticles ·
mouse-animations.  *(Tier 3 adds: Vanta or three.js.)*

**React · Tier 2:** shadcn + Geist · Tailwind tokens · Magic UI / Aceternity (idioms + effects) · Motion +
Lenis + GSAP · `@tsparticles/react` + use-magnetic · `@paper-design/shaders-react`.  *(Tier 3 adds: R3F + Drei
+ Spline.)*

## Premium self-check (the gate — audit before shipping; revise every FAIL)
Observable, countable criteria — not vibes:
1. Canvas is near-black, **not `#000`**; **exactly one** accent hue, and it appears ONLY on CTA / status / focus.
2. Display type carries **negative tracking** AND a **mono sibling** is present.
3. Section padding **≥ 96px**; every border is **≤ white 10%**; elevation uses the surface ladder (no heavy drop shadows).
4. **≤ 2 ambient background effects** in any one viewport; **grain present**.
5. Every animation is **spring/eased** (no default-linear) and respects **`prefers-reduced-motion`**; cursor
   effects gated on **`pointer:fine`**.
6. **Tier gate honored** (no 3D in Tier 1/2; ≤ 1 particle field; ≤ 1–2 3D scenes in Tier 3).
7. **No library/font/color used that isn't in a menu** — or, if there is, it was a logged registry change, not a one-off.

If any item FAILS, the surface is off-scope or off-premium. Fix tokens/budgets first, effects last.

## Anti-patterns (these kill "premium")
- ❌ Pure `#000` canvas · ❌ a second accent color · ❌ default letter-spacing on display type ·
  ❌ rounded-everything · ❌ 3+ stacked background effects · ❌ default-`ease`/linear motion ·
  ❌ reaching for 3D to rescue weak tokens · ❌ a different reveal style on every heading ·
  ❌ shipping a scraped third-party asset verbatim (IP — rebuild clean) ·
  ❌ adding a library outside the menu without gating it (silent drift).

## What this skill does NOT cover
Copywriting / conversion-rate strategy · backend / data · dashboards & in-app UI (different motion + density
rules) · light-mode or illustrative brand systems · the scraper/harvest pipeline · accessibility beyond the
motion/pointer gates named above (do a full a11y pass separately).

## Optimization log & open questions
- Seed menus derived from 2026-06 EXA research (Linear/Vercel/Stripe teardowns, bento/scrollytelling guides,
  GSAP/Lenis 2026 stack, paper-design/shaders, tsParticles, mouse-animations, GSAP SplitText) + a live recon of
  daytona.io (Framer + Lottie, Tier 2, near-black + single accent).
- Open: lock a default font license set for commercial use; decide whether Rive earns a slot for interactive
  state-machine motion; add a measured perf budget (LCP/CLS) per tier.
