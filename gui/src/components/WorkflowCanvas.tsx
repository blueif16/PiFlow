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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ZoneNode } from "./ZoneNode";
import { NodeExpandOverlay } from "./NodeExpandOverlay";
import { FileExpandOverlay, openFileFor, type OpenFile } from "./FileExpandOverlay";
import { DirectoryPanel, type DirEntry } from "./DirectoryPanel";
import { MenuBar } from "./MenuBar";
import { WorkspaceLauncher } from "./WorkspaceLauncher";
import { ControlPlaneChip, type ControlHealth } from "./ControlPlaneChip";
import { ModeBar } from "./ModeBar";
import { Companion } from "./Companion";
import { RunDigestPanel } from "./RunDigestPanel";
import { RunIssuesPanel } from "./RunIssuesPanel";
import { StartRunPanel } from "./StartRunPanel";
import { MigrateRunPanel } from "./MigrateRunPanel";
import { ExpandContext } from "./ExpandContext";
import { ViewModeContext, type ViewMode } from "./ViewModeContext";
import { FusionContext, type FusionMode } from "./FusionContext";
import { FusionSaveBar } from "./FusionSaveBar";
import { ComposeContext } from "./ComposeContext";
import { CardMenuContext } from "./CardMenuContext";
import { BasisContext } from "./BasisContext";
import { MarketContext } from "./MarketContext";
import { SkillContext } from "./SkillContext";
import { SkillPanel } from "./SkillPanel";
import { SkillMarketPanel } from "./SkillMarketPanel";
import { SkillDropCard, type SkillCardTarget } from "./SkillDropCard";
import { RemoteSkillContext } from "./RemoteSkillContext";
import { RemoteSkillPanel } from "./RemoteSkillPanel";
import type { RemoteSkill } from "../data/runView";
import { GateRail } from "./GateRail";
import { GateDropCard, type DropCardTarget } from "./GateDropCard";
import { AgentRail } from "./AgentRail";
import { AgentDropCard, type AgentCardTarget } from "./AgentDropCard";
import { loadRunView, loadPreview, saveRunFusion, loadRunTree, toFlowGraph, buildDirectory, liveModelToRunView, runViewToLiveModel, digestLiveSig, loadAgentCatalog, loadNodeConfig, dropChipOnNode, type GateChip, type AuthoredNodeConfig, type AgentCatalog } from "../data/runView";
import type { AgentChip } from "../data/agentChips";
import type { SkillChip } from "../data/skillChips";
import type { RailKind } from "../data/gates";
import { deriveZones, toZoneFlowNode, type ZoneFlowNode } from "../data/zones";
import { loadIndex, pickCurrentRun, pickRunForWorkspace, workspaceOfRun, homeWorkspace, homeRoots, type GlobalIndex } from "../data/runIndex";
import { useRunStream, RunStreamContext } from "../data/runStream";
import { liveSource, shadowDiffEnabled } from "../data/liveSource";
import { shadowDiff } from "../data/shadowDiff";
import { setEndpoint, useEndpoint } from "../data/apiBase";

/* defined OUTSIDE the component — prevents node re-mounts on every render */
const nodeTypes = { flowNode: WorkflowNode, zone: ZoneNode };

/* the canvas holds real cards AND backdrop zone nodes in one flat array (zones recompute each poll). */
type CanvasNode = FlowNode | ZoneFlowNode;
/* a backdrop zone is non-selectable, so it never becomes the expanded node nor a file-provenance source —
   the card-only consumers (HUD, file overlay) read this narrowed set. */
const isFlowNode = (n: CanvasNode): n is FlowNode => n.type === "flowNode";

