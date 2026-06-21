import { Motif } from "@/components/iso/Motif";

export default function CTA() {
  return (
    <section id="start" className="relative isolate overflow-hidden border-y border-[var(--hairline)]">
      <div className="aurora" aria-hidden />
      <Motif
        src="/motifs/m25.svg"
        motion="spin-slow"
        className="absolute left-1/2 top-1/2 -z-10 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 opacity-[0.10]"
      />
      <div className="relative z-10 mx-auto w-full max-w-3xl px-6 py-32 text-center">
        <h2 className="reveal text-balance text-4xl font-semibold tracking-[-0.03em] text-fg sm:text-5xl">
          Build flows that build themselves.
        </h2>
        <p className="reveal mx-auto mt-5 max-w-lg text-lg leading-relaxed text-fg-muted">
          Describe the goal once. An agent designs the graph, a sealed fleet runs it, and a learning
          loop makes it better — every run.
        </p>
        <div className="reveal mt-10 flex flex-wrap items-center justify-center gap-3">
          <a
            href="#"
            className="inline-flex h-11 items-center rounded-full bg-accent px-6 text-sm font-medium text-[var(--accent-ink)] transition-opacity hover:opacity-90"
          >
            Start a flow
          </a>
          <a
            href="#"
            className="inline-flex h-11 items-center rounded-full border border-[var(--hairline)] px-6 text-sm font-medium text-fg transition-colors hover:border-[var(--hairline-2)]"
          >
            Read the docs →
          </a>
        </div>
        <p className="reveal mt-9 inline-flex items-center gap-2 font-mono text-xs text-fg-faint">
          <span className="size-1.5 rounded-full bg-accent" aria-hidden />
          self-designing · durable · self-improving
        </p>
      </div>
    </section>
  );
}
