"use client";

/* ============================================================
   ProductScreens — the product section as THREE pinned screens
   that pan HORIZONTALLY as you scroll down: Agents → Workflow →
   Memory. The top + bottom rails stay put (the breadcrumb label
   and progress flip per panel); only the middle band pans. After
   the third panel, vertical scrolling resumes.

   Mechanism: a GSAP ScrollTrigger pin + scrub, gated by
   gsap.matchMedia to motion-safe desktop. Reduced-motion desktop
   gets a hand-scrollable strip (no scroll-jack); below lg the
   panels simply stack and scroll vertically. (Ref: GSAP
   ScrollTrigger horizontal-scroll idiom — function-based end/x +
   invalidateOnRefresh.)

   Reconciliation of the fixed top-left widget: the pinned rail's
   breadcrumb IS the title — "[π] Product / {panel}" — so no heading
   is ever stacked beneath it. ONE orange spark per viewport (the
   active progress tick). Card copy is placeholder DATA — drop real
   content into AGENTS / WORKFLOW / MEMORY.
   ============================================================ */

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import ProductMenu from "@/components/ProductMenu";

gsap.registerPlugin(ScrollTrigger);

// Brand glyph — inverted to the black mark on the white rail (see Hero).
function LogoMark() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/bw_icon.svg" alt="PiFlow" className="size-7 invert" />
  );
}

type Card = { tag: string; title: string; line: string; cut: string };
type Product = {
  key: string;
  name: string;
  count: string;
  grid: string; // lg-only column/row/spacing classes for this panel
  cards: Card[];
};

// PLACEHOLDER content — real copy drops straight in. Cuts are VARIED per
// neighbour so the silhouettes never restamp one mold (design system §4).
const AGENTS: Card[] = [
  { tag: "P1 · 01", title: "Card one",   line: "One line of supporting copy lives here.", cut: "hud-frame [--hud-bevel:22px]" },
  { tag: "P1 · 02", title: "Card two",   line: "One line of supporting copy lives here.", cut: "hud-cut-tr [--hud-bevel:14px]" },
  { tag: "P1 · 03", title: "Card three", line: "One line of supporting copy lives here.", cut: "hud-frame-anti [--hud-bevel:22px]" },
  { tag: "P1 · 04", title: "Card four",  line: "One line of supporting copy lives here.", cut: "hud-cut-bl [--hud-bevel:14px]" },
  { tag: "P1 · 05", title: "Card five",  line: "One line of supporting copy lives here.", cut: "hud-cut-br [--hud-bevel:14px]" },
  { tag: "P1 · 06", title: "Card six",   line: "One line of supporting copy lives here.", cut: "hud-frame [--hud-bevel:18px]" },
];
const WORKFLOW: Card[] = [
  { tag: "P2 · 01", title: "Card one",   line: "One line of supporting copy lives here.", cut: "hud-cut-tr [--hud-bevel:16px]" },
  { tag: "P2 · 02", title: "Card two",   line: "One line of supporting copy lives here.", cut: "hud-frame [--hud-bevel:22px]" },
  { tag: "P2 · 03", title: "Card three", line: "One line of supporting copy lives here.", cut: "hud-cut-bl [--hud-bevel:16px]" },
];
const MEMORY: Card[] = [
  { tag: "P3 · 01", title: "Card one", line: "One line of supporting copy lives here.", cut: "hud-frame [--hud-bevel:26px]" },
  { tag: "P3 · 02", title: "Card two", line: "One line of supporting copy lives here.", cut: "hud-frame-anti [--hud-bevel:26px]" },
];

const PRODUCTS: Product[] = [
  // Agents — 3 columns × 2 rows
  { key: "agents", name: "Agents", count: "06", cards: AGENTS,
    grid: "lg:grid-cols-3 lg:[grid-template-rows:1fr_1fr] lg:gap-4 lg:p-5" },
  // Workflow — one row, 3 columns
  { key: "workflow", name: "Workflow", count: "03", cards: WORKFLOW,
    grid: "lg:grid-cols-3 lg:[grid-template-rows:1fr] lg:gap-4 lg:p-5" },
  // Memory — one row, 2 columns, roomier (each card occupies more space)
  { key: "memory", name: "Memory", count: "02", cards: MEMORY,
    grid: "lg:grid-cols-2 lg:[grid-template-rows:1fr] lg:gap-6 lg:p-8" },
];

