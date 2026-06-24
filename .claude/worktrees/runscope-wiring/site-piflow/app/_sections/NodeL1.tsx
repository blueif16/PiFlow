import SealedNodeArt from "@/components/iso/art/SealedNodeArt";

export default function NodeL1() {
  return (
    <section id="node" className="mx-auto w-full max-w-6xl px-6 py-28">
      <div className="grid grid-cols-1 items-center gap-16 lg:grid-cols-[0.95fr_1.05fr]">
        {/* Illustration — a full agent sealed in a sandbox, tools docking in */}
        <div className="reveal relative mx-auto w-full max-w-[460px]">
          <SealedNodeArt className="w-full" />
        </div>

        {/* Copy */}
        <div className="reveal">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-fg-faint">L1 · The node</p>
          <h2 className="mt-4 max-w-md text-balance text-4xl font-semibold tracking-[-0.03em] text-fg sm:text-5xl">
            Every node is a full agent in a sealed box.
          </h2>
          <p className="mt-6 max-w-md text-lg leading-relaxed text-fg-muted">
            Not a thin model call — a complete agent, isolated in its own sandbox, holding exactly the
            tools and files you grant it. Bind anything: built-ins, your own functions, or the wider
            OpenClaw community ecosystem.
          </p>
          <ul className="mt-8 grid gap-3 sm:grid-cols-2">
            {[
              "Sealed sandbox per node",
              "Declarative tool bindings",
              "Native OpenClaw tools",
              "Verified, never assumed",
            ].map((p) => (
              <li key={p} className="flex items-center gap-2.5 text-sm text-fg">
                <span className="size-1.5 rounded-full bg-accent" aria-hidden />
                {p}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
