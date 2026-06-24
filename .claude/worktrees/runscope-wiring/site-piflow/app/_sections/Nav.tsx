const LINKS = [
  { label: "How it works", href: "#loop" },
  { label: "Layers", href: "#layers" },
  { label: "Findings", href: "#findings" },
  { label: "Docs", href: "#" },
];

export default function Nav() {
  return (
    <header className="nav fixed inset-x-0 top-0 z-50">
      <nav className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
        <a href="#top" className="flex items-center gap-2 font-mono text-sm tracking-tight text-fg">
          <span className="inline-block size-1.5 rounded-full bg-accent" aria-hidden />
          piflow
        </a>

        <div className="hidden items-center gap-7 md:flex">
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="text-sm text-fg-muted transition-colors hover:text-fg"
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <a
            href="#"
            className="hidden text-sm text-fg-muted transition-colors hover:text-fg sm:inline"
          >
            GitHub
          </a>
          <a
            href="#start"
            className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-sm font-medium text-[var(--accent-ink)] transition-opacity hover:opacity-90"
          >
            Start a flow
          </a>
        </div>
      </nav>
    </header>
  );
}
