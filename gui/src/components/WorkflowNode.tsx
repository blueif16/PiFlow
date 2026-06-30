/**
 * WorkflowNode — a React Flow custom node. Flat hairline card (NOT glass, so
 * hundreds render cheaply). Carries:
 *   - 3px left status bar (idle / running / success / error) — the "game" signal
 *   - mono type label + agent/file icon
 *   - a one-line preview (file path or summary)
 *   - source/target handles
 *   - the shared-element origin: layoutId={`node-${id}`}
 *
 * Hover reaction is CSS-only (lift, see glass.css). Expansion is explicit:
 * click the card or the peek button → expand(id). Keyboard: the peek is a real
 * <button>, so Tab + Enter expands without a mouse.
 *
 * `nodeTypes` MUST be defined outside the canvas component (see WorkflowCanvas).
 */
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import * as motion from "motion/react-client";
import { useExpand } from "./ExpandContext";
import { useViewMode } from "./ViewModeContext";
import { NodeModeStrip } from "./NodeModeStrip";
import { NodeFusionToggle } from "./NodeFusionToggle";
import { NodeGateChips } from "./NodeGateChips";
import { ProgressBar } from "./ProgressBar";
import type { FieldTone } from "./FieldBlock";
import type { RunViewNode } from "../data/runView";

export type NodeStatus = "idle" | "selected" | "running" | "success" | "error";

/** one rectangular config cell rendered in the expanded overlay's field grid */
export interface NodeMetaField {
  label: string;
  value: string;
  tone?: FieldTone;
  /** render the value in mono (paths, ids, code-ish data) */
  mono?: boolean;
}

/** a telemetry cell for the monitor variant (value + delta + optional trend) */
export interface NodeMetric {
  label: string;
  value: string;
  /** signed delta, e.g. "+12%" / "-3"; auto-colored by sign */
  delta?: string;
  series?: number[];
}

/** one line in the stream variant's console */
export interface StreamLine {
  text: string;
  level?: "info" | "ok" | "warn" | "error";
}

/** upstream/downstream signals for the inspector variant */
export interface NodeIO {
  inputs?: string[];
  outputs?: string[];
}

export type FlowNodeData = {
  title: string;
  kind: "agent" | "file";
  typeLabel: string;
  status?: NodeStatus;
  preview?: string;
  /** full content shown in the expanded overlay */
  content?: string;
  /** how to render `content`: markdown / json get a themed reader (else inferred from typeLabel) */
  contentType?: "text" | "markdown" | "json";
  /** (SKIN channel) the node's runtime skin from its EFFECTIVE sandbox backend + config. 'cloud' ⇒ the
   *  extruded 3D block + cloud glyph (runs in daytona/e2b); 'unlocked' ⇒ the per-node fs jail was opened
   *  (config.fullAccess) → a small NEUTRAL unlock glyph; omitted/'flat' ⇒ the default local card (no attr). */
  runtime?: "flat" | "cloud" | "unlocked";
  /** 0..1 determinate progress; omit while running for an indeterminate sweep */
  progress?: number;
  /** Config panel: rectangular config blocks in the HUD */
  meta?: NodeMetaField[];
  /** Telemetry + Activity panels: metric tiles, an activity sparkline, an ETA */
  metrics?: NodeMetric[];
  activity?: number[];
  eta?: string;
  /** Stream panel: console output lines */
  logs?: Array<string | StreamLine>;
  /** Signals panel: I/O */
  io?: NodeIO;
  /** The full real run-view payload for this node — the HUD's source of truth (model, tools,
   *  scope-bucketed reads, timeline, writes, artifacts). Present for data-driven nodes. */
  rv?: RunViewNode;
  /** (G6) agent-PRESET branding, resolved from the catalog by the node's `agentType` (runView.toFlowGraph).
   *  `agentIcon` is a KEY → a bundled glyph; `agentColor` tints the chip's icon; `agentLabel` is the
   *  human label. Absent ⇒ the node renders its default agent/file glyph. */
  agentIcon?: string;
  agentColor?: string;
  agentLabel?: string;
};

