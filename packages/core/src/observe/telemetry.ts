// telemetry.ts — THE agent-facing projection over observe. This is NOT a second collector: it reads the
// run-view observe already builds (runView.ts) and projects the DECISION-GRADE subset a debugging /
// self-improving agent needs — verdicts, the cost spine, loop signals, and failure-onset localization —
// while dropping the human-view furniture (timeline spans, scope buckets, read previews, lane geometry).
//
// TWO MODES, ONE span vocabulary (the record is the FOLD of the stream, the LangSmith/OTel pattern):
//   • RECORD — projectRunDigest(view): the authoritative one-shot RunDigest (the `inspect` view).
//   • STREAM — telemetryStream(watchRun(dir)): TelemetryEvent deltas as the run advances (the `logs -f`
//              / `stats` view), at a chosen verbosity. Anomalies are EDGE-TRIGGERED — emitted the moment
//              a node first crosses a threshold, not on a heartbeat — so a watching agent stays lean.
//
// Field names track the OTel `gen_ai.*` semantic conventions; `toGenAiAttributes` ships a node digest to
// any OTLP backend (LangSmith / Langfuse / Datadog) with no re-shaping.

import type { RunView, RunViewNode } from './runView.js';
import type { RunUpdate } from './types.js';
import { createNodeAccumulator, type LiveMetrics } from './distill.js';
import { loadModelCatalog, contextWindowFor, type ModelCatalog } from './models.js';

// ── thresholds — the tail-sampling triggers (research: keep errors + anomalies, not keep-all) ──────────
export interface TelemetryThresholds {
  /** context-pressure fires at contextPeak / contextWindow ≥ this (0–1). */
  contextPct: number;
  /** tool-loop fires when one tool ran with identical args ≥ this many times. */
  toolRepeat: number;
  /** slow fires when durationMs ≥ this × the cross-run mean (record mode only — needs history). */
  slowRatio: number;
  /** retries fires at this many provider rate-limit/overload retries. */
  retries: number;
}
export const DEFAULT_THRESHOLDS: TelemetryThresholds = { contextPct: 0.85, toolRepeat: 3, slowRatio: 2, retries: 2 };

export type AnomalyKind = 'failed' | 'truncated' | 'context-pressure' | 'tool-loop' | 'slow' | 'retries';

/** One reason a node is worth the agent's attention — the worklist item, with the value/bar it crossed. */
export interface Anomaly {
  kind: AnomalyKind;
  nodeId: string;
  /** one-line, agent-readable (e.g. "auth-verify truncated (stopReason=max_tokens)"). */
  detail: string;
  value?: number;
  threshold?: number;
}

/** Per-node decision-grade digest — the projection of RunViewNode, view furniture stripped. */
export interface NodeDigest {
  id: string;
  label: string;
  phase: string | null;
  agentType?: string;
  /** the derived (verified-not-trusted) status: ok | reused | running | blocked | error | … */
  outcome: string;
  model: string | null;
  provider: string | null;
  // timing
  durationMs: number | null;
  expectedMs: number | null;
  /** durationMs / expectedMs (>1 = slower than the cross-run mean); null without history. */
  slowRatio: number | null;
  // cost spine (the five gen_ai.* attributes do 80% of the work)
  inputTokens: number;
  outputTokens: number;
  cost: number;
  contextPeak: number;
  contextWindow: number | null;
  /** contextPeak / contextWindow (0–1); null when the window is unknown. */
  contextPct: number | null;
  // behaviour / loop signals
  modelCalls: number;
  toolCalls: number;
  topTools: Record<string, number>;
  maxToolRepeat: number;
  repeatedTool: string | null;
  retries: number;
  stopReason: string | null;
  truncated: boolean;
  // failure surface
  missing: string[];
  issues: string[];
  /** which thresholds this node tripped (the per-node anomaly kinds). */
  anomalies: AnomalyKind[];
}

/** Failure-onset localization: the earliest decisive upstream node for a failure, via the file-flow DAG. */
export interface RootCause {
  /** the failed node. */
  failed: string;
  /** the earliest upstream node that is itself failed (= where the chain started); === `failed` if the
   *  failure originates here (no failed ancestor). */
  earliestUpstream: string;
  /** the file on the first hop out of `earliestUpstream` (the data link that propagated the failure). */
  viaPath: string;
  /** the node path earliestUpstream → … → failed. */
  chain: string[];
}

