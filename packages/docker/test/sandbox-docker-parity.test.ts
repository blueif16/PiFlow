// Contract parity + lifecycle for the LOCAL Docker sandbox.
//
// The seam's promise (mirrored from @piflow/e2b's sandbox-e2b-parity.test.ts): "One provider-agnostic
// lifecycle, identical local or cloud: create → stage → exec → collect → dispose." This file drives the
// REAL `DockerSandboxProvider` (src/docker.ts) against a FAKE `DockerSdk` whose "container" is a host temp
// dir (the provider is constructed with `homeDir` = that dir, so every in-container absolute path the
// provider builds IS a real host path — no path rewriting, faithful fs + shell). It exercises docker.ts's
// real lifecycle code: openRun (one container/run), per-node views, writeMany/read/list staging+collection,
// BOTH exec paths (buffered + background/streaming/cancel), and run-scoped dispose — WITHOUT a Docker daemon.
//
// The fake reproduces the seam's post-normalization shape so a wiring bug FAILS the test:
//   • commands.run / handle.wait() return a result for ANY exit code (never throw on nonzero).
//   • stdout and stderr are SEPARATE.
//   • runBackground streams via onStdout/onStderr AND wait() carries the real exit code; kill() really
//     terminates the child (via its process group, so a `sleep` grandchild dies too).

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  compile,
  InMemorySandboxProvider,
  runWorkflow,
} from '@piflow/core';
import type {
  NodeIntent,
  WorkflowSpec,
  Sandbox,
  SandboxProvider,
} from '@piflow/core';
import { DockerSandboxProvider } from '../src/docker.js';
import type {
  DockerSdk,
  DockerContainer,
  DockerFs,
  DockerProcess,
  DockerEntry,
  DockerRunOpts,
  DockerExecResult,
  DockerCommandHandle,
} from '../src/docker.js';

// ── the fake Docker SDK: a "container" that is really a host temp dir ──────────────────────────────

class FakeDockerFs implements DockerFs {
  async write(remotePath: string, data: Uint8Array | string): Promise<void> {
    await fs.mkdir(path.dirname(remotePath), { recursive: true });
    await fs.writeFile(remotePath, data);
  }
  async writeMany(files: { path: string; data: Uint8Array | string }[]): Promise<void> {
    for (const f of files) await this.write(f.path, f.data);
  }
  async read(remotePath: string): Promise<Uint8Array> {
    return fs.readFile(remotePath);
  }
  async list(root: string): Promise<DockerEntry[]> {
    const out: DockerEntry[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Awaited<ReturnType<typeof fs.readdir>> = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // missing dir → no entries (a node that produced nothing)
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const isDir = e.isDirectory();
        out.push({ path: full, isDir });
        if (isDir) await walk(full);
      }
    };
    await walk(root);
    return out;
  }
  async makeDir(remotePath: string): Promise<void> {
    await fs.mkdir(remotePath, { recursive: true });
  }
}

