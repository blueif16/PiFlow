// Contract parity: the LOCAL in-memory sandbox vs. the CLOUD (Daytona) sandbox.
//
// The seam's promise (l1-node-envelope.md philosophy #6): "One provider-agnostic lifecycle, identical
// local or cloud: create → stage → exec → collect → dispose; only the `provider` swaps." This file makes
// that promise EXECUTABLE — the SAME assertions run against both backends, so the user-visible CONTRACT
// (lifecycle, cross-sandbox file flow, host-stat artifact verification, run verdict) is proven identical.
// BEHAVIOR is allowed to differ (the cloud path streams via sessions, reports a combined-output `result`,
// and forces a session exit code) — only the contract must hold, which is exactly what we assert on.
//
// The cloud backend is the REAL `DaytonaSandboxProvider` (src/daytona.ts) driven by a FAKE `DaytonaSdk`
// whose "VM" is a host temp dir (the provider is constructed with `homeDir` = that dir, so every in-VM
// absolute path the provider builds IS a real host path — no path rewriting, faithful fs + shell). This is
// the unit-test the draft's header anticipates ("dependency-free and unit-testable with a fake SDK"). It
// exercises daytona.ts's real lifecycle code: openRun (one VM/run), per-node views, uploadFile/downloadFile/
// searchFiles staging+collection, the session exec path, and run-scoped dispose. (Mirrors core's
// inmemory rows; the Daytona row + fake moved here when Daytona became a choose-to-install extension.)

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { compile, InMemorySandboxProvider, runWorkflow } from '@piflow/core';
import type { NodeIntent, WorkflowSpec, Sandbox, SandboxProvider } from '@piflow/core';
import { DaytonaSandboxProvider } from '../src/daytona.js';

// ── the fake Daytona SDK: a "VM" that is really a host temp dir ──────────────────────────────────────
// Structurally implements the DaytonaSdk/DaytonaVm/DaytonaFs/DaytonaProcess seam in daytona.ts. Because
// the provider is built with `homeDir` = a real host dir, every remotePath the provider passes is a real
// absolute host path, so fs ops are plain node fs and exec is a real shell.

interface SessionRec {
  child: ReturnType<typeof spawn>;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  done: Promise<void>;
}

class FakeDaytonaFs {
  async uploadFile(data: Uint8Array, remotePath: string): Promise<void> {
    await fs.mkdir(path.dirname(remotePath), { recursive: true });
    await fs.writeFile(remotePath, data);
  }
  async downloadFile(remotePath: string): Promise<Uint8Array> {
    return fs.readFile(remotePath);
  }
  async createFolder(remotePath: string, _mode?: string): Promise<void> {
    await fs.mkdir(remotePath, { recursive: true });
  }
  async searchFiles(root: string, _pattern: string): Promise<{ files: string[] }> {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Awaited<ReturnType<typeof fs.readdir>> = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // missing dir → no files (mirrors a node that produced nothing)
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else files.push(full);
      }
    };
    await walk(root);
    return { files };
  }
}

class FakeDaytonaProcess {
  private readonly sessions = new Map<string, SessionRec>();

