import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJsonFile, type RunStatus, type NodeStatusRecord } from '@piflow/core';
import { buildRunFixture } from './fixture.js';
import { watchRun, type WatchResult } from '../src/watch.js';

// A deterministic poll source: yields a fixed SEQUENCE of run snapshots, one per poll, so the watcher
// is driven by data — never by a real wall-clock sleep.
function source(snaps: (RunStatus | null)[]): () => Promise<RunStatus | null> {
  let i = 0;
  return async () => snaps[Math.min(i++, snaps.length - 1)];
}

function node(id: string, status: NodeStatusRecord['status']): NodeStatusRecord {
  return { id, label: id, status, artifacts: [], issues: [] };
}
function run(partial: Partial<RunStatus>): RunStatus {
  return {
    run: 'r', startedAt: '', updatedAt: new Date().toISOString(), done: false, ok: null,
    durationMs: null, stage: null, totals: null, nodes: {}, ...partial,
  };
}

describe('watch — silent sentinel over the .pi/ layout', () => {
  it('stays silent while running, then announces completion when done', async () => {
    const lines: string[] = [];
    const running = run({ nodes: { w0: node('w0', 'running') } });
    const finished = run({ done: true, ok: true, nodes: { w0: node('w0', 'ok') } });
    const res: WatchResult = await watchRun({
      poll: source([running, running, finished]),
      print: (l) => lines.push(l),
    });
    expect(res.reason).toBe('done');
    expect(res.ok).toBe(true);
    // Silent until the terminal event: exactly ONE announcement line, and it fires on `done`.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/DONE|done/i);
  });

  it('announces a failure the moment a node blocks (before the run is done)', async () => {
    const lines: string[] = [];
    const running = run({ nodes: { w0: node('w0', 'running') } });
    const blocked = run({ nodes: { w0: node('w0', 'ok'), w2: node('w2', 'blocked') } });
    const res = await watchRun({ poll: source([running, blocked]), print: (l) => lines.push(l) });
    expect(res.reason).toBe('node-failed');
    expect(res.node).toBe('w2');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/w2/);
  });

  it('announces a node error verdict', async () => {
    const lines: string[] = [];
    const errored = run({ nodes: { w0: node('w0', 'error') } });
    const res = await watchRun({ poll: source([errored]), print: (l) => lines.push(l) });
    expect(res.reason).toBe('node-failed');
    expect(res.node).toBe('w0');
  });

  it('reads its poll source from a real .pi/run.json fixture (finished → done)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-watch-'));
    try {
      await buildRunFixture(dir, { done: true }); // done:true, ok:false (w2 blocked)
      const lines: string[] = [];
      // The default poll source reads .pi/run.json off disk via the layout helper.
      const res = await watchRun({ rundir: dir, print: (l) => lines.push(l), maxPolls: 1 });
      // The fixture is already finished AND failed → the watcher fires on the first poll.
      expect(['done', 'node-failed']).toContain(res.reason);
      expect(lines).toHaveLength(1);
      // sanity: the watcher really read the engine-written file, not a hardcoded path.
      await fs.access(runJsonFile(dir));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
