// `piflowctl context` STORE — the pure `~/.piflow/contexts.json` read/write + the resolution LADDER.
//
// The load-bearing behavior is `resolveActive`'s precedence: `--context` flag > `PIFLOW_CONTEXT` env >
// persisted `current` > `'local'`. The test-the-test mutation target is that ORDER: if the impl checked env
// before the flag (or current before env), 'the flag beats the env' / 'the env beats current' go RED. Every
// rung is asserted while the HIGHER rungs are present, so a reordering can't hide.
//
// All fs is pointed at a per-test tmp dir via `PIFLOW_HOME` (the @piflow/core home seam that `context-store`
// reuses through `globalDir`), so this suite never touches the real `~/.piflow`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readContexts,
  writeContexts,
  resolveActive,
  addContext,
  removeContext,
  useContext,
  contextsFile,
  LOCAL_CONTEXT,
  LOCAL_BASE_URL,
  isCloudHost,
  isCloudEntry,
  isWorkerCompatible,
  defaultWorkerFor,
  resolveWorker,
} from '../src/context-store.js';

let home: string;
const savedHome = process.env.PIFLOW_HOME;
const savedCtx = process.env.PIFLOW_CONTEXT;

beforeEach(() => {
  home = fssync.mkdtempSync(path.join(os.tmpdir(), 'piflow-ctx-'));
  process.env.PIFLOW_HOME = home;
  delete process.env.PIFLOW_CONTEXT; // each test opts into the env rung explicitly.
});

afterEach(() => {
  fssync.rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = savedHome;
  if (savedCtx === undefined) delete process.env.PIFLOW_CONTEXT;
  else process.env.PIFLOW_CONTEXT = savedCtx;
});

describe('readContexts — implicit local seed', () => {
  it('seeds `local` at the serve default even with NO file on disk', () => {
    // No writeContexts has run: the file does not exist yet.
    expect(fssync.existsSync(contextsFile())).toBe(false);
    const file = readContexts();
    expect(file.contexts[LOCAL_CONTEXT]).toEqual({ baseUrl: LOCAL_BASE_URL });
    expect(file.current).toBeNull();
  });

  it('a corrupt file degrades to defaults (still seeds local) rather than throwing', async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(contextsFile(), '{ this is not json');
    expect(() => readContexts()).not.toThrow();
    expect(readContexts().contexts[LOCAL_CONTEXT]).toEqual({ baseUrl: LOCAL_BASE_URL });
  });
});

describe('resolveActive — the precedence ladder (flag > env > current > local)', () => {
  it('with nothing set, resolves to the implicit `local`', () => {
    expect(resolveActive()).toBe('local');
  });

  it('the persisted `current` beats the `local` default', async () => {
    await writeContexts(addContext({ current: 'cloud', contexts: {} } as any, 'cloud', { baseUrl: 'https://x' }));
    expect(resolveActive()).toBe('cloud');
  });

  it('the PIFLOW_CONTEXT env beats the persisted `current`', async () => {
    // `current` points at cloud, but the env override must WIN — proves env sits above current in the ladder.
    await writeContexts({ current: 'cloud', contexts: { cloud: { baseUrl: 'https://x' } } });
    process.env.PIFLOW_CONTEXT = 'staging';
    expect(resolveActive()).toBe('staging');
  });

  it('the --context flag beats the PIFLOW_CONTEXT env (AND the persisted current)', async () => {
    // All three lower rungs are present and DIFFERENT — only a correctly ordered ladder returns the flag.
    // If the impl checked env before the flag, this returns 'staging' and the test is RED.
    await writeContexts({ current: 'cloud', contexts: { cloud: { baseUrl: 'https://x' } } });
    process.env.PIFLOW_CONTEXT = 'staging';
    expect(resolveActive({ flagContext: 'prod' })).toBe('prod');
  });

  it('an EMPTY flag/env falls through to the next rung (does not win with "")', async () => {
    await writeContexts({ current: 'cloud', contexts: { cloud: { baseUrl: 'https://x' } } });
    process.env.PIFLOW_CONTEXT = '';
    expect(resolveActive({ flagContext: '  ' })).toBe('cloud'); // both blank → falls to current
  });
});

describe('add → use → ls (read) → rm round-trip', () => {
  it('add persists an endpoint that a fresh read sees', async () => {
    await writeContexts(addContext(readContexts(), 'cloud', { baseUrl: 'https://c.example', token: 'sk-1' }));
    const reread = readContexts();
    expect(reread.contexts.cloud).toEqual({ baseUrl: 'https://c.example', token: 'sk-1' });
    expect(reread.contexts[LOCAL_CONTEXT]).toBeDefined(); // local still present alongside
  });

  it('useContext sets current to a KNOWN name; resolveActive then returns it', async () => {
    await writeContexts(useContext(addContext(readContexts(), 'cloud', { baseUrl: 'https://c' }), 'cloud'));
    expect(readContexts().current).toBe('cloud');
    expect(resolveActive()).toBe('cloud');
  });

  it('useContext THROWS on an unknown name (kubectl use-context semantics)', () => {
    expect(() => useContext(readContexts(), 'ghost')).toThrow(/unknown context/i);
  });

  it('rm removes an endpoint AND clears current when it was the active one', async () => {
    await writeContexts(useContext(addContext(readContexts(), 'cloud', { baseUrl: 'https://c' }), 'cloud'));
    // Precondition: cloud is current.
    expect(readContexts().current).toBe('cloud');
    await writeContexts(removeContext(readContexts(), 'cloud'));
    const reread = readContexts();
    expect(reread.contexts.cloud).toBeUndefined();
    expect(reread.current).toBeNull(); // cleared → resolution falls back to local
    expect(resolveActive()).toBe('local');
  });

  it('rm of a NON-current context leaves current intact', async () => {
    let file = addContext(readContexts(), 'cloud', { baseUrl: 'https://c' });
    file = addContext(file, 'staging', { baseUrl: 'https://s' });
    file = useContext(file, 'cloud');
    await writeContexts(file);
    await writeContexts(removeContext(readContexts(), 'staging'));
    const reread = readContexts();
    expect(reread.current).toBe('cloud'); // untouched — we removed the OTHER one
    expect(reread.contexts.staging).toBeUndefined();
  });
});