function CanvasInner({ initialExpandedId }: { initialExpandedId?: string }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId ?? null);
  // the file opened from the navigator — shown in the standalone file overlay (null = closed).
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [mode, setMode] = useState<ViewMode | null>(null);
  // (Fusion mode) per-node fusion overrides — `{ nodeId: "moa" | "best-of-n" }`. When non-empty the canvas
  // renders the SDK-expanded PREVIEW (via /__piflow/preview) instead of the live run-view; empty ⇒ run-view.
  const [fusionOverrides, setFusionOverrides] = useState<Record<string, FusionMode>>({});
  // (Compose mode · SA-E) per-node AUTHORED config from the TEMPLATE (op[]/checkpoint/tier) — the gate-
  // pipeline badge's source of truth (the run-view distillation does NOT carry the template op[]). Loaded
  // lazily when Compose mode opens; refreshed for a single node after a chip drops.
  const [nodeConfigs, setNodeConfigs] = useState<Record<string, AuthoredNodeConfig>>({});
  // (Compose mode) the open drop card — a rail gate dropped on a node opens the natural-language card at it;
  // "Create gate" writes the template. Null = no card open.
  const [dropCard, setDropCard] = useState<DropCardTarget | null>(null);
  // (Compose · Slice 2) the node whose compose AGENT session is mid-wire — the target renders a pending hex
  // while composing; it solidifies from the run-view re-read once the gate lands. Null when idle.
  const [composingNodeId, setComposingNodeId] = useState<string | null>(null);
  // (Basis mode · P1) the open base-agent reassign card — an AgentRail avatar dropped on a node's basis
  // slot opens the confirm card at it; "Set base agent" writes the template. Null = no card open.
  const [agentCard, setAgentCard] = useState<AgentCardTarget | null>(null);
  // (Slice 1.5) bumped after a RUN-first gate bake so the run-view re-loads even for a DONE run (whose poll
  // has stopped) — the newly-applied gate then appears on the graph without a manual reload.
  const [runViewNonce, setRunViewNonce] = useState(0);
  const [openSkill, setOpenSkill] = useState<string | null>(null); // the skill id shown in the left SkillPanel (null = closed)
  const [runIssuesOpen, setRunIssuesOpen] = useState(false); // (M8) right-dock run-LEVEL issues card (all nodes, grouped) — the "I" key
  const [focusIssue, setFocusIssue] = useState<{ node: string; issueId: string } | null>(null); // set when the run card jumps to a node's HUD issues-mode
  const [openRemote, setOpenRemote] = useState<RemoteSkill | null>(null); // the ONLINE row shown in the RemoteSkillPanel
  const [installedNonce, setInstalledNonce] = useState(0); // bumped on a successful install → marketplace re-fetches
  const [companionOpen, setCompanionOpen] = useState(false); // bottom-right pi chat; launched by the "P" key
  const [digestOpen, setDigestOpen] = useState(false); // left-edge run digest; launched by the "D" key
  const [marketOpen, setMarketOpen] = useState(false); // left-edge skill marketplace; launched by the "S" key
  // (P2 skill marketplace) the open skill-loadout confirm card — a skill dragged from the panel onto a node's
  // skill slot opens it; "Apply to this run" bakes run-first, then offers a template promote. Null = no card.
  const [skillCard, setSkillCard] = useState<SkillCardTarget | null>(null);
  const [startOpen, setStartOpen] = useState(false); // the "Start a run" launcher modal (from the MenuBar)
  const [migrateOpen, setMigrateOpen] = useState(false); // the "Migrate run" modal (from the MenuBar)
  // The live control-plane endpoint. When a migrate re-points it (setEndpoint), this baseUrl changes and the
  // index poll + run-view loader below re-run against the new origin (they list it in their deps).
  const endpointBase = useEndpoint().baseUrl;

  // ── RIGHT-edge SINGLE SLOT ─────────────────────────────────────────────────────────────────────────────
  // Chat + the viewer cards (digest / skill / remote-skill / market) are mutually exclusive: only one
  // right-dock panel shows at a time, so opening one CLOSES the rest — a new card REPLACES the prior, never a
  // stack. `keep` is the slot being opened; every other occupant is cleared.
  const closeRightSlot = useCallback((keep?: "chat" | "digest" | "skill" | "remote" | "market" | "issues") => {
    if (keep !== "chat") setCompanionOpen(false);
    if (keep !== "digest") setDigestOpen(false);
    if (keep !== "skill") setOpenSkill(null);
    if (keep !== "remote") setOpenRemote(null);
    if (keep !== "market") setMarketOpen(false);
    if (keep !== "issues") setRunIssuesOpen(false);
  }, []);
  const setChatOpen = useCallback((o: boolean) => { if (o) closeRightSlot("chat"); setCompanionOpen(o); }, [closeRightSlot]);
  const toggleChat = useCallback(() => setChatOpen(!companionOpen), [setChatOpen, companionOpen]);
  const toggleDigest = useCallback(() => { if (!digestOpen) closeRightSlot("digest"); setDigestOpen(!digestOpen); }, [digestOpen, closeRightSlot]);
  const toggleMarket = useCallback(() => { if (!marketOpen) closeRightSlot("market"); setMarketOpen(!marketOpen); }, [marketOpen, closeRightSlot]);
  const toggleIssues = useCallback(() => { if (!runIssuesOpen) closeRightSlot("issues"); setRunIssuesOpen(!runIssuesOpen); }, [runIssuesOpen, closeRightSlot]);
  // any right-dock card open (chat now floats too) ⇒ the top-right MenuBar HIDES so it never clashes with the
  // card; the open card hosts a menu handle (CardMenuContext) that PEEKS the bar back over the card on click.
  const cardOpen = digestOpen || !!openSkill || !!openRemote || marketOpen || companionOpen || runIssuesOpen;
  const [menuPeek, setMenuPeek] = useState(false);
  useEffect(() => { if (!cardOpen) setMenuPeek(false); }, [cardOpen]); // reset the peek once no card is open
  const cardMenu = useMemo(() => ({ onOpenMenu: () => setMenuPeek(true) }), []);

  const [ix, setIx] = useState<GlobalIndex | null>(null);
  // control-plane liveness for the ControlPlaneChip dot — driven by the index poll below (ok on a successful
  // fetch, error on a failed one, connecting until the first result). A pure health signal, not a data input.
  const [controlHealth, setControlHealth] = useState<ControlHealth>("connecting");
  const [activeRun, setActiveRun] = useState<string>("");
  // (Workspace switch) the entered folder = a `product` in the index. It sits ABOVE activeRun: entering a
  // workspace re-scopes the run set (+ the pi session). Null until the first-focus effect seeds it. The
  // launcher (full-screen) toggles via `workspaceOpen`; `lastRunByWorkspace` restores where you were on re-entry.
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const lastRunByWorkspace = useRef<Record<string, string>>({});
  const home = useMemo(() => homeRoots(), []); // the launched folder(s) — read once for the initial-focus bias
  const [dir, setDir] = useState<{ tree: DirEntry[]; fileToNode: Record<string, string> }>({ tree: [], fileToNode: {} });
  // (P3) the G6 agent-preset catalog for the SSE render path — fetched once per run (it is ~static), so the
  // enriched-live re-render doesn't re-hit /agents.json on every token delta. The poll path fetches it inline.
  const [agentCatalog, setAgentCatalog] = useState<AgentCatalog>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const rf = useReactFlow();
  const { fitView } = rf;
  // ONE run-telemetry subscription for the active run — provided to the Companion via RunStreamContext so
  // it doesn't open a second EventSource. The CANVAS renders EITHER from the distilled run-view poll (default)
  // OR from this enriched live model, gated by the client transport flag (docs/design P3).
  const live = useRunStream(activeRun);

  // The top-left directory navigator floats over the canvas and fitView can't reserve screen space
  // for it (px/% padding resolves in FLOW coordinates in this @xyflow version — verified empirically).
  // So after a fit settles, MEASURE the panel and pan the viewport right just enough that no node in
  // its vertical band sits under it. Pan only — never zoom. Chained onto the refit below.
  const nudgeClearOfDir = useCallback(() => {
    const dirEl = document.querySelector(".ds-dir");
    if (!dirEl) return;
    const r = dirEl.getBoundingClientRect();
    const { x, y, zoom } = rf.getViewport();
    let minScreenX = Infinity;
    for (const n of rf.getNodes()) {
      const sy = n.position.y * zoom + y;
      const sh = (n.measured?.height ?? 0) * zoom;
      if (sy > r.bottom + 12 || sy + sh < r.top) continue;
      minScreenX = Math.min(minScreenX, n.position.x * zoom + x);
    }
    const need = r.right + 16 - minScreenX;
    if (Number.isFinite(minScreenX) && need > 0) rf.setViewport({ x: x + need, y, zoom });
  }, [rf]);

  // (P3) The CLIENT transport flag — read once per session (URL `?live=` / build default). 'poll' (default)
  // keeps today's 3 s /run-view re-poll VERBATIM; 'sse' renders the graph from the enriched live.model.
  const useSse = liveSource() === "sse";
  // (Fusion mode) any override ⇒ render the SDK-expanded PREVIEW of the run's template; else the run-view/live.
  const preview = Object.keys(fusionOverrides).length > 0;
  // SSE drives the graph only for a LIVE run that is actually streaming a model: not preview, flag on, the
  // stream `live` (not done/foreign/errored), and a snapshot has arrived. On SSE failure (`error`, no model)
  // or once the run is `done`, this is false → the poll path (below) takes over — the safety-valve degrade.
  const sseLive = useSse && !preview && live.status === "live" && !!live.model;

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
        setControlHealth("ok"); // the control plane answered → the dot is green
      } catch (err) {
        if (!alive) return;
        setControlHealth("error"); // poll failed → the dot is red (a live liveness signal, not just first-load)
        if (!everLoaded) setLoadError(String((err as Error)?.message ?? err));
      }
    };
    refresh();
    const id = setInterval(refresh, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [endpointBase]);

  // Pick the focused workspace + run on first load. Bias to the launched "home" folder (VITE_PIFLOW_HOME_ROOTS)
  // so widening the served scope to every registered folder doesn't hijack focus to another folder's run: if the
  // home folder has a run, focus it; else fall back to the global running/newest run (and adopt its folder). Once
  // chosen, the user drives it via the launcher (folder) + the run switcher.
  useEffect(() => {
    if (!ix || activeRun || activeWorkspace) return;
    const homeWs = homeWorkspace(ix, home);
    const homeRun = homeWs ? pickRunForWorkspace(ix, homeWs) : null;
    const run = homeRun ?? pickCurrentRun(ix);
    const ws = homeRun ? homeWs : run ? workspaceOfRun(ix, run) : homeWs;
    if (ws) setActiveWorkspace(ws);
    if (run) setActiveRun(run);
  }, [ix, activeRun, activeWorkspace, home]);

  // Keep the workspace tier in sync with the run + remember the last run per folder (so re-entering a workspace
  // restores where you were). Also adopts the folder when a run is picked directly from the run switcher (which
  // lists every folder's runs), keeping the MenuBar workspace pill honest.
  useEffect(() => {
    if (!ix || !activeRun) return;
    const ws = workspaceOfRun(ix, activeRun);
    if (!ws) return;
    lastRunByWorkspace.current[ws] = activeRun;
    if (ws !== activeWorkspace) setActiveWorkspace(ws);
  }, [ix, activeRun, activeWorkspace]);

  // ONE graph path for EVERY run: distill the run's real `.pi/` via the run-view endpoint (live,
  // historical, or foreign alike). While the run is still going, re-poll so status + telemetry stay
  // fresh; a finished run loads once. Re-runs when the switcher picks a different run.
  //
  // (P3) When `sseLive` — the client flag is 'sse' AND this run is streaming a live model — the enriched-live
  // effect below drives the graph instead, so this poll SKIPS (no 3 s re-poll). The flag defaults to 'poll',
  // and on any SSE failure/finish `sseLive` flips false → this poll takes over VERBATIM (the degrade path).
  useEffect(() => {
    if (!activeRun) { setNodes([]); setEdges([]); setDir({ tree: [], fileToNode: {} }); return; }
    if (sseLive) return; // (P3) the enriched-live effect owns the graph — don't poll or re-arm
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const [view, agents] = await Promise.all([
          preview ? loadPreview(activeRun, fusionOverrides) : loadRunView(activeRun),
          loadAgentCatalog(),
        ]);
        if (!alive) return;
        setLoadError(null);
        setAgentCatalog(agents); // keep the held catalog fresh on the poll path too (AgentRail reads it)
        const { nodes: n, edges: e } = toFlowGraph(view, agents); // (G6) resolve preset icons by agentType
        // Prepend the derived backdrop zones (fusion clusters; template frame is dormant) — they're flat
        // nodes recomputed each poll, painted UNDER the cards via their negative zIndex. Same RunView shape
        // for the live run AND the fusion preview, so frames appear in preview automatically.
        setNodes([...deriveZones(view).map(toZoneFlowNode), ...n]);
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
    // `runViewNonce` forces a one-off re-load after a run-first gate bake (a DONE run's poll has stopped).
  }, [activeRun, fusionOverrides, sseLive, setNodes, setEdges, endpointBase, runViewNonce]);

  // ── (P3) Enriched-live render path — active only when `sseLive` (flag 'sse' + a live streaming run) ────────
  // The graph is built from the SSE-enriched `live.model` (adapter → toFlowGraph); the GUI computes nothing.
  // The 3 s /run-view re-poll above is SKIPPED. Zones/positions come from the same RunView shape, so the canvas
  // is identical to the poll path — only the transport differs.
  const liveModel = live.model;
  // (P5) The digest-refetch trigger for RunDigestPanel: non-null under SSE (a status/billable-bucket delta drives
  // an event-driven refetch), null in poll-mode (the panel keeps its 3 s fallback). The panel never computes the
  // digest — this only decides WHEN it refetches the server projection.
  const digestSig = digestLiveSig(sseLive, liveModel);
  // Fetch the ~static agent-preset catalog once when the sse path first drives this run (not per token delta).
  useEffect(() => {
    if (!sseLive) return;
    let alive = true;
    loadAgentCatalog().then((c) => { if (alive) setAgentCatalog(c); }).catch(() => { /* {} → default chips */ });
    return () => { alive = false; };
  }, [sseLive, activeRun, endpointBase]);

  // Re-render the graph from the enriched live model on every fold change (snapshot / node-status / node-enriched
  // all mutate `live.model`'s reference). PURE: adapter → toFlowGraph, no network, no re-derive.
  useEffect(() => {
    if (!sseLive || !liveModel) return;
    setLoadError(null);
    const view = liveModelToRunView(liveModel);
    const { nodes: n, edges: e } = toFlowGraph(view, agentCatalog);
    setNodes([...deriveZones(view).map(toZoneFlowNode), ...n]);
    setEdges(e);
  }, [sseLive, liveModel, agentCatalog, setNodes, setEdges]);

  // ── (P4) DEV-ONLY shadow-diff parity gate — a PURE side-observer, NEVER a render input ──────────────────────
  // Armed only in a dev build with `?shadow=1` (shadowDiffEnabled) AND while the SSE path drives the graph
  // (`sseLive` + a live model). It ALSO fetches the authoritative /run-view and deep-compares the SSE-rendered
  // graph against it over the full field key (docs/design/observe-live-sse-single-source.md DR7/§11), console-
  // warning each divergence and console.info'ing once when they agree. It touches NO render state (no
  // setNodes/setEdges/setDir, no flag) — it is the human's proof that SSE≡/run-view before the cutover.
  useEffect(() => {
    if (!shadowDiffEnabled() || !sseLive || !liveModel) return;
    let alive = true;
    (async () => {
      try {
        const pollView = await loadRunView(activeRun);
        if (!alive) return;
        const divs = shadowDiff(liveModelToRunView(liveModel), pollView);
        if (divs.length === 0) {
          console.info("[shadow] SSE≡/run-view ✓");
        } else {
          for (const d of divs) {
            console.warn(`[shadow] divergence — ${d.scope}${d.id ? `#${d.id}` : ""}.${d.field}`, { sse: d.sse, poll: d.poll });
          }
        }
      } catch {
        /* the parity fetch is best-effort; a failed /run-view load must not disturb the render */
      }
    })();
    return () => { alive = false; };
  }, [sseLive, liveModel, activeRun, endpointBase]);

  // Keep the file tree/dir fresh WITHOUT the telemetry replay (DR5): refetch only when a node's STATUS changes
  // (a node finishing is when files land) — not on every token delta. The status signature gates the refetch.
  const statusSig = (liveModel?.nodes ?? []).map((x) => `${x.id}:${x.status}`).join("|");
  useEffect(() => {
    if (!sseLive || !liveModel) return;
    let alive = true;
    // `fileToNode` comes from the live model's produced-files (writes/artifacts); the tree prefers the real fs
    // walk, falling back to that produced set — same as the poll path's directory build.
    const { tree: producedTree, fileToNode } = buildDirectory(liveModelToRunView(liveModel));
    (async () => {
      let tree = producedTree;
      try { const fsTree = await loadRunTree(activeRun); if (alive && fsTree.length) tree = fsTree; } catch { /* keep producedTree */ }
      if (!alive) return;
      setDir({ tree, fileToNode });
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch keyed on status change, not every fold
  }, [sseLive, activeRun, statusSig, endpointBase]);

  // ── (DR6) Reconcile net — heal drift after a backgrounded / throttled tab ────────────────────────────────────
  // A backgrounded tab throttles (or silently stalls) SSE delivery, so on return to the foreground the live model
  // may be BEHIND the run. On `visibilitychange` → visible, fetch the authoritative /run-view ONCE and MODEL-REPLACE
  // the live model with it (`live.reconcile` → the same snapshot-replace merge path) so the graph re-bases to
  // ground truth. Active only under the SSE path; best-effort — a failed fetch never disturbs the live stream, and
  // on SSE failure/done `sseLive` is false so the poll path (which already re-polls) owns the graph. A dropped
  // stream self-heals separately (EventSource auto-reconnects → the server re-sends a fresh snapshot). A slow ≥30 s
  // safety poll is the next lever if a FOREGROUND tab is ever seen to silently stall; omitted to preserve P5's
  // zero-fetch-when-idle property.
  const reconcile = live.reconcile;
  useEffect(() => {
    if (!sseLive || !activeRun) return;
    let alive = true;
    const resync = async () => {
      if (document.visibilityState !== "visible") return; // fire only on becoming visible, never on hide
      try {
        const view = await loadRunView(activeRun);
        if (alive) reconcile(runViewToLiveModel(view));
      } catch { /* best-effort — the SSE stream stays the source of truth */ }
    };
    document.addEventListener("visibilitychange", resync);
    return () => { alive = false; document.removeEventListener("visibilitychange", resync); };
  }, [sseLive, activeRun, reconcile, endpointBase]);

  // switch the viewed run (from the menu-bar switcher): load it + close any open node / file
  const selectRun = useCallback((run: string) => {
    setActiveRun(run);
    setExpandedId(null);
    setOpenFile(null);
  }, []);

  // (Workspace switch) ENTER a folder → re-scope to it. Prefer the last run viewed there (if still in the index),
  // else the folder's current run (running > newest); an empty folder clears the canvas. selectRun re-points the
  // run-view poll / SSE / companion (all keyed on activeRun) to the new folder's run.
  const enterWorkspace = useCallback((productId: string) => {
    if (!ix) return;
    setActiveWorkspace(productId);
    const remembered = lastRunByWorkspace.current[productId];
    const restore = remembered && workspaceOfRun(ix, remembered) === productId ? remembered : null;
    selectRun(restore ?? pickRunForWorkspace(ix, productId) ?? "");
  }, [ix, selectRun]);

  // migrate done → re-point the whole console to the target serve (baseUrl + token) and follow the run to its
  // new home. setEndpoint drives the index poll / run-view loader / stream hooks to reconnect (endpointBase deps);
  // the run-view loader already retries, so it picks the run up once the target has adopted + resumed it.
  const onMigrated = useCallback((tgt: { baseUrl: string; token: string }, run: string) => {
    setEndpoint(tgt);
    selectRun(run);
  }, [selectRun]);

  // refit the viewport once the real nodes land; when the animated fit completes, nudge the graph
  // clear of the directory navigator (a pan mid-animation would be overwritten by its later frames)
  useEffect(() => {
    if (nodes.length) requestAnimationFrame(() => { void fitView({ padding: 0.25, duration: 320 }).then(nudgeClearOfDir); });
  }, [nodes.length, fitView, nudgeClearOfDir]);

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge(c, eds)), [setEdges]);
  const onNodeClick: NodeMouseHandler = useCallback((_, node) => { setExpandedId(node.id); setFocusIssue(null); }, []);

  const expandApi = useMemo(
    () => ({ expandedId, expand: setExpandedId, collapse: () => setExpandedId(null) }),
    [expandedId],
  );

  // (Skill panel) which skill the left inspector shows — a skill chip anywhere calls openSkill(id). Opening the
  // LOCAL inspector closes the online detail (both are left-anchored — only one shows at a time).
  const skillApi = useMemo(
    () => ({ open: openSkill, openSkill: (s: string) => { closeRightSlot("skill"); setOpenSkill(s); }, close: () => setOpenSkill(null) }),
    [openSkill, closeRightSlot],
  );
  // (Remote skill panel) the ONLINE detail inspector — a remote marketplace card calls openRemote(row). Opening
  // it closes the local inspector; installedNonce bumps on a successful install so SkillMarketPanel re-fetches.
  const remoteSkillApi = useMemo(
    () => ({
      open: openRemote,
      openRemote: (row: RemoteSkill) => { closeRightSlot("remote"); setOpenRemote(row); },
      close: () => setOpenRemote(null),
      installedNonce,
      bumpInstalled: () => setInstalledNonce((n) => n + 1),
    }),
    [openRemote, installedNonce, closeRightSlot],
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

  // card-only nodes — the backdrop zones carry no config/provenance, so every card-only consumer (compose
  // config fetch, file overlay) reads this narrowed set, never the flat array that also holds zone nodes.
  // MEMOized so its identity is stable across renders — the compose effect below depends on it.
  const flowNodes = useMemo(() => nodes.filter(isFlowNode), [nodes]);

  // (Compose mode · SA-E) When Compose opens, fetch each node's AUTHORED config from the TEMPLATE (one
  // /__piflow/node-config call per node) so each badge can render its real gate pipeline + tier. A node
  // whose template config can't be read (e.g. a fusion-generated sibling that isn't an author node) is
  // simply absent ⇒ its badge shows "drop a gate". Re-runs when the node set or the active run changes.
  useEffect(() => {
    if (mode !== "compose" || !activeRun || flowNodes.length === 0) { setNodeConfigs({}); return; }
    let alive = true;
    (async () => {
      const entries = await Promise.all(
        flowNodes.map(async (n) => [n.id, await loadNodeConfig(activeRun, n.id)] as const),
      );
      if (!alive) return;
      const map: Record<string, AuthoredNodeConfig> = {};
      for (const [id, cfg] of entries) if (cfg) map[id] = cfg;
      setNodeConfigs(map);
    })();
    return () => { alive = false; };
  }, [mode, activeRun, flowNodes]);

  // (Compose · SA-E + Slice 1.5) apply a gate chip to a node. `target` defaults to "run" — RUN-FIRST: the gate
  // lands on THIS run's `.pi/run.json` (visible on the run once the run-view re-polls), the template untouched.
  // "template" PROMOTES it durably (the original write-back path); on a template write we refresh that node's
  // AUTHORED config so the compose badge re-renders with the promoted gate. config is the single source of truth.
  const dropChip = useCallback(async (nodeId: string, chip: GateChip | AgentChip | SkillChip, target: "run" | "template" = "run"): Promise<{ ok: boolean; error?: string; stub?: boolean }> => {
    if (!activeRun) return { ok: false, error: "no active run" };
    const r = await dropChipOnNode(activeRun, nodeId, chip, target);
    if (r.ok && target === "template") {
      // Prefer the mutated config the endpoint echoed; fall back to a fresh read (the run bake doesn't touch it).
      const fresh = r.node ?? (await loadNodeConfig(activeRun, nodeId));
      if (fresh) setNodeConfigs((prev) => ({ ...prev, [nodeId]: fresh }));
    }
    // A run-first bake changed the run's `.pi/` — re-load the run-view so the gate appears on the graph even
    // for a DONE run (whose 3 s poll has stopped).
    if (r.ok && target === "run") setRunViewNonce((n) => n + 1);
    return { ok: r.ok, error: r.error, stub: r.stub };
  }, [activeRun]);

  // (Compose mode) a rail gate dropped on a node opens the left-side authoring overlay bound to that node.
  // The node's upstream/downstream neighbors (from the live edge set) ride along so the compose agent gets the
  // node's structural context in its bundle (Slice 2, inv 2) — read from `edges` at drop time.
  const openCard = useCallback((nodeId: string, kind: RailKind) => {
    const prev = edges.filter((e) => e.target === nodeId).map((e) => e.source);
    const next = edges.filter((e) => e.source === nodeId).map((e) => e.target);
    setDropCard({ nodeId, kind, prev, next });
  }, [edges]);

  const composeApi = useMemo(
    () => ({ active: mode === "compose", run: activeRun, configs: nodeConfigs, dropChip, openCard, targetId: dropCard?.nodeId ?? null, composingNodeId }),
    [mode, activeRun, nodeConfigs, dropChip, openCard, dropCard, composingNodeId],
  );

  // Leaving Compose mode drops the loaded configs (re-fetched fresh on re-entry) + closes any open card.
  useEffect(() => { if (mode !== "compose") { setNodeConfigs((c) => (Object.keys(c).length ? {} : c)); setDropCard(null); setComposingNodeId(null); } }, [mode]);

  // (Basis mode · P1) an AgentRail avatar dropped on a node's basis slot opens the reassign confirm card.
  const openAgentCard = useCallback((nodeId: string, agentType: string, current?: string) => {
    setAgentCard({ nodeId, agentType, ...(current ? { current } : {}) });
  }, []);
  const basisApi = useMemo(
    () => ({ openCard: openAgentCard, targetId: agentCard?.nodeId ?? null }),
    [openAgentCard, agentCard],
  );
  // Leaving Basis mode closes any open reassign card (mirrors the Compose teardown).
  useEffect(() => { if (mode !== "basis") setAgentCard(null); }, [mode]);

  // (P2 skill marketplace) a skill dragged onto a node's skill slot opens the loadout confirm card. `active`
  // = the marketplace panel is open (agent nodes then show the drop slot); the write happens on the card.
  const openSkillCard = useCallback((nodeId: string, skill: string, current?: string) => {
    setSkillCard({ nodeId, skill, ...(current ? { current } : {}) });
  }, []);
  const marketApi = useMemo(
    () => ({ active: marketOpen, openCard: openSkillCard, targetId: skillCard?.nodeId ?? null }),
    [marketOpen, openSkillCard, skillCard],
  );
  // Closing the marketplace panel closes any open skill card (mirrors the Basis teardown).
  useEffect(() => { if (!marketOpen) setSkillCard(null); }, [marketOpen]);

  // A backdrop zone is non-selectable, so the expanded node is always a real card — narrow before reading data.
  const expandedNode = nodes.find((n) => n.id === expandedId);
  const expandedData = expandedNode && isFlowNode(expandedNode) ? expandedNode.data : null;

  // (Workspace switch) the entered folder's display name for the MenuBar pill; and whether the current run is
  // LIVE-streaming (switching folders while live routes through the launcher's detach-the-session confirm).
  const workspaceName = useMemo(
    () => (ix && activeWorkspace ? ix.products.find((p) => p.id === activeWorkspace)?.name ?? null : null),
    [ix, activeWorkspace],
  );
  const liveRun = live.status === "live" && activeRun ? activeRun : null;

  return (
    <ExpandContext.Provider value={expandApi}>
      <ViewModeContext.Provider value={viewModeApi}>
      <FusionContext.Provider value={fusionApi}>
      <ComposeContext.Provider value={composeApi}>
      <BasisContext.Provider value={basisApi}>
      <MarketContext.Provider value={marketApi}>
      <SkillContext.Provider value={skillApi}>
      <RemoteSkillContext.Provider value={remoteSkillApi}>
      <RunStreamContext.Provider value={live}>
      <CardMenuContext.Provider value={cardMenu}>
      <LayoutGroup>
        <div style={{ position: "relative", width: "100%", height: "100%", background: "var(--ds-bg-canvas)" }}>
          <OrbField />
          {loadError && (
            <div
              role="alert"
              style={{
                // top: 60 keeps the alert clear of the top chrome band (chrome floats above content, so content
                // must clear its band — the same law as the palette-row / HUD-caption clearances).
                position: "absolute", top: 60, left: "50%", transform: "translateX(-50%)", zIndex: 200,
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

          <NodeExpandOverlay id={expandedId} data={expandedData} run={activeRun} focusIssue={focusIssue} onClose={() => { setExpandedId(null); setFocusIssue(null); }} />
          <FileExpandOverlay
            open={openFile}
            run={activeRun}
            tree={dir.tree}
            nodes={flowNodes}
            onSelectFile={setOpenFile}
            onOpenNode={(nodeId) => { setOpenFile(null); setExpandedId(nodeId); }}
            onClose={() => setOpenFile(null)}
          />
          {/* Start/Migrate are true modals and mutually exclusive — the chrome stays clickable above their
              scrim (by design), so opening one must close the other or they stack. */}
          <MenuBar activeRun={activeRun} workspaceName={workspaceName} onOpenWorkspaces={() => setWorkspaceOpen(true)} onSelectRun={selectRun} onStartRun={() => { setMigrateOpen(false); setStartOpen(true); }} onMigrateRun={() => { setStartOpen(false); setMigrateOpen(true); }} ix={ix} hidden={cardOpen && !menuPeek} peeking={cardOpen && menuPeek} onDismissMenu={() => setMenuPeek(false)} />
          {/* Full-screen "switch workspace" launcher (opened by the MenuBar ⊞ pill). Entering a folder re-scopes
              the console via enterWorkspace; a live run routes through its detach-the-session confirm. */}
          <WorkspaceLauncher open={workspaceOpen} ix={ix} activeWorkspace={activeWorkspace} liveRun={liveRun} onEnter={enterWorkspace} onClose={() => setWorkspaceOpen(false)} />
          {/* Consolidated control-plane control (bottom-right, beside the chat launcher): the local ⇄ cloud
              switch + connect-a-remote, with a liveness dot (green reachable / red unreachable). */}
          <ControlPlaneChip health={controlHealth} />
          <ModeBar chatOpen={companionOpen} onToggleChat={toggleChat} digestOpen={digestOpen} onToggleDigest={toggleDigest} marketOpen={marketOpen} onToggleMarket={toggleMarket} issuesOpen={runIssuesOpen} onToggleIssues={toggleIssues} muted={startOpen || migrateOpen || workspaceOpen} />
          <FusionSaveBar active={mode === "fusion"} />
          {/* (Compose mode) the left-edge hexagon gate rail (drag source). It HIDES while the authoring
              overlay is open — both are left-anchored, and the overlay is the focus. */}
          <GateRail active={mode === "compose" && !dropCard} />
          {/* (Basis mode · P1) the left-edge base-agent rail (drag source) — every catalog base as a
              draggable avatar. Same hide-while-the-card-is-open law as the GateRail. */}
          <AgentRail active={mode === "basis" && !agentCard} catalog={agentCatalog} />
          {/* The base-agent reassign confirm card (GateDropCard idiom, simpler): dragged base vs current,
              one action — the TEMPLATE-ONLY agentType write through the same validated node-edit path. */}
          <AgentDropCard
            card={mode === "basis" ? agentCard : null}
            catalog={agentCatalog}
            onClose={() => setAgentCard(null)}
            dropChip={dropChip}
          />
          {/* The left-side gate-authoring overlay (mirror of the right-side Companion), bound to the node. For
              agent-composed kinds it drives a dedicated compose `pi` session (channel=compose) + reports which
              node is mid-compose so the canvas paints a pending hex on it. */}
          <GateDropCard
            card={mode === "compose" ? dropCard : null}
            run={activeRun}
            onClose={() => { setDropCard(null); setComposingNodeId(null); }}
            dropChip={dropChip}
            onComposingChange={setComposingNodeId}
          />
          <Companion activeRun={activeRun} open={companionOpen} onOpenChange={setChatOpen} />
          {/* Left-edge skill inspector — opened by clicking a loaded skill chip (node card / NodeHud) OR a
              marketplace card. */}
          <SkillPanel activeRun={activeRun} />
          {/* Left-edge ONLINE detail inspector — opened by clicking a remote (online-ring) marketplace card;
              shows the fuller description + the fetched SKILL.md + a one-click Install. */}
          <RemoteSkillPanel />
          {/* Left-edge skill MARKETPLACE (S key): search + ring filter + draggable skill cards. A card CLICK
              opens the SkillPanel detail; DRAGGING one onto a node's skill slot opens the loadout confirm card. */}
          <SkillMarketPanel activeRun={activeRun} open={marketOpen} onClose={() => setMarketOpen(false)} />
          {/* The skill-loadout confirm card (AgentDropCard idiom + the GateDropCard two-tier apply): dragged
              skill vs current + requires/allowed, one primary "Apply to this run" then a template promote. */}
          <SkillDropCard card={skillCard} run={activeRun} onClose={() => setSkillCard(null)} dropChip={dropChip} />
          {/* Left-edge run-LEVEL digest (anomaly worklist + failure-onset), sourced from /__piflow/run-digest.
              Clicking an anomaly/onset node focuses that node on the canvas. */}
          <RunDigestPanel activeRun={activeRun} open={digestOpen} liveStatus={live.status} liveSig={digestSig} onFocusNode={setExpandedId} onClose={() => setDigestOpen(false)} />
          {/* (M8) Right-dock RUN-LEVEL issues card (I key) — all nodes grouped, filter-by-node. Clicking an
              issue jumps to that node's HUD with the issue open (focusIssue). The node-scoped view lives
              in-HUD now (NodeHud issues-mode), not here. */}
          <RunIssuesPanel
            activeRun={activeRun}
            open={runIssuesOpen}
            onClose={() => setRunIssuesOpen(false)}
            onOpenIssue={(node, issueId) => { setRunIssuesOpen(false); setExpandedId(node); setFocusIssue({ node, issueId }); }}
          />
          {/* Launch a run → on the 202, select it via `selectRun` so the live views observe the new run. */}
          <StartRunPanel open={startOpen} onClose={() => setStartOpen(false)} onStarted={selectRun} />
          {/* Migrate the active run → on the 202, re-point the console to the target serve + follow the run. */}
          <MigrateRunPanel open={migrateOpen} onClose={() => setMigrateOpen(false)} activeRun={activeRun} onMigrated={onMigrated} />
        </div>
      </LayoutGroup>
      </CardMenuContext.Provider>
      </RunStreamContext.Provider>
      </RemoteSkillContext.Provider>
      </SkillContext.Provider>
      </MarketContext.Provider>
      </BasisContext.Provider>
      </ComposeContext.Provider>
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
