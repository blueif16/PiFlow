/**
 * GateGlyph — the ONE gate icon vocabulary, shared by the left-edge rail, the on-node hex icons, and the
 * HUD "Hooks" lanes. Two exports:
 *   - <GateKindGlyph kind> — a tiny inline SVG per gate glyph (no icon dependency, the KindIcon pattern).
 *   - <GateHex desc size>  — the angular HEXAGON container the glyph sits in, tinted by the gate's policy tone
 *                            (severity reads at a glance; the glyph is ALSO distinct + titled, never color alone).
 *
 * The three authorable rail kinds get purpose marks (execution = a robot; agentic check "judge" = the agent
 * scales; human = a person); the remaining observed kinds (check/retry/escalate/notify) reuse the established
 * marks so an observed chain reads in the same vocabulary. config is the source of truth — this only draws it.
 */
import type { GateGlyphKind, GateHexDesc } from "../data/gates";
import "../styles/gates.css";

/** A tiny inline glyph per gate glyph-kind (16×16 viewBox, stroke-based, currentColor). */
export function GateKindGlyph({ kind }: { kind: GateGlyphKind }) {
  const p = { viewBox: "0 0 16 16", fill: "none", "aria-hidden": true } as const;
  switch (kind) {
    case "execution": // a ROBOT head — an agent-written script gates the output (programmatic judgment)
      return (
        <svg {...p}>
          <path d="M8 4.6V3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="8" cy="2.3" r="0.95" stroke="currentColor" strokeWidth="1.1" />
          <rect x="3.4" y="4.6" width="9.2" height="7.4" rx="1.8" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="6.1" cy="8.2" r="0.95" fill="currentColor" />
          <circle cx="9.9" cy="8.2" r="0.95" fill="currentColor" />
          <path d="M6.4 10.4h3.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      );
    case "judge": // balance scales — an AGENTIC CHECK: a verify agent weighs the output against a bar
      return (
        <svg {...p}>
          <path d="M8 2.5v11M4.5 13.5h7M3 5h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M3 5L1.4 8.4a1.9 1.9 0 003.2 0zM13 5l-1.6 3.4a1.9 1.9 0 003.2 0z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
        </svg>
      );
    case "human": // a person — a HITL checkpoint (a person approves before the output propagates)
      return (
        <svg {...p}>
          <circle cx="8" cy="5" r="2.2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3.8 13c0-2.1 1.9-3.4 4.2-3.4s4.2 1.3 4.2 3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case "check": // a checkmark — a deterministic floor predicate
      return (
        <svg {...p}>
          <path d="M3 8.5l3 3 7-7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "retry": // a circular arrow — re-run / reroute back
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
  }
}

/** The angular HEXAGON container: a tone-tinted ring around the glyph, sitting on the background (no card box).
 *  `size` is the pixel edge (rest ~20px on a node, ~34px on the rail). The tone drives the ring + glyph color. */
export function GateHex({ desc, size = 22, title }: { desc: GateHexDesc; size?: number; title?: string }) {
  const tip = title ?? desc.label;
  return (
    <span
      className="ds-hex"
      data-tone={desc.tone}
      style={{ ["--hex-size" as string]: `${size}px` }}
      title={tip}
      aria-label={tip}
      role="img"
    >
      <GateKindGlyph kind={desc.glyph} />
    </span>
  );
}