export type FlowNode = Node<FlowNodeData, "flowNode">;

function KindIcon({ kind }: { kind: FlowNodeData["kind"] }) {
  // tiny inline glyphs — no icon dependency
  if (kind === "agent") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="5" r="2.4" stroke="currentColor" strokeWidth="1.3" />
        <path d="M3.5 13c0-2.2 2-3.6 4.5-3.6S12.5 10.8 12.5 13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 2h5l3 3v9H4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

/** (G6) Agent-PRESET glyphs, keyed by the `icon` string a preset declares (display.icon). A preset's icon
 *  is its headline — the pre-customized mark that makes a node feel purpose-built. An unknown key falls back
 *  to the default agent glyph, so a missing/new icon never breaks the chip (the icon is cosmetic). */
export function AgentPresetIcon({ icon }: { icon?: string }) {
  switch (icon) {
    case "chart-trend": // market-research — an upward trend line
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 12.5h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M3 10l3-3 2.5 2L13 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10.5 4H13v2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "file-search": // paper-analyzer — a document with a magnifier
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 2h5l3 3v4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M4 2v12h4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <circle cx="10.5" cy="11" r="2.3" stroke="currentColor" strokeWidth="1.3" />
          <path d="M12.2 12.7L14 14.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case "messages": // interview — two speech bubbles
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 4.5A1.5 1.5 0 013.5 3h6A1.5 1.5 0 0111 4.5v3A1.5 1.5 0 019.5 9H6L3.5 11V9A1.5 1.5 0 012 7.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M13 6.5h.5A1.5 1.5 0 0115 8v3a1.5 1.5 0 01-1.5 1.5H13L10.5 14v-2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
    case "spark": // general-purpose — a four-point sparkle (the do-anything default agent)
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2l1.2 4.8L14 8l-4.8 1.2L8 14l-1.2-4.8L2 8l4.8-1.2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
    case "compass": // explore — a compass (read-only fan-out search)
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 4.4l1.7 3.6L8 11.6 6.3 8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
    case "list": // plan — a checklist (step-by-step implementation plan)
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6 4.5h7M6 8h7M6 11.5h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="3.3" cy="4.5" r="1" fill="currentColor" />
          <circle cx="3.3" cy="8" r="1" fill="currentColor" />
          <circle cx="3.3" cy="11.5" r="1" fill="currentColor" />
        </svg>
      );
    case "scale": // verify → The Critic — balance scales (read-only judgment against a bar)
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2.5v11M4.5 13.5h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M3 5h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M3 5L1.4 8.4a1.9 1.9 0 003.2 0z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M13 5l-1.6 3.4a1.9 1.9 0 003.2 0z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
        </svg>
      );
    case "quill": // author → The Scribe — a pen nib (synthesize inputs into a polished artifact)
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M13.5 2.5c-3 .4-6 2.8-7.6 6.4L4.3 12.8l3.6-1.5c3.6-1.6 6-4.6 6.4-7.6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M6 9l1.6 1.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          <path d="M2.6 14l1.7-1.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    default: // unknown / no icon key → the default agent glyph
      return <KindIcon kind="agent" />;
  }
}

/** (SKIN channel) The cloud-runtime glyph — a small inline cloud (no icon dependency, the KindIcon
 *  pattern). Rendered on a 'cloud' node so the signal is not color-only (a11y / color-blind). */
