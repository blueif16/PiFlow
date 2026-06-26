# RESEARCH-interactivity.md — clickable/hoverable parts on the iso-SVG, end to end

Decision-ready synthesis of two research briefs (authoring-side + consumption-side) for making individual
parts of our hand-authored 2.5D isometric line-art SVG independently clickable/hoverable ("layer effect").
Every recommendation maps to either **(a) what the zero-dep generator emits** or **(b) the Next.js wiring**,
and obeys three hard rules: **one orange only** · **reduced-motion + pointer:fine gated** · **RSC-safe**.

**Code this is grounded in (verified):**
- `site-piflow/components/iso/iso.tsx` — `IsoBox` (line 113) already emits each solid as **one `<g>` wrapping 3 `<polygon>` faces**; pure JSX string-builder, RSC-safe, accepts `className`. **Line 11 hardcodes a stale green `const ACCENT = "#3df2a7"`** (dark-theme legacy) — it fights the one-orange rule and must be reconciled to the orange token as part of this work.
- `site-piflow/components/iso/iso-math.ts` — pure `project()` / `boxFaces()`; coords are `.toFixed(2)` so output is byte-stable/deterministic.
- `site-piflow/app/globals.css` — `--accent: #ff5a1f` (line 25), `--accent-subtle: #fff1ea` peach (line 31, the one sanctioned soft fill), focus ring `outline: 2px solid var(--accent)` (line 112–113), all `.flow/.iso-float/.draw/.blur-in` motion gated under `@media (prefers-reduced-motion: no-preference)` with a hard `animation: none !important` kill at line 455–457, and a working `:focus-within` flex-expand precedent at lines 385–389.

We **own `proj()` and the emit order**, so we can stamp any `id`/`data-*`/`<g>` wrapper at zero cost — this is the leverage most SVG-interactivity teardowns lack, and it makes every recommendation below cheap.

---

## 1. TL;DR — the decisions

1. **Each selectable part = one named `<g id="part-<slug>" data-part="<slug>">`**, slug = the metaphor name (never an array index). Our `IsoBox` is already a `<g>`; we only add the attribute. This is the whole authoring change.
2. **Add one invisible enlarged hit polygon as the LAST child of each part group** (`fill="none" pointer-events="all"`), generated free from `boxFaces()` — thin 1.6px strokes are un-hoverable without it; document-order-last = it wins the event.
3. **`pointer-events="none"` on every decorative/label/glow layer** so they never steal the cursor or fire spurious `mouseleave`.
4. **Highlight = reuse `#ff5a1f` via stroke/opacity + the `--accent-subtle` peach face fill ONLY; dim siblings via `opacity`, never `display/visibility`** (those kill events). Pure-CSS `:has()` substrate does hover-dim with zero JS; the JS island adds sticky *click* state CSS can't hold.
5. **Reconcile `iso.tsx` line 11 green `#3df2a7` → the orange token** regardless of this feature — it already violates one-orange.
6. **Next.js: keep the scene RSC; isolate ONLY state+handlers into one thin `"use client"` island.** Motion (ex-Framer-Motion) `motion.g` variants (`idle/highlighted/dimmed`) are the primary; GSAP timeline is REFERENCE — reach for it only if one click must orchestrate a sequenced multi-beat reveal. Never double-drive the same node with both.
7. **Mirror the brand gate in JS:** wrap the island in `<MotionConfig reducedMotion="user">`, gate `whileHover` behind `(hover:hover) and (pointer:fine)`, keep the *highlight/selection information* under reduced-motion and strip only the *motion* (scale/spring/Draw). a11y: each clickable `<g>` gets `role="button" tabIndex={0} aria-label aria-pressed` + Enter/Space `onKeyDown`.

---

## 2. The layer/id convention to bake into the generator NOW

This is what you apply when you **redraw the atom** so its parts (agent core, sandbox shell, PRE/POST hooks, tools, edges) are independently addressable. It costs ~one attribute per solid plus one auto-emitted polygon.

