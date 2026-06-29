// ── tui/model.mjs ───────────────────────────────────────────────────────
// The renderer-AGNOSTIC data layer for visualizing ONE pi-flow run — now a THIN ADAPTER over the SHARED
// observability source (`@piflow/core/observe`). It reads the run through `readRunModel(runDir)` — the
// ONE reader the CLI, the TUI, and a future GUI all share — and subscribes to `watchRun(runDir)` for
// the live tail. There is NO bespoke `.pi/` reader here anymore: status derivation, stage/lane
// reconstruction, and the io-derived data-flow edges all live in the shared source; this file only
// MAPS the shared `RunModel` into the view shape the renderers (components.mjs / dag.mjs) already
// consume, and DERIVES the cosmetic live extras (the running-node text tail) from the streamed
// `node-event` PiEvents — never by re-reading `.pi/` files.
//
// Per-node token/cost counts, tool breakdown, thinking-char totals, and Gantt start/end timestamps come
// from the RICH run-view (`buildRunView`, the SAME distiller the GUI uses) — see `loadBuildRunView` below.
// Where the rich view is unavailable (no built `dist`, or no `.pi/run.json`) we fall back to the lean
// `readRunModel` snapshot, whose missing telemetry the view null-guards. The live running-node tail
// (text · tools · thinking) is still folded from the streamed `node-event` PiEvents, never by re-reading
// `.pi/` files.
import { readRunModel, watchRun, loadRegistry, buildSnapshot } from '@piflow/core';
import { pathToFileURL, fileURLToPath } from 'node:url';
import nodePath from 'node:path';

// `summarizeRun` is RE-HOMED in `@piflow/core/observe` (the ONE shared thread-row builder the CLI, the TUI,
// and the GUI all render) — the TUI no longer keeps a divergent copy that drifted from it. Re-exported so
// the single-run `discoverNamespaces` below (and any importer) keeps the same name.
export { summarizeRun } from '@piflow/core';
import { summarizeRun } from '@piflow/core';

// ── rich run-view loader — the SAME builder the GUI dynamic-imports ───────────────────────────────────
// `buildRunView` lives in `@piflow/core/observe` but that subpath is NOT in the package's `exports` map,
// so a bare `import '@piflow/core/observe'` is blocked (ERR_PACKAGE_PATH_NOT_EXPORTED). We mirror the GUI's
// resolution (gui/vite.config.ts): resolve the EXPORTED main entry to find the built package on disk, then
// file-URL `import()` the sibling `observe/index.js` — which bypasses package `exports` resolution and
// modifies nothing in core. Cached after first load; `null` (graceful fallback) if the dist isn't built.
let _buildRunView; // undefined = not tried; null = unavailable; fn = loaded
async function loadBuildRunView() {
  if (_buildRunView !== undefined) return _buildRunView;
  try {
    const mainPath = fileURLToPath(import.meta.resolve('@piflow/core'));
    const obs = nodePath.join(nodePath.dirname(mainPath), 'observe', 'index.js');
    const mod = await import(pathToFileURL(obs).href);
    _buildRunView = typeof mod.buildRunView === 'function' ? mod.buildRunView : null;
  } catch { _buildRunView = null; }
  return _buildRunView;
}

/** Build the rich run-view for a run dir, or null if unavailable (dist not built / no run.json). */
async function tryRichView(runDir) {
  const build = await loadBuildRunView();
  if (!build) return null;
  try { return build(runDir).view; }
  catch { return null; }
}

