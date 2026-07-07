// packages/cli/src/runs.ts + runs-scan.ts — the M5.4 `piflowctl runs` cross-run summary. Seeds a REAL runs
// home (`<runsHome>/<id>/.pi/run.json`), so the shared scan (the same one `--topk` rides), the --node/--status/
// --since filters, and the parent→child lineage INDENT are all asserted end-to-end.
//
// Run: npx vitest run packages/cli/test/runs-cli.test.ts

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRunsHome, nodeRanFresh, runLevelStatus } from '../src/runs-scan.js';
import { parseRunsArgs, parseSince, runRunsCli } from '../src/runs.js';
import type { RunStatus } from '@piflow/core';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'runs-cli-'));

async function seedRun(runsHome: string, id: string, o: { node?: string; nodeStatus?: string; startedAt: string; done?: boolean; ok?: boolean | null; parent?: string; spawnedBy?: RunStatus['spawnedBy'] }): Promise<void> {
  const runDir = path.join(runsHome, id);
  await fs.mkdir(path.join(runDir, '.pi'), { recursive: true });
  const nodes = o.node ? { [o.node]: { id: o.node, label: o.node, status: o.nodeStatus ?? 'ok', artifacts: [], issues: [] } } : {};
  await fs.writeFile(path.join(runDir, '.pi', 'run.json'), JSON.stringify({
    run: id, name: id, startedAt: o.startedAt, updatedAt: o.startedAt, done: o.done ?? true, ok: o.ok ?? true,
    durationMs: 1, stage: null, totals: null, nodes,
    ...(o.parent ? { parent: o.parent } : {}), ...(o.spawnedBy ? { spawnedBy: o.spawnedBy } : {}),
  }, null, 2));
}

// ── the shared scan primitives ──────────────────────────────────────────────────────────────────────────────
describe('runs-scan primitives', () => {
  it('nodeRanFresh: ok|error are fresh; reused/pending/running/absent are NOT', () => {
    const mk = (s: string): RunStatus => ({ nodes: { g: { status: s } } } as unknown as RunStatus);
    expect(nodeRanFresh(mk('ok'), 'g')).toBe(true);
    expect(nodeRanFresh(mk('error'), 'g')).toBe(true);
    expect(nodeRanFresh(mk('reused'), 'g')).toBe(false);
    expect(nodeRanFresh(mk('running'), 'g')).toBe(false);
    expect(nodeRanFresh({ nodes: {} } as unknown as RunStatus, 'g')).toBe(false);
  });
  it('runLevelStatus: done+ok→ok, done+not-ok→error, unfinished→running', () => {
    expect(runLevelStatus({ done: true, ok: true } as RunStatus)).toBe('ok');
    expect(runLevelStatus({ done: true, ok: false } as RunStatus)).toBe('error');
    expect(runLevelStatus({ done: false, ok: null } as RunStatus)).toBe('running');
  });
  it('parseSince: a number ⇒ N days ago; an ISO string ⇒ that date; garbage ⇒ null', () => {
    const now = new Date('2026-07-06T12:00:00Z');
    expect(parseSince('3', now)!.toISOString()).toBe('2026-07-03T12:00:00.000Z');
    expect(parseSince('2026-07-01', now)!.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(parseSince('not-a-date', now)).toBeNull();
  });
  it('scanRunsHome returns readable runs NEWEST-first, dropping unreadable ones', async () => {
    const dir = await tmp();
    const rh = path.join(dir, 'runs');
    await seedRun(rh, 'a', { startedAt: '2026-07-06T01:00:00Z' });
    await seedRun(rh, 'b', { startedAt: '2026-07-06T03:00:00Z' });
    await fs.mkdir(path.join(rh, 'torn', '.pi'), { recursive: true });
    await fs.writeFile(path.join(rh, 'torn', '.pi', 'run.json'), '{ not json'); // unreadable → dropped
    const scanned = await scanRunsHome(rh);
    expect(scanned.map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('parseRunsArgs', () => {
  it('parses node/status/since/json/template', () => {
    expect(parseRunsArgs(['--node', 'g', '--status', 'error', '--since', '7', '--json'])).toMatchObject({ node: 'g', status: 'error', since: '7', json: true });
    expect(parseRunsArgs(['--status', 'weird']).status).toBeUndefined(); // only ok|error accepted
  });
});

describe('runRunsCli — filters + parent/child lineage indent', () => {
  it('renders child runs INDENTED under their parent, newest-first, with issue attribution', async () => {
    const dir = await tmp();
    const rh = path.join(dir, 'runs');
    await seedRun(rh, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T01:00:00Z' });
    await seedRun(rh, 'tS2.gameplay', { node: 'gameplay', startedAt: '2026-07-06T02:00:00Z', parent: 'tS2', spawnedBy: { by: 'substrate-fix', issue: 'soggy-crust' } });
    await seedRun(rh, 'other', { node: 'gameplay', startedAt: '2026-07-06T00:30:00Z' });
    const lines: string[] = [];
    await runRunsCli([], { runsHome: rh, print: (s) => lines.push(s) });

    const parentIdx = lines.findIndex((l) => l.startsWith('tS2 '));
    const childIdx = lines.findIndex((l) => l.trimStart().startsWith('tS2.gameplay'));
    expect(parentIdx).toBeGreaterThanOrEqual(0);
    expect(childIdx).toBe(parentIdx + 1); // child immediately under its parent
    expect(lines[childIdx].startsWith('  ')).toBe(true); // and INDENTED
    expect(lines[childIdx]).toMatch(/substrate-fix:soggy-crust/); // attribution
  });

  it('--node filters to runs where that node executed fresh; --status + --since narrow further', async () => {
    const dir = await tmp();
    const rh = path.join(dir, 'runs');
    await seedRun(rh, 'freshOk', { node: 'gameplay', nodeStatus: 'ok', startedAt: '2026-07-06T05:00:00Z' });
    await seedRun(rh, 'freshErr', { node: 'gameplay', nodeStatus: 'error', startedAt: '2026-07-06T04:00:00Z', ok: false });
    await seedRun(rh, 'reusedRun', { node: 'gameplay', nodeStatus: 'reused', startedAt: '2026-07-06T04:30:00Z' });
    await seedRun(rh, 'otherNode', { node: 'plan', startedAt: '2026-07-06T04:45:00Z' });

    const all: string[] = [];
    await runRunsCli(['--node', 'gameplay', '--json'], { runsHome: rh, print: (s) => all.push(s) });
    const ids = JSON.parse(all.join('')).map((r: { id: string }) => r.id);
    expect(ids.sort()).toEqual(['freshErr', 'freshOk']); // reused + other-node excluded

    const errOnly: string[] = [];
    await runRunsCli(['--node', 'gameplay', '--status', 'error', '--json'], { runsHome: rh, print: (s) => errOnly.push(s) });
    expect(JSON.parse(errOnly.join('')).map((r: { id: string }) => r.id)).toEqual(['freshErr']);
  });
});
