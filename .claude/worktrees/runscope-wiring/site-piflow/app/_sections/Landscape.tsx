import { cn } from "@/lib/utils";
import { Motif } from "@/components/iso/Motif";

type System = {
  name: string;
  strength: string;
  /** map position as percentages: x left→right, y from top */
  x: number;
  y: number;
  accent?: boolean;
};

// X: fixed / deterministic (0%) → agentic / adaptive (100%)
// Y (top): designs & improves it (0%) → runs your flow (100%)
const SYSTEMS: System[] = [
  {
    name: "Temporal · DBOS · Restate",
    strength: "Durable execution: exactly-once, runs for years.",
    x: 14,
    y: 80,
  },
  {
    name: "LangGraph",
    strength: "A typed state-graph in code; great for fixed, structured flows.",
    x: 33,
    y: 64,
  },
  {
    name: "CrewAI · AutoGen",
    strength: "Fast multi-agent role & conversation prototyping.",
    x: 56,
    y: 50,
  },
  {
    name: "ADAS · AFlow · GEPA",
    strength: "The research frontier of automated agent design (offline).",
    x: 26,
    y: 22,
  },
  {
    name: "Pi Flow",
    strength:
      "Self-designing, durable, self-improving full-agent nodes — extended by OpenClaw tools.",
    x: 76,
    y: 20,
    accent: true,
  },
];

function MapChip({ s }: { s: System }) {
  return (
    <div
      className="group absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${s.x}%`, top: `${s.y}%` }}
    >
      <div
        className={cn(
          "relative whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[13px] font-medium backdrop-blur-sm transition-colors",
          s.accent
            ? "border-[var(--accent-30)] bg-surface-2 text-accent [box-shadow:0_0_36px_-10px_var(--accent-glow)]"
            : "border-[var(--hairline)] bg-surface-2/80 text-fg group-hover:border-[var(--hairline-2)]"
        )}
      >
        {s.name}
      </div>
      {/* strength on hover — does not shift layout */}
      <div
        className={cn(
          "pointer-events-none absolute left-1/2 top-[calc(100%+8px)] z-20 w-56 -translate-x-1/2 rounded-lg border px-3 py-2 text-[12px] leading-snug opacity-0 transition-opacity duration-200 group-hover:opacity-100",
          s.accent
            ? "border-[var(--accent-30)] bg-surface-1 text-fg-muted"
            : "border-[var(--hairline)] bg-surface-1 text-fg-muted"
        )}
      >
        {s.strength}
      </div>
    </div>
  );
}

export default function Landscape() {
  return (
    <section id="landscape" className="relative isolate mx-auto w-full max-w-6xl overflow-hidden px-6 py-28">
      <Motif
        src="/motifs/g44.svg"
        className="absolute bottom-[6%] left-[-4%] -z-10 h-[360px] w-[360px] opacity-[0.09]"
      />
      <div className="reveal max-w-2xl">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-fg-faint">
          Where it sits
        </p>
        <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.03em] text-fg sm:text-5xl">
          Different tools, different jobs.
        </h2>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-fg-muted">
          We don&apos;t think there&apos;s a head-to-head here. Here&apos;s roughly who&apos;s good at
          what — and the corner we focus on.
        </p>
      </div>

      {/* ── Desktop: the 2-axis positioning map ───────────────────────── */}
      <div className="reveal mt-14 hidden md:block">
        <div className="relative h-[460px] overflow-hidden rounded-2xl border border-[var(--hairline)] bg-surface-1">
          {/* axis lines */}
          <div
            className="pointer-events-none absolute left-[8%] right-[8%] top-1/2 h-px bg-[var(--hairline)]"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute bottom-[8%] top-[8%] left-1/2 w-px bg-[var(--hairline)]"
            aria-hidden
          />

          {/* X axis ticks (accent) */}
          <span className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 font-mono text-[11px] uppercase tracking-[0.14em] text-fg-faint">
            fixed / deterministic
          </span>
          <span className="pointer-events-none absolute right-6 top-1/2 -translate-y-1/2 font-mono text-[11px] uppercase tracking-[0.14em] text-fg-faint">
            agentic / adaptive
          </span>

          {/* Y axis ticks (accent) */}
          <span className="pointer-events-none absolute left-1/2 top-5 -translate-x-1/2 font-mono text-[11px] uppercase tracking-[0.14em] text-fg-faint">
            designs &amp; improves it
          </span>
          <span className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 font-mono text-[11px] uppercase tracking-[0.14em] text-fg-faint">
            runs your flow
          </span>

          {/* system chips */}
          {SYSTEMS.map((s) => (
            <MapChip key={s.name} s={s} />
          ))}
        </div>

        <p className="mt-4 font-mono text-xs text-fg-faint">
          Pi Flow&apos;s niche: agentic · self-designing · self-improving · long-horizon · production
        </p>
      </div>

      {/* ── Mobile: stacked list (same content, legible) ──────────────── */}
      <ul className="reveal mt-12 grid gap-3 md:hidden">
        {SYSTEMS.map((s) => (
          <li
            key={s.name}
            className={cn(
              "rounded-xl border bg-surface-1 p-4",
              s.accent
                ? "border-[var(--accent-30)] [box-shadow:0_0_36px_-12px_var(--accent-glow)]"
                : "border-[var(--hairline)]"
            )}
          >
            <p
              className={cn(
                "text-[15px] font-semibold",
                s.accent ? "text-accent" : "text-fg"
              )}
            >
              {s.name}
            </p>
            <p className="mt-1 text-sm leading-snug text-fg-muted">{s.strength}</p>
          </li>
        ))}
        <li className="mt-1 font-mono text-xs text-fg-faint">
          Pi Flow&apos;s niche: agentic · self-designing · self-improving · long-horizon · production
        </li>
      </ul>
    </section>
  );
}
