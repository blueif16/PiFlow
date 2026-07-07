/**
 * IssueBits — the shared, layout-agnostic building blocks for the M8 issues surfaces, so the run-level card,
 * the node-level in-HUD list, and the node side-pane all render issues IDENTICALLY (one status vocabulary,
 * one row, one content view). Deliberately presentational: no fetching, no context — the caller supplies the
 * records and the click handlers.
 *
 * GitHub-issues idiom (the user's reference): an issue is OPEN unless it is `resolved` (then CLOSED); a
 * `regressed` issue is open again but visually distinct ("reopened"). Icons imitate GitHub's octicons —
 * a green issue-opened ring-dot, a purple issue-closed check-ring, an amber reopened ring-dot.
 */
import type { ReactNode } from "react";
import { MarkdownReader } from "./MarkdownReader";
import { isClosed, isCurrentRun, type IssueRecord, type Issue, type Severity, type Status } from "../data/nodeIssues";
import "../styles/issues.css";

// severity → the shared tone vocabulary (matches IssuesPanel/digest: block=red · warn=amber · muted=gray).
const SEVERITY_TONE: Record<Severity, string> = { critical: "block", high: "block", medium: "warn", low: "muted" };

type IconKind = "open" | "closed" | "reopened";
function iconKind(status: Status): IconKind {
  if (status === "resolved") return "closed";
  if (status === "regressed") return "reopened";
  return "open";
}

/** GitHub-octicon-style status glyph: green ring-dot (open), purple check-ring (resolved), amber ring-dot
 *  (regressed/reopened). The exact status word rides alongside in a tag — the icon is the open/closed signal. */
export function IssueStatusIcon({ status, title }: { status: Status; title?: string }) {
  const kind = iconKind(status);
  return (
    <svg
      className="ds-issue-ic" data-kind={kind} width="15" height="15" viewBox="0 0 16 16" fill="currentColor"
      aria-hidden={title ? undefined : true} role={title ? "img" : undefined} aria-label={title}
    >
      {kind === "closed" ? (
        // issue-closed (completed): a check inside the ring
        <>
          <path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z" />
          <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
        </>
      ) : (
        // issue-opened (open / reopened): a filled center dot inside the ring
        <>
          <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
          <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
        </>
      )}
    </svg>
  );
}

/** The "N open · M closed" count cluster — the identity-row affordance + any header summary. Presentational:
 *  wrap it in a <button> where it should be clickable. */
export function IssueCountCluster({ open, closed, compact }: { open: number; closed: number; compact?: boolean }) {
  return (
    <span className={`ds-issue-counts${compact ? " ds-issue-counts--compact" : ""}`}>
      <span className="ds-issue-count" data-kind="open">
        <IssueStatusIcon status="open" />
        <span className="ds-issue-count__v">{open}</span>
        {!compact && <span className="ds-issue-count__l">open</span>}
      </span>
      <span className="ds-issue-count" data-kind="closed">
        <IssueStatusIcon status="resolved" />
        <span className="ds-issue-count__v">{closed}</span>
        {!compact && <span className="ds-issue-count__l">closed</span>}
      </span>
    </span>
  );
}

/** One issue in a list: status icon · title · severity chip · optional "this run" badge. Renders as a button
 *  when `onClick` is given (the master → detail affordance), else a static row. `showNode` prefixes the node
 *  id (the run-level flat/grouped view). */
export function IssueRow({
  record, activeRun, selected, showNode, onClick,
}: {
  record: IssueRecord; activeRun?: string; selected?: boolean; showNode?: boolean; onClick?: () => void;
}) {
  const { issue } = record;
  const badge = activeRun && isCurrentRun(record, activeRun);
  const body: ReactNode = (
    <>
      <IssueStatusIcon status={issue.status} title={issue.status} />
      {showNode && <span className="ds-issue-row__node">{record.node}</span>}
      <span className="ds-issue-row__title" title={issue.title}>{issue.title}</span>
      {issue.status !== "open" && !isClosed(issue.status) && (
        <span className="ds-issue-row__status" data-kind={iconKind(issue.status)}>{issue.status}</span>
      )}
      <span className="ds-issue-row__sev" data-tone={SEVERITY_TONE[issue.severity]}>{issue.severity}</span>
      {badge && <span className="ds-nflag" data-tone="retry" title="referenced by the currently-viewed run">this run</span>}
    </>
  );
  const cls = `ds-issue-row${selected ? " is-sel" : ""}`;
  return onClick
    ? <button type="button" className={cls} data-closed={isClosed(issue.status)} onClick={onClick} aria-pressed={selected}>{body}</button>
    : <div className={cls} data-closed={isClosed(issue.status)}>{body}</div>;
}

/** The issue's full content — the parsed "original issue file": a facts header (status · severity · seen · fix
 *  attempts) over the verbatim markdown context brief. This is what the CENTER pane / detail view renders. */
export function IssueContent({ record }: { record: IssueRecord }) {
  const { issue }: { issue: Issue } = record;
  return (
    <div className="ds-issue-content">
      <header className="ds-issue-content__head">
        <IssueStatusIcon status={issue.status} title={issue.status} />
        <h3 className="ds-issue-content__title">{issue.title}</h3>
        <span className="ds-issue-row__sev" data-tone={SEVERITY_TONE[issue.severity]}>{issue.severity}</span>
      </header>

      <dl className="ds-issue-facts">
        <Fact k="status" v={issue.status} />
        {issue.reason && <Fact k="reason" v={issue.reason} />}
        <Fact k="first seen" v={issue.firstSeen} />
        <Fact k="last seen" v={issue.lastSeen} />
        <Fact k="signature" v={<code>{issue.sig}</code>} />
      </dl>

      {issue.attempts.length > 0 && (
        <section className="ds-issue-attempts">
          <h4 className="ds-issue-attempts__head">fix attempts · {issue.attempts.length}</h4>
          <ol className="ds-issue-attempts__list">
            {issue.attempts.map((a, i) => (
              <li key={i} className="ds-issue-attempt" data-regressed={!!a.regressedIn}>
                <code className="ds-issue-attempt__commit">{a.commit}</code>
                <span className="ds-issue-attempt__by">verified · {a.verifiedByRun}</span>
                {a.regressedIn && <span className="ds-issue-attempt__reg">regressed · {a.regressedIn}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="ds-issue-content__body">
        <MarkdownReader source={issue.body} />
      </div>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="ds-issue-fact">
      <dt className="ds-issue-fact__k">{k}</dt>
      <dd className="ds-issue-fact__v">{v}</dd>
    </div>
  );
}