/** Run-level digest — the record. The agent's single read for "how did this run go + where to look". */
export interface RunDigest {
  run: string;
  source?: string;
  done: boolean;
  ok: boolean | null;
  durationMs: number | null;
  totals: {
    nodes: number;
    ok: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    contextPeak: number;
    modelCalls: number;
    toolCalls: number;
  };
  nodes: NodeDigest[];
  /** the tail-sampled attention list across all nodes — the agent's worklist, highest-signal first. */
  anomalies: Anomaly[];
  /** failure-onset localization for every failed node (empty when the run is clean). */
  rootCauses: RootCause[];
}

// ── normalized projection input — the ONE shape both drivers (record + stream) feed projectNode ─────────
interface NodeMetrics {
  id: string;
  label: string;
  phase: string | null;
  agentType?: string;
  status: string;
  durationMs: number | null;
  expectedMs: number | null;
  priorSamples: number;
  model: string | null;
  provider: string | null;
  contextWindow: number | null;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  contextPeak: number;
  modelCalls: number;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  maxToolRepeat: number;
  repeatedTool: string | null;
  retries: number;
  stopReason: string | null;
  truncated: boolean;
  missing: string[];
  issues: string[];
}

const isFailed = (status: string): boolean => status === 'blocked' || status === 'error';

/** Detect which thresholds a node tripped — pure over its metrics. */
function detectAnomalies(m: NodeMetrics, th: TelemetryThresholds): Anomaly[] {
  const out: Anomaly[] = [];
  if (isFailed(m.status)) {
    const why = m.missing.length ? `blocked: missing ${m.missing.join(', ')}` : `${m.status}`;
    out.push({ kind: 'failed', nodeId: m.id, detail: why });
  }
  if (m.truncated) {
    out.push({ kind: 'truncated', nodeId: m.id, detail: `output truncated (stopReason=${m.stopReason})` });
  }
  const pct = m.contextWindow && m.contextWindow > 0 ? m.contextPeak / m.contextWindow : null;
  if (pct != null && pct >= th.contextPct) {
    out.push({ kind: 'context-pressure', nodeId: m.id, detail: `context ${Math.round(pct * 100)}% of ${m.contextWindow} (peak ${m.contextPeak})`, value: pct, threshold: th.contextPct });
  }
  if (m.maxToolRepeat >= th.toolRepeat) {
    out.push({ kind: 'tool-loop', nodeId: m.id, detail: `${m.repeatedTool} called ${m.maxToolRepeat}× with identical args`, value: m.maxToolRepeat, threshold: th.toolRepeat });
  }
  // slow needs a real cross-run mean (priorSamples>0) — else expectedMs is just this run's own duration.
  if (m.priorSamples > 0 && m.durationMs != null && m.expectedMs && m.expectedMs > 0) {
    const ratio = m.durationMs / m.expectedMs;
    if (ratio >= th.slowRatio) out.push({ kind: 'slow', nodeId: m.id, detail: `${m.durationMs}ms vs ${m.expectedMs}ms mean (${ratio.toFixed(1)}×)`, value: ratio, threshold: th.slowRatio });
  }
  if (m.retries >= th.retries) {
    out.push({ kind: 'retries', nodeId: m.id, detail: `${m.retries} provider retries`, value: m.retries, threshold: th.retries });
  }
  return out;
}

/** Project one node's metrics → its digest (+ the full anomalies it tripped). Pure. */
function projectNode(m: NodeMetrics, th: TelemetryThresholds): { digest: NodeDigest; anomalies: Anomaly[] } {
  const anomalies = detectAnomalies(m, th);
  const slowRatio = m.priorSamples > 0 && m.durationMs != null && m.expectedMs ? m.durationMs / m.expectedMs : null;
  const contextPct = m.contextWindow && m.contextWindow > 0 ? m.contextPeak / m.contextWindow : null;
  const digest: NodeDigest = {
    id: m.id,
    label: m.label,
    phase: m.phase,
    ...(m.agentType ? { agentType: m.agentType } : {}),
    outcome: m.status,
    model: m.model,
    provider: m.provider,
    durationMs: m.durationMs,
    expectedMs: m.expectedMs,
    slowRatio,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cost: m.cost,
    contextPeak: m.contextPeak,
    contextWindow: m.contextWindow,
    contextPct,
    modelCalls: m.modelCalls,
    toolCalls: m.toolCalls,
    topTools: m.toolBreakdown,
    maxToolRepeat: m.maxToolRepeat,
    repeatedTool: m.repeatedTool,
    retries: m.retries,
    stopReason: m.stopReason,
    truncated: m.truncated,
    missing: m.missing,
    issues: m.issues,
    anomalies: anomalies.map((a) => a.kind),
  };
  return { digest, anomalies };
}

