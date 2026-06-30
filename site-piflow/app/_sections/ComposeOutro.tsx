"use client";

/* ============================================================
   SECTION · Compose → About (the outro)  ·  #layers  ·  data-section="outro"
   ------------------------------------------------------------
   The final scene MERGES the old composition page, the intro page,
   and the footer into ONE scroll-driven morph. Robust mechanics: a
   tall TRACK (h-[230vh]) holds a STICKY stage (h-svh); a ScrollTrigger
   SCRUB over the track drives a GSAP timeline — so the composition
   state is unambiguously the FIRST frame (no pin guesswork).
   At the top (progress 0) it reads as the composition page: the
   "@piflow is agent-native … as ▮" heading over the three @SDK ·
   @CLI · @Skills cells (click-to-swap the ▮). Scrolling:
     · the three containers DISSOLVE cleanly,
     · the heading CROSS-FADES, in place, into the personal intro,
     · FOUR lines DRAW OUT from four directions — top → · right ↓ ·
       left ↑ · and the bottom ← as a full-bleed footer divider —
       staggered + eased so each traces (never a wipe),
     · the footer info fades in beneath the drawn divider.
   The morph layout is gated by `lg:motion-safe:` so reduced-motion /
   mobile / no-JS get a clean STACKED layout, everything visible.
   Sparks BLUE (.theme-blue); ONE accent mark — the node ring.
   ============================================================ */

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Package, Terminal, Sparkles } from "lucide-react";
import BrandPill from "@/components/BrandPill";

gsap.registerPlugin(ScrollTrigger);

const GITHUB_REPO = "https://github.com/blueif16/PiFlow";

// The three page-3 (composition) format cells. `art` tiles come from the SAME
// pipeline as the node cards — scripts/prep-node-tiles.sh (here a 1×3 grid, BLUE
// accent wedge); see that script's header for the full generate→flatten→wire
// workflow. In the cell (below) the art is grey at rest and blooms BLUE when the
// format is ACTIVE; ground is #ededed to match the flattened tiles.
type Format = { handle: string; pkg: string; Icon: typeof Package; cut: string; art: string };
const FORMATS: Format[] = [
  { handle: "@SDK", pkg: "@piflow/core", Icon: Package, cut: "hud-cut-tr [--hud-bevel:16px]", art: "/nodes/sdk.png" },
  { handle: "@CLI", pkg: "piflowctl", Icon: Terminal, cut: "hud-frame [--hud-bevel:20px]", art: "/nodes/cli.png" },
  { handle: "@Skills", pkg: "init · start · enhance", Icon: Sparkles, cut: "hud-cut-bl [--hud-bevel:16px]", art: "/nodes/skills.png" },
];

// Inline brand marks (lucide dropped Github/Linkedin in v1). Explicit 16×16 so
// they NEVER fall back to the 300×150 default SVG size; `.io-link svg` may
// refine to em when the cascade applies.
const GH = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
);
const LI = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
  </svg>
);
const WWW = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.5 2.6 3.9 5.7 3.9 9S14.5 18.4 12 21c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3Z" />
  </svg>
);

// TODO: confirm the two URLs marked below (GitHub is the live profile).
const SOCIAL_GH = "https://github.com/blueif16";
const SOCIAL_LI = "#";
const SOCIAL_WWW = "#";

// Social presence — bare icon glyphs rendered INLINE in the closing sentence
// (no "find me on …" prose, no chips). Self-colored ink-muted so they stay live
// under the spotlight dim; never the accent spark.
type Social = { label: string; href: string; icon: React.ReactNode };
const SOCIALS: Social[] = [
  { label: "GitHub", href: SOCIAL_GH, icon: GH },
  { label: "LinkedIn", href: SOCIAL_LI, icon: LI },
  { label: "Website", href: SOCIAL_WWW, icon: WWW },
];

// Frame geometry (% of the stage box). The verticals run from the top line
// down to the stage floor, where the full-bleed footer divider continues.
const FX1 = "8%", FX2 = "92%", FTOP = "12%";

