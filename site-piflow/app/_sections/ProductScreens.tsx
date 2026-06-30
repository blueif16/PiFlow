"use client";

/* ============================================================
   SECTION · Function page  ·  #agents  ·  data-section="function"
   (Agent · Workflow · Memory — the three horizontal screens)
   ------------------------------------------------------------
   ProductScreens — the product section as THREE screens that
   advance HORIZONTALLY one at a time: Agents → Workflow → Memory.
   The top + bottom rails stay put (the breadcrumb label + progress
   flip per panel); only the middle band moves.

   Feel (GSAP Observer, NOT scrub): while the section is pinned,
   ONE scroll gesture = a sudden jump to exactly the next/prev
   panel — no linear in-between, and you can never blow past all
   three in one scroll. At the ends it hands control back to the
   page: from the first panel an up-gesture returns to the hero;
   from the last panel a down-gesture (or the bottom-rail arrow)
   jumps to the section after Memory (#start, the demo page).

   Gated by gsap.matchMedia to motion-safe desktop; reduced-motion
   desktop gets a hand-scrollable strip; below lg the panels stack
   and scroll vertically. Content is data-driven from
   content/products.ts. ONE orange spark per viewport (active tick).
   ============================================================ */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Observer } from "gsap/Observer";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";
import ProductMenu from "@/components/ProductMenu";
import LearnMoreButton from "@/components/LearnMoreButton";
import NodeCursor from "@/components/NodeCursor";
import ViewTransition from "@/components/ViewTransition";
import { PRODUCTS, type ProductCard } from "@/content/products";

gsap.registerPlugin(ScrollTrigger, Observer, ScrollToPlugin);

// Per-panel grid layout (lg-only). Mobile is a single stacking column.
const LAYOUT: Record<string, string> = {
  // Agents — 3 columns × 2 rows
  agents: "lg:grid-cols-3 lg:[grid-template-rows:1fr_1fr] lg:gap-4 lg:p-5",
  // Workflow — one row, 3 columns
  workflow: "lg:grid-cols-3 lg:[grid-template-rows:1fr] lg:gap-4 lg:p-5",
  // Memory — one row, 2 columns. Same normal padding/gap as the others so all
  // three pages share equal, symmetric left/right padding around the grid.
  memory: "lg:grid-cols-2 lg:[grid-template-rows:1fr] lg:gap-4 lg:p-5",
};

// Per-card illustration art (PRESENTATION → here, not products.ts). Cards with
// no entry render head-only. Tiles are produced by the pipeline in
// scripts/prep-node-tiles.sh (gray grid → flatten + split; see that header for
// the full generate→flatten→wire workflow). `ground` is the flat hex the script
// prints for that tile — the card background is set to it so the object + ground
// are one seamless surface: grey at rest, blooms orange when the card is active.
const NODE_ART: Record<string, { src: string; ground: string }> = {
  node: { src: "/nodes/node.png", ground: "#ebeaea" },
  hooks: { src: "/nodes/hooks.png", ground: "#efefef" },
  sandbox: { src: "/nodes/sandbox.png", ground: "#eeeded" },
  telemetry: { src: "/nodes/telemetry.png", ground: "#ebebeb" },
  composability: { src: "/nodes/composability.png", ground: "#ededed" },
  adaptivity: { src: "/nodes/adaptivity.png", ground: "#ededed" },
  cloud: { src: "/nodes/cloud.png", ground: "#ededed" },
  lessons: { src: "/nodes/lessons.png", ground: "#ededed" },
  functionality: { src: "/nodes/functionality.png", ground: "#ededed" },
};

// HUD silhouettes, rotated by position so neighbours never restamp one mold.
const CUTS = [
  "hud-frame [--hud-bevel:22px]",
  "hud-cut-tr [--hud-bevel:14px]",
  "hud-frame-anti [--hud-bevel:22px]",
  "hud-cut-bl [--hud-bevel:14px]",
  "hud-cut-br [--hud-bevel:14px]",
  "hud-frame [--hud-bevel:18px]",
];

// Brand glyph — inverted to the black mark on the white rail (see Hero).
function LogoMark() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/bw_icon.svg" alt="PiFlow" className="size-7 invert" />
  );
}