function metricsFromView(n: RunViewNode): NodeMetrics {
  const t = n.tokens;
  return {
    id: n.id,
    label: n.label,
    phase: n.phase,
    ...(n.agentType ? { agentType: n.agentType } : {}),
    status: n.status,
    durationMs: n.durationMs ?? null,
    expectedMs: n.expectedMs ?? null,
    priorSamples: n.priorSamples ?? 0,
    model: n.model ?? null,
    provider: n.provider ?? null,
    contextWindow: n.contextWindow ?? null,
    inputTokens: t?.input ?? 0,
    outputTokens: t?.output ?? 0,
    cost: t?.cost ?? 0,
    contextPeak: t?.contextPeak ?? 0,
    modelCalls: n.modelCalls ?? 0,
    toolCalls: n.toolCalls ?? 0,
    toolBreakdown: n.toolBreakdown ?? {},
    maxToolRepeat: n.maxToolRepeat ?? 0,
    repeatedTool: n.repeatedTool ?? null,
    retries: n.retries ?? 0,
    stopReason: n.stopReason ?? null,
    truncated: !!n.truncated,
    missing: [], // a RunViewNode that ran clean carries no missing list; failure surface comes via status
    issues: n.issues ?? [],
  };
}

// ── failure-onset localization — walk the file-flow DAG backward from each failure ─────────────────────
function localizeRootCauses(view: RunView): RootCause[] {
  const failed = new Set(view.nodes.filter((n) => isFailed(n.status)).map((n) => n.id));
  if (failed.size === 0) return [];
  const stageOf = new Map(view.nodes.map((n) => [n.id, n.stageIndex ?? 0]));
  // reverse adjacency: for a node, the upstream nodes that wrote a file it read.
  const up = new Map<string, { from: string; path: string }[]>();
  for (const e of view.edges) (up.get(e.to) ?? up.set(e.to, []).get(e.to)!).push({ from: e.from, path: e.path });

  const out: RootCause[] = [];
  for (const f of failed) {
    // BFS upstream, recording for each discovered ancestor the downstream child + edge path it reached via.
    const via = new Map<string, { child: string; path: string }>();
    const seen = new Set([f]);
    const queue = [f];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const { from, path } of up.get(cur) ?? []) {
        if (seen.has(from)) continue;
        seen.add(from);
        via.set(from, { child: cur, path });
        queue.push(from);
      }
    }
    // candidates = upstream ancestors that are THEMSELVES failed; the earliest by stage is the onset.
    const cands = [...seen].filter((id) => id !== f && failed.has(id));
    let origin = f;
    if (cands.length) origin = cands.reduce((a, b) => ((stageOf.get(a) ?? 0) <= (stageOf.get(b) ?? 0) ? a : b));
    // reconstruct origin → … → f by following the downstream pointers from origin.
    const chain = [origin];
    let firstHop = '';
    let cur = origin;
    while (cur !== f) {
      const step = via.get(cur);
      if (!step) break; // origin === f (no failed ancestor) or a broken pointer
      if (cur === origin) firstHop = step.path;
      chain.push(step.child);
      cur = step.child;
    }
    out.push({ failed: f, earliestUpstream: origin, viaPath: firstHop, chain });
  }
  return out;
}

