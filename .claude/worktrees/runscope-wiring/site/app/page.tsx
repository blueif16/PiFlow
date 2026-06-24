export default function Home() {
  return (
    <>
      {/* Grain — the only effect. Fixed, full-viewport, non-interactive. */}
      <div className="grain" aria-hidden />

      <div className="relative flex min-h-dvh flex-col">
        {/* Bare top bar: just a mono wordmark placeholder. */}
        <header className="mx-auto flex w-full max-w-5xl items-center px-6 py-6">
          <span className="font-mono text-sm tracking-tight text-fg">
            ◆ brand
          </span>
        </header>

        {/* Hero — centered, generous whitespace, ~120px vertical padding. */}
        <main className="flex flex-1 items-center">
          <section className="mx-auto w-full max-w-3xl px-6 py-[120px] text-center">
            {/* Mono eyebrow / label. */}
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-fg-muted">
              EYEBROW — LABEL
            </p>

            {/* Display headline — negative tracking, tight line-height. */}
            <h1 className="mx-auto mt-7 max-w-2xl text-5xl font-semibold leading-[1.05] tracking-[-0.03em] text-fg sm:text-6xl">
              Your premium headline goes right here.
            </h1>

            {/* Muted subhead. */}
            <p className="mx-auto mt-7 max-w-xl text-lg leading-relaxed text-fg-muted">
              A one- or two-line subhead. Replace this copy in the next pass.
            </p>

            {/* Two CTAs in a row: primary accent + ghost link. */}
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <a
                href="#"
                className="inline-flex h-11 items-center rounded-full bg-accent px-6 text-sm font-medium text-[var(--accent-ink)] transition-opacity hover:opacity-90"
              >
                Primary action
              </a>
              <a
                href="#"
                className="inline-flex h-11 items-center rounded-full border border-[var(--hairline)] px-6 text-sm font-medium text-fg transition-colors hover:border-white/20"
              >
                Secondary link
              </a>
            </div>

            {/* Optional: accent status dot + mono caption. */}
            <p className="mt-10 inline-flex items-center gap-2 font-mono text-xs text-fg-muted">
              <span className="size-1.5 rounded-full bg-accent" aria-hidden />
              ready
            </p>
          </section>
        </main>
      </div>
    </>
  );
}
