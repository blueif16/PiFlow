import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planMigration, isLocalEntry, migrateRun, type MigrateDeps } from '../src/migrate.js';
import { addContext, readContexts, writeContexts, useContext, LOCAL_BASE_URL } from '../src/context-store.js';

// ── the pure classifier ─────────────────────────────────────────────────────────────────────────
describe('planMigration — direction from endpoint locality', () => {
  it('local source → remote target is UPLOAD', () => expect(planMigration(true, false)).toBe('upload'));
  it('remote source → local target is DOWNLOAD', () => expect(planMigration(false, true)).toBe('download'));
  it('both local is local-to-local', () => expect(planMigration(true, true)).toBe('local-to-local'));
  it('both remote is remote-to-remote', () => expect(planMigration(false, false)).toBe('remote-to-remote'));
});

describe('isLocalEntry', () => {
  it('treats an undefined entry and the local serve baseUrl as local; a cloud url as remote', () => {
    expect(isLocalEntry(undefined)).toBe(true);
    expect(isLocalEntry({ baseUrl: LOCAL_BASE_URL })).toBe(true);
    expect(isLocalEntry({ baseUrl: 'https://cloud.example' })).toBe(false);
  });
});

// ── the orchestration flows (injected boundaries — no real network / spawn / fs) ──────────────────
describe('migrateRun — the freeze → bundle → adopt → use orchestration', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'piflow-mig-home-'));
    process.env.PIFLOW_HOME = home;
  });
  afterEach(() => {
    delete process.env.PIFLOW_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('UPLOAD (local→cloud): freezes the local run, POSTs the bundle to the target adopt, switches context', async () => {
    await writeContexts(addContext(readContexts(), 'cloud', { baseUrl: 'https://cloud.example', token: 'tok' }));
    // current stays unset ⇒ source resolves to `local`.

    const calls: string[] = [];
    const bundle = Buffer.from('THE-BUNDLE');
    let frozenYet = false;
    const fetched: { url: string; method?: string; body?: unknown }[] = [];
    const deps: MigrateDeps = {
      resolveLocalRun: async () => ({ runDir: '/src/run', product: 'greet', workflow: 'greet', templateDir: '/p/.piflow/greet/template', productRoot: '/p' }),
      requestFreeze: async (dir) => { calls.push(`freeze:${dir}`); frozenYet = true; },
      readRunModel: async () => ({ run: 'r1', done: false, ok: null, frozen: frozenYet, durationMs: null, stage: null, totals: null, nodes: [], stages: [], edges: [] }),
      packRunDir: async (dir) => { calls.push(`pack:${dir}`); return bundle; },
      fetchImpl: (async (url: string, init: { method?: string; body?: unknown }) => {
        fetched.push({ url: String(url), method: init?.method, body: init?.body });
        return { ok: true, status: 202, async text() { return '{}'; } } as unknown as Response;
      }) as unknown as typeof fetch,
      useContextFn: async (t) => { calls.push(`use:${t}`); },
      print: () => {},
      sleep: async () => {},
    };

    const dir = await migrateRun({ target: 'cloud', run: 'r1' }, deps);
    expect(dir).toBe('upload');
    expect(calls).toEqual(['freeze:/src/run', 'pack:/src/run', 'use:cloud']); // ordered: freeze → bundle → switch
    const adopt = fetched.find((f) => f.url.includes('/adopt'));
    expect(adopt).toBeTruthy();
    expect(adopt!.url).toContain('https://cloud.example/__piflow/migrate/r1/adopt');
    expect(adopt!.method).toBe('POST');
    expect(adopt!.body).toBe(bundle); // the frozen run-dir bundle is the request body
  });

  it('DOWNLOAD (cloud→local): freezes+bundles over HTTP, unpacks locally, spawns the resume, switches context', async () => {
    await writeContexts(addContext(readContexts(), 'cloud', { baseUrl: 'https://cloud.example', token: 'tok' }));
    await writeContexts(useContext(readContexts(), 'cloud')); // source = cloud (remote)

    const calls: string[] = [];
    const gzip = new Uint8Array([1, 2, 3]);
    let frozenYet = false;
    const deps: MigrateDeps = {
      fetchImpl: (async (url: string, init: { method?: string }) => {
        const u = String(url);
        if (u.includes('/freeze')) { calls.push('http-freeze'); frozenYet = true; return { ok: true, status: 202 } as Response; }
        if (u.includes('/bundle')) { calls.push('http-bundle'); return { ok: true, status: 200, async arrayBuffer() { return gzip.buffer; } } as unknown as Response; }
        throw new Error(`unexpected fetch ${u}`);
      }) as unknown as typeof fetch,
      remoteRunModelFn: async () => ({ run: 'r1', done: false, ok: null, frozen: frozenYet, durationMs: null, stage: null, totals: null, nodes: [], stages: [], edges: [] }),
      resolveLocalTemplate: async () => ({ templateDir: '/p/.piflow/greet/template', productRoot: '/p' }),
      unpackRunDir: async (buf, dest) => { calls.push(`unpack:${dest}:${buf.length}`); return []; },
      spawnResume: (tpl, run, sandbox) => { calls.push(`resume:${tpl}:${run}:${sandbox}`); },
      useContextFn: async (t) => { calls.push(`use:${t}`); },
      print: () => {},
      sleep: async () => {},
    };

    const dir = await migrateRun({ target: 'local', run: 'r1', product: 'greet' }, deps);
    expect(dir).toBe('download');
    expect(calls).toEqual([
      'http-freeze',
      'http-bundle',
      'unpack:/p/.piflow/greet/runs/r1:3', // bundle bytes landed at the target's D9 runs dir
      'resume:/p/.piflow/greet/template:r1:local', // detached resume launched with --sandbox local
      'use:local',
    ]);
  });

  it('DOWNLOAD: threads the source run\'s launch config (provider + model) into the resume so the migrated tail keeps them', async () => {
    await writeContexts(addContext(readContexts(), 'cloud', { baseUrl: 'https://cloud.example', token: 'tok' }));
    await writeContexts(useContext(readContexts(), 'cloud')); // source = cloud (remote)

    let launch: { provider?: string; model?: string | null } | undefined;
    let frozenYet = false;
    const deps: MigrateDeps = {
      fetchImpl: (async (url: string) => {
        const u = String(url);
        if (u.includes('/freeze')) { frozenYet = true; return { ok: true, status: 202 } as Response; }
        if (u.includes('/bundle')) { return { ok: true, status: 200, async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer; } } as unknown as Response; }
        throw new Error(`unexpected fetch ${u}`);
      }) as unknown as typeof fetch,
      // The source run model carries its persisted launch config (provider/model) — recovered on freeze-wait.
      remoteRunModelFn: async () => ({ run: 'r1', done: false, ok: null, frozen: frozenYet, durationMs: null, provider: 'mmgw', model: 'deepseek', stage: null, totals: null, nodes: [], stages: [], edges: [] }),
      resolveLocalTemplate: async () => ({ templateDir: '/p/.piflow/greet/template', productRoot: '/p' }),
      unpackRunDir: async () => [],
      spawnResume: (_tpl, _run, _sandbox, _cwd, l) => { launch = l; },
      useContextFn: async () => {},
      print: () => {},
      sleep: async () => {},
    };

    await migrateRun({ target: 'local', run: 'r1', product: 'greet' }, deps);
    expect(launch?.provider).toBe('mmgw'); // the source provider is preserved (regression: resumed on "cp")
    expect(launch?.model).toBe('deepseek');
  });

  it('if the source already FINISHED before it could freeze, it does not bundle or adopt (nothing to move)', async () => {
    await writeContexts(addContext(readContexts(), 'cloud', { baseUrl: 'https://cloud.example' }));
    const packSpy = vi.fn(async () => Buffer.from('x'));
    const fetchSpy = vi.fn();
    const deps: MigrateDeps = {
      resolveLocalRun: async () => ({ runDir: '/src/run', product: 'greet', workflow: 'greet', templateDir: '/p/.piflow/greet/template', productRoot: '/p' }),
      requestFreeze: async () => {},
      readRunModel: async () => ({ run: 'r1', done: true, ok: true, frozen: false, durationMs: 10, stage: null, totals: null, nodes: [], stages: [], edges: [] }),
      packRunDir: packSpy,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      useContextFn: async () => {},
      print: () => {},
      sleep: async () => {},
    };
    await migrateRun({ target: 'cloud', run: 'r1' }, deps);
    expect(packSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