function GridCard({ card }: { card: Card }) {
  return (
    <article
      className={`group relative flex min-h-[200px] flex-col justify-between ${card.cut} border border-[var(--hairline)] bg-[var(--surface-1)] p-7 shadow-[var(--shadow-sm)] transition-[transform,border-color,background] hover:-translate-y-0.5 hover:border-[var(--hairline-2)] hover:bg-[var(--surface-2)] sm:p-8 lg:min-h-0`}
    >
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-fg-faint">
          {card.tag}
        </p>
        <h3 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-fg sm:text-[28px]">
          {card.title}
        </h3>
      </div>
      <p className="mt-6 max-w-[36ch] text-[15px] leading-relaxed text-fg-muted">
        {card.line}
      </p>
      {/* illustration slot — reserved bottom-right for an iso motif later */}
      <span aria-hidden className="pointer-events-none absolute bottom-6 right-6 size-12" />
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

    const mm = gsap.matchMedia();

    // Motion-safe desktop → pin the screen and scrub the track horizontally.
    mm.add("(min-width: 1024px) and (prefers-reduced-motion: no-preference)", () => {
      const distance = () => track.scrollWidth - band.offsetWidth;
      const tween = gsap.to(track, {
        x: () => -distance(),
        ease: "none",
        scrollTrigger: {
          trigger: pin,
          pin: pin,
          start: "top top",
          end: () => "+=" + distance(),
          scrub: 1,
          invalidateOnRefresh: true,
          onUpdate: (self) => {
            const i = Math.round(self.progress * (PRODUCTS.length - 1));
            setActive((prev) => (prev === i ? prev : i));
          },
        },
      });
      return () => tween.kill();
    });

    // Reduced-motion desktop → no pin/scroll-jack; let the strip scroll by hand.
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
    <section id="agents" ref={rootRef} className="relative w-full">
      <div
        ref={pinRef}
        className="relative flex h-auto w-full flex-col bg-canvas lg:h-svh"
      >
        {/* ── TOP RAIL — static across all three panels; the breadcrumb
              label + progress are the only things that change. ── */}
        <div className="z-40 flex items-center justify-between gap-4 border-b border-[var(--hairline)] bg-[rgba(255,255,255,0.72)] px-4 py-2.5 backdrop-blur-xl sm:px-6 lg:px-10">
          {/* the pinned widget == breadcrumb: [π] Product / {panel} */}
          <div className="flex items-center gap-1">
            <LogoMark />
            <ProductMenu />
            <span className="px-0.5 text-sm text-fg-faint" aria-hidden>
              /
            </span>
            <span className="px-1.5 text-sm font-medium text-fg">{current.name}</span>
          </div>

          {/* progress — the active tick is the ONE orange spark in this viewport */}
          <div className="flex items-center gap-4">
            <div className="hidden items-center gap-1.5 sm:flex" aria-hidden>
              {PRODUCTS.map((p, i) => (
                <span
                  key={p.key}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    i === active ? "w-5 bg-accent" : "w-1.5 bg-[var(--surface-4)]"
                  }`}
                />
              ))}
            </div>
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-fg-faint">
              Layer P{active + 1}
            </span>
          </div>
        </div>

        {/* ── BAND — clips the horizontal track (panned by GSAP on desktop) ── */}
        <div ref={bandRef} className="relative flex-1 lg:overflow-hidden">
          <div ref={trackRef} className="flex flex-col lg:h-full lg:w-max lg:flex-row">
            {PRODUCTS.map((p) => (
              <div key={p.key} className="w-full shrink-0 lg:h-full lg:w-screen">
                <div
                  className={`grid h-full grid-cols-1 gap-3 p-3 sm:grid-cols-2 sm:gap-4 sm:p-4 ${p.grid}`}
                >
                  {p.cards.map((c) => (
                    <GridCard key={c.tag} card={c} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── BOTTOM RAIL — static, mirrors the top ── */}
        <div className="flex items-center justify-between gap-4 border-t border-[var(--hairline)] px-4 py-2.5 text-fg-faint sm:px-6 lg:px-10">
          <span className="font-mono text-[11px] uppercase tracking-[0.16em]">
            PiFlow · {current.name}
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.16em]">
            {current.count} items
          </span>
        </div>
      </div>
    </section>
  );
}
