/**
 * RunDigestPanel — the run-LEVEL observation lens: the whole run at a glance, not one node. A full-height
 * glass rail on the LEFT edge (mirroring the Companion's right rail), layered over the flowmap with no
 * backdrop, one tier below the floating MenuBar/ModeBar. Toggled by the ModeBar's "D" key.
 *
 * DATA: pure projection. It fetches `/__piflow/run-digest/<run>` — the agent-facing RunDigest core already
 * builds (projectRunDigest over the same run-view the canvas renders) — so nothing is re-derived here (the
 * ONE trivial exception is summing `nodes[].topTools` into a run-wide tool distribution). It renders, top to
 * bottom: the run verdict + cost spine (totals, anomaly count, a run-wide tool distribution, and a flag
 * summary), the RANKED anomaly worklist (each row tinted by severity, clicking it focuses the node), the
 * failure-onset localization (earliest decisive upstream node → … → the failure), and the PER-NODE telemetry
 * table (one clickable row per node — outcome · model · duration/slow · tokens · ctx% · calls · top tools ·
 * loop/retry/truncate flags — sorted anomalous-first, else run order).
 * REFRESH (P5): EVENT-DRIVEN under SSE (a `liveSig` delta — a node status flip or a billable bucket crossing —
 * re-runs the effect), with a 3 s self-poll only as the POLL-mode fallback (`liveSig === null`). Either way a
 * stream flip to "done" refetches the authoritative record.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { loadRunDigest, type RunDigest, type NodeDigest, type AnomalyKind } from "../data/runDigest";
import { formatTokens, formatMs } from "../data/runView";
import { ToolTag } from "./toolMeta";
import "../styles/digest.css";

const KIND_LABEL: Record<AnomalyKind, string> = {
  failed: "FAILED",
  truncated: "TRUNCATED",
  "context-pressure": "CONTEXT",
  "tool-loop": "LOOP",
  "loop-score": "STUCK-LOOP",
  slow: "SLOW",
  "cost-spike": "COST-SPIKE",
  retries: "RETRIES",
};
// severity tone, reusing the gate/policy tint vocabulary (block=red, warn=amber, retry=blue, escalate=violet).
const KIND_TONE: Record<AnomalyKind, string> = {
  failed: "block",
  truncated: "block",
  "tool-loop": "warn",
  "loop-score": "warn",
  "context-pressure": "warn",
  slow: "retry",
  "cost-spike": "retry",
  retries: "escalate",
};

// outcome → tone, reusing the same vocabulary: error/blocked/failed = block, gap = warn, running = retry,
// ok = ok, reused/dry/skipped = muted, anything else neutral. Colours the row's outcome tag + attention border.
const OUTCOME_TONE: Record<string, string> = {
  ok: "ok",
  reused: "muted",
  running: "retry",
  blocked: "block",
  error: "block",
  failed: "block",
  gap: "warn",
  dry: "muted",
  skipped: "muted",
};
const outcomeTone = (o: string) => OUTCOME_TONE[o] ?? "neutral";
// context-pressure tone on a node's ctx% cell (mirrors runView.contextTone: ≥0.7 high, ≥0.4 warn).
const ctxTone = (pct: number) => (pct >= 0.7 ? "block" : pct >= 0.4 ? "warn" : "neutral");
// a node is looping if a tool repeated ≥3× or it tail-sampled a loop anomaly.
const isLooping = (n: NodeDigest) =>
  n.maxToolRepeat >= 3 || n.anomalies.includes("tool-loop") || n.anomalies.includes("loop-score");
// a node is slow if its duration ran >1.5× its mean, or it tail-sampled the slow anomaly.
const isSlow = (n: NodeDigest) => (n.slowRatio != null && n.slowRatio > 1.5) || n.anomalies.includes("slow");
// worklist-style rank for the per-node table: nodes with anomalies first, then failure outcomes, then run order.
const nodeRank = (n: NodeDigest): number => {
  if (n.anomalies.length > 0) return 0;
  if (n.outcome === "error" || n.outcome === "blocked" || n.outcome === "failed" || n.outcome === "gap") return 1;
  return 2;
};
// sum every node's topTools into one run-wide distribution, highest first (the only re-derivation in the panel).
function runToolDistribution(nodes: NodeDigest[]): Array<[string, number]> {
  const acc: Record<string, number> = {};
  for (const n of nodes) for (const [tool, count] of Object.entries(n.topTools)) acc[tool] = (acc[tool] ?? 0) + count;
  return Object.entries(acc).sort((a, b) => b[1] - a[1]);
}
// the ADDITIVE per-tool error tally alongside runToolDistribution — same sum, over topToolErrors — so a
// tool rejected on every call across the run doesn't read identically to a real run-wide execution count.
function runToolErrorDistribution(nodes: NodeDigest[]): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const n of nodes) for (const [tool, count] of Object.entries(n.topToolErrors ?? {})) acc[tool] = (acc[tool] ?? 0) + count;
  return acc;
}

export function RunDigestPanel({
  open,
  activeRun,
  liveStatus,
  liveSig,
  onFocusNode,
  onClose,
}: {
  open: boolean;
  activeRun: string;
  /** the live stream status ("connecting" | "live" | "done" | "error") — a flip to "done" refetches the record. */
  liveStatus: string;
  /** (P5) the SSE trigger signature (`digestLiveSig`): non-null ⇒ SSE-driven — refetch when it changes (a delta),
   *  no 3 s success timer; null ⇒ POLL-mode — keep the 3 s fallback timer while the run is unfinished. */
  liveSig: string | null;
  onFocusNode: (nodeId: string) => void;
  onClose: () => void;
}) {
  const [digest, setDigest] = useState<RunDigest | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch on open. REFRESH is EVENT-DRIVEN under SSE (`liveSig !== null`): the effect re-runs when `liveSig`
  // changes (a node status flip or a billable bucket crossing) or `liveStatus` flips to "done", so NO success
  // timer is armed. In POLL-mode (`liveSig === null`) it keeps the 3 s self-poll while the run is unfinished
  // (mirrors the canvas's run-view poll). Either mode retries on error — a just-started run may not be distillable yet.
  useEffect(() => {
    if (!open || !activeRun) { setDigest(null); setError(null); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const d = await loadRunDigest(activeRun);
        if (!alive) return;
        setDigest(d);
        setError(null);
        if (liveSig === null && !d.done) timer = setTimeout(load, 3000); // poll-mode fallback only; SSE re-runs on a delta
      } catch (e) {
        if (!alive) return;
        setError(String((e as Error)?.message ?? e));
        timer = setTimeout(load, 3000); // a just-started run may not be distillable yet — retry (both modes)
      }
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [open, activeRun, liveStatus, liveSig]);

  if (!open) return null;

  const t = digest?.totals;
  const verdict = !digest
    ? "loading…"
    : !digest.done
      ? "running"
      : digest.ok === false || (t && t.failed > 0)
        ? `${t?.failed ?? 0} failed`
        : "clean";
  const verdictTone = verdict === "clean" ? "ok" : verdict === "running" || verdict === "loading…" ? "muted" : "block";

  // run-wide derivations (trivial sums/counts over the per-node array; nothing else is re-derived).
  const nodes = digest?.nodes ?? [];
  const toolDist = runToolDistribution(nodes);
  const toolErrDist = runToolErrorDistribution(nodes);
  const flags: Array<[AnomalyKind, number]> = [
    ["tool-loop", nodes.filter(isLooping).length],
    ["retries", nodes.filter((n) => n.retries > 0).length],
    ["truncated", nodes.filter((n) => n.truncated).length],
    ["slow", nodes.filter(isSlow).length],
  ];
  const sortedNodes = nodes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => nodeRank(a.n) - nodeRank(b.n) || a.i - b.i)
    .map((x) => x.n);

  return createPortal(
    <div className="ds-digest-layer">
      <GlassSurface variant="window" className="ds-digest" legibleText aria-label="Run digest">
        <button type="button" className="ds-digest__close" onClick={onClose} title="Close (D)" aria-label="Close digest">✕</button>

        <header className="ds-digest__head">
          <div className="ds-digest__run" title={activeRun}>{activeRun || "—"}</div>
          <span className="ds-digest__verdict" data-tone={verdictTone}>{verdict}</span>
        </header>

        {digest?.source && <div className="ds-digest__source" title={digest.source}>{digest.source}</div>}

        {error && <p className="ds-digest__error">Couldn’t load digest — {error}</p>}

        {t && digest && (
          <div className="ds-digest__totals" aria-label="Run totals">
            <Stat label="nodes" value={`${t.ok}/${t.nodes}`} sub={t.failed ? `${t.failed} failed` : "ok"} tone={t.failed ? "block" : "ok"} />
            <Stat label="tokens" value={`${formatTokens(t.inputTokens)}→${formatTokens(t.outputTokens)}`} sub="in→out" />
            {t.cost > 0 && <Stat label="cost" value={`$${t.cost.toFixed(t.cost < 1 ? 3 : 2)}`} />}
            <Stat label="peak ctx" value={formatTokens(t.contextPeak)} sub="tokens" />
            <Stat label="calls" value={`${t.modelCalls}·${t.toolCalls}`} sub="model·tool" />
            <Stat label="anomalies" value={String(digest.anomalies.length)} tone={digest.anomalies.length ? "block" : "ok"} />
            {digest.durationMs != null && <Stat label="duration" value={formatMs(digest.durationMs)} />}
          </div>
        )}

        {/* run-wide tool distribution (summed from every node's topTools) + a flag summary */}
        {(toolDist.length > 0 || flags.some(([, c]) => c > 0)) && (
          <section className="ds-digest__section">
            <h3 className="ds-digest__title">Tools · {toolDist.reduce((s, [, c]) => s + c, 0)} calls</h3>
            {toolDist.length > 0 && (
              <div className="ds-digest__tools">
                {toolDist.map(([tool, count]) => (
                  <ToolTag key={tool} name={tool} count={count} errors={toolErrDist[tool]} />
                ))}
              </div>
            )}
            {flags.some(([, c]) => c > 0) && (
              <div className="ds-digest__flags">
                {flags.filter(([, c]) => c > 0).map(([kind, count]) => (
                  <span key={kind} className="ds-nflag" data-tone={KIND_TONE[kind]}>
                    {KIND_LABEL[kind]} <b>{count}</b>
                  </span>
                ))}
              </div>
            )}
          </section>
        )}

        <section className="ds-digest__section">
          <h3 className="ds-digest__title">Worklist · {digest?.anomalies.length ?? 0}</h3>
          {digest && digest.anomalies.length === 0 && (
            <p className="ds-digest__empty">No anomalies — every node ran within its bars.</p>
          )}
          <ul className="ds-digest__list">
            {digest?.anomalies.map((a, i) => (
              <li key={`${a.kind}-${a.nodeId}-${i}`}>
                <button type="button" className="ds-anom" data-tone={KIND_TONE[a.kind]} onClick={() => onFocusNode(a.nodeId)} title={`Focus ${a.nodeId}`}>
                  <span className="ds-anom__kind">{KIND_LABEL[a.kind]}</span>
                  <span className="ds-anom__node">{a.nodeId}</span>
                  <span className="ds-anom__detail">{a.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {digest && digest.rootCauses.length > 0 && (
          <section className="ds-digest__section">
            <h3 className="ds-digest__title">Failure onset · {digest.rootCauses.length}</h3>
            <ul className="ds-digest__list">
              {digest.rootCauses.map((rc) => (
                <li key={rc.failed} className="ds-onset">
                  <div className="ds-onset__chain">
                    {rc.chain.map((id, i) => (
                      <span key={id} className="ds-onset__hop">
                        {i > 0 && <span className="ds-onset__arrow" aria-hidden="true">→</span>}
                        <button
                          type="button"
                          className="ds-onset__node"
                          data-role={id === rc.earliestUpstream ? "origin" : id === rc.failed ? "failed" : "mid"}
                          onClick={() => onFocusNode(id)}
                          title={`Focus ${id}`}
                        >
                          {id}
                        </button>
                      </span>
                    ))}
                  </div>
                  {rc.viaPath && <div className="ds-onset__via" title={rc.viaPath}>via {rc.viaPath}</div>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* the per-node telemetry table — the run's full observation surface, one clickable row per node */}
        {sortedNodes.length > 0 && (
          <section className="ds-digest__section">
            <h3 className="ds-digest__title">Nodes · {sortedNodes.length}</h3>
            <ul className="ds-digest__list ds-digest__nodes">
              {sortedNodes.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className="ds-node-row"
                    data-tone={outcomeTone(n.outcome)}
                    onClick={() => onFocusNode(n.id)}
                    title={`Focus ${n.id}`}
                  >
                    <div className="ds-node-row__head">
                      <span className="ds-node-out" data-tone={outcomeTone(n.outcome)}>{n.outcome}</span>
                      <span className="ds-node-row__label">{n.label}</span>
                      {n.phase && <span className="ds-node-row__phase">{n.phase}</span>}
                      {n.model && <span className="ds-node-row__model" title={n.provider ? `${n.provider} · ${n.model}` : n.model}>{n.model}</span>}
                    </div>

                    <div className="ds-node-row__metrics">
                      {n.durationMs != null && (
                        <span className="ds-nm">
                          <span className="ds-nm__v">{formatMs(n.durationMs)}</span>
                          {isSlow(n) && n.slowRatio != null && <span className="ds-nm__flag" data-tone="warn">×{n.slowRatio.toFixed(1)}</span>}
                        </span>
                      )}
                      {(n.inputTokens > 0 || n.outputTokens > 0) && (
                        <span className="ds-nm"><span className="ds-nm__v">{formatTokens(n.inputTokens)}→{formatTokens(n.outputTokens)}</span><span className="ds-nm__l">tok</span></span>
                      )}
                      {n.cost > 0 && (
                        <span className="ds-nm"><span className="ds-nm__v">${n.cost.toFixed(n.cost < 1 ? 3 : 2)}</span></span>
                      )}
                      {n.contextPct != null && (
                        <span className="ds-nm" data-tone={ctxTone(n.contextPct)}><span className="ds-nm__v">{Math.round(n.contextPct * 100)}%</span><span className="ds-nm__l">ctx</span></span>
                      )}
                      {(n.modelCalls > 0 || n.toolCalls > 0) && (
                        <span className="ds-nm"><span className="ds-nm__v">{n.modelCalls}·{n.toolCalls}</span><span className="ds-nm__l">calls</span></span>
                      )}
                    </div>

                    {(Object.keys(n.topTools).length > 0 || isLooping(n) || n.retries > 0 || n.truncated) && (
                      <div className="ds-node-row__tools">
                        {Object.entries(n.topTools)
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 3)
                          .map(([tool, count]) => (
                            <ToolTag key={tool} name={tool} count={count} errors={n.topToolErrors?.[tool]} />
                          ))}
                        {isLooping(n) && (
                          <span className="ds-nflag" data-tone="warn" title={n.repeatedTool ? `${n.repeatedTool} ×${n.maxToolRepeat}` : undefined}>
                            LOOP{n.maxToolRepeat > 1 ? ` ×${n.maxToolRepeat}` : ""}{n.repeatedTool ? ` ${n.repeatedTool}` : ""}
                          </span>
                        )}
                        {n.retries > 0 && <span className="ds-nflag" data-tone="escalate">RETRY ×{n.retries}</span>}
                        {n.truncated && <span className="ds-nflag" data-tone="block">TRUNC{n.stopReason ? ` ${n.stopReason}` : ""}</span>}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </GlassSurface>
    </div>,
    document.body,
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="ds-digest__stat" data-tone={tone ?? "neutral"}>
      <span className="ds-digest__stat-v">{value}</span>
      <span className="ds-digest__stat-l">{label}</span>
      {sub && <span className="ds-digest__stat-s">{sub}</span>}
    </div>
  );
}
