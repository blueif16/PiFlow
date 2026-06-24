import { Box, Workflow, Radar } from "lucide-react";

const LAYERS = [
  {
    tag: "L1 · The node",
    title: "A full agent, sealed.",
    line: "Every node runs isolated, with only the tools you grant.",
    points: ["Sealed sandbox per node", "Declarative tool & function bindings", "Native OpenClaw community tools"],
    href: "#node",
    Icon: Box,
  },
  {
    tag: "L2 · Compose",
    title: "It designs the graph.",
    line: "Hand it a goal; it wires the flow — parallel by default.",
    points: ["Decomposes the goal", "Discovers the right tools", "Edges inferred, not drawn"],
    href: "#compose",
    Icon: Workflow,
  },
  {
    tag: "L3 · Control plane",
    title: "A background brain.",
    line: "Watches every run, remembers what worked.",
    points: ["Background listener, not polling", "Debug fixes the instance, Hermes the class", "Long-horizon, improve-and-repeat"],
    href: "#control",
    Icon: Radar,
  },
];

export default function LayerCards() {
  return (
    <section id="layers" className="mx-auto w-full max-w-6xl px-6 py-24">
      <div className="reveal mb-12 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <h2 className="max-w-md text-balance text-3xl font-semibold tracking-[-0.02em] text-fg sm:text-4xl">
          Three layers. One loop.
        </h2>
        <p className="max-w-sm text-sm leading-relaxed text-fg-muted">
          Hover a layer to open it. Each one owns a different kind of intelligence — and hands off to
          the next through the filesystem.
        </p>
      </div>

      <div className="exp-row reveal min-h-[280px]">
        {LAYERS.map((l) => (
          <article
            key={l.tag}
            tabIndex={0}
            className="exp-card flex flex-col rounded-2xl border border-[var(--hairline)] bg-surface-1 p-6 outline-none focus-visible:border-[var(--hairline-2)]"
          >
            <span className="flex size-10 items-center justify-center rounded-xl border border-[var(--hairline)] bg-surface-2 text-accent">
              <l.Icon className="size-5" strokeWidth={1.6} />
            </span>
            <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-fg-faint">
              {l.tag}
            </p>
            <h3 className="mt-2 whitespace-nowrap text-xl font-semibold text-fg">{l.title}</h3>

            <div className="exp-body mt-3">
              <p className="max-w-xs text-sm leading-relaxed text-fg-muted">{l.line}</p>
              <ul className="mt-5 space-y-2">
                {l.points.map((p) => (
                  <li key={p} className="flex items-center gap-2.5 text-sm text-fg">
                    <span className="size-1 rounded-full bg-accent" aria-hidden />
                    {p}
                  </li>
                ))}
              </ul>
              <a
                href={l.href}
                className="mt-6 inline-block text-sm text-fg-muted underline-offset-4 transition-colors hover:text-accent"
              >
                Go deeper ↓
              </a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
