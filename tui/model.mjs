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
import { readRunModel, watchRun } from '@piflow/core';
import { pathToFileURL, fileURLToPath } from 'node:url';
import nodePath from 'node:path';

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
  // STRUCTURE from the lean snapshot: status/stage/lane + the io.json-DERIVED data-flow edges. (The rich
  // `buildRunView` derives edges from events.jsonl writes/reads, which a run may not carry — so the
  // io-ledger edges from `readRunModel` stay the structural source of truth.)
  let model;
  try { model = await readRunModel(runDir); }
  catch { return emptyModel(run); }
  const view = adaptModel(model, run);
  // TELEMETRY overlay: real per-node tokens/ctx/tools from the RICH run-view (the SAME distiller the GUI
  // renders). A no-op when the rich view is unavailable (dist not built / no run.json) — rows then keep
  // the null-rendered telemetry, exactly the prior behaviour.
  const rich = await tryRichView(runDir);
  if (rich) overlayRichTelemetry(view, rich);
  return view;
}

/**
 * Overlay the RICH `RunView` (`buildRunView`) telemetry onto an already-structured view (from
 * `adaptModel`), keyed by node id: `tokens` (the `RunTokens` shape the renderer reads as
 * `n.tokens.contextPeak` / `n.tokens.billable`), `contextWindow`, `model`/`provider`, `toolCalls`,
 * `toolBreakdown`, real Gantt timestamps, and the run-level token/cost/toolCall rollups. Structure
 * (status, stages, io edges) is left untouched. Mutates `view` in place. The live `node-event` overlay
 * (foldLiveIntoModel) still wins for the running node (it OR-folds over these snapshot values).
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
  // take them (and each node's stageIndex/lane) as the layout. Edges stay the io.json-derived ones from
  // readRunModel that the per-node inspector reads.
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
  if (rich.model && view.run.model == null) view.run.model = rich.model;
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
// one-thread list — summarized from the SHARED reader (readRunModel), no bespoke `.pi/` read.
const TERMINAL_OK = new Set(['ok', 'reused', 'gap', 'dry']);

/** Summarize a run dir into the thread row the view layer iterates. Async (reads via the shared model). */
export async function summarizeRun(runDir) {
  let m;
  try { m = await readRunModel(runDir); }
  catch { return null; }
  const nodes = m.nodes;
  const nodesDone = nodes.filter((n) => TERMINAL_OK.has(n.status)).length;
  const running = nodes.find((n) => n.status === 'running');
  const errored = nodes.find((n) => n.status === 'error' || n.status === 'blocked');
  // Real run-level token/cost rollup from the rich view (same source the node rows use); 0 if unavailable.
  const view = await tryRichView(runDir);
  const tt = view?.tokenTotal || {};
  return {
    run: m.run, runDir, statusPath: runDir,
    state: m.done ? (m.ok === false ? 'failed' : 'done') : 'running',
    done: !!m.done, ok: m.ok ?? null,
    stageIndex: m.stage?.index ?? null, stageTotal: m.stage?.total ?? null, phase: null,
    runningNode: running?.id || null, runningTool: null, runningStalled: false,
    nodesDone, nodesTotal: nodes.length,
    frac: m.done ? 1 : (nodes.length ? nodesDone / nodes.length : 0),
    elapsedMs: m.durationMs ?? null,
    tokensBillable: tt.billable || 0, cost: tt.cost || 0,
    provider: m.provider || null, model: m.model || null,
    updatedAt: null, staleMs: null,
    errorNode: errored?.id || null,
  };
}

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

// path helpers kept local (no node:path import gymnastics; the run dir is already absolute from pi-tui).
function resolveDir(p) { return p; }
function basenameOf(p) {
  const parts = String(p).split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  return last === '.pi' ? parts[parts.length - 2] || last : last;
}
