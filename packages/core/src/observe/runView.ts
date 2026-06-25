// runView.ts — THE shared run-view builder. Distills one run's `.pi/` tree (run.json + per-node
// events.jsonl + io.json) into the compact, ENRICHED run-view every view renders. Lives in
// @piflow/core/observe (the shared observability home) so the GUI middleware, the TUI, and the CLI all
// build the SAME rich model from the SAME code — no view owns data collection.
//
// It is a SUPERSET of readRunModel (observe/read.ts): that one is the lean live snapshot (status/stage/
// edges from run.json + io.json); this one ALSO replays each node's events.jsonl through the shared
// reducer (./distill.ts) for model/provider, tokens/contextPeak, toolBreakdown, per-tool timeline,
// scope-bucketed reads, and writes — and stamps each node's `contextWindow` from pi's native registry
// (./models.ts) so the context-pressure bar needs no hardcoded table.
//
// PURE: takes a run dir (+ optional sibling history dirs for the prior-run average, + a workspace root
// for display paths). Returns { view, audit } — `view` is the contract, `audit` is the data-load ledger.

import fssync from 'node:fs';
import path from 'node:path';
import { createNodeAccumulator } from './distill.js';
import { loadModelCatalog, contextWindowFor, type ModelCatalog } from './models.js';
import { checkpointViewFrom, type CheckpointMarker, type CheckpointJournalSlot } from '../runner/checkpoint.js';

export type ScopeKind = 'run' | 'skill' | 'template' | 'package' | 'repo';
export interface ScopeBucket { kind: ScopeKind; label: string; count: number; paths: string[] }
export interface TimelineSpan { name: string; tStartMs: number | null; durMs: number; ok: boolean }
export interface ReadRef { path: string; displayPath: string; via: string; scope: ScopeKind; preview?: string }
export interface WriteRef { path: string; displayPath: string; verified: boolean; bytes?: number }
export interface ArtifactRef { path: string; displayPath: string; exists: boolean; bytes: number }
export interface BashCall { command: string; tStartMs: number | null; durMs?: number }
export interface RunTokens { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextPeak: number; billable: number }

export interface RunViewNode {
  id: string;
  label: string;
  phase: string | null;
  /** (G6) The agent-PRESET label (branding) — the GUI maps it to {icon,label,color} from ~/.piflow/agents/. */
  agentType?: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number | null;
  expectedMs?: number | null;
  priorSamples?: number;
  model?: string | null;
  provider?: string | null;
  api?: string | null;
  /** Pi-native context window for this node's model (tokens) — the context-bar denominator. */
  contextWindow?: number | null;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  timeline: TimelineSpan[];
  reads: ReadRef[];
  scopes: ScopeBucket[];
  writes: WriteRef[];
  artifacts: ArtifactRef[];
  bash: BashCall[];
  tokens?: RunTokens;
  /** provider rate-limit/overload retries (count of `auto_retry_start`) — per-node. */
  retries: number;
  /** the assistant's final `message.stopReason` (null if none seen). */
  stopReason: string | null;
  /** the output was cut off by the token cap (stopReason `'max_tokens'`/`'length'`). */
  truncated: boolean;
  /** total `thinking_delta` characters for this node. */
  thinkingChars: number;
  summary?: string;
  issues?: string[];
  stageIndex?: number;
  lane?: number;
  /**
   * (G5) The human-checkpoint payload — the marker (question) cross-checked against the `__checkpoints__`
   * journal (resolution). Present iff a checkpoint marker exists for this node. When `status` is `pending`
   * the node's `status` reads `awaiting-input` so existing status-driven UI lights up; the GUI's
   * notification points at this node and the reply flows back via the courier endpoint.
   */
  checkpoint?: {
    status: 'pending' | 'resolved';
    kind: 'confirm' | 'input' | 'select';
    prompt: string;
    choices?: string[];
    default?: unknown;
    reply?: unknown;
    askedAt?: string;
    hash: string;
  };
}
export interface RunViewStage { index: number; phase: string; parallel: boolean; nodeIds: string[] }
export interface RunViewEdge { from: string; to: string; path: string }
export interface RunView {
  run: string;
  source?: string;
  provider?: string;
  model?: string | null;
  startedAt?: string;
  updatedAt?: string;
  durationMs?: number | null;
  done?: boolean;
  ok?: boolean | null;
  totals?: { nodes: number; ok: number; failed: number };
  tokenTotal?: RunTokens;
  stages: RunViewStage[];
  edges: RunViewEdge[];
  nodes: RunViewNode[];
}
export interface NodeAudit { id: string; status: string; exists: boolean; bytes: number; lines: number; seen: number; dropped: number; usageEvents: number; billable: number }

