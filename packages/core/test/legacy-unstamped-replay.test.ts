// legacy-unstamped-replay.test.ts — Defect E1+E2, END-TO-END through the two real accumulator-selection
// call sites (`buildRunView`'s `replayEvents` and `watchRun`'s `seedNode` — packages/core/src/observe/
// runView.ts and watch.ts). A LEGACY run (no `driverId` stamped on any node — game-omni's old engine, the
// exact shape of game-omni p09's run.json) must no longer render a Claude node as model:null + all-zero
// tokens, and must NOT mis-detect a legacy PI node as Claude either. Both the batch builder and the live
// SSE fold are exercised here (they are NOT one shared function — replayEvents and seedNode are two
// separate call sites) — this is the SSE≡run-view parity proof for Defect E specifically.
//
// Run: npx vitest run packages/core/test/legacy-unstamped-replay.test.ts

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJsonFile, nodeEventsFile, writeNodeIo } from '../src/runner/layout.js';
import type { RunStatus } from '../src/runner/status.js';
import { buildRunView } from '../src/observe/runView.js';
import { watchRun } from '../src/observe/watch.js';
import type { RunUpdate } from '../src/observe/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mkRunDir = (): string => mkdtempSync(path.join(tmpdir(), 'piflow-legacy-replay-'));

async function writeRunJson(runDir: string, status: RunStatus): Promise<void> {
  const rj = runJsonFile(runDir);
  await fs.mkdir(path.dirname(rj), { recursive: true });
  await fs.writeFile(rj, JSON.stringify(status, null, 2));
}

/** Copy the real fixture's raw bytes straight to a node's events.jsonl — the exact file replayEvents/
 *  tailEvents read, with no re-serialization step that could mask a real parse issue. */
async function seedRealEventsFile(runDir: string, nodeId: string): Promise<void> {
  const src = path.join(here, 'fixtures', 'claude-stream-json-usage.ndjson');
  const raw = await fs.readFile(src, 'utf8');
  const ef = nodeEventsFile(runDir, nodeId);
  await fs.mkdir(path.dirname(ef), { recursive: true });
  await fs.writeFile(ef, raw);
}

const baseStatus = (nodes: RunStatus['nodes']): RunStatus => ({
  run: 'legacy1', startedAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:05.000Z',
  done: true, ok: true, durationMs: 5000, stage: null, totals: { nodes: 1, ok: 1, failed: 0 },
  nodes,
});

describe('buildRunView — an UNSTAMPED legacy Claude node is format-detected (Defect E1+E2)', () => {
  it('reports the real model + non-zero tokens instead of model:null + all-zero (the reported symptom)', async () => {
    const runDir = mkRunDir();
    // The EXACT legacy shape: driverId ABSENT, usage ABSENT — the node's only telemetry is events.jsonl.
    await writeRunJson(runDir, baseStatus({
      guidance: { id: 'guidance', label: 'Guidance', status: 'ok', artifacts: [], issues: [], durationMs: 52054 },
    }));
    await writeNodeIo(runDir, { id: 'guidance', label: 'Guidance', phase: null, reads: [], writes: [], promotes: [], status: 'ok' });
    await seedRealEventsFile(runDir, 'guidance');

    const { view } = buildRunView(runDir);
    const node = view.nodes.find((n) => n.id === 'guidance')!;

    expect(node.model).toBe('claude-sonnet-5'); // NOT null
    expect(node.tokens!.input).toBe(6);          // NOT 0
    expect(node.tokens!.output).toBe(7);
    expect(node.tokens!.billable).toBe(13);
  });

  it('a legacy PI node (also unstamped, pi vocabulary) still folds via pi — no Claude misdetection', async () => {
    const runDir = mkRunDir();
    await writeRunJson(runDir, baseStatus({
      p0: { id: 'p0', label: 'Pi Node', status: 'ok', artifacts: [], issues: [], durationMs: 1000, model: 'm1' },
    }));
    await writeNodeIo(runDir, { id: 'p0', label: 'Pi Node', phase: null, reads: [], writes: [], promotes: [], status: 'ok' });
    const ef = nodeEventsFile(runDir, 'p0');
    await fs.mkdir(path.dirname(ef), { recursive: true });
    const piEvents = [
      { type: 'message_start', message: { role: 'assistant', model: 'm1', provider: 'cp' } },
      { type: 'message_end', message: { role: 'assistant', usage: { input: 40, output: 8, totalTokens: 48 }, stopReason: 'end_turn' } },
    ];
    await fs.writeFile(ef, piEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const { view } = buildRunView(runDir);
    const node = view.nodes.find((n) => n.id === 'p0')!;
    expect(node.tokens!.input).toBe(40); // folded via pi's accumulator, unaffected by the new detection
    expect(node.tokens!.output).toBe(8);
  });

  it('a STAMPED record with an UNKNOWN driverId still FAILS CLOSED (propagates through replayEvents)', async () => {
    const runDir = mkRunDir();
    await writeRunJson(runDir, baseStatus({
      x0: { id: 'x0', label: 'Mystery', status: 'ok', artifacts: [], issues: [], driverId: 'some-third-executor' },
    }));
    await writeNodeIo(runDir, { id: 'x0', label: 'Mystery', phase: null, reads: [], writes: [], promotes: [], status: 'ok' });
    expect(() => buildRunView(runDir)).toThrow(/unknown driver id/);
  });
});

describe('watchRun — the SAME unstamped legacy Claude node is format-detected in the LIVE fold (SSE≡run-view parity)', () => {
  it('the first snapshot reports the real model + non-zero tokens, matching buildRunView', async () => {
    const runDir = mkRunDir();
    await writeRunJson(runDir, baseStatus({
      guidance: { id: 'guidance', label: 'Guidance', status: 'ok', artifacts: [], issues: [], durationMs: 52054 },
    }));
    await writeNodeIo(runDir, { id: 'guidance', label: 'Guidance', phase: null, reads: [], writes: [], promotes: [], status: 'ok' });
    await seedRealEventsFile(runDir, 'guidance');

    const { view } = buildRunView(runDir); // the oracle
    const oracle = view.nodes.find((n) => n.id === 'guidance')!;

    const ctrl = new AbortController();
    let snapshot: Extract<RunUpdate, { kind: 'snapshot' }> | null = null;
    for await (const u of watchRun(runDir, { signal: ctrl.signal, pollMs: 10 })) {
      if (u.kind === 'snapshot') { snapshot = u; ctrl.abort(); break; }
    }
    expect(snapshot).toBeTruthy();
    const streamNode = snapshot!.model.nodes.find((n) => n.id === 'guidance')!;

    expect(streamNode.model).toBe('claude-sonnet-5'); // NOT null — same as the batch oracle
    expect(streamNode.model).toBe(oracle.model);
    expect(streamNode.tokens?.billable).toBe(13);
    expect(streamNode.tokens?.billable).toBe(oracle.tokens?.billable);
  });
});