  // Buffered exec — combined stdout+stderr into ONE `result`, mirroring Daytona's real shape.
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    _timeoutSec?: number,
  ): Promise<{ exitCode: number; result: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, { cwd, env: { ...process.env, ...(env ?? {}) }, shell: true });
      let result = '';
      child.stdout?.on('data', (d: Buffer) => { result += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { result += d.toString(); });
      child.on('error', () => resolve({ exitCode: 1, result }));
      child.on('close', (code) => resolve({ exitCode: code ?? 0, result }));
    });
  }

  async createSession(_sessionId: string): Promise<void> {
    /* no-op: the fake has no long-lived shell; each session command spawns its own process */
  }

  // runAsync: spawn now, return a handle; the command keeps running while logs stream.
  async executeSessionCommand(
    sessionId: string,
    req: { command: string; runAsync?: boolean },
  ): Promise<{ cmdId?: string }> {
    // The provider bakes `cd <cwd> && <env> <cmd>` into req.command, so no cwd/env needed here.
    const child = spawn(req.command, { env: { ...process.env }, shell: true });
    const rec: SessionRec = { child, stdout: '', stderr: '', exitCode: null, done: Promise.resolve() };
    rec.done = new Promise<void>((res) => {
      child.stdout?.on('data', (d: Buffer) => { rec.stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { rec.stderr += d.toString(); });
      child.on('close', (code) => { rec.exitCode = code ?? 0; res(); });
      child.on('error', () => { rec.exitCode = 1; res(); });
    });
    this.sessions.set(sessionId, rec);
    return { cmdId: 'cmd-1' };
  }

  // Stream form: resolves VOID when the command ENDS, replaying buffered output to the callbacks
  // (the callbacks own the bytes — mirroring the real streaming overload's `Promise<void>` return).
  async getSessionCommandLogs(
    sessionId: string,
    _cmdId: string,
    onStdout?: (chunk: string) => void,
    onStderr?: (chunk: string) => void,
  ): Promise<void> {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    await rec.done;
    if (onStdout && rec.stdout) onStdout(rec.stdout);
    if (onStderr && rec.stderr) onStderr(rec.stderr);
  }

  // The finished command's real exit code (mirrors `getSessionCommand → Command { exitCode? }`).
  async getSessionCommand(sessionId: string, _cmdId: string): Promise<{ exitCode?: number }> {
    const rec = this.sessions.get(sessionId);
    return { exitCode: rec?.exitCode ?? undefined };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const rec = this.sessions.get(sessionId);
    if (rec && !rec.child.killed) {
      try { rec.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    this.sessions.delete(sessionId);
  }
}

class FakeDaytonaVm {
  readonly id: string;
  readonly fs = new FakeDaytonaFs();
  readonly process = new FakeDaytonaProcess();
  constructor(id: string) { this.id = id; }
}

/** The fake client. Tracks create/delete so a test can assert the per-run VM lifecycle (1 boot, 1 tear). */
class FakeDaytonaSdk {
  createCalls = 0;
  deleteCalls = 0;
  private seq = 0;
  async create(_params?: {
    image?: string;
    envVars?: Record<string, string>;
    resources?: { cpu?: number; memory?: number; disk?: number };
    autoStopInterval?: number;
  }): Promise<FakeDaytonaVm> {
    this.createCalls++;
    return new FakeDaytonaVm(`vm-${++this.seq}`);
  }
  async delete(_vm: FakeDaytonaVm): Promise<void> {
    this.deleteCalls++;
  }
}

// ── shared workflow helpers (mirror runner.test.ts / sandbox-seatbelt.test.ts) ───────────────────────

function node(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return {
    label,
    prompt: `do ${label}`,
    tools: {},
    io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) },
    ...over,
  };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `piflow-${prefix}-`));
}

