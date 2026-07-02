// runStream.ts — the GUI's LIVE run-telemetry client. Subscribes to the SSE bridge
// (gui/vite.config.ts `/__piflow/stream/<run>`), which pipes the EXACT
// `@piflow/core/observe` `watchRun` stream. The view types here MIRROR observe/types.ts
// (RunModel/RunUpdate) — the shapes are the shared contract, not a fork. It carries the live
// status + snapshot model and folds NOTHING: the canvas renders the fully-derived run-view the
// `/__piflow/run-view/<run>` poll returns (the observe surface stamps every zone). Real data only.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { sse, useEndpoint } from "./apiBase";
import type { RunTokens, NodeDerived, TimelineSpan, ReadRef, WriteRef, ArtifactRef, RunViewStage } from "./runView";

export type LiveNodeStatus =
  | "pending" | "running" | "ok" | "reused" | "gap" | "blocked" | "error" | "dry";

/**
 * A node as the live model carries it. The base identity/placement fields are always present; the ENRICHED
 * telemetry fields (tokens/derived/model/toolCalls/…) are optional and filled by the SSE fold's
 * `node-enriched` delta (docs/design/observe-live-sse-single-source.md DR3/§6). This MIRRORS the core
 * `NodeView` shape LOCALLY (the GUI cannot import @piflow/core — the mirror is the contract, not a fork), so a
 * streamed enriched node maps 1:1 onto `RunViewNode` via `liveModelToRunView` and renders through `toFlowGraph`.
 */
export interface LiveNode {
  id: string;
  label: string;
  phase: string | null;
  status: LiveNodeStatus;
  stageIndex: number;
  lane: number;

  // ── ENRICHED live-graph fields (optional; present once the SSE fold enriches the node — P2) ──────────────
  /** agent-neutral token/cost/context rollup (input/output/cache/cost/contextPeak/billable). */
  tokens?: RunTokens;
  /** the per-node DISPLAY projection (zones/rankings/unified outputs), computed ONCE server-side. */
  derived?: NodeDerived;
  /** the effective model label the node ran on. */
  model?: string | null;
  /** the PER-NODE provider (detected from the node's own events; null when undeterminable) — mirrors core
   *  NodeView.provider so the adapter renders each node's own provider, matching buildRunView's field key. */
  provider?: string | null;
  /** the node's settled run duration (ms); null while running (the elapsed clock is a view-side concern). */
  durationMs?: number | null;
  /** the context-window denominator for the context-pressure bar. */
  contextWindow?: number | null;
  /** how many tool invocations this node made. */
  toolCalls?: number;
  /** per-tool call counts (the ranking + dominance source). */
  toolBreakdown?: Record<string, number>;
  /** the per-tool execution timeline (spans with real durMs/ok once closed). */
  timeline?: TimelineSpan[];
  /** scope-bucketed reads. */
  reads?: ReadRef[];
  /** declared/observed writes. */
  writes?: WriteRef[];
  /** declared artifacts with on-disk existence + bytes. */
  artifacts?: ArtifactRef[];
  /** provider rate-limit/overload retries. */
  retries?: number;
  /** the assistant's final `message.stopReason` (null if none seen). */
  stopReason?: string | null;
  /** the output was cut off by the token cap. */
  truncated?: boolean;
  /** the node's self-reported summary line. */
  summary?: string;
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
  /** run-level token/cost rollup folded across nodes — the sum the enriched live graph shows (present once
   *  the SSE fold enriches the snapshot; recomputed on each `node-enriched` delta). */
  tokenTotal?: RunTokens;
  nodes: LiveNode[];
  /** file-flow edges (a writer's path read back by a consumer) — fills in as nodes complete. */
  edges?: { from: string; to: string; path: string }[];
  /** the resolved stage spine (index/phase/parallel/nodeIds), carried verbatim from the SSE snapshot
   *  (readRunModel's resolveStructure, P0b) so `liveModelToRunView` yields a FAITHFUL RunView and the
   *  shadow-diff parity check matches the /run-view build. `toFlowGraph` lays out from per-node
   *  stageIndex/lane, NOT this array, so carrying it does not change what the graph renders. */
  stages?: RunViewStage[];
}