/** RECORD mode: project a built run-view → the authoritative RunDigest. Pure. */
export function projectRunDigest(view: RunView, opts: { thresholds?: Partial<TelemetryThresholds> } = {}): RunDigest {
  const th = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const nodes: NodeDigest[] = [];
  const anomalies: Anomaly[] = [];
  for (const n of view.nodes) {
    const { digest, anomalies: a } = projectNode(metricsFromView(n), th);
    nodes.push(digest);
    anomalies.push(...a);
  }
  const totals = nodes.reduce(
    (acc, n) => {
      acc.inputTokens += n.inputTokens;
      acc.outputTokens += n.outputTokens;
      acc.cost += n.cost;
      acc.modelCalls += n.modelCalls;
      acc.toolCalls += n.toolCalls;
      acc.contextPeak = Math.max(acc.contextPeak, n.contextPeak);
      if (isFailed(n.outcome)) acc.failed += 1;
      else if (n.outcome === 'ok' || n.outcome === 'reused') acc.ok += 1;
      return acc;
    },
    { nodes: nodes.length, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0, contextPeak: 0, modelCalls: 0, toolCalls: 0 },
  );
  return {
    run: view.run,
    source: view.source,
    done: !!view.done,
    ok: view.ok ?? null,
    durationMs: view.durationMs ?? null,
    totals,
    nodes,
    anomalies: rankAnomalies(anomalies),
    rootCauses: localizeRootCauses(view),
  };
}

/** Order the worklist: failures first, then truncation, loops, context pressure, slow, retries. */
const ANOMALY_RANK: Record<AnomalyKind, number> = { failed: 0, truncated: 1, 'tool-loop': 2, 'context-pressure': 3, slow: 4, retries: 5 };
function rankAnomalies(a: Anomaly[]): Anomaly[] {
  return [...a].sort((x, y) => ANOMALY_RANK[x.kind] - ANOMALY_RANK[y.kind]);
}

// ── STREAM mode — the live span vocabulary (record = fold of these) ────────────────────────────────────
export type TelemetryEvent =
  | { kind: 'run-start'; run: string }
  | { kind: 'node-open'; nodeId: string; label: string; phase: string | null; model: string | null }
  | { kind: 'call'; nodeId: string; op: 'chat' | 'tool'; name: string; ok: boolean; durMs?: number } // verbose only
  | { kind: 'anomaly'; anomaly: Anomaly }
  | { kind: 'node-close'; digest: NodeDigest }
  | { kind: 'run-end'; ok: boolean | null };

export type Verbosity = 'important' | 'verbose';

export interface StreamOpts {
  /** 'important' (default): verdicts + anomalies + failures. 'verbose': also per chat/tool `call` events. */
  verbosity?: Verbosity;
  thresholds?: Partial<TelemetryThresholds>;
  catalog?: ModelCatalog;
}

const TERMINAL = new Set(['ok', 'reused', 'gap', 'blocked', 'error', 'dry']);

/**
 * STREAM mode: fold a `watchRun` update stream into agent-facing telemetry deltas. Anomalies are
 * EDGE-TRIGGERED (emitted once, the moment a node first crosses a threshold). Live-only differences vs
 * the record: the `slow` anomaly needs cross-run history so it never fires here, and a node-close digest's
 * durationMs/missing are best-effort from the opening snapshot (tokens/loops/anomalies are fresh). The
 * authoritative record is `projectRunDigest(buildRunView(dir))` once the run is done.
 */