// ── the host/worker cascade (PURE) ─────────────────────────────────────────────────────────────────
// The load-bearing new logic: a CLOUD control plane can't reach a laptop's local sandbox, so the worker
// cascades off the host. Mutation targets: the compat rule (cloud rejects `local`), the precedence ORDER
// (e2b before daytona), and the promote-on-incompatible branch. These are pure — no fs, no env.
describe('host/worker cascade (pure)', () => {
  it('isCloudHost: only `local` is not a cloud plane', () => {
    expect(isCloudHost('local')).toBe(false);
    expect(isCloudHost('railway')).toBe(true);
    expect(isCloudHost('fly')).toBe(true);
    expect(isCloudHost('selfhost')).toBe(true);
  });

  it('compat: a LOCAL host drives every worker', () => {
    for (const w of ['local', 'e2b', 'daytona'] as const) expect(isWorkerCompatible('local', w)).toBe(true);
  });
  it('compat: a CLOUD host rejects the `local` worker but accepts cloud workers', () => {
    expect(isWorkerCompatible('railway', 'local')).toBe(false);
    expect(isWorkerCompatible('fly', 'local')).toBe(false);
    expect(isWorkerCompatible('railway', 'e2b')).toBe(true);
    expect(isWorkerCompatible('fly', 'daytona')).toBe(true);
  });

  it('defaultWorkerFor: a LOCAL host → `local`, regardless of what cloud workers are configured', () => {
    expect(defaultWorkerFor('local', new Set())).toBe('local');
    expect(defaultWorkerFor('local', new Set(['e2b']))).toBe('local');
  });
  it('defaultWorkerFor: a CLOUD host → the highest-precedence CONFIGURED cloud worker', () => {
    expect(defaultWorkerFor('railway', new Set(['daytona']))).toBe('daytona'); // e2b unconfigured → skipped
    expect(defaultWorkerFor('railway', new Set(['e2b', 'daytona']))).toBe('e2b'); // e2b wins by precedence
  });
  it('defaultWorkerFor: a CLOUD host with NOTHING configured → the top cloud worker (setup-on-miss signal)', () => {
    expect(defaultWorkerFor('railway', new Set())).toBe('e2b');
  });

  it('isCloudEntry: baseUrl is authoritative (== the local serve ⇒ local); the host label is ignored', () => {
    // baseUrl IS the local serve → local, no matter the host LABEL (which is display/provisioning only).
    expect(isCloudEntry({ baseUrl: LOCAL_BASE_URL })).toBe(false);
    expect(isCloudEntry({ baseUrl: LOCAL_BASE_URL, host: 'railway' })).toBe(false); // host label does NOT flip cloud-ness
    // Any baseUrl that is NOT the exact local serve is a remote control plane.
    expect(isCloudEntry({ baseUrl: 'https://app.up.railway.app' })).toBe(true);
    expect(isCloudEntry({ baseUrl: 'http://localhost:9000' })).toBe(true); // different host:port than the local serve
  });

  it('resolveWorker: an explicit COMPATIBLE worker is kept (no promotion)', () => {
    expect(resolveWorker({ baseUrl: 'https://a.up.railway.app', host: 'railway', worker: 'daytona' }, new Set(['e2b', 'daytona'])))
      .toEqual({ worker: 'daytona', promoted: false, cloud: true });
  });
  it('resolveWorker: a cloud context with an INCOMPATIBLE `local` worker is PROMOTED to the cascade default', () => {
    expect(resolveWorker({ baseUrl: 'https://a.up.railway.app', host: 'railway', worker: 'local' }, new Set(['e2b'])))
      .toEqual({ worker: 'e2b', promoted: true, cloud: true });
  });
  it('resolveWorker: a local context defaults to the `local` worker (no promotion)', () => {
    expect(resolveWorker({ baseUrl: LOCAL_BASE_URL, host: 'local' }, new Set()))
      .toEqual({ worker: 'local', promoted: false, cloud: false });
  });
  it('resolveWorker: a cloud context with NO stored worker defaults (defaulting is not a promotion)', () => {
    expect(resolveWorker({ baseUrl: 'https://a.fly.dev', host: 'fly' }, new Set(['e2b'])))
      .toEqual({ worker: 'e2b', promoted: false, cloud: true });
  });
});
