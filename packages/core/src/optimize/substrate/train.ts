// optimize/substrate/train.ts — the adopt TRAIN's PURE policy (docs/design/optimize-blame.md §6, WS-B5). The
// impure land (cherry-pick, branch GC, the issue walk-back) lives in fix.ts `adoptSubstrateManifest`; THIS
// module is the deterministic, fs/git-free brain it consults — so the policy is table-tested in isolation.
//
// THREE pure decisions:
//   • assessStaleness — the per-record staleness VERDICT over `(baseSha, HEAD, interveningPaths, closure)`
//     (§6's staleness table). LAW — CONSERVATIVE ON MISSING EVIDENCE: an absent baseSha or an unreadable
//     intervening diff degrades to `overlap` (re-prove/bounce), NEVER `disjoint`. This is the merge-queue
//     default (always-revalidate when disjointness cannot be PROVEN); assuming disjoint on missing evidence
//     would silently land a fix onto a baseline that moved under it. `disjoint` is earned ONLY by a readable
//     diff whose changed paths provably miss the node's include-closure.
//   • orderRecords — the deterministic LANDING ORDER (§6 single-writer train): blame node order first, then
//     every other node (node asc), then issues asc within a node. Completion order NEVER dictates landing
//     order — a lane's green candidate WAITS for its blame-ordered slot (bors `CompletedPendingMerge`).
//   • deriveNodeOrder — the blame graph's upstream-first topological order (§5 MODE T) over the summary tail's
//     `edges` (`owner → observedAt`; fixes flow downstream, so the OWNER lands first). Kahn's algorithm with a
//     node-asc tie-break; CYCLE-SAFE — nodes stuck in a cycle (never reaching in-degree 0) are appended
//     node-asc, so the fn is total and never hangs.

import type { BlameSummary } from '../blame/summary.js';

/** The per-record staleness verdict (§6): the live baseline is unchanged (`fresh`), moved but provably OUTSIDE
 *  this node's closure (`disjoint` — land + log the skip), or moved inside it / unprovable (`overlap` — re-prove
 *  or bounce, never a blind land). */
export type StalenessVerdict = 'fresh' | 'disjoint' | 'overlap';

/** PURE: is `rel` inside the closure — exactly a closure entry, or UNDER a closure dir? The SAME prefix rule
 *  `isOracleRel` (fix.ts) applies to the oracle set; here it applies to the include-closure, so a staleness
 *  overlap uses identical path semantics to the fence (`c` exactly, or `c/` a prefix — never a sibling-prefix). */
export function pathInClosure(rel: string, closure: readonly string[]): boolean {
  return closure.some((c) => rel === c || rel.startsWith(`${c}/`));
}

export interface AssessStalenessInput {
  /** the sha the candidate branched from — ABSENT on a pre-WS0 record (⇒ conservative overlap). */
  baseSha: string | undefined;
  /** the live branch's current HEAD. */
  headSha: string;
  /** `git diff --name-only baseSha HEAD` — the paths that moved since the base. UNDEFINED ⇒ the diff could not
   *  be read (⇒ conservative overlap). An empty array is a READABLE "nothing moved" (⇒ disjoint). */
  interveningPaths: string[] | undefined;
  /** the node's include-closure (`readClosureRefs(...).include`) — the paths a fix of this node may depend on. */
  closure: string[];
}

/**
 * The §6 staleness table as a pure verdict. `baseSha === HEAD` ⇒ `fresh`. A missing baseSha OR an unreadable
 * diff ⇒ `overlap` (the conservative degrade — never assume disjoint on missing evidence). Otherwise `disjoint`
 * iff NO intervening path lands inside the closure, else `overlap`.
 */
export function assessStaleness(input: AssessStalenessInput): StalenessVerdict {
  const { baseSha, headSha, interveningPaths, closure } = input;
  if (baseSha === headSha) return 'fresh';
  if (baseSha === undefined || interveningPaths === undefined) return 'overlap';
  return interveningPaths.some((p) => pathInClosure(p, closure)) ? 'overlap' : 'disjoint';
}

/** The severity spelling `orderRecords` ranks within a node (mirrors issues.ts `Severity`, duplicated so this
 *  policy module imports no fs-bound type — see `OrderableRecord`). */
export type OrderableSeverity = 'critical' | 'high' | 'medium' | 'low';

/** The minimal record shape `orderRecords` needs — kept structural (NOT `SubstrateManifestRecord`) so this
 *  policy module imports no fs-bound type and stays independently table-testable. */
