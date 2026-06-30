// ── tui/adapt.mjs ───────────────────────────────────────────────────────
// The BROWSER-PURE mapping layer for the pi-flow TUI. This module imports NOTHING from node or
// `@piflow/core` — it is plain JS that turns a structural model (the shared `RunModel`, OR a rich
// `RunView` JSON) into the "view" shape `components.mjs`/`dag.mjs` consume. The node-coupled
// `tui/model.mjs` re-exports these so the filesystem path is unchanged; the marketing-site TUI demo
// imports them directly to render a `run-view/<run>.json` in the browser with no node dependency.
//
// `adaptModel` seeds the structural view (status/stage/lane + io.json-derived edges). `overlayRichTelemetry`
// + `overlayRichIo` overlay the RICH run-view's telemetry/structure/io (the SAME mappers the node path uses).
// `adaptRunView` is the browser entry: it treats the rich `RunView` AS the structural model, then overlays
// its own telemetry — one pure call, no filesystem.

/** Map the shared RunModel → the view shape. Pure (no I/O) — all data is already in `model`. */
export function adaptModel(model, run) {
  const labelOf = (id) => model.nodes.find((n) => n.id === id)?.label || id;

  // edges: producer→consumer over a shared path. Index them both ways for inputs/outputs.
  const inEdges = {};  // consumer id → [{ from, path }]
  const outEdges = {}; // producer id → [{ to, path }]
  for (const e of model.edges || []) {
    (inEdges[e.to] ||= []).push(e);
    (outEdges[e.from] ||= []).push(e);
  }

  const nodes = {};
  for (const n of model.nodes) {
    // INPUTS — each upstream edge into this node (the producer is the edge `from`).
    const seenIn = new Set();
    const inputs = (inEdges[n.id] || []).filter((e) => { const k = e.path; if (seenIn.has(k)) return false; seenIn.add(k); return true; })
      .map((e) => ({ rel: e.path, fromNode: e.from, fromLabel: labelOf(e.from), functionality: null, exists: null, bytes: null, path: null, kind: 'in' }));
    // OUTPUTS — each path this node produced + the downstream consumers (the edge `to`s sharing it).
    const byPath = {};
    for (const e of outEdges[n.id] || []) (byPath[e.path] ||= []).push(e.to);
    const outputs = Object.entries(byPath).map(([rel, tos]) => {
      const consumers = [...new Set(tos)];
      return { rel, toNodes: consumers, toLabels: consumers.map(labelOf), functionality: null, exists: null, bytes: null, path: rel, kind: 'out' };
    });

    nodes[n.id] = {
      id: n.id,
      label: n.label || n.id,
      phase: n.phase || null,
      // (G6) the agent-preset label — verbatim from the shared model (was dropped to null).
      agentType: n.agentType || null,
      hasSchema: false,
      stageIndex: n.stageIndex || null,
      lane: n.lane || 0,
      status: n.status || 'pending',
      reported: n.reported || n.status,
      startedAt: null, endedAt: null,
      // Gantt timestamps are NOT in the shared RunModel (a proposed extension); the bar null-renders.
      durationMs: n.durationMs ?? null,
      startMs: null, endMs: null,
      // Live cosmetics accumulated from the node-event stream (subscribeRun), not re-read from files.
      tokens: null,
      contextWindow: null,
      toolCalls: 0,
      toolBreakdown: null,
      thinking: null,
      eventCount: 0,
      // HEALTH signals — the GUI's anomaly lens; null/0 here, filled by overlayRichTelemetry when the rich
      // view is available (the lean snapshot carries none), so a no-dist run just shows no warnings.
      retries: 0,
      stopReason: null,
      truncated: false,
      modelCalls: 0,
      maxToolRepeat: 0,
      repeatedTool: null,
      expectedMs: null,
      priorSamples: null,
      // (G5) the parked human-checkpoint payload — present (from the shared NodeView) iff a marker exists.
      checkpoint: n.checkpoint || null,
      // artifact verification IS in the shared model — surface verified/total + the missing set.
      artifactsVerified: n.artifactsVerified ?? 0,
      artifactsTotal: n.artifactsTotal ?? 0,
      artifacts: null,
      missing: n.missing || [],
      issues: [],
      summary: null,
      pipelineFindings: [],
      attempts: null,
      escalated: n.status === 'error' || n.status === 'blocked' ? false : false,
      live: null,
      io: {
        description: n.phase || null,
        projectDir: null, skill: null,
        inputs, outputs, produced: [],
        externalReads: [],
        owns: outputs.map((o) => baseName(o.rel)),
        note: null,
      },
      description: n.phase || null,
    };
  }

  const stages = (model.stages || []).map((st) => ({
    index: st.index, phase: st.phase || null, parallel: !!st.parallel, nodeIds: st.nodeIds,
  }));

  // DERIVED — a minimal Gantt window (no per-node timestamps in the source ⇒ a flat, zero-width band);
  // the bar self-blanks when startMs is null, so this stays cosmetically inert until the source carries
  // timestamps. stageTimes/pathways are reconstructed from the structural model.
  const timeline = { t0: 0, t1: 1, rows: [] };
  const stageTimes = stages.map((st) => ({ index: st.index, durationMs: null }));
  const pathways = {
    halted: model.done === true && model.ok === false,
    haltNode: Object.values(nodes).find((n) => n.status === 'error' || n.status === 'blocked')?.id || null,
    reused: Object.values(nodes).filter((n) => n.status === 'reused').map((n) => n.id),
    pending: Object.values(nodes).filter((n) => n.status === 'pending').map((n) => n.id),
    running: Object.values(nodes).filter((n) => n.status === 'running').map((n) => n.id),
    escalated: [],
  };
  const totals = model.totals
    ? { nodes: model.totals.nodes, toolCalls: 0, tokensBillable: 0 }
    : { nodes: Object.keys(nodes).length, toolCalls: 0, tokensBillable: 0 };

  return {
    run: {
      id: model.run || run || null,
      source: null,
      provider: model.provider || null, model: model.model || null,
      done: !!model.done, ok: model.ok ?? null,
      debug: false, sandbox: false, escalate: false,
      startedAt: null, updatedAt: null,
      elapsedMs: null, durationMs: model.durationMs ?? null,
      stage: model.stage || null,
      staleMs: null,
      missing: false,
      extractErr: null,
    },
    stages, stageTimes, nodes, timeline, pathways,
    totals: { ...totals, cost: 0 },
  };
}

