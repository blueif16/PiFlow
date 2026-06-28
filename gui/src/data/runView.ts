// runView.ts — the GUI's real-data contract. Mirrors the shape `@piflow/core/observe` `buildRunView`
// emits, fetches it from the `/__piflow/run-view/<run>` endpoint (which distills the run's real `.pi/`
// on demand), and maps it onto the React Flow graph + FlowNodeData. Every field is backed by a real
// value; there is no mock fallback, so a node that lacks data simply renders empty.
import type { FlowNode, FlowNodeData, NodeStatus } from "../components/WorkflowNode";
import type { DirEntry } from "../components/DirectoryPanel";
import type { Edge } from "@xyflow/react";

export type ScopeKind = "run" | "skill" | "template" | "package" | "repo";

/** (SKIN channel) The sandbox BACKEND kind — mirrors core `SandboxProviderKind` (types.ts). */
export type SandboxProviderKind = "inmemory" | "local" | "seatbelt" | "worktree" | "daytona" | "e2b";

/** (SKIN channel) The curated per-node config slice — mirrors core `NodeConfig` (runner/status.ts). The
 *  `sandbox` here is per-node SCOPING (workspace/readScope/owns), NOT the backend (that is run-level). */
export interface NodeConfig {
  model?: string | null;
  provider?: string;
  tier?: string;
  tools?: { allow?: string[]; deny?: string[]; };
  timeoutMs?: number;
  retries?: number;
  agentType?: string;
  programmatic?: boolean;
  sandbox?: { workspace?: string; readScope?: string[]; owns?: string[]; };
}

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
  /** (G6) the agent-PRESET label (branding) — resolved to {icon,color,label} via the agents catalog. */
  agentType?: string;
  /** (SKIN channel) the curated per-node config slice (model/tools/scoping/programmatic) — mirrors core. */
  config?: NodeConfig;
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
  /** pi-native context window for this node's model (tokens) — the context-bar denominator. */
  contextWindow?: number | null;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  timeline: TimelineSpan[];
  reads: ReadRef[];
  scopes: ScopeBucket[];
  writes: WriteRef[];
  artifacts: ArtifactRef[];
  bash: BashCall[];
  tokens?: RunTokens;
  /** provider rate-limit/overload retries (count of `auto_retry_start`) — mirrors core. */
  retries: number;
  /** the assistant's final `message.stopReason` (null if none seen). */
  stopReason: string | null;
  /** the output was cut off by the token cap (stopReason `'max_tokens'`/`'length'`). */
  truncated: boolean;
  /** total `thinking_delta` characters for this node. */
  thinkingChars: number;
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
  /** (SKIN channel) the run's effective sandbox BACKEND — mirrors core; drives the node skin. */
  sandbox?: SandboxProviderKind;
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

/** Fetch the distilled run-view for a run id. ONE path: the dev middleware (`/__piflow/run-view/<run>`)
 *  distills the run's REAL `.pi/` on demand via the shared `@piflow/core/observe` builder — works for
 *  live, historical, and foreign runs alike (no transcode, no per-run static file). */
export async function loadRunView(run: string): Promise<RunView> {
  const res = await fetch(`/__piflow/run-view/${encodeURIComponent(run)}`);
  if (!res.ok) throw new Error(`Failed to load run-view for "${run}": ${res.status} ${res.statusText}`);
  return (await res.json()) as RunView;
}

/** Fetch a FUSION/STRUCTURE PREVIEW for a run's template with per-node fusion overrides applied
 *  (`{ "<nodeId>": "moa" | "best-of-n" }`). The `/__piflow/preview/<run>` endpoint re-compiles the
 *  template through the SDK's OWN `withNodeFusion → expandFusion → compile → previewView` and returns the
 *  SAME RunView shape — so the canvas renders the real siblings+judge DAG, never a view-local rewrite. */
export async function loadPreview(run: string, overrides: Record<string, string>): Promise<RunView> {
  const q = encodeURIComponent(JSON.stringify(overrides));
  const res = await fetch(`/__piflow/preview/${encodeURIComponent(run)}?overrides=${q}`);
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try { const body = await res.json(); if (body?.error) detail = body.error; } catch { /* keep status */ }
    throw new Error(`Fusion preview failed for "${run}": ${detail}`);
  }
  return (await res.json()) as RunView;
}

/** BAKE the current fusion overrides into THIS run (POST /__piflow/save-run) — rewrites the run's
 *  `.pi/workflow.json` + `run.json` to the edited structure (NOT the template). Returns ok/error. */