export interface OrderableRecord {
  node: string;
  issue: string;
  /** §5 MODE P / §6 within-node ordering: HIGHER severity lands first (severity-desc). Absent ⇒ ranked LOWEST,
   *  so a record that declares no severity never jumps ahead of one that does. */
  severity?: OrderableSeverity;
  /** §5 MODE P / §6 within-node, within-severity tiebreak: OLDEST firstSeen lands first (firstSeen-asc). Absent
   *  ⇒ falls through to the deterministic issue-name asc tail. */
  firstSeen?: string;
}

/** Severity as a sortable rank; an ABSENT/unknown severity is 0 (lands last within a node, after any declared). */
const SEVERITY_RANK: Record<OrderableSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
function severityRank(s: OrderableSeverity | undefined): number {
  return s ? SEVERITY_RANK[s] : 0;
}

/**
 * Deterministic LANDING ORDER over staged records: nodes named in `nodeOrder` first, IN that order (the blame
 * upstream-first schedule); every other node after, node asc; then WITHIN a node the §5 MODE P / §6 priority —
 * severity-DESC (higher lands first), firstSeen-ASC (older first), and issue-name asc as the deterministic tail.
 * PURE — returns a NEW array, never mutates. Completion order is irrelevant here BY DESIGN (§6): the train lands
 * in this order no matter which candidate finished first.
 */
export function orderRecords<T extends OrderableRecord>(records: readonly T[], nodeOrder: string[] = []): T[] {
  const rank = (node: string): number => {
    const i = nodeOrder.indexOf(node);
    return i === -1 ? nodeOrder.length : i; // unranked nodes all share a rank AFTER every ranked node
  };
  return [...records].sort((a, b) => {
    const ra = rank(a.node);
    const rb = rank(b.node);
    if (ra !== rb) return ra - rb;
    if (a.node !== b.node) return a.node < b.node ? -1 : 1; // same rank but different (unranked) nodes → node asc
    // WITHIN a node (§5/§6): severity-desc, then firstSeen-asc, then issue-name asc (the deterministic tail).
    const bySeverity = severityRank(b.severity) - severityRank(a.severity);
    if (bySeverity !== 0) return bySeverity;
    if (a.firstSeen !== undefined && b.firstSeen !== undefined && a.firstSeen !== b.firstSeen) {
      return a.firstSeen < b.firstSeen ? -1 : 1;
    }
    if (a.issue !== b.issue) return a.issue < b.issue ? -1 : 1; // same node/severity/firstSeen → issue asc
    return 0;
  });
}

/**
 * The upstream-first node order derived from a blame summary's graph (§5 MODE T). Edges are `[owner,
 * observedAt]` (fixes flow downstream), so a topological sort with the OWNER before its targets schedules the
 * decision node first. Kahn's algorithm with a node-asc tie-break for determinism; CYCLE-SAFE — any node left
 * in a cycle (never reaching in-degree 0) is appended node-asc, so the fn is total and never hangs. The node
 * set is the union of the blamed nodes and every edge endpoint.
 */
export function deriveNodeOrder(summary: BlameSummary): string[] {
  const nodes = new Set<string>();
  for (const b of summary.blamed) nodes.add(b.node);
  for (const [owner, observedAt] of summary.edges) { nodes.add(owner); nodes.add(observedAt); }
  const all = [...nodes];

  const indeg = new Map<string, number>(all.map((n) => [n, 0]));
  const adj = new Map<string, string[]>(all.map((n) => [n, []]));
  for (const [owner, observedAt] of summary.edges) {
    adj.get(owner)!.push(observedAt);
    indeg.set(observedAt, (indeg.get(observedAt) ?? 0) + 1);
  }

  const emitted: string[] = [];
  const done = new Set<string>();
  for (;;) {
    // pick the smallest in-degree-0 node not yet emitted (node-asc tie-break → a total, deterministic order).
    const ready = all.filter((n) => !done.has(n) && (indeg.get(n) ?? 0) === 0).sort();
    if (ready.length === 0) break;
    const n = ready[0];
    emitted.push(n);
    done.add(n);
    for (const m of adj.get(n) ?? []) if (!done.has(m)) indeg.set(m, (indeg.get(m) ?? 0) - 1);
  }
  // cycle-safe: whatever never reached in-degree 0 is stuck in a cycle — append it node-asc rather than hang.
  const remaining = all.filter((n) => !done.has(n)).sort();
  return [...emitted, ...remaining];
}
