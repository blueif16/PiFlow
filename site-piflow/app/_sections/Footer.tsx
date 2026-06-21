const COLS = [
  { head: "Product", links: ["How it works", "Layers", "Findings", "Capabilities"] },
  { head: "Docs", links: ["Architecture", "Design canon", "Roadmap", "Quickstart"] },
  { head: "Project", links: ["GitHub", "OpenClaw tools", "License (MIT)"] },
];

export default function Footer() {
  return (
    <footer className="mx-auto w-full max-w-6xl px-6 py-16">
      <div className="grid grid-cols-2 gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <a href="#top" className="flex items-center gap-2 font-mono text-sm tracking-tight text-fg">
            <span className="inline-block size-1.5 rounded-full bg-accent" aria-hidden />
            piflow
          </a>
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-fg-muted">
            A self-designing, durable, self-improving agent orchestration substrate.
          </p>
        </div>
        {COLS.map((c) => (
          <div key={c.head}>
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-fg-faint">{c.head}</p>
            <ul className="mt-4 space-y-2.5">
              {c.links.map((l) => (
                <li key={l}>
                  <a href="#" className="text-sm text-fg-muted transition-colors hover:text-fg">
                    {l}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mt-14 flex flex-col gap-2 border-t border-[var(--hairline)] pt-6 font-mono text-xs text-fg-faint sm:flex-row sm:items-center sm:justify-between">
        <span>© 2026 Pi Flow · MIT</span>
        <span>compose · run · improve — repeat</span>
      </div>
    </footer>
  );
}
