// The WIRING that makes the active context redirect observe/start to a remote serve: `resolveRemote` (the
// local-vs-remote gate every subcommand asks), the remote `status` composition (remoteRunModel → renderStatus),
// the remote `watch` composition (remoteUpdates → watchRun's `updates` seam), and the remote `run` path
// (runTemplateRemote → POST /api/runs/start). Every remote call is driven with an INJECTED fetch / start fn —
// NO real network. `PIFLOW_HOME` points the context store at a per-test tmp dir so the real ~/.piflow is untouched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunModel, NodeView, RunUpdate } from '@piflow/core';
import { writeContexts, addContext, useContext, readContexts, LOCAL_BASE_URL } from '../src/context-store.js';
import { resolveRemote, remoteRunModel } from '../src/remote.js';
import { renderStatus } from '../src/status.js';
import { watchRun } from '../src/watch.js';
import { remoteStartBody, runTemplateRemote, parseRunArgs } from '../src/run.js';
import type { ContextEntry } from '../src/context-store.js';

let home: string;
const savedHome = process.env.PIFLOW_HOME;
const savedCtx = process.env.PIFLOW_CONTEXT;

beforeEach(() => {
  home = fssync.mkdtempSync(path.join(os.tmpdir(), 'piflow-remote-'));
  process.env.PIFLOW_HOME = home;
  delete process.env.PIFLOW_CONTEXT;
});
afterEach(() => {
  fssync.rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = savedHome;
  if (savedCtx === undefined) delete process.env.PIFLOW_CONTEXT;
  else process.env.PIFLOW_CONTEXT = savedCtx;
});

function nodeView(id: string, status: NodeView['status']): NodeView {
  return {
    id, label: id, phase: null, status, reported: status,
    artifactsVerified: 0, artifactsTotal: 0, missing: [], stageIndex: 1, lane: 0,
  };
}
function model(nodes: NodeView[], extra: Partial<RunModel> = {}): RunModel {
  return { run: 'r', done: false, ok: null, durationMs: null, stage: null, totals: null, nodes, stages: [], edges: [], ...extra };
}
const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
function fakeFetch(chunks: string[]): typeof fetch {
  const enc = new TextEncoder();
  return (async () => ({
    ok: true, status: 200, statusText: '',
    body: {
      getReader() {
        let i = 0;
        return { read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined }), releaseLock() {}, cancel: async () => {} };
      },
    },
    text: async () => '{}',
  })) as unknown as typeof fetch;
}
async function* seq(updates: RunUpdate[]): AsyncIterable<RunUpdate> {
  for (const u of updates) yield u;
}

describe('resolveRemote — the local-vs-remote gate', () => {
  it('returns null for the implicit `local` (no HTTP hop; keep the local filesystem path)', () => {
    expect(resolveRemote()).toBeNull();
  });

  it('returns the entry for a REMOTE active context (persisted current)', async () => {
    await writeContexts(useContext(addContext(readContexts(), 'cloud', { baseUrl: 'https://c.example', token: 'sk-1' }), 'cloud'));
    const r = resolveRemote();
    // Test-the-test: if resolveRemote treated a remote context as local (returned null), this throws → RED.
    expect(r).not.toBeNull();
    expect(r!.name).toBe('cloud');
    expect(r!.entry).toEqual({ baseUrl: 'https://c.example', token: 'sk-1' });
  });

  it('the --context flag overrides the active context', async () => {
    await writeContexts(addContext(addContext(readContexts(), 'cloud', { baseUrl: 'https://c' }), 'staging', { baseUrl: 'https://s' }));
    expect(resolveRemote('staging')!.entry.baseUrl).toBe('https://s');
  });

  it('a named context still pointing at the LOCAL serve baseUrl is treated as local (null)', async () => {
    await writeContexts(useContext(addContext(readContexts(), 'loopback', { baseUrl: LOCAL_BASE_URL }), 'loopback'));
    expect(resolveRemote()).toBeNull();
  });

  it('THROWS on an unknown --context name (never silently falls back to the local path)', () => {
    expect(() => resolveRemote('ghost')).toThrow(/unknown context "ghost"/i);
  });
});

describe('remote status — remoteRunModel feeds the SAME renderStatus', () => {
  it('fetches the snapshot over SSE and renders the identical table local would for that model', async () => {
    const entry: ContextEntry = { baseUrl: 'http://remote:5273', token: 'sk-2' };
    const m = model([nodeView('w0', 'ok'), nodeView('w1', 'running')], { run: 'demo', provider: 'cp', model: 'x' });
    const fetched = await remoteRunModel(entry, 'demo', {
      fetchImpl: fakeFetch([frame({ kind: 'meta', run: 'demo' }), frame({ kind: 'snapshot', model: m }), frame({ kind: 'done' })]),
    });
    // The remote path renders byte-identically to the local path for the SAME model (renderStatus is pure).
    expect(renderStatus(fetched)).toBe(renderStatus(m));
    expect(renderStatus(fetched)).toContain('w0');
    expect(renderStatus(fetched)).toContain('w1');
  });
});