/**
 * Overlay the RICH `RunView` (`buildRunView`) telemetry onto an already-structured view (from
 * `adaptModel`), keyed by node id: `tokens` (the `RunTokens` shape the renderer reads as
 * `n.tokens.contextPeak` / `n.tokens.billable`), `contextWindow`, `model`/`provider`, `toolCalls`,
 * `toolBreakdown`, real Gantt timestamps, and the run-level token/cost/toolCall rollups. STRUCTURE
 * (stages/lanes) AND the data-flow io (edges + per-node input/output files) are also adopted from the
 * rich view — it reads the run-local resolved DAG (`.pi/workflow.json`) the GUI renders, which the lean
 * `readRunModel` snapshot can't see, so the TUI draws the SAME connected graph and real files. Mutates
 * `view` in place. The live `node-event` overlay (foldLiveIntoModel) still wins for the running node.
 */
export function overlayRichTelemetry(view, rich) {
  const byId = new Map((rich.nodes || []).map((n) => [n.id, n]));
  for (const [id, row] of Object.entries(view.nodes)) {
    const rn = byId.get(id);
    if (!rn) continue;
    if (rn.tokens) row.tokens = rn.tokens;                    // { input, output, cacheRead, cacheWrite, cost, contextPeak, billable }
    if (rn.contextWindow != null) row.contextWindow = rn.contextWindow;
    if (rn.model != null) row.model = rn.model;
    if (rn.provider != null) row.provider = rn.provider;
    if (rn.toolCalls) row.toolCalls = rn.toolCalls;
    if (rn.toolBreakdown && Object.keys(rn.toolBreakdown).length) row.toolBreakdown = rn.toolBreakdown;
    if (rn.thinkingChars) row.thinking = { chars: rn.thinkingChars }; // the live fold (foldLiveIntoModel) wins for the running node
    // HEALTH / ANOMALY signals — the GUI's anomaly lens, surfaced verbatim so the inspector can WARN:
    // rate-limit retries, a token-capped (truncated) stop, a tool/model loop, and slow-vs-baseline timing.
    row.retries = rn.retries || 0;
    row.stopReason = rn.stopReason ?? null;
    row.truncated = !!rn.truncated;
    row.modelCalls = rn.modelCalls || 0;
    row.maxToolRepeat = rn.maxToolRepeat || 0;
    row.repeatedTool = rn.repeatedTool ?? null;
    if (rn.expectedMs != null) row.expectedMs = rn.expectedMs;
    if (rn.priorSamples != null) row.priorSamples = rn.priorSamples;
    if (rn.agentType) row.agentType = rn.agentType;
    if (rn.summary) row.summary = rn.summary;
    if (rn.issues && rn.issues.length) row.issues = rn.issues;
    if (rn.checkpoint) row.checkpoint = rn.checkpoint; // (G5) the human-gate payload (prompt/kind/reply)
    // Real Gantt window from the rich view's timestamps (the lean snapshot carries none).
    const s = rn.startedAt ? Date.parse(rn.startedAt) : NaN;
    const e = rn.endedAt ? Date.parse(rn.endedAt) : NaN;
    if (Number.isFinite(s)) { row.startedAt = rn.startedAt; row.startMs = s; }
    if (Number.isFinite(e)) { row.endedAt = rn.endedAt; row.endMs = e; }
    if (rn.durationMs != null) row.durationMs = rn.durationMs;
  }

  // STRUCTURE: adopt the rich view's phase-grouped stages + lanes — the horizontal DAG the GUI renders.
  // readRunModel reconstructs stages from the engine's LAST published barrier, which on a FINISHED run
  // collapses to one singleton stage per node (the DAG drew as a vertical line); the phase grouping stays
  // correct (parallel siblings share a stage, each on its own lane). When the rich stages are present we
  // take them (and each node's stageIndex/lane) as the layout.
  if (Array.isArray(rich.stages) && rich.stages.length) {
    view.stages = rich.stages.map((st) => ({ index: st.index, phase: st.phase ?? null, parallel: !!st.parallel, nodeIds: [...st.nodeIds] }));
    view.stageTimes = view.stages.map((st) => ({ index: st.index, durationMs: null }));
    for (const rn of rich.nodes || []) {
      const row = view.nodes[rn.id];
      if (!row) continue;
      if (rn.stageIndex != null) row.stageIndex = rn.stageIndex;
      if (rn.lane != null) row.lane = rn.lane;
    }
  }

  // DATA FLOW: adopt the rich view's edges (the authoritative resolved-DAG topology) + real input/output
  // files. On a real run `readRunModel`'s io.json ledger is empty — its edges are 0 — so adaptModel left
  // every node with NO inputs/outputs and the DAG drew disconnected boxes. The rich view carries the
  // declared edges (one source the GUI draws) plus per-node writes/artifacts with verified/bytes. We
  // rebuild each node's `io.inputs`/`io.outputs` from them so the DAG (io.outputs[].toNodes) and the
  // inspector (flow · INPUTS/OUTPUTS) read the SAME connected graph. A no-op when the rich view has
  // neither edges nor files (degenerate/no-dist), so adaptModel's io.json fallback survives.
  overlayRichIo(view, rich);

  // Real Gantt window across nodes (was a flat 0→1 band without timestamps).
  const starts = Object.values(view.nodes).map((n) => n.startMs).filter((x) => x != null);
  const ends = Object.values(view.nodes).map((n) => n.endMs).filter((x) => x != null);
  if (starts.length) {
    const tStart = Math.min(...starts);
    const tEnd = ends.length ? Math.max(...ends) : tStart + 1;
    view.timeline = { t0: tStart, t1: tEnd > tStart ? tEnd : tStart + 1, rows: [] };
  }

  // Run-level rollups from the rich token totals + per-node tool sums (header showed 0 before).
  const tt = rich.tokenTotal || {};
  view.totals = {
    ...view.totals,
    toolCalls: Object.values(view.nodes).reduce((a, n) => a + (n.toolCalls || 0), 0),
    tokensBillable: tt.billable || 0,
    cost: tt.cost || 0,
  };
  if (rich.provider && !view.run.provider) view.run.provider = rich.provider;
  // Run-level model: the rich view's top-level `model` is often null (a fleet run stamps provider but no
  // single model). Fall back to the first node's resolved model so the header reads "provider/MiniMax-M3"
  // instead of "provider/" — the per-node models already populated above are the authoritative source.
  if (view.run.model == null) view.run.model = rich.model || Object.values(view.nodes).map((n) => n.model).find(Boolean) || null;
}