class FakeDockerProcess implements DockerProcess {
  // Buffered exec — SEPARATE stdout/stderr, returns a result for ANY exit code.
  run(cmd: string, opts?: DockerRunOpts): Promise<DockerExecResult> {
    return new Promise((resolve) => {
      const child = spawn(cmd, {
        cwd: opts?.cwd,
        env: { ...process.env, ...(opts?.envs ?? {}) },
        shell: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', () => resolve({ stdout, stderr, exitCode: 1 }));
      child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    });
  }

  // Background exec — streams via the callbacks in real time, AND wait() carries the real exit code;
  // kill() really terminates the child's process group (so a `shell:true` child AND its grandchildren die).
  async runBackground(cmd: string, opts?: DockerRunOpts): Promise<DockerCommandHandle> {
    const child = spawn(cmd, {
      cwd: opts?.cwd,
      env: { ...process.env, ...(opts?.envs ?? {}) },
      shell: true,
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout?.on('data', (d: Buffer) => { const s = d.toString(); stdout += s; opts?.onStdout?.(s); });
    child.stderr?.on('data', (d: Buffer) => { const s = d.toString(); stderr += s; opts?.onStderr?.(s); });
    const done = new Promise<number>((res) => {
      child.on('close', (code) => res(code ?? 0));
      child.on('error', () => res(1));
    });
    return {
      pid: child.pid ?? -1,
      async wait(): Promise<DockerExecResult> {
        const code = await done;
        return { stdout, stderr, exitCode: killed ? 137 : code };
      },
      async kill(): Promise<void> {
        killed = true;
        // Kill the whole process group (negative pid) so a `shell:true` child AND its grandchildren
        // (e.g. a `sleep`) die together — otherwise an orphaned grandchild keeps the pipe open and wait() hangs.
        if (!child.killed && child.pid !== undefined) {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
        }
      },
    };
  }
}

class FakeDockerContainer implements DockerContainer {
  readonly id: string;
  readonly files = new FakeDockerFs();
  readonly commands = new FakeDockerProcess();
  killed = false;
  constructor(id: string) { this.id = id; }
  async kill(): Promise<void> { this.killed = true; }
}

/** The fake SDK. Tracks create/kill so a test can assert the per-run container lifecycle (1 boot, 1 rm). */
class FakeDockerSdk implements DockerSdk {
  createCalls = 0;
  killCalls = 0;
  containers: FakeDockerContainer[] = [];
  private seq = 0;
  async create(): Promise<DockerContainer> {
    this.createCalls++;
    const c = new FakeDockerContainer(`ctr-${++this.seq}`);
    const origKill = c.kill.bind(c);
    c.kill = async (): Promise<void> => { this.killCalls++; await origKill(); };
    this.containers.push(c);
    return c;
  }
}

// ── shared workflow helpers (mirror sandbox-e2b-parity.test.ts) ────────────────────────────────────

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
  return fs.mkdtemp(path.join(os.tmpdir(), `piflow-docker-${prefix}-`));
}

// The offline stub command builder (identical to sandbox-e2b-parity.test.ts): instead of spawning `pi`,
// write each declared artifact into the node's sandbox OUTPUT dir, plus a return-protocol block.
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

// ── 1. low-level Sandbox lifecycle parity (bare, no runner) ────────────────────────────────────────

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
    name: 'docker (local container, fake SDK)',
    makeSandbox: async () => {
      const home = await tmpDir('ctr-home');
      const provider = new DockerSandboxProvider(new FakeDockerSdk(), { image: 'fake', homeDir: home });
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

  it('putFiles bulk-stages multiple files', async () => {
    const { sandbox, cleanup } = await makeSandbox();
    try {
      await sandbox.putFiles([
        { path: 'a/one.txt', data: 'one' },
        { path: 'a/two.txt', data: 'two' },
      ]);
      expect(await sandbox.readFile('a/one.txt', { encoding: 'utf8' })).toBe('one');
      expect(await sandbox.readFile('a/two.txt', { encoding: 'utf8' })).toBe('two');
    } finally {
      await cleanup();
    }
  });
});

// ── 2. runner integration parity (the user-facing path: `provider:` swaps, nothing else) ───────────

interface ProviderCase {
  name: string;
  setup: () => Promise<{ provider: SandboxProvider; cleanup: () => Promise<void> }>;
}

const PROVIDER_CASES: ProviderCase[] = [
  {
    name: 'inmemory (local)',
    setup: async () => ({ provider: new InMemorySandboxProvider(), cleanup: async () => {} }),
  },
  {
    name: 'docker (local container, fake SDK)',
    setup: async () => {
      const home = await tmpDir('ctr-home');
      const provider = new DockerSandboxProvider(new FakeDockerSdk(), { image: 'fake', homeDir: home });
      return { provider, cleanup: async () => { await fs.rm(home, { recursive: true, force: true }); } };
    },
  },
];

describe.each(PROVIDER_CASES)('runWorkflow contract — $name', ({ setup }) => {
  it('producer → consumer: run ok, artifacts host-verified, cross-sandbox file flow lands', async () => {
    const { provider, cleanup } = await setup();
    const outDir = await tmpDir('run');
    try {
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
      expect(status.nodes.consumer.artifacts).toEqual([{ path: 'b.txt', exists: true, bytes: 'consumer'.length }]);
      expect(await fs.readFile(path.join(outDir, 'a.txt'), 'utf8')).toBe('producer');
      expect(await fs.readFile(path.join(outDir, 'b.txt'), 'utf8')).toBe('consumer');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await cleanup();
    }
  });

  it('blocked path: a node that produces nothing is `blocked` and halts the run (same verdict as inmemory)', async () => {
    const { provider, cleanup } = await setup();
    const outDir = await tmpDir('run');
    try {
      const g = compile(wf([node('Up', [], ['up.txt']), node('Down', ['up.txt'], ['down.txt'])]));
      let downRan = false;
      const builder = stubBuilder((n) => {
        if (n.id === 'down') downRan = true;
        return n.id === 'up' ? [] : ['down.txt'];
      });

      const { status } = await runWorkflow(g, { run: 'parity-blocked', outDir, provider, buildCommand: builder, nodeTimeoutMs: 15000 });

      expect(status.nodes.up.status).toBe('blocked');
      expect(status.nodes.up.issues.join(' ')).toMatch(/required artifact.*missing/i);
      expect(downRan).toBe(false);
      expect(status.nodes.down.status).toBe('pending');
      expect(status.ok).toBe(false);
      expect(status.done).toBe(true);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await cleanup();
    }
  });
});

// ── 3. the run-scoped container lifecycle (what makes a CLOUD_KIND different under the hood) ────────

describe('DockerSandboxProvider — run-scoped container lifecycle', () => {
  it('boots ONE container for the whole run and removes it exactly once, after the last node', async () => {
    const home = await tmpDir('ctr-home');
    const sdk = new FakeDockerSdk();
    const provider = new DockerSandboxProvider(sdk, { image: 'fake', homeDir: home });
    const outDir = await tmpDir('run');
    try {
      const g = compile(wf([node('A', [], ['a.txt']), node('B', [], ['b.txt']), node('C', ['a.txt', 'b.txt'], ['c.txt'])]));

      const { status } = await runWorkflow(g, { run: 'scoped', outDir, provider, buildCommand: stubBuilder(), nodeTimeoutMs: 15000 });

      expect(status.ok).toBe(true);
      expect(sdk.createCalls).toBe(1); // ONE container per run (openRun), not one per node
      expect(sdk.killCalls).toBe(1); // removed exactly once (RunScope.dispose); per-node dispose is a no-op
      expect(await fs.readFile(path.join(outDir, 'c.txt'), 'utf8')).toBe('c');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('still removes the run container exactly once when a node fails (teardown runs in finally)', async () => {
    const home = await tmpDir('ctr-home');
    const sdk = new FakeDockerSdk();
    const provider = new DockerSandboxProvider(sdk, { image: 'fake', homeDir: home });
    const outDir = await tmpDir('run');
    try {
      const g = compile(wf([node('Up', [], ['up.txt'])]));
      const { status } = await runWorkflow(g, { run: 'scoped-fail', outDir, provider, buildCommand: stubBuilder(() => []), nodeTimeoutMs: 15000 });

      expect(status.ok).toBe(false);
      expect(status.nodes.up.status).toBe('blocked');
      expect(sdk.createCalls).toBe(1);
      expect(sdk.killCalls).toBe(1); // finally-block run-level teardown fired despite the failure
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('non-scoped create() owns a throwaway container: dispose removes it', async () => {
    const home = await tmpDir('ctr-home');
    const sdk = new FakeDockerSdk();
    const provider = new DockerSandboxProvider(sdk, { image: 'fake', homeDir: home });
    try {
      const sandbox = await provider.create({ readScope: [], outputDir: 'out', workdir: 'solo' });
      expect(sdk.createCalls).toBe(1);
      expect(sdk.killCalls).toBe(0);
      await sandbox.dispose();
      expect(sdk.killCalls).toBe(1); // ownsContainer ⇒ dispose removed the throwaway container
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

// ── 4. docker-specific: streaming callbacks fire, and cancel via signal kills the command ───────────

describe('DockerSandbox — streaming + cancel (the exec contract that needs a live e2e)', () => {
  it('streams stdout via onStdout when a callback is passed (the background path)', async () => {
    const home = await tmpDir('ctr-home');
    const provider = new DockerSandboxProvider(new FakeDockerSdk(), { image: 'fake', homeDir: home });
    try {
      const sandbox = await provider.create({ readScope: [], outputDir: 'out', workdir: 'work' });
      const chunks: string[] = [];
      const r = await sandbox.exec("printf 'streamed-line\\n'", { onStdout: (c) => chunks.push(c) });
      expect(r.code).toBe(0);
      expect(chunks.join('')).toContain('streamed-line'); // the callback fired
      expect(r.stdout).toContain('streamed-line'); // and the buffered result is faithful
      await sandbox.dispose();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('reports separate stderr (streams are split — not collapsed into stdout)', async () => {
    const home = await tmpDir('ctr-home');
    const provider = new DockerSandboxProvider(new FakeDockerSdk(), { image: 'fake', homeDir: home });
    try {
      const sandbox = await provider.create({ readScope: [], outputDir: 'out', workdir: 'work' });
      const errChunks: string[] = [];
      const r = await sandbox.exec("printf 'oops\\n' 1>&2", { onStderr: (c) => errChunks.push(c) });
      expect(errChunks.join('')).toContain('oops');
      expect(r.stderr).toContain('oops');
      expect(r.stdout).toBe(''); // stderr did NOT leak into stdout
      await sandbox.dispose();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('cancel via AbortSignal kills the running command and returns the 124 kill code', async () => {
    const home = await tmpDir('ctr-home');
    const provider = new DockerSandboxProvider(new FakeDockerSdk(), { image: 'fake', homeDir: home });
    try {
      const sandbox = await provider.create({ readScope: [], outputDir: 'out', workdir: 'work' });
      const ac = new AbortController();
      const p = sandbox.exec('sleep 30', { signal: ac.signal });
      setTimeout(() => ac.abort(), 50);
      const r = await p;
      expect(r.code).toBe(124); // the runner kill convention — proves kill-on-abort fired
      await sandbox.dispose();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