describe('remote watch — remoteUpdates plugs into watch\'s `updates` seam', () => {
  it('fires the terminal DONE line off the SSE RunUpdate sequence', async () => {
    const lines: string[] = [];
    // The remote path swaps ONLY the source; the sentinel logic is the same one the local watch uses.
    const res = await watchRun({ updates: seq([{ kind: 'snapshot', model: model([nodeView('w0', 'running')]) }, { kind: 'done' }]), print: (l) => lines.push(l) });
    expect(res.reason).toBe('done');
    expect(res.ok).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/DONE|done/i);
  });

  it('fires node-failed the moment a blocked node arrives on the remote stream', async () => {
    const lines: string[] = [];
    const res = await watchRun({
      updates: seq([{ kind: 'snapshot', model: model([nodeView('w0', 'running')]) }, { kind: 'node-status', id: 'w2', status: 'blocked' }, { kind: 'done' }]),
      print: (l) => lines.push(l),
    });
    expect(res.reason).toBe('node-failed');
    expect(res.node).toBe('w2');
  });
});

describe('remote run — runTemplateRemote POSTs /api/runs/start and surfaces the returned run id', () => {
  it('maps the parsed args → StartBody, calls the start fn, and prints the REMOTE run id (not a local run)', async () => {
    const entry: ContextEntry = { baseUrl: 'http://remote:5273', token: 'sk-3' };
    const parsed = parseRunArgs(['/tmpl', '--sandbox', 'local', '--arg', 'topic=x', '--executor', 'claude-code']);
    let sentBody: any;
    const lines: string[] = [];
    const res = await runTemplateRemote(entry, 'cloud', parsed, {
      startRemoteRun: async (_e, body) => { sentBody = body; return { run: 'brave-tart', streamUrl: '/__piflow/stream/brave-tart' }; },
      print: (l) => lines.push(l),
    });
    // The RETURNED run id is the remote one (test-the-test: return a wrong run → the assertions go RED).
    expect(res.run).toBe('brave-tart');
    expect(sentBody).toMatchObject({ templateDir: path.resolve('/tmpl'), sandbox: 'local', args: { topic: 'x' }, executor: 'claude-code' });
    // it surfaces how to observe via the SAME remote context (a remote run id, --context cloud).
    expect(lines.join('\n')).toContain('brave-tart');
    expect(lines.join('\n')).toContain('--context cloud');
    expect(lines.join('\n')).toContain('http://remote:5273/__piflow/stream/brave-tart');
  });

  it('surfaces the server error (non-2xx) rather than a local run', async () => {
    const entry: ContextEntry = { baseUrl: 'http://remote:5273' };
    const parsed = parseRunArgs(['/tmpl']);
    await expect(
      runTemplateRemote(entry, 'cloud', parsed, { startRemoteRun: async () => { throw new Error('remote start-run failed (403): template not allowed'); }, print: () => {} }),
    ).rejects.toThrow(/template not allowed/);
  });
});

describe('remoteStartBody — the pure argv→StartBody mapping', () => {
  it('omits the default inmemory sandbox + unset flags, keeps the ones the user chose', () => {
    const body = remoteStartBody(parseRunArgs(['/t']));
    expect(body).toEqual({ templateDir: path.resolve('/t') }); // nothing else — a bare run.
    expect('sandbox' in body).toBe(false); // inmemory default is NOT forwarded.
  });

  it('forwards run/args/sandbox/profile/provider/thinking/model/dryRun/detach/executor when set', () => {
    const body = remoteStartBody(parseRunArgs([
      '/t', '--run', 'r1', '--arg', 'a=b', '--sandbox', 'daytona', '--profile', 'fast',
      '--provider', 'cp', '--thinking', 'low', '--model', 'm', '--dry-run', '--detach',
      '--executor', 'pi', '--executor', 'w0=claude-code',
    ]));
    expect(body).toMatchObject({
      templateDir: path.resolve('/t'), run: 'r1', args: { a: 'b' }, sandbox: 'daytona', profile: 'fast',
      provider: 'cp', thinking: 'low', model: 'm', dryRun: true, detach: true,
      executor: 'pi', executorOverride: { w0: 'claude-code' },
    });
  });
});
