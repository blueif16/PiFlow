/* ============================================================
   Hero — the reference layout, re-cut with the GUI's angular
   game-UI geometry: the white passe-partout FRAME and the inner
   panel are "sci-fi rectangles" (hard corners + one beveled
   diagonal) with ink targeting brackets on the two square
   corners. Holds two top pills (nav, kept round), the iso-block
   illustration (upper-right), the coding panel (lower-right),
   and a two-line title (lower-left). Color system unchanged —
   only the BORDER/SHAPE is angular (brackets are ink, not orange).
   ============================================================ */
import HeroBlocksLight from "@/components/iso/art/HeroBlocksLight";

const GITHUB_URL = "https://github.com/blueif16/PiFlow";

// Dark rounded-square brand mark (white block glyph) — matches the
// reference's logo chip seated at the left edge of the left pill.
function LogoMark() {
  return (
    <span className="hud-cut-tl [--hud-bevel:7px] grid size-8 place-items-center bg-[var(--ink)] text-white">
      <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
        <rect x="3.5" y="6" width="4" height="12" rx="1" />
        <rect x="10" y="9.5" width="4" height="8.5" rx="1" />
        <rect x="16.5" y="3.5" width="4" height="14.5" rx="1" />
      </svg>
    </span>
  );
}

// The original coding panel — "a flow, in a few lines". Relights to the
// light system via the .editor tokens (white surface, orange caret).
function CodeEditor() {
  const Kw = ({ children }: { children: React.ReactNode }) => (
    <span className="text-fg">{children}</span>
  );
  const Arg = ({ children }: { children: React.ReactNode }) => (
    <span className="text-fg-muted">{children}</span>
  );
  return (
    <div className="editor w-full">
      <div className="editor-bar">
        <span className="editor-dot" />
        <span className="editor-dot" />
        <span className="editor-dot" />
        <span className="ml-2 font-mono text-xs text-fg-faint">
          a flow, in a few lines
        </span>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-7">
        <code>
          <Kw>flow</Kw> <Arg>&quot;morning repost&quot;</Arg>
          {"\n"}
          {"  "}
          <Kw>every</Kw> <Arg>day at 8:00am</Arg>
          {"\n"}
          {"  "}
          <Kw>watch</Kw>
          {"  "}
          <Arg>&lt;paste a post URL&gt;</Arg>
          {"\n"}
          {"  "}
          <Kw>rewrite</Kw> <Arg>it in my voice</Arg>
          {"\n"}
          {"  "}
          <Kw>post</Kw>
          {"   "}
          <Arg>to my channel</Arg>
          <span className="caret" aria-hidden />
        </code>
      </pre>
      <div className="flex items-center gap-2 border-t border-[var(--hairline)] px-5 py-3 font-mono text-xs text-fg-muted">
        <span className="size-1.5 rounded-full bg-accent" aria-hidden />
        designed, running, and improving — every run
      </div>
    </div>
  );
}

export default function Hero() {
  return (
    <section id="top" className="px-3 pt-3 sm:px-5 sm:pt-5">
      {/* outer WHITE frame — angular sci-fi rectangle (beveled diagonal) */}
      <div className="hud-frame [--hud-bevel:28px] mx-auto w-full max-w-[1200px] bg-white p-3 shadow-[var(--shadow-lg)] sm:p-4">
        {/* inner light-grey panel — the HUD stage: angular + corner brackets */}
        <div className="hud-frame [--hud-bevel:20px] relative overflow-hidden bg-[var(--surface-3)] px-5 pt-4 pb-10 sm:px-8 sm:pt-5 sm:pb-14">
          {/* faint engineered grid inside the panel */}
          <div className="gridpaper" aria-hidden />

          {/* targeting brackets on the two SQUARE corners (TL + BR); the
              beveled diagonal (TR + BL) carries the chamfer */}
          <span className="hud-corner hud-corner--tl" aria-hidden />
          <span className="hud-corner hud-corner--br" aria-hidden />

          {/* ── TOP PILLS — imitated from the reference ───────────── */}
          <nav className="relative z-20 flex items-center justify-between gap-3">
            {/* left pill: logo chip + minimal links — diagonal cut (TR+BL) */}
            <div className="hud-frame [--hud-bevel:14px] inline-flex items-center gap-1 bg-white py-1.5 pl-1.5 pr-2 shadow-[var(--shadow-sm)]">
              <LogoMark />
              <a
                href="/docs"
                className="ml-1.5 px-2.5 text-sm font-medium text-fg-muted transition-colors hover:text-fg"
              >
                Docs
              </a>
              <a
                href="#loop"
                className="hidden px-2.5 text-sm font-medium text-fg-muted transition-colors hover:text-fg sm:inline"
              >
                How it works
              </a>
            </div>

            {/* right pill: link + black CTA — anti-diagonal cut (TL+BR), mirrors the left */}
            <div className="hud-frame-anti [--hud-bevel:14px] inline-flex items-center gap-1 bg-white py-1.5 pl-2 pr-1.5 shadow-[var(--shadow-sm)]">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="hidden px-3 text-sm font-medium text-fg-muted transition-colors hover:text-fg sm:inline"
              >
                GitHub
              </a>
              <a
                href="#start"
                className="hud-cut-tr [--hud-bevel:10px] bg-[var(--ink)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--ink-hover)]"
              >
                Start a flow
              </a>
            </div>
          </nav>

          {/* ── ILLUSTRATION — iso blocks, upper-right (recedes) ───── */}
          <div
            aria-hidden
            className="pointer-events-none absolute right-0 top-[7%] z-0 hidden w-[54%] max-w-[600px] opacity-80 lg:block"
          >
            <HeroBlocksLight className="iso-float-slow w-full" />
          </div>

          {/* ── CODING PANEL — lower-right, foreground ─────────────── */}
          <div className="absolute bottom-10 right-5 z-10 hidden w-[40%] max-w-[400px] sm:right-8 lg:block">
            <CodeEditor />
          </div>

          {/* ── TITLE — lower-left, greatly reduced text ───────────── */}
          <div className="relative z-10 flex min-h-[360px] flex-col justify-end sm:min-h-[460px] lg:min-h-[540px]">
            <span className="hud-frame [--hud-bevel:8px] blur-in mb-5 inline-flex w-fit items-center gap-2 border border-[var(--hairline)] bg-white/70 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.16em] text-fg-faint backdrop-blur">
              <span className="size-1.5 rounded-full bg-accent" aria-hidden />
              Agent substrate
            </span>
            <h1
              className="blur-in max-w-xl text-balance text-6xl font-semibold leading-[0.96] tracking-[-0.04em] text-fg sm:text-7xl"
              style={{ animationDelay: "0.05s" }}
            >
              Ultracode,
              <br />
              on Pi
            </h1>
          </div>
        </div>
      </div>
    </section>
  );
}
