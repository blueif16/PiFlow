import { Marquee } from "@/components/ui/marquee";
import { Motif } from "@/components/iso/Motif";

/* One accent hue, three opacities = three block "types".
   var(--accent) is reserved for the differentiator (Hermes). */
type Stripe = "var(--accent)" | "var(--accent-60)" | "var(--accent-30)";

const BLOCKS: { label: string; action: string; stripe: Stripe }[] = [
  { label: "Listener", action: "reacts on events, never polls", stripe: "var(--accent-60)" },
  { label: "Hermes", action: "remembers what worked across runs", stripe: "var(--accent)" },
  { label: "Debug", action: "fixes this instance", stripe: "var(--accent-30)" },
  { label: "Retry", action: "backs off and retries", stripe: "var(--accent-30)" },
  { label: "Schedule", action: "wakes on a trigger", stripe: "var(--accent-60)" },
  { label: "Gate", action: "blocks on a failed check", stripe: "var(--accent-30)" },
  { label: "Improve", action: "rewrites the flow for next run", stripe: "var(--accent-60)" },
  { label: "Branch", action: "routes on the result", stripe: "var(--accent-30)" },
];

function Block({ label, action, stripe }: { label: string; action: string; stripe: Stripe }) {
  const isHermes = stripe === "var(--accent)";
  return (
    <div className="lift flex w-56 items-stretch gap-3 rounded-xl border border-[var(--hairline)] bg-surface-2 p-4">
      {/* left vertical TYPE-STRIPE — accent at one of three opacities encodes the block's type */}
      <span
        aria-hidden
        className="w-1 shrink-0 self-stretch rounded-full"
        style={{ background: stripe }}
      />
      <div className="min-w-0">
        <p
          className={
            "font-mono text-[13px] tracking-tight " + (isHermes ? "text-accent" : "text-fg")
          }
        >
          {label}
        </p>
        <p className="mt-1 truncate text-xs leading-snug text-fg-muted">{action}</p>
      </div>
    </div>
  );
}

export default function ControlL3() {
  return (
    <section id="control" className="relative overflow-hidden py-28">
      <div
        aria-hidden
        className="absolute right-[3%] top-[44%] z-0 hidden -translate-y-1/2 lg:block"
      >
        <Motif
          src="/motifs/g9.svg"
          motion="spin-slow"
          className="h-[470px] w-[470px] opacity-[0.14]"
        />
      </div>

      {/* Copy */}
      <div className="reveal relative z-10 mx-auto w-full max-w-6xl px-6">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-fg-faint">
          L3 · Control plane
        </p>
        <h2 className="mt-4 max-w-2xl text-balance text-4xl font-semibold tracking-[-0.03em] text-fg sm:text-5xl">
          A background brain that never sleeps.
        </h2>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-fg-muted">
          A background listener watches every run and steps in the instant a node stalls — no
          polling. The Hermes block keeps long-term memory of what worked, so flows carry across long
          horizons, spin up new ones, and improve-and-repeat.
        </p>
      </div>

      {/* Two continuous decks. Full-bleed rail with edge fades so the blocks read as
          infinitely extensible; the second deck peeks from below the bottom mask. */}
      <div
        className="relative z-10 mt-16 w-full select-none"
        style={{
          WebkitMaskImage:
            "linear-gradient(to right, transparent, #000 12%, #000 88%, transparent)",
          maskImage: "linear-gradient(to right, transparent, #000 12%, #000 88%, transparent)",
        }}
      >
        {/* Top deck — primary, forward, faster */}
        <Marquee pauseOnHover className="[--duration:38s] [--gap:1rem]">
          {BLOCKS.map((b) => (
            <Block key={b.label} {...b} />
          ))}
        </Marquee>

        {/* Second deck — reverse, slower, partially visible: scaled down, dimmed,
            pulled up and clipped by the section so it reads "the blocks keep going". */}
        <div className="-mt-2 h-16 overflow-hidden">
          <Marquee
            reverse
            pauseOnHover
            className="[--duration:50s] [--gap:1rem] origin-top -translate-y-1 scale-[0.92] opacity-60"
          >
            {BLOCKS.map((b) => (
              <Block key={b.label} {...b} />
            ))}
          </Marquee>
        </div>
      </div>

      <p className="reveal relative z-10 mx-auto mt-6 w-full max-w-6xl px-6 font-mono text-xs text-fg-faint">
        background listener — reacts, never polls.
      </p>
    </section>
  );
}
