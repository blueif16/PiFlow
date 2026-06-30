/* ============================================================
   SECTION · Hero  ·  #top  ·  data-section="hero"
   ------------------------------------------------------------
   Hero — full-screen. Fills the viewport (no width container, no
   white frame): content sits directly on the grey field. The
   engineering grid + the PiFlow mark (components/LogoGrid) own the
   right half; nav rides the top, the product title the lower-left.
   Modular by design — LogoGrid and the coding panel
   (components/CodeEditor) live in their own files and drop back in
   with a single import.
   ============================================================ */
import LogoGrid from "@/components/LogoGrid";
import HoverGrid from "@/components/HoverGrid";
import LearnMoreButton from "@/components/LearnMoreButton";

const GITHUB_URL = "https://github.com/blueif16/PiFlow";

export default function Hero() {
  return (
    <section id="top" data-section="hero" className="relative min-h-svh w-full overflow-hidden">
      {/* right-half grid + the PiFlow mark (desktop) */}
      <LogoGrid className="pointer-events-none absolute inset-y-0 right-0 z-0 hidden w-[56%] lg:block" />

      {/* left-side hover field — the grid lights up under the cursor.
          Scoped to the left 44% (complement of LogoGrid's right 56%) so
          the right half stays untouched. */}
      <HoverGrid className="pointer-events-none absolute inset-y-0 left-0 z-0 hidden w-[44%] lg:block" />

      {/* targeting brackets on the two square corners (TL + BR) */}
      <span className="hud-corner hud-corner--tl" aria-hidden />
      <span className="hud-corner hud-corner--br" aria-hidden />

      {/* content layer — fills the viewport, nav top / title bottom */}
      <div className="relative z-10 flex min-h-svh flex-col px-4 pt-4 sm:px-6 sm:pt-6 lg:px-10 lg:pt-8">
        {/* ── TOP PILLS ───────────────────────────────────────── */}
        {/* the left pill is the page-level FixedBrandPill (fixed corner); only
            the GitHub pill rides the hero nav, so it sits on the right */}
        <nav className="flex items-center justify-end gap-3">
          {/* right pill: GitHub only — anti-diagonal cut (TL+BR), mirrors the left */}
          <div className="hud-frame-anti [--hud-bevel:14px] inline-flex items-center bg-white px-1 py-1.5 shadow-[var(--shadow-sm)]">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="px-3 text-sm font-medium text-fg-muted transition-colors hover:text-fg"
            >
              GitHub
            </a>
          </div>
        </nav>

        {/* ── TITLE — lower-left ───────────────────────────────── */}
        {/* data-hover-anchor: HoverGrid warms cells near this box to accent */}
        <div
          data-hover-anchor
          className="mt-auto max-w-2xl pb-12 sm:pb-16 lg:pb-20"
        >
          <span className="hud-frame [--hud-bevel:8px] blur-in mb-5 inline-flex w-fit items-center gap-2 border border-[var(--hairline)] bg-white/70 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.16em] text-fg-faint backdrop-blur">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            Agentic workflow powered by the Pi Agents
          </span>

          {/* title + CTA on one row — the button rides parallel to the
              wordmark, bottom-aligned, and wraps under it on narrow widths */}
          <div className="flex flex-wrap items-end gap-x-7 gap-y-4">
            <h1
              className="blur-in text-balance text-6xl font-semibold leading-[0.96] tracking-[-0.04em] text-fg sm:text-7xl"
              style={{ animationDelay: "0.05s" }}
            >
              Pi Flow
            </h1>

            {/* primary CTA — angular ink button, GSAP-scrolls to #agents */}
            <LearnMoreButton
              className="hud-cut-tr [--hud-bevel:12px] blur-in mb-1.5 inline-flex w-fit items-center gap-2 bg-[var(--ink)] px-5 py-3 text-sm font-medium text-white shadow-[var(--shadow-sm)] transition-[background,transform] hover:bg-[var(--ink-hover)] hover:-translate-y-0.5 active:translate-y-0"
              target="#agents"
            >
              Learn more
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14M6 13l6 6 6-6" />
              </svg>
            </LearnMoreButton>
          </div>
        </div>
      </div>
    </section>
  );
}
