// `piflowctl context` CLI — the thin wrapper's INTEGRATION of the pure cascade with persistence + stdout. The
// pure rules are unit-tested in context-store.test.ts; here we pin the CLI decisions that layer adds: `worker
// use` REJECTS an incompatible pick (vs the cascade's auto-promote), `use` prints the cascaded worker, and
// setup-on-miss guides instead of erroring. Real fs via a tmp PIFLOW_HOME; stdout captured via a spy.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runContextCli } from '../src/context.js';
import { readContexts, writeContexts, addContext, useContext } from '../src/context-store.js';

let home: string;
const savedHome = process.env.PIFLOW_HOME;
const savedE2B = process.env.E2B_API_KEY;
const savedDaytona = process.env.DAYTONA_API_KEY;

/** Capture everything runContextCli writes to stdout for one call. */
async function capture(argv: string[]): Promise<string> {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string | Uint8Array) => {
    out.push(String(s));
    return true;
  }) as typeof process.stdout.write);
  try {
    await runContextCli(argv);
  } finally {
    spy.mockRestore();
  }
  return out.join('');
}

beforeEach(() => {
  home = fssync.mkdtempSync(path.join(os.tmpdir(), 'piflow-ctxcli-'));
  process.env.PIFLOW_HOME = home;
  // Deterministic cascade: no cloud-worker creds unless a test opts in (the dev's real keys must not leak in).
  delete process.env.E2B_API_KEY;
  delete process.env.DAYTONA_API_KEY;
  process.exitCode = 0;
});

afterEach(() => {
  fssync.rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = savedHome;
  if (savedE2B === undefined) delete process.env.E2B_API_KEY;
  else process.env.E2B_API_KEY = savedE2B;
  if (savedDaytona === undefined) delete process.env.DAYTONA_API_KEY;
  else process.env.DAYTONA_API_KEY = savedDaytona;
  process.exitCode = 0;
});

describe('piflowctl context worker use', () => {
  it('persists a compatible worker on the active context (local host drives any worker)', async () => {
    await runContextCli(['worker', 'use', 'e2b']);
    expect(readContexts().contexts.local.worker).toBe('e2b');
    expect(process.exitCode).toBeFalsy();
  });

  it('REJECTS a local worker on a cloud context (a cloud plane can’t reach a local sandbox) — not persisted', async () => {
    await writeContexts(useContext(addContext(readContexts(), 'cloud', { baseUrl: 'https://x.up.railway.app', host: 'railway' }), 'cloud'));
    process.exitCode = 0;
    await runContextCli(['worker', 'use', 'local']);
    expect(process.exitCode).toBe(1); // rejected
    expect(readContexts().contexts.cloud.worker).toBeUndefined(); // NOT persisted
  });

  it('prints setup-on-miss guidance when the chosen cloud worker has no creds', async () => {
    const out = await capture(['worker', 'use', 'e2b']); // E2B_API_KEY deleted in beforeEach
    expect(out).toMatch(/set it up/);
    expect(out).toMatch(/E2B_API_KEY/);
  });

  it('worker use local on a remote-baseUrl context is rejected (compat keys on baseUrl, not the host label)', async () => {
    // No `host` field: compat is keyed on isCloudEntry (baseUrl), NOT the label — a remote baseUrl still rejects `local`.
    await writeContexts(useContext(addContext(readContexts(), 'cloud', { baseUrl: 'https://x.up.railway.app' }), 'cloud'));
    process.exitCode = 0;
    await runContextCli(['worker', 'use', 'local']);
    expect(process.exitCode).toBe(1); // rejected on baseUrl alone
    expect(readContexts().contexts.cloud.worker).toBeUndefined(); // NOT persisted
  });
});

describe('piflowctl context use (the cascade)', () => {
  it('switches and PROMOTES an incompatible stored local worker to the top cloud worker', async () => {
    await writeContexts(addContext(readContexts(), 'cloud', { baseUrl: 'https://x.up.railway.app', host: 'railway', worker: 'local' }));
    const out = await capture(['use', 'cloud']);
    expect(readContexts().current).toBe('cloud');
    expect(out).toMatch(/workers → e2b/); // promoted local → e2b (top of precedence)
    expect(out).toMatch(/promoted/);
  });

  it('switching to local keeps the local worker (no promotion, no setup hint)', async () => {
    const out = await capture(['use', 'local']);
    expect(readContexts().current).toBe('local');
    expect(out).toMatch(/workers → local/);
    expect(out).not.toMatch(/set it up/);
  });

  it('setup-on-miss: `use <known host kind>` with no such context guides instead of switching', async () => {
    const out = await capture(['use', 'railway']); // no 'railway' context exists
    expect(out).toMatch(/set it up/);
    expect(out).toMatch(/railway/);
    expect(readContexts().current).toBeNull(); // did NOT switch to a non-existent endpoint
  });
});

describe('piflowctl context host use', () => {
  it('records a cloud host LABEL on the loopback local context but STAYS local (not provisioned)', async () => {
    // A cloud host LABEL on the loopback `local` context is a provisioning INTENT, not a cloud switch: baseUrl
    // is authoritative, so the context stays LOCAL — the worker is NOT dropped and the CLI prints a setup hint.
    await writeContexts(addContext(readContexts(), 'local', { baseUrl: 'http://127.0.0.1:5273', worker: 'local' }));
    const out = await capture(['host', 'use', 'railway']);
    const local = readContexts().contexts.local;
    expect(local.host).toBe('railway'); // the LABEL is recorded
    expect(local.worker).toBe('local'); // baseUrl unchanged (still local) → the local worker is KEPT, not dropped
    expect(out).toMatch(/workers → local/); // cascade re-derives off the unchanged local baseUrl
    expect(out).toMatch(/not provisioned/); // setup-on-miss: the cloud label has no real baseUrl yet
  });

  it('REJECTS relabelling a REMOTE context as local (baseUrl is authoritative)', async () => {
    // A context that ACTUALLY runs a remote plane (remote baseUrl) can't be relabelled `local` — that would make
    // the display/cascade say local while every run still HTTP-hops to the remote serve. Must fail, host unchanged.
    await writeContexts(useContext(addContext(readContexts(), 'cloud', { baseUrl: 'https://x.up.railway.app' }), 'cloud'));
    process.exitCode = 0;
    await runContextCli(['host', 'use', 'local']);
    expect(process.exitCode).toBe(1); // rejected
    expect(readContexts().contexts.cloud.host).not.toBe('local'); // host NOT changed to local (unchanged/undefined)
  });
});
