/**
 * WorkspaceLauncher — the full-screen "switch workspace" launcher (the corner icon in the MenuBar opens it).
 * A workspace = a folder/repo (a `product` in the global index); entering one RE-SCOPES the whole console to
 * that folder — its templates, its runs, and the live pi session all follow (the effect lives in CanvasInner's
 * `enterWorkspace`). This surface only PICKS a workspace; it computes nothing about the switch itself.
 *
 * Pattern (see gui/docs/WORKSPACE-SWITCHER.md): a deliberate re-scope launcher (VS-Code-window / Basecamp-
 * Launchpad model), leading with recents (folders with a live run first, then most-recent) + fuzzy search, the
 * current folder always labelled for orientation. Because the switch re-points a LIVE agent session, choosing a
 * DIFFERENT folder while a run is live routes through an inline confirm ("detach the live session") — the
 * design-system rule of confirming only when state is actually live, never on a clean switch.
 *
 * Portaled to <body> above the modal scrim; Esc / scrim-click / click-away close (the shell's overlay convention).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { deriveWorkspaces, type GlobalIndex, type WorkspaceCard } from "../data/runIndex";
import "../styles/launcher.css";

export function WorkspaceLauncher({
  open,
  ix,
  activeWorkspace,
  liveRun,
  onEnter,
  onClose,
}: {
  open: boolean;
  ix: GlobalIndex | null;
  /** the product id currently entered (shown as "current"), or null before first focus. */
  activeWorkspace: string | null;
  /** non-null when the current run is LIVE — switching folders then asks to confirm (detach the session). */
  liveRun: string | null;
  onEnter: (productId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  // a pending switch that needs confirmation (chosen a different folder while a run is live). Null = no confirm.
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Esc closes; reset the query + any pending confirm each time the launcher opens; focus the search.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setConfirm(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => { document.removeEventListener("keydown", onKey); window.clearTimeout(t); };
  }, [open, onClose]);

  const workspaces = useMemo(() => (ix ? deriveWorkspaces(ix) : []), [ix]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter((w) => `${w.name} ${w.root} ${w.id}`.toLowerCase().includes(q));
  }, [workspaces, query]);
  const currentName = workspaces.find((w) => w.id === activeWorkspace)?.name ?? "the current workspace";

  if (!open) return null;

  // Choose a folder: already here → just close; live run + a DIFFERENT folder → confirm; else commit now.
  const choose = (w: WorkspaceCard) => {
    if (!w.viewable && w.id !== activeWorkspace) return; // a folder this serve can't open isn't enterable
    if (w.id === activeWorkspace) { onClose(); return; }
    if (liveRun) { setConfirm({ id: w.id, name: w.name }); return; }
    commit(w.id);
  };
  const commit = (id: string) => { onEnter(id); onClose(); };

  return createPortal(
    <div
      className="ds-wsl-scrim"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <GlassSurface variant="window" as="div" legibleText role="dialog" aria-modal="true" aria-label="Switch workspace" className="ds-wsl">
        <header className="ds-wsl__head">
          <div className="ds-wsl__titles">
            <h2 className="ds-wsl__title">Switch workspace</h2>
            <p className="ds-wsl__sub">Each workspace is a folder — its templates, runs, and pi session.</p>
          </div>
          <button type="button" className="ds-wsl__close" aria-label="Close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <input
          ref={inputRef}
          className="ds-wsl__search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && filtered[0]) choose(filtered[0]); }}
          placeholder="Search workspaces…"
          spellCheck={false}
          aria-label="Search workspaces"
        />

        <div className="ds-wsl__grid" role="listbox" aria-label="Workspaces">
          {filtered.map((w) => (
            <button
              key={w.id}
              type="button"
              role="option"
              aria-selected={w.id === activeWorkspace}
              className="ds-wsl-card"
              data-current={w.id === activeWorkspace ? "true" : undefined}
              data-unviewable={!w.viewable && w.id !== activeWorkspace ? "true" : undefined}
              disabled={!w.viewable && w.id !== activeWorkspace}
              onClick={() => choose(w)}
              title={w.viewable || w.id === activeWorkspace ? w.root : `${w.root} — not served by this console`}
            >
              <span className="ds-wsl-card__top">
                <span className="ds-wsl-card__name">{w.name}</span>
                {w.runningCount > 0 && <span className="ds-wsl-card__dot" aria-hidden="true" />}
                {w.id === activeWorkspace && <span className="ds-wsl-card__badge">current</span>}
              </span>
              <span className="ds-wsl-card__root">{w.root}</span>
              <span className="ds-wsl-card__stats">
                {w.templateCount} {w.templateCount === 1 ? "template" : "templates"} · {w.runCount} {w.runCount === 1 ? "run" : "runs"}
                {w.runningCount > 0 && <span className="ds-wsl-card__live"> · {w.runningCount} live</span>}
                {!w.viewable && w.id !== activeWorkspace && <span className="ds-wsl-card__off"> · not served</span>}
              </span>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="ds-wsl__empty">
              {workspaces.length === 0 ? "No workspaces registered yet." : `No workspace matches “${query}”.`}
            </div>
          )}
        </div>
      </GlassSurface>

      {confirm && (
        <div className="ds-wsl-confirm-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirm(null); }} role="presentation">
          <GlassSurface variant="window" as="div" legibleText role="alertdialog" aria-label="Confirm workspace switch" className="ds-wsl-confirm">
            <p className="ds-wsl-confirm__note">
              A run is live in <strong>{currentName}</strong>. Switching to <strong>{confirm.name}</strong> detaches
              that session from this console (it keeps running; you can return to it).
            </p>
            <div className="ds-wsl-confirm__foot">
              <button type="button" className="ds-wsl__btn-ghost" onClick={() => setConfirm(null)}>Stay</button>
              <button type="button" className="ds-wsl__btn-go" onClick={() => commit(confirm.id)}>Switch anyway</button>
            </div>
          </GlassSurface>
        </div>
      )}
    </div>,
    document.body,
  );
}
