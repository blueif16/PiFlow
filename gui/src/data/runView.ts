// runView.ts — the GUI's real-data contract. Mirrors the shape build-run-view.mjs emits, loads it,
// and maps it onto the React Flow graph + the existing FlowNodeData. Every field here is backed by a
// real value in run-view.json (transcoded from a real run); there is no mock fallback, so a node that
// lacks data simply renders empty — "no mock data" enforced by the type, not by discipline alone.
import type { FlowNode, FlowNodeData, NodeStatus } from "../components/WorkflowNode";
import type { DirEntry } from "../components/DirectoryPanel";
import type { Edge } from "@xyflow/react";

export type ScopeKind = "run" | "skill" | "template" | "package" | "repo";

export interface ScopeBucket { kind: ScopeKind; label: string; count: number; paths: string[]; }
export interface TimelineSpan { name: string; tStartMs: number | null; durMs: number; ok: boolean; }
export interface ReadRef { path: string; displayPath: string; via: string; scope: ScopeKind; preview?: string; }
export interface WriteRef { path: string; displayPath: string; verified: boolean; bytes?: number; }
export interface ArtifactRef { path: string; displayPath: string; exists: boolean; bytes: number; }
export interface BashCall { command: string; tStartMs: number | null; durMs?: number; }
export interface RunTokens { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextPeak: number; billable: number; }

export interface RunViewNode {
  id: string;
  label: string;
  phase: string | null;
  status: string; // ok | reused | error | blocked | running | pending | gap | dry
  startedAt?: string;
  endedAt?: string;
  durationMs?: number | null;
  /** mean duration across prior runs of this node — the live progress ETA baseline */
  expectedMs?: number | null;
  priorSamples?: number;
  model?: string | null;
  provider?: string | null;
  api?: string | null;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  timeline: TimelineSpan[];
  reads: ReadRef[];
  scopes: ScopeBucket[];
  writes: WriteRef[];
  artifacts: ArtifactRef[];
  bash: BashCall[];
  tokens?: RunTokens;
  summary?: string;
  issues?: string[];
  stageIndex?: number;
  lane?: number;
}

export interface RunViewStage { index: number; phase: string; parallel: boolean; nodeIds: string[]; }
export interface RunViewEdge { from: string; to: string; path: string; }

export interface RunView {
  run: string;
  source?: string;
  provider?: string;
  model?: string | null;
  startedAt?: string;
  updatedAt?: string;
  durationMs?: number | null;
  done?: boolean;
  ok?: boolean | null;
  totals?: { nodes: number; ok: number; failed: number };
  /** run-level rollup of every node's token usage (sum of per-node tokens; contextPeak is the max). */
  tokenTotal?: RunTokens;
  stages: RunViewStage[];
  edges: RunViewEdge[];
  nodes: RunViewNode[];
}

/** Fetch the distilled run-view for a run id (served from gui/public/runs/<run>/run-view.json). */
export async function loadRunView(run: string): Promise<RunView> {
  const res = await fetch(`${import.meta.env.BASE_URL}runs/${run}/run-view.json`);
  if (!res.ok) throw new Error(`Failed to load run-view for "${run}": ${res.status} ${res.statusText}`);
  return (await res.json()) as RunView;
}

/** Map the engine's node status ladder onto the design-system's visual NodeStatus. */
export function toNodeStatus(s: string): NodeStatus {
  switch (s) {
    case "ok":
    case "reused":
      return "success";
    case "error":
    case "blocked":
      return "error";
    case "running":
      return "running";
    default:
      return "idle";
  }
}

export function formatMs(ms?: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${String(r).padStart(2, "0")}s`;
}

export function formatBytes(b?: number): string {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Build the React Flow graph (positions by stage column / parallel-lane row) from a run-view. */
export function toFlowGraph(view: RunView): { nodes: FlowNode[]; edges: Edge[] } {
  const COL = 300;
  const ROW = 132;
  const nodes: FlowNode[] = view.nodes.map((rv) => {
    const stageIndex = rv.stageIndex ?? 1;
    const lane = rv.lane ?? 0;
    const data: FlowNodeData = {
      title: rv.label,
      kind: "agent",
      typeLabel: rv.phase ?? "node",
      status: toNodeStatus(rv.status),
      preview: rv.summary ? truncate(rv.summary, 84) : `${rv.toolCalls} tools · ${rv.reads.length} reads`,
      progress: rv.status === "running" ? undefined : 1,
      // populate the existing HUD cards with REAL values (the 5-region rebuild reads `rv` directly)
      meta: [
        { label: "Model", value: rv.model ?? "—", mono: true },
        { label: "Provider", value: rv.provider ?? "—", mono: true },
        { label: "Duration", value: formatMs(rv.durationMs), mono: true },
        { label: "Tool calls", value: String(rv.toolCalls) },
      ],
      io: { inputs: rv.reads.map((r) => r.displayPath), outputs: rv.writes.map((w) => w.displayPath) },
      content: rv.summary,
      rv,
    };
    return {
      id: rv.id,
      type: "flowNode",
      position: { x: 40 + (stageIndex - 1) * COL, y: 60 + lane * ROW },
      data,
    } as FlowNode;
  });

  // collapse multi-path edges between the same pair into one visual edge (the file list lives in detail)
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const e of view.edges) {
    const key = `${e.from}->${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: key, source: e.from, target: e.to });
  }
  return { nodes, edges };
}

const extOf = (name: string) => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1) : undefined; };

/**
 * Build a Miller-columns directory tree from the run's PRODUCED files (writes + artifacts), plus a
 * file→producing-node map so opening a file leaf opens the node that wrote it. Real outputs, no mock.
 */
export function buildDirectory(view: RunView): { tree: DirEntry[]; fileToNode: Record<string, string> } {
  const fileToNode: Record<string, string> = {};
  const paths = new Set<string>();
  for (const n of view.nodes) {
    for (const w of n.writes) { paths.add(w.displayPath); if (!fileToNode[w.displayPath]) fileToNode[w.displayPath] = n.id; }
    for (const a of n.artifacts) { paths.add(a.displayPath); if (!fileToNode[a.displayPath]) fileToNode[a.displayPath] = n.id; }
  }
  const root: DirEntry[] = [];
  const folders = new Map<string, DirEntry>();
  for (const p of [...paths].sort()) {
    const parts = p.split("/");
    let level = root;
    let prefix = "";
    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1;
      prefix = prefix ? `${prefix}/${part}` : part;
      if (isLeaf) {
        level.push({ id: `f:${p}`, name: part, kind: "file", typeLabel: extOf(part) });
      } else {
        let folder = folders.get(prefix);
        if (!folder) {
          folder = { id: `d:${prefix}`, name: part, kind: "folder", children: [] };
          folders.set(prefix, folder);
          level.push(folder);
        }
        level = folder.children!;
      }
    });
  }
  return { tree: root, fileToNode };
}