/**
 * Rebuild each node's `io.inputs`/`io.outputs` from the RICH view's authoritative data-flow: edges (the
 * resolved-DAG topology that drives the DAG arrows + the inspector's flow/INPUTS/OUTPUTS) and real output
 * files (writes ∪ artifacts, merged by path, carrying verified→exists + bytes). The DAG reads
 * `io.outputs[].toNodes`, so the full outbound-consumer set is attached to a node's first output row (the
 * renderer unions same-pair edges, then transitively reduces) — and a node that has consumers but no
 * known output file still gets ONE synthetic output row so its edges survive. INPUTS are one row per
 * upstream producer (the edge `from`). A no-op (leaving adaptModel's io.json-derived io intact) when the
 * rich view carries neither edges nor files, e.g. when the dist isn't built. Mutates `view` in place.
 */
export function overlayRichIo(view, rich) {
  const edges = rich.edges || [];
  const richNodes = rich.nodes || [];
  const hasFiles = richNodes.some((n) => (n.writes?.length || 0) + (n.artifacts?.length || 0) > 0);
  if (!edges.length && !hasFiles) return; // nothing richer than the lean io ledger — keep adaptModel's.

  const labelOf = (id) => richNodes.find((n) => n.id === id)?.label || view.nodes[id]?.label || id;
  const inboundOf = {};  // consumer id → [edge]
  const outboundOf = {}; // producer id → [edge]
  for (const e of edges) { (inboundOf[e.to] ||= []).push(e); (outboundOf[e.from] ||= []).push(e); }

  for (const rn of richNodes) {
    const row = view.nodes[rn.id];
    if (!row) continue;

    // INPUTS — one row per distinct upstream producer (the edge `from`); rel is the flowing file basename.
    const seenIn = new Set();
    const inputs = (inboundOf[rn.id] || []).filter((e) => { const k = `${e.from}|${e.path}`; if (seenIn.has(k)) return false; seenIn.add(k); return true; })
      .map((e) => ({ rel: e.path ? baseName(e.path) : '', path: e.path || null, fromNode: e.from, fromLabel: labelOf(e.from), functionality: null, exists: null, bytes: null, kind: 'in' }));

    // OUTPUTS — real files this node produced (writes ∪ artifacts), merged by run-relative display path so
    // a write and its declared artifact collapse to ONE row; the artifact carries the authoritative
    // exists/bytes. The full outbound-consumer set rides EVERY output row (the node's outputs all feed its
    // consumers — we can't reliably map file→consumer when an edge declares no file, and labelling one
    // output "terminal" while the node clearly feeds downstream is wrong). The DAG unions same-pair edges.
    const fileMap = new Map();
    for (const w of rn.writes || []) { const rel = w.displayPath || w.path; fileMap.set(rel, { ...(fileMap.get(rel) || {}), rel, exists: w.verified ?? null, bytes: w.bytes ?? null }); }
    for (const a of rn.artifacts || []) { const rel = a.displayPath || a.path; fileMap.set(rel, { ...(fileMap.get(rel) || {}), rel, exists: a.exists, bytes: a.bytes }); }
    const consumers = [...new Set((outboundOf[rn.id] || []).map((e) => e.to))];
    const consumerLabels = consumers.map(labelOf);
    let outputs = [...fileMap.values()].map((f) => ({
      rel: f.rel, path: f.rel, exists: f.exists ?? null, bytes: f.bytes ?? null, functionality: null, kind: 'out',
      toNodes: consumers, toLabels: consumerLabels,
    }));
    if (!outputs.length && consumers.length) {
      // Consumers but no known produced file (e.g. a contract edge with no write event) — one synthetic row
      // so the DAG keeps the outbound edges.
      const p = (outboundOf[rn.id][0] || {}).path || '';
      outputs = [{ rel: p ? baseName(p) : '', path: p || null, exists: null, bytes: null, functionality: null, kind: 'out', toNodes: consumers, toLabels: consumerLabels }];
    }

    row.io.inputs = inputs;
    row.io.outputs = outputs;
    row.io.owns = outputs.map((o) => baseName(o.rel)).filter(Boolean);
  }
}