### Naming contract (put this as a comment block in `iso.tsx`)
- **Every selectable object = one `<g id="part-<slug>" data-part="<slug>" data-layer="<group>">`.**
- **Slugs are the fixed metaphor names**, never index-derived: `agent-core`, `sandbox-shell`, `hook-pre`, `hook-post`, `tool-<name>`, `edge-<from>-<to>`. (Index-derived ids churn when you reorder `COLS`; semantic slugs stay byte-stable — and `project()` already `.toFixed(2)`s coords, so the whole emit is deterministic.)
- **Child z-order INSIDE each part group, in document order:** (1) art paint (the 3 faces), (2) optional `<text pointer-events="none">` label, (3) the **hit polygon LAST** (document order = topmost = wins the pointer event).
- **Decorative groups** (orange node dot, glow overlays, joint dots, the floor grid, connector decoration) get `data-layer="decor"` + `pointer-events="none"`.

### Hit-area rule (the un-hoverable-thin-line fix)
- For a **closed iso solid**: emit the union of the visible faces as one `<polygon points={hit} fill="none" pointer-events="all" />` — painted-but-invisible (no fill is still event-visible; `pointer-events="all"` catches the whole interior). Generate `hit` for free from `boxFaces()`.
- For a **thin connector edge** (`IsoEdge`): emit a fat invisible duplicate path `stroke="transparent" stroke-width="14" pointer-events="stroke"`.

### Highlight / mask scheme
- **Dim-siblings + highlight-active = `opacity` + `stroke` swaps**, NOT `<mask>`/`<clipPath>`. For <30 already-separate polygons, masking is overkill and pixel-processed per frame. **SKIP `<mask>` for the highlight.**
- **One optional glow `<filter>` def, namespaced, applied via class** (REFERENCE tier — static, never JS-animate `stdDeviation`):
  ```xml
  <filter id="part-glow" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="2.5" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  ```
  Toggle with `.iso-part[data-active] .iso-art { filter: url(#part-glow); }`. Use `<mask>` (grayscale, feathered) ONLY for the single "detail panel reveals" moment if we ever add one — never for the per-part dim.

