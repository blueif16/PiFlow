import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runJsonFile,
  nodeEventsFile,
  writeNodeIo,
  checkpointMarkerFile,
} from '../src/runner/layout.js';
import type { RunStatus, NodeStatusRecord } from '../src/runner/status.js';
import type { NodeIo } from '../src/types.js';
import type { PiEvent } from '../src/runner/events.js';
import type { CheckpointMarker } from '../src/runner/checkpoint.js';
import { hashCheckpoint } from '../src/runner/checkpoint.js';
import { watchRun } from '../src/observe/watch.js';
import { buildRunView } from '../src/observe/runView.js';
import type { RunUpdate, NodeView } from '../src/observe/types.js';

// ── P2 — watchRun folds telemetry server-side (incremental accumulator) + node-enriched deltas ────────
// These tests pin the P2 acceptance bar (design §10 P2): the SSE stream is the single ENRICHED live source
// — it seeds one long-lived accumulator per node from events.jsonl [0,size) via the SAME tailEvents
// primitive, feeds the incremental tail into it, and re-assembles the FULL node via the SHARED assembly
// (assembleNode + nodeTokenSpine + deriveNode) over the NON-DESTRUCTIVE acc.snapshot(). A node-enriched
// delta fires on a stable fold-signature change; the enriched snapshot deep-equals buildRunView per-node.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mkRunDir = (): string => mkdtempSync(path.join(tmpdir(), 'piflow-watch-'));

const rec = (id: string, label: string, status: NodeStatusRecord['status'], extra: Partial<NodeStatusRecord> = {}): NodeStatusRecord => ({
  id, label, status, artifacts: [], issues: [], ...extra,
});

/** One assistant message_end that accrues `input`/`output` billable + `totalTokens` context. */
const usageEvent = (input: number, output: number, totalTokens: number, extra: Record<string, unknown> = {}): PiEvent =>
  ({ type: 'message_end', message: { role: 'assistant', model: 'm1', provider: 'cp', usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens }, ...extra } }) as unknown as PiEvent;

/** Write run.json only (never the events files) — used mid-stream so an appended line is never clobbered. */
async function writeRunJson(runDir: string, status: RunStatus): Promise<void> {
  const rj = runJsonFile(runDir);
  await fs.mkdir(path.dirname(rj), { recursive: true });
  await fs.writeFile(rj, JSON.stringify(status, null, 2));
}