export interface BuildRunViewOpts {
  historyDirs?: string[];
  workspaceRoot?: string | null;
  catalog?: ModelCatalog;
  /** The template's declared DAG from piflow init's `workflow.json` — ordered `stages` + per-node `deps`.
   *  When the caller resolves it (the SDK never reaches into the registry itself), the graph's stages and
   *  edges come from this COMPLETE topology, so no declared connection is missing even when a run's
   *  io.json/events are sparse. Absent → structure is derived from the run alone (phase grouping + runtime
   *  file-flow edges). */
  workflow?: { stages?: string[][]; nodes?: Record<string, { phase?: string | null; deps?: string[] }> } | null;
}

// Strip an absolute path to a clean DISPLAY path using the run's two roots. A file inside the run sandbox
// ({{RUN}}) shows relative to it (`spec/blueprint.json`); a file in the shared tree ({{WORKSPACE}}) shows
// relative to it (`packages/skills/...`); anything else falls back to a bare basename. runDir is checked
// FIRST because it nests under workspaceRoot, so a run file never displays as the long `.piflow/.../runs/…`.
function makeDisplayPath(runDir: string | null, workspaceRoot: string | null) {
  const run = runDir ? path.resolve(runDir) : null;
  const ws = workspaceRoot ? path.resolve(workspaceRoot) : null;
  return (abs: unknown): string => {
    if (typeof abs !== 'string') return String(abs);
    if (run && abs.startsWith(run + path.sep)) return abs.slice(run.length + 1);
    if (ws && abs.startsWith(ws + path.sep)) return abs.slice(ws.length + 1);
    if (!abs.startsWith('/')) return abs;
    return abs.replace(/^.*\//, '');
  };
}

// Scope bucket from the WORKSPACE-relative display path. 'run' is detected upstream by {{RUN}} membership
// (run files display run-relative, with no distinguishing prefix), so it is not inferred here.
function scopeKind(dp: string): ScopeKind {
  if (dp.startsWith('packages/skills/')) return 'skill';
  if (dp.startsWith('templates/')) return 'template';
  if (dp.startsWith('packages/')) return 'package';
  return 'repo';
}
const SCOPE_LABEL: Record<ScopeKind, string> = { run: 'Run workspace', skill: 'Skill', template: 'Templates', package: 'Packages', repo: 'Repo source' };
const SCOPE_ORDER: ScopeKind[] = ['run', 'skill', 'template', 'package', 'repo'];

// Replay a node's events.jsonl through the reducer, COUNTING every line + every torn line (the data-load
// ledger: lines == eventsSeen + parseErrors must hold, or events were silently lost).
function replayEvents(runDir: string, id: string) {
  const f = path.join(runDir, '.pi', 'nodes', id, 'events.jsonl');
  const acc = createNodeAccumulator();
  let lines = 0, parseErrors = 0, exists = false, bytes = 0;
  if (fssync.existsSync(f)) {
    exists = true;
    bytes = fssync.statSync(f).size;
    for (const line of fssync.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      try { acc.push(JSON.parse(line)); } catch { parseErrors += 1; }
    }
  }
  return { acc, lines, parseErrors, exists, bytes };
}

// Cross-run history: expectedMs[id] = mean durationMs across history runs that ran node `id`.
function buildHistory(historyDirs: string[]) {
  const dur: Record<string, number[]> = {};
  for (const r of historyDirs) {
    const rjFile = path.join(r, '.pi', 'run.json');
    if (!fssync.existsSync(rjFile)) continue;
    let rj: { nodes?: Record<string, { durationMs?: number }> };
    try { rj = JSON.parse(fssync.readFileSync(rjFile, 'utf8')); } catch { continue; }
    for (const [id, rec] of Object.entries(rj.nodes || {})) {
      if (typeof rec.durationMs === 'number') (dur[id] = dur[id] || []).push(rec.durationMs);
    }
  }
  const expected: Record<string, number> = {}, samples: Record<string, number> = {};
  for (const [id, arr] of Object.entries(dur)) {
    expected[id] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    samples[id] = arr.length;
  }
  return { expected, samples };
}

interface RunJsonNode {
  id: string; label?: string; agentType?: string; phase?: string | null; status: string;
  startedAt?: string; endedAt?: string; durationMs?: number;
  artifacts?: { path: string; exists?: boolean; bytes?: number }[];
  summary?: string; issues?: string[];
}
interface RunJson {
  run: string; source?: string; provider?: string; model?: string | null;
  startedAt?: string; updatedAt?: string; durationMs?: number | null;
  done?: boolean; ok?: boolean | null; totals?: { nodes: number; ok: number; failed: number };
  nodes: Record<string, RunJsonNode>;
}

/**
 * Distill `runDir`/.pi → the enriched run-view. Throws if `.pi/run.json` is absent/unparseable.
 */
export function buildRunView(runDir: string, opts: BuildRunViewOpts = {}): { view: RunView; audit: NodeAudit[] } {
  const rj = JSON.parse(fssync.readFileSync(path.join(runDir, '.pi', 'run.json'), 'utf8')) as RunJson;
  const { expected, samples } = buildHistory(opts.historyDirs ?? []);
  const runResolved = path.resolve(runDir);
  const displayPath = makeDisplayPath(runResolved, opts.workspaceRoot ?? null);
  // UNIFORM PATH RULE: every file path the view emits is ABSOLUTE. Reads/writes arrive absolute from the
  // event stream; declared artifacts arrive RELATIVE to `{{RUN}}` (the contract states `MEMORY.w4-M2.md`,
  // not a full path). A node's tools run with cwd = the run sandbox (= `{{RUN}}` = runDir), so any relative
  // path resolves against runDir. Resolving here — once, at the single data source — means every consumer
  // (GUI read-back, TUI, CLI) gets one unambiguous path and never has to guess a base.
  const toAbs = (p: string) => (path.isAbsolute(p) ? p : path.join(runResolved, p));
  const underRun = (abs: string) => abs === runResolved || abs.startsWith(runResolved + path.sep);
  const catalog = opts.catalog ?? loadModelCatalog();

  // (G5) Read the `__checkpoints__` resolution journal ONCE off `.pi/state.json` (sync). Each node's
  // marker (`.pi/checkpoints/<id>.json`) is cross-checked against it so a resolved checkpoint shows
  // `resolved` + `reply`, a pending one drives `awaiting-input`.
  let ckJournal: Record<string, CheckpointJournalSlot> = {};
  try {
    const st = JSON.parse(fssync.readFileSync(path.join(runDir, '.pi', 'state.json'), 'utf8')) as Record<string, unknown>;
    const ch = st.__checkpoints__;
    if (ch && typeof ch === 'object') ckJournal = ch as Record<string, CheckpointJournalSlot>;
  } catch { /* no state.json yet */ }
  const readMarkerSync = (id: string): CheckpointMarker | null => {
    try {
      return JSON.parse(fssync.readFileSync(path.join(runDir, '.pi', 'checkpoints', `${id}.json`), 'utf8')) as CheckpointMarker;
    } catch {
      return null;
    }
  };

  const nodes: RunViewNode[] = [];
  const audit: NodeAudit[] = [];
  // Declared I/O ledger per node (io.json reads[]/writes[]) — the data-flow edge source. Unlike the
  // events stream, io.json PERSISTS across reuse and predates per-node event capture, so the DAG wires
  // every node, not just the ones that happened to record events.
  const ioByNode = new Map<string, { reads: string[]; writes: string[] }>();
  for (const [id, rec] of Object.entries(rj.nodes || {})) {
    const replay = replayEvents(runDir, id);
    const { rich } = replay.acc.finalize(rec);
    const cov = rich.coverage;
    audit.push({
      id, status: rec.status, exists: replay.exists, bytes: replay.bytes,
      lines: replay.lines, seen: cov.eventsSeen, dropped: replay.parseErrors,
      usageEvents: cov.usageEvents, billable: rich.tokens.billable,
    });

    let phase: string | null = rec.phase ?? null;
    const ioFile = path.join(runDir, '.pi', 'nodes', id, 'io.json');
    if (fssync.existsSync(ioFile)) {
      try {
        const io = JSON.parse(fssync.readFileSync(ioFile, 'utf8')) as { phase?: string | null; reads?: { path?: unknown }[]; writes?: { path?: unknown }[] };
        phase = (io.phase ?? phase) as string | null;
        const paths = (arr: { path?: unknown }[] | undefined) => (arr ?? []).map((x) => x?.path).filter((p): p is string => typeof p === 'string');
        ioByNode.set(id, { reads: paths(io.reads), writes: paths(io.writes) });
      } catch { /* keep fallback */ }
    }

    const reads: ReadRef[] = rich.reads.map((r) => {
      const abs = toAbs(r.path);
      const dp = displayPath(abs);
      return { path: abs, displayPath: dp, via: r.via, scope: underRun(abs) ? 'run' : scopeKind(dp), preview: r.preview };
    });
    const buckets: Partial<Record<ScopeKind, string[]>> = {};
    for (const r of reads) (buckets[r.scope] = buckets[r.scope] || []).push(r.displayPath);
    const scopes: ScopeBucket[] = SCOPE_ORDER.filter((k) => buckets[k]).map((kind) => ({
      kind, label: SCOPE_LABEL[kind], count: buckets[kind]!.length, paths: buckets[kind]!,
    }));

    const writes: WriteRef[] = rich.writes.map((w) => { const abs = toAbs(w.path); return { path: abs, displayPath: displayPath(abs), verified: w.verified, bytes: w.bytes }; });
    const artifacts: ArtifactRef[] = (rec.artifacts || []).map((a) => { const abs = toAbs(a.path); return { path: abs, displayPath: displayPath(abs), exists: !!a.exists, bytes: a.bytes ?? 0 }; });

    // (G5) Build the checkpoint view from the marker + the `__checkpoints__` journal. A pending marker
    // makes the node's shown `status` read `awaiting-input` (verified-not-trusted: the marker is on disk).
    const checkpoint = checkpointViewFrom(readMarkerSync(id), ckJournal[id]) ?? undefined;
    const status = checkpoint && checkpoint.status === 'pending' ? 'awaiting-input' : rec.status;

    nodes.push({
      id, label: rec.label || id, phase, status,
      ...(rec.agentType ? { agentType: rec.agentType } : {}), // (G6) verbatim passthrough → GUI icon
      startedAt: rec.startedAt, endedAt: rec.endedAt, durationMs: rec.durationMs,
      expectedMs: expected[id] ?? rec.durationMs ?? null, priorSamples: samples[id] ?? 0,
      model: rich.model, provider: rich.provider, api: rich.api,
      contextWindow: rich.model ? contextWindowFor(rich.model, catalog) : null,
      toolCalls: rich.toolCalls, toolBreakdown: rich.toolBreakdown, timeline: rich.timeline,
      reads, scopes, writes, artifacts, bash: rich.bash, tokens: { ...rich.tokens },
      retries: rich.retries, stopReason: rich.stopReason, truncated: rich.truncated, thinkingChars: rich.thinkingChars,
      summary: rec.summary, issues: rec.issues || [],
      ...(checkpoint ? { checkpoint } : {}),
    });
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // The run-local RESOLVED DAG (`.pi/workflow.json`, written by the runner with the active profile already
  // applied — elided nodes dropped, deps rewired) is the AUTHORITATIVE structure: the deck of nodes, their
  // topological stages, and their DECLARED data-flow edges. It makes the run self-describing, so the graph
  // is the workflow the run actually executed — never reconstructed from runtime io/events traces.
  let resolvedDag: { stages?: { index: number; phase?: string | null; parallel?: boolean; nodeIds: string[] }[]; edges?: { from: string; to: string; files?: string[] }[] } | null = null;
  try {
    const f = path.join(runDir, '.pi', 'workflow.json');
    if (fssync.existsSync(f)) resolvedDag = JSON.parse(fssync.readFileSync(f, 'utf8'));
  } catch { resolvedDag = null; }

  // STAGES — columns = stages, rows = parallel lanes. Priority: the run-local resolved DAG → the declared
  // template (opts.workflow) when it covers every run node → phase grouping in execution order. One
  // {stageIndex, lane} assignment whichever wins.
  const tStages = (opts.workflow?.stages ?? [])
    .map((ids) => ids.filter((id) => nodeById.has(id)))
    .filter((ids) => ids.length > 0);
  let stages: RunViewStage[];
  if (resolvedDag?.stages?.length) {
    stages = resolvedDag.stages
      .map((st) => ({ phase: st.phase ?? '—', parallel: !!st.parallel, nodeIds: (st.nodeIds || []).filter((id) => nodeById.has(id)) }))
      .filter((st) => st.nodeIds.length > 0)
      .map((st, i) => ({ index: i + 1, phase: st.phase, parallel: st.parallel, nodeIds: st.nodeIds }));
  } else if (tStages.length && new Set(tStages.flat()).size === nodeById.size) {
    stages = tStages.map((ids, i) => ({ index: i + 1, phase: nodeById.get(ids[0])?.phase ?? '—', parallel: ids.length > 1, nodeIds: ids }));
  } else {
    const ordered = [...nodes].sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
    const phaseOrder: string[] = [];
    for (const n of ordered) { const ph = n.phase || '—'; if (!phaseOrder.includes(ph)) phaseOrder.push(ph); }
    stages = phaseOrder.map((ph, i) => {
      const ids = ordered.filter((n) => (n.phase || '—') === ph).map((n) => n.id);
      return { index: i + 1, phase: ph, parallel: ids.length > 1, nodeIds: ids };
    });
  }
  for (const st of stages) st.nodeIds.forEach((id, lane) => { const n = nodeById.get(id); if (n) { n.stageIndex = st.index; n.lane = lane; } });

  // EDGES — same priority as stages. The run-local resolved DAG's DECLARED data-flow edges are authoritative
  // (one RunViewEdge per contract file; a declared edge with no files still draws the connection). Runtime
  // io/events are then NOT consulted for topology — only for per-node telemetry. Without a resolved DAG we
  // fall back to the declared template (opts.workflow) UNION the runtime file-flow edges.
  let edges: RunViewEdge[];
  if (resolvedDag?.edges) {
    edges = [];
    const seen = new Set<string>();
    for (const e of resolvedDag.edges) {
      if (!nodeById.has(e.from) || !nodeById.has(e.to) || e.from === e.to) continue;
      const files = e.files && e.files.length ? e.files : [''];
      for (const f of files) {
        const p = f ? displayPath(f) : '';
        const key = `${e.from}|${e.to}|${p}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: e.from, to: e.to, path: p });
      }
    }
  } else {
    // FALLBACK (no run-local DAG): the DECLARED io.json ledger UNION the events-observed I/O, keyed on the
    // ABSOLUTE path so a shared edge dedupes to one and basenames never collide. First writer of a path wins
    // (declared io.json before events-observed); a well-formed workflow has one producer per path.
    const writerOf = new Map<string, string>();
    const claim = (nodeId: string, abs: string) => { if (abs && !writerOf.has(abs)) writerOf.set(abs, nodeId); };
    for (const n of nodes) for (const p of ioByNode.get(n.id)?.writes ?? []) claim(n.id, p);   // declared first…
    for (const n of nodes) for (const w of n.writes) claim(n.id, w.path);                       // …then observed
    const readsOf = (n: RunViewNode): string[] => [
      ...(ioByNode.get(n.id)?.reads ?? []),
      ...n.reads.map((r) => r.path),
    ];
    const seen = new Set<string>();
    edges = [];
    for (const n of nodes) {
      for (const abs of readsOf(n)) {
        const from = writerOf.get(abs);
        if (!from || from === n.id) continue;
        const key = `${from}|${n.id}|${abs}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from, to: n.id, path: displayPath(abs) });
      }
    }
    // Fill any connection the runtime traces missed from the declared template deps, bridging THROUGH
    // profile-elided nodes to their nearest present ancestors so the downstream node stays connected.
    const wfNodes = opts.workflow?.nodes ?? {};
    const presentDeps = (id: string, seenIds = new Set<string>()): string[] => {
      const out: string[] = [];
      for (const d of wfNodes[id]?.deps ?? []) {
        if (seenIds.has(d)) continue;
        seenIds.add(d);
        if (nodeById.has(d)) out.push(d);
        else out.push(...presentDeps(d, seenIds));
      }
      return out;
    };
    const pairLinked = new Set(edges.map((e) => `${e.from}|${e.to}`));
    for (const to of Object.keys(wfNodes)) {
      if (!nodeById.has(to)) continue;
      for (const from of presentDeps(to)) {
        if (from === to || pairLinked.has(`${from}|${to}`)) continue;
        pairLinked.add(`${from}|${to}`);
        edges.push({ from, to, path: '' });
      }
    }
  }

  const tokenTotal: RunTokens = nodes.reduce((acc, n) => {
    const t = n.tokens || ({} as RunTokens);
    acc.input += t.input || 0; acc.output += t.output || 0; acc.cacheRead += t.cacheRead || 0;
    acc.cacheWrite += t.cacheWrite || 0; acc.cost += t.cost || 0; acc.billable += t.billable || 0;
    acc.contextPeak = Math.max(acc.contextPeak, t.contextPeak || 0);
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, billable: 0, contextPeak: 0 });

  const view: RunView = {
    run: rj.run, source: rj.source, provider: rj.provider, model: rj.model,
    startedAt: rj.startedAt, updatedAt: rj.updatedAt, durationMs: rj.durationMs,
    done: rj.done, ok: rj.ok, totals: rj.totals, tokenTotal,
    stages, edges, nodes,
  };
  return { view, audit };
}
