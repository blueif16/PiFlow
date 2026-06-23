import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJsonFile, type RunModel, type NodeView, type RunUpdate } from '@piflow/core';
import { buildRunFixture } from './fixture.js';
import { watchRun, type WatchResult } from '../src/watch.js';

// The sentinel is now a THIN consumer of the SHARED live stream (@piflow/core/observe watchRun): it
// subscribes to a `RunUpdate` sequence and fires ONE line on the terminal event. These tests inject a
// deterministic `RunUpdate` sequence (the `updates` seam) — no bespoke `.pi/` reader, no wall-clock
// sleep — keeping their observable assertions (silent-until-terminal, fires on done / node-failed).
async function* seq(updates: RunUpdate[]): AsyncIterable<RunUpdate> {
  for (const u of updates) yield u;
}

function nodeView(id: string, status: NodeView['status']): NodeView {
  return {
    id, label: id, phase: null, status, reported: status,
    artifactsVerified: 0, artifactsTotal: 0, missing: [], stageIndex: 1, lane: 0,
  };
}
function snapshot(nodes: NodeView[], extra: Partial<RunModel> = {}): RunUpdate {
  return {
    kind: 'snapshot',
    model: {
      run: 'r', done: false, ok: null, durationMs: null, stage: null, totals: null,
      nodes, stages: [], edges: [], ...extra,
    },
  };
}

describe('watch — silent sentinel over the shared @piflow/core/observe stream', () => {
  it('stays silent while running, then announces completion when done', async () => {
    const lines: string[] = [];
    const res: WatchResult = await watchRun({
      updates: seq([snapshot([nodeView('w0', 'running')]), { kind: 'done' }]),
      print: (l) => lines.push(l),
    });
    expect(res.reason).toBe('done');
    expect(res.ok).toBe(true);
    // Silent until the terminal event: exactly ONE announcement line, and it fires on `done`.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/DONE|done/i);
  });

  it('announces a failure the moment a node-status delta blocks (before the run is done)', async () => {
    const lines: string[] = [];
    const res = await watchRun({
      updates: seq([
        snapshot([nodeView('w0', 'running')]),
        { kind: 'node-status', id: 'w2', status: 'blocked' },
        { kind: 'done' },
      ]),
      print: (l) => lines.push(l),
    });
    expect(res.reason).toBe('node-failed');
    expect(res.node).toBe('w2');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/w2/);
  });

  it('announces a node error already present in the initial snapshot', async () => {
    const lines: string[] = [];
    const res = await watchRun({
      updates: seq([snapshot([nodeView('w0', 'error')])]),
      print: (l) => lines.push(l),
    });
    expect(res.reason).toBe('node-failed');
    expect(res.node).toBe('w0');
  });

  it('reads its stream source from a real .pi/run.json fixture (finished → done)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-watch-'));
    try {
      await buildRunFixture(dir, { done: true }); // done:true, ok:false (w2 blocked)
      const lines: string[] = [];
      // No injected source → the sentinel subscribes to the shared watchRun(rundir) stream off disk.
      const res = await watchRun({ rundir: dir, print: (l) => lines.push(l), pollMs: 10 });
      // The fixture is finished AND failed (w2 blocked) → the watcher fires on the first snapshot.
      expect(['done', 'node-failed']).toContain(res.reason);
      expect(lines).toHaveLength(1);
      // sanity: the run dir really holds the engine-written .pi/run.json (read via the layout helper).
      await fs.access(runJsonFile(dir));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
