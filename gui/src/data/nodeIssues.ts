// nodeIssues.ts — the GUI's contract for the M8 issues card: the optimize-substrate issue LEDGER
// (docs/specs/optimize-substrate-plan.md §M2) for one node TYPE. Mirrors `runDigest.ts`'s convention: the
// shape tracks `@piflow/core/observe` `nodeIssuesProjection` (a thin wrapper over `listIssues`), fetched
// fresh from `/__piflow/issues/<run>?node=<id>` on open (no mock fallback, no client-side cache beyond the
// component's own state).
//
// The ledger is NODE-TYPE-scoped, not run-scoped — it accumulates across every run of the node — so this
// module also carries the pure BADGE/SORT logic the card applies to flag rows against the run it was opened
// from, extracted here (not inlined in the component) so it is unit-testable without a DOM.
import { apiFetch } from "./apiBase";

export type Severity = "critical" | "high" | "medium" | "low";
export type Status = "open" | "active" | "fix-landed" | "verifying" | "resolved" | "regressed";
export type Reason = "fixed" | "wontfix" | "false-positive" | "superseded";

/** One append-only fix attempt on an issue (see core's `Attempt`). */
export interface IssueAttempt {
  commit: string;
  verifiedByRun: string;
  /** set when the fix that landed this attempt later regressed. */
  regressedIn?: string;
}

/** One issue, parsed (mirrors core's `Issue` — the M2 ledger's frontmatter + body). */
export interface Issue {
  id: string;
  name: string;
  title: string;
  severity: Severity;
  status: Status;
  reason: Reason | null;
  sig: string;
  firstSeen: string;
  lastSeen: string;
  attempts: IssueAttempt[];
  body: string;
}

/** One row as `nodeIssuesProjection`/`listIssues` emit it — the node id + its file path + the parsed issue. */
export interface IssueRecord {
  node: string;
  file: string;
  issue: Issue;
}

/** Fetch the full accumulated ledger for one node TYPE, scoped by the run the card was opened from (the
 *  route is node-scoped, not run-scoped — `run` only resolves which registered repo/template to read). */
export async function loadNodeIssues(run: string, node: string): Promise<IssueRecord[]> {
  const res = await apiFetch(`/__piflow/issues/${encodeURIComponent(run)}?node=${encodeURIComponent(node)}`);
  if (!res.ok) throw new Error(`Failed to load issues for node "${node}" (run "${run}"): ${res.status} ${res.statusText}`);
  return (await res.json()) as IssueRecord[];
}

// ── pure sort/badge logic (extracted so it's testable without a DOM — test-discipline) ────────────────────

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** severity DESC, then firstSeen ASC — mirrors core's `listIssues` order (the card re-asserts it rather than
 *  trusting the wire order, since a future caller of this module may pass an unsorted array). */
export function sortIssues(records: IssueRecord[]): IssueRecord[] {
  return [...records].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.issue.severity] - SEVERITY_RANK[a.issue.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.issue.firstSeen < b.issue.firstSeen) return -1;
    if (a.issue.firstSeen > b.issue.firstSeen) return 1;
    return 0;
  });
}

/**
 * True when this issue record is tied to the CURRENTLY-viewed run — its `firstSeen`/`lastSeen` IS that run
 * (a run id, per the M1 date-seq naming), or one of its `attempts[]` was `verifiedByRun`/`regressedIn` by it.
 * This is the "badge this row" predicate the card applies per-row against the ledger — the ledger itself
 * carries no notion of "current run" (it's node-TYPE-scoped), so the badge is a client-side projection.
 */
export function isCurrentRun(record: IssueRecord, run: string): boolean {
  if (!run) return false;
  const { issue } = record;
  if (issue.firstSeen === run || issue.lastSeen === run) return true;
  return issue.attempts.some((a) => a.verifiedByRun === run || a.regressedIn === run);
}
