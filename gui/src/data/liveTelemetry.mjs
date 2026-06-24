// liveTelemetry.mjs — the BROWSER live-telemetry folder. It reuses the EXACT SAME stream reducer the
// offline transcoder uses (scripts/lib/distill.mjs `createNodeAccumulator`) — NOT a second parser — so a
// RUNNING run's HUD shows tokens/tools/reads derived live from the node-event firehose, with numbers
// identical to the post-run run-view.json. One reducer ⇒ live + transcode can't drift.
//
// It folds each `{kind:'node-event', id, event}` SSE frame into the matching node's accumulator, then
// synthesizes a partial `RunViewNode` (the HUD's source of truth, `FlowNodeData.rv`) on demand. Pure JS
// (no DOM/Node deps) so it runs in the browser AND under `node` for the oracle test.
import { createNodeAccumulator } from "../../scripts/lib/distill.mjs";

// Strip an absolute capture path to a readable, scoped display path (no product hard-coding): keep the
// tail after a run workspace `out/<run>/`, else a `packages/…` / `templates/…` segment, else the basename.
function displayPath(abs) {
  const p = typeof abs === "string" ? abs : String(abs);
  let m;
  if ((m = p.match(/\/out\/[^/]+\/(.+)$/))) return m[1];
  if ((m = p.match(/\/(packages\/.+)$/))) return m[1];
  if ((m = p.match(/\/(templates\/.+)$/))) return m[1];
  return p.startsWith("/") ? p.replace(/^.*\//, "") : p;
}

// Bucket a read by WHERE it lives — the "different kind of scope" the HUD's left region shows.
function scopeOf(abs) {
  const p = String(abs);
  if (/\/out\/[^/]+\//.test(p)) return "run";
  if (p.includes("/packages/skills/")) return "skill";
  if (p.includes("/templates/")) return "template";
  if (p.includes("/packages/")) return "package";
  return "repo";
}
const SCOPE_LABEL = { run: "Run workspace", skill: "Skill", template: "Templates", package: "Packages", repo: "Repo source" };
const SCOPE_ORDER = ["run", "skill", "template", "package", "repo"];

/**
 * Map one accumulator's `rich` output + a live node's identity → a partial `RunViewNode`. Mirrors the
 * mapping build-run-view.mjs does for the transcode, so the SAME NodeHud renders it. Every array the HUD
 * indexes (toolBreakdown/scopes/reads/writes/artifacts/bash/timeline/issues) is always present (never
 * undefined) so a live node can't crash the HUD; artifacts is empty (on-disk verify is offline only).
 */
export function liveRunViewNode(node, rich) {
  const reads = (rich.reads || []).map((r) => ({
    path: r.path, displayPath: displayPath(r.path), via: r.via, scope: scopeOf(r.path), preview: r.preview,
  }));
  const buckets = {};
  for (const r of reads) (buckets[r.scope] = buckets[r.scope] || []).push(r.displayPath);
  const scopes = SCOPE_ORDER.filter((k) => buckets[k]).map((kind) => ({
    kind, label: SCOPE_LABEL[kind] || kind, count: buckets[kind].length, paths: buckets[kind],
  }));
  const writes = (rich.writes || []).map((w) => ({ path: w.path, displayPath: displayPath(w.path), verified: w.verified, bytes: w.bytes }));
  return {
    id: node.id, label: node.label, phase: node.phase, status: node.status,
    durationMs: rich.durationMs ?? null, expectedMs: null, priorSamples: 0,
    model: rich.model, provider: rich.provider, api: rich.api,
    toolCalls: rich.toolCalls, toolBreakdown: rich.toolBreakdown, timeline: rich.timeline,
    reads, scopes, writes, artifacts: [], bash: rich.bash, tokens: rich.tokens,
    summary: undefined, issues: [], stageIndex: node.stageIndex, lane: node.lane,
  };
}

/**
 * One per live run. Folds node-event PiEvents per node (idempotent — each frame pushed once by the
 * caller) and yields a `richByNode` map for the current live nodes. Only nodes that have folded ≥1
 * event appear in the map; the rest render with the lean snapshot data.
 */
export class LiveTelemetry {
  constructor() { this.accs = new Map(); }

  /** Fold one node-event frame's `event` into node `nodeId`'s accumulator. */
  pushEvent(nodeId, event) {
    let acc = this.accs.get(nodeId);
    if (!acc) { acc = createNodeAccumulator(); this.accs.set(nodeId, acc); }
    acc.push(event);
  }

  has(nodeId) { return this.accs.has(nodeId); }

  /** Build { nodeId → partial RunViewNode } for the given live nodes (those with folded events). */
  richByNode(nodes) {
    const out = {};
    for (const n of nodes) {
      const acc = this.accs.get(n.id);
      if (acc) out[n.id] = liveRunViewNode(n, acc.finalize().rich);
    }
    return out;
  }

  /** Sum of every folded node's billable tokens — the run-level live token counter. */
  billableTotal() {
    let total = 0;
    for (const acc of this.accs.values()) { const t = acc.finalize().rich.tokens; total += t.billable || 0; }
    return total;
  }
}
