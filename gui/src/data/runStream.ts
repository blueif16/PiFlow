// runStream.ts — the GUI's LIVE run-telemetry client. Subscribes to the SSE bridge
// (gui/vite.config.ts `/__piflow/stream/<run>`), which pipes the EXACT
// `@piflow/core/observe` `watchRun` stream. The view types here MIRROR observe/types.ts
// (RunModel/RunUpdate) — we only carry the fields the companion renders, but the shapes
// are the shared contract, not a fork. Real data only; no mock fallback.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Edge } from "@xyflow/react";
import type { FlowNode, FlowNodeData } from "../components/WorkflowNode";
import { toNodeStatus, formatMs } from "./runView";
import type { RunViewNode } from "./runView";
import { LiveTelemetry } from "./liveTelemetry";

export type LiveNodeStatus =
  | "pending" | "running" | "ok" | "reused" | "gap" | "blocked" | "error" | "dry";

/** A node as the live model carries it (subset of observe NodeView). */
export interface LiveNode {
  id: string;
  label: string;
  phase: string | null;
  status: LiveNodeStatus;
  stageIndex: number;
  lane: number;
}

/** The live snapshot (subset of observe RunModel). */
export interface LiveModel {
  run: string;
  done: boolean;
  ok: boolean | null;
  durationMs: number | null;
  provider?: string;
  model?: string | null;
  totals: { nodes: number; ok: number; failed: number } | null;
  nodes: LiveNode[];
  /** file-flow edges (a writer's path read back by a consumer) — fills in as nodes complete. */
  edges?: { from: string; to: string; path: string }[];
}

/** A wire frame: the observe RunUpdate kinds + the bridge's `meta`/`stream-error` wrappers. */
type Frame =
  | { kind: "meta"; run: string; runDir: string }
  | { kind: "snapshot"; model: LiveModel }
  | { kind: "node-status"; id: string; status: LiveNodeStatus }
  | { kind: "node-event"; id: string; event: Record<string, unknown> }
  | { kind: "done" }
  | { kind: "stream-error"; error: string };

export interface RunEvent { id: string; event: Record<string, unknown> }

export interface RunStreamState {
  status: "connecting" | "live" | "done" | "error";
  model: LiveModel | null;
  /** rolling tail of the most recent node events — the live "what's happening now" feed. */
  recent: RunEvent[];
  /** per-node rich telemetry folded LIVE from the node-event firehose (tokens/tools/reads/writes/
   *  timeline), keyed by node id — the SAME shape the transcoded run-view carries, so the existing
   *  HUD renders it. Only nodes that have emitted events appear; the rest stay lean. */
  richByNode: Record<string, RunViewNode>;
  /** sum of every folded node's billable tokens — the run-level live token counter. */
  liveBillable: number;
  error?: string;
}

const INITIAL: RunStreamState = { status: "connecting", model: null, recent: [], richByNode: {}, liveBillable: 0 };
const RECENT_CAP = 40;
/** How often to re-fold the live accumulators into richByNode (cheap, but not per-event at firehose rate). */
const FOLD_MS = 500;

/** Shared stream state — CanvasInner owns ONE subscription (for the live graph) and provides it here so
 *  the Companion reads the same connection instead of opening a second EventSource. */
export const RunStreamContext = createContext<RunStreamState>(INITIAL);
export const useRunStreamContext = (): RunStreamState => useContext(RunStreamContext);

function reduce(prev: RunStreamState, f: Frame): RunStreamState {
  switch (f.kind) {
    case "meta":
      return prev;
    case "snapshot":
      return { ...prev, status: prev.status === "done" ? "done" : "live", model: f.model };
    case "node-status": {
      if (!prev.model) return prev;
      const nodes = prev.model.nodes.map((n) => (n.id === f.id ? { ...n, status: f.status } : n));
      return { ...prev, model: { ...prev.model, nodes } };
    }
    case "node-event":
      return { ...prev, recent: [...prev.recent, { id: f.id, event: f.event }].slice(-RECENT_CAP) };
    case "done":
      return { ...prev, status: "done" };
    case "stream-error":
      return { ...prev, status: "error", error: f.error };
    default:
      return prev;
  }
}

/**
 * Subscribe to a run's live telemetry. Re-subscribes when `run` changes; closes the
 * EventSource on unmount AND on `done` (a finished run's stream is closed server-side,
 * so we stop EventSource's auto-reconnect). A transient drop mid-run auto-reconnects
 * (EventSource default) and the bridge re-sends a fresh snapshot — idempotent.
 */
