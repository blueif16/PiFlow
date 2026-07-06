/**
 * IssuesPanel — the M8 issues card: the FULL accumulated optimize-substrate issue ledger
 * (docs/specs/optimize-substrate-plan.md §M2) for one node TYPE (open/closed/regressed, severity-sorted).
 * Opened from the NodeHud's identity row (IssuesContext, mirroring the skill chip's SkillContext pattern) —
 * node-click selects the node TYPE, not a run-scoped view: the ledger accumulates across every run.
 *
 * DATA: pure projection, fetch-on-open (mirrors RunDigestPanel/SkillPanel's convention). It fetches
 * `/__piflow/issues/<run>?node=<id>` — core's `nodeIssuesProjection`, a thin wrapper over `listIssues` — and
 * re-fetches whenever the open node or the active run changes. No SSE: issues mutate only at triage/fix
 * time (the recon's explicit M8 verdict), so a plain re-fetch on reopen is enough — there is no live poll.
 *
 * VISUAL IDIOM: deliberately reuses RunDigestPanel's classes (`ds-digest__*`, `ds-node-row`, `ds-nflag`) —
 * no new design language. Severity/status map onto the SAME tone vocabulary the digest's worklist/flags use
 * (block=red · warn=amber · retry=blue · ok=green · muted=gray).
 */
import { useEffect, useState } from "react";
import { SideCard } from "./SideCard";
import { useIssues } from "./IssuesContext";
import { loadNodeIssues, sortIssues, isCurrentRun, type IssueRecord, type Severity, type Status } from "../data/nodeIssues";
import "../styles/digest.css";

const SEVERITY_TONE: Record<Severity, string> = { critical: "block", high: "block", medium: "warn", low: "muted" };
const STATUS_TONE: Record<Status, string> = {
  open: "warn", active: "retry", "fix-landed": "retry", verifying: "retry", resolved: "ok", regressed: "block",
};

export function IssuesPanel({ activeRun }: { activeRun: string }) {
  const { open, close } = useIssues();
  const [records, setRecords] = useState<IssueRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch on open (and whenever the open node or the active run changes) — no poll/SSE (see header).
  useEffect(() => {
    if (!open || !activeRun) { setRecords(null); setError(null); return; }
    let alive = true;
    setRecords(null);
    setError(null);
    loadNodeIssues(activeRun, open)
      .then((r) => { if (alive) setRecords(r); })
      .catch((e) => { if (alive) setError(String((e as Error)?.message ?? e)); });
    return () => { alive = false; };
  }, [open, activeRun]);

  if (!open) return null;

  const sorted = records ? sortIssues(records) : [];
  const verdict = !records ? "loading…" : sorted.length === 0 ? "clean" : `${sorted.length} issue${sorted.length === 1 ? "" : "s"}`;
  const verdictTone = verdict === "clean" ? "ok" : verdict === "loading…" ? "muted" : "block";

  return (
    <SideCard open={!!open} onClose={close} accent="issues" ariaLabel={`issue ledger for ${open}`}>
      <header className="ds-digest__head">
        <div className="ds-digest__run" title={open}>{open}</div>
        <span className="ds-digest__verdict" data-tone={verdictTone}>{verdict}</span>
      </header>

      {error && <p className="ds-digest__error">Couldn’t load issues — {error}</p>}

      <section className="ds-digest__section">
        <h3 className="ds-digest__title">Ledger · {sorted.length}</h3>
        {records && sorted.length === 0 && <p className="ds-digest__empty">No issues recorded for this node.</p>}
        <ul className="ds-digest__list ds-digest__nodes">
          {sorted.map(({ issue }) => (
            <li key={issue.id}>
              <div className="ds-node-row" data-tone={SEVERITY_TONE[issue.severity]}>
                <div className="ds-node-row__head">
                  <span className="ds-node-out" data-tone={STATUS_TONE[issue.status]}>{issue.status}</span>
                  <span className="ds-node-row__label" title={issue.title}>{issue.title}</span>
                  <span className="ds-node-row__phase">{issue.severity}</span>
                  {activeRun && isCurrentRun({ node: open, file: "", issue }, activeRun) && (
                    <span className="ds-nflag" data-tone="retry" title="referenced by the currently-viewed run">this run</span>
                  )}
                </div>
                {issue.attempts.length > 0 && (
                  <div className="ds-node-row__metrics">
                    <span className="ds-nm"><span className="ds-nm__v">{issue.attempts.length}</span><span className="ds-nm__l">attempt{issue.attempts.length === 1 ? "" : "s"}</span></span>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </SideCard>
  );
}