### Accessibility attributes
- **Decorative scene** (today's hero): keep `aria-hidden` on the `<svg>` — correct as-is, no per-part roles.
- **Interactive scene:** `<svg role="img">` + `<title>`; **each clickable `<g>`:** `role="button" tabIndex={0} aria-label="<part name>" aria-pressed={selected}` + an `onKeyDown` that fires on Enter/Space (`tabindex` alone does NOT make them fire). Reuse the brand focus ring (`outline: 2px solid var(--accent)`, globals.css:113) via `:focus-visible`. If all ~7 parts as tab-stops clutters, use one container tab-stop + `aria-activedescendant` + arrow keys. WCAG 1.4.1: never signal active by color alone — we already shift stroke-width/opacity, which satisfies it.

### SVGO hygiene (only if we ever optimize)
`cleanupIds` minifies/drops the ids our CSS/JS target. Guard with `preservePrefixes: ['part-','hit-']` (or disable `cleanupIds`); use `prefixIds` to namespace `<filter>`/gradient ids if two scenes share a page (avoid `url(#iso-top)` collisions).

### One new primitive — `IsoPart` (the only author-side API addition; zero-dep, RSC-safe)
Wraps any part's art + auto hit area; **interactive only when `onSelect` is passed**, so the same primitive serves the decorative RSC hero and the interactive client island.

```tsx
// iso.tsx — wraps a part's art + auto hit polygon; interactive iff onSelect given
export function IsoPart({ slug, label, hit, active, onSelect, children }: {
  slug: string; label?: string; hit: string;          // hit = polygon points from boxFaces()
  active?: boolean; onSelect?: (s: string) => void; children: ReactNode;
}) {
  const interactive = !!onSelect;
  return (
    <g id={`part-${slug}`} data-part={slug} data-active={active || undefined} className="iso-part"
       role={interactive ? "button" : undefined}
       tabIndex={interactive ? 0 : undefined}
       aria-label={interactive ? label : undefined}
       aria-pressed={interactive ? !!active : undefined}
       onClick={interactive ? () => onSelect!(slug) : undefined}
       onKeyDown={interactive ? (e) => {
         if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect!(slug); }
       } : undefined}>
      {children}
      {/* hit area LAST = topmost for events; painted-but-invisible */}
      <polygon points={hit} fill="none" pointerEvents="all" />
    </g>
  );
}
```

### Tiny example — the emitted markup for ONE part (agent core)
```svg
<g id="part-agent-core" data-part="agent-core" data-layer="agent" class="iso-part"
   role="button" tabindex="0" aria-label="Agent core" aria-pressed="false">
  <g class="iso-art">
    <polygon points="…right face…"  fill="url(#iso-right)" stroke="#ff5a1f" stroke-width="1.6"/>
    <polygon points="…left face…"   fill="url(#iso-left)"  stroke="#ff5a1f" stroke-width="1.6"/>
    <polygon points="…top face…"    fill="url(#iso-top)"   stroke="#ff5a1f" stroke-width="1.6"/>
  </g>
  <text pointer-events="none" font-size="13" fill="#ff5a1f">Agent core</text>
  <polygon points="…union of faces…" fill="none" pointer-events="all"/>   <!-- hit, LAST -->
</g>
```
> Note the inner `.iso-art` wrapper: it lets the highlight CSS target paint only (stroke/opacity/filter) without touching the invisible hit polygon. Faces here show `#ff5a1f` — when you redraw, retire the green `#3df2a7`.

### The interaction CSS (add to `globals.css`, single accent only, gated)
```css
.iso-part .iso-art { transition: opacity .25s ease, stroke .25s ease; }
@media (hover: hover) and (pointer: fine) {
  /* dim siblings on hover — opacity keeps pointer-events alive (display/visibility would kill them) */
  .iso-scene:hover .iso-part:not(:hover) .iso-art { opacity: .35; }
  .iso-part:hover .iso-art,
  .iso-part[data-active] .iso-art { stroke: var(--accent); }   /* the ONE accent, reused */
}
.iso-part:focus-visible { outline: none; }
.iso-part:focus-visible .iso-art { stroke: var(--accent); stroke-width: 2; }   /* reuse brand ring intent */
@media (prefers-reduced-motion: reduce) {
  .iso-part .iso-art { transition: none; }   /* state still CHANGES — only the tween is removed */
}
```

---

## 3. The Next.js interactivity pattern for port time

The illustration ships into `site-piflow/` (RSC). Keep the **scene/page as a Server Component**; isolate **only state + handlers** into one small `"use client"` island. The SVG markup is just strings — it serializes through the server fine; only `useState`/`onClick`/`useReducedMotion` force the client boundary. Pass the server-authored scene in as `children` so the static art stays RSC and the whole page doesn't become client JS.

**Motion vs GSAP:** **Motion (default).** For a state toggle (click → highlight, siblings dim, label enters/exits) Motion's `motion.g` variants + `AnimatePresence` are the ergonomic fit and animate `fill`/`opacity`/`scale` off the main thread. **GSAP is REFERENCE** — only when one click must fire a *frame-accurate sequence* (dim → scale → DrawSVG the connector → fade label, each cued off the prior's end), which Motion has no true timeline for. GSAP DrawSVG/ScrollTrigger already drives our entrance `.draw`/`.flow` classes — leave those as-is, and **never run a GSAP tween and a Motion `animate` on the same node** (they fight over the transform).

**The one concrete minimal pattern** — click a part → it highlights, label reveals, siblings dim; reduced-motion + pointer:fine safe:

