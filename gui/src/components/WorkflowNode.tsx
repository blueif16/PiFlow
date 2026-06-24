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

export function WorkflowNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { expand } = useExpand();
  const status: NodeStatus = data.status ?? (selected ? "selected" : "idle");
  const accentColor = data.kind === "agent" ? "var(--ds-node-agent)" : "var(--ds-node-file)";
  // show the charge bar while running, or whenever a node carries a progress value
  const showProgress = data.progress != null || status === "running";

  return (
    <motion.div
      layoutId={`node-${id}`}
      className="ds-node"
      data-status={status}
      data-kind={data.kind}
      role="button"
      tabIndex={0}
      aria-label={`${data.kind} ${data.title}. Press Enter to expand.`}
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
          <KindIcon kind={data.kind} />
        </span>
        <span className="ds-node__title">{data.title}</span>
        <span className="ds-node__type" style={{ marginLeft: "auto" }}>
          {data.typeLabel}
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
    </motion.div>
  );
}
