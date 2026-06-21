import LoopArt from "@/components/iso/art/LoopArt";

export default function Loop() {
  return (
    <section className="relative mx-auto w-full max-w-6xl px-6 py-28 sm:py-36" id="loop">
      <div className="reveal mx-auto max-w-2xl text-center">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-fg-faint">The shape</p>
        <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.03em] text-fg sm:text-5xl">
          A loop, not a pipeline.
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-fg-muted">
          Design the graph. Run it. Learn from the run — then refine and run again. The output of
          one run is the input to the next.
        </p>
      </div>

      <div className="reveal mt-10">
        <LoopArt className="mx-auto w-full max-w-3xl" />
      </div>

      <p className="reveal mt-2 text-center font-mono text-xs text-fg-faint">
        re-compose a new flow — or refine this one and repeat
      </p>
    </section>
  );
}
