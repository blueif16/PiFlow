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

/** Fetch the run-LEVEL aggregate — every node's ledger (the `?node`-omitted route → `allIssuesProjection`).
 *  Viewer-tolerant server-side (one unreadable node ledger can't blank the whole card). Used by the run card. */
export async function loadAllIssues(run: string): Promise<IssueRecord[]> {
  const res = await apiFetch(`/__piflow/issues/${encodeURIComponent(run)}`);
  if (!res.ok) throw new Error(`Failed to load run-level issues (run "${run}"): ${res.status} ${res.statusText}`);
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

// ── status partition + counts + grouping (the GitHub-issues model, pure so it's testable) ─────────────────

/** True when the issue is CLOSED. GitHub semantics: only `resolved` is closed; every other status —
 *  open/active/fix-landed/verifying and a reopened `regressed` — counts as OPEN. */
export function isClosed(status: Status): boolean {
  return status === "resolved";
}

/** The open/closed tallies the identity-row count cluster renders (`◎ N open · ✓ M closed`). */
export function issueCounts(records: IssueRecord[]): { open: number; closed: number } {
  let closed = 0;
  for (const r of records) if (isClosed(r.issue.status)) closed++;
  return { open: records.length - closed, closed };
}

// ── the optimize-loop status PROGRESSION (mirrors core's ALLOWED_TRANSITIONS pipeline) ────────────────────
// A per-node issue is walked through a fixed pipeline by the out-of-band optimize loop:
//   open → active → fix-landed → verifying → resolved
// `regressed` is a resolved issue reopened (a hash re-match of a closed issue) — it completed the whole
// pipeline once, then bounced back and re-enters at `active`. This block is the single source of truth the
// node-level card reads for BOTH the progression stepper and the per-row status tone, so the two never drift
// from each other or from core's status machine.

/** The human phase an issue is in — the coarse tone the UI colors by (finer than isClosed's binary). */
export type StatusPhase = "open" | "in-progress" | "closed" | "reopened";

/** Per-status label + phase. `open` = untouched/awaiting work; the three `in-progress` states are the live
 *  fix cycle; `resolved` = closed; `regressed` = reopened after a resolve. */
export const STATUS_META: Record<Status, { label: string; phase: StatusPhase }> = {
  open: { label: "open", phase: "open" },
  active: { label: "active", phase: "in-progress" },
  "fix-landed": { label: "fix landed", phase: "in-progress" },
  verifying: { label: "verifying", phase: "in-progress" },
  resolved: { label: "resolved", phase: "closed" },
  regressed: { label: "regressed", phase: "reopened" },
};

/** The pipeline stages, in order — the stepper's fixed rail. `regressed` is NOT a stage (it's a reopen of
 *  the terminal `resolved`), so it never appears here; `lifecycleView` renders it against this rail. */
export const LIFECYCLE_STAGES: readonly { key: Exclude<Status, "regressed">; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "active", label: "Active" },
  { key: "fix-landed", label: "Fix landed" },
  { key: "verifying", label: "Verifying" },
  { key: "resolved", label: "Resolved" },
];

/** One rendered stage of the progression stepper. */
export interface LifecycleStage {
  key: Exclude<Status, "regressed">;
  label: string;
  /** `done` = already passed · `current` = the issue is here now · `pending` = not yet reached ·
   *  `reopened` = the terminal `resolved` stage of a `regressed` issue (walked once, then bounced back). */
  state: "done" | "current" | "pending" | "reopened";
}

/**
 * Project a status onto the fixed pipeline rail — every stage before the issue's position is `done`, its own
 * stage is `current`, later stages are `pending`. A `regressed` issue reached `resolved` once (the only edge
 * into `regressed`), so its whole rail is `done` with the terminal `resolved` stage flagged `reopened`.
 */
export function lifecycleView(status: Status): LifecycleStage[] {
  const reopened = status === "regressed";
  const currentIdx = reopened
    ? LIFECYCLE_STAGES.length - 1 // the resolved terminal, flagged reopened below
    : LIFECYCLE_STAGES.findIndex((s) => s.key === status);
  return LIFECYCLE_STAGES.map((stage, i) => {
    let state: LifecycleStage["state"];
    if (reopened && i === currentIdx) state = "reopened";
    else if (i < currentIdx) state = "done";
    else if (i === currentIdx) state = "current";
    else state = "pending";
    return { key: stage.key, label: stage.label, state };
  });
}

/** One node's issues, for the run-level card's grouped rendering. */
export interface IssueGroup {
  node: string;
  records: IssueRecord[];
}

/** Partition records by node, ordered worst-severity-first (then node name), each group sorted by
 *  `sortIssues`. The run-level "characterized by node" view + its node filter read this. */
export function groupByNode(records: IssueRecord[]): IssueGroup[] {
  const byNode = new Map<string, IssueRecord[]>();
  for (const r of records) {
    const bucket = byNode.get(r.node);
    if (bucket) bucket.push(r);
    else byNode.set(r.node, [r]);
  }
  const topRank = (rs: IssueRecord[]) => Math.max(...rs.map((r) => SEVERITY_RANK[r.issue.severity]));
  return [...byNode.entries()]
    .map(([node, rs]) => ({ node, records: sortIssues(rs) }))
    .sort((a, b) => {
      const bySeverity = topRank(b.records) - topRank(a.records); // worst node first
      if (bySeverity !== 0) return bySeverity;
      return a.node < b.node ? -1 : a.node > b.node ? 1 : 0; // tiebreak: node name ASC
    });
}
