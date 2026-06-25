import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runJsonFile,
  nodeIoFile,
  nodeEventsFile,
  writeNodeIo,
} from '../src/runner/layout.js';
import type { RunStatus, NodeStatusRecord } from '../src/runner/status.js';
import type { NodeIo } from '../src/types.js';
import type { PiEvent } from '../src/runner/events.js';
import { readRunModel } from '../src/observe/read.js';
import { buildRunView } from '../src/observe/runView.js';
import { watchRun } from '../src/observe/watch.js';
import type { RunUpdate } from '../src/observe/types.js';

// ── fixture: a `.pi/` run dir built with the LAYOUT HELPERS (never a hardcoded path) ─────────────────
// Three+ nodes covering the bar: an `ok`, a `blocked` (record self-reports ok but a declared artifact
// is ABSENT on disk), a `running`, plus a parallel lane (b1‖b2 share the published stage barrier). One
// io-derived edge: `w0` writes spec/cls.json → `w1` reads it (a→b data-flow edge).

interface FixtureNode {
  rec: NodeStatusRecord;
  io?: NodeIo;
  /** Declared write paths to actually CREATE on disk (so artifactState sees them). */
  filesOnDisk?: { rel: string; body: string }[];
  events?: PiEvent[];
}

async function writeFixture(
  runDir: string,
  status: RunStatus,
  nodes: Record<string, FixtureNode>,
): Promise<void> {
  // write each node's on-disk artifacts (relative to the run dir).
  for (const fn of Object.values(nodes)) {
    for (const f of fn.filesOnDisk ?? []) {
      const abs = path.resolve(runDir, f.rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.body);
    }
  }
  // write run.json via the layout helper's path.
  const rj = runJsonFile(runDir);
  await fs.mkdir(path.dirname(rj), { recursive: true });
  await fs.writeFile(rj, JSON.stringify(status, null, 2));
  // write each node's io.json + events.jsonl via the layout helpers.
  for (const [id, fn] of Object.entries(nodes)) {
    if (fn.io) await writeNodeIo(runDir, fn.io);
    if (fn.events?.length) {
      const ef = nodeEventsFile(runDir, id);
      await fs.mkdir(path.dirname(ef), { recursive: true });
      await fs.writeFile(ef, fn.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
  }
}

// Rewrite ONLY run.json + the io ledgers (never the events files) — used mid-stream so an appended
// events.jsonl line is never clobbered by a full-file rewrite.
async function writeFixtureMeta(
  runDir: string,
  status: RunStatus,
  nodes: Record<string, FixtureNode>,
): Promise<void> {
  for (const fn of Object.values(nodes)) {
    for (const f of fn.filesOnDisk ?? []) {
      const abs = path.resolve(runDir, f.rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.body);
    }
  }
  await fs.writeFile(runJsonFile(runDir), JSON.stringify(status, null, 2));
  for (const fn of Object.values(nodes)) if (fn.io) await writeNodeIo(runDir, fn.io);
}

function baseFixture(): { status: RunStatus; nodes: Record<string, FixtureNode> } {
  const rec = (id: string, label: string, status: NodeStatusRecord['status'], extra: Partial<NodeStatusRecord> = {}): NodeStatusRecord => ({
    id, label, status, artifacts: [], issues: [], ...extra,
  });
  const status: RunStatus = {
    run: 'fix1',
    provider: 'cp',
    model: 'm1',
    startedAt: '2026-06-23T00:00:00.000Z',
    updatedAt: '2026-06-23T00:00:10.000Z',
    done: false,
    ok: null,
    durationMs: null,
    // The engine's last-published parallel barrier: b1 ‖ b2 run side-by-side.
    stage: { index: 2, total: 2, nodeIds: ['b1', 'b2'] },
    totals: null,
    nodes: {
      // w0: clean ok, one declared artifact PRESENT on disk → stays ok.
      w0: rec('w0', 'Classify', 'ok', { durationMs: 4000, artifacts: [{ path: 'spec/cls.json', exists: true, bytes: 12 }] }),
      // b1: record SELF-REPORTS ok, but its declared artifact is ABSENT → derived `blocked`.
      b1: rec('b1', 'Build A', 'ok', { durationMs: 3000, artifacts: [{ path: 'src/a.js', exists: false, bytes: 0 }] }),
      // b2: still running (parallel sibling of b1).
      b2: rec('b2', 'Build B', 'running', {}),
    },
  };
  const nodes: Record<string, FixtureNode> = {
    w0: {
      rec: status.nodes.w0,
      io: { id: 'w0', label: 'Classify', phase: 'design', reads: [], writes: [{ path: 'spec/cls.json', verified: true, bytes: 12 }], promotes: [], status: 'ok' },
      filesOnDisk: [{ rel: 'spec/cls.json', body: '{"a":1}' }],
    },
    b1: {
      rec: status.nodes.b1,
      // b1 READS w0's output (the edge w0→b1) and declares src/a.js — which we do NOT create on disk.
      io: { id: 'b1', label: 'Build A', phase: 'build', reads: [{ path: 'spec/cls.json' }], writes: [{ path: 'src/a.js', verified: false }], promotes: [], status: 'ok' },
    },
    b2: {
      rec: status.nodes.b2,
      io: { id: 'b2', label: 'Build B', phase: 'build', reads: [{ path: 'spec/cls.json' }], writes: [{ path: 'src/b.js', verified: false }], promotes: [], status: 'running' },
    },
  };
  return { status, nodes };
}

const mkRunDir = (): string => mkdtempSync(path.join(tmpdir(), 'piflow-observe-'));

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (2) readRunModel — the one-shot snapshot
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('readRunModel — the shared one-shot snapshot over a .pi/ run dir', () => {
  // G6 — the agentType LABEL is a verbatim passthrough from the node record through BOTH shared readers
  // (the lean readRunModel snapshot and the enriched buildRunView), so the GUI can key the preset icon off
  // it. FAILS if a reader drops it (the icon would never render). Additive: a node with none → undefined.
  it('surfaces the node record\'s agentType through readRunModel AND buildRunView (G6)', async () => {
    const runDir = mkRunDir();
    const { status, nodes } = baseFixture();
    status.nodes.w0.agentType = 'market-research';
    await writeFixture(runDir, status, nodes);

    const model = await readRunModel(runDir);
    const byId = Object.fromEntries(model.nodes.map((n) => [n.id, n]));
    expect(byId.w0.agentType).toBe('market-research');
    expect(byId.b2.agentType).toBeUndefined();

    const { view } = buildRunView(runDir);
    const vById = Object.fromEntries(view.nodes.map((n) => [n.id, n]));
    expect(vById.w0.agentType).toBe('market-research');
    expect(vById.b2.agentType).toBeUndefined();
  });

  it('maps status (verified-not-trusted), verified/total artifacts, the parallel lane, and io edges', async () => {
    const runDir = mkRunDir();
    const { status, nodes } = baseFixture();
    await writeFixture(runDir, status, nodes);

    const model = await readRunModel(runDir);

    expect(model.run).toBe('fix1');
    expect(model.done).toBe(false);
    expect(model.provider).toBe('cp');

    const byId = Object.fromEntries(model.nodes.map((n) => [n.id, n]));

    // w0: ok, artifact present → 1/1 verified, stays ok.
    expect(byId.w0.status).toBe('ok');
    expect(byId.w0.reported).toBe('ok');
    expect(byId.w0.artifactsVerified).toBe(1);
    expect(byId.w0.artifactsTotal).toBe(1);
    expect(byId.w0.missing).toEqual([]);

    // b1: record self-reports ok but src/a.js is ABSENT → derived blocked (the load-bearing mapping).
    expect(byId.b1.reported).toBe('ok');
    expect(byId.b1.status).toBe('blocked');
    expect(byId.b1.artifactsVerified).toBe(0);
    expect(byId.b1.artifactsTotal).toBe(1);
    expect(byId.b1.missing).toEqual(['src/a.js']);

    // b2: running passes through (makes no artifact claim yet).
    expect(byId.b2.status).toBe('running');

    // Parallel lane: b1 and b2 share the published barrier stage → same stageIndex, distinct lanes.
    expect(byId.b1.stageIndex).toBe(byId.b2.stageIndex);
    expect(new Set([byId.b1.lane, byId.b2.lane])).toEqual(new Set([0, 1]));
    const parallel = model.stages.find((s) => s.parallel);
    expect(parallel?.nodeIds.sort()).toEqual(['b1', 'b2']);

    // Edge: w0 wrote spec/cls.json which b1 read back → w0→b1 (b2 reads it too → w0→b2).
    const edge = model.edges.find((e) => e.from === 'w0' && e.to === 'b1');
    expect(edge).toBeTruthy();
    expect(edge?.path).toBe('spec/cls.json');
  });

  it('throws a clear error when the run dir has no readable .pi/run.json', async () => {
    const runDir = mkRunDir();
    await expect(readRunModel(runDir)).rejects.toThrow(/run\.json/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (3) watchRun — the single live stream
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('watchRun — snapshot, then node-status / node-event / done in order', () => {
  it('yields an initial snapshot then the matching deltas as the fixture mutates between polls', async () => {
    const runDir = mkRunDir();
    const { status, nodes } = baseFixture();
    // start b2 with one event already on disk (so the snapshot has a known event baseline).
    nodes.b2.events = [{ type: 'tool_execution_start', toolName: 'read', args: { path: 'spec/cls.json' } }];
    await writeFixture(runDir, status, nodes);

    const ctrl = new AbortController();
    const updates: RunUpdate[] = [];

    // Drive the fixture forward in lockstep with the poll loop: after the first snapshot lands, flip
    // b2 → ok, append a new events line, then mark the run done. A small pollMs makes it deterministic.
    const driver = (async () => {
      // wait until the consumer has the initial snapshot.
      while (!updates.some((u) => u.kind === 'snapshot')) await sleep(5);

      // 1) append a NEW events.jsonl line for b2 (→ a node-event update). Keep it in nodes.b2.events so
      //    the writeFixture rewrite below does NOT clobber it (writeFixture rewrites each node's file).
      const newEvent: PiEvent = { type: 'tool_execution_start', toolName: 'write', args: { path: 'src/b.js' } };
      nodes.b2.events!.push(newEvent);
      const ef = nodeEventsFile(runDir, 'b2');
      await fs.appendFile(ef, JSON.stringify(newEvent) + '\n');
      // 2) flip b2 → ok and write its declared artifact so the derived status is really ok.
      await fs.mkdir(path.resolve(runDir, 'src'), { recursive: true });
      await fs.writeFile(path.resolve(runDir, 'src/b.js'), 'console.log(1)');
      status.nodes.b2.status = 'ok';
      status.nodes.b2.artifacts = [{ path: 'src/b.js', exists: true, bytes: 14 }];
      nodes.b2.io!.writes[0].verified = true;
      // rewrite run.json + io.json ONLY (events already appended above; avoid the events rewrite).
      await writeFixtureMeta(runDir, status, nodes);

      // wait for the node-status delta to be observed before flipping done (deterministic ordering).
      while (!updates.some((u) => u.kind === 'node-status' && u.id === 'b2')) await sleep(5);

      // 3) mark the whole run done.
      status.done = true;
      status.ok = true;
      status.durationMs = 9000;
      await writeFixtureMeta(runDir, status, nodes);
    })();

    for await (const u of watchRun(runDir, { signal: ctrl.signal, pollMs: 10 })) {
      updates.push(u);
      if (u.kind === 'done') break;
    }
    await driver;

    // The FIRST update is the full snapshot.
    expect(updates[0].kind).toBe('snapshot');
    const snap = updates[0] as Extract<RunUpdate, { kind: 'snapshot' }>;
    expect(snap.model.run).toBe('fix1');
    expect(snap.model.nodes.find((n) => n.id === 'b2')?.status).toBe('running');

    // A node-status delta for b2 → ok was emitted.
    const statusDelta = updates.find((u) => u.kind === 'node-status' && u.id === 'b2');
    expect(statusDelta).toBeTruthy();
    expect((statusDelta as Extract<RunUpdate, { kind: 'node-status' }>).status).toBe('ok');

    // A node-event delta for the NEW b2 line (the write) was emitted — NOT the pre-snapshot read line.
    const evDeltas = updates.filter((u) => u.kind === 'node-event' && u.id === 'b2') as Extract<RunUpdate, { kind: 'node-event' }>[];
    expect(evDeltas.length).toBeGreaterThanOrEqual(1);
    expect(evDeltas.some((e) => (e.event as { toolName?: string }).toolName === 'write')).toBe(true);
    expect(evDeltas.some((e) => (e.event as { toolName?: string }).toolName === 'read')).toBe(false);

    // The terminal update is `done`, and it comes AFTER the b2 status delta.
    const lastKind = updates[updates.length - 1].kind;
    expect(lastKind).toBe('done');
    const iStatus = updates.findIndex((u) => u.kind === 'node-status' && u.id === 'b2');
    const iDone = updates.findIndex((u) => u.kind === 'done');
    expect(iStatus).toBeGreaterThanOrEqual(0);
    expect(iDone).toBeGreaterThan(iStatus);
  });

  // (4) abort: an already-aborted signal stops the iterator promptly without hanging.
  it('stops promptly when the signal is already aborted (no hang, no done required)', async () => {
    const runDir = mkRunDir();
    const { status, nodes } = baseFixture();
    await writeFixture(runDir, status, nodes);

    const ctrl = new AbortController();
    ctrl.abort();

    const updates: RunUpdate[] = [];
    const started = Date.now();
    for await (const u of watchRun(runDir, { signal: ctrl.signal, pollMs: 10 })) {
      updates.push(u);
    }
    // It must return quickly (well under any node timeout) and not hang.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stops promptly when the signal aborts MID-STREAM (the run never completes)', async () => {
    const runDir = mkRunDir();
    const { status, nodes } = baseFixture();
    await writeFixture(runDir, status, nodes); // run is NOT done and never will be

    const ctrl = new AbortController();
    const updates: RunUpdate[] = [];
    const loop = (async () => {
      for await (const u of watchRun(runDir, { signal: ctrl.signal, pollMs: 10 })) {
        updates.push(u);
      }
    })();
    // abort after the first snapshot is observed.
    while (!updates.some((u) => u.kind === 'snapshot')) await sleep(5);
    ctrl.abort();
    await loop; // must resolve (not hang) even though the run never reaches `done`.
    expect(updates[0].kind).toBe('snapshot');
  });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
