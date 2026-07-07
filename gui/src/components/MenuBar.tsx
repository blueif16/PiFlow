/**
 * MenuBar — the persistent top-right shell chrome. It lives in the canvas shell
 * (CanvasInner), NOT inside the NodeHud, and PORTALS to <body> at a z above the
 * overlay scrim so it stays visible and clickable in BOTH the full-map view and
 * the per-node HUD view. Because it's portaled within the providers, it still
 * reads ExpandContext (Exit). (Fit view lives once, in the React Flow Controls bottom-left.)
 *
 *   [ ⊞ folder ] [ template / run ▾ ]  9/9 · 1m47s   ✕ exit(node mode only)
 *
 * The ⊞ pill (current folder name) opens the full-screen WorkspaceLauncher to switch
 * folders (re-scope). The template/run switch opens the SAME Miller-column directory
 * menu as the canvas navigator (DirectoryPanel), fed by the global index snapshot
 * (~/.piflow/index.json via the Vite middleware); selecting a run sets the active run.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { DirectoryPanel } from "./DirectoryPanel";
import { useExpand } from "./ExpandContext";
import { findThread, homeRoots, homeWorkspace, indexToTree, workspaceOfRun, type GlobalIndex } from "../data/runIndex";
import { formatMs } from "../data/runView";
import "../styles/menubar.css";
import "../styles/startrun.css";

// `ix` is owned + LIVE-polled by CanvasInner (single source of truth) and passed down — the switcher
// list + status chip stay fresh as runs start / progress without the bar holding its own loader.
// `onStartRun` deploys the StartRunPanel (owned by CanvasInner so it can wire the returned run into
// the run-select seam). Which control server the GUI talks to is shown by the ControlPlaneChip
// (bottom-right, beside the chat launcher), not here — this bar carries the workspace/run switcher + run actions.
export function MenuBar({ activeRun, workspaceName, onOpenWorkspaces, onSelectRun, onStartRun, onMigrateRun, ix, hidden = false, peeking = false, onDismissMenu }: { activeRun: string; workspaceName: string | null; onOpenWorkspaces: () => void; onSelectRun: (run: string) => void; onStartRun: () => void; onMigrateRun: () => void; ix: GlobalIndex | null; hidden?: boolean; peeking?: boolean; onDismissMenu?: () => void }) {
  const { expandedId, collapse } = useExpand();
  const [open, setOpen] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);

  // dismiss the switcher on any click outside it (or Esc) — the "click anywhere closes" rule
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!layerRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown, true); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // PEEKED over an open card (summoned by the card's menu handle): an outside click / Escape / a selection
  // dismisses the bar again so it never lingers over the card.
  useEffect(() => {
    if (!peeking) return;
    const onDown = (e: MouseEvent) => { if (!layerRef.current?.contains(e.target as Node)) onDismissMenu?.(); };
    // capture + stopImmediatePropagation so an Escape dismisses the PEEK only — the open card's own Escape
    // (SideCard) never also fires, so the card stays put.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); onDismissMenu?.(); } };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown, true); document.removeEventListener("keydown", onKey, true); };
  }, [peeking, onDismissMenu]);

  const active = ix ? findThread(ix, activeRun) : null;
  // Scope the switcher to the ACTIVE workspace: the workspace that owns the active run, else the launched
  // ("home") folder — never the whole global registry. indexToTree itself falls back to every workspace
  // when this resolves to null (nothing owns activeRun AND no home root matched), so the switcher is never
  // empty just because a workspace couldn't be pinned down.
  const activeWorkspace = ix ? (workspaceOfRun(ix, activeRun) ?? homeWorkspace(ix, homeRoots())) : null;
  const { tree, resolve } = useMemo(
    () => (ix ? indexToTree(ix, activeWorkspace) : { tree: [], resolve: () => undefined }),
    [ix, activeWorkspace],
  );

  // hidden while a card is open (and not being peeked) — the open card hosts the menu handle instead.
  if (hidden) return null;

  return createPortal(
    <div className="ds-menubar-layer" ref={layerRef}>
      <GlassSurface variant="soft" as="nav" className="ds-menubar" legibleText aria-label="Workspace menu">
        {/* WORKSPACE pill — the current folder + a grid glyph; opens the full-screen launcher to switch folders.
            Always shows the workspace name (orientation), even for an empty folder with no active run. */}
        <button
          type="button"
          className="ds-menubar__workspace"
          aria-label="Switch workspace"
          title="Switch workspace — browse & enter another folder"
          onClick={() => { onOpenWorkspaces(); onDismissMenu?.(); }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
            <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
            <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
            <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          <span className="ds-menubar__ws-name">{workspaceName ?? "workspace"}</span>
        </button>
        <span className="ds-menubar__vsep" aria-hidden="true" />

        <button
          type="button"
          className="ds-menubar__switch"
          aria-expanded={open}
          aria-haspopup="true"
          onClick={() => setOpen((o) => !o)}
          disabled={!ix}
        >
          <span className="ds-menubar__ns">{active?.nsName ?? "workspace"}</span>
          <span className="ds-menubar__sep" aria-hidden="true">/</span>
          <span className="ds-menubar__run">{activeRun}</span>
          <svg className={`ds-menubar__chev${open ? " is-open" : ""}`} width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {active && (
          <span className="ds-menubar__status" data-state={active.state} data-stalled={active.state === "running" && active.runningStalled ? "true" : undefined}>
            {active.nodesDone}/{active.nodesTotal} · {formatMs(active.elapsedMs)}
            {active.state === "running" && active.phase && <span className="ds-menubar__live"> · {active.phase}</span>}
            {active.state === "running" && active.runningNode && (
              <span className="ds-menubar__live"> · {active.runningNode}{active.runningTool ? `:${active.runningTool}` : ""}</span>
            )}
            {active.state === "running" && active.runningStalled && <span className="ds-menubar__stalled"> · stalled</span>}
          </span>
        )}

        {/* LAUNCH a run — the one action in the chrome (accent-tinted). Opens the StartRunPanel. */}
        <button type="button" className="ds-menubar__icon ds-menubar__start" aria-label="Start a run" title="Start a run" onClick={onStartRun}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4.5 3l8 5-8 5V3z" fill="currentColor" />
          </svg>
        </button>

        {/* MIGRATE the active run to another serve (local ⇄ cloud). Needs a run to move; opens MigrateRunPanel. */}
        {activeRun && (
          <button type="button" className="ds-menubar__icon" aria-label="Migrate this run" title="Migrate this run to another serve" onClick={onMigrateRun}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 5h9M8 2l3 3-3 3M14 11H5M8 14l-3-3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}

        {expandedId && (
          <button type="button" className="ds-menubar__icon ds-menubar__exit" aria-label="Exit node view" onClick={collapse}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </GlassSurface>

      {open && ix && (
        <div className="ds-menubar__pop">
          <DirectoryPanel
            tree={tree}
            title="Workspaces · runs"
            reverse
            onOpenFile={(entry) => {
              const hit = resolve(entry.id);
              if (!hit) return;
              onSelectRun(hit.run); // viewable OR live — the canvas + companion handle both
              setOpen(false);
              onDismissMenu?.();
            }}
          />
        </div>
      )}
    </div>,
    document.body,
  );
}