/**
 * BROWSER entry — adapt a rich `RunView` JSON (the exact `run-view/<run>.json` the GUI demo renders) into
 * the TUI view shape with NO filesystem/`@piflow/core`. The rich `RunView`'s TOP-LEVEL shape IS the
 * structural model `adaptModel` expects (`.nodes` array with status/stageIndex/lane, `.edges`
 * `[{from,to,path}]`, `.stages`, `.run`, `.done`, `.ok`, `.provider`, `.model`, `.durationMs`), so we seed
 * the base view by treating the RunView as that model, then overlay its OWN telemetry + io (which re-adopts
 * its stages/lanes and rebuilds each node's io from `.edges` ∪ `.writes`/`.artifacts`). One pure call.
 */
export function adaptRunView(rich) {
  const view = adaptModel(rich, rich.run);
  overlayRichTelemetry(view, rich);
  return view;
}

export function emptyModel(run) {
  return {
    run: { id: run || null, provider: null, model: null, done: false, ok: null, durationMs: null, elapsedMs: null, stage: null, staleMs: null, missing: true, extractErr: null },
    stages: [], stageTimes: [], nodes: {}, timeline: { t0: 0, t1: 1, rows: [] },
    pathways: { halted: false, haltNode: null, reused: [], pending: [], running: [], escalated: [] },
    totals: { nodes: 0, toolCalls: 0, tokensBillable: 0, cost: 0 },
  };
}

export const baseName = (p) => String(p ?? '').split('/').pop();
