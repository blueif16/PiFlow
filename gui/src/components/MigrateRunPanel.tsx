/**
 * MigrateRunPanel — MOVE the active run to another serve (the one-click local ⇄ cloud switch). A centered
 * glass modal (deployed from the MenuBar) that lists the target contexts and, on Migrate, asks THIS serve to
 * orchestrate the move (POST /api/migrate → the serve spawns `piflowctl context migrate`, reusing the tested
 * freeze→bundle→adopt→resume). On the 202 the serve hands back the target's endpoint (baseUrl + token); the
 * panel calls `onMigrated`, and the canvas re-points the whole console to it (setEndpoint) so the live views
 * reconnect to the run on its new home — no reload.
 *
 * Why server-orchestrated (not the browser POSTing freeze/bundle/adopt): the serve sets no CORS, and a
 * multi-MB bundle can't cross origins from the browser; the serve reaches both its own fleet and the target.
 * UPLOAD (local→cloud) is the one-click path; a cloud→laptop DOWNLOAD stays a CLI op (a cloud VM can't reach
 * your laptop) — such a target simply won't be reachable, and the move reports the failure.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { apiFetch, useEndpoint } from "../data/apiBase";
import "../styles/startrun.css";

const LOCAL_BASE_URL = "http://127.0.0.1:5273";

interface ContextRow { name: string; baseUrl: string }
/** The 202 body /api/migrate returns — the target endpoint to re-point the console to. */
interface MigrateResp { run: string; target: { name: string; baseUrl: string; token: string }; migrating: true }

export function MigrateRunPanel({ open, onClose, activeRun, onMigrated }: {
  open: boolean;
  onClose: () => void;
  activeRun: string;
  /** re-point the console to the target endpoint + follow the run to its new home. */
  onMigrated: (target: { baseUrl: string; token: string }, run: string) => void;
}) {
  const { baseUrl: currentBaseUrl } = useEndpoint();
  const [contexts, setContexts] = useState<ContextRow[] | null>(null);
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the target contexts when the panel opens. Exclude the CURRENT endpoint (can't migrate to self):
  // a context whose baseUrl matches the current one, or `local` when the GUI is same-origin ("").
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    setContexts(null);
    apiFetch("/api/contexts")
      .then(async (r) => {
        if (!r.ok) throw new Error(`contexts unavailable (${r.status})`);
        return (await r.json()) as { contexts: ContextRow[] };
      })
      .then(({ contexts: rows }) => {
        if (!alive) return;
        const isSelf = (e: ContextRow) => e.baseUrl === currentBaseUrl || (currentBaseUrl === "" && e.baseUrl === LOCAL_BASE_URL);
        const targets = rows.filter((e) => !isSelf(e));
        setContexts(targets);
        if (targets[0] && !target) setTarget(targets[0].name);
      })
      .catch((e) => { if (alive) setError(String((e as Error)?.message ?? e)); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentBaseUrl]);

  if (!open) return null;

  async function migrate() {
    if (!target) { setError("pick a target"); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/migrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run: activeRun, target }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError((err as { error?: string }).error ?? `migrate failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as MigrateResp;
      onMigrated({ baseUrl: data.target.baseUrl, token: data.target.token }, data.run);
      onClose();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="ds-startrun-scrim"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <GlassSurface as="section" variant="window" legibleText className="ds-startrun" role="dialog" aria-modal="true" aria-label="Migrate this run">
        <div className="ds-startrun__head">
          <h2 className="ds-startrun__title">Migrate run</h2>
          <button type="button" className="ds-startrun__close" aria-label="Close" onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <p className="ds-startrun__label" style={{ marginBottom: 4 }}>
          Move <strong style={{ fontFamily: "var(--ds-font-mono)" }}>{activeRun}</strong> to another control plane. It
          freezes at the next node boundary, its run-dir moves, and it resumes there via the journal.
        </p>

        <label className="ds-startrun__field">
          <span className="ds-startrun__label">Target</span>
          <select
            className="ds-startrun__control"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={!contexts}
          >
            {!contexts && <option value="">loading…</option>}
            {contexts?.map((c) => <option key={c.name} value={c.name}>{c.name} — {c.baseUrl}</option>)}
            {contexts && contexts.length === 0 && <option value="">no other contexts — add one (piflowctl cloud up / context add)</option>}
          </select>
        </label>

        {error && <div className="ds-startrun__error" role="alert">{error}</div>}

        <div className="ds-startrun__foot">
          <button type="button" className="ds-startrun__btn ds-startrun__btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="ds-startrun__btn ds-startrun__btn--go" onClick={migrate} disabled={busy || !target}>
            {busy ? "Migrating…" : "Migrate"}
          </button>
        </div>
      </GlassSurface>
    </div>,
    document.body,
  );
}