/** A wire frame: the observe RunUpdate kinds + the bridge's `meta`/`stream-error` wrappers. Exported so the
 *  headless P4 parity test can fold the EXACT server frames through the real `reduce` (no reinvented fold). */
export type Frame =
  | { kind: "meta"; run: string; runDir: string }
  | { kind: "snapshot"; model: LiveModel }
  | { kind: "node-status"; id: string; status: LiveNodeStatus }
  | { kind: "node-event"; id: string; event: Record<string, unknown> }
  /** the WHOLE re-assembled enriched node (not just tokens+derived — DR3/M4), on a material fold change. */
  | { kind: "node-enriched"; id: string; node: LiveNode }
  | { kind: "done" }
  | { kind: "stream-error"; error: string };

export interface RunEvent { id: string; event: Record<string, unknown> }

export interface RunStreamState {
  status: "connecting" | "live" | "done" | "error";
  model: LiveModel | null;
  /** rolling tail of the most recent node events — the live "what's happening now" feed. */
  recent: RunEvent[];
  error?: string;
}

export const INITIAL: RunStreamState = { status: "connecting", model: null, recent: [] };
const RECENT_CAP = 40;

/** Shared stream state — CanvasInner owns ONE subscription (for the live graph) and provides it here so
 *  the Companion reads the same connection instead of opening a second EventSource. */
export const RunStreamContext = createContext<RunStreamState>(INITIAL);
export const useRunStreamContext = (): RunStreamState => useContext(RunStreamContext);

/** Run-level token rollup folded across nodes — MIRRORS core `buildRunView` (runView.ts): every field sums
 *  except `contextPeak`, which is the MAX. Recomputed whenever a `node-enriched` delta lands. */
export function foldTokenTotal(nodes: LiveNode[]): RunTokens {
  return nodes.reduce<RunTokens>(
    (acc, n) => {
      const t = n.tokens;
      if (!t) return acc;
      acc.input += t.input || 0;
      acc.output += t.output || 0;
      acc.cacheRead += t.cacheRead || 0;
      acc.cacheWrite += t.cacheWrite || 0;
      acc.cost += t.cost || 0;
      acc.billable += t.billable || 0;
      acc.contextPeak = Math.max(acc.contextPeak, t.contextPeak || 0);
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, billable: 0, contextPeak: 0 },
  );
}

/** The PURE SSE fold: apply one wire frame to the stream state. This is the testable core of `useRunStream`
 *  (which is only the EventSource plumbing around it) — exported so the headless P4 parity test folds the exact
 *  server frames through THIS reducer, proving the SSE-rendered graph ≡ /run-view without a browser. */
export function reduce(prev: RunStreamState, f: Frame): RunStreamState {
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
    case "node-enriched": {
      // Merge the FULL re-assembled enriched node into the model (DR3/M4 — the delta carries the whole node,
      // not just tokens+derived, so no rendered field blanks), then recompute the run-level token rollup.
      if (!prev.model) return prev;
      const nodes = prev.model.nodes.map((n) => (n.id === f.id ? f.node : n));
      return { ...prev, model: { ...prev.model, nodes, tokenTotal: foldTokenTotal(nodes) } };
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
  // Re-point trigger: a migrate switches the console to a new serve → this baseUrl changes → the effect
  // re-runs and reopens the telemetry stream against the new origin (for the same run id).
  const endpointBase = useEndpoint().baseUrl;

  useEffect(() => {
    if (!run) { setState(INITIAL); return; }
    setState(INITIAL);
    const es = sse(`/__piflow/stream/${encodeURIComponent(run)}`);
    esRef.current = es;
    es.onmessage = (e: MessageEvent) => {
      let f: Frame;
      try { f = JSON.parse(e.data) as Frame; } catch { return; }
      if (f.kind === "done") es.close(); // finished run → stop auto-reconnect
      setState((prev) => reduce(prev, f));
    };
    es.onerror = () => {
      // EventSource retries on its own; only surface an error if we never got a model
      // and the run isn't already done.
      setState((prev) => (prev.status === "done" || prev.model ? prev : { ...prev, status: "error", error: "stream connection failed" }));
    };
    return () => { es.close(); esRef.current = null; };
  }, [run, endpointBase]);

  return state;
}