```tsx
"use client";
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from "motion/react";
import { useState, useSyncExternalStore } from "react";

const PARTS = [
  { id: "agent-core",   label: "Agent core" },
  { id: "sandbox-shell",label: "Sandbox shell" },
  { id: "hook-pre",     label: "PRE hook" },
  { id: "hook-post",    label: "POST hook" },
  { id: "tools",        label: "Tools" },
];

// SSR-safe: server snapshot = false so no hydration mismatch / hover flash
function useFinePointer() {
  return useSyncExternalStore(
    (cb) => { const m = matchMedia("(hover:hover) and (pointer:fine)"); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => matchMedia("(hover:hover) and (pointer:fine)").matches,
    () => false,
  );
}

export function InteractiveIso() {
  const [selected, setSelected] = useState<string | null>(null);
  const reduce = useReducedMotion();
  const fine = useFinePointer();

  const variants = {
    idle:        { opacity: 1,   scale: 1 },
    highlighted: { opacity: 1,   scale: reduce ? 1 : 1.06 }, // motion stripped under reduced-motion; highlight stays
    dimmed:      { opacity: 0.4, scale: 1 },                 // opacity-only dim is always safe
  };

  return (
    <MotionConfig reducedMotion="user">
      <svg className="iso-scene" viewBox="0 0 600 420" fill="none" role="img" xmlns="http://www.w3.org/2000/svg">
        <title>PiFlow agent pipeline</title>
        {PARTS.map((p) => {
          const status = selected == null ? "idle" : selected === p.id ? "highlighted" : "dimmed";
          return (
            <motion.g key={p.id} data-part={p.id}
              role="button" tabIndex={0} aria-pressed={selected === p.id} aria-label={p.label}
              variants={variants} initial="idle" animate={status}
              whileHover={fine && !reduce ? { scale: 1.04 } : undefined}
              transition={{ type: "spring", stiffness: 300, damping: 26 }}
              style={{ cursor: "pointer", transformBox: "fill-box", transformOrigin: "center" }}
              onClick={() => setSelected((s) => (s === p.id ? null : p.id))}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected((s) => (s === p.id ? null : p.id)); } }}>
              {/* the IsoBox/IsoPart faces for this part — selected face may take the peach wash */}
            </motion.g>
          );
        })}

        <AnimatePresence>
          {selected && (
            <motion.g key={selected}
              initial={{ opacity: 0, y: reduce ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduce ? 0 : 6 }}>
              <rect x="20" y="380" rx="6" width="180" height="28" fill="var(--accent-subtle)"/>{/* #fff1ea peach */}
              <text x="32" y="399" fontSize="13" fill="var(--accent)">{PARTS.find(p=>p.id===selected)?.label}</text>
            </motion.g>
          )}
        </AnimatePresence>
      </svg>
    </MotionConfig>
  );
}
```

**Pure-CSS substrate (no JS, survives reduced-motion) — pair it so hover degrades gracefully before/without the island:**
```css
@media (hover:hover) and (pointer:fine) {
  .iso-scene:has([data-part]:hover) [data-part]:not(:hover) { opacity: .45; transition: opacity .2s; }
}
@media (prefers-reduced-motion: reduce) { [data-part] { transition: none; } }   /* dim stays, motion gone */
```