/** Write one node's io.json + its (initial) events.jsonl via the layout helpers. */
async function writeNodeFixture(runDir: string, io: NodeIo, events: PiEvent[] = []): Promise<void> {
  await writeNodeIo(runDir, io);
  if (events.length) {
    const ef = nodeEventsFile(runDir, io.id);
    await fs.mkdir(path.dirname(ef), { recursive: true });
    await fs.writeFile(ef, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
}

/** Append raw text (may be a partial line, no trailing \n) to a node's events.jsonl. */
async function appendRaw(runDir: string, id: string, text: string): Promise<void> {
  const ef = nodeEventsFile(runDir, id);
  await fs.mkdir(path.dirname(ef), { recursive: true });
  await fs.appendFile(ef, text);
}

/** Append whole event lines to a node's events.jsonl. */
const appendEvents = (runDir: string, id: string, events: PiEvent[]): Promise<void> =>
  appendRaw(runDir, id, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (a) ANTI-FREEZE — an accruing running node emits node-enriched deltas with ADVANCING tokens.billable
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('watchRun — anti-freeze: a running node emits node-enriched with advancing billable', () => {
  it('emits node-enriched deltas whose tokens.billable STRICTLY ADVANCES across polls', async () => {
    const runDir = mkRunDir();
    const status: RunStatus = {
      run: 'af1', provider: 'cp', model: 'm1',
      startedAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:01.000Z',
      done: false, ok: null, durationMs: null, stage: null, totals: null,
      nodes: { r0: rec('r0', 'Runner', 'running', { model: 'm1' }) },
    };
    await writeRunJson(runDir, status);
    // Seed with ONE usage event so the snapshot already has some billable (10+2 = 12).
    await writeNodeFixture(
      runDir,
      { id: 'r0', label: 'Runner', phase: null, reads: [], writes: [], promotes: [], status: 'running' },
      [usageEvent(10, 2, 12)],
    );

    const ctrl = new AbortController();
    const updates: RunUpdate[] = [];

    // Drive: after the snapshot lands, append two MORE usage events across two poll windows so billable
    // climbs 12 → 24 → 39. Then mark done. Each append must be observed (its node-enriched seen) before the next.
    const driver = (async () => {
      while (!updates.some((u) => u.kind === 'snapshot')) await sleep(5);

      await appendEvents(runDir, 'r0', [usageEvent(10, 2, 20)]); // billable → 24
      while (!updates.some((u) => u.kind === 'node-enriched' && (u.node.tokens?.billable ?? 0) >= 24)) await sleep(5);

      await appendEvents(runDir, 'r0', [usageEvent(12, 3, 30)]); // billable → 39
      while (!updates.some((u) => u.kind === 'node-enriched' && (u.node.tokens?.billable ?? 0) >= 39)) await sleep(5);

      status.done = true; status.ok = true; status.durationMs = 1000;
      status.nodes.r0.status = 'ok';
      await writeRunJson(runDir, status);
    })();

    for await (const u of watchRun(runDir, { signal: ctrl.signal, pollMs: 10 })) {
      updates.push(u);
      if (u.kind === 'done') break;
    }
    await driver;

    // The snapshot already carried the seeded billable (server-side fold, not blank).
    const snap = updates[0] as Extract<RunUpdate, { kind: 'snapshot' }>;
    expect(snap.kind).toBe('snapshot');
    expect(snap.model.nodes.find((n) => n.id === 'r0')?.tokens?.billable).toBe(12);

    // Collect the billable values from the node-enriched deltas — they must ADVANCE (12 <) 24 < 39.
    const enriched = updates.filter((u): u is Extract<RunUpdate, { kind: 'node-enriched' }> => u.kind === 'node-enriched' && u.id === 'r0');
    const billables = enriched.map((u) => u.node.tokens?.billable ?? -1);
    expect(billables).toContain(24);
    expect(billables).toContain(39);
    // STRICTLY advancing: the 2nd emitted value is greater than the 1st (a frozen/non-folding stream fails this).
    const distinct = [...new Set(billables)].filter((b) => b > 12);
    expect(distinct.length).toBeGreaterThanOrEqual(2);
    expect(distinct[distinct.length - 1]).toBeGreaterThan(distinct[0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (b) OPEN-SPAN — a tool span open at snapshot time projects read-only; a later real _end yields the
//     correct CLOSED span in a subsequent snapshot/delta (a finalize-based fold would corrupt this).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('watchRun — open-span correctness (non-destructive snapshot, real _end wins)', () => {
  it('projects an open span read-only, then a later real _end yields the correct durMs/ok', async () => {
    const runDir = mkRunDir();
    const status: RunStatus = {
      run: 'os1', provider: 'cp', model: 'm1',
      startedAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:01.000Z',
      done: false, ok: null, durationMs: null, stage: null, totals: null,
      nodes: { t0: rec('t0', 'Tooler', 'running', { model: 'm1' }) },
    };
    await writeRunJson(runDir, status);
    // Seed with a tool_execution_start that has NO end yet (an OPEN span at snapshot time).
    await writeNodeFixture(
      runDir,
      { id: 't0', label: 'Tooler', phase: null, reads: [], writes: [], promotes: [], status: 'running' },
      [{ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'sleep' }, _t: 100 } as unknown as PiEvent],
    );

    const ctrl = new AbortController();
    const updates: RunUpdate[] = [];
    let sawOpen = false;

    const driver = (async () => {
      while (!updates.some((u) => u.kind === 'snapshot')) await sleep(5);
      // The snapshot's timeline projects the open span read-only (durMs:0, ok:true) WITHOUT closing it.
      const snap = updates[0] as Extract<RunUpdate, { kind: 'snapshot' }>;
      const t0 = snap.model.nodes.find((n) => n.id === 't0')!;
      const open = (t0.timeline ?? []).find((s) => s.name === 'bash');
      sawOpen = !!open && open.durMs === 0 && open.ok === true;

      // Now the REAL _end arrives with an error verdict — the span must close with the REAL durMs/ok, NOT
      // the synth durMs:0/ok:true a destructive finalize() would have stamped mid-run.
      await appendEvents(runDir, 't0', [
        { type: 'tool_execution_end', toolCallId: 'c1', isError: true, _t: 350 } as unknown as PiEvent,
      ]);
      // wait for a node-enriched delta whose span carries the real close.
      while (!updates.some((u) => u.kind === 'node-enriched' && u.id === 't0' &&
        (u.node.timeline ?? []).some((s) => s.name === 'bash' && s.durMs === 250 && s.ok === false))) await sleep(5);

      status.done = true; status.ok = true; status.durationMs = 500;
      status.nodes.t0.status = 'ok';
      await writeRunJson(runDir, status);
    })();

    for await (const u of watchRun(runDir, { signal: ctrl.signal, pollMs: 10 })) {
      updates.push(u);
      if (u.kind === 'done') break;
    }
    await driver;

    // (1) the snapshot projected the OPEN span read-only.
    expect(sawOpen).toBe(true);

    // (2) a later real _end produced the CORRECT closed span: durMs 350-100=250, ok=false (isError). If the
    //     live path had used the destructive finalize() the open span would have been synth-closed to
    //     durMs:0/ok:true and the real _end dropped — this assertion would fail.
    const enrichedClosed = updates.filter((u): u is Extract<RunUpdate, { kind: 'node-enriched' }> => u.kind === 'node-enriched' && u.id === 't0')
      .flatMap((u) => (u.node.timeline ?? []))
      .filter((s) => s.name === 'bash');
    const closed = enrichedClosed.find((s) => s.durMs === 250);
    expect(closed).toBeTruthy();
    expect(closed?.ok).toBe(false);
    // exactly ONE bash span in the final delta (no double-push from a per-tick finalize).
    const lastDelta = [...updates].reverse().find((u): u is Extract<RunUpdate, { kind: 'node-enriched' }> => u.kind === 'node-enriched' && u.id === 't0');
    expect((lastDelta!.node.timeline ?? []).filter((s) => s.name === 'bash').length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (c) BYTE-ALIGNMENT — a partial line appended between the seed and the first tail poll → folded totals
//     equal a single full replay (no line folded twice or skipped).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('watchRun — byte-alignment: seed + partial-line tail equals a single full replay', () => {
  it('folds totals byte-identically to buildRunView when a partial line lands between seed and tail', async () => {
    const runDir = mkRunDir();
    const status: RunStatus = {
      run: 'ba1', provider: 'cp', model: 'm1',
      startedAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:01.000Z',
      done: false, ok: null, durationMs: null, stage: null, totals: null,
      nodes: { b0: rec('b0', 'Byter', 'running', { model: 'm1' }) },
    };
    await writeRunJson(runDir, status);
    // Seed with ONE full usage line (billable 10).
    const seed = usageEvent(8, 2, 30);
    await writeNodeFixture(
      runDir,
      { id: 'b0', label: 'Byter', phase: null, reads: [], writes: [], promotes: [], status: 'running' },
      [seed],
    );
    // The two more events that will land, one arriving as a PARTIAL (unterminated) line first.
    const ev2 = usageEvent(5, 5, 40); // billable → +10
    const ev3 = usageEvent(7, 3, 50); // billable → +10
    const ev2line = JSON.stringify(ev2);
    const ev3line = JSON.stringify(ev3);

    const ctrl = new AbortController();
    const updates: RunUpdate[] = [];

    const driver = (async () => {
      while (!updates.some((u) => u.kind === 'snapshot')) await sleep(5);
      // Append ev2 as a PARTIAL line (no trailing newline) — the tail must carry it, not fold it yet.
      await appendRaw(runDir, 'b0', ev2line);
      await sleep(30); // let at least one tail poll observe the partial (it should NOT count it)
      // Complete ev2's line and append a full ev3 line.
      await appendRaw(runDir, 'b0', '\n' + ev3line + '\n');
      // wait until both are folded (billable 10 + 10 + 10 = 30).
      while (!updates.some((u) => u.kind === 'node-enriched' && (u.node.tokens?.billable ?? 0) >= 30)) await sleep(5);

      status.done = true; status.ok = true; status.durationMs = 1000;
      status.nodes.b0.status = 'ok';
      await writeRunJson(runDir, status);
    })();

    for await (const u of watchRun(runDir, { signal: ctrl.signal, pollMs: 10 })) {
      updates.push(u);
      if (u.kind === 'done') break;
    }
    await driver;

    // ORACLE: buildRunView over the FINAL on-disk state (all three lines) is the single-full-replay truth.
    const { view } = buildRunView(runDir);
    const oracle = view.nodes.find((n) => n.id === 'b0')!;
    expect(oracle.tokens.billable).toBe(30);        // 10 + 10 + 10 — no double count, no skip
    expect(oracle.tokens.contextPeak).toBe(50);     // MAX totalTokens across the three

    // The streamed fold must match the single-replay oracle EXACTLY (no line folded twice or skipped).
    const finalEnriched = [...updates].reverse().find((u): u is Extract<RunUpdate, { kind: 'node-enriched' }> => u.kind === 'node-enriched' && u.id === 'b0');
    expect(finalEnriched).toBeTruthy();
    expect(finalEnriched!.node.tokens?.billable).toBe(oracle.tokens.billable);
    expect(finalEnriched!.node.tokens?.contextPeak).toBe(oracle.tokens.contextPeak);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (d) contextPeak MAX — a peak event then a LOWER one → contextPeak does not drop.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('watchRun — contextPeak is a running MAX (never drops on a lower later event)', () => {
  it('keeps the high contextPeak after a subsequent lower-context event', async () => {
    const runDir = mkRunDir();
    const status: RunStatus = {
      run: 'cp1', provider: 'cp', model: 'm1',
      startedAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:01.000Z',
      done: false, ok: null, durationMs: null, stage: null, totals: null,
      nodes: { p0: rec('p0', 'Peaker', 'running', { model: 'm1' }) },
    };
    await writeRunJson(runDir, status);
    // Seed with a HIGH-context event (totalTokens 900).
    await writeNodeFixture(
      runDir,
      { id: 'p0', label: 'Peaker', phase: null, reads: [], writes: [], promotes: [], status: 'running' },
      [usageEvent(5, 5, 900)],
    );

    const ctrl = new AbortController();
    const updates: RunUpdate[] = [];

    const driver = (async () => {
      while (!updates.some((u) => u.kind === 'snapshot')) await sleep(5);
      // A LOWER-context event follows (totalTokens 100) — it must NOT drop the peak, but it DOES advance
      // billable (5+5 → +10), which is what triggers the node-enriched delta we then inspect.
      await appendEvents(runDir, 'p0', [usageEvent(5, 5, 100)]);
      while (!updates.some((u) => u.kind === 'node-enriched' && (u.node.tokens?.billable ?? 0) >= 20)) await sleep(5);

      status.done = true; status.ok = true; status.durationMs = 1000;
      status.nodes.p0.status = 'ok';
      await writeRunJson(runDir, status);
    })();

    for await (const u of watchRun(runDir, { signal: ctrl.signal, pollMs: 10 })) {
      updates.push(u);
      if (u.kind === 'done') break;
    }
    await driver;

    // The snapshot already peaked at 900.
    const snap = updates[0] as Extract<RunUpdate, { kind: 'snapshot' }>;
    expect(snap.model.nodes.find((n) => n.id === 'p0')?.tokens?.contextPeak).toBe(900);

    // After the lower event, the delta STILL reports 900 (a naive "last value" fold would report 100).
    const afterLower = updates.filter((u): u is Extract<RunUpdate, { kind: 'node-enriched' }> => u.kind === 'node-enriched' && u.id === 'p0' && (u.node.tokens?.billable ?? 0) >= 20);
    expect(afterLower.length).toBeGreaterThanOrEqual(1);
    expect(afterLower[afterLower.length - 1].node.tokens?.contextPeak).toBe(900);
    // and the run-level tokenTotal.contextPeak (folded MAX) is 900 on the snapshot too.
    expect(snap.model.tokenTotal?.contextPeak).toBe(900);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (e) MIRROR (the strong oracle) — watchRun's enriched snapshot per-node deep-equals buildRunView over a
//     fixture dir with a pi node, a Claude/rec.usage node, a reused node, and an awaiting-input node.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('watchRun — enriched snapshot mirrors buildRunView per-node (pi + Claude + reused + awaiting)', () => {
  it('deep-equals tokens+derived+toolCalls+toolBreakdown+reads+writes+artifacts+model over 4 node kinds', async () => {
    const runDir = mkRunDir();

    // Build a SETTLED run (done) so the snapshot equals the terminal buildRunView — a live snapshot with no
    // open spans folds byte-identically to the batch builder (the whole invariant of the shared assembly).
    const status: RunStatus = {
      run: 'mir1', provider: 'cp', model: 'm1',
      startedAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:05.000Z',
      done: false, ok: null, durationMs: null,
      stage: null, totals: null,
      nodes: {
        // (1) PI node — sourced from the event replay (no rec.usage). reads + a write + a tool span.
        pi: rec('pi', 'Pi Node', 'ok', { model: 'm1', durationMs: 4000, artifacts: [{ path: 'out/pi.txt', exists: true, bytes: 3 }] }),
        // (2) CLAUDE node — blank event replay, authoritative rec.usage spine.
        cl: rec('cl', 'Claude Node', 'ok', {
          model: 'claude-haiku-4-5-20251001', durationMs: 3000,
          artifacts: [{ path: 'out/cl.txt', exists: true, bytes: 5 }],
          usage: { inputTokens: 18, outputTokens: 337, cacheRead: 17172, cacheCreation: 4790, cost: 0.0130002, contextWindow: 200000, numTurns: 2, stopReason: 'end_turn' },
        }),
        // (3) REUSED node — no events, no usage → all-zero telemetry shape (parity is both being blank).
        ru: rec('ru', 'Reused Node', 'reused', { model: 'm1' }),
        // (4) AWAITING-INPUT node — a pending checkpoint marker on disk drives status 'awaiting-input'.
        aw: rec('aw', 'Ask Node', 'running', { model: 'm1' }),
      },
    };
    await writeRunJson(runDir, status);

    // pi node: a read + a write + one tool span + a usage rollup.
    const piEvents: PiEvent[] = [
      { type: 'message_start', message: { role: 'assistant', model: 'm1', provider: 'cp' } },
      { type: 'tool_execution_start', toolCallId: '1', toolName: 'read', args: { path: 'spec/in.txt' }, _t: 0 },
      { type: 'tool_execution_end', toolCallId: '1', isError: false, _t: 10 },
      { type: 'tool_execution_start', toolCallId: '2', toolName: 'write', args: { path: 'out/pi.txt' }, _t: 20 },
      { type: 'tool_execution_end', toolCallId: '2', isError: false, _t: 30 },
      { type: 'message_end', message: { role: 'assistant', usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, cost: 0.5, totalTokens: 1000 }, stopReason: 'end_turn' } },
    ] as unknown as PiEvent[];
    await writeNodeFixture(
      runDir,
      { id: 'pi', label: 'Pi Node', phase: null, reads: [{ path: 'spec/in.txt' }], writes: [{ path: 'out/pi.txt', verified: true, bytes: 3 }], promotes: [], status: 'ok' },
      piEvents,
    );
    await fs.mkdir(path.resolve(runDir, 'out'), { recursive: true });
    await fs.mkdir(path.resolve(runDir, 'spec'), { recursive: true });
    await fs.writeFile(path.resolve(runDir, 'out/pi.txt'), 'pi!');
    await fs.writeFile(path.resolve(runDir, 'spec/in.txt'), 'input-bytes');

    // Claude node: NO events (blank replay), the spine comes from rec.usage.
    await writeNodeFixture(
      runDir,
      { id: 'cl', label: 'Claude Node', phase: null, reads: [], writes: [{ path: 'out/cl.txt', verified: true, bytes: 5 }], promotes: [], status: 'ok' },
      [],
    );
    await fs.writeFile(path.resolve(runDir, 'out/cl.txt'), 'hello');

    // Reused node: an io ledger, no events.
    await writeNodeFixture(
      runDir,
      { id: 'ru', label: 'Reused Node', phase: null, reads: [], writes: [], promotes: [], status: 'reused' },
      [],
    );

    // Awaiting node: an io ledger + a PENDING checkpoint marker so both readers show 'awaiting-input'.
    await writeNodeFixture(
      runDir,
      { id: 'aw', label: 'Ask Node', phase: null, reads: [], writes: [], promotes: [], status: 'running' },
      [],
    );
    const spec = { kind: 'confirm' as const, prompt: 'Proceed?' };
    const marker: CheckpointMarker = {
      nodeId: 'aw', label: 'Ask Node', kind: 'confirm', prompt: 'Proceed?',
      headless: 'default', status: 'pending', askedAt: '2026-07-01T00:00:02.000Z',
      hash: hashCheckpoint(spec),
    };
    const mf = checkpointMarkerFile(runDir, 'aw');
    await fs.mkdir(path.dirname(mf), { recursive: true });
    await fs.writeFile(mf, JSON.stringify(marker));

    // ── the ORACLE: buildRunView over the SAME dir (live-run defaults: no history, no workspaceRoot). ──
    const { view } = buildRunView(runDir);
    const oracleById = Object.fromEntries(view.nodes.map((n) => [n.id, n]));

    // ── the STREAM: take the first snapshot's enriched nodes. ──
    const ctrl = new AbortController();
    let snapshot: Extract<RunUpdate, { kind: 'snapshot' }> | null = null;
    for await (const u of watchRun(runDir, { signal: ctrl.signal, pollMs: 10 })) {
      if (u.kind === 'snapshot') { snapshot = u; ctrl.abort(); break; }
    }
    expect(snapshot).toBeTruthy();
    const streamById = Object.fromEntries(snapshot!.model.nodes.map((n) => [n.id, n]));

    // The mirror: each enriched field the live graph renders deep-equals the batch builder's, per node.
    const mirrorFields = (a: NodeView, b: { tokens?: unknown; derived?: unknown; toolCalls: number; toolBreakdown: Record<string, number>; reads: unknown; writes: unknown; artifacts: unknown; model?: string | null; contextWindow?: number | null }) => {
      expect(a.tokens).toEqual(b.tokens);
      expect(a.derived).toEqual(b.derived);
      expect(a.toolCalls).toEqual(b.toolCalls);
      expect(a.toolBreakdown).toEqual(b.toolBreakdown);
      expect(a.reads).toEqual(b.reads);
      expect(a.writes).toEqual(b.writes);
      expect(a.artifacts).toEqual(b.artifacts);
      expect(a.model).toEqual(b.model);
      expect(a.contextWindow).toEqual(b.contextWindow);
    };

    for (const id of ['pi', 'cl', 'ru', 'aw']) {
      mirrorFields(streamById[id], oracleById[id]);
    }

    // Concrete teeth (not just "they're equal"): each node kind lit up the way its source dictates.
    // pi: from the event replay.
    expect(streamById.pi.tokens?.billable).toBe(120);
    expect(streamById.pi.toolCalls).toBe(2);
    expect(streamById.pi.reads?.length).toBe(1);
    expect(streamById.pi.writes?.length).toBe(1);
    // cl: from rec.usage (Claude spine).
    expect(streamById.cl.tokens?.billable).toBe(18 + 337);
    expect(streamById.cl.tokens?.contextPeak).toBe(18 + 17172 + 4790);
    expect(streamById.cl.contextWindow).toBe(200000);
    expect(streamById.cl.model).toBe('claude-haiku-4-5-20251001');
    // ru: reused → all-zero telemetry, matching the (blank) oracle.
    expect(streamById.ru.tokens?.billable).toBe(0);
    expect(streamById.ru.toolCalls).toBe(0);
    // aw: awaiting-input status carried on the enriched node (marker on disk).
    expect(streamById.aw.status).toBe('awaiting-input');
    expect(oracleById.aw.status).toBe('awaiting-input');

    // run-level tokenTotal folds across nodes exactly as buildRunView (sum billable, MAX contextPeak).
    expect(snapshot!.model.tokenTotal?.billable).toBe(view.tokenTotal?.billable);
    expect(snapshot!.model.tokenTotal?.contextPeak).toBe(view.tokenTotal?.contextPeak);
    expect(snapshot!.model.tokenTotal?.cost).toBeCloseTo(view.tokenTotal?.cost ?? -1, 9);
  });
});
