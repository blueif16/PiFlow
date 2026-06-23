import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRunFixture } from './fixture.js';
import { readRun, renderStatus } from '../src/status.js';

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-status-'));
  await buildRunFixture(dir);
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('status — per-node table over the .pi/ layout', () => {
  it('reads every node id and its label', async () => {
    const out = renderStatus(await readRun(dir));
    for (const id of ['w0', 'w1a', 'w1b', 'w2']) expect(out).toContain(id);
    expect(out).toContain('W0 Classify');
    expect(out).toContain('W2 Scaffold');
  });

  it('reports an ok node as ok with its verified-artifact count', async () => {
    const run = await readRun(dir);
    const w0 = run.nodes.find((n) => n.id === 'w0')!;
    expect(w0.status).toBe('ok');
    expect(w0.verified).toBe(1);
    expect(w0.total).toBe(1);
  });

  it('surfaces the parallel lane (w1a + w1b share a stage)', async () => {
    const run = await readRun(dir);
    const w1a = run.nodes.find((n) => n.id === 'w1a')!;
    const w1b = run.nodes.find((n) => n.id === 'w1b')!;
    expect(w1a.status).toBe('ok');
    expect(w1b.status).toBe('ok');
  });

  it('DERIVES blocked from the missing artifact — NOT the self-reported field', async () => {
    // The fixture writes w2 with a SELF-REPORTED status of 'ok', but its declared artifact
    // (src/index.ts) is ABSENT on disk. The reader must verify on disk and read 'blocked'.
    const lyingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-lie-'));
    try {
      await buildRunFixture(lyingDir, { w2SelfReport: 'ok' });
      const run = await readRun(lyingDir);
      const w2 = run.nodes.find((n) => n.id === 'w2')!;
      expect(w2.status).toBe('blocked'); // must beat the self-report
      expect(w2.verified).toBe(0);
      expect(w2.total).toBe(1);
      expect(renderStatus(run)).toContain('blocked');
    } finally {
      await fs.rm(lyingDir, { recursive: true, force: true });
    }
  });

  it('renders the stage + rollup summary', async () => {
    const finishedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-done-'));
    try {
      await buildRunFixture(finishedDir, { done: true });
      const out = renderStatus(await readRun(finishedDir));
      expect(out).toMatch(/4 nodes/);
      expect(out).toMatch(/3 ok/);
      expect(out).toMatch(/1 failed/);
    } finally {
      await fs.rm(finishedDir, { recursive: true, force: true });
    }
  });
});
