/**
 * RunDigestPanel — the run-LEVEL observation lens: the whole run at a glance, not one node. A full-height
 * glass rail on the LEFT edge (mirroring the Companion's right rail), layered over the flowmap with no
 * backdrop, one tier below the floating MenuBar/ModeBar. Toggled by the ModeBar's "D" key.
 *
 * DATA: pure projection. It fetches `/__piflow/run-digest/<run>` — the agent-facing RunDigest core already
 * builds (projectRunDigest over the same run-view the canvas renders) — so nothing is re-derived here. It
 * shows the run verdict + cost spine, the RANKED anomaly worklist (each row tinted by severity, clicking it
 * focuses the node), and failure-onset localization (the earliest decisive upstream node → … → the failure).
 * While the run is live it self-polls; when the stream flips to done it refetches the authoritative record.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { loadRunDigest, type RunDigest, type AnomalyKind } from "../data/runDigest";
import "../styles/digest.css";

const KIND_LABEL: Record<AnomalyKind, string> = {
  failed: "FAILED",
  truncated: "TRUNCATED",
  "context-pressure": "CONTEXT",
  "tool-loop": "LOOP",
  slow: "SLOW",
  retries: "RETRIES",
};
// severity tone, reusing the gate/policy tint vocabulary (block=red, warn=amber, retry=blue, escalate=violet).
const KIND_TONE: Record<AnomalyKind, string> = {
  failed: "block",
  truncated: "block",
  "tool-loop": "warn",
  "context-pressure": "warn",
  slow: "retry",
  retries: "escalate",
};

/** compact token count: 1234 → "1.2k", 45000 → "45k". */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}

export function RunDigestPanel({
  open,
  activeRun,
  liveStatus,
  onFocusNode,
  onClose,
}: {
  open: boolean;
  activeRun: string;
  /** the live stream status ("connecting" | "live" | "done" | "error") — a flip to "done" refetches the record. */
  liveStatus: string;
  onFocusNode: (nodeId: string) => void;
  onClose: () => void;
}) {
  const [digest, setDigest] = useState<RunDigest | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch on open; while the run is unfinished, self-poll (mirrors the canvas's run-view poll). Re-running on
  // `liveStatus` means a stream flip to "done" pulls the final record promptly.
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
        if (!d.done) timer = setTimeout(load, 3000);
      } catch (e) {
        if (!alive) return;
        setError(String((e as Error)?.message ?? e));
        timer = setTimeout(load, 3000); // a just-started run may not be distillable yet — retry
      }
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [open, activeRun, liveStatus]);

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

  return createPortal(
    <div className="ds-digest-layer">
      <GlassSurface variant="window" className="ds-digest" legibleText aria-label="Run digest">
        <button type="button" className="ds-digest__close" onClick={onClose} title="Close (D)" aria-label="Close digest">✕</button>

        <header className="ds-digest__head">
          <div className="ds-digest__run" title={activeRun}>{activeRun || "—"}</div>
          <span className="ds-digest__verdict" data-tone={verdictTone}>{verdict}</span>
        </header>

        {error && <p className="ds-digest__error">Couldn’t load digest — {error}</p>}

        {t && (
          <div className="ds-digest__totals" aria-label="Run totals">
            <Stat label="nodes" value={`${t.ok}/${t.nodes}`} sub={t.failed ? `${t.failed} failed` : "ok"} tone={t.failed ? "block" : "ok"} />
            <Stat label="tokens" value={`${fmtTokens(t.inputTokens)}→${fmtTokens(t.outputTokens)}`} sub="in→out" />
            {t.cost > 0 && <Stat label="cost" value={`$${t.cost.toFixed(t.cost < 1 ? 3 : 2)}`} />}
            <Stat label="peak ctx" value={fmtTokens(t.contextPeak)} sub="tokens" />
            <Stat label="calls" value={`${t.modelCalls}·${t.toolCalls}`} sub="model·tool" />
          </div>
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
