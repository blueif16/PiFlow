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
import { DirectoryPanel, type DirEntry } from "./DirectoryPanel";
import { MenuBar } from "./MenuBar";
import { Companion } from "./Companion";
import { ExpandContext } from "./ExpandContext";
import { loadRunView, toFlowGraph, buildDirectory } from "../data/runView";
import { loadIndex, findThread, pickCurrentRun, type GlobalIndex } from "../data/runIndex";
import { useRunStream, liveFlowGraph, RunStreamContext } from "../data/runStream";

/* defined OUTSIDE the component — prevents node re-mounts on every render */
const nodeTypes = { flowNode: WorkflowNode };

function CanvasInner({ initialExpandedId }: { initialExpandedId?: string }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId ?? null);
  const [ix, setIx] = useState<GlobalIndex | null>(null);
  const [activeRun, setActiveRun] = useState<string>("");
  const [viewable, setViewable] = useState<boolean>(true);
  const [dir, setDir] = useState<{ tree: DirEntry[]; fileToNode: Record<string, string> }>({ tree: [], fileToNode: {} });
  const [loadError, setLoadError] = useState<string | null>(null);
  const { fitView } = useReactFlow();
  // ONE run-telemetry subscription for the active run — drives the LIVE graph (below) and is provided to
  // the Companion via RunStreamContext so it doesn't open a second EventSource.
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

  // Derive the focused run + its viewability from the (live) index: open on the REAL current run
  // (running > newest — no demo default), and keep viewability fresh as the active run's state changes.
  useEffect(() => {
    if (!ix) return;
    if (!activeRun) {
      const run = pickCurrentRun(ix);
      if (run) { setActiveRun(run); setViewable(findThread(ix, run)?.viewable ?? false); }
    } else {
      setViewable(findThread(ix, activeRun)?.viewable ?? false);
    }
  }, [ix, activeRun]);

  // Build the graph from the active run's real run-view — no mock seed. The canvas renders a transcoded
  // run-view.json (viewable runs only); a LIVE/foreign run has none yet, so we clear the graph and let
  // the companion stream it. Re-runs when the switcher picks a different run.
  useEffect(() => {
    if (!activeRun || !viewable) { setNodes([]); setEdges([]); setDir({ tree: [], fileToNode: {} }); return; }
    let alive = true;
    setLoadError(null);
    loadRunView(activeRun)
      .then((view) => {
        if (!alive) return;
        const { nodes: n, edges: e } = toFlowGraph(view);
        setNodes(n);
        setEdges(e);
        setDir(buildDirectory(view));
      })
      .catch((err) => { if (alive) setLoadError(String(err?.message ?? err)); });
    return () => { alive = false; };
  }, [activeRun, viewable, setNodes, setEdges]);

  // A LIVE / foreign run has no transcoded run-view.json — render it straight from the stream model, and
  // re-render as node-status deltas arrive. (Viewable runs are handled by the run-view effect above.)
  useEffect(() => {
    if (viewable || !activeRun) return;
    if (!live.model) { setNodes([]); setEdges([]); setDir({ tree: [], fileToNode: {} }); return; }
    // pass richByNode so a running node renders its LIVE-folded tokens/tools (the HUD's rv); re-runs
    // when richByNode updates (the throttled fold) so the numbers climb as the run streams.
    const { nodes: n, edges: e } = liveFlowGraph(live.model, live.richByNode);
    setNodes(n);
    setEdges(e);
  }, [viewable, activeRun, live.model, live.richByNode, setNodes, setEdges]);

  // switch the viewed run (from the menu-bar switcher): load it + close any open node
  const selectRun = useCallback((run: string) => {
    setActiveRun(run);
    setViewable(ix ? findThread(ix, run)?.viewable ?? false : false);
    setExpandedId(null);
  }, [ix]);

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

  const expandedData = nodes.find((n) => n.id === expandedId)?.data ?? null;

  return (
    <ExpandContext.Provider value={expandApi}>
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
              Couldn’t load run data — {loadError}. Run <code>npm run data</code> in <code>gui/</code>.
            </div>
          )}
          {activeRun && !viewable && !loadError && !live.model && (
            <div
              style={{
                position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 150,
                maxWidth: 420, padding: "16px 20px", borderRadius: 10, textAlign: "center",
                background: "var(--ds-glass-bg-strong, #fff)", boxShadow: "var(--ds-shadow-md)",
                fontFamily: "var(--ds-font-sans)", fontSize: 13, color: "var(--ds-text-secondary)", lineHeight: 1.5,
              }}
            >
              {live.status === "error"
                ? <>Couldn’t reach the live stream for <strong style={{ fontFamily: "var(--ds-font-mono)" }}>{activeRun}</strong>.</>
                : <>Connecting to <strong style={{ fontFamily: "var(--ds-font-mono)" }}>{activeRun}</strong> — live graph loading…</>}
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
                title="Run output"
                onOpenFile={(entry) => {
                  // entry.id is `f:<displayPath>` — open the node that produced this file
                  const producer = dir.fileToNode[entry.id.slice(2)];
                  if (producer) setExpandedId(producer);
                }}
              />
            </Panel>
          </ReactFlow>

          <NodeExpandOverlay id={expandedId} data={expandedData} onClose={() => setExpandedId(null)} />
          <MenuBar activeRun={activeRun} onSelectRun={selectRun} ix={ix} />
          <Companion activeRun={activeRun} />
        </div>
      </LayoutGroup>
      </RunStreamContext.Provider>
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