function GridCard({
  card,
  cut,
  morph,
}: {
  card: ProductCard;
  cut: string;
  /** active panel only → tag the title for the card→detail morph */
  morph: boolean;
}) {
  if (card.comingSoon) {
    return (
      <article
        className={`relative flex min-h-[150px] items-center justify-center ${cut} border border-[var(--hairline)] bg-[var(--surface-2)] lg:min-h-0`}
      >
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-faint">
          Coming soon
        </p>
      </article>
    );
  }

  const art = NODE_ART[card.id];

  // eyebrow + title — the shared element that morphs into the detail page.
  const head = (
    <div>
      {card.keywords.length > 0 && (
        // keyword eyebrow — takes the slot the old "P1 · 01" tag had
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-fg-faint">
          {card.keywords.join("  ·  ")}
        </p>
      )}
      <h3 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-fg sm:text-[28px]">
        {card.title}
      </h3>
    </div>
  );

  return (
    <article
      style={art ? ({ "--card-ground": art.ground } as CSSProperties) : undefined}
      className={`group relative flex min-h-[200px] flex-col overflow-hidden ${cut} border border-[var(--hairline)] ${art ? "bg-[var(--card-ground)]" : "bg-[var(--surface-1)] hover:bg-[var(--surface-2)]"} p-7 shadow-[var(--shadow-sm)] transition-[transform,border-color] hover:-translate-y-0.5 hover:border-[var(--hairline-2)] sm:p-8 lg:min-h-0`}
    >
      {/* The illustration sits in the card's BOTTOM-RIGHT, leaving the top-left
          for the title. The tile ground was flattened (prep-node-tiles.sh) and
          the card background is set to that exact ground (--card-ground), so the
          object + ground are one inseparable surface — no rectangle, no edge,
          even on hover. Tune size with the h/w-[..]; object-right-bottom anchors
          the object into the corner. */}
      {art && (
        <div className="pointer-events-none absolute bottom-0 right-0 z-0 h-[80%] w-[80%]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={art.src}
            alt=""
            aria-hidden
            className="node-art h-full w-full object-contain object-right-bottom"
          />
        </div>
      )}

      <div className="relative z-10">
        {morph ? <ViewTransition name={`node-${card.id}`}>{head}</ViewTransition> : head}
      </div>

      {/* whole-card trigger — navigates to this node's detail PAGE. Stretched
          over the article so the click target is the full card, keyboard-
          operable, and carries the orange focus ring (inset, so the card's
          overflow-hidden never clips it). data-node-trigger drives the cursor. */}
      <Link
        href={`/product/${card.id}`}
        data-node-trigger
        aria-label={`Open ${card.title}`}
        className="absolute inset-0 z-20 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
      />
    </article>
  );
}