**Brand-fit rules baked in (piflow-web-design):** highlight = `scale` + `opacity` ONLY, **no second hue**; the *selected* face may switch fill to `--accent-subtle` (#fff1ea), the one sanctioned orange-adjacent wash; label chip = peach bg + orange text (spark stays rationed). `transformBox: "fill-box"` is REQUIRED so `transform-origin: center` is the part's own bbox, not the SVG root (without it a scaled part flies off). Mirror the dim with `:focus-within` so keyboard users get the same affordance, and reuse the brand focus ring (globals.css:112–113).

---

## 4. Verdict table

| # | Technique | What it gives | Usable in our stack? | Verdict | Why for us |
|---|---|---|---|---|---|
| A | Per-part `<g id data-part>` group | The addressable-layer unit; lets a hover on one part dim/reveal siblings | Yes — `IsoBox` is already a `<g>` | **ADOPT** | We own emit order; add one attribute, get named layers like an Illustrator export — deterministically |
| B | Invisible enlarged hit polygon (`fill:none; pointer-events:all`) | Makes thin 1.6px line-art reliably hoverable/clickable | Yes — generate from `boxFaces()` | **ADOPT** | Our strokes are too thin to hit; the hit shape is free from existing geometry |
| C | `pointer-events:none` on decor/label/glow | Stops decoration stealing the cursor / firing spurious `mouseleave` | Yes — one attribute | **ADOPT** | One-line emit on the `data-layer="decor"` group |
| D | `opacity` dim-siblings + stroke highlight (CSS-first, `data-active` for sticky) | Highlight-active / dim-rest; `opacity` keeps events alive | Yes — `:has()` + `data-active` | **ADOPT** | Cheap, reduced-motion-safe; reuses `#ff5a1f`; click state flips `data-active` from React |
| E | SVG `<filter>` glow / `<mask>` highlight | Soft glow / feathered reveal | Partly | **REFERENCE** | One STATIC glow def toggled by class is fine; filters are costly to *animate* — never JS-drive `stdDeviation`. SKIP `<mask>` for highlight |
| F | Per-part `role/tabindex/aria` vs `role="img"` | Keyboard + screen-reader access; WCAG | Yes | **ADOPT (conditional)** | Decorative hero stays `aria-hidden`; interactive scene gets roles + Enter/Space handlers |
| G | SVGO id/`data-*` hygiene (`preservePrefixes`, `prefixIds`) | Keeps our ids through optimization; avoids cross-scene id collisions | Yes — config only | **ADOPT (config)** | Only if we run SVGO; guards `part-`/`hit-` ids and namespaces shared defs |
| H | Two-layer paint/event mirror (pganalyze) | Dodge re-renders by separating paint from events | Overkill | **SKIP** | <30 deterministic elements; technique B (hit shape inside the group) gives the same benefit cheaply |
| T1 | Truly inline SVG (JSX), not `<img>`/`<use><symbol>` sprite | Real DOM node per part to attach handlers + CSS | Yes — already inline | **ADOPT** | `<img>` = opaque; `<use>` collapses the event target to the `<use>` — breaks per-part clicks |
| T2 | RSC art + thin `"use client"` island | Keeps page server-rendered; only state/handlers ship as client JS | Yes | **ADOPT** | Handlers can't live in RSC; one tight island, not the whole section |
| T3 | Single `selected/hovered` state → per-part status string | The core "click one, dim the rest" wiring | Yes | **ADOPT** | Maps cleanly onto our enumerable parts via stable `data-part` |
| T4 | CSS-only `:has()` hover-dim substrate | Hover-dim with zero JS; graceful degradation | Yes | **ADOPT** | The no-JS / reduced-motion baseline the Motion layer rides on for *click* |
| T5 | `<mask>` (feathered) vs `<clipPath>` (hard) reveal | Premium soft reveal of a detail panel | Partly | **REFERENCE** | Use a small grayscale `mask` once for a detail reveal; do dim/highlight with cheaper `opacity` |
| T6 | Motion variants + `AnimatePresence` | Ergonomic state-toggle + label enter/exit, off-main-thread | Yes — in our menu | **ADOPT (primary)** | Best fit for highlight/dim/label; `motion.g`/`motion.polygon` exist for SVG |
| T7 | GSAP timeline (+ DrawSVG) sequenced reveal | Frame-accurate multi-beat sequence on one click | Yes — in-stack | **REFERENCE** | Only for a centerpiece multi-beat sequence; Club license for DrawSVG; never co-drive with Motion |
| T8 | `MotionConfig reducedMotion="user"` + `(pointer:fine)` gate | Mirrors the CSS brand gate into JS | Yes | **ADOPT** | Brand-mandated; keep highlight info, drop motion; SSR default avoids hydration flash |

---

## 5. Sources (deduped)

**SVG interactivity / pointer-events / groups / hit areas**
- Smashing — Managing SVG Interaction With `pointer-events`: https://www.smashingmagazine.com/2018/05/svg-interaction-pointer-events-property/
- W3C — SVG 2 Interactivity / pointer-events: https://www.w3.org/TR/SVG2/interact.html
- O'Reilly *Using SVG* — interactive labels (`:hover` + opacity, events): https://oreillymedia.github.io/Using_SVG/extras/ch07-interactive-labels.html
- Peter Collingridge — SVG mouseover effects (group requirement): https://www.petercollingridge.co.uk/tutorials/svg/interactive/mouseover-effects/
- pganalyze — Building SVG components (two-layer render/interactivity): https://pganalyze.com/blog/building-svg-components-in-react

**CSS dim-siblings / `:has()` / hover-pointer gating**
- CSS-Tricks — Hover on everything but: https://css-tricks.com/hover-on-everything-but/
- Trys Mudford — Fade out siblings CSS trick: https://www.trysmudford.com/blog/fade-out-siblings-css-trick/
- Smashing — Level up CSS with `:has()`: https://www.smashingmagazine.com/2023/01/level-up-css-skills-has-selector/
- Smashing — Guide to hover/pointer media queries: https://www.smashingmagazine.com/2022/03/guide-hover-pointer-media-queries/

**Masks / clipPath / glow filter**
- Motion Tricks — SVG masks and clipPaths: https://www.motiontricks.com/svg-masks-and-clippaths/
- CSS-Tricks — Clipping and masking in CSS: https://css-tricks.com/clipping-masking-css/
- Codrops — Motion-blur / glow filter (`feGaussianBlur`+`feMerge`): https://tympanus.net/codrops/2015/04/08/motion-blur-effect-svg/

**Accessibility**
- A11Y Collective — Implementing accessible SVG (role/tabindex/aria, activedescendant): https://www.a11y-collective.com/blog/svg-accessibility/
- CSS-Tricks — Accessible SVGs (`<title>`, `role="img"`): https://css-tricks.com/accessible-svgs/
- Deque — Accessible ARIA buttons (Enter/Space handlers, name): https://www.deque.com/blog/accessible-aria-buttons/

**Next.js / React SVG · inline vs img/sprite · RSC**
- vectosolve — SVG in React/Next.js guide: https://vectosolve.com/blog/svg-in-react-nextjs-guide
- svgverseai — inline vs img vs components: https://svgverseai.com/blog/using-svg-in-nextjs-react-inline-img-components
- LogRocket — Importing SVGs in Next.js (2025): https://blog.logrocket.com/import-svgs-next-js-apps/
- Strapi — React SVG integration/animation/optimization: https://strapi.io/blog/mastering-react-svg-integration-animation-optimization
- Jacob Paris — SVG icons / `<use>` sprite event-target gotcha: https://www.jacobparis.com/content/svg-icons

**Motion (ex-Framer-Motion) · GSAP · reduced-motion**
- Motion — React motion component / RSC import (`motion/react-client`): https://motion.dev/docs/react-motion-component
- Motion — component reference: https://www.framer.com/motion/component
- Motion — animation / variants: https://www.framer.com/motion/animation/
- Motion — gestures (`whileHover`/`whileTap`, variant propagation): https://www.framer.com/motion/gestures/
- Maxime Heckel — advanced Framer Motion patterns: https://blog.maximeheckel.com/posts/advanced-animation-patterns-with-framer-motion/
- Motion — `useReducedMotion`: https://motion.dev/docs/react-use-reduced-motion
- Motion — accessibility (`MotionConfig reducedMotion`): https://motion.dev/docs/react-accessibility
- Motion — GSAP vs Motion: https://motion.dev/docs/gsap-vs-motion
- codercops — Web animation GSAP/Framer/CSS 2026: https://www.codercops.com/blog/web-animation-gsap-framer-motion-css-2026
- dev.to — Why I switched from Framer Motion to GSAP: https://dev.to/worapon_jintajirakul/why-i-switched-from-framer-motion-to-gsap-597b
- usehooks — `useMediaQuery` (SSR default): https://usehooks.com/usemediaquery

**SVGO**
- SVGO — `cleanupIds` (`preserve`/`preservePrefixes`): https://svgo.dev/docs/plugins/cleanupIds/
- SVGOMG — Clean up IDs (interactive-asset warning): https://svgomg.net/plugins/cleanup-ids/

---

### Self-check (against the OUTPUT bar — every row revised to PASS)

- **§1 TL;DR is 5–7 one-line decisions** — PASS (7 lines, each a concrete decision).
- **§2 gives exact `<g id>`/data-attr scheme, hit-area rule, mask/highlight scheme, a11y attrs, AND a tiny emitted-markup example for one part** — PASS (naming contract + hit rule + skip-mask/static-glow + a11y block + `IsoPart` + agent-core markup example).
- **§3 gives RSC-safe island, per-part click/hover state, CSS+mask highlight note, Motion-vs-GSAP recommendation, reduced-motion + pointer:fine gates, ONE concrete minimal code pattern** — PASS (island + `MotionConfig` + `useFinePointer` + `:has()` substrate, all gated).
- **Verdict table has Technique · what it gives · usable? · ADOPT/REFERENCE/SKIP · why-for-us** — PASS (5 columns; merges both briefs' A–H + T1–T8, no dupes).
- **Sources deduped** — PASS (grouped, each URL once).
- **One-orange obeyed** — PASS (every highlight uses `var(--accent)` `#ff5a1f` / `--accent-subtle` `#fff1ea`; the green `#3df2a7` is flagged for removal, never recommended).
- **Reduced-motion + RSC obeyed** — PASS (CSS `reduce` block keeps state, drops tween; JS `MotionConfig reducedMotion="user"`; scene stays RSC, only island is `"use client"`).
- **Every recommendation maps to (a) generator emit or (b) Next.js wiring; no hand-wave** — PASS (each row/section names the file, attribute, or component it touches).