// ── snapshot: readRunModel → the legacy buildModel() view shape ──────────────────────
// `RunModel` (the shared snapshot) is a SUPERSET of what the view needs for structure (nodes with
// derived status + stageIndex/lane, the stage spine, the io-derived edges). We re-key its `nodes` array
// into the `{id: node}` map the renderers index, and reconstruct each node's io.inputs/outputs from the
// shared `edges` (a write of A that B reads back = edge A→B) so the per-node inspector + the DAG still
// draw the data flow. One definition of "the truth", many views.
export async function buildModel({ runDir, run } = {}) {
  // STRUCTURE from the lean snapshot: status/stage/lane + the io.json-DERIVED data-flow edges. This is the
  // FALLBACK structure — when the rich view is available, `overlayRichTelemetry` adopts its resolved-DAG
  // stages + edges (the GUI's authoritative topology) over these, which a real run's empty io.json lacks.
  let model;
  try { model = await readRunModel(runDir); }
  catch { return emptyModel(run); }
  const view = adaptModel(model, run);
  // TELEMETRY + STRUCTURE overlay: real per-node tokens/ctx/tools AND the resolved-DAG stages/edges/files
  // from the RICH run-view (the SAME distiller the GUI renders). A no-op when the rich view is unavailable
  // (dist not built / no run.json) — the view then keeps the lean snapshot's io-ledger structure.
  const rich = await tryRichView(runDir);
  if (rich) overlayRichTelemetry(view, rich);
  return view;
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
      agentType: null,
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
      toolCalls: 0,
      toolBreakdown: null,
      thinking: null,
      eventCount: 0,
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

function emptyModel(run) {
  return {
    run: { id: run || null, provider: null, model: null, done: false, ok: null, durationMs: null, elapsedMs: null, stage: null, staleMs: null, missing: true, extractErr: null },
    stages: [], stageTimes: [], nodes: {}, timeline: { t0: 0, t1: 1, rows: [] },
    pathways: { halted: false, haltNode: null, reused: [], pending: [], running: [], escalated: [] },
    totals: { nodes: 0, toolCalls: 0, tokensBillable: 0, cost: 0 },
  };
}

const baseName = (p) => String(p ?? '').split('/').pop();

// ── live tail: accumulated from the shared watchRun node-event stream ─────────────────
// The running-node output tail (and the tool/thinking cosmetics) are DERIVED from the streamed
// `node-event` PiEvents — NOT by re-reading `.pi/nodes/<id>/events.jsonl`. `subscribeRun` drives the
// shared stream and folds each node-event into a per-node accumulator the view reads.

/** Reconstruct the assistant text + tool tally a node-event PiEvent carries (the slimmed delta shape). */
function foldEvent(acc, event) {
  const a = event?.assistantMessageEvent || event?.event || event;
  const t = a?.type ?? event?.type;
  const d = a?.delta;
  if ((t === 'text_delta' || t === 'content_delta') && typeof d === 'string') acc.text += d;
  else if (t === 'thinking_delta' && typeof d === 'string') acc.thinkChars += d.length;
  else if (event?.type === 'tool_execution_start') {
    acc.toolCalls += 1;
    const tn = event.toolName;
    if (typeof tn === 'string') acc.toolBreakdown[tn] = (acc.toolBreakdown[tn] || 0) + 1;
  }
  acc.eventCount += 1;
  return acc;
}

function newAcc() { return { text: '', thinkChars: 0, toolCalls: 0, eventCount: 0, toolBreakdown: {} }; }

/**
 * Subscribe to the SHARED live stream for one run dir. `onModel(model)` fires on each snapshot/status
 * delta with the adapted view model; `onTail(byNode)` fires on each node-event with the per-node live
 * accumulators (text tail · toolCalls · thinking chars · toolBreakdown). Returns an unsubscribe fn.
 * All live data comes from the stream — this opens NO `.pi/` file itself.
 */
export function subscribeRun({ runDir, run, onModel, onTail, pollMs } = {}) {
  const ctrl = new AbortController();
  const accs = new Map(); // nodeId → live accumulator
  (async () => {
    try {
      for await (const u of watchRun(runDir, { signal: ctrl.signal, pollMs })) {
        if (ctrl.signal.aborted) break;
        if (u.kind === 'snapshot') {
          // STRUCTURE from the stream's lean model; OVERLAY real tokens/ctx/tools from the rich re-distill
          // (a no-op when unavailable). The live running-node tail is folded separately by the consumer.
          const model = adaptModel(u.model, run);
          const rich = await tryRichView(runDir);
          if (ctrl.signal.aborted) break;
          if (rich) overlayRichTelemetry(model, rich);
          onModel?.(model);
        }
        else if (u.kind === 'node-status') { /* status deltas are reflected by the next snapshot poll */ }
        else if (u.kind === 'node-event') {
          const acc = accs.get(u.id) || newAcc();
          foldEvent(acc, u.event);
          accs.set(u.id, acc);
          onTail?.(Object.fromEntries(accs));
        }
      }
    } catch { /* a stream error never crashes the TUI; the last good model stays on screen */ }
  })();
  return () => ctrl.abort();
}

// ── single-run "discovery": a run dir is one namespace with one thread ───────────────────────────────
// A `piflow-tui <rundir>` monitors ONE run. We keep the namespace→thread→detail SHAPE the view layer
// expects (so components.mjs is unchanged) by projecting the single run dir into a one-namespace /
// one-thread list — summarized via the SHARED `summarizeRun` (re-homed in @piflow/core/observe), no
// bespoke `.pi/` read and no divergent row builder.

/** Project the single run dir → the one-namespace list the view layer iterates. Async (shared reader). */
export async function discoverNamespaces({ runDir } = {}) {
  if (!runDir) return [];
  const sum = await summarizeRun(runDir);
  if (!sum) return [];
  return [{
    name: basenameOf(runDir),
    dir: resolveDir(runDir),
    runDir: resolveDir(runDir),
    threads: [sum],
  }];
}

// ── fleet discovery: the SAME registered repos the GUI shows, mapped to the App's namespace list ──────
// With NO `<rundir>`, the TUI monitors the whole FLEET. `buildSnapshot(loadRegistry())` (the ONE fleet
// builder the GUI also consumes) returns products → namespaces(workflows) → threads(ThreadRow). We FLATTEN
// every product's namespaces into one flat list in the EXACT shape `components.mjs`'s App iterates —
// `{ name, dir, runDir, threads:[ThreadRow] }` — keeping every namespace and every thread. Each thread is a
// shared ThreadRow that already carries its OWN absolute `runDir`, so drilling in opens THAT run via the
// existing buildModel/subscribeRun path (which read `thread.runDir`, not the namespace's). The namespace
// `dir`/`runDir` (used by the App only for the export path + the file-overlay base) is the product `root`.
export async function discoverFleet() {
  let snapshot;
  try { snapshot = await buildSnapshot(loadRegistry()); }
  catch { return []; }
  const out = [];
  for (const product of snapshot.products || []) {
    for (const ns of product.namespaces || []) {
      // Disambiguate same-named namespaces across products in the picker (e.g. two repos with `unfiled`).
      const multi = (snapshot.products || []).length > 1;
      out.push({
        name: multi ? `${product.name}/${ns.name}` : ns.name,
        dir: product.root,
        runDir: product.root,
        threads: ns.threads || [],
      });
    }
  }
  return out;
}

// path helpers kept local (no node:path import gymnastics; the run dir is already absolute from pi-tui).
function resolveDir(p) { return p; }
function basenameOf(p) {
  const parts = String(p).split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  return last === '.pi' ? parts[parts.length - 2] || last : last;
}
