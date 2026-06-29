"use client";

/* ============================================================
   SECTION · Composition page  ·  #layers  ·  data-section="composition"
   (the @SDK · @CLI · @Skills format cards)
   ------------------------------------------------------------
   Formats — "@piflow is agent-native. Everything is built — not
   only for you, but for the agents that run it — as ▮." The trailing
   ▮ is a LIVE readout: click one of the three angular format cells
   (@SDK · @CLI · @Skills) and the inline block swaps to that format's
   ID + package name. The cells themselves are illustration-only — an
   icon marker over an open area for the iso art supplied later; no
   body copy. ONE orange spark per viewport: the active cell's bracket
   (mirrors the GUI's accent = selected).
   ============================================================ */

import { useState } from "react";
import { Package, Terminal, Sparkles } from "lucide-react";

type Format = {
  /** the ID — e.g. @SDK */
  handle: string;
  /** the name — e.g. @piflow/core */
  pkg: string;
  Icon: typeof Package;
  /** HUD cut — varied per cell so neighbouring chrome isn't stamped */
  cut: string;
};

const FORMATS: Format[] = [
  { handle: "@SDK", pkg: "@piflow/core", Icon: Package, cut: "hud-cut-tr [--hud-bevel:16px]" },
  { handle: "@CLI", pkg: "piflowctl", Icon: Terminal, cut: "hud-frame [--hud-bevel:20px]" },
  { handle: "@Skills", pkg: "init · start · enhance", Icon: Sparkles, cut: "hud-cut-bl [--hud-bevel:16px]" },
];

export default function LayerCards() {
  const [active, setActive] = useState(0);
  const current = FORMATS[active];

  return (
    <section id="layers" data-section="composition" className="theme-blue relative flex min-h-svh w-full flex-col justify-center overflow-hidden bg-canvas py-20">
      <div className="gridpaper pointer-events-none absolute inset-0" aria-hidden />

      <div className="relative mx-auto w-full max-w-5xl px-6">
        {/* ── centered sentence — @piflow boxed, plus the live ▮ readout ── */}
        <div className="reveal mb-12 text-center">
          <h2 className="text-balance text-3xl font-semibold leading-[1.2] tracking-[-0.03em] text-fg sm:text-4xl">
            <span className="hud-cut-tr [--hud-bevel:8px] mr-1 inline-flex items-center border border-[var(--hairline-2)] bg-surface-1 px-2.5 py-0.5 align-baseline font-mono text-[0.82em] font-medium shadow-[var(--shadow-sm)]">
              @piflow
            </span>{" "}
            is agent-native. Everything is built — not only for you, but for the agents that run it — as{" "}
            <span
              className="hud-cut-bl [--hud-bevel:8px] ml-1 inline-flex items-center gap-1.5 border border-[var(--hairline-2)] bg-surface-1 px-2.5 py-0.5 align-baseline font-mono text-[0.82em] font-medium shadow-[var(--shadow-sm)]"
              aria-live="polite"
            >
              <span className="text-fg">{current.handle}</span>
              <span className="text-fg-faint" aria-hidden>·</span>
              <span className="text-fg-faint">{current.pkg}</span>
            </span>
            .
          </h2>
        </div>

        {/* ── one row of three illustration cells — click to select ── */}
        <div className="reveal grid grid-cols-1 gap-4 sm:grid-cols-3">
          {FORMATS.map((f, i) => {
            const isActive = i === active;
            return (
              <button
                key={f.handle}
                type="button"
                onClick={() => setActive(i)}
                aria-pressed={isActive}
                aria-label={`${f.handle} · ${f.pkg}`}
                className={`group relative flex min-h-[clamp(320px,48vh,540px)] flex-col ${f.cut} border bg-surface-1 p-7 text-left shadow-[var(--shadow-sm)] outline-none transition-[border-color,background,transform] hover:-translate-y-0.5 ${
                  isActive
                    ? "border-[var(--hairline-2)] bg-surface-2"
                    : "border-[var(--hairline)] hover:border-[var(--hairline-2)] hover:bg-surface-2"
                }`}
              >
                {/* active = the ONE orange spark: a bracket on the square TL corner */}
                {isActive && (
                  <span
                    className="pointer-events-none absolute left-0 top-0 size-3.5 border-l-2 border-t-2 border-[var(--accent)]"
                    aria-hidden
                  />
                )}
                {/* icon-only marker; the rest of the cell is open for the iso illo */}
                <f.Icon
                  className={`size-6 transition-colors ${isActive ? "text-fg" : "text-fg-muted"}`}
                  strokeWidth={1.6}
                  aria-hidden
                />
                {/* illustration drops in here later */}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
