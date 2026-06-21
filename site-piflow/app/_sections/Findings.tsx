"use client";

import { NumberTicker } from "@/components/ui/number-ticker";
import { cn } from "@/lib/utils";
import { Motif } from "@/components/iso/Motif";

/* Error-amplification by architecture — synthesized from published
   scaling-agent research, NOT Pi Flow's own measurements. */
const BARS = [
  { name: "single", value: 1.0 },
  { name: "centralized", value: 4.4, highlight: true },
  { name: "hybrid", value: 5.1 },
  { name: "decentralized", value: 7.8 },
  { name: "independent", value: 17.2 },
] as const;

// Scale so the tallest bar (17.2) reads at ~200px.
const MAX_BAR_PX = 200;
const SCALE = MAX_BAR_PX / 17.2;

export default function Findings() {
  return (
    <section id="findings" className="relative isolate mx-auto w-full max-w-6xl overflow-hidden px-6 py-28">
      <Motif
        src="/motifs/g11.svg"
        className="absolute right-[-2%] top-[14%] -z-10 h-[440px] w-[440px] opacity-[0.10]"
      />
      {/* Header — editorial, left-set */}
      <div className="reveal max-w-2xl">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-fg-faint">Findings</p>
        <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.03em] text-fg sm:text-5xl">
          The research is blunt about what breaks multi-agent systems.
        </h2>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-fg-muted">
          We built on the side that wins.
        </p>
      </div>

      {/* Offset-asymmetric grid */}
      <div className="mt-16 grid grid-cols-1 gap-x-10 gap-y-14 lg:grid-cols-12">
        {/* Contrast centerpiece — large, spans most of the row */}
        <div className="reveal lg:col-span-7 lg:row-span-2">
          <div className="flex items-baseline gap-5 sm:gap-7">
            <span className="flex items-baseline">
              <NumberTicker
                value={4.4}
                decimalPlaces={1}
                className="text-accent text-7xl font-semibold tracking-[-0.04em] tabular-nums sm:text-8xl"
              />
              <span
                className="text-accent text-5xl font-semibold tracking-[-0.04em] sm:text-6xl"
                aria-hidden
              >
                ×
              </span>
            </span>
            <span className="font-mono text-sm uppercase tracking-[0.16em] text-fg-faint">
              vs
            </span>
            <span className="flex items-baseline text-fg-muted">
              <span className="text-5xl font-semibold tracking-[-0.04em] tabular-nums sm:text-6xl">
                17.2
              </span>
              <span className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl" aria-hidden>
                ×
              </span>
            </span>
          </div>
          <p className="mt-6 max-w-md text-base leading-relaxed text-fg-muted">
            A centralized orchestrator contains how far a single error spreads. A leaderless swarm
            lets it explode.
          </p>
          <p className="mt-3 font-mono text-xs text-fg-faint">
            — across published scaling-agent research
          </p>
        </div>

        {/* Token-tax stat — dropped lower than the contrast block, right column */}
        <div className="reveal lg:col-span-5 lg:col-start-8 lg:mt-10">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-fg-faint">
            The token tax
          </p>
          <div className="mt-3 flex items-baseline gap-0.5 text-fg">
            <span className="text-5xl font-semibold tracking-[-0.04em] tabular-nums sm:text-6xl">
              4–
            </span>
            <NumberTicker
              value={15}
              className="text-fg text-5xl font-semibold tracking-[-0.04em] tabular-nums sm:text-6xl"
            />
            <span className="text-4xl font-semibold tracking-[-0.04em] sm:text-5xl" aria-hidden>
              ×
            </span>
          </div>
          <p className="mt-4 max-w-xs text-base leading-relaxed text-fg-muted">
            the token tax of naive multi-agent — the cost floor a cheap fleet is built to beat.
          </p>
          <p className="mt-3 font-mono text-xs text-fg-faint">
            — across research on multi-agent systems
          </p>
        </div>

        {/* Bar chart panel — full row beneath, offset left to balance the stat */}
        <div className="reveal lg:col-span-9 lg:col-start-1">
          <div className="rounded-xl border border-[var(--hairline)] bg-surface-1/70 p-7 backdrop-blur-sm sm:p-8">
            <div className="flex items-baseline justify-between gap-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-fg-faint">
                Error amplification by architecture
              </p>
              <p className="font-mono text-[11px] text-fg-faint">relative spread of one error</p>
            </div>

            {/* Bars */}
            <div
              className="mt-9 flex items-end gap-5 sm:gap-8"
              style={{ height: MAX_BAR_PX + 4 }}
            >
              {BARS.map((b) => {
                const highlight = "highlight" in b && b.highlight;
                return (
                  <div
                    key={b.name}
                    className="flex h-full flex-1 flex-col items-center justify-end"
                  >
                    {highlight ? (
                      <span className="mb-2 whitespace-nowrap rounded-full border border-[var(--accent-30)] bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-accent">
                        the shape we use
                      </span>
                    ) : null}
                    <div
                      className={cn(
                        "bar-grow w-full max-w-[64px] rounded-t-md",
                        highlight
                          ? "bg-accent [box-shadow:0_0_36px_-8px_var(--accent-glow)]"
                          : "border border-[var(--hairline)] border-b-0 bg-surface-3"
                      )}
                      style={{ height: Math.round(b.value * SCALE) }}
                      aria-hidden
                    />
                  </div>
                );
              })}
            </div>

            {/* Axis labels */}
            <div className="mt-3 flex items-start gap-5 border-t border-[var(--hairline)] pt-3 sm:gap-8">
              {BARS.map((b) => {
                const highlight = "highlight" in b && b.highlight;
                return (
                  <div key={b.name} className="flex flex-1 flex-col items-center text-center">
                    <span
                      className={cn(
                        "font-mono text-sm tabular-nums",
                        highlight ? "text-accent" : "text-fg"
                      )}
                    >
                      {b.value.toFixed(1)}×
                    </span>
                    <span className="mt-1 text-[11px] leading-tight text-fg-muted">{b.name}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
