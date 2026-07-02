// Target 3 (N-breach) — CROSS-KIND RUNTIME PARITY, GUARDRAIL.
//
// The N-breach signature is that a SINGLE-kind test structurally cannot catch: an output-collection
// config that greens `local` (IN_PLACE, no strip) reds `e2b` (downloadDir flattens the prefix), and
// vice-versa. This test characterizes the ALREADY-WORKING runtime: when a greet node declaring
// `artifacts:["out/greet/greeting.txt"]` is compiled with `sandbox.output:"."` INJECTED directly into
// the intent (bypassing the loader, so this test does NOT depend on Target 3's loader passthrough),
// the deliverable lands at `outDir/out/greet/greeting.txt` under BOTH kinds — because `output:"."` is
// the identity collection (no flatten). Both arms are GREEN now.
//
// This is the ORACLE the Target 3 SDK fix must keep green. Its teeth: reverting the injected
// `sandbox.output` from `"."` back to `"out/greet"` makes e2b's downloadDir strip the `out/greet/`
// prefix → the file lands at `outDir/greeting.txt`, the contract stats `outDir/out/greet/greeting.txt`
// → MISS → the e2b arm reds while local stays green. That EXACTLY-ONE-ARM asymmetry is the N-breach
// discriminator (verified against the FIXED-STATE TRUTH TABLE in the LOCKED design).
//
// Reuse: the FakeE2bSdk / node() / relativeWriteBuilder harnesses are module-local in
// sandbox-e2b-parity.test.ts + in-place-artifact.test.ts (not exported), so they are copied here
// byte-faithful (the standard reuse-by-copy for these fakes). The independent post-hoc probe is a
// fresh `readFileSync` at the contract stat path — NOT `view.artifacts[].exists` (the runner's path).

import { describe, it, expect } from 'vitest';
import { promises as fs, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { compile, runWorkflow, LocalSandboxProvider } from '@piflow/core';
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

// ── the fake E2B SDK: a "VM" that is really a host temp dir (copied from sandbox-e2b-parity.test.ts:48) ──

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
        return;
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

// ── workflow helpers (node() with the over:Partial<NodeIntent> seam, sandbox-e2b-parity.test.ts:169) ──

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
  return fs.mkdtemp(path.join(os.tmpdir(), `piflow-nbreach-${prefix}-`));
}

// A builder that writes the CONTROL-VM-OK content at the RELATIVE artifact path — exactly how a real `pi`
// agent writes `out/greet/greeting.txt` (no `output/` prefix). Mirrors relativeWriteBuilder,
// in-place-artifact.test.ts:23 (mkdir -p <dir> && printf … > <path>), but writes a fixed content so the
// independent probe can assert on it. `contentBuilder`-style so both arms produce identical bytes.
function controlVmBuilder() {
  return (n: { io: { artifacts: { path: string }[] } }): string => {
    const writes = n.io.artifacts
      .map((a) => {
        const p = a.path;
        const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' 'CONTROL-VM-OK' > ${p}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok"}\\n\`\`\`'`;
    return `${writes} && ${ret}`;
  };
}

// The FIXED-STATE parity config: declared artifact = the exact write path, output pinned to identity ".".
// Injected DIRECTLY into the intent's sandbox (over:Partial<NodeIntent>), bypassing the loader — so this
// guardrail does NOT depend on Target 3's loader passthrough (that is what the sibling loader test covers).
const ARTIFACT = 'out/greet/greeting.txt';
const greetWf = (): WorkflowSpec =>
  wf([node('Greet', [], [ARTIFACT], { sandbox: { output: '.' } })]);

describe('N-breach cross-kind parity — output:"." lands out/greet/greeting.txt under BOTH kinds', () => {
  it('Arm A (local, IN_PLACE): greet is ok AND the deliverable reads CONTROL-VM-OK at the contract path', async () => {
    const outDir = await tmpDir('local');
    try {
      const g = compile(greetWf());
      const { status } = await runWorkflow(g, {
        run: 'nbreach-local',
        outDir,
        provider: new LocalSandboxProvider({ enforceReadScope: false }), // kind 'local' ⇒ IN_PLACE (no download)
        buildCommand: controlVmBuilder(),
        nodeTimeoutMs: 15000,
      });

      // (1) verdict ok (verdict ladder).
      expect(status.nodes.greet.status).toBe('ok');
      // (2) INDEPENDENT post-hoc probe — fresh fs read at the contract stat path (NOT view.artifacts[].exists).
      expect(readFileSync(path.resolve(outDir, ARTIFACT), 'utf8').trim()).toBe('CONTROL-VM-OK');
      // (3) path-equality invariant: the file is at out/greet/greeting.txt, NOT duplicated at bare greeting.txt.
      expect(existsSync(path.resolve(outDir, 'greeting.txt'))).toBe(false);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it('Arm B (e2b, downloadDir flatten): greet is ok AND the deliverable reads CONTROL-VM-OK at the contract path', async () => {
    const home = await tmpDir('vm-home');
    const outDir = await tmpDir('e2b');
    try {
      const g = compile(greetWf());
      const { status } = await runWorkflow(g, {
        run: 'nbreach-e2b',
        outDir,
        provider: new E2bSandboxProvider(new FakeE2bSdk(), { homeDir: home }), // kind 'e2b' ⇒ real downloadDir(".")
        buildCommand: controlVmBuilder(),
        nodeTimeoutMs: 15000,
      });

      // (1) verdict ok.
      expect(status.nodes.greet.status).toBe('ok');
      // (2) INDEPENDENT post-hoc probe — fresh fs read at the contract stat path.
      expect(readFileSync(path.resolve(outDir, ARTIFACT), 'utf8').trim()).toBe('CONTROL-VM-OK');
      // (3) path-equality invariant: identity collection did NOT strip the out/greet/ prefix.
      expect(existsSync(path.resolve(outDir, 'greeting.txt'))).toBe(false);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
