/**
 * RunIssuesPanel — the M8 RUN-LEVEL issues card (bottom-bar "Issues" / the I key). The whole template's
 * issues, "characterized by node": grouped by node (worst-severity node first), with a filter-by-node chip
 * row and a GitHub-style open/closed count per node. The ledger is run-agnostic — the `activeRun` only picks
 * which template to read (`loadAllIssues` → the `?node`-omitted aggregate route). Clicking an issue does NOT
 * expand here: it JUMPS to that node's HUD with the issue open (onOpenIssue) — the run card is the index, the
 * node view is the reader.
 *
 * DATA: fetch-on-open (mirrors RunDigestPanel/SkillPanel); no SSE — issues mutate only at triage/fix time.
 * VISUAL: the right-dock SideCard shell (accent="issues") + the digest header classes; rows/icons are the
 * shared IssueBits so every issue surface reads identically.
 */
import { useEffect, useMemo, useState } from "react";
import { SideCard } from "./SideCard";
import { IssueRow, IssueCountCluster } from "./IssueBits";
import { loadAllIssues, groupByNode, issueCounts, type IssueRecord } from "../data/nodeIssues";
import "../styles/digest.css";
import "../styles/issues.css";

export function RunIssuesPanel({ activeRun, open, onClose, onOpenIssue }: {
  activeRun: string;
  open: boolean;
  onClose: () => void;
  /** jump to a node's HUD with this issue open (the run card is an index, the node view is the reader). */
  onOpenIssue: (node: string, issueId: string) => void;
}) {
  const [records, setRecords] = useState<IssueRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nodeFilter, setNodeFilter] = useState<string | null>(null); // null = all nodes

  useEffect(() => {
    if (!open || !activeRun) { setRecords(null); setError(null); setNodeFilter(null); return; }
    let alive = true;
    setRecords(null); setError(null);
    loadAllIssues(activeRun)
      .then((r) => { if (alive) setRecords(r); })
      .catch((e) => { if (alive) setError(String((e as Error)?.message ?? e)); });
    return () => { alive = false; };
  }, [open, activeRun]);

  const groups = useMemo(() => (records ? groupByNode(records) : []), [records]);
  const total = records?.length ?? 0;
  const counts = issueCounts(records ?? []);
  const shown = nodeFilter ? groups.filter((g) => g.node === nodeFilter) : groups;

  if (!open) return null;

  return (
    <SideCard open={open} onClose={onClose} accent="issues" ariaLabel={`issues for run ${activeRun}`}>
      <header className="ds-digest__head">
        <div className="ds-digest__run" title={activeRun}>Issues · {activeRun}</div>
        {records && <IssueCountCluster open={counts.open} closed={counts.closed} />}
      </header>

      {error && <p className="ds-digest__error">Couldn’t load issues — {error}</p>}
      {!records && !error && <p className="ds-digest__empty">Loading issues…</p>}
      {records && total === 0 && <p className="ds-digest__empty">No issues recorded across this template’s nodes.</p>}

      {/* filter by node — one chip per node, plus "all" */}
      {groups.length > 1 && (
        <div className="ds-issue-filter" role="group" aria-label="Filter issues by node">
          <button type="button" className={`ds-issue-filter__chip${!nodeFilter ? " is-active" : ""}`} onClick={() => setNodeFilter(null)}>all nodes</button>
          {groups.map((g) => (
            <button
              key={g.node}
              type="button"
              className={`ds-issue-filter__chip${nodeFilter === g.node ? " is-active" : ""}`}
              onClick={() => setNodeFilter((cur) => (cur === g.node ? null : g.node))}
            >
              {g.node}
            </button>
          ))}
        </div>
      )}

      {shown.map((g) => {
        const c = issueCounts(g.records);
        return (
          <section key={g.node} className="ds-issue-group">
            <header className="ds-issue-group__head">
              <span className="ds-issue-group__node">{g.node}</span>
              <IssueCountCluster open={c.open} closed={c.closed} compact />
            </header>
            <div className="ds-issue-group__list">
              {g.records.map((rec) => (
                <IssueRow
                  key={rec.issue.id}
                  record={rec}
                  activeRun={activeRun}
                  onClick={() => onOpenIssue(g.node, rec.issue.id)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </SideCard>
  );
}
