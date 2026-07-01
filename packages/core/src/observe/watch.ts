// ── watchRun — the single live STREAM (server-side enriched) ─────────────────────────────────────────
// One async iterable every live view drives: it yields a full `{kind:'snapshot'}` FIRST, then the
// deltas — `{kind:'node-status'}` when a node's DERIVED status changes, `{kind:'node-event'}` for each
// NEW `.pi/nodes/<id>/events.jsonl` line, `{kind:'node-enriched'}` when a node's FOLDED telemetry
// materially changes (the FULL re-assembled enriched node, DR3/M4), and `{kind:'done'}` when the run
// completes — and stops cleanly on `opts.signal` abort. It polls the engine-owned `.pi/` layout (the
// writer publishes `run.json` atomically, so a poll never reads a torn file) at `opts.pollMs`.
//
// The event tail REUSES the byte-offset + carry-partial-line technique `followRun` (logs.ts) uses — we
// read only the bytes appended since the last poll, split into whole lines, JSON.parse each, and carry
// the trailing partial — so we never re-emit a line and never duplicate the firehose-distiller logic.
//
// SERVER-SIDE FOLD (P2): the stream is the single ENRICHED live source. Each node keeps ONE long-lived
// `createNodeAccumulator` (a Map, never recreated mid-stream). It is SEEDED on the first snapshot by
// replaying `events.jsonl [0,size)` via the SAME `tailEvents` primitive (from=0, capturing carry) and
// the stored offset is `size` FROM THAT READ (never a separate statSync — seed bytes and offset MUST
// match, or a line folds twice / is skipped). Thereafter the incremental tail feeds the SAME accumulator.
// The enrichment reuses the SHARED assembly (`assembleNode` + `nodeTokenSpine` + `deriveNode` from
// runView.ts) over the NON-DESTRUCTIVE `acc.snapshot(rec)` — never `finalize()`, which is destructive on
// a live (still-open-span) accumulator — so the live graph and the on-demand `buildRunView` render
// byte-identical per-node data.

import fssync from 'node:fs';
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { nodeEventsFile, nodeIoFile } from '../runner/layout.js';
import type { PiEvent } from '../runner/events.js';
import type { NodeStatus, NodeStatusRecord } from '../runner/status.js';
import { checkpointViewFrom, type CheckpointMarker, type CheckpointJournalSlot } from '../runner/checkpoint.js';
import { readRunModel, readRunJson } from './read.js';
import { createNodeAccumulator, type NodeAccumulator } from './distill.js';
import { loadModelCatalog, type ModelCatalog } from './models.js';
import { assembleNode, type AssembleNodeCtx, type NodeIoLedger, type RunViewNode, type RunTokens } from './runView.js';
import type { NodeView, RunModel, RunUpdate } from './types.js';

export interface WatchOpts {
  /** Abort the stream — the iterator returns promptly (no hang) on abort. */
  signal?: AbortSignal;
  /** Poll interval (ms). Default 700 (the `followRun` cadence). */
  pollMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Resolve immediately on abort so a long pollMs can't delay teardown.
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** Read the bytes appended to a node's events file since `from`; returns the parsed NEW events + the
 * new byte offset + the trailing partial line to carry. Pure over the file (no state). */
function tailEvents(
  file: string,
  from: number,
  carry: string,
): { events: PiEvent[]; offset: number; carry: string } {
  if (!existsSync(file)) return { events: [], offset: from, carry };
  const size = statSync(file).size;
  if (size <= from) return { events: [], offset: from, carry };
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(size - from);
  readSync(fd, buf, 0, buf.length, from);
  closeSync(fd);
  const lines = (carry + buf.toString('utf8')).split('\n');
  const nextCarry = lines.pop() ?? '';
  const events: PiEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line) as PiEvent); } catch { /* skip a torn line */ }
  }
  return { events, offset: size, carry: nextCarry };
}

/** Parse a node's io.json ledger (phase override + declared read/write paths), or null. Mirrors the
 *  buildRunView per-node io parse so `assembleNode` sees the SAME ledger shape from BOTH paths. */
