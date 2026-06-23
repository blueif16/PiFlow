// ── packages/tui/model.mjs ───────────────────────────────────────────────────────
// The renderer-AGNOSTIC data layer for visualizing ONE pi-flow run — MIGRATED from the legacy
// pi-runner viz-model.mjs to the NEW `.pi/` run layout (D7). The view layer (components.mjs / dag.mjs)
// is unchanged: it consumes the SAME buildModel() shape; only the data ACQUISITION moved.
//
// OLD source (legacy out/<id> layout)         NEW source (this file — the .pi/ layout)
//   the run-status digest                   →  <rundir>/.pi/run.json            (runJsonFile)
//   the per-node debug event archive        →  <rundir>/.pi/nodes/<id>/events.jsonl (nodeEventsFile)
//   prompt-text parse for io/data-flow      →  <rundir>/.pi/nodes/<id>/io.json   (nodeIoFile; NodeIo)
//   the global registry + extract.mjs static DAG  →  GONE — a run dir is self-describing.
//
// All paths come from @piflow/core's layout helpers — NEVER hardcoded. The `.pi/run.json` payload IS a
// RunStatus (packages/core/src/runner/status.ts): { run, nodes: {id: NodeStatusRecord}, done, ok,
// stage, … } — so the status→row mapping ports verbatim; the data-flow edges are now read from the
// structured io ledgers (a write of node A that node B reads back is an edge A→B) instead of parsed
// out of prompt text. One definition of "the truth", many views.
import fs from 'node:fs';
import path from 'node:path';
import { runJsonFile, nodeEventsFile, nodeIoFile } from '@piflow/core';

const ms = (iso) => (iso ? Date.parse(iso) : null);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// ── status read: <rundir>/.pi/run.json ─────────────────────────────────────────────
function readStatus(runDir) {
  return readJson(runJsonFile(runDir));
}

// ── io ledger read: <rundir>/.pi/nodes/<id>/io.json (NodeIo) ─────────────────────────
function readNodeIo(runDir, id) {
  return readJson(nodeIoFile(runDir, id));
}

// Best-effort partial OUTPUT text for a running (or finished) node — reconstructs the assistant text
// from the slimmed events.jsonl delta stream (DEBUG runs only; returns null otherwise — the UI then
// falls back to the digest's char-count + currentTool). MIGRATED to <rundir>/.pi/nodes/<id>/events.jsonl.
export function tailNodeOutput({ runDir, node, maxChars = 1200 } = {}) {
  if (!node || !runDir) return null;
  let raw;
  try { raw = fs.readFileSync(nodeEventsFile(runDir, node), 'utf8'); } catch { return null; }
  let text = '';
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const a = ev?.assistantMessageEvent || ev?.event || ev;
    const d = a?.delta;
    if (ev?.type === 'message_update' && (a?.type === 'text_delta' || a?.type === 'content_delta') && typeof d === 'string') text += d;
  }
  if (!text) return null;
  return { node, chars: text.length, tail: text.slice(-maxChars) };
}

// ── stages from the run status ───────────────────────────────────────────────────────
// A run dir is self-describing: there is no separate static DAG to join. We reconstruct the stage spine
// the way the legacy fallback did — group nodes into stages, keeping the in-file node ORDER, and treat
// the live `stage.nodeIds` (the parallel barrier the engine last published) as one parallel lane-set so
// concurrently-running siblings render side-by-side. Every node lands in exactly one stage.
function buildStages(s, nodes) {
  const order = Object.keys(nodes);
  const stages = [];
  const placed = new Set();
  // The currently-/last-active parallel stage, if the engine published one.
  const barrier = (s?.stage?.nodeIds || []).filter((id) => id in nodes);
  const barrierSet = new Set(barrier);

  let cur = null;
  for (const id of order) {
    if (barrierSet.has(id)) continue; // the barrier nodes group together (placed below), in barrier order
    cur = { index: stages.length + 1, phase: nodes[id].phase || null, parallel: false, nodeIds: [id] };
    stages.push(cur);
    placed.add(id);
  }
  if (barrier.length) {
    const idx = stages.length + 1;
    stages.push({ index: idx, phase: nodes[barrier[0]].phase || null, parallel: barrier.length > 1, nodeIds: barrier });
    for (const id of barrier) placed.add(id);
  }
  // re-index + stamp stageIndex/lane onto the nodes.
  stages.forEach((st, i) => {
    st.index = i + 1;
    st.parallel = st.nodeIds.length > 1;
    st.nodeIds.forEach((id, lane) => { nodes[id].stageIndex = st.index; nodes[id].lane = lane; });
  });
  return stages;
}

