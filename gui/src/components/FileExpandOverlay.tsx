/**
 * FileExpandOverlay — the "clicked-a-file" view. Same shell grammar as NodeExpandOverlay
 * (portaled to <body>, the global frosted scrim, Esc / scrim-click close, focus trap) but
 * laid out for a FILE instead of a node:
 *
 *      ┌ EXPLORER ┐                                  the run's file navigator (top-left)
 *      │          │            FILE                  the file's real content fills the
 *      ├──────────┤          (entire                 entire right area, rendered BARE
 *      │ PROVENANCE│          right)                  on the scrim (same FileView the node
 *      └──────────┘                                  HUD uses — no card, no background)
 *
 * The only background is the global scrim, so the effect matches the node pane: the
 * explorer appears to stay in place while everything else dims and the file fills the
 * right. PROVENANCE (bottom-left) names the node that produced this file and the nodes
 * that read it — both click through to that node's HUD.
 */
import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as motion from "motion/react-client";
import { DirectoryPanel, type DirEntry } from "./DirectoryPanel";
import { FileView, type FileTarget } from "./FileContent";
import { scrimVariants, overlayContentVariants } from "../motion/transitions";
import { AgentPresetIcon, type FlowNode, type NodeStatus } from "./WorkflowNode";
import "../styles/fileoverlay.css";

/** the open file plus the navigator state it was opened from (so the embedded explorer mounts in place). */
export interface OpenFile { file: FileTarget; path: DirEntry[]; fileId: string }

export interface FileExpandOverlayProps {
  open: OpenFile | null;
  run: string;
  /** the run's full file tree (same data the canvas navigator shows) — for the embedded explorer. */
  tree: DirEntry[];
  /** the graph nodes — provenance (producer / consumers) is derived from their reads/writes. */
  nodes: FlowNode[];
  /** a file leaf was chosen in the embedded explorer — switch the open file. */
  onSelectFile: (next: OpenFile) => void;
  /** a provenance chip was clicked — open that node's HUD (the overlay closes itself). */
  onOpenNode: (nodeId: string) => void;
  onClose: () => void;
}

interface NodeRef { id: string; title: string; status: NodeStatus; typeLabel: string; agentIcon?: string; agentColor?: string }

/** Derive which node PRODUCED the file (wrote/emitted it) and which nodes USED it (read it),
 *  by matching the file's run-relative displayPath against every node's reads/writes/artifacts. */
function provenanceOf(nodes: FlowNode[], displayPath: string): { producedBy: NodeRef | null; usedBy: NodeRef[] } {
  let producedBy: NodeRef | null = null;
  const usedBy: NodeRef[] = [];
  for (const n of nodes) {
    const rv = n.data.rv;
    if (!rv) continue;
    const ref: NodeRef = {
      id: n.id, title: n.data.title, status: n.data.status ?? "idle",
      typeLabel: n.data.agentLabel ?? n.data.typeLabel,
      agentIcon: n.data.agentIcon, agentColor: n.data.agentColor,
    };
    if (!producedBy && (rv.writes.some((w) => w.displayPath === displayPath) || rv.artifacts.some((a) => a.displayPath === displayPath)))
      producedBy = ref;
    if (rv.reads.some((r) => r.displayPath === displayPath)) usedBy.push(ref);
  }
  return { producedBy, usedBy };
}

/** a file leaf id (`f:<displayPath>`) → the OpenFile the overlay renders. The path is run-relative;
 *  the read-back endpoint resolves it under the run dir. */
export function openFileFor(entry: DirEntry, path: DirEntry[]): OpenFile {
  const displayPath = entry.id.startsWith("f:") ? entry.id.slice(2) : entry.id;
  return { file: { path: displayPath, displayPath }, path, fileId: entry.id };
}

export function FileExpandOverlay({ open, run, tree, nodes, onSelectFile, onOpenNode, onClose }: FileExpandOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const docRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Esc to close + focus management (mirror NodeExpandOverlay)
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => docRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      restoreFocusRef.current?.focus?.();
    };
  }, [open, onClose]);

  const prov = useMemo(
    () => (open ? provenanceOf(nodes, open.file.displayPath) : { producedBy: null, usedBy: [] }),
    [nodes, open],
  );

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="ds-scrim"
            variants={scrimVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={onClose}
          />
          {/* full-screen layer; clicks on the empty area fall through to the scrim (close).
              Only the explorer / provenance / doc capture pointer events. */}
          <motion.div
            className="ds-fileov"
            variants={overlayContentVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <div className="ds-fileov__rail">
              {/* EXPLORER (top-left): the SAME navigator, mounted pointing at the clicked leaf. Keyed by
                  the rail so it persists across in-overlay file switches (only a close+reopen remounts it). */}
              <div className="ds-fileov__explorer">
                <DirectoryPanel
                  tree={tree}
                  title="Run files"
                  initialPath={open.path}
                  initialFileId={open.fileId}
                  onOpenFile={(entry, path) => onSelectFile(openFileFor(entry, path))}
                />
              </div>
              {/* PROVENANCE (bottom-left): who made this file, who reads it. */}
              <Provenance producedBy={prov.producedBy} usedBy={prov.usedBy} onOpenNode={onOpenNode} />
            </div>

            {/* FILE (entire right): the real bytes, rendered BARE on the scrim via the shared FileView. */}
            <div className="ds-fileov__doc" role="dialog" aria-modal="true" aria-label={`${open.file.displayPath} content`} tabIndex={-1} ref={docRef}>
              <header className="ds-fileov__head">
                <span className="ds-fileov__path" title={open.file.displayPath}>{open.file.displayPath}</span>
                <button type="button" className="ds-fileov__close" onClick={onClose} aria-label="Close file">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
              </header>
              <div className="ds-fileov__scroll" key={open.file.path}>
                <FileView run={run} file={open.file} />
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/* Two floating columns of node-shaped cards: the file as one node's OUTPUT (produced by) and as other
   nodes' INPUT (used by). The cards reuse the canvas node grammar — right angles, beveled top-end corner,
   status-tinted border, hover corner-brackets — so they read as the same kit, not a foreign pill. */
function Provenance({ producedBy, usedBy, onOpenNode }: { producedBy: NodeRef | null; usedBy: NodeRef[]; onOpenNode: (id: string) => void }) {
  return (
    <div className="ds-prov">
      <div className="ds-prov__col">
        <div className="ds-prov__label">Produced by</div>
        {producedBy
          ? <NodeChip node={producedBy} onClick={onOpenNode} />
          : <span className="ds-prov__none">input · not written here</span>}
      </div>
      <div className="ds-prov__col">
        <div className="ds-prov__label">Used by{usedBy.length > 0 && <span className="ds-prov__count">{usedBy.length}</span>}</div>
        {usedBy.length
          ? usedBy.map((n) => <NodeChip key={n.id} node={n} onClick={onOpenNode} />)
          : <span className="ds-prov__none">read by no node</span>}
      </div>
    </div>
  );
}

function NodeChip({ node, onClick }: { node: NodeRef; onClick: (id: string) => void }) {
  const accent = node.agentColor ?? "var(--ds-node-agent)";
  return (
    <button type="button" className="ds-provnode" data-status={node.status} onClick={() => onClick(node.id)} title={`${node.title} · ${node.typeLabel}`}>
      <span className="ds-provnode__icon" style={{ color: accent }}><AgentPresetIcon icon={node.agentIcon} /></span>
      <span className="ds-provnode__title">{node.title}</span>
    </button>
  );
}
