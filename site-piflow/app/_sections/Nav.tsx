import Link from "next/link";

const GITHUB_URL = "https://github.com/blueif16/PiFlow";

// Top-level destinations only. Demo + Roadmap are placeholders until those
// pages exist; Docs routes to the public docs.
const LINKS = [
  { label: "Demo", href: "#" },
  { label: "Docs", href: "/docs" },
  { label: "Roadmap", href: "#" },
];

export default function Nav() {
  return (
    <header className="fixed inset-x-0 top-3 z-50 px-3 sm:px-5">
      <nav className="mx-auto grid h-14 w-full max-w-6xl grid-cols-[1fr_auto_1fr] items-center rounded-2xl border border-[var(--hairline)] bg-[rgba(12,12,13,0.5)] px-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04),0_10px_30px_-14px_rgba(0,0,0,0.7)] backdrop-blur-xl sm:px-5">
        {/* Wordmark */}
        <a
          href="#top"
          className="justify-self-start text-[15px] font-semibold tracking-tight text-fg transition-opacity hover:opacity-80"
        >
          PiFlow
        </a>

        {/* Centered nav */}
        <div className="col-start-2 hidden items-center gap-8 md:flex">
          {LINKS.map((l) =>
            l.href.startsWith("/") ? (
              <Link
                key={l.label}
                href={l.href}
                className="text-sm text-fg-muted transition-colors hover:text-fg"
              >
                {l.label}
              </Link>
            ) : (
              <a
                key={l.label}
                href={l.href}
                className="text-sm text-fg-muted transition-colors hover:text-fg"
              >
                {l.label}
              </a>
            ),
          )}
        </div>

        {/* Unique icon-only GitHub button */}
        <div className="justify-self-end">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="View PiFlow on GitHub"
            className="group inline-flex size-9 items-center justify-center rounded-xl border border-[var(--hairline)] bg-[var(--surface-2)]/40 text-fg-muted transition-all duration-300 hover:-translate-y-0.5 hover:border-[var(--accent-30)] hover:text-fg hover:shadow-[0_0_0_1px_rgba(61,242,167,0.3),0_8px_24px_-8px_rgba(61,242,167,0.35)]"
          >
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden
              className="size-[18px] transition-transform duration-300 group-hover:scale-110"
            >
              <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.16-.02-2.1-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 2.9-.39c.98 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.07.78 2.16 0 1.56-.01 2.82-.01 3.2 0 .31.21.68.8.56C20.71 21.39 24 17.08 24 12 24 5.73 18.27.5 12 .5Z" />
            </svg>
          </a>
        </div>
      </nav>
    </header>
  );
}
