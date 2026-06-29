"use client";

/* ============================================================
   SECTION · Presentation / demo page  ·  #start  ·  data-section="presentation"
   ------------------------------------------------------------
   A huge render frame fills most of the screen; beneath it two
   minimal keys — GUI (left) and TUI (right) — are just labels
   split by ONE hairline divider (the reference iOS | Android bar).
   Click a key and the frame swaps to that surface (the real GUI
   flowmap / the terminal console; media dropped in later). ONE
   orange spark per viewport: the active key's underline (mirrors
   the GUI's accent = selected).
   (File is still named CTA.tsx — see the page.tsx glossary.)
   ============================================================ */

import { useState } from "react";

type View = {
  key: string;
  label: string;
  sub: string;
  /** real screenshot / recording dropped in later; empty → placeholder */
  media?: string;
};

const VIEWS: View[] = [
  { key: "gui", label: "GUI", sub: "packages/gui · the flowmap" },
  { key: "tui", label: "TUI", sub: "piflowctl · the terminal console" },
];

export default function CTA() {
  const [active, setActive] = useState(0);
  const current = VIEWS[active];

  return (
    <section
      id="start"
      data-section="presentation"
      className="relative flex min-h-svh w-full flex-col overflow-hidden bg-canvas"
    >
      <div className="gridpaper pointer-events-none absolute inset-0" aria-hidden />

      {/* ── huge render frame — fills most of the screen ── */}
      <div className="relative flex flex-1 items-stretch p-3 sm:p-4 lg:p-6">
        <div className="hud-frame [--hud-bevel:28px] flex w-full bg-white p-3 shadow-[var(--shadow-lg)] sm:p-4">
          <div
            className="hud-frame [--hud-bevel:20px] relative flex min-h-[40vh] w-full items-center justify-center overflow-hidden bg-[var(--surface-3)]"
            aria-live="polite"
          >
            {/* ink targeting brackets on the two square corners */}
            <span className="hud-corner hud-corner--tl" aria-hidden />
            <span className="hud-corner hud-corner--br" aria-hidden />

            {/* slim mono breadcrumb — which surface is shown */}
            <span className="absolute left-5 top-4 font-mono text-[11px] uppercase tracking-[0.18em] text-fg-faint">
              piflow / {current.label}
            </span>

            {current.media ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={current.media}
                alt={`${current.label} preview`}
                className="h-full w-full object-cover"
              />
            ) : (
              <p className="px-6 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-fg-faint">
                {current.label} preview — {current.sub}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── two keys — GUI | TUI, just labels split by ONE hairline ── */}
      <div className="relative grid grid-cols-2 border-t border-[var(--hairline)]">
        {VIEWS.map((v, i) => {
          const isActive = i === active;
          return (
            <button
              key={v.key}
              type="button"
              onClick={() => setActive(i)}
              aria-pressed={isActive}
              className={`group relative flex items-end justify-between gap-4 px-6 py-8 text-left outline-none transition-colors sm:px-10 sm:py-12 ${
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
              <span className="hidden font-mono text-[11px] tracking-tight text-fg-faint sm:inline">
                {v.sub}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
