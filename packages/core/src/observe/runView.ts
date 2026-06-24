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

export interface BuildRunViewOpts { historyDirs?: string[]; workspaceRoot?: string | null; catalog?: ModelCatalog }

// Strip an absolute path to a workspace-relative display path (workspace root first, then the legacy
// `/game-omni/` heuristic for the older demo capture, then a bare basename).
function makeDisplayPath(workspaceRoot: string | null) {
  const root = workspaceRoot ? path.resolve(workspaceRoot) : null;
  return (abs: unknown): string => {
    if (typeof abs !== 'string') return String(abs);
    if (root && abs.startsWith(root + path.sep)) return abs.slice(root.length + 1);
    const i = abs.indexOf('/game-omni/');
    if (i >= 0) return abs.slice(i + '/game-omni/'.length);
    if (!abs.startsWith('/')) return abs;
    return abs.replace(/^.*\//, '');
  };
}

function scopeKind(dp: string): ScopeKind {
  if (dp.startsWith('out/')) return 'run';
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
  id: string; label?: string; phase?: string | null; status: string;
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
  const displayPath = makeDisplayPath(opts.workspaceRoot ?? null);
  const catalog = opts.catalog ?? loadModelCatalog();

  const nodes: RunViewNode[] = [];
  const audit: NodeAudit[] = [];
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
    if (fssync.existsSync(ioFile)) { try { phase = (JSON.parse(fssync.readFileSync(ioFile, 'utf8')).phase ?? phase) as string | null; } catch { /* keep fallback */ } }

    const reads: ReadRef[] = rich.reads.map((r) => {
      const dp = displayPath(r.path);
      return { path: r.path, displayPath: dp, via: r.via, scope: scopeKind(dp), preview: r.preview };
    });
    const buckets: Partial<Record<ScopeKind, string[]>> = {};
    for (const r of reads) (buckets[r.scope] = buckets[r.scope] || []).push(r.displayPath);
    const scopes: ScopeBucket[] = SCOPE_ORDER.filter((k) => buckets[k]).map((kind) => ({
      kind, label: SCOPE_LABEL[kind], count: buckets[kind]!.length, paths: buckets[kind]!,
    }));

    const writes: WriteRef[] = rich.writes.map((w) => ({ path: w.path, displayPath: displayPath(w.path), verified: w.verified, bytes: w.bytes }));
    const artifacts: ArtifactRef[] = (rec.artifacts || []).map((a) => ({ path: a.path, displayPath: displayPath(a.path), exists: !!a.exists, bytes: a.bytes ?? 0 }));

    nodes.push({
      id, label: rec.label || id, phase, status: rec.status,
      startedAt: rec.startedAt, endedAt: rec.endedAt, durationMs: rec.durationMs,
      expectedMs: expected[id] ?? rec.durationMs ?? null, priorSamples: samples[id] ?? 0,
      model: rich.model, provider: rich.provider, api: rich.api,
      contextWindow: rich.model ? contextWindowFor(rich.model, catalog) : null,
      toolCalls: rich.toolCalls, toolBreakdown: rich.toolBreakdown, timeline: rich.timeline,
      reads, scopes, writes, artifacts, bash: rich.bash, tokens: { ...rich.tokens },
      retries: rich.retries, stopReason: rich.stopReason, truncated: rich.truncated, thinkingChars: rich.thinkingChars,
      summary: rec.summary, issues: rec.issues || [],
    });
  }

  // stages: group nodes by phase in execution order (a shared phase with >1 node is a parallel lane)
  const ordered = [...nodes].sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
  const phaseOrder: string[] = [];
  for (const n of ordered) { const ph = n.phase || '—'; if (!phaseOrder.includes(ph)) phaseOrder.push(ph); }
  const stages: RunViewStage[] = phaseOrder.map((ph, i) => {
    const ids = ordered.filter((n) => (n.phase || '—') === ph).map((n) => n.id);
    return { index: i + 1, phase: ph, parallel: ids.length > 1, nodeIds: ids };
  });
  for (const st of stages) st.nodeIds.forEach((id, lane) => { const n = nodes.find((x) => x.id === id); if (n) { n.stageIndex = st.index; n.lane = lane; } });

  // data-flow edges: a producer's write path read back by a consumer
  const seen = new Set<string>();
  const edges: RunViewEdge[] = [];
  for (const from of nodes) {
    const w = new Set(from.writes.map((x) => x.displayPath));
    for (const to of nodes) {
      if (from.id === to.id) continue;
      for (const r of to.reads) {
        const key = `${from.id}|${to.id}|${r.displayPath}`;
        if (w.has(r.displayPath) && !seen.has(key)) { seen.add(key); edges.push({ from: from.id, to: to.id, path: r.displayPath }); }
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