export async function saveRunFusion(run: string, overrides: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  try {
    const q = encodeURIComponent(JSON.stringify(overrides));
    const res = await fetch(`/__piflow/save-run/${encodeURIComponent(run)}?overrides=${q}`, { method: "POST" });
    if (res.ok) return { ok: true };
    let error = `${res.status} ${res.statusText}`;
    try { const body = await res.json(); if (body?.error) error = body.error; } catch { /* keep status */ }
    return { ok: false, error };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** (G6) A preset's branding, as the catalog endpoint returns it (the node carries only `agentType`). */
export interface AgentDisplay { label?: string; icon?: string; color?: string; }
/** agentType id → its display branding, from `~/.piflow/agents/` via `/__piflow/agents.json`. */
export type AgentCatalog = Record<string, AgentDisplay>;

/** Fetch the agent-preset catalog (id → {icon,label,color}) from the dev middleware. The display lives in
 *  `~/.piflow/agents/`, never on the node (decision #3). Absent/unreachable ⇒ {} (nodes render default chips). */
export async function loadAgentCatalog(): Promise<AgentCatalog> {
  try {
    const res = await fetch("/__piflow/agents.json");
    if (!res.ok) return {};
    return (await res.json()) as AgentCatalog;
  } catch {
    return {};
  }
}

/** Fetch the run's FULL on-disk file tree rooted at its `{{RUN}}` folder (the dev middleware
 *  `/__piflow/tree/<run>` walks runDir). This is the real filesystem — every file the run holds — not just
 *  the produced-files set `buildDirectory` derives from the run-view. File leaf ids are `f:<run-relative>`,
 *  which equals a produced file's run-relative displayPath, so the `fileToNode` map still maps clicks. */
export async function loadRunTree(run: string): Promise<DirEntry[]> {
  const res = await fetch(`/__piflow/tree/${encodeURIComponent(run)}`);
  if (!res.ok) throw new Error(`Failed to load file tree for "${run}": ${res.status} ${res.statusText}`);
  const { tree } = (await res.json()) as { tree: DirEntry[] };
  return tree ?? [];
}

/** URL for the file read-back endpoint (`vite.config.ts` `piflowFile`) — serves a file's REAL bytes from
 *  disk (text or image), resolved under the run's workspace. The HUD uses this to render ANY file it has a
 *  path for — input read, output artifact, or write — not just the telemetry preview snapshot. */
export function fileUrl(run: string, path: string): string {
  return `/__piflow/file/${encodeURIComponent(run)}?path=${encodeURIComponent(path)}`;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);
/** True when a path should render as an <img> (served binary) rather than fetched as text. */
export const isImagePath = (p: string) => IMAGE_EXTS.has((p.split(".").pop() || "").toLowerCase());

/** (SKIN channel) The cloud backends — a node that runs in one of these gets the extruded 3D block skin. */
const CLOUD = new Set<SandboxProviderKind>(["daytona", "e2b"]);

/** (SKIN channel) The EFFECTIVE backend a node ran in: a programmatic node is ALWAYS host-local (it spawns
 *  no pi, so it ignores the run's chosen backend — core types.ts:97-99); otherwise the run-level backend. */
export function effectiveSandbox(view: RunView, node: RunViewNode): SandboxProviderKind | undefined {
  return node.config?.programmatic ? "local" : view.sandbox;
}

/** (SKIN channel) Map a backend kind → its node skin. Extensible (a future `danger-full-access` skin maps
 *  here); only cloud→'cloud' is implemented now, everything else (incl. undefined) is the default 'flat'. */
export function sandboxSkin(kind: SandboxProviderKind | undefined): "flat" | "cloud" {
  return kind && CLOUD.has(kind) ? "cloud" : "flat";
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

/** Compact token count: 1234 → "1.2k", 139653 → "140k", 1_200_000 → "1.2M". */
export function formatTokens(n?: number | null): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Fallback window when a node's model isn't in pi's native registry (rv.contextWindow is null). The
 *  real value now comes per-node from `@piflow/core/observe` (pi's ~/.pi/agent/models.json) — no table here. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export type ContextTone = "ok" | "warn" | "high";
/** Context-pressure zones (per telemetry research 2026): <40% ok · 40–70% warn · ≥70% high — quality
 *  degrades as the window fills, so we flag the 70%+ band before it becomes critical. */
export function contextTone(frac: number): ContextTone {
  if (frac >= 0.7) return "high";
  if (frac >= 0.4) return "warn";
  return "ok";
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Node-placement geometry — the SINGLE source for where a node lands on the canvas. Exported so the
 *  backdrop-zone math (`data/zones.ts`) mirrors `toFlowGraph` EXACTLY (no duplicated literals → no drift).
 *  COL/ROW = stage-column / parallel-lane stride; NODE_W/NODE_H = the card box (= --ds-node-width /
 *  --ds-node-min-h tokens) used to inflate a cluster's bbox from its members' top-left anchors. */
export const COL = 300;
export const ROW = 132;
export const NODE_W = 220;
export const NODE_H = 64;

/** Top-left anchor of a node, given its stage/lane — the one formula `toFlowGraph` lays out by. */
export function nodePosition(stageIndex: number | undefined, lane: number | undefined): { x: number; y: number } {
  return { x: 40 + ((stageIndex ?? 1) - 1) * COL, y: 60 + (lane ?? 0) * ROW };
}

/** Build the React Flow graph (positions by stage column / parallel-lane row) from a run-view. The optional
 *  agent-preset `catalog` resolves a node's `agentType` → its branded icon/color/label (G6); absent ⇒ the
 *  node renders the default chip. */
export function toFlowGraph(view: RunView, catalog: AgentCatalog = {}): { nodes: FlowNode[]; edges: Edge[] } {
  const nodes: FlowNode[] = view.nodes.map((rv) => {
    const stageIndex = rv.stageIndex ?? 1;
    const lane = rv.lane ?? 0;
    const preset = rv.agentType ? catalog[rv.agentType] : undefined;
    // (SKIN channel) The node's runtime skin from its EFFECTIVE backend (programmatic ⇒ local; else the
    // run's backend). Set `runtime` only when 'cloud' is meaningful — 'flat' is the default (no DOM attr).
    const skin = sandboxSkin(effectiveSandbox(view, rv));
    const data: FlowNodeData = {
      title: rv.label,
      kind: "agent",
      typeLabel: rv.phase ?? "node",
      ...(skin === "cloud" ? { runtime: skin } : {}),
      // (G6) the preset's branding, resolved from the catalog by the node's agentType label. The icon is
      // a KEY the chip maps to a bundled glyph; absent/unknown ⇒ the default agent glyph (never blocks).
      ...(preset ? { agentIcon: preset.icon, agentColor: preset.color, agentLabel: preset.label ?? rv.agentType } : {}),
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
      position: nodePosition(stageIndex, lane),
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
