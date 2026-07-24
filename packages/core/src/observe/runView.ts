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
import { createNodeAccumulator, type RichNode } from './distill.js';
import { buildNodeContext, type ContextOp, type NodeComposition, type ReadsManifest } from './contextComposition.js';
import { buildNodeTurns, type TurnRecord, type TurnSummary } from './turnDissection.js';
import { CAPABILITY_KEYS, type TranscriptCapabilities, type TranscriptOrigin } from './transcript.js';
import { resolveStructure } from './structure.js';
import { deriveNode, type NodeDerived } from './derive.js';
import { loadModelCatalog, contextWindowFor, type ModelCatalog } from './models.js';
import { checkpointViewFrom, type CheckpointMarker, type CheckpointJournalSlot } from '../runner/checkpoint.js';
import { builtinDrivers, type DriverTable } from '../runner/drivers/table.js';
import { recoverNodeEvents } from '../runner/pi-session.js';
import type { NodeConfig, NodeUsage } from '../runner/status.js';
import type { PiEvent } from '../runner/events.js';
import type { SandboxProviderKind, Workflow, OnFailure } from '../types.js';

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
  /** (P5) The stamped executor/driver id this node ran under (pi/claude-code/third) — the GUI badge source,
   *  folded verbatim from the record's `driverId` (separate from agentType branding). Absent ⇒ pi default. */
  executor?: string;
  /** (SKIN channel) The curated per-node config slice (model/tools/scoping/programmatic) — verbatim from the record. */
  config?: NodeConfig;
  status: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number | null;
  expectedMs?: number | null;
  /** (P6) cross-run mean billable tokens (input+output) for this node — the cost-spike denominator; null without history. */
  expectedBillable?: number | null;
  /** (P6) cross-run mean cost (USD) for this node — the cost-spike SECONDARY signal; null without history. */
  expectedCost?: number | null;
  priorSamples?: number;
  model?: string | null;
  provider?: string | null;
  api?: string | null;
  /** Pi-native context window for this node's model (tokens) — the context-bar denominator. */
  contextWindow?: number | null;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  /** ADDITIVE per-tool error tally (name → rejected-call count), folded verbatim from the reducer's
   *  toolErrorCounts — feeds derived.topTools[].errors so a rejected-only tool doesn't read as a real one.
   *  Optional (unlike toolBreakdown) so an existing hand-built RunViewNode fixture that omits it still
   *  type-checks unchanged; deriveNode treats an absent map as "no errors known", same as before this field. */
  toolErrorCounts?: Record<string, number>;
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
  /** assistant completions in this node — how many times the model was invoked (loop signal). */
  modelCalls: number;
  /** most times one tool ran with identical args (≥3 ⇒ probable tool loop); 0 = no tool calls. */
  maxToolRepeat: number;
  /** the tool behind `maxToolRepeat` (null when none). */
  repeatedTool: string | null;
  /** (P6) longest run of CONSECUTIVE back-to-back identical calls (canonical name+args-first-100 fingerprint);
   *  DISTINCT from maxToolRepeat (global full-args peak). 0 = no tool calls / no consecutive repeat. */
  loopScore?: number;
  /** the per-node DISPLAY projection (zones/rankings/unified outputs), computed ONCE here so the GUI +
   *  TUI render `derived.*` verbatim and never re-derive a threshold. See ./derive.ts. */
  derived?: NodeDerived;
  /** (context-composition) The ordered "element tree" — force-injected prompt + every agent read, each with
   *  range · coverage · sha · order. ADDITIVE, computed post-hoc by `buildNodeContext`. Absent when the node
   *  recorded no events + no prompt. See observe/contextComposition.ts. */
  context?: ContextOp[];
  /** (context-composition) The roll-up over `context`: injectedBytes, distinct readFiles, advertised paths,
   *  the `advertisedUnread` BLIND-SPOT, and `partialReads`. */
  composition?: NodeComposition;
  /** (turn-dissection) The per-MODEL-TURN timeline — thinking/text volume + the tool calls each turn made.
   *  ADDITIVE, computed post-hoc by `buildNodeTurns`. Absent when the node recorded no turns. */
  turns?: TurnRecord[];
  /** (turn-dissection) The roll-up over `turns`: totalThinkChars, the largest turn, `megaThinkTurns` (a
   *  turn that burned ≥ MEGA_THINK_CHARS of thinking with ZERO tool calls — pure deliberation, no action),
   *  and `derivationMarkerCount`. See observe/turnDissection.ts. */
  turnSummary?: TurnSummary;
  /**
   * (transcript port) The PROVENANCE + HONESTY declaration behind `context`/`composition`/`turns`: which
   * executor adapter read this node, which file it read, what it can answer, and — for each capability it
   * CANNOT answer — why. A renderer reads `capabilities` to decide between printing a number and printing
   * `SKIP: <limitations[cap]>`; it must never present a zero for a capability declared false.
   * See observe/transcript.ts.
   */
  transcript?: {
    executorId: string;
    origin: TranscriptOrigin;
    capabilities: TranscriptCapabilities;
    /** keyed by the FALSE capability names only — the SKIP reason for each. */
    limitations: Partial<Record<keyof TranscriptCapabilities, string>>;
  };
  summary?: string;
  issues?: string[];
  /** (A1) op[] action failures on their DEDICATED TYPED channel — carried verbatim from the record so an
   *  op failure stays VISIBLE in the observe surface even though it left `issues[]` entirely. Absent when none.
   *  (op-integrity WS-I1/I2) `resultFile?`/`integrity?` ride verbatim too — kept in sync with
   *  `NodeStatusRecord.opFailures` (status.ts) so a verb reading THIS field sees the same verdict content. */
  opFailures?: { detail: string; onFailure: OnFailure; resultFile?: string; integrity?: { kind: string; ok: boolean; detail: string }[] }[];
  /** (op-integrity WS-I3) Every DISPATCHED run op — pass or fail — carried verbatim from `NodeStatusRecord.ops`
   *  (status.ts); the telemetry per-node ops table's source. Absent when the node dispatched no run op. */
  ops?: { id: string; exit?: number; durationMs?: number; integrity?: { kind: string; ok: boolean; detail: string }[] }[];
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
  /** (SKIN channel) The run's effective sandbox BACKEND (from `run.json` `sandbox`) — drives the GUI node skin. */
  sandbox?: SandboxProviderKind;
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
  /** (P5) The executor-id → AgentDriver table the per-node fold selects its accumulator from (keyed by the
   *  node's stamped `driverId`). Absent ⇒ `builtinDrivers()` (pi + claude-code) — the hermetic default. A
   *  caller only overrides it to register a third executor's driver. */
  drivers?: DriverTable;
}