export function useRunStream(run: string | null | undefined): RunStreamState {
  const [state, setState] = useState<RunStreamState>(INITIAL);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!run) { setState(INITIAL); return; }
    setState(INITIAL);
    // ONE telemetry folder per run: every node-event frame is folded through the SHARED distiller, then
    // a throttled flush rebuilds richByNode (per-node tokens/tools/reads the HUD renders) off the model.
    const tele = new LiveTelemetry();
    const dirty = { current: false };
    const flush = () => {
      if (!dirty.current) return;
      dirty.current = false;
      setState((prev) => {
        if (!prev.model) return prev;
        return { ...prev, richByNode: tele.richByNode(prev.model.nodes), liveBillable: tele.billableTotal() };
      });
    };
    const foldTimer = window.setInterval(flush, FOLD_MS);

    const es = new EventSource(`/__piflow/stream/${encodeURIComponent(run)}`);
    esRef.current = es;
    es.onmessage = (e: MessageEvent) => {
      let f: Frame;
      try { f = JSON.parse(e.data) as Frame; } catch { return; }
      if (f.kind === "node-event") { tele.pushEvent(f.id, f.event); dirty.current = true; }
      if (f.kind === "done") es.close(); // finished run → stop auto-reconnect
      setState((prev) => reduce(prev, f));
      if (f.kind === "done") flush(); // final fold so a finished run shows its complete token totals
    };
    es.onerror = () => {
      // EventSource retries on its own; only surface an error if we never got a model
      // and the run isn't already done.
      setState((prev) => (prev.status === "done" || prev.model ? prev : { ...prev, status: "error", error: "stream connection failed" }));
    };
    return () => { es.close(); esRef.current = null; window.clearInterval(foldTimer); };
  }, [run]);

  return state;
}

const TERMINAL_OK = new Set<LiveNodeStatus>(["ok", "reused", "gap", "dry"]);

/** A one-line, REAL "where are we" summary derived from the live model (no fabrication). */
export function whereAreWe(s: RunStreamState): string {
  if (s.status === "connecting") return "connecting…";
  if (s.status === "error") return "telemetry unavailable";
  const m = s.model;
  if (!m) return "no run data";
  const total = m.totals?.nodes ?? m.nodes.length;
  if (m.done) {
    if (m.ok === false) return `failed · ${m.totals?.failed ?? 0}/${total} bad`;
    return `done ✓ ${m.totals?.ok ?? m.nodes.filter((n) => TERMINAL_OK.has(n.status)).length}/${total}`;
  }
  const doneCount = m.nodes.filter((n) => TERMINAL_OK.has(n.status)).length;
  const running = m.nodes.find((n) => n.status === "running");
  if (running) return `running ${running.label} · ${doneCount}/${total}`;
  const bad = m.nodes.find((n) => n.status === "error" || n.status === "blocked");
  if (bad) return `${bad.status} · ${bad.label}`;
  return `${doneCount}/${total} nodes`;
}

/**
 * Build the React Flow graph from the LIVE model — the canvas renderer for a run with no transcoded
 * run-view.json (a running or foreign run). Positions by stage column / parallel lane (same layout as
 * runView.toFlowGraph); status drives the node color and re-renders as node-status deltas arrive. When
 * `richByNode` carries this node's LIVE-folded telemetry it is attached as `rv` — so the SAME NodeHud
 * that renders a transcoded run now shows real tokens/tools/reads for a RUNNING node; nodes with no
 * folded events yet stay lean (just status + stage).
 */
export function liveFlowGraph(
  model: LiveModel,
  richByNode: Record<string, RunViewNode> = {},
): { nodes: FlowNode[]; edges: Edge[] } {
  const COL = 300;
  const ROW = 132;
  const nodes: FlowNode[] = model.nodes.map((n) => {
    const rv = richByNode[n.id];
    const data: FlowNodeData = rv
      ? {
          title: n.label,
          kind: "agent",
          typeLabel: n.phase ?? "node",
          status: toNodeStatus(n.status),
          preview: `${rv.tokens?.billable?.toLocaleString() ?? 0} tok · ${rv.toolCalls} tools`,
          progress: n.status === "running" ? undefined : 1,
          meta: [
            { label: "Model", value: rv.model ?? "—", mono: true },
            { label: "Tokens", value: (rv.tokens?.billable ?? 0).toLocaleString() },
            { label: "Tool calls", value: String(rv.toolCalls) },
            { label: "Duration", value: formatMs(rv.durationMs), mono: true },
          ],
          io: { inputs: rv.reads.map((r) => r.displayPath), outputs: rv.writes.map((w) => w.displayPath) },
          rv,
        }
      : {
          title: n.label,
          kind: "agent",
          typeLabel: n.phase ?? "node",
          status: toNodeStatus(n.status),
          preview: n.status === "running" ? "running…" : n.status,
          progress: n.status === "running" ? undefined : 1,
          meta: [
            { label: "Status", value: n.status, mono: true },
            { label: "Stage", value: String(n.stageIndex), mono: true },
          ],
          io: { inputs: [], outputs: [] },
        };
    return {
      id: n.id,
      type: "flowNode",
      position: { x: 40 + (Math.max(1, n.stageIndex) - 1) * COL, y: 60 + n.lane * ROW },
      data,
    } as FlowNode;
  });

  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const e of model.edges ?? []) {
    const key = `${e.from}->${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: key, source: e.from, target: e.to });
  }
  return { nodes, edges };
}