// The offline stub command builder (identical to runner.test.ts): instead of spawning `pi`, write each
// declared artifact into the node's sandbox OUTPUT dir at <output>/<artifactPath> (the path convention
// downloadDir flattens onto the host run dir), plus a return-protocol JSON block on stdout.
function stubBuilder(producePaths?: (node: { id: string }) => string[]) {
  return (n: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const paths = producePaths ? producePaths(n) : n.io.artifacts.map((a) => a.path);
    const writes = paths
      .map((p) => {
        const dest = `${n.sandbox.output}/${p}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${n.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${n.id} done"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

// ── provider cases: the SAME wiring the user writes, only `provider` swaps ────────────────────────────
// Each `setup()` yields a provider + a cleanup. The Daytona case also exposes its fake `sdk` so the
// cloud-only lifecycle block can assert the VM was booted once and torn down once.

interface ProviderCase {
  name: string;
  setup: () => Promise<{ provider: SandboxProvider; sdk?: FakeDaytonaSdk; cleanup: () => Promise<void> }>;
}

const PROVIDER_CASES: ProviderCase[] = [
  {
    name: 'inmemory (local)',
    setup: async () => ({ provider: new InMemorySandboxProvider(), cleanup: async () => {} }),
  },
  {
    name: 'daytona (cloud, fake SDK)',
    setup: async () => {
      const home = await tmpDir('vm-home');
      const sdk = new FakeDaytonaSdk();
      // homeDir = a real host dir ⇒ in-VM absolute paths are real host paths (faithful fs + shell).
      const provider = new DaytonaSandboxProvider(sdk, { homeDir: home });
      return { provider, sdk, cleanup: async () => { await fs.rm(home, { recursive: true, force: true }); } };
    },
  },
];

// ── 1. low-level Sandbox lifecycle parity (bare, no runner) ───────────────────────────────────────────
// Drives create → writeFile → exec (BUFFERED: no streaming opts, so the cloud path returns a faithful
// exit code) → readFile → downloadDir → dispose. IDENTICAL assertions for both backends.

interface SandboxCase {
  name: string;
  makeSandbox: () => Promise<{ sandbox: Sandbox; cleanup: () => Promise<void> }>;
}

const SANDBOX_CASES: SandboxCase[] = [
  {
    name: 'inmemory (local)',
    makeSandbox: async () => {
      const sandbox = await new InMemorySandboxProvider().create({ readScope: [], outputDir: 'out', workdir: 'work' });
      return { sandbox, cleanup: async () => { await sandbox.dispose().catch(() => {}); } };
    },
  },
  {
    name: 'daytona (cloud, fake SDK)',
    makeSandbox: async () => {
      const home = await tmpDir('vm-home');
      const provider = new DaytonaSandboxProvider(new FakeDaytonaSdk(), { homeDir: home });
      const sandbox = await provider.create({ readScope: [], outputDir: 'out', workdir: 'work' });
      return {
        sandbox,
        cleanup: async () => {
          await sandbox.dispose().catch(() => {});
          await fs.rm(home, { recursive: true, force: true });
        },
      };
    },
  },
];

describe.each(SANDBOX_CASES)('Sandbox lifecycle contract — $name', ({ makeSandbox }) => {
  it('stages a file, execs against it, reads it back, collects the output dir', async () => {
    const { sandbox, cleanup } = await makeSandbox();
    const dest = await tmpDir('dl');
    try {
      await sandbox.writeFile('in.txt', 'hello');
      const r = await sandbox.exec('cat in.txt > out/copy.txt');
      expect(r.code).toBe(0);
      expect(await sandbox.readFile('out/copy.txt', { encoding: 'utf8' })).toBe('hello');

      await sandbox.downloadDir('out', path.join(dest, 'out'));
      expect(await fs.readFile(path.join(dest, 'out', 'copy.txt'), 'utf8')).toBe('hello');
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
      await cleanup();
    }
  });

  it('surfaces a nonzero exit code', async () => {
    const { sandbox, cleanup } = await makeSandbox();
    try {
      expect((await sandbox.exec('exit 3')).code).toBe(3);
    } finally {
      await cleanup();
    }
  });
});

// ── 2. runner integration parity (the user-facing path: `provider:` swaps, nothing else) ──────────────

describe.each(PROVIDER_CASES)('runWorkflow contract — $name', ({ setup }) => {
  it('producer → consumer: run ok, artifacts host-verified, cross-sandbox file flow lands', async () => {
    const { provider, cleanup } = await setup();
    const outDir = await tmpDir('run');
    try {
      // Consumer reads Producer's artifact — staged across sandboxes via the host run dir. Identical
      // shape to the seatbelt e2e test; the ONLY difference here is which provider is passed.
      const g = compile(wf([node('Producer', [], ['a.txt']), node('Consumer', ['a.txt'], ['b.txt'])]));

      const { status } = await runWorkflow(g, {
        run: 'parity',
        outDir,
        provider,
        buildCommand: stubBuilder(),
        nodeTimeoutMs: 15000,
      });

      expect(status.ok).toBe(true);
      expect(status.done).toBe(true);
      expect(status.nodes.producer.status).toBe('ok');
      expect(status.nodes.consumer.status).toBe('ok');
      // Artifacts verified by host-stat (downloadDir flattened <output>/<path> → <hostRunDir>/<path>).
      expect(status.nodes.consumer.artifacts).toEqual([{ path: 'b.txt', exists: true, bytes: 'consumer'.length }]);
      expect(await fs.readFile(path.join(outDir, 'a.txt'), 'utf8')).toBe('producer');
      expect(await fs.readFile(path.join(outDir, 'b.txt'), 'utf8')).toBe('consumer');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await cleanup();
    }
  });

  it('blocked path: a node that produces nothing is `blocked` and halts the run (same verdict both backends)', async () => {
    const { provider, cleanup } = await setup();
    const outDir = await tmpDir('run');
    try {
      const g = compile(wf([node('Up', [], ['up.txt']), node('Down', ['up.txt'], ['down.txt'])]));
      let downRan = false;
      const builder = stubBuilder((n) => {
        if (n.id === 'down') downRan = true;
        return n.id === 'up' ? [] : ['down.txt']; // Up writes nothing → missing required artifact
      });

      const { status } = await runWorkflow(g, { run: 'parity-blocked', outDir, provider, buildCommand: builder, nodeTimeoutMs: 15000 });

      expect(status.nodes.up.status).toBe('blocked');
      expect(status.nodes.up.issues.join(' ')).toMatch(/required artifact.*missing/i);
      expect(downRan).toBe(false); // downstream never executed
      expect(status.nodes.down.status).toBe('pending');
      expect(status.ok).toBe(false);
      expect(status.done).toBe(true);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await cleanup();
    }
  });
});

// ── 3. cloud-only: the run-scoped VM lifecycle (what makes "cloud" different under the hood) ──────────
// The contract above is identical; HERE we prove the cloud SHAPE: ONE VM is booted for the whole run
// (openRun), every node runs as a view INSIDE it, and the VM is destroyed EXACTLY once at run end —
// not per node. This is the run-scope seam (RunScope/openRun) the local providers don't need.

describe('DaytonaSandboxProvider — run-scoped VM lifecycle (cloud-only)', () => {
  it('boots ONE VM for the whole run and destroys it exactly once, after the last node', async () => {
    const home = await tmpDir('vm-home');
    const sdk = new FakeDaytonaSdk();
    const provider = new DaytonaSandboxProvider(sdk, { homeDir: home });
    const outDir = await tmpDir('run');
    try {
      // A 3-node chain (A, B → C) so multiple per-node sandbox VIEWS are created inside the one VM.
      const g = compile(wf([node('A', [], ['a.txt']), node('B', [], ['b.txt']), node('C', ['a.txt', 'b.txt'], ['c.txt'])]));

      const { status } = await runWorkflow(g, { run: 'scoped-cloud', outDir, provider, buildCommand: stubBuilder(), nodeTimeoutMs: 15000 });

      expect(status.ok).toBe(true);
      expect(sdk.createCalls).toBe(1); // ONE VM per run (openRun), not one per node
      expect(sdk.deleteCalls).toBe(1); // torn down exactly once (RunScope.dispose), per-node dispose is a no-op
      expect(await fs.readFile(path.join(outDir, 'c.txt'), 'utf8')).toBe('c');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('still destroys the run VM exactly once when a node fails (teardown runs in finally)', async () => {
    const home = await tmpDir('vm-home');
    const sdk = new FakeDaytonaSdk();
    const provider = new DaytonaSandboxProvider(sdk, { homeDir: home });
    const outDir = await tmpDir('run');
    try {
      const g = compile(wf([node('Up', [], ['up.txt'])]));
      // Up produces nothing → blocked → run halts; the shared VM MUST still be destroyed (no leak/bill).
      const { status } = await runWorkflow(g, { run: 'scoped-fail', outDir, provider, buildCommand: stubBuilder(() => []), nodeTimeoutMs: 15000 });

      expect(status.ok).toBe(false);
      expect(status.nodes.up.status).toBe('blocked');
      expect(sdk.createCalls).toBe(1);
      expect(sdk.deleteCalls).toBe(1); // finally-block run-level teardown fired despite the failure
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('non-scoped create() owns a throwaway VM: dispose destroys it', async () => {
    // The fallback path (parity with inmemory/seatbelt `create`): one VM per node, owned by the view, so
    // the per-node dispose destroys it. Proven directly against the bare provider.create.
    const home = await tmpDir('vm-home');
    const sdk = new FakeDaytonaSdk();
    const provider = new DaytonaSandboxProvider(sdk, { homeDir: home });
    try {
      const sandbox = await provider.create({ readScope: [], outputDir: 'out', workdir: 'solo' });
      expect(sdk.createCalls).toBe(1);
      expect(sdk.deleteCalls).toBe(0);
      await sandbox.dispose();
      expect(sdk.deleteCalls).toBe(1); // ownsVm ⇒ dispose destroyed the throwaway VM
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