function CloudGlyph() {
  return (
    <svg className="ds-node__cloud" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.5 12.5h6.2a2.6 2.6 0 00.3-5.18 3.4 3.4 0 00-6.43-1.06A2.85 2.85 0 004.5 12.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** (SKIN channel) The unlock glyph — a small OPEN padlock (the shackle swung clear of the body), drawn in
 *  the same recessive inline pattern as CloudGlyph. NEUTRAL, not an alarm: it signals "this node's fs jail
 *  was unlocked", muted (see .ds-node__runtime--unlocked in glass.css) — never red/danger. */
function UnlockGlyph() {
  return (
    <svg className="ds-node__unlock" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.5" y="7.5" width="9" height="6" rx="1.3" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.5 7.5V5a2.5 2.5 0 014.9-.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function WorkflowNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { expand } = useExpand();
  const { mode } = useViewMode();
  const status: NodeStatus = data.status ?? (selected ? "selected" : "idle");
  // (G6) a preset node leads with its branded icon, tinted by the preset's color; otherwise the default
  // agent/file accent. The icon is purely cosmetic — it never changes status, layout, or behavior.
  const accentColor = data.agentIcon
    ? (data.agentColor ?? "var(--ds-node-agent)")
    : data.kind === "agent" ? "var(--ds-node-agent)" : "var(--ds-node-file)";
  // show the charge bar while running, or whenever a node carries a progress value
  const showProgress = data.progress != null || status === "running";
  // (SKIN channel) a 'cloud' node renders as the extruded 3D block (data-runtime drives glass.css) + a
  // cloud glyph + an extended aria-label, so the runtime is signaled by SHAPE + GLYPH + TEXT, not color alone.
  const isCloud = data.runtime === "cloud";
  // (SKIN channel) an 'unlocked' node (per-node fs jail opened, config.fullAccess) gets a small NEUTRAL
  // open-padlock glyph in the header — informative, not an alarm (no red/danger; muted via glass.css).
  const isUnlocked = data.runtime === "unlocked";
  const hasRuntimeGlyph = isCloud || isUnlocked;

  return (
    <motion.div
      layoutId={`node-${id}`}
      className="ds-node"
      data-status={status}
      data-kind={data.kind}
      {...(hasRuntimeGlyph ? { "data-runtime": data.runtime } : {})}
      role="button"
      tabIndex={0}
      aria-label={`${data.kind} ${data.title}.${isCloud ? " Runs in cloud." : ""}${isUnlocked ? " Sandbox unlocked — full filesystem access." : ""} Press Enter to expand.`}
      onClick={() => expand(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          expand(id);
        }
      }}
    >
      <Handle type="target" position={Position.Left} className="ds-handle" />

      <div className="ds-node__header">
        <span style={{ color: accentColor, display: "inline-flex" }}>
          {data.agentIcon ? <AgentPresetIcon icon={data.agentIcon} /> : <KindIcon kind={data.kind} />}
        </span>
        <span className="ds-node__title">{data.title}</span>
        {isCloud && (
          <span className="ds-node__runtime" style={{ marginLeft: "auto" }} title="Runs in cloud">
            <CloudGlyph />
          </span>
        )}
        {isUnlocked && (
          <span
            className="ds-node__runtime ds-node__runtime--unlocked"
            style={{ marginLeft: "auto" }}
            title="Sandbox unlocked — full filesystem access"
            aria-label="sandbox unlocked — full filesystem access"
          >
            <UnlockGlyph />
          </span>
        )}
        <span className="ds-node__type" style={{ marginLeft: hasRuntimeGlyph ? undefined : "auto" }}>
          {data.agentLabel ?? data.typeLabel}
        </span>
      </div>

      {data.preview && <div className="ds-node__body">{data.preview}</div>}

      {showProgress && (
        <ProgressBar
          className="ds-node__progress"
          size="node"
          value={data.progress}
          status={status}
          aria-label={`${data.title} progress`}
        />
      )}

      <Handle type="source" position={Position.Right} className="ds-handle" />

      {mode === "fusion" ? (
        <NodeFusionToggle nodeId={id} agentType={data.rv?.agentType} />
      ) : mode === "compose" ? (
        // (SA-E) Compose mode: the node becomes a gate drop-target + surfaces its gate pipeline + tier
        // (the badge widen) — read from the authored TEMPLATE config via ComposeContext, not the run-view.
        <NodeGateChips nodeId={id} />
      ) : (
        mode && <NodeModeStrip mode={mode} data={data} />
      )}
    </motion.div>
  );
}
