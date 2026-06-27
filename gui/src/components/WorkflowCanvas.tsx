/**
 * WorkflowCanvas — the workspace shell that composes the whole system:
 *
 *   OrbField (background)  →  ReactFlow (light)  →  NodeExpandOverlay (portal)
 *   all wrapped in a single <LayoutGroup> so the node and the overlay share a
 *   layout context and the `layoutId` morph works across the portal boundary.
 *
 * DATA: there is no mock data here. The graph is built at mount from a real run's
 * distilled telemetry (gui/public/runs/<run>/run-view.json — see gui/scripts), so
 * every node/edge/HUD field traces back to a real pi run. Node positions come from
 * the run's stages (column) and parallel lanes (row); edges are real file-flow
 * dependencies (a producer's write read back by a consumer).
 *
 * Notes that matter:
 *   - `nodeTypes` is defined at module scope (React Flow re-render rule).
 *   - colorMode="light" — this system is light-first.
 *   - onNodeClick expands on a genuine click (React Flow filters out drags).
 *   - Import order: tokens.css first, then the React Flow stylesheet, then our
 *     glass.css overrides last so our node/handle styles win.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  type Connection,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import { LayoutGroup } from "motion/react";
import "@xyflow/react/dist/style.css";

import "../../tokens/tokens.css";
import "../styles/glass.css";
import "../styles/panels.css";

import { OrbField } from "./OrbField";
import { WorkflowNode, type FlowNode } from "./WorkflowNode";
import { NodeExpandOverlay } from "./NodeExpandOverlay";
import { FileExpandOverlay, openFileFor, type OpenFile } from "./FileExpandOverlay";
import { DirectoryPanel, type DirEntry } from "./DirectoryPanel";
import { MenuBar } from "./MenuBar";
import { ModeBar } from "./ModeBar";
import { Companion } from "./Companion";
import { ExpandContext } from "./ExpandContext";
import { ViewModeContext, type ViewMode } from "./ViewModeContext";
import { FusionContext, type FusionMode } from "./FusionContext";
import { FusionSaveBar } from "./FusionSaveBar";
import { loadRunView, loadPreview, saveRunFusion, loadRunTree, toFlowGraph, buildDirectory, loadAgentCatalog } from "../data/runView";
import { loadIndex, pickCurrentRun, type GlobalIndex } from "../data/runIndex";
import { useRunStream, RunStreamContext } from "../data/runStream";

/* defined OUTSIDE the component — prevents node re-mounts on every render */
const nodeTypes = { flowNode: WorkflowNode };

