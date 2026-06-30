/**
 * MenuBar — the persistent top-right shell chrome. It lives in the canvas shell
 * (CanvasInner), NOT inside the NodeHud, and PORTALS to <body> at a z above the
 * overlay scrim so it stays visible and clickable in BOTH the full-map view and
 * the per-node HUD view. Because it's portaled within the providers, it still
 * reads ExpandContext (Exit) and the React Flow instance (Fit view).
 *
 *   [ workspace / run ▾ ]  9/9 · 1m47s   ⤢ fit   ✕ exit(node mode only)
 *
 * Clicking the switch opens the workspace/run switcher — the SAME Miller-column
 * directory menu as the canvas navigator (DirectoryPanel), fed by the global
 * index snapshot (~/.piflow/index.json via the Vite middleware). Selecting a run
 * sets the active run; the live pi connection is deferred.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useReactFlow } from "@xyflow/react";
import { GlassSurface } from "./GlassSurface";
import { DirectoryPanel } from "./DirectoryPanel";
import { useExpand } from "./ExpandContext";
import { findThread, indexToTree, type GlobalIndex } from "../data/runIndex";
import { formatMs } from "../data/runView";
import "../styles/menubar.css";

// `ix` is owned + LIVE-polled by CanvasInner (single source of truth) and passed down — the switcher
// list + status chip stay fresh as runs start / progress without the bar holding its own loader.
export function MenuBar({ activeRun, onSelectRun, ix }: { activeRun: string; onSelectRun: (run: string) => void; ix: GlobalIndex | null }) {
  const { expandedId, collapse } = useExpand();
  const { fitView } = useReactFlow();
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

  const active = ix ? findThread(ix, activeRun) : null;
  const { tree, resolve } = useMemo(() => (ix ? indexToTree(ix) : { tree: [], resolve: () => undefined }), [ix]);

  return createPortal(
    <div className="ds-menubar-layer" ref={layerRef}>
      <GlassSurface variant="soft" as="nav" className="ds-menubar" legibleText aria-label="Workspace menu">
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

        <button type="button" className="ds-menubar__icon" aria-label="Fit view" onClick={() => fitView({ padding: 0.25, duration: 320 })}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 5.5V2.5h3M14 5.5V2.5h-3M2 10.5v3h3M14 10.5v3h-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

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
            }}
          />
        </div>
      )}
    </div>,
    document.body,
  );
}