// THE join. Reads <rundir>/.pi/run.json + the per-node io ledgers and produces the buildModel() shape
// the renderers (components.mjs / dag.mjs) already consume — IDENTICAL contract to the legacy.
export async function buildModel({ runDir, run } = {}) {
  const s = readStatus(runDir);
  const now = Date.now();

  // 1) NODES — straight from .pi/run.json (NodeStatusRecord), order-preserving.
  const nodes = {};
  for (const [id, rt] of Object.entries(s?.nodes || {})) {
    const startMs = ms(rt.startedAt);
    const endMs = ms(rt.endedAt) || (rt.status === 'running' ? now : null);
    nodes[id] = {
      id,
      label: rt.label || id,
      phase: rt.phase || null,
      agentType: rt.agentType || null,
      hasSchema: !!rt.checks || !!rt.schemaChecked,
      stageIndex: null, lane: 0,
      status: rt.status || 'pending',
      startedAt: rt.startedAt || null, endedAt: rt.endedAt || null,
      durationMs: rt.durationMs ?? (startMs && endMs ? endMs - startMs : null),
      startMs, endMs,
      tokens: rt.tokens || null,
      toolCalls: rt.toolCalls ?? 0,
      toolBreakdown: rt.toolBreakdown || null,
      thinking: rt.thinking || null,
      eventCount: rt.eventCount ?? 0,
      artifacts: rt.artifacts || null,
      issues: rt.issues || [],
      summary: rt.summary || null,
      pipelineFindings: rt.pipelineFindings || [],
      attempts: rt.attempts || null,
      escalated: !!rt.escalated,
      live: rt.live || null,
    };
  }

  // 2) STAGES + lanes (self-describing run dir; no static DAG to join).
  const stages = buildStages(s, nodes);

  // 3) IO + file-level data flow — from the per-node io.json ledgers (NodeIo: reads/writes), NOT prompt
  //    text. An io write of node A that another node B READS back is the data-flow edge A→B (the engine's
  //    only hard guarantee — nodes coordinate through files). Map NodeIo → the visual's io shape.
  const ioById = {};
  for (const id of Object.keys(nodes)) ioById[id] = readNodeIo(runDir, id);
  const labelOf = (id) => nodes[id]?.label || id;
  const descOf = (id) => ioById[id]?.phase || nodes[id]?.phase || null;
  const baseName = (p) => String(p ?? '').split('/').pop();

  // producer index: which node WROTE each path (first writer wins).
  const writerOf = {};
  for (const id of Object.keys(nodes)) {
    for (const w of (ioById[id]?.writes || [])) if (w?.path && !(w.path in writerOf)) writerOf[w.path] = id;
  }
  // consumer index: which nodes READ each path.
  const readersOf = {};
  for (const id of Object.keys(nodes)) {
    for (const r of (ioById[id]?.reads || [])) {
      if (!r?.path) continue;
      (readersOf[r.path] ||= []).push(id);
    }
  }

  for (const id of Object.keys(nodes)) {
    const node = nodes[id];
    const io = ioById[id];
    node.description = descOf(id);
    if (!io) { node.io = { description: node.description, inputs: [], outputs: [], produced: [] }; continue; }

    // INPUTS — each read whose producer we know becomes an edge from that producer.
    const inputs = (io.reads || []).map((r) => {
      const fromNode = writerOf[r.path] && writerOf[r.path] !== id ? writerOf[r.path] : null;
      return {
        rel: r.path,
        fromNode, fromLabel: fromNode ? labelOf(fromNode) : (r.via || 'input'),
        functionality: fromNode ? descOf(fromNode) : null,
        exists: null, bytes: null, path: null,
      };
    });
    // OUTPUTS — each declared write + which downstream nodes read it.
    const outputs = (io.writes || []).map((w) => {
      const consumers = (readersOf[w.path] || []).filter((oid) => oid !== id);
      return {
        rel: w.path,
        toNodes: consumers, toLabels: consumers.map(labelOf),
        functionality: node.description,
        exists: w.verified ?? null, bytes: w.bytes ?? null, path: w.path,
      };
    });
    // PRODUCED — every file the run actually wrote (run-status artifacts), keyed by path; all openable.
    const produced = (node.artifacts || []).map((a) => ({
      rel: a.path, exists: !!a.exists, bytes: a.bytes ?? a.size ?? null, path: a.path,
    })).filter((p) => p.rel);

    node.io = {
      description: node.description, projectDir: null, skill: null,
      inputs, outputs, produced,
      externalReads: [],
      owns: (io.writes || []).map((w) => baseName(w.path)),
      note: null,
    };
  }

  // 4) DERIVED — Gantt timeline + stage durations + pathways (all reconstructed, none persisted).
  const startMsList = Object.values(nodes).map((n) => n.startMs).filter(Boolean);
  const runStart = ms(s?.startedAt) || (startMsList.length ? Math.min(...startMsList) : now);
  const runEnd = s?.done ? (ms(s.updatedAt) || now) : now;
  const timeline = {
    t0: Number.isFinite(runStart) ? runStart : now,
    t1: Number.isFinite(runEnd) ? runEnd : now,
    rows: Object.values(nodes)
      .filter((n) => n.startMs)
      .map((n) => ({ id: n.id, stageIndex: n.stageIndex, lane: n.lane, status: n.status, startMs: n.startMs, endMs: n.endMs || now, durationMs: n.durationMs })),
  };
  const stageTimes = stages.map((st) => {
    const ns = st.nodeIds.map((id) => nodes[id]).filter((n) => n && n.startMs);
    const start = ns.length ? Math.min(...ns.map((n) => n.startMs)) : null;
    const end = ns.length ? Math.max(...ns.map((n) => n.endMs || now)) : null;
    return { index: st.index, durationMs: start && end ? end - start : null };
  });

  const pathways = {
    halted: s?.done === true && s?.ok === false,
    haltNode: Object.values(nodes).find((n) => n.status === 'error' || n.status === 'blocked')?.id || null,
    reused: Object.values(nodes).filter((n) => n.status === 'reused').map((n) => n.id),
    pending: Object.values(nodes).filter((n) => n.status === 'pending').map((n) => n.id),
    running: Object.values(nodes).filter((n) => n.status === 'running').map((n) => n.id),
    escalated: Object.values(nodes).filter((n) => n.escalated).map((n) => n.id),
  };

  const totals = s?.totals || {
    nodes: Object.keys(nodes).length,
    toolCalls: Object.values(nodes).reduce((a, n) => a + (n.toolCalls || 0), 0),
    tokensBillable: Object.values(nodes).reduce((a, n) => a + (n.tokens?.billable || 0), 0),
  };
  const cost = Object.values(nodes).reduce((a, n) => a + (n.tokens?.cost || 0), 0);

  return {
    run: {
      id: s?.run || run || null,
      source: s?.source || null,
      provider: s?.provider || null, model: s?.model || null,
      done: !!s?.done, ok: s?.ok ?? null,
      debug: !!s?.debug, sandbox: !!s?.sandbox, escalate: s?.escalate || false,
      startedAt: s?.startedAt || null, updatedAt: s?.updatedAt || null,
      elapsedMs: s?.elapsedMs ?? null, durationMs: s?.durationMs ?? null,
      stage: s?.stage || null,
      staleMs: s?.updatedAt ? now - ms(s.updatedAt) : null,
      missing: !s,
      extractErr: null,
    },
    stages, stageTimes, nodes, timeline, pathways,
    totals: { ...totals, cost },
  };
}

