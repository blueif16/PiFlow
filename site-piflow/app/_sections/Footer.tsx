import Link from "next/link";

const GITHUB_URL = "https://github.com/blueif16/PiFlow";

const COLS = [
  {
    head: "Product",
    links: [
      { label: "Overview", href: "#top" },
      { label: "Product", href: "#agents" },
      { label: "Get started", href: "#start" },
      { label: "Formats", href: "#layers" },
    ],
  },
  {
    head: "Docs",
    links: [
      { label: "Getting started", href: "/docs/start/getting-started" },
      { label: "Architecture", href: "/docs/concepts/architecture" },
      { label: "Compose", href: "/docs/concepts/compose" },
      { label: "Run on pi", href: "/docs/guides/run-on-pi" },
    ],
  },
  {
    head: "Project",
    links: [
      { label: "GitHub", href: GITHUB_URL },
      { label: "Docs", href: "/docs" },
      { label: "License (MIT)", href: `${GITHUB_URL}/blob/main/LICENSE` },
    ],
  },
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
              {c.links.map((l) => {
                const cls = "text-sm text-fg-muted transition-colors hover:text-fg";
                return (
                  <li key={l.label}>
                    {l.href.startsWith("/") ? (
                      <Link href={l.href} className={cls}>
                        {l.label}
                      </Link>
                    ) : (
                      <a
                        href={l.href}
                        {...(l.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                        className={cls}
                      >
                        {l.label}
                      </a>
                    )}
                  </li>
                );
              })}
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
