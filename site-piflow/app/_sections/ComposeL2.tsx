import ComposeDagArt from "@/components/iso/art/ComposeDagArt";

const BULLETS = [
  "Decomposes the goal",
  "Discovers the right tools",
  "Edges inferred, not drawn",
  "Parallel by default",
];

export default function ComposeL2() {
  return (
    <section id="compose" className="mx-auto w-full max-w-6xl px-6 py-28">
      <div className="grid grid-cols-1 items-center gap-16 lg:grid-cols-[1fr_1.1fr]">
        {/* Copy */}
        <div className="reveal">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-fg-faint">
            L2 · Compose
          </p>
          <h2 className="mt-4 max-w-md text-balance text-4xl font-semibold tracking-[-0.03em] text-fg sm:text-5xl">
            Hand it a goal. It designs the graph.
          </h2>
          <p className="mt-6 max-w-md text-lg leading-relaxed text-fg-muted">
            An agent breaks your goal into the work that gets it done, finds the right tools for each
            piece, and wires them into a flow. Independent steps run side by side; the dependencies
            between them become the edges.
          </p>
          <ul className="mt-8 grid gap-3 sm:grid-cols-2">
            {BULLETS.map((b) => (
              <li key={b} className="flex items-center gap-2.5 text-sm text-fg">
                <span className="size-1.5 rounded-full bg-accent" aria-hidden />
                {b}
              </li>
            ))}
          </ul>
        </div>

        {/* Illustration — a designed DAG: one goal fans out, then converges */}
        <div className="reveal">
          <ComposeDagArt className="mx-auto w-full max-w-2xl lg:max-w-none" />
        </div>
      </div>
    </section>
  );
}