function CanvasInner({ initialExpandedId }: { initialExpandedId?: string }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId ?? null);
  // the file opened from the navigator — shown in the standalone file overlay (null = closed).
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [mode, setMode] = useState<ViewMode | null>(null);
  // (Fusion mode) per-node fusion overrides — `{ nodeId: "moa" | "best-of-n" }`. When non-empty the canvas
  // renders the SDK-expanded PREVIEW (via /__piflow/preview) instead of the live run-view; empty ⇒ run-view.
  const [fusionOverrides, setFusionOverrides] = useState<Record<string, FusionMode>>({});
  const [companionOpen, setCompanionOpen] = useState(false); // bottom-right pi chat; launched by the "P" key

  const [ix, setIx] = useState<GlobalIndex | null>(null);
  const [activeRun, setActiveRun] = useState<string>("");
  const [dir, setDir] = useState<{ tree: DirEntry[]; fileToNode: Record<string, string> }>({ tree: [], fileToNode: {} });
  const [loadError, setLoadError] = useState<string | null>(null);
  const { fitView } = useReactFlow();
  // ONE run-telemetry subscription for the active run — provided to the Companion via RunStreamContext so
  // it doesn't open a second EventSource. The CANVAS itself renders from the distilled run-view (below).
  const live = useRunStream(activeRun);

  // LIVE-poll the global index (every 4s) so runs that start / progress after launch appear without a
  // manual re-index. CanvasInner is the single owner; MenuBar reads `ix` as a prop.
  useEffect(() => {
    let alive = true;
    let everLoaded = false;
    const refresh = async () => {
      try {
        const index = await loadIndex();
        if (!alive) return;
        everLoaded = true;
        setIx(index);
      } catch (err) {
        if (alive && !everLoaded) setLoadError(String((err as Error)?.message ?? err));
      }
    };
    refresh();
    const id = setInterval(refresh, 4000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Pick the focused run from the (live) index on first load: the REAL current run (running > newest —
  // no demo default). Once chosen, the user drives it via the switcher.
  useEffect(() => {
    if (!ix || activeRun) return;
    const run = pickCurrentRun(ix);
    if (run) setActiveRun(run);
  }, [ix, activeRun]);

  // ONE graph path for EVERY run: distill the run's real `.pi/` via the run-view endpoint (live,
  // historical, or foreign alike). While the run is still going, re-poll so status + telemetry stay
  // fresh; a finished run loads once. Re-runs when the switcher picks a different run.
  useEffect(() => {
    if (!activeRun) { setNodes([]); setEdges([]); setDir({ tree: [], fileToNode: {} }); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // (Fusion mode) any override ⇒ render the SDK-expanded PREVIEW of the run's template; else the run-view.
    // The preview is STATIC (no live run), so it never polls.
    const preview = Object.keys(fusionOverrides).length > 0;
    const load = async () => {
      try {
        const [view, agents] = await Promise.all([
          preview ? loadPreview(activeRun, fusionOverrides) : loadRunView(activeRun),
          loadAgentCatalog(),
        ]);
        if (!alive) return;
        setLoadError(null);
        const { nodes: n, edges: e } = toFlowGraph(view, agents); // (G6) resolve preset icons by agentType
        setNodes(n);
        setEdges(e);
        // The navigator shows the run's FULL on-disk tree (rooted at {{RUN}}); `fileToNode` still comes
        // from the run-view so clicking a produced file opens its node. Fall back to the produced-files
        // tree if the fs endpoint is unavailable. (A preview produces no files ⇒ its tree is empty.)
        const { tree: producedTree, fileToNode } = buildDirectory(view);
        let tree = producedTree;
        try { const fsTree = await loadRunTree(activeRun); if (alive && fsTree.length) tree = fsTree; } catch { /* keep producedTree */ }
        if (!alive) return;
        setDir({ tree, fileToNode });
        if (!preview && !view.done) timer = setTimeout(load, 3000); // poll a live run; a preview is static
      } catch (err) {
        if (!alive) return;
        setLoadError(String((err as Error)?.message ?? err));
        if (!preview) timer = setTimeout(load, 3000); // a just-started run may not be distillable yet — retry
      }
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [activeRun, fusionOverrides, setNodes, setEdges]);

  // switch the viewed run (from the menu-bar switcher): load it + close any open node / file
  const selectRun = useCallback((run: string) => {
    setActiveRun(run);
    setExpandedId(null);
    setOpenFile(null);
  }, []);

  // refit the viewport once the real nodes land
  useEffect(() => {
    if (nodes.length) requestAnimationFrame(() => fitView({ padding: 0.25, duration: 320 }));
  }, [nodes.length, fitView]);

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge(c, eds)), [setEdges]);
  const onNodeClick: NodeMouseHandler = useCallback((_, node) => setExpandedId(node.id), []);

  const expandApi = useMemo(
    () => ({ expandedId, expand: setExpandedId, collapse: () => setExpandedId(null) }),
    [expandedId],
  );

  const viewModeApi = useMemo(
    () => ({ mode, setMode, toggle: (m: ViewMode) => setMode((cur) => (cur === m ? null : m)) }),
    [mode],
  );

  // (Fusion mode) toggle a node's override: set node→mode, or clear it if it's already that mode.
  const toggleFusion = useCallback((nodeId: string, m: FusionMode) => {
    setFusionOverrides((prev) => {
      const next = { ...prev };
      if (next[nodeId] === m) delete next[nodeId];
      else next[nodeId] = m;
      return next;
    });
  }, []);
  // (Fusion mode) BAKE the current overrides into THIS run's structure (NOT the template). On success the
  // edits are persisted into the run dir, so we clear them ⇒ the saved structure becomes the run-view base.
  const saveFusion = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!activeRun || !Object.keys(fusionOverrides).length) return { ok: false, error: "nothing to save" };
    const r = await saveRunFusion(activeRun, fusionOverrides);
    if (r.ok) setFusionOverrides({});
    return r;
  }, [activeRun, fusionOverrides]);
  const fusionApi = useMemo(
    () => ({ overrides: fusionOverrides, toggle: toggleFusion, save: saveFusion }),
    [fusionOverrides, toggleFusion, saveFusion],
  );

  // Leaving Fusion mode drops every override ⇒ the canvas falls back to the live run-view.
  useEffect(() => { if (mode !== "fusion") setFusionOverrides((o) => (Object.keys(o).length ? {} : o)); }, [mode]);

  const expandedData = nodes.find((n) => n.id === expandedId)?.data ?? null;

  return (
    <ExpandContext.Provider value={expandApi}>
      <ViewModeContext.Provider value={viewModeApi}>
      <FusionContext.Provider value={fusionApi}>
      <RunStreamContext.Provider value={live}>
      <LayoutGroup>
        <div style={{ position: "relative", width: "100%", height: "100%", background: "var(--ds-bg-canvas)" }}>
          <OrbField />
          {loadError && (
            <div
              role="alert"
              style={{
                position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 200,
                padding: "10px 14px", borderRadius: 8, fontSize: 13, fontFamily: "var(--ds-font-mono)",
                background: "var(--ds-glass-bg-strong, #fff)", color: "var(--ds-error-fg, #c1262b)",
                boxShadow: "var(--ds-shadow-md)",
              }}
            >
              Couldn’t load run data — {loadError}. Ensure <code>@piflow/core</code> is built (<code>npm run build</code> at the repo root).
            </div>
          )}
          {activeRun && !loadError && nodes.length === 0 && (
            <div
              style={{
                position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 150,
                maxWidth: 420, padding: "16px 20px", borderRadius: 10, textAlign: "center",
                background: "var(--ds-glass-bg-strong, #fff)", boxShadow: "var(--ds-shadow-md)",
                fontFamily: "var(--ds-font-sans)", fontSize: 13, color: "var(--ds-text-secondary)", lineHeight: 1.5,
              }}
            >
              Loading <strong style={{ fontFamily: "var(--ds-font-mono)" }}>{activeRun}</strong> — distilling its run telemetry…
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            colorMode="light"
            fitView
            onlyRenderVisibleElements
            minZoom={0.3}
            proOptions={{ hideAttribution: false }}
            style={{ background: "transparent" }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--ds-neutral-300)" />
            <Controls showInteractive={false} />
            <Panel position="top-left">
              <DirectoryPanel
                tree={dir.tree}
                title="Run files"
                // Open the file itself in the standalone overlay (its content on the right, its
                // producer/consumer nodes in the provenance rail) — reachable from there.
                onOpenFile={(entry, path) => setOpenFile(openFileFor(entry, path))}
              />
            </Panel>
          </ReactFlow>

          <NodeExpandOverlay id={expandedId} data={expandedData} run={activeRun} onClose={() => setExpandedId(null)} />
          <FileExpandOverlay
            open={openFile}
            run={activeRun}
            tree={dir.tree}
            nodes={nodes}
            onSelectFile={setOpenFile}
            onOpenNode={(nodeId) => { setOpenFile(null); setExpandedId(nodeId); }}
            onClose={() => setOpenFile(null)}
          />
          <MenuBar activeRun={activeRun} onSelectRun={selectRun} ix={ix} />
          <ModeBar chatOpen={companionOpen} onToggleChat={() => setCompanionOpen((o) => !o)} />
          <FusionSaveBar active={mode === "fusion"} />
          <Companion activeRun={activeRun} open={companionOpen} onOpenChange={setCompanionOpen} />
        </div>
      </LayoutGroup>
      </RunStreamContext.Provider>
      </FusionContext.Provider>
      </ViewModeContext.Provider>
    </ExpandContext.Provider>
  );
}

export function WorkflowCanvas({ initialExpandedId }: { initialExpandedId?: string } = {}) {
  return (
    <ReactFlowProvider>
      <CanvasInner initialExpandedId={initialExpandedId} />
    </ReactFlowProvider>
  );
}
