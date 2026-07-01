/**
 * NodeGates — the LEGIBLE projection of a node's authored post-node consequence chain (its `config.gates`,
 * distilled by core `summarizeGates` and carried through observe). Two variants, one source:
 *   - "card"   → a compact always-on glyph row (the "short symbol") beneath the node card.
 *   - "detail" → a labeled "what happens after this node" list for the expanded HUD.
 *
 * PURE + presentational: it reads the run-view's `GateSummary` and renders it — it NEVER reads the template
 * `/__piflow/node-config` side-channel (that is the Compose EDITOR's concern). config is the single source
 * of truth; this is an honest projection of it. Each entry is tinted by its on-fail POLICY so the posture
 * (blocks / warns / retries / escalates) reads at a glance without opening anything.
 */
import type { GateSummary, GateSummaryEntry } from "../data/runView";
import "../styles/gates.css";

type Tone = "block" | "warn" | "retry" | "escalate" | "human" | "muted" | "ok";

/** The on-fail POLICY (or the control kind) → a color tone. This is the whole point: the node's posture is
 *  visible in color + glyph, never color alone (each glyph is distinct + carries a title). */
function toneFor(e: GateSummaryEntry): Tone {
  if (e.advisory) return "muted";
  if (e.onFail) {
    if (e.onFail === "block" || e.onFail === "stop") return "block";
    if (e.onFail === "warn") return "warn";
    if (e.onFail === "retry") return "retry";
    if (e.onFail === "escalate") return "escalate";
  }
  if (e.kind === "reroute" || e.kind === "retry") return "retry";
  if (e.kind === "escalate") return "escalate";
  if (e.kind === "human") return "human";
  if (e.kind === "notify") return "muted";
  return "ok";
}

/** A one-line human summary of the chain — the row's title/aria (screen-reader + hover legibility). */
export function gatesTip(gates: GateSummary): string {
  const parts = gates.entries.map((e) => `${e.label}${e.onFail ? ` → ${e.onFail}` : ""}`);
  return `after this node: ${parts.join("; ")}`;
}

/** Tiny inline glyph per consequence kind (the KindIcon pattern — no icon dependency, 13px). */
function GateGlyph({ kind }: { kind: GateSummaryEntry["kind"] }) {
  const p = { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true } as const;
  switch (kind) {
    case "check": // a checkmark — a deterministic floor predicate
      return (
        <svg {...p}>
          <path d="M3 8.5l3 3 7-7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "exec": // a play triangle — a deterministic command gate
      return (
        <svg {...p}>
          <path d="M5 3.5l7 4.5-7 4.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      );
    case "judge": // balance scales — an agentic judge (mirrors the Critic preset glyph)
      return (
        <svg {...p}>
          <path d="M8 2.5v11M4.5 13.5h7M3 5h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M3 5L1.4 8.4a1.9 1.9 0 003.2 0zM13 5l-1.6 3.4a1.9 1.9 0 003.2 0z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
        </svg>
      );
    case "reroute": // a return loop — judge-fail routes back to the producer
    case "retry": // a circular arrow — re-run
      return (
        <svg {...p}>
          <path d="M12.5 6.5A5 5 0 103.5 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M12.8 3.5v3h-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "escalate": // an up arrow — re-run on a stronger model
      return (
        <svg {...p}>
          <path d="M8 13V4M4.5 7.5L8 4l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "notify": // a bell
      return (
        <svg {...p}>
          <path d="M4.5 11h7l-1-1.5V7a2.5 2.5 0 00-5 0v2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M7 12.5a1 1 0 002 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "human": // a person — a HITL checkpoint (stops for approval)
      return (
        <svg {...p}>
          <circle cx="8" cy="5" r="2.2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3.8 13c0-2.1 1.9-3.4 4.2-3.4s4.2 1.3 4.2 3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
  }
}

/** The compact always-on glyph row for the node card (the "short symbol"). */
function CardRow({ gates }: { gates: GateSummary }) {
  return (
    <div className="ds-gates ds-gates--card" title={gatesTip(gates)} aria-label={gatesTip(gates)}>
      {gates.entries.map((e, i) => (
        <span key={`${e.kind}-${i}`} className="ds-gate" data-tone={toneFor(e)}>
          <GateGlyph kind={e.kind} />
        </span>
      ))}
    </div>
  );
}

/** The labeled detail list for the HUD — "what happens after this node", one row per consequence. */
function DetailList({ gates }: { gates: GateSummary }) {
  return (
    <div className="ds-gates ds-gates--detail" aria-label="what happens after this node">
      {gates.entries.map((e, i) => (
        <div key={`${e.kind}-${i}`} className="ds-gate-row" data-tone={toneFor(e)}>
          <span className="ds-gate"><GateGlyph kind={e.kind} /></span>
          <span className="ds-gate-row__label">{e.label}</span>
          {e.when !== "post" && <span className="ds-gate-row__when">{e.when}</span>}
          {e.onFail && <span className="ds-gate-row__policy">→ {e.onFail}</span>}
          {e.advisory && <span className="ds-gate-row__policy">advisory</span>}
        </div>
      ))}
    </div>
  );
}

export function NodeGates({ gates, variant }: { gates?: GateSummary; variant: "card" | "detail" }) {
  if (!gates || gates.entries.length === 0) return null;
  return variant === "card" ? <CardRow gates={gates} /> : <DetailList gates={gates} />;
}