export default function ComposeOutro() {
  const [active, setActive] = useState(0);

  const trackRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const cellsRef = useRef<HTMLDivElement>(null);
  const aboutRef = useRef<HTMLDivElement>(null);
  const marksRef = useRef<SVGGElement>(null);
  const dividerRef = useRef<HTMLSpanElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = trackRef.current, svg = svgRef.current, heading = headingRef.current;
    const cells = cellsRef.current, about = aboutRef.current, marks = marksRef.current;
    const divider = dividerRef.current, footer = footerRef.current;
    if (!track || !svg || !heading || !cells || !about || !marks || !divider || !footer) return;

    const mm = gsap.matchMedia();

    // Gate matches the CSS (`lg:motion-safe:`) EXACTLY: the sticky track + the
    // scrub morph only run where the overlap layout is actually applied.
    mm.add("(min-width: 1024px) and (prefers-reduced-motion: no-preference)", () => {
      const lines = svg.querySelectorAll<SVGLineElement>(".outro-line"); // [top, left, right]

      // Initial hidden states (CSS pre-hides about/footer too — no first-frame flash).
      gsap.set(about, { autoAlpha: 0, y: 14 });
      gsap.set(marks, { autoAlpha: 0 });
      gsap.set(footer, { autoAlpha: 0 });
      gsap.set(divider, { scaleX: 0, transformOrigin: "right center" });
      gsap.set(lines, { strokeDasharray: 1, strokeDashoffset: 1 });

      const tl = gsap.timeline({
        defaults: { ease: "none" },
        scrollTrigger: { trigger: track, start: "top top", end: "bottom bottom", scrub: 0.6 },
      });
      // a brief HOLD (0 → 0.12) keeps the composition page at rest so it's
      // clearly read, THEN: containers dissolve → heading fades → the frame
      // DRAWS from four directions (staggered, eased) → paragraph arrives →
      // footer divider draws out (R→L) → marks + footer info land.
      tl.to(cells.children, { autoAlpha: 0, y: 26, stagger: 0.05, ease: "power1.in", duration: 0.3 }, 0.12);
      tl.to(heading, { autoAlpha: 0, y: -16, ease: "power1.in", duration: 0.35 }, 0.18);
      tl.to(lines[0], { strokeDashoffset: 0, ease: "power2.out", duration: 0.4 }, 0.24); // top  →
      tl.to([lines[1], lines[2]], { strokeDashoffset: 0, ease: "power2.out", duration: 0.42, stagger: 0.08 }, 0.4); // left ↑ / right ↓
      tl.to(about, { autoAlpha: 1, y: 0, ease: "power2.out", duration: 0.44 }, 0.5);
      tl.to(divider, { scaleX: 1, ease: "power2.out", duration: 0.36 }, 0.64); // bottom ←
      tl.to(marks, { autoAlpha: 1, duration: 0.3 }, 0.72);
      tl.to(footer, { autoAlpha: 1, duration: 0.34 }, 0.78);

      return () => {
        tl.scrollTrigger?.kill();
        tl.kill();
        gsap.set([heading, about, marks, footer, divider, ...cells.children, ...lines], { clearProps: "all" });
      };
    });

    return () => mm.revert();
  }, []);

  return (
    <section id="layers" data-section="outro" className="theme-blue relative w-full bg-canvas">
      {/* TRACK — tall only in the animated mode; drives the scrub. */}
      <div ref={trackRef} className="relative lg:motion-safe:h-[230vh]">
        {/* STAGE — sticky one-viewport scene (static stacked in fallback). */}
        <div className="relative flex min-h-svh w-full flex-col lg:motion-safe:sticky lg:motion-safe:top-0 lg:motion-safe:h-svh lg:motion-safe:overflow-hidden">
          <div className="gridpaper pointer-events-none absolute inset-0" aria-hidden />

          {/* persistent top-left brand pill — sits in the sticky stage so it
              holds the corner through the whole composition→intro morph */}
          <div className="absolute left-4 top-4 z-30 sm:left-6 sm:top-6 lg:left-10 lg:top-8">
            <BrandPill />
          </div>

          {/* ── STAGE BODY — the frame + the morphing content ── */}
          <div className="relative flex flex-1 items-center justify-center px-6 py-14">
            {/* three frame lines drawn by the scrub (solid in fallback) */}
            <svg
              ref={svgRef}
              className="pointer-events-none absolute inset-0 z-0 h-full w-full text-fg-faint"
              preserveAspectRatio="none"
              fill="none"
              aria-hidden
            >
              <g stroke="currentColor" strokeWidth={1} strokeOpacity={0.55}>
                {/* top → (start left) · left ↑ (start bottom) · right ↓ (start top) */}
                <line className="outro-line" pathLength={1} x1={FX1} y1={FTOP} x2={FX2} y2={FTOP} />
                <line className="outro-line" pathLength={1} x1={FX1} y1="100%" x2={FX1} y2={FTOP} />
                <line className="outro-line" pathLength={1} x1={FX2} y1={FTOP} x2={FX2} y2="100%" />
              </g>
              {/* joint + the ONE accent node — fade in with the paragraph */}
              <g ref={marksRef}>
                <circle cx={FX2} cy={FTOP} r={2} fill="var(--fg-muted)" fillOpacity={0.6} />
                <circle cx={FX1} cy={FTOP} r={5} fill="none" stroke="var(--accent)" strokeWidth={1.6} />
                <circle cx={FX1} cy={FTOP} r={1.7} fill="var(--accent)" />
              </g>
            </svg>

            <div className="relative z-10 mx-auto w-full max-w-5xl text-center">
              {/* MORPH SLOT — heading sets the height; the intro sits ON it (absolute)
                  in the animated mode, or stacks beneath it in fallback. */}
              <div className="relative mx-auto max-w-3xl">
                <div ref={headingRef}>
                  <h2 className="text-balance text-3xl font-semibold leading-[1.2] tracking-[-0.03em] text-fg sm:text-4xl">
                    <span className="hud-cut-tr [--hud-bevel:10px] mr-1 inline-flex items-center border border-[var(--hairline-2)] bg-surface-1 px-3 py-1 align-middle font-mono text-[0.9em] font-medium shadow-[var(--shadow-sm)]">
                      @piflow
                    </span>{" "}
                    is agent-native. Everything is built — not only for you, but for the agents that run it — as{" "}
                    {/* The swapping format chip is an OVERLAPPING inline-grid: all three
                        variants share cell (1,1), so the chip's footprint is locked to the
                        widest option. Clicking a cell only cross-fades the content — the
                        surrounding heading never reflows and the line height never moves. */}
                    <span
                      className="hud-cut-bl [--hud-bevel:10px] ml-1 inline-grid place-items-center border border-[var(--hairline-2)] bg-surface-1 px-3 py-1 align-middle font-mono text-[0.9em] font-medium shadow-[var(--shadow-sm)]"
                      aria-live="polite"
                    >
                      {FORMATS.map((f, i) => (
                        <span
                          key={f.handle}
                          aria-hidden={i !== active}
                          className={`col-start-1 row-start-1 inline-flex items-center gap-1.5 whitespace-nowrap transition-opacity duration-300 ${
                            i === active ? "opacity-100" : "pointer-events-none opacity-0"
                          }`}
                        >
                          <span className="text-fg">{f.handle}</span>
                          <span className="text-fg-faint" aria-hidden>·</span>
                          <span className="text-fg-faint">{f.pkg}</span>
                        </span>
                      ))}
                    </span>
                    .
                  </h2>
                </div>

                {/* the personal intro — EXACT same font as the heading (.intro-copy),
                    a HOVER SPOTLIGHT over sentence spans (.intro-reveal), the io-fx
                    gradient streaks + io-glass behind key phrases, and the social
                    icons INLINE in the closing line. (Merging the spotlight × the
                    gradients cleanly is the next step — for now both coexist.) */}
                <div
                  ref={aboutRef}
                  className="mx-auto mt-10 max-w-3xl lg:motion-safe:absolute lg:motion-safe:inset-x-0 lg:motion-safe:top-0 lg:motion-safe:mt-0 lg:motion-safe:invisible"
                >
                  <p className="mb-6 font-mono text-[11px] uppercase tracking-[0.18em] text-fg-faint">
                    Who builds this
                  </p>

                  {/* faint-grey body, one sentence in ink — hover a sentence to move
                      the highlight (.intro-reveal). The io-fx streaks + io-glass ride
                      INSIDE each sentence span (not as direct children) so the spotlight
                      still lands on exactly one sentence; the social icons sit inline in
                      the closing line, self-colored so they stay live under the dim. */}
                  <p className="intro-copy intro-reveal text-balance text-3xl text-fg sm:text-4xl">
                    <span>
                      I&apos;m Shiran Wang, currently building{" "}
                      <span className="io-fx io-fx--warm" style={{ "--w": "3em", "--x": "-0.04em", "--y": "-0.02em", "--r": "-1.5deg" } as React.CSSProperties} aria-hidden />
                      <span className="io-glass">agentic applications</span>.
                    </span>{" "}
                    <span>
                      Empowering everything with{" "}
                      <span className="io-fx io-fx--mix" style={{ "--w": "2.9em", "--x": "0.02em", "--y": "0.03em", "--r": "1deg" } as React.CSSProperties} aria-hidden />
                      <span className="io-glass">agentic workflows</span>.
                    </span>{" "}
                    <span>
                      Currently focusing on the{" "}
                      <span className="io-fx io-fx--green" style={{ "--w": "2.5em", "--y": "-0.04em", "--r": "-2deg" } as React.CSSProperties} aria-hidden />
                      <span className="io-glass">AI educational</span> front.
                    </span>{" "}
                    <span>Love to connect.</span>{" "}
                    <span>
                      Here&apos;s my info 👉{" "}
                      {SOCIALS.map((s) => (
                        <a
                          key={s.label}
                          href={s.href}
                          aria-label={s.label}
                          {...(s.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                          className="mx-[0.14em] inline-flex items-center align-middle text-fg-muted transition-colors hover:text-fg [&>svg]:size-[0.92em]"
                        >
                          {s.icon}
                        </a>
                      ))}
                    </span>
                  </p>
                </div>
              </div>

              {/* format cells — the three containers that dissolve on scrub */}
              <div ref={cellsRef} className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-3">
                {FORMATS.map((f, i) => {
                  const isActive = i === active;
                  return (
                    <button
                      key={f.handle}
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onFocus={() => setActive(i)}
                      aria-pressed={isActive}
                      aria-label={`${f.handle} · ${f.pkg}`}
                      style={{ "--card-ground": "#ededed" } as React.CSSProperties}
                      className={`group relative flex min-h-[clamp(260px,40vh,440px)] flex-col overflow-hidden ${f.cut} border bg-[var(--card-ground)] p-9 text-left shadow-[var(--shadow-sm)] outline-none transition-[border-color,transform] hover:-translate-y-0.5 ${
                        isActive
                          ? "border-[var(--hairline-2)]"
                          : "border-[var(--hairline)] hover:border-[var(--hairline-2)]"
                      }`}
                    >
                      {/* the illustration fills the cell bottom-right on a ground
                          that matches the tile (#ededed); grey at rest, blooms
                          BLUE when this format is active (hover/focus sets active),
                          so one cell carries the spark — like the heading chip. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={f.art}
                        alt=""
                        aria-hidden
                        className={`pointer-events-none absolute bottom-0 right-0 z-0 h-[82%] w-[82%] object-contain object-right-bottom transition-[filter,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                          isActive ? "scale-[1.01] grayscale-0 saturate-[1.06]" : "grayscale"
                        }`}
                      />
                      {isActive && (
                        <span
                          className="pointer-events-none absolute left-0 top-0 z-20 size-3.5 border-l-2 border-t-2 border-[var(--accent)]"
                          aria-hidden
                        />
                      )}
                      <f.Icon
                        className={`relative z-10 size-6 transition-colors ${isActive ? "text-fg" : "text-fg-muted"}`}
                        strokeWidth={1.6}
                        aria-hidden
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ── FOOTER — the fourth line draws out as a full-bleed divider (R→L),
                page footer info beneath it (replaces <Footer/>). ── */}
          <div className="relative z-10 shrink-0">
            <span
              ref={dividerRef}
              className="block h-px w-full origin-right scale-x-100 bg-[var(--hairline-2)] lg:motion-safe:scale-x-0"
              aria-hidden
            />
            <div
              ref={footerRef}
              className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-2 px-6 py-5 font-mono text-xs text-fg-faint sm:flex-row lg:motion-safe:invisible"
            >
              <span>© 2026 Pi Flow · MIT — compose · run · improve</span>
              <nav className="flex items-center gap-5">
                <a href="/docs" className="transition-colors hover:text-fg">Docs</a>
                <a href={GITHUB_REPO} target="_blank" rel="noreferrer" className="transition-colors hover:text-fg">GitHub</a>
                <a href="#top" className="transition-colors hover:text-fg">Top ↑</a>
              </nav>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