function readIoLedger(runDir: string, id: string): NodeIoLedger | null {
  const ioFile = nodeIoFile(runDir, id);
  if (!fssync.existsSync(ioFile)) return null;
  try {
    const io = JSON.parse(fssync.readFileSync(ioFile, 'utf8')) as { phase?: string | null; reads?: { path?: unknown }[]; writes?: { path?: unknown }[] };
    const paths = (arr: { path?: unknown }[] | undefined) => (arr ?? []).map((x) => x?.path).filter((p): p is string => typeof p === 'string');
    return { phase: io.phase, reads: paths(io.reads), writes: paths(io.writes) };
  } catch {
    return null;
  }
}

/** The run-scoped closures `assembleNode` needs — built ONCE per stream, the SAME way buildRunView(runDir)
 *  does for a live run (no workspaceRoot, no historyDirs). `ckJournal`/`readMarkerSync` re-read each poll so
 *  an awaiting-input node is re-evaluated on both the snapshot AND every enriched delta (M1 contract). */
function buildAssembleCtx(runDir: string, catalog: ModelCatalog): AssembleNodeCtx {
  const runResolved = path.resolve(runDir);
  const toAbs = (p: string): string => (path.isAbsolute(p) ? p : path.join(runResolved, p));
  const underRun = (abs: string): boolean => abs === runResolved || abs.startsWith(runResolved + path.sep);
  // No workspaceRoot for a live run ⇒ only the {{RUN}} root strips; anything else falls back to a basename
  // (identical to makeDisplayPath(runDir, null) in buildRunView).
  const displayPath = (abs: unknown): string => {
    if (typeof abs !== 'string') return String(abs);
    if (abs.startsWith(runResolved + path.sep)) return abs.slice(runResolved.length + 1);
    if (!abs.startsWith('/')) return abs;
    return abs.replace(/^.*\//, '');
  };
  const readCkJournal = (): Record<string, CheckpointJournalSlot> => {
    try {
      const st = JSON.parse(fssync.readFileSync(path.join(runResolved, '.pi', 'state.json'), 'utf8')) as Record<string, unknown>;
      const ch = st.__checkpoints__;
      if (ch && typeof ch === 'object') return ch as Record<string, CheckpointJournalSlot>;
    } catch { /* no state.json yet */ }
    return {};
  };
  const readMarkerSync = (id: string): CheckpointMarker | null => {
    try {
      return JSON.parse(fssync.readFileSync(path.join(runResolved, '.pi', 'checkpoints', `${id}.json`), 'utf8')) as CheckpointMarker;
    } catch {
      return null;
    }
  };
  return {
    toAbs, underRun, displayPath, catalog,
    // No history dirs for a live run ⇒ expectedMs falls back to the node's own duration (buildRunView default).
    expected: {}, samples: {},
    // Re-read the checkpoint journal per assemble so a mid-run resolution is reflected in the delta.
    get ckJournal(): Record<string, CheckpointJournalSlot> { return readCkJournal(); },
    readMarkerSync,
  } as AssembleNodeCtx;
}

/** The STABLE fold-signature of an enriched node — a change in ANY of these emits a `node-enriched` delta.
 *  It is `tokens.billable | tokens.contextPeak | toolCalls | any derived tone/flag`, and EXCLUDES every live
 *  clock / `updatedAt` / elapsed (those tick every poll and would defeat the cost win; `deriveNode.time` is
 *  already `null` for a running node, so the signature is stable). (DR3.) */
function foldSignature(node: RunViewNode): string {
  const d = node.derived;
  const tones = d
    ? [
        d.cacheHit?.tone ?? '', d.toolError.tone, d.context.tone, d.retries.tone,
        d.time?.tone ?? '', d.dominance.dominant ? 'D' : '',
      ].join('|')
    : '';
  return [node.tokens?.billable ?? 0, node.tokens?.contextPeak ?? 0, node.toolCalls, tones].join('~');
}

/** Merge the enriched fields `assembleNode` produced onto the lean snapshot NodeView (M4: the WHOLE node,
 *  not just tokens+derived, so no rendered field blanks). Only the additive enriched fields are copied;
 *  the lean status/artifact/placement fields the snapshot already carries are preserved. */
function mergeEnriched(base: NodeView, full: RunViewNode): NodeView {
  return {
    ...base,
    tokens: full.tokens,
    derived: full.derived,
    model: full.model,
    contextWindow: full.contextWindow,
    toolCalls: full.toolCalls,
    toolBreakdown: full.toolBreakdown,
    timeline: full.timeline,
    reads: full.reads,
    writes: full.writes,
    artifacts: full.artifacts,
    retries: full.retries,
    stopReason: full.stopReason,
    truncated: full.truncated,
    summary: full.summary,
  };
}

/** Fold the run-level token total across the enriched nodes EXACTLY as buildRunView does
 *  (sum billable/input/output/cache/cost, MAX contextPeak). */
function foldTokenTotal(nodes: RunViewNode[]): RunTokens {
  return nodes.reduce((acc, n) => {
    const t = n.tokens || ({} as RunTokens);
    acc.input += t.input || 0; acc.output += t.output || 0; acc.cacheRead += t.cacheRead || 0;
    acc.cacheWrite += t.cacheWrite || 0; acc.cost += t.cost || 0; acc.billable += t.billable || 0;
    acc.contextPeak = Math.max(acc.contextPeak, t.contextPeak || 0);
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, billable: 0, contextPeak: 0 });
}

/**
 * Tail a run live. Yields an ENRICHED snapshot, then status/event/enriched/done deltas, until the run is
 * `done` or the signal aborts. SAFE to start before the run has written anything: the first readable
 * run.json produces the snapshot; until then it polls (and an abort still returns promptly).
 *
 * The stream folds per-node telemetry INCREMENTALLY (one long-lived accumulator/node) via the SHARED
 * assembly, so the snapshot's nodes carry the full enriched fields (tokens/derived/toolCalls/…), the run
 * carries `tokenTotal`, and a `node-enriched` delta fires the moment a node's stable fold-signature changes.
 */
export async function* watchRun(runDir: string, opts: WatchOpts = {}): AsyncIterable<RunUpdate> {
  const pollMs = opts.pollMs ?? 700;
  const signal = opts.signal;

  const aborted = (): boolean => !!signal?.aborted;
  if (aborted()) return; // already-aborted ⇒ yield nothing, return immediately

  const lastStatus = new Map<string, NodeStatus>(); // per-node DERIVED status, for change detection
  const offsets = new Map<string, number>();        // per-node consumed byte offset of events.jsonl
  const carry = new Map<string, string>();          // per-node trailing partial line
  // ONE long-lived accumulator per node id — SEEDED on the first snapshot, fed the tail thereafter. NEVER
  // recreated mid-stream (a fresh accumulator would drop the folded history). Each connection is a fresh
  // watchRun ⇒ a fresh Map ⇒ a fresh seed-from-0 (the reconnect open-span reconstruction, DR6).
  const accs = new Map<string, NodeAccumulator>();
  const lastSig = new Map<string, string>();        // per-node last fold-signature (for node-enriched deltas)
  let sentSnapshot = false;

  const catalog = loadModelCatalog();
  const ctx = buildAssembleCtx(runDir, catalog);

  /** Assemble the enriched node from its long-lived accumulator + the raw run.json record + io ledger. */
  const enrich = (rec: NodeStatusRecord, acc: NodeAccumulator): RunViewNode => {
    const rich = acc.snapshot(rec); // NON-DESTRUCTIVE — never finalize() on a live accumulator
    const ledger = readIoLedger(runDir, rec.id);
    return assembleNode(rec, rich, ledger, ctx);
  };

  for (;;) {
    if (aborted()) return;

    // 1) snapshot/poll the model (atomic run.json ⇒ never torn). Skip a poll cleanly if run.json absent.
    let model: RunModel;
    let raw;
    try {
      model = await readRunModel(runDir);
      raw = await readRunJson(runDir);
    } catch {
      await sleep(pollMs, signal);
      continue;
    }
    // The raw NodeStatusRecord map — the source of rec.usage/model/artifacts the enrichment needs. If it is
    // momentarily unreadable (mid-write, never torn but could be absent), skip enrichment this poll.
    const recById: Record<string, NodeStatusRecord> = raw?.nodes ?? {};

    // SEED the accumulators + offsets from the CURRENT files BEFORE the snapshot: replay each node's
    // events.jsonl [0,size) through its long-lived accumulator via the SAME tailEvents primitive, and store
    // the offset that read returned (M2: the seed bytes and the stored offset MUST come from ONE read — no
    // separate statSync — or a line folds twice or is skipped). This runs once (on the first poll that has a
    // model); a node that first appears later is seeded in the delta branch below.
    const seedNode = (id: string): void => {
      const acc = createNodeAccumulator();
      const file = nodeEventsFile(runDir, id);
      const { events, offset, carry: nextCarry } = tailEvents(file, 0, '');
      for (const e of events) acc.push(e);
      accs.set(id, acc);
      offsets.set(id, offset);
      carry.set(id, nextCarry);
    };

    const wasSnapshotPoll = !sentSnapshot;
    if (!sentSnapshot) {
      for (const n of model.nodes) {
        lastStatus.set(n.id, n.status);
        seedNode(n.id);
      }
      // ENRICH each node from its just-seeded accumulator, MERGE onto the lean snapshot node, fold tokenTotal.
      const enrichedNodes: RunViewNode[] = [];
      for (let i = 0; i < model.nodes.length; i++) {
        const n = model.nodes[i];
        const rec = recById[n.id];
        const acc = accs.get(n.id);
        if (!rec || !acc) continue;
        const full = enrich(rec, acc);
        enrichedNodes.push(full);
        model.nodes[i] = mergeEnriched(n, full);
        lastSig.set(n.id, foldSignature(full));
      }
      model.tokenTotal = foldTokenTotal(enrichedNodes);
      sentSnapshot = true;
      yield { kind: 'snapshot', model };
    } else {
      // 2) node-status deltas — a node whose DERIVED status changed since last poll. A node that first
      //    APPEARS after the snapshot (prev undefined) only seeds the baseline — no spurious delta.
      for (const n of model.nodes) {
        const prev = lastStatus.get(n.id);
        if (prev === n.status) continue;
        lastStatus.set(n.id, n.status);
        if (prev !== undefined) yield { kind: 'node-status', id: n.id, status: n.status };
      }
    }

    // 3) node-event deltas — new events.jsonl lines per node (offset tail) — FED into the long-lived
    //    accumulator so the fold advances incrementally. A node that first appears after the snapshot is
    //    seeded here (seed-from-0 through the same accumulator) so its history is never skipped.
    for (const n of model.nodes) {
      if (!accs.has(n.id)) { seedNode(n.id); }
      const acc = accs.get(n.id)!;
      const file = nodeEventsFile(runDir, n.id);
      const from = offsets.get(n.id) ?? 0;
      const { events, offset, carry: nextCarry } = tailEvents(file, from, carry.get(n.id) ?? '');
      offsets.set(n.id, offset);
      carry.set(n.id, nextCarry);
      for (const event of events) {
        if (aborted()) return;
        acc.push(event);
        yield { kind: 'node-event', id: n.id, event };
      }
    }

    // 4) node-enriched deltas (post-snapshot) — re-assemble each node from its long-lived accumulator + the
    //    current record, and emit the FULL node when its STABLE fold-signature changed (DR3/M4). This fires
    //    on token/toolCall/derived-tone change AND on a checkpoint/status change carried on the record; it
    //    EXCLUDES the live clock, so an idle node emits nothing. Skipped on the snapshot poll itself (the
    //    snapshot already carried every node's enriched fields + seeded lastSig).
    if (!wasSnapshotPoll) {
      for (const n of model.nodes) {
        const rec = recById[n.id];
        const acc = accs.get(n.id);
        if (!rec || !acc) continue;
        const full = enrich(rec, acc);
        const sig = foldSignature(full);
        if (lastSig.get(n.id) !== sig) {
          lastSig.set(n.id, sig);
          yield { kind: 'node-enriched', id: n.id, node: mergeEnriched(n, full) };
        }
      }
    }

    // 5) done — terminal. Emit a final snapshot-consistent `done` and stop.
    if (model.done) {
      yield { kind: 'done' };
      return;
    }

    await sleep(pollMs, signal);
  }
}
