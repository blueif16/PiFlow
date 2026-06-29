"use client";

/* ============================================================
   Formats — "@piflow is agent-native, provided in the formats you
   build with." A centered sentence (the @piflow token boxed in an
   ANGULAR grid chip, not a round pill) sits on top. Below: three
   hover-expand drawers (@SDK · @CLI · @Skills) keep the slider shape
   from the old layer row; hovering/focusing one fills the SECOND box
   beneath with that format's detail. The second box is empty until
   you hover. ONE orange spark per viewport: the active drawer's
   bracket (mirrors the GUI's accent = selected). Reduced-motion-safe
   (the .exp-row transition is disabled in globals.css).
   ============================================================ */

import { useState } from "react";
import { Package, Terminal, Sparkles } from "lucide-react";

type Format = {
  handle: string;
  pkg: string;
  tagline: string;
  lead: string;
  points: string[];
  Icon: typeof Package;
  /** single-corner HUD cut — varied per box so the chrome isn't stamped */
  cut: string;
};

const FORMATS: Format[] = [
  {
    handle: "@SDK",
    pkg: "@piflow/core",
    tagline: "The workflow engine, as a library.",
    lead: "Load a structured template into a WorkflowSpec and run it as a fleet — one real Pi agent per node.",
    points: [
      "One real Pi agent per node",
      "Compose nodes, gates and fusion",
      "Logic only — product-agnostic",
    ],
    Icon: Package,
    cut: "hud-cut-tr [--hud-bevel:14px]",
  },
  {
    handle: "@CLI",
    pkg: "piflowctl",
    tagline: "An agent-native CLI.",
    lead: "Run and monitor the whole DAG on the Pi fleet from one console — commands built for inspecting a live agent run.",
    points: [
      "Run the DAG on the Pi fleet",
      "Stream telemetry; scope with --from / --until",
      "Scaffold with new / add-node",
    ],
    Icon: Terminal,
    cut: "hud-cut-bl [--hud-bevel:14px]",
  },
  {
    handle: "@Skills",
    pkg: "init · start · enhance",
    tagline: "Author-time systems that drive each node.",
    lead: "Disciplined skills create, run and improve a workflow — and stage per-node skills into the agents that execute it.",
    points: [
      "Create · run · improve",
      "Per-node skills staged into nodes",
      "Fix the class, not the case",
    ],
    Icon: Sparkles,
    cut: "hud-cut-br [--hud-bevel:14px]",
  },
];

export default function LayerCards() {
  const [active, setActive] = useState<number | null>(null);
  const detail = active === null ? null : FORMATS[active];

  return (
    <section id="layers" className="relative w-full overflow-hidden bg-canvas">
      <div className="gridpaper pointer-events-none absolute inset-0" aria-hidden />

      <div className="relative mx-auto w-full max-w-4xl px-6 py-24">
        {/* ── centered sentence — @piflow boxed in an angular grid chip ── */}
        <div className="reveal mb-12 text-center">
          <h2 className="text-balance text-3xl font-semibold leading-[1.15] tracking-[-0.03em] text-fg sm:text-4xl">
            <span className="hud-cut-tr [--hud-bevel:8px] mr-1 inline-flex items-center border border-[var(--hairline-2)] bg-surface-1 px-2.5 py-0.5 align-baseline font-mono text-[0.82em] font-medium shadow-[var(--shadow-sm)]">
              @piflow
            </span>{" "}
            is agent-native — provided in the formats you build with.
          </h2>
        </div>

        {/* ── three hover-expand drawers (the slider shape, kept) ── */}
        <div className="exp-row reveal" onMouseLeave={() => setActive(null)}>
          {FORMATS.map((f, i) => (
            <article
              key={f.handle}
              tabIndex={0}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              className={`exp-card group relative flex min-h-[112px] flex-col justify-between ${f.cut} border bg-surface-1 p-5 shadow-[var(--shadow-sm)] outline-none transition-[border-color,background] ${
                active === i
                  ? "border-[var(--hairline-2)] bg-surface-2"
                  : "border-[var(--hairline)] hover:border-[var(--hairline-2)]"
              }`}
            >
              {/* active = the ONE orange spark: a bracket on the square TL corner */}
              {active === i && (
                <span
                  className="pointer-events-none absolute left-0 top-0 size-3.5 border-l-2 border-t-2 border-[var(--accent)]"
                  aria-hidden
                />
              )}
              <div className="flex items-center gap-2">
                <f.Icon className="size-4 text-fg-muted" strokeWidth={1.6} />
                <span className="font-mono text-sm font-medium tracking-tight text-fg">
                  {f.handle}
                </span>
              </div>
              {/* tagline rides the drawer — revealed as the card expands */}
              <p className="exp-body mt-4 whitespace-nowrap text-sm leading-relaxed text-fg-muted">
                {f.tagline}
              </p>
            </article>
          ))}
        </div>

        {/* ── second box — empty until you hover a drawer, then it fills ── */}
        <div
          className="hud-frame [--hud-bevel:24px] relative mt-3 min-h-[200px] border border-[var(--hairline)] bg-surface-1 p-7 shadow-[var(--shadow-sm)] sm:p-9"
          aria-live="polite"
        >
          {/* ink targeting brackets on the two square corners (TL + BR) */}
          <span className="hud-corner hud-corner--tl" aria-hidden />
          <span className="hud-corner hud-corner--br" aria-hidden />

          {detail ? (
            <div className="grid gap-6 lg:grid-cols-2 lg:gap-12">
              <div>
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-lg font-medium text-fg">{detail.handle}</span>
                  <span className="font-mono text-[11px] tracking-tight text-fg-faint">
                    {detail.pkg}
                  </span>
                </div>
                <p className="mt-1.5 text-base font-medium text-fg">{detail.tagline}</p>
                <p className="mt-3 max-w-md text-sm leading-relaxed text-fg-muted">{detail.lead}</p>
              </div>
              <ul className="space-y-2.5 lg:pt-1">
                {detail.points.map((p) => (
                  <li key={p} className="flex items-start gap-2.5 text-sm text-fg">
                    {/* angular ink marker, not a round dot */}
                    <span
                      className="mt-[7px] size-1 shrink-0 bg-[var(--fg-faint)]"
                      aria-hidden
                    />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="flex min-h-[148px] items-center justify-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-faint">
                Hover a format to look inside
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
