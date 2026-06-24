import HeroLatticeArt from "@/components/iso/art/HeroLatticeArt";

function CodeEditor() {
  // A few lines of intent — "describe the goal." Monochrome by design;
  // accent appears only on the status chip + caret (action voice, no files).
  const Kw = ({ children }: { children: React.ReactNode }) => (
    <span className="text-fg">{children}</span>
  );
  const Arg = ({ children }: { children: React.ReactNode }) => (
    <span className="text-fg-muted">{children}</span>
  );
  return (
    <div className="editor w-full">
      <div className="editor-bar">
        <span className="editor-dot" />
        <span className="editor-dot" />
        <span className="editor-dot" />
        <span className="ml-2 font-mono text-xs text-fg-faint">a flow, in a few lines</span>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-7">
        <code>
          <Kw>flow</Kw> <Arg>&quot;morning repost&quot;</Arg>
          {"\n"}
          {"  "}
          <Kw>every</Kw> <Arg>day at 8:00am</Arg>
          {"\n"}
          {"  "}
          <Kw>watch</Kw>{"  "}
          <Arg>&lt;paste a post URL&gt;</Arg>
          {"\n"}
          {"  "}
          <Kw>rewrite</Kw> <Arg>it in my voice</Arg>
          {"\n"}
          {"  "}
          <Kw>post</Kw>{"   "}
          <Arg>to my channel</Arg>
          <span className="caret" aria-hidden />
        </code>
      </pre>
      <div className="flex items-center gap-2 border-t border-[var(--hairline)] px-5 py-3 font-mono text-xs text-fg-muted">
        <span className="size-1.5 rounded-full bg-accent" aria-hidden />
        designed, running, and improving — every run
      </div>
    </div>
  );
}

export default function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      <div className="aurora" aria-hidden />
      <div
        aria-hidden
        className="pointer-events-none absolute right-[-8%] top-[58%] z-0 hidden w-[54%] -translate-y-1/2 opacity-45 lg:block"
      >
        <HeroLatticeArt className="w-full" />
      </div>

      <div className="relative z-10 mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-14 px-6 pt-36 pb-24 lg:grid-cols-[1.15fr_0.85fr] lg:pt-44 lg:pb-32">
        {/* Left — the pitch */}
        <div className="relative z-10">
          <p className="blur-in inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-fg-muted">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            Agent orchestration substrate
          </p>

          <h1
            className="blur-in mt-7 max-w-xl text-balance text-5xl font-semibold leading-[1.04] tracking-[-0.03em] text-fg sm:text-6xl"
            style={{ animationDelay: "0.05s" }}
          >
            Describe the goal. It builds the workflow — and improves it every run.
          </h1>

          <p
            className="blur-in mt-7 max-w-lg text-lg leading-relaxed text-fg-muted"
            style={{ animationDelay: "0.12s" }}
          >
            Pi Flow is a self-designing, durable, self-improving agent substrate. An agent designs
            the graph, a fleet of sealed full-agent nodes runs it, and a learning loop makes it
            better — run after run.
          </p>

          <div
            className="blur-in mt-10 flex flex-wrap items-center gap-3"
            style={{ animationDelay: "0.18s" }}
          >
            <a
              href="#start"
              className="inline-flex h-11 items-center rounded-full bg-accent px-6 text-sm font-medium text-[var(--accent-ink)] transition-opacity hover:opacity-90"
            >
              Start a flow
            </a>
            <a
              href="#loop"
              className="inline-flex h-11 items-center rounded-full border border-[var(--hairline)] px-6 text-sm font-medium text-fg transition-colors hover:border-[var(--hairline-2)]"
            >
              See the loop ↓
            </a>
          </div>

          <p
            className="blur-in mt-9 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-xs text-fg-faint"
            style={{ animationDelay: "0.24s" }}
          >
            <span>self-designing</span>
            <span aria-hidden>·</span>
            <span>durable</span>
            <span aria-hidden>·</span>
            <span>sandboxed nodes</span>
            <span aria-hidden>·</span>
            <span>centralized, not a swarm</span>
          </p>
        </div>

        {/* Right — the editor, floating in front of the hero lattice */}
        <div className="blur-in relative z-10" style={{ animationDelay: "0.16s" }}>
          <CodeEditor />
        </div>
      </div>
    </section>
  );
}