export async function* telemetryStream(updates: AsyncIterable<RunUpdate>, opts: StreamOpts = {}): AsyncIterable<TelemetryEvent> {
  const th = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const verbose = opts.verbosity === 'verbose';
  const catalog = opts.catalog ?? loadModelCatalog();

  const accs = new Map<string, ReturnType<typeof createNodeAccumulator>>();
  const snap = new Map<string, { label: string; phase: string | null; agentType?: string; missing: string[]; durationMs: number | null; stageIndex?: number }>();
  const emitted = new Map<string, Set<AnomalyKind>>(); // anomaly kinds already announced per node
  const opened = new Set<string>();
  const closed = new Set<string>();
  let anyFailed = false;

  const accOf = (id: string) => accs.get(id) ?? accs.set(id, createNodeAccumulator()).get(id)!;
  const emitOf = (id: string) => emitted.get(id) ?? emitted.set(id, new Set()).get(id)!;

  // build NodeMetrics from a node's live accumulator + its snapshot row + the given status.
  const liveMetrics = (id: string, status: string): NodeMetrics => {
    const lm: LiveMetrics = accOf(id).metrics();
    const s = snap.get(id);
    const cw = lm.model ? contextWindowFor(lm.model, catalog) : null;
    return {
      id,
      label: s?.label ?? id,
      phase: s?.phase ?? null,
      ...(s?.agentType ? { agentType: s.agentType } : {}),
      status,
      durationMs: s?.durationMs ?? null,
      expectedMs: null,
      priorSamples: 0,
      model: lm.model,
      provider: lm.provider,
      contextWindow: cw,
      inputTokens: lm.tokens.input,
      outputTokens: lm.tokens.output,
      cost: lm.tokens.cost,
      contextPeak: lm.tokens.contextPeak,
      modelCalls: lm.modelCalls,
      toolCalls: lm.toolCalls,
      toolBreakdown: {}, // not needed for live anomaly checks; the record digest carries the breakdown
      maxToolRepeat: lm.maxToolRepeat,
      repeatedTool: lm.repeatedTool,
      retries: lm.retries,
      stopReason: lm.stopReason,
      truncated: lm.truncated,
      missing: s?.missing ?? [],
      issues: [],
    };
  };

  // detect newly-crossed anomalies for a node and yield each ONCE.
  function* fireAnomalies(id: string, status: string): Generator<TelemetryEvent> {
    const set = emitOf(id);
    for (const a of detectAnomalies(liveMetrics(id, status), th)) {
      if (set.has(a.kind)) continue;
      set.add(a.kind);
      yield { kind: 'anomaly', anomaly: a };
    }
  }

  function* openIfNeeded(id: string): Generator<TelemetryEvent> {
    if (opened.has(id)) return;
    opened.add(id);
    const lm = accOf(id).metrics();
    const s = snap.get(id);
    yield { kind: 'node-open', nodeId: id, label: s?.label ?? id, phase: s?.phase ?? null, model: lm.model };
  }

  for await (const u of updates) {
    if (u.kind === 'snapshot') {
      yield { kind: 'run-start', run: u.model.run };
      for (const n of u.model.nodes) {
        snap.set(n.id, { label: n.label, phase: n.phase, agentType: n.agentType, missing: n.missing ?? [], durationMs: n.durationMs ?? null, stageIndex: n.stageIndex });
        if (n.status === 'running') yield* openIfNeeded(n.id);
        if (TERMINAL.has(n.status)) { /* already-done node from a late attach — closed below at done */ }
      }
    } else if (u.kind === 'node-event') {
      accOf(u.id).push(u.event);
      yield* openIfNeeded(u.id);
      if (verbose) {
        const t = u.event.type as string;
        if (t === 'message_end') yield { kind: 'call', nodeId: u.id, op: 'chat', name: 'chat', ok: true };
        else if (t === 'tool_execution_end') yield { kind: 'call', nodeId: u.id, op: 'tool', name: 'tool', ok: !(u.event.isError as boolean) };
      }
      // re-check anomalies on every event (edge-triggered emit guards against repeats).
      yield* fireAnomalies(u.id, 'running');
    } else if (u.kind === 'node-status') {
      if (u.status === 'running') yield* openIfNeeded(u.id);
      yield* fireAnomalies(u.id, u.status);
      if (TERMINAL.has(u.status) && !closed.has(u.id)) {
        closed.add(u.id);
        if (isFailed(u.status)) anyFailed = true;
        const { digest } = projectNode(liveMetrics(u.id, u.status), th);
        yield { kind: 'node-close', digest };
      }
    } else if (u.kind === 'done') {
      yield { kind: 'run-end', ok: anyFailed ? false : true };
      return;
    }
  }
}

// ── OTel bridge — project a node digest to gen_ai.* attributes for any OTLP backend ────────────────────
/**
 * Map a node digest to the OpenTelemetry GenAI `invoke_agent` span attributes (+ piflow custom keys for the
 * loop signals). No OTel SDK dependency: returns a plain attribute bag a caller hands to its own exporter.
 */
export function toGenAiAttributes(node: NodeDigest): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.name': node.id,
    'gen_ai.usage.input_tokens': node.inputTokens,
    'gen_ai.usage.output_tokens': node.outputTokens,
    // piflow custom — the agent-self-debug spine the gen_ai namespace doesn't standardize.
    'piflow.node.model_calls': node.modelCalls,
    'piflow.node.tool_calls': node.toolCalls,
    'piflow.node.max_tool_repeat': node.maxToolRepeat,
    'piflow.cost.usd': node.cost,
    'piflow.context.peak_tokens': node.contextPeak,
  };
  if (node.provider) attrs['gen_ai.provider.name'] = node.provider;
  if (node.model) attrs['gen_ai.request.model'] = node.model;
  if (node.stopReason) attrs['gen_ai.response.finish_reasons'] = [node.stopReason];
  if (isFailed(node.outcome)) attrs['error.type'] = node.outcome;
  return attrs;
}
