// ── packages/tui/model.mjs ───────────────────────────────────────────────────────
// The renderer-AGNOSTIC data layer for visualizing ONE pi-flow run — now a THIN ADAPTER over the SHARED
// observability source (`@piflow/core/observe`). It reads the run through `readRunModel(runDir)` — the
// ONE reader the CLI, the TUI, and a future GUI all share — and subscribes to `watchRun(runDir)` for
// the live tail. There is NO bespoke `.pi/` reader here anymore: status derivation, stage/lane
// reconstruction, and the io-derived data-flow edges all live in the shared source; this file only
// MAPS the shared `RunModel` into the view shape the renderers (components.mjs / dag.mjs) already
// consume, and DERIVES the cosmetic live extras (the running-node text tail) from the streamed
// `node-event` PiEvents — never by re-reading `.pi/` files.
//
// Fields the shared `RunModel` does not (yet) carry — Gantt start/end timestamps, per-node token/cost
// counts, tool breakdown, thinking-char totals — are rendered as null/blank (the view null-guards them)
// or, where they have a streamed source, accumulated from the live `node-event` stream. They are FLAGGED
// as proposed `RunModel` extensions rather than re-derived by forking a second reader.
import { readRunModel, watchRun } from '@piflow/core';

// ── snapshot: readRunModel → the legacy buildModel() view shape ──────────────────────
// `RunModel` (the shared snapshot) is a SUPERSET of what the view needs for structure (nodes with
// derived status + stageIndex/lane, the stage spine, the io-derived edges). We re-key its `nodes` array
// into the `{id: node}` map the renderers index, and reconstruct each node's io.inputs/outputs from the
// shared `edges` (a write of A that B reads back = edge A→B) so the per-node inspector + the DAG still
// draw the data flow. One definition of "the truth", many views.
export async function buildModel({ runDir, run } = {}) {
  let model;
  try { model = await readRunModel(runDir); }
  catch { return emptyModel(run); }
  return adaptModel(model, run);
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
        if (u.kind === 'snapshot') { onModel?.(adaptModel(u.model, run)); }
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
  return {
    run: m.run, runDir, statusPath: runDir,
    state: m.done ? (m.ok === false ? 'failed' : 'done') : 'running',
    done: !!m.done, ok: m.ok ?? null,
    stageIndex: m.stage?.index ?? null, stageTotal: m.stage?.total ?? null, phase: null,
    runningNode: running?.id || null, runningTool: null, runningStalled: false,
    nodesDone, nodesTotal: nodes.length,
    frac: m.done ? 1 : (nodes.length ? nodesDone / nodes.length : 0),
    elapsedMs: m.durationMs ?? null,
    tokensBillable: 0, cost: 0,
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
