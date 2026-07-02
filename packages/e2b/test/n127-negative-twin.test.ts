// Target 2 · TEST CONTRACT (c) — the N-127 NEGATIVE TWIN (docs/design/full-run-e2e-LOCKED.md §"Target 2").
//
// N-127's falsifiable form (§3): the control plane's e2b worker boots a *pi-less base image* (no
// E2B_TEMPLATE) → `pi: command not found` → exit 127 → the node writes NOTHING → the full-run rubric
// must CATCH the silent failure. Here we model that fault as exactly what a pi-less base yields — "the
// e2b worker produced no artifact" — using the FakeE2b seam, and assert the rubric reds on it.
//
// This is the GUARDRAIL twin (GREEN now): `assessRunView` already catches a missing on-disk artifact on
// a REAL backend. Its whole point is to distinguish N-127 (missing artifact on a genuine e2b backend —
// `forbidSandbox:['inmemory']` does NOT fire) from N-inmemory (the backend gate itself reds). The load-
// bearing observable is `view.sandbox==='e2b'` (a real backend ran) AND the assess verdict flips to
// `pass===false` for the missing `out/greet/greeting.txt`, NOT the agent's self-report.
//
// Teeth (verify phase): swap `stubBuilder(() => [])` for `stubBuilder((n) => ['out/greet/greeting.txt'])`
// (writes the declared artifact) → `a.pass` flips to `true`. The standing `pass===false` is the injected
// fault; `assess.ts:72` (`if (!a.exists)`) is the production line that must stay wired.
//
// Reuse (per the LOCKED spec §"Target 2 (c)"): sandbox-e2b-parity.test.ts:48 (FakeE2bSdk), :186
// (stubBuilder), :326-349 (blocked-path harness), @piflow/core/observe (index.ts:15,23).

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
// buildRunView + assessRunView are the observe layer (@piflow/core/observe, index.ts:15,23); the
// package re-exports both from its main '.' entry (packages/core/dist/index.d.ts:107,109), and the
// './observe' subpath is not in the exports map — so we import them from '@piflow/core' (same symbols).
import { compile, runWorkflow, buildRunView, assessRunView } from '@piflow/core';
import type { NodeIntent, WorkflowSpec } from '@piflow/core';
import { E2bSandboxProvider } from '../src/e2b.js';
import type {
  E2bSdk,
  E2bVm,
  E2bFs,
  E2bProcess,
  E2bEntry,
  E2bRunOpts,
  E2bExecResult,
  E2bCommandHandle,
} from '../src/e2b.js';

// ── the fake E2B SDK: a "VM" that is really a host temp dir (verbatim from sandbox-e2b-parity.test.ts) ─

class FakeE2bFs implements E2bFs {
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
  async list(root: string): Promise<E2bEntry[]> {
    const out: E2bEntry[] = [];
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

class FakeE2bProcess implements E2bProcess {
  run(cmd: string, opts?: E2bRunOpts): Promise<E2bExecResult> {
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

  async runBackground(cmd: string, opts?: E2bRunOpts): Promise<E2bCommandHandle> {
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
      async wait(): Promise<E2bExecResult> {
        const code = await done;
        return { stdout, stderr, exitCode: killed ? 137 : code };
      },
      async kill(): Promise<void> {
        killed = true;
        if (!child.killed && child.pid !== undefined) {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
        }
      },
    };
  }
}

class FakeE2bVm implements E2bVm {
  readonly id: string;
  readonly files = new FakeE2bFs();
  readonly commands = new FakeE2bProcess();
  killed = false;
  constructor(id: string) { this.id = id; }
  async kill(): Promise<void> { this.killed = true; }
}

class FakeE2bSdk implements E2bSdk {
  createCalls = 0;
  killCalls = 0;
  vms: FakeE2bVm[] = [];
  private seq = 0;
  async create(): Promise<E2bVm> {
    this.createCalls++;
    const vm = new FakeE2bVm(`sbx-${++this.seq}`);
    const origKill = vm.kill.bind(vm);
    vm.kill = async (): Promise<void> => { this.killCalls++; await origKill(); };
    this.vms.push(vm);
    return vm;
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
  return fs.mkdtemp(path.join(os.tmpdir(), `piflow-n127-${prefix}-`));
}

// The offline stub command builder (identical to sandbox-e2b-parity.test.ts): write each declared
// artifact into the node's sandbox OUTPUT dir, plus a return-protocol block. When `producePaths`
// returns [], NOTHING is written — modeling the pi-less-base 127 (exit 127, no artifact).
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

// ── the N-127 negative twin ─────────────────────────────────────────────────────────────────────

describe('N-127 negative twin — e2b worker produced no artifact (pi-less base) fails the rubric', () => {
  it('runs on a REAL e2b backend yet reds because greeting.txt is missing on disk (127, not inmemory)', async () => {
    const home = await tmpDir('vm-home');
    const provider = new E2bSandboxProvider(new FakeE2bSdk(), { homeDir: home }); // kind === 'e2b'
    const outDir = await tmpDir('run');
    try {
      const g = compile(wf([node('Greet', [], ['out/greet/greeting.txt'])]));

      // buildCommand writes NOTHING — exactly what a pi-less base image yields (exit 127, no artifact).
      await runWorkflow(g, {
        run: 'n127',
        outDir,
        provider,
        buildCommand: stubBuilder(() => []),
        nodeTimeoutMs: 15000,
      });

      const { view } = buildRunView(outDir);

      // A REAL backend ran — the e2b provider, NOT the inmemory no-op. This is what distinguishes
      // N-127 (missing artifact on a genuine backend) from N-inmemory (the backend gate reds).
      expect(view.sandbox).toBe('e2b');

      // The rubric CATCHES the silent 127: greet declared out/greet/greeting.txt but produced nothing.
      const a = assessRunView(view, { expectNodes: ['greet'] });
      expect(a.pass).toBe(false);
      expect(a.failures.join(' ')).toMatch(/greeting\.txt.*missing|missing.*greeting\.txt/i);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
