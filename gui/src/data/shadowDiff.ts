// shadowDiff.ts — the P4 dev-only PARITY GATE (docs/design/observe-live-sse-single-source.md DR7/§8/§10-P4/§11).
// Before the live default flips from 'poll' to 'sse', a human must PROVE the SSE-rendered graph is byte-identical
// to the authoritative /run-view — never eyeballed. This is that proof: a PURE deep-compare of the two RunViews
// over the ENTIRE rendered field key, returning the concrete per-field divergences (empty ⇒ they agree).
//
// The field key mirrors DR7/§11 — everything `toFlowGraph` (+ the derived zones) actually consumes:
//   per-node : tokens · derived · model · provider · contextWindow · toolCalls · toolBreakdown · reads · writes ·
//              artifacts · retries · stopReason · truncated · summary · durationMs · stageIndex · lane
//   run      : the edges set (from|to|path) · the stages (index/phase/parallel/nodeIds) · tokenTotal
// A node present in one view but not the other is itself a divergence (scope 'node', that side's value truthy,
// the other undefined); likewise an edge. Nodes are matched by id, edges by their (from,to,path) identity.
//
// Divergences report the DEEPEST differing leaf: an object recurses per-key so a scalar mismatch names the exact
// dotted path (`tokens.billable`, `derived.context.tone`) and carries BOTH concrete scalar values — an actionable
// log for the human running `?live=sse&shadow=1`. Arrays are compared whole (their order is significant, matching
// how the rendered lists are consumed), so a list mismatch reports the whole two arrays.
import type { RunView, RunViewNode } from "./runView";

/** One byte-level disagreement between the SSE-rendered and the /run-view-loaded graph. `scope` locates it
 *  (a node by `id`, an edge, or a run-level rollup); `field` is the dotted leaf path; `sse`/`poll` are the two
 *  concrete values that differ (one is `undefined` when the whole node/edge/leaf is missing on that side). */
export interface Divergence {
  scope: "node" | "edge" | "run";
  id?: string;
  field: string;
  sse: unknown;
  poll: unknown;
}

/** Stable structural deep-equal: JSON with sorted keys (order-independent for objects; array order IS
 *  significant, matching how the rendered lists are consumed). NaN/undefined are normalized by JSON. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Deep structural equality via the stable serialization. */
function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Recursively diff two values, emitting `{field,sse,poll}` at the DEEPEST differing leaf. Two plain objects
 * recurse per-key (union of keys, so a key present on one side surfaces as `undefined` on the other); anything
 * else (scalar, array, null, object-vs-non-object shape mismatch) that isn't `deepEqual` is reported whole at
 * `path`. Returns [] when structurally equal. PURE.
 */
function diffValue(path: string, sse: unknown, poll: unknown): Array<{ field: string; sse: unknown; poll: unknown }> {
  if (deepEqual(sse, poll)) return [];
  if (isPlainObject(sse) && isPlainObject(poll)) {
    const out: Array<{ field: string; sse: unknown; poll: unknown }> = [];
    const keys = new Set<string>([...Object.keys(sse), ...Object.keys(poll)]);
    for (const k of keys) out.push(...diffValue(path ? `${path}.${k}` : k, sse[k], poll[k]));
    return out;
  }
  return [{ field: path, sse, poll }];
}

/** The per-node rendered field key (DR7/§11) — every field `toFlowGraph`/the zones read off a RunViewNode. */
const NODE_FIELDS = [
  "tokens", "derived", "model", "provider", "contextWindow", "toolCalls", "toolBreakdown",
  "reads", "writes", "artifacts", "retries", "stopReason", "truncated", "summary",
  "durationMs", "stageIndex", "lane",
  "agentType", // (G6) rendered identity: face avatar + hover card + basis chip key off it
] as const satisfies readonly (keyof RunViewNode)[];

/** Compare two node lists by id; a node on one side only is a divergence, else diff the field key. */
function diffNodes(sse: RunViewNode[], poll: RunViewNode[]): Divergence[] {
  const out: Divergence[] = [];
  const sseById = new Map(sse.map((n) => [n.id, n]));
  const pollById = new Map(poll.map((n) => [n.id, n]));
  const ids = new Set<string>([...sseById.keys(), ...pollById.keys()]);
  for (const id of ids) {
    const s = sseById.get(id);
    const p = pollById.get(id);
    if (!s || !p) {
      // a node present in one view but not the other IS a divergence
      out.push({ scope: "node", id, field: "<node>", sse: s, poll: p });
      continue;
    }
    for (const f of NODE_FIELDS) {
      for (const d of diffValue(f, s[f], p[f])) out.push({ scope: "node", id, ...d });
    }
  }
  return out;
}

/** Compare the edge SETS by (from,to,path) identity — an edge on one side only is a divergence. */
function diffEdges(sse: RunView["edges"], poll: RunView["edges"]): Divergence[] {
  const out: Divergence[] = [];
  const key = (e: { from: string; to: string; path: string }) => `${e.from} ${e.to} ${e.path}`;
  const sseByKey = new Map((sse ?? []).map((e) => [key(e), e]));
  const pollByKey = new Map((poll ?? []).map((e) => [key(e), e]));
  const keys = new Set<string>([...sseByKey.keys(), ...pollByKey.keys()]);
  for (const k of keys) {
    const s = sseByKey.get(k);
    const p = pollByKey.get(k);
    if (!s || !p) out.push({ scope: "edge", id: k, field: "edge", sse: s, poll: p });
  }
  return out;
}

/**
 * The parity gate: deep-compare the SSE-rendered `RunView` against the authoritative /run-view-loaded one over
 * the FULL rendered field key (DR7/§11) — per-node telemetry + the edges set + the stages + `tokenTotal`.
 * Returns `[]` when byte-identical, else the concrete list of divergences (deepest differing leaf). PURE.
 */
export function shadowDiff(sse: RunView, poll: RunView): Divergence[] {
  const out: Divergence[] = [];
  out.push(...diffNodes(sse.nodes, poll.nodes));
  out.push(...diffEdges(sse.edges, poll.edges));
  // run-level rollups the graph reads: the stages set (compared whole — array order is the layout order) and the
  // folded tokenTotal (recursed to leaf so a single billable/contextPeak delta reads concretely).
  if (!deepEqual(sse.stages, poll.stages)) out.push({ scope: "run", field: "stages", sse: sse.stages, poll: poll.stages });
  for (const d of diffValue("tokenTotal", sse.tokenTotal, poll.tokenTotal)) out.push({ scope: "run", ...d });
  return out;
}
