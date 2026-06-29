"use client";

/* ============================================================
   SECTION · Presentation / demo page  ·  #start  ·  data-section="presentation"
   ------------------------------------------------------------
   A single, simple render panel sits centred (reduced width) on the
   field; the GUI key embeds the REAL piflow flowmap (a pure-frontend
   static build served at /gui-demo/) so visitors can actually try a
   workflow. Beneath, two minimal keys — GUI | TUI — are labels split
   by ONE hairline; their divider lines run FULL-BLEED across the page.
   Each key rides a delicate kaomoji that swaps idle → active on click.
   This page sparks BLUE (.theme-blue) — see globals.css.
   (File is still named CTA.tsx — see the page.tsx glossary.)
   ============================================================ */

import { useState } from "react";

type View = {
  key: string;
  label: string;
  /** delicate kaomoji on the key — swaps when selected */
  idle: string;
  active: string;
};

const VIEWS: View[] = [
  { key: "gui", label: "GUI", idle: "(｡･ω･｡)", active: "(｡•‿•｡)♡" },
  { key: "tui", label: "TUI", idle: "[ ･_･ ]", active: "[ •‿• ]✦" },
];

export default function CTA() {
  const [active, setActive] = useState(0);
  const current = VIEWS[active];

  return (
    <section
      id="start"
      data-section="presentation"
      className="theme-blue relative flex min-h-svh w-full flex-col overflow-hidden bg-canvas"
    >
      <div className="gridpaper pointer-events-none absolute inset-0" aria-hidden />

      {/* ── render panel — ONE container, centred at a reduced width ── */}
      <div className="relative mx-auto flex w-full max-w-5xl flex-1 items-stretch px-4 py-4 sm:px-6 sm:py-6">
        <div className="hud-frame [--hud-bevel:20px] relative flex min-h-[55vh] w-full overflow-hidden bg-[var(--surface-3)] shadow-[var(--shadow-lg)]">
          {/* ink targeting brackets on the two square corners */}
          <span className="hud-corner hud-corner--tl" aria-hidden />
          <span className="hud-corner hud-corner--br" aria-hidden />

          {current.key === "gui" ? (
            // the real flowmap GUI, running pure-frontend from /gui-demo/
            <iframe
              src="/gui-demo/"
              title="piflow GUI — interactive demo"
              loading="lazy"
              className="h-full w-full border-0 bg-white"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-faint">
                TUI preview
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── two keys — GUI | TUI. The top divider + the centre divider run
            FULL-BLEED across the whole page (outside the panel's width). ── */}
      <div className="relative grid grid-cols-2 border-t border-[var(--hairline)]">
        {VIEWS.map((v, i) => {
          const isActive = i === active;
          return (
            <button
              key={v.key}
              type="button"
              onClick={() => setActive(i)}
              aria-pressed={isActive}
              className={`group relative flex items-center justify-between gap-4 px-6 py-7 text-left outline-none transition-colors sm:px-12 sm:py-10 ${
                i === 1 ? "border-l border-[var(--hairline)]" : ""
              }`}
            >
              <span
                className={`border-b-2 pb-2 text-5xl font-semibold tracking-[-0.03em] transition-colors sm:text-7xl ${
                  isActive
                    ? "border-[var(--accent)] text-fg"
                    : "border-transparent text-fg-muted group-hover:text-fg"
                }`}
              >
                {v.label}
              </span>
              {/* delicate kaomoji — sans (not mono) so the glyphs render fully */}
              <span
                className={`text-2xl transition-colors sm:text-4xl ${
                  isActive ? "text-fg" : "text-fg-faint"
                }`}
                aria-hidden
              >
                {isActive ? v.active : v.idle}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
