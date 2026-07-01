/**
 * StartRunPanel — LAUNCH a run from the console. A centered glass modal (deployed from the MenuBar
 * launcher) that lets the user pick a product + workflow, set --arg key/values, choose the sandbox and
 * the executor (pi | claude-code), optionally dry-run, and Start. It POSTs the assembled body to
 * api('/api/runs/start') (the control server's launch endpoint); on the 202 it reads `{ run }` and hands
 * it to the canvas' existing run-select seam so the live views immediately observe the new run — no new
 * streaming/observe code here.
 *
 * The picker is fed by the SAME global index the switcher uses (loadIndex → products[] → namespaces[]).
 * We send `product` + `workflow` (the namespace id); the server resolves the template dir from those.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { apiFetch } from "../data/apiBase";
import { loadIndex, type GlobalIndex } from "../data/runIndex";
import "../styles/startrun.css";

const SANDBOXES = ["inmemory", "local", "danger-full-access", "daytona", "e2b"] as const;
type Sandbox = (typeof SANDBOXES)[number];
type Executor = "pi" | "claude-code";

interface ArgRow { key: string; value: string }

/** The 202 body the launch endpoint returns. */
interface StartResp { run: string; runDir: string | null; started: true; resolved: boolean }

export function StartRunPanel({ open, onClose, onStarted }: {
  open: boolean;
  onClose: () => void;
  /** the canvas' run-select setter — observe the newly-launched run. */
  onStarted: (run: string) => void;
}) {
  const [ix, setIx] = useState<GlobalIndex | null>(null);
  const [productId, setProductId] = useState<string>("");
  const [workflowId, setWorkflowId] = useState<string>("");
  const [args, setArgs] = useState<ArgRow[]>([]);
  const [sandbox, setSandbox] = useState<Sandbox>("local");
  const [executor, setExecutor] = useState<Executor>("pi");
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the index when the panel opens (its own read — the panel can be mounted standalone). Default the
  // pickers to the first product / its first workflow.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    loadIndex()
      .then((index) => {
        if (!alive) return;
        setIx(index);
        const p = index.products[0];
        if (p && !productId) { setProductId(p.id); setWorkflowId(p.namespaces[0]?.id ?? ""); }
      })
      .catch((e) => { if (alive) setError(String((e as Error)?.message ?? e)); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const product = useMemo(() => ix?.products.find((p) => p.id === productId) ?? null, [ix, productId]);

  // When the product changes, snap the workflow to its first namespace.
  useEffect(() => {
    if (product && !product.namespaces.some((n) => n.id === workflowId)) {
      setWorkflowId(product.namespaces[0]?.id ?? "");
    }
  }, [product, workflowId]);

  if (!open) return null;

  const addArg = () => setArgs((a) => [...a, { key: "", value: "" }]);
  const setArg = (i: number, patch: Partial<ArgRow>) =>
    setArgs((a) => a.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const delArg = (i: number) => setArgs((a) => a.filter((_, j) => j !== i));

  async function start() {
    if (!productId) { setError("pick a product"); return; }
    setBusy(true);
    setError(null);
    // Assemble the body from the fields: product + workflow locate the template server-side; the args rows
    // (non-empty keys only) become the run's --arg map; sandbox/executor/dryRun ride straight onto the flags.
    const argMap: Record<string, string> = {};
    for (const { key, value } of args) { const k = key.trim(); if (k) argMap[k] = value; }
    const body = {
      product: productId,
      workflow: workflowId || undefined,
      args: Object.keys(argMap).length ? argMap : undefined,
      sandbox,
      executor,
      // TODO: per-node executorOverride table — a { nodeId: 'pi' | 'claude-code' } map for heterogeneous fleets.
      dryRun: dryRun || undefined,
    };
    try {
      const res = await apiFetch("/api/runs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError((err as { error?: string }).error ?? `start failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as StartResp;
      onStarted(data.run); // observe the new run via the existing run-select seam
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
      <GlassSurface as="section" variant="window" legibleText className="ds-startrun" role="dialog" aria-modal="true" aria-label="Start a run">
        <div className="ds-startrun__head">
          <h2 className="ds-startrun__title">Start a run</h2>
          <button type="button" className="ds-startrun__close" aria-label="Close" onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <label className="ds-startrun__field">
          <span className="ds-startrun__label">Product</span>
          <select
            className="ds-startrun__control"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            disabled={!ix}
          >
            {!ix && <option value="">loading…</option>}
            {ix?.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>

        <label className="ds-startrun__field">
          <span className="ds-startrun__label">Workflow</span>
          <select
            className="ds-startrun__control"
            value={workflowId}
            onChange={(e) => setWorkflowId(e.target.value)}
            disabled={!product}
          >
            {product?.namespaces.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            {product && product.namespaces.length === 0 && <option value="">no workflows</option>}
          </select>
        </label>

        <div className="ds-startrun__field">
          <span className="ds-startrun__label">Args</span>
          <div className="ds-startrun__args">
            {args.map((row, i) => (
              <div className="ds-startrun__arg-row" key={i}>
                <input
                  className="ds-startrun__control"
                  placeholder="key"
                  value={row.key}
                  onChange={(e) => setArg(i, { key: e.target.value })}
                  aria-label={`arg ${i + 1} key`}
                />
                <input
                  className="ds-startrun__control"
                  placeholder="value"
                  value={row.value}
                  onChange={(e) => setArg(i, { value: e.target.value })}
                  aria-label={`arg ${i + 1} value`}
                />
                <button type="button" className="ds-startrun__arg-del" aria-label={`remove arg ${i + 1}`} onClick={() => delArg(i)}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4 8h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            ))}
            <button type="button" className="ds-startrun__arg-add" onClick={addArg}>+ add arg</button>
          </div>
        </div>

        <div className="ds-startrun__row">
          <label className="ds-startrun__field">
            <span className="ds-startrun__label">Sandbox</span>
            <select
              className="ds-startrun__control"
              value={sandbox}
              onChange={(e) => setSandbox(e.target.value as Sandbox)}
            >
              {SANDBOXES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>

          <div className="ds-startrun__field">
            <span className="ds-startrun__label">Executor</span>
            {/* run-level executor toggle for v1. TODO: per-node executorOverride table lives in the body above. */}
            <div className="ds-startrun__seg" role="group" aria-label="Executor">
              {(["pi", "claude-code"] as Executor[]).map((ex) => (
                <button
                  key={ex}
                  type="button"
                  className="ds-startrun__seg-btn"
                  aria-pressed={executor === ex}
                  onClick={() => setExecutor(ex)}
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className="ds-startrun__check">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Dry run (plan only — no agents spawned)
        </label>

        {error && <div className="ds-startrun__error" role="alert">{error}</div>}

        <div className="ds-startrun__foot">
          <button type="button" className="ds-startrun__btn ds-startrun__btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="ds-startrun__btn ds-startrun__btn--go" onClick={start} disabled={busy || !productId}>
            {busy ? "Starting…" : dryRun ? "Dry run" : "Start run"}
          </button>
        </div>
      </GlassSurface>
    </div>,
    document.body,
  );
}