export default function ProductScreens() {
  const rootRef = useRef<HTMLElement>(null);
  const pinRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const track = trackRef.current;
    const band = bandRef.current;
    const pin = pinRef.current;
    if (!track || !band || !pin) return;

    const n = PRODUCTS.length;
    const mm = gsap.matchMedia();

    // Motion-safe desktop → pin + Observer-driven one-panel-per-gesture jumps.
    mm.add("(min-width: 1024px) and (prefers-reduced-motion: no-preference)", () => {
      let index = 0;
      let animating = false;
      let lockUntil = 0; // swallow the gesture momentum that brought us in

      const xFor = (i: number) => -i * band.offsetWidth;

      const set = (i: number, immediate: boolean) => {
        index = i;
        setActive(i);
        if (immediate) gsap.set(track, { x: xFor(i) });
      };

      // Sudden jump to a whole panel — never a linear in-between rest.
      const goTo = (i: number) => {
        if (i < 0 || i > n - 1 || i === index) return;
        animating = true;
        set(i, false);
        gsap.to(track, {
          x: xFor(i),
          duration: 0.7,
          ease: "power3.inOut",
          overwrite: true,
          onComplete: () => {
            animating = false;
            // swallow trailing trackpad momentum so ONE flick = ONE panel
            lockUntil = performance.now() + 420;
          },
        });
      };

      // At a boundary, hand back to the page (down → #start, up → hero).
      const leave = (dir: 1 | -1) => {
        animating = true;
        obs.disable();
        gsap.to(window, {
          scrollTo: dir > 0 ? "#start" : "#top",
          duration: 0.6,
          ease: "power2.inOut",
          onComplete: () => {
            animating = false;
          },
        });
      };

      const blocked = () => animating || performance.now() < lockUntil;

      const obs = Observer.create({
        target: window,
        type: "wheel,touch",
        wheelSpeed: -1,
        tolerance: 10,
        preventDefault: true,
        onUp: () => {
          if (blocked()) return;
          index < n - 1 ? goTo(index + 1) : leave(1);
        },
        onDown: () => {
          if (blocked()) return;
          index > 0 ? goTo(index - 1) : leave(-1);
        },
      });
      obs.disable();

      const enter = (startIndex: number) => {
        set(startIndex, true);
        lockUntil = performance.now() + 450;
        animating = false;
        obs.enable();
      };

      const st = ScrollTrigger.create({
        trigger: pin,
        start: "top top",
        end: "+=" + window.innerHeight,
        pin: true,
        pinSpacing: true,
        anticipatePin: 1,
        onEnter: () => enter(0), // arrived scrolling down → first panel
        onEnterBack: () => enter(n - 1), // came back up from below → last panel
        onLeave: () => obs.disable(),
        onLeaveBack: () => obs.disable(),
      });

      const onResize = () => gsap.set(track, { x: xFor(index) });
      window.addEventListener("resize", onResize);

      return () => {
        window.removeEventListener("resize", onResize);
        obs.kill();
        st.kill();
      };
    });

    // Reduced-motion desktop → no hijack; let the strip scroll by hand.
    mm.add("(min-width: 1024px) and (prefers-reduced-motion: reduce)", () => {
      band.style.overflowX = "auto";
      return () => {
        band.style.overflowX = "";
      };
    });

    return () => mm.revert();
  }, []);

  const current = PRODUCTS[active];

  return (
    <section id="agents" ref={rootRef} data-section="function" className="relative w-full">
      {/* angular hover cursor over the node cards (desktop, motion-safe) */}
      <NodeCursor />
      <div
        ref={pinRef}
        className="relative flex h-auto w-full flex-col bg-canvas lg:h-svh"
      >
        {/* ── TOP RAIL — static; only the breadcrumb + progress change. ── */}
        <div className="z-40 flex items-stretch justify-between border-b border-[var(--hairline)] bg-[rgba(255,255,255,0.72)] backdrop-blur-xl">
          {/* the pinned widget == breadcrumb: [π] Product / {panel} */}
          <div className="flex items-center gap-1 px-4 py-2.5 sm:px-6 lg:px-10">
            <LogoMark />
            <ProductMenu />
            <span className="px-0.5 text-sm text-fg-faint" aria-hidden>
              /
            </span>
            <span className="px-1.5 text-sm font-medium text-fg">{current.name}</span>
          </div>

          {/* progress — boxed in a grid cell at the top-right: a left vertical
              hairline + the bottom divider form the grid corner. The three
              ticks are rectangular boxes; the active one is the ONE orange spark. */}
          <div className="hidden items-center gap-1.5 border-l border-[var(--hairline)] px-5 sm:flex" aria-hidden>
            {PRODUCTS.map((p, i) => (
              <span
                key={p.key}
                className={`h-2 transition-all duration-300 ${
                  i === active ? "w-6 bg-accent" : "w-2 bg-[var(--surface-4)]"
                }`}
              />
            ))}
          </div>
        </div>

        {/* ── BAND — clips the horizontal track (stepped by GSAP on desktop) ── */}
        <div ref={bandRef} className="relative flex-1 lg:overflow-hidden">
          <div ref={trackRef} className="flex flex-col lg:h-full lg:flex-row">
            {PRODUCTS.map((p, pi) => (
              // Panel width == band width (NOT 100vw, which includes the page
              // scrollbar and clips the right padding). Keeps left/right equal.
              <div key={p.key} className="w-full shrink-0 lg:h-full">
                <div
                  className={`grid h-full grid-cols-1 gap-3 p-3 sm:grid-cols-2 sm:gap-4 sm:p-4 ${LAYOUT[p.key]}`}
                >
                  {p.cards.map((c, i) => (
                    <GridCard
                      key={c.id}
                      card={c}
                      cut={CUTS[i % CUTS.length]}
                      // only the visible panel tags its titles, so off-screen
                      // panels never claim a duplicate view-transition-name
                      morph={pi === active}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── BOTTOM RAIL — the down-arrow boxed in a grid cell at the
              bottom-right: the top divider + a left vertical hairline form the
              grid corner. Jumps past the product section to #start. ── */}
        <div className="flex justify-end border-t border-[var(--hairline)]">
          <LearnMoreButton
            target="#start"
            className="flex size-12 items-center justify-center border-l border-[var(--hairline)] text-fg-muted transition-colors hover:bg-[var(--surface-2)] hover:text-fg"
          >
            <span className="sr-only">Continue past the product section</span>
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14M6 13l6 6 6-6" />
            </svg>
          </LearnMoreButton>
        </div>
      </div>
    </section>
  );
}