// Strip an absolute path to a clean DISPLAY path using the run's two roots. A file inside the run sandbox
// ({{RUN}}) shows relative to it (`spec/blueprint.json`); a file in the shared tree ({{WORKSPACE}}) shows
// relative to it (`packages/skills/...`); anything else falls back to a bare basename. runDir is checked
// FIRST because it nests under workspaceRoot, so a run file never displays as the long `.piflow/.../runs/…`.
export function makeDisplayPath(runDir: string | null, workspaceRoot: string | null) {
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
export function scopeKind(dp: string): ScopeKind {
  if (dp.startsWith('packages/skills/')) return 'skill';
  if (dp.startsWith('templates/')) return 'template';
  if (dp.startsWith('packages/')) return 'package';
  return 'repo';
}
const SCOPE_LABEL: Record<ScopeKind, string> = { run: 'Run workspace', skill: 'Skill', template: 'Templates', package: 'Packages', repo: 'Repo source' };
const SCOPE_ORDER: ScopeKind[] = ['run', 'skill', 'template', 'package', 'repo'];

// Replay a node's events.jsonl through the reducer, COUNTING every line + every torn line (the data-load
// ledger: lines == eventsSeen + parseErrors must hold, or events were silently lost). The reducer is
// DRIVER-SELECTED by the node's stamped `driverId` (P5): pi ⇒ createNodeAccumulator (byte-identical),
// claude-code ⇒ the count-only stream-json decoder. A STAMPED record resolves via `drivers.get` UNCHANGED
// (an unknown stamped id still FAILS CLOSED). An UNSTAMPED record (driverId absent — mid-run, or a run
// written before P3 stamped it) is FORMAT-DETECTED from the parsed events via `drivers.detectUnstamped`
// (Defect E1), so a legacy Claude run stops silently folding through pi's no-op accumulator; an unstamped
// pi-vocabulary (or empty) sample still falls back to pi, exactly as before. `?? createNodeAccumulator()`
// covers a driver that returns no accumulator so nothing crashes.
function replayEvents(runDir: string, id: string, drivers: DriverTable, driverId?: string) {
  const f = path.join(runDir, '.pi', 'nodes', id, 'events.jsonl');
  let lines = 0, parseErrors = 0, exists = false, bytes = 0;
  const parsed: PiEvent[] = [];
  if (fssync.existsSync(f)) {
    exists = true;
    bytes = fssync.statSync(f).size;
    for (const line of fssync.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      try { parsed.push(JSON.parse(line)); } catch { parseErrors += 1; }
    }
  }
  const driver = driverId != null ? drivers.get(driverId) : drivers.detectUnstamped(parsed);
  const acc = driver.eventAccumulator?.() ?? createNodeAccumulator();
  for (const e of parsed) acc.push(e);
  return { acc, lines, parseErrors, exists, bytes };
}

// ── session backfill — recover a pi node's signal from its NATIVE session when events.jsonl had no usage ──
// pi's stdout tee (events.jsonl) can be empty of model turns even though the node really ran — e.g. a
// failed `--session <id>` resume whose events.jsonl holds only pi's "No session found matching '<id>'"
// stderr, while pi still persisted a full native session (run 260715-02/plan: 688KB session, 0 in
// events.jsonl → `telemetry plan` reported 0 calls/0 tokens). The native session is the authoritative
// record; we TRANSCODE its `message`/content vocabulary into the pi STREAM events the shared reducer
// already folds, so recovered tokens/calls are byte-identical to a live run.

/** Fold a pi node's native session into a `rich` node (the SAME reducer path a live pi run uses), or null
 *  when there is no session or it holds no model turn. The locator + transcode live in the shared
 *  `runner/pi-session.ts` (reused by the write path and `runner/logs`), so there is ONE copy of that logic.
 *  The caller only reaches here when events.jsonl gave nothing, so this never double-counts a captured stream. */
function recoverFromPiSession(runDir: string, rec: RunJsonNode): RichNode | null {
  const events = recoverNodeEvents(runDir, { sessionId: rec.sessionId, sessionDir: rec.sessionDir }, rec.id);
  if (!events) return null;
  const acc = createNodeAccumulator();
  for (const e of events) acc.push(e);
  const { rich } = acc.finalize(rec);
  return rich.coverage.usageEvents > 0 ? rich : null;
}

// Read a UTF-8 file, returning null when it is absent/unreadable (the context builder's prompt source).
function readTextSafe(file: string): string | null {
  try { return fssync.readFileSync(file, 'utf8'); } catch { return null; }
}
// Read + parse the run-time reads-manifest, returning null when absent/unparseable (context builder falls
// back to the on-disk file for size/version when this is null).
function readManifestSafe(file: string): ReadsManifest | null {
  try { return JSON.parse(fssync.readFileSync(file, 'utf8')) as ReadsManifest; } catch { return null; }
}

// Cross-run history: expectedMs[id] = mean durationMs across history runs that ran node `id`. Exported so the
// live watchRun ctx computes expectedMs from the SAME history the /run-view handler passes (else derived.time
// diverges between the live stream and the loaded view — the shadow-diff parity break P4-live caught).
export function buildHistory(historyDirs: string[]) {
  const dur: Record<string, number[]> = {};
  // (P6) IN-PLACE extension: per node, gather billable (input+output) + cost samples from the SAME run.json
  // set the durationMs fold reads — no new persistence file. Only runs that carried usage contribute.
  const bill: Record<string, number[]> = {}, cost: Record<string, number[]> = {};
  for (const r of historyDirs) {
    const rjFile = path.join(r, '.pi', 'run.json');
    if (!fssync.existsSync(rjFile)) continue;
    let rj: { nodes?: Record<string, { durationMs?: number; usage?: NodeUsage }> };
    try { rj = JSON.parse(fssync.readFileSync(rjFile, 'utf8')); } catch { continue; }
    for (const [id, rec] of Object.entries(rj.nodes || {})) {
      if (typeof rec.durationMs === 'number') (dur[id] = dur[id] || []).push(rec.durationMs);
      const u = rec.usage;
      if (u && (typeof u.inputTokens === 'number' || typeof u.outputTokens === 'number')) {
        (bill[id] = bill[id] || []).push((u.inputTokens ?? 0) + (u.outputTokens ?? 0));
        (cost[id] = cost[id] || []).push(u.cost ?? 0);
      }
    }
  }
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const expected: Record<string, number> = {}, samples: Record<string, number> = {};
  for (const [id, arr] of Object.entries(dur)) {
    expected[id] = Math.round(mean(arr));
    samples[id] = arr.length;
  }
  // (P6) cross-run COST/BILLABLE mean per node — the cost-spike denominator, from the SAME run.json fold.
  const expectedCost: Record<string, number> = {}, expectedBillable: Record<string, number> = {};
  for (const [id, arr] of Object.entries(bill)) expectedBillable[id] = mean(arr);
  for (const [id, arr] of Object.entries(cost)) expectedCost[id] = mean(arr);
  return { expected, samples, expectedCost, expectedBillable };
}

interface RunJsonNode {
  id: string; label?: string; agentType?: string; phase?: string | null; status: string;
  startedAt?: string; endedAt?: string; durationMs?: number;
  artifacts?: { path: string; exists?: boolean; bytes?: number }[];
  summary?: string; issues?: string[];
  /** (A1) op[] action failures on their DEDICATED TYPED channel (NodeStatusRecord.opFailures) — read off
   *  `.pi/run.json` and carried onto the wire node so an op failure stays visible after leaving `issues[]`. */
  opFailures?: { detail: string; onFailure: OnFailure; resultFile?: string; integrity?: { kind: string; ok: boolean; detail: string }[] }[];
  /** (op-integrity WS-I3) Every DISPATCHED run op — pass or fail (NodeStatusRecord.ops) — read off
   *  `.pi/run.json` and carried onto the wire node for the telemetry per-node ops table. */
  ops?: { id: string; exit?: number; durationMs?: number; integrity?: { kind: string; ok: boolean; detail: string }[] }[];
  config?: NodeConfig;
  /** the effective model recorded on the node (fallback when message events carried none — e.g. Claude). */
  model?: string | null;
  /** (agent-neutral spine) authoritative token/cost rollup from the executor's final report. See NodeUsage. */
  usage?: NodeUsage;
  /** (P5) the stamped driver/executor id (P3, `NodeStatusRecord.driverId`) — the observe fold selects the
   *  per-node accumulator by this and folds it onto the wire node's `executor`. Absent ⇒ pi default. */
  driverId?: string;
  /** pi's per-node NATIVE session (`NodeStatusRecord.sessionId`/`.sessionDir`) — the read-path fallback source
   *  when events.jsonl carried no usage (see `recoverFromPiSession`). sessionId === node id; the file is
   *  `<sessionDir>/<ISO-ts>_<sessionId>.jsonl`. Absent ⇒ no session (no fallback). */
  sessionId?: string;
  sessionDir?: string;
}
interface RunJson {
  run: string; source?: string; provider?: string; model?: string | null;
  sandbox?: SandboxProviderKind;
  startedAt?: string; updatedAt?: string; durationMs?: number | null;
  done?: boolean; ok?: boolean | null; totals?: { nodes: number; ok: number; failed: number };
  nodes: Record<string, RunJsonNode>;
}

/** The token/cost/context SPINE for one node — the agent-neutral rollup `assembleNode` stamps. */
export interface NodeTokenSpine {
  tokens: RunTokens;
  /** the model label to display (rec.usage path prefers the effective model; else the event-replay model). */
  model: string | null;
  /** the context-window denominator (rec.usage's own cap, else the model's registry window). */
  contextWindow: number | null;
  modelCalls: number;
  stopReason: string | null;
  truncated: boolean;
}

/**
 * (agent-neutral spine) Pick the token/cost/context/turns rollup for one node. When the executor persisted
 * an authoritative usage rollup (`rec.usage` — Claude, whose stream-json the pi reducer cannot decode so
 * `rich` is blank), PREFER it; otherwise source from the event replay (`rich`). Gated on `usage`: pi never
 * sets it, so pi nodes stay byte-identical (event replay wins). Extracted verbatim from `buildRunView`'s
 * per-node loop so the live SSE fold and the batch builder compute the SAME spine from the SAME code —
 * and so the AgentDriver registry (Thrust 3) slots in here (pick the driver for `rec`) with no rework.
 */
export function nodeTokenSpine(
  usage: NodeUsage | undefined,
  rich: RichNode,
  catalog: ModelCatalog,
  effModel: string | null,
): NodeTokenSpine {
  const u = usage;
  const tokens: RunTokens = u
    ? {
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cacheWrite: u.cacheCreation ?? 0, // Claude cache_creation ≙ pi cacheWrite (newly-cached input)
        cost: u.cost ?? 0,
        contextPeak: (u.inputTokens ?? 0) + (u.cacheRead ?? 0) + (u.cacheCreation ?? 0), // context in the window
        billable: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
      }
    : { ...rich.tokens };
  const model = u ? effModel : rich.model;
  const contextWindow = u
    ? (u.contextWindow ?? (effModel ? contextWindowFor(effModel, catalog) : null))
    : (rich.model ? contextWindowFor(rich.model, catalog) : null);
  const modelCalls = u ? (u.numTurns ?? rich.modelCalls) : rich.modelCalls;
  const stopReason = u ? (u.stopReason ?? rich.stopReason) : rich.stopReason;
  const truncated = u ? (stopReason === 'max_tokens' || stopReason === 'length') : rich.truncated;
  return { tokens, model, contextWindow, modelCalls, stopReason, truncated };
}

/** The per-node build context `assembleNode` needs — the run-scoped closures `buildRunView` sets up once. */
export interface AssembleNodeCtx {
  /** absolutize a possibly-relative path against the run sandbox. */
  toAbs: (p: string) => string;
  /** whether an absolute path lives inside the run sandbox ({{RUN}}) — the `run` scope test. */
  underRun: (abs: string) => boolean;
  /** strip an absolute path to a clean display path using the run's two roots. */
  displayPath: (abs: unknown) => string;
  /** pi-native model registry for the context-window denominator. */
  catalog: ModelCatalog;
  /** cross-run mean durationMs per node id (empty when no history dirs). */
  expected: Record<string, number>;
  /** cross-run sample count per node id. */
  samples: Record<string, number>;
  /** (P6) cross-run mean billable tokens per node id (empty when no history dirs). */
  expectedBillable?: Record<string, number>;
  /** (P6) cross-run mean cost per node id (empty when no history dirs). */
  expectedCost?: Record<string, number>;
  /** the `__checkpoints__` resolution journal read once off state.json. */
  ckJournal: Record<string, CheckpointJournalSlot>;
  /** read a node's checkpoint marker (`.pi/checkpoints/<id>.json`), null if absent/unparseable. */
  readMarkerSync: (id: string) => CheckpointMarker | null;
}

/** The parsed io.json ledger for one node (phase override + declared read/write paths). */
export interface NodeIoLedger { phase?: string | null; reads: string[]; writes: string[] }

/**
 * Assemble ONE `RunViewNode` from its status record + the reduced `rich` node + its io.json ledger + the
 * run-scoped context — the whole per-node build (reads/scopes/writes/artifacts/tokens/spine/checkpoint),
 * then stamps `derived = deriveNode(node)`. Extracted VERBATIM from `buildRunView`'s per-node loop so the
 * live SSE fold and the batch builder produce byte-identical nodes from the SAME code.
 */
export function assembleNode(
  rec: RunJsonNode,
  rich: RichNode,
  ioLedger: NodeIoLedger | null,
  ctx: AssembleNodeCtx,
): RunViewNode {
  const id = rec.id;
  let phase: string | null = rec.phase ?? null;
  if (ioLedger) phase = ioLedger.phase ?? phase;

  const reads: ReadRef[] = rich.reads.map((r) => {
    const abs = ctx.toAbs(r.path);
    const dp = ctx.displayPath(abs);
    return { path: abs, displayPath: dp, via: r.via, scope: ctx.underRun(abs) ? 'run' : scopeKind(dp), preview: r.preview };
  });
  const buckets: Partial<Record<ScopeKind, string[]>> = {};
  for (const r of reads) (buckets[r.scope] = buckets[r.scope] || []).push(r.displayPath);
  const scopes: ScopeBucket[] = SCOPE_ORDER.filter((k) => buckets[k]).map((kind) => ({
    kind, label: SCOPE_LABEL[kind], count: buckets[kind]!.length, paths: buckets[kind]!,
  }));

  const writes: WriteRef[] = rich.writes.map((w) => { const abs = ctx.toAbs(w.path); return { path: abs, displayPath: ctx.displayPath(abs), verified: w.verified, bytes: w.bytes }; });
  const artifacts: ArtifactRef[] = (rec.artifacts || []).map((a) => { const abs = ctx.toAbs(a.path); return { path: abs, displayPath: ctx.displayPath(abs), exists: !!a.exists, bytes: a.bytes ?? 0 }; });

  // (agent-neutral spine) tokens/cost/context/turns — rec.usage-first-vs-event-replay (nodeTokenSpine).
  const effModel = rich.model ?? rec.model ?? null;
  const spine = nodeTokenSpine(rec.usage, rich, ctx.catalog, effModel);

  // (G5) Build the checkpoint view from the marker + the `__checkpoints__` journal. A pending marker
  // makes the node's shown `status` read `awaiting-input` (verified-not-trusted: the marker is on disk).
  const checkpoint = checkpointViewFrom(ctx.readMarkerSync(id), ctx.ckJournal[id]) ?? undefined;
  const status = checkpoint && checkpoint.status === 'pending' ? 'awaiting-input' : rec.status;

  const node: RunViewNode = {
    id, label: rec.label || id, phase, status,
    ...(rec.agentType ? { agentType: rec.agentType } : {}), // (G6) verbatim passthrough → GUI icon
    ...(rec.driverId ? { executor: rec.driverId } : {}), // (P5) stamped executor/driver id → GUI badge
    ...(rec.config ? { config: rec.config } : {}), // (SKIN) curated config slice → GUI cloud skin
    startedAt: rec.startedAt, endedAt: rec.endedAt, durationMs: rec.durationMs,
    // Honest "no baseline": a node with zero prior samples gets expectedMs:null, NEVER falling back to its
    // OWN durationMs (that fabricated a ratio of exactly 1.0 — "on-target" — for a node with no history at all).
    expectedMs: ctx.expected[id] ?? null, priorSamples: ctx.samples[id] ?? 0,
    // (P6) cross-run cost/billable means — the cost-spike denominators (null without history).
    expectedBillable: ctx.expectedBillable?.[id] ?? null,
    expectedCost: ctx.expectedCost?.[id] ?? null,
    model: spine.model, provider: rich.provider, api: rich.api,
    contextWindow: spine.contextWindow,
    toolCalls: rich.toolCalls, toolBreakdown: rich.toolBreakdown, toolErrorCounts: rich.toolErrorCounts, timeline: rich.timeline,
    reads, scopes, writes, artifacts, bash: rich.bash, tokens: spine.tokens,
    retries: rich.retries, stopReason: spine.stopReason, truncated: spine.truncated, thinkingChars: rich.thinkingChars,
    modelCalls: spine.modelCalls, maxToolRepeat: rich.maxToolRepeat, repeatedTool: rich.repeatedTool,
    loopScore: rich.loopScore, // (P6) consecutive-repeat loop signal, folded from the reducer.
    summary: rec.summary, issues: rec.issues || [],
    ...(rec.opFailures ? { opFailures: rec.opFailures } : {}), // (A1) typed op-failure channel → observe surface
    ...(rec.ops ? { ops: rec.ops } : {}), // (op-integrity WS-I3) per-op execution record → the telemetry ops table
    ...(checkpoint ? { checkpoint } : {}),
  };
  // Compute the DISPLAY zones ONCE, from the assembled node's own fields (tokens/tools/timeline/context/
  // duration) — every view renders `node.derived.*` and re-derives nothing.
  node.derived = deriveNode(node);
  return node;
}

/**
 * Distill `runDir`/.pi → the enriched run-view. Throws if `.pi/run.json` is absent/unparseable.
 */
export function buildRunView(runDir: string, opts: BuildRunViewOpts = {}): { view: RunView; audit: NodeAudit[] } {
  const rj = JSON.parse(fssync.readFileSync(path.join(runDir, '.pi', 'run.json'), 'utf8')) as RunJson;
  const { expected, samples, expectedBillable, expectedCost } = buildHistory(opts.historyDirs ?? []);
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
  // (P5) The driver table the per-node fold selects its accumulator from — hermetic default (pi + claude).
  const drivers = opts.drivers ?? builtinDrivers();

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
  const ctx: AssembleNodeCtx = { toAbs, underRun, displayPath, catalog, expected, samples, expectedBillable, expectedCost, ckJournal, readMarkerSync };
  for (const [id, rec] of Object.entries(rj.nodes || {})) {
    const replay = replayEvents(runDir, id, drivers, rec.driverId);
    let { rich } = replay.acc.finalize(rec);
    const cov = rich.coverage;
    // The audit ledger stays TRUE to events.jsonl (its integrity is the thing being audited) — computed
    // from the stream replay BEFORE any session backfill below.
    audit.push({
      id, status: rec.status, exists: replay.exists, bytes: replay.bytes,
      lines: replay.lines, seen: cov.eventsSeen, dropped: replay.parseErrors,
      usageEvents: cov.usageEvents, billable: rich.tokens.billable,
    });
    // SESSION BACKFILL: events.jsonl carried no model usage and the executor left no authoritative usage
    // rollup (pi never sets `rec.usage`) — recover the node's real metrics from pi's native session file so
    // telemetry isn't a false zero (run 260715-02/plan). Gated so a normal captured run is never re-sourced.
    if (cov.usageEvents === 0 && !rec.usage) {
      const recovered = recoverFromPiSession(runDir, rec);
      if (recovered) rich = recovered;
    }

    // Parse the io.json ledger once (phase override + declared read/write paths for the edge source).
    let ioLedger: NodeIoLedger | null = null;
    const ioFile = path.join(runDir, '.pi', 'nodes', id, 'io.json');
    if (fssync.existsSync(ioFile)) {
      try {
        const io = JSON.parse(fssync.readFileSync(ioFile, 'utf8')) as { phase?: string | null; reads?: { path?: unknown }[]; writes?: { path?: unknown }[] };
        const paths = (arr: { path?: unknown }[] | undefined) => (arr ?? []).map((x) => x?.path).filter((p): p is string => typeof p === 'string');
        ioLedger = { phase: io.phase, reads: paths(io.reads), writes: paths(io.writes) };
        ioByNode.set(id, { reads: ioLedger.reads, writes: ioLedger.writes });
      } catch { /* keep fallback */ }
    }

    const node = assembleNode(rec, rich, ioLedger, ctx);
    // (context-composition) ADDITIVE: reconstruct the ordered element tree (force-injected prompt + every
    // agent read, each with range/coverage/sha/order) + the blind-spot roll-up. Reads events.jsonl a SECOND
    // time post-hoc (fine). Best-effort — a build error never perturbs the parity-critical assembleNode set.
    // (transcript port) ONE source per node, routed by the stamped `driverId` through the DriverTable — the
    // SAME registry `replayEvents` selects its accumulator from. Both projections below read this source, so
    // neither knows any executor's event schema, and an executor with no reader (or an unknown id) surfaces
    // as a declared SKIP on `node.transcript` rather than as zeros.
    const source = drivers.transcriptFor(rec.driverId, runDir, id, { sessionId: rec.sessionId, sessionDir: rec.sessionDir });
    const caps = source.capabilities();
    node.transcript = {
      executorId: source.executorId,
      origin: source.origin(),
      capabilities: caps,
      limitations: Object.fromEntries(
        CAPABILITY_KEYS.filter((k) => !caps[k]).map((k) => [k, source.limitation(k) ?? 'unavailable']),
      ),
    };
    try {
      const nc = buildNodeContext(caps.ops ? source.ops() : [], {
        displayPath,
        scopeOf: (abs, dp) => (underRun(abs) ? 'run' : scopeKind(dp)),
        promptText: readTextSafe(path.join(runDir, '.pi', 'nodes', id, 'prompt.md')),
        promptPath: path.join(runResolved, '.pi', 'nodes', id, 'prompt.md'),
        manifest: readManifestSafe(path.join(runDir, '.pi', 'nodes', id, 'reads-manifest.json')),
        // (op-integrity WS-I4) the node's mirrored `readContract` (NodeConfig, stamped by buildNodeConfig) —
        // absent on a node with none, so the marker backstop is a no-op there (byte-identical to today).
        readContract: node.config?.readContract,
      });
      if (nc.context.length) node.context = nc.context;
      node.composition = nc.composition;
    } catch { /* context is a projection add-on — never let it break the run-view */ }
    // (turn-dissection) ADDITIVE: per-turn reasoning-effort timeline (thinking/text volume + tool calls) +
    // the mega-think/derivation-marker rollup, folded from the SAME transcript source (same best-effort
    // contract as context-composition above; never let it break the run-view).
    try {
      const td = buildNodeTurns(caps.turns ? source.turns() : []);
      if (td.turns.length) node.turns = td.turns;
      node.turnSummary = td.summary;
    } catch { /* turn dissection is a projection add-on — never let it break the run-view */ }
    nodes.push(node);
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // STRUCTURE — the run's stage spine + data-flow edges via the ONE shared resolver (structure.ts). Priority:
  // the run-local resolved DAG (`.pi/workflow.json`) → the declared template (opts.workflow) → phase grouping
  // in execution order (with runtime file-flow edges). `readRunModel` uses the SAME resolver, so the live
  // snapshot and this enriched view draw the SAME graph. buildRunView feeds it the declared io ledger PLUS the
  // events-observed I/O (already absolute) — the extra tier-3 signal the lean reader lacks.
  const { stages, edges, placement } = resolveStructure(
    runDir,
    nodes.map((n) => ({
      id: n.id,
      phase: n.phase,
      startedAt: n.startedAt,
      ioReads: ioByNode.get(n.id)?.reads ?? [],
      ioWrites: ioByNode.get(n.id)?.writes ?? [],
      observedReads: n.reads.map((r) => r.path),
      observedWrites: n.writes.map((w) => w.path),
    })),
    { workflow: opts.workflow, toAbs, displayPath },
  );
  for (const [id, place] of Object.entries(placement)) { const n = nodeById.get(id); if (n) { n.stageIndex = place.stageIndex; n.lane = place.lane; } }

  const tokenTotal: RunTokens = nodes.reduce((acc, n) => {
    const t = n.tokens || ({} as RunTokens);
    acc.input += t.input || 0; acc.output += t.output || 0; acc.cacheRead += t.cacheRead || 0;
    acc.cacheWrite += t.cacheWrite || 0; acc.cost += t.cost || 0; acc.billable += t.billable || 0;
    acc.contextPeak = Math.max(acc.contextPeak, t.contextPeak || 0);
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, billable: 0, contextPeak: 0 });

  // The resolver returns a nullable phase (it also serves the lean StageView); every buildRunView tier yields
  // a non-null phase at runtime (`?? '—'`), so coerce to the RunViewStage contract without changing values.
  const viewStages: RunViewStage[] = stages.map((st) => ({ index: st.index, phase: st.phase ?? '—', parallel: st.parallel, nodeIds: st.nodeIds }));

  const view: RunView = {
    run: rj.run, source: rj.source, provider: rj.provider, model: rj.model,
    ...(rj.sandbox ? { sandbox: rj.sandbox } : {}), // (SKIN) the run's effective backend → GUI node skin
    startedAt: rj.startedAt, updatedAt: rj.updatedAt, durationMs: rj.durationMs,
    done: rj.done, ok: rj.ok, totals: rj.totals, tokenTotal,
    stages: viewStages, edges, nodes,
  };
  return { view, audit };
}

/** Placement: stage column (1-based, gap-free) + the node's lane within its parallel stage — the SAME
 *  coordinates `toFlowGraph` lays out by. Shared by every reader that projects a compiled `Workflow`
 *  directly (no run on disk) — `previewView` and `buildTemplateView` both stamp from this ONE placement. */
function placeStages(wf: Workflow): { stages: RunViewStage[]; place: Map<string, { stageIndex: number; lane: number }> } {
  const place = new Map<string, { stageIndex: number; lane: number }>();
  const stages: RunViewStage[] = wf.stages
    .filter((st) => st.nodeIds.length > 0)
    .map((st, i) => {
      const index = i + 1;
      st.nodeIds.forEach((id, lane) => place.set(id, { stageIndex: index, lane }));
      return { index, phase: st.phase ?? '—', parallel: !!st.parallel, nodeIds: [...st.nodeIds] };
    });
  return { stages, place };
}

/** One RunViewEdge per produced file (the GUI collapses same-pair edges); self-edges dropped, like
 *  buildRunView. Shared by `previewView` and `buildTemplateView` (both collapse a compiled `Workflow`'s
 *  edges the same way; only `buildRunView`'s run-local `resolveStructure` ladder is a different concern). */
function collapseWorkflowEdges(wf: Workflow): RunViewEdge[] {
  const edges: RunViewEdge[] = [];
  const seen = new Set<string>();
  for (const e of wf.edges) {
    if (e.from === e.to) continue;
    const files = e.files && e.files.length ? e.files : [''];
    for (const f of files) {
      const key = `${e.from}|${e.to}|${f}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: e.from, to: e.to, path: f });
    }
  }
  return edges;
}

/** Synthetic-view options: the run id/provider/model to STAMP on the preview (defaults to the wf name). */
export interface PreviewViewOpts { run?: string; provider?: string; model?: string | null }

/**
 * Project a COMPILED `Workflow` into the run-view contract WITHOUT a run on disk — the static twin of
 * `buildRunView` (which distills a real `.pi/` tree). Pure + telemetry-free: every node is `pending`, no
 * tokens/timeline/artifacts. Its reason to exist is the fusion/structure PREVIEW: a surface compiles the
 * SAME spec the run-path would (`expandFusion(spec) → compile`) and renders the EXACT resulting DAG through
 * the ONE `{stages, edges, nodes}` contract + the SAME `toFlowGraph` placement (stageIndex = column, lane =
 * row) — so no view re-derives the siblings+judge structure on its own. Node `model` falls back to the tier
 * alias so a tier-routed sibling still labels (the runner resolves tier→model later).
 */
export function previewView(wf: Workflow, opts: PreviewViewOpts = {}): RunView {
  const { stages, place } = placeStages(wf);
  const edges = collapseWorkflowEdges(wf);

  const nodes: RunViewNode[] = Object.values(wf.nodes).map((n) => {
    const p = place.get(n.id);
    const node: RunViewNode = {
      id: n.id,
      label: n.label ?? n.id,
      phase: n.phase ?? null,
      ...(n.agentType ? { agentType: n.agentType } : {}),
      // (SKIN) a preview has no run.json ⇒ `config` is omitted here and the view-level `sandbox` stays
      // undefined (no chosen backend yet); the GUI defaults to the 'flat' skin until a real run records them.
      status: 'pending', // a preview never ran ⇒ no live status, no telemetry
      model: n.model ?? n.tier ?? null, // tier alias labels until the runner resolves tier→model
      provider: n.provider ?? null,
      toolCalls: 0,
      toolBreakdown: {},
      toolErrorCounts: {},
      timeline: [],
      reads: [],
      scopes: [],
      writes: [],
      artifacts: [],
      bash: [],
      retries: 0,
      stopReason: null,
      truncated: false,
      thinkingChars: 0,
      modelCalls: 0,
      maxToolRepeat: 0,
      repeatedTool: null,
      ...(p ? { stageIndex: p.stageIndex, lane: p.lane } : {}),
    };
    // A never-ran node still carries the derived shape (all-neutral zones) so the GUI stays render-only.
    node.derived = deriveNode(node);
    return node;
  });

  return {
    run: opts.run ?? wf.meta.name,
    source: wf.meta.name,
    ...(opts.provider ? { provider: opts.provider } : {}),
    model: opts.model ?? null,
    done: false,
    ok: null,
    totals: { nodes: nodes.length, ok: 0, failed: 0 },
    stages,
    edges,
    nodes,
  };
}

/** One node's identity + placement as the AUTHORED template declares it — nothing else. Deliberately NOT a
 *  `RunViewNode`: a template never ran, so there is no telemetry to pad with zeros. */
export interface TemplateViewNode {
  id: string;
  label: string;
  phase: string | null;
  agentType?: string;
  model?: string | null;
  provider?: string | null;
  stageIndex?: number;
  lane?: number;
}

/** The bare template's shape — a subset of `RunView`'s CONTOUR (same `{stages, edges, nodes}` contract, so
 *  a client-side adapter can widen it into a `RunView` for reuse of the one render path) but not its
 *  telemetry: only what the template itself declares. */
export interface TemplateView {
  run: string;
  source?: string;
  stages: RunViewStage[];
  edges: RunViewEdge[];
  nodes: TemplateViewNode[];
}

/**
 * Project a COMPILED `Workflow` into its bare template shape — "the canonical workflow, no run needed" view
 * (docs the `gui` slice's pinned-template row). Shares `placeStages`/`collapseWorkflowEdges` with
 * `previewView` (same compiled-`Workflow`-in projection), but carries NONE of `previewView`'s zeroed
 * telemetry fields — those exist so the fusion-preview editor can render/save through the full `RunView`
 * contract; a pinned template has no such need, so this stays a genuinely lean subset. `buildRunView`
 * (a real run's telemetry) is a separate, unrelated reader — it resolves structure from run-local
 * `.pi/workflow.json` via `resolveStructure`, not from an in-memory compiled `Workflow`.
 */
export function buildTemplateView(wf: Workflow, opts: { run?: string } = {}): TemplateView {
  const { stages, place } = placeStages(wf);
  const edges = collapseWorkflowEdges(wf);
  const nodes: TemplateViewNode[] = Object.values(wf.nodes).map((n) => {
    const p = place.get(n.id);
    return {
      id: n.id,
      label: n.label ?? n.id,
      phase: n.phase ?? null,
      ...(n.agentType ? { agentType: n.agentType } : {}),
      model: n.model ?? n.tier ?? null,
      provider: n.provider ?? null,
      ...(p ? { stageIndex: p.stageIndex, lane: p.lane } : {}),
    };
  });
  return { run: opts.run ?? wf.meta.name, source: wf.meta.name, stages, edges, nodes };
}