// ── single-run "discovery": a run dir is one namespace with one thread ───────────────────────────────
// The legacy registry/scan/namespace machinery is gone — `piflow-tui <rundir>` monitors ONE run. We
// keep the namespace→thread→detail SHAPE the view layer expects (so components.mjs is unchanged) by
// projecting the single run dir into a one-namespace / one-thread list.
const TERMINAL_OK = new Set(['ok', 'reused', 'gap', 'dry']);
export function summarizeRun(runDir) {
  const s = readStatus(runDir);
  if (!s) return null;
  const nodes = Object.values(s.nodes || {});
  const nodesDone = nodes.filter((n) => TERMINAL_OK.has(n.status)).length;
  const running = nodes.find((n) => n.status === 'running');
  const updatedMs = ms(s.updatedAt);
  const now = Date.now();
  return {
    // `statusPath` is the thread's unique KEY in the view layer (selection/cache keying, unchanged from
    // the legacy); for a `.pi/` run that key IS the run dir. `runDir` is the data-read root.
    run: s.run, runDir, statusPath: runDir,
    state: s.done ? (s.ok === false ? 'failed' : 'done') : 'running',
    done: !!s.done, ok: s.ok ?? null,
    stageIndex: s.stage?.index ?? null, stageTotal: s.stage?.total ?? null, phase: s.stage?.phase ?? null,
    runningNode: running?.id || null, runningTool: running?.live?.currentTool || null, runningStalled: !!running?.live?.stalled,
    nodesDone, nodesTotal: nodes.length,
    frac: s.done ? 1 : (nodes.length ? nodesDone / nodes.length : 0),
    elapsedMs: s.done ? (s.durationMs ?? s.elapsedMs) : (s.elapsedMs ?? null),
    tokensBillable: nodes.reduce((a, n) => a + (n.tokens?.billable || 0), 0),
    cost: nodes.reduce((a, n) => a + (n.tokens?.cost || 0), 0),
    provider: s.provider || null, model: s.model || null,
    updatedAt: s.updatedAt || null, staleMs: updatedMs ? now - updatedMs : null,
    errorNode: nodes.find((n) => n.status === 'error' || n.status === 'blocked')?.id || null,
  };
}

// Project the single run dir → the namespace list the view layer iterates. The "thread" carries the
// runDir so refresh()/buildModel read straight from it (no statusPath, no out/ convention).
export function discoverNamespaces({ runDir } = {}) {
  if (!runDir) return [];
  const sum = summarizeRun(runDir);
  if (!sum) return [];
  return [{
    name: path.basename(path.dirname(runDir)) === '.pi' ? path.basename(runDir) : path.basename(path.resolve(runDir, '..')),
    dir: path.resolve(runDir),
    runDir: path.resolve(runDir),
    threads: [sum],
  }];
}
