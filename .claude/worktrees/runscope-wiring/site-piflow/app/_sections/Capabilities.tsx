import {
  Workflow,
  Puzzle,
  Lock,
  GitFork,
  ShieldCheck,
  History,
  RefreshCw,
} from "lucide-react";

type Capability = {
  title: string;
  line: string;
  Icon: React.ElementType;
  /** Grid span. Hero is 2x2; two fillers are wide; rest are 1x1. */
  span: string;
  emphasized?: boolean;
};

const CAPABILITIES: Capability[] = [
  {
    title: "Improve & repeat",
    line: "The Hermes block remembers what worked, so proven flows get better each run.",
    Icon: RefreshCw,
    span: "md:col-span-2 md:row-span-2",
    emphasized: true,
  },
  {
    title: "Design a flow from a goal",
    line: "Decompose, wire, route.",
    Icon: Workflow,
    span: "md:col-span-1",
  },
  {
    title: "Bind any tool",
    line: "Built-ins, your functions, OpenClaw community tools.",
    Icon: Puzzle,
    span: "md:col-span-1",
  },
  {
    title: "Seal every node",
    line: "Its own sandbox; only what you grant.",
    Icon: Lock,
    span: "md:col-span-1",
  },
  {
    title: "Run in parallel",
    line: "Independent work fans out by default.",
    Icon: GitFork,
    span: "md:col-span-1",
  },
  {
    title: "Verify every step",
    line: "Outputs checked, never assumed.",
    Icon: ShieldCheck,
    span: "md:col-span-2",
  },
  {
    title: "Carry long horizons",
    line: "Design the next phase after seeing the last.",
    Icon: History,
    span: "md:col-span-2",
  },
];

export default function Capabilities() {
  return (
    <section id="capabilities" className="mx-auto w-full max-w-6xl px-6 py-28">
      <div className="reveal mb-12 max-w-2xl">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-fg-faint">
          Capabilities
        </p>
        <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.03em] text-fg sm:text-5xl">
          What it lets you do.
        </h2>
      </div>

      <div className="grid auto-rows-[200px] grid-cols-2 gap-4 md:grid-cols-4">
        {CAPABILITIES.map((c) => {
          const emphasized = c.emphasized;
          return (
            <article
              key={c.title}
              className={
                "lift reveal flex flex-col justify-between rounded-2xl border bg-surface-1 p-6 " +
                c.span +
                " " +
                (emphasized
                  ? "border-[var(--accent-30)] [box-shadow:0_0_60px_-20px_var(--accent-glow)_inset]"
                  : "border-[var(--hairline)]")
              }
            >
              <span
                className={
                  "flex size-10 items-center justify-center rounded-xl border bg-surface-2 " +
                  (emphasized
                    ? "border-[var(--accent-30)] text-accent"
                    : "border-[var(--hairline)] text-fg-muted")
                }
              >
                <c.Icon className="size-5" strokeWidth={1.6} />
              </span>

              <div>
                <h3
                  className={
                    "font-semibold text-fg " +
                    (emphasized ? "text-2xl tracking-[-0.02em]" : "text-base")
                  }
                >
                  {c.title}
                </h3>
                <p
                  className={
                    "mt-1.5 text-fg-muted " +
                    (emphasized ? "max-w-sm text-base leading-relaxed" : "text-sm leading-snug")
                  }
                >
                  {c.line}
                </p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
