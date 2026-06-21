// Sandbox providers — the create → stage → exec → collect → dispose lifecycle, one impl per backend.
// `InMemorySandbox` is the reference impl + the "simplest case": an ephemeral temp-dir workspace,
// wiped on dispose. It does NOT enforce read/write scope (that is the Seatbelt provider, ROADMAP M1)
// — it is the local, no-isolation baseline the runner and tests build on.

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type {
  Sandbox,
  SandboxProvider,
  SandboxProviderKind,
  CreateOpts,
  ExecOpts,
  ExecResult,
} from '../types.js';

export class InMemorySandbox implements Sandbox {
  private constructor(
    public readonly root: string,
    public readonly workdir: string,
    private readonly env: Record<string, string>,
  ) {}

  static async create(opts: CreateOpts): Promise<InMemorySandbox> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-'));
    const workdir = path.resolve(root, opts.workdir || '.');
    await fs.mkdir(workdir, { recursive: true });
    await fs.mkdir(path.resolve(workdir, opts.outputDir || 'out'), { recursive: true });
    return new InMemorySandbox(root, workdir, opts.env ?? {});
  }

  private abs(p: string): string {
    return path.resolve(this.workdir, p);
  }

  async putFiles(files: { path: string; data: Uint8Array | string }[]): Promise<void> {
    for (const f of files) await this.writeFile(f.path, f.data);
  }

  async writeFile(p: string, data: Uint8Array | string): Promise<void> {
    const target = this.abs(p);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }

  exec(cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn(cmd, {
        cwd: opts.cwd ? this.abs(opts.cwd) : this.workdir,
        env: { ...process.env, ...this.env, ...opts.env },
        shell: true,
        // detached → the command is its own process group leader, so on cancel we can kill the WHOLE
        // tree (the agent AND any grandchildren it spawned), not just the shell — no orphans.
        detached: true,
        // Close stdin: a headless CLI with an open stdin pipe and no TTY blocks forever waiting for
        // EOF (the documented ~10-minute pi hang). Pipe stdout/stderr for the event stream.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let done = false;
      const signal = opts.signal;
      // On cancel, SIGTERM the process group then SIGKILL-escalate (`-pid` targets the group).
      const onAbort = (): void => {
        const pid = child.pid;
        if (pid === undefined) return;
        try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
        const esc = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* reaped */ } }, 2000);
        esc.unref?.();
      };
      const cleanup = (): void => { signal?.removeEventListener('abort', onAbort); };
      const finish = (r: ExecResult): void => { if (done) return; done = true; cleanup(); resolve(r); };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      child.stdout?.on('data', (d: Buffer) => {
        const s = d.toString();
        stdout += s;
        opts.onStdout?.(s);
      });
      child.stderr?.on('data', (d: Buffer) => {
        const s = d.toString();
        stderr += s;
        opts.onStderr?.(s);
      });
      child.on('error', (err) => finish({ stdout, stderr: stderr + String(err), code: 1 }));
      // A signal-killed child reports code=null + a signal name → surface a nonzero (124) so the runner
      // classifies it as a failure even before the watchdog's own `killed` verdict.
      child.on('close', (code, sig) => finish({ stdout, stderr, code: code ?? (sig ? 124 : 0) }));
    });
  }

  async readFile(p: string, opts: { encoding?: 'utf8' } = {}): Promise<Uint8Array | string> {
    return opts.encoding === 'utf8' ? fs.readFile(this.abs(p), 'utf8') : fs.readFile(this.abs(p));
  }

  async downloadDir(remote: string, local: string): Promise<void> {
    await fs.cp(this.abs(remote), path.resolve(process.cwd(), local), { recursive: true });
  }

  async dispose(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
  }
}

export class InMemorySandboxProvider implements SandboxProvider {
  readonly kind: SandboxProviderKind = 'inmemory';
  create(opts: CreateOpts): Promise<Sandbox> {
    return InMemorySandbox.create(opts);
  }
}

/** A backend that is declared in the spine but not yet implemented (Seatbelt/worktree/Daytona/E2B). */
export class NotImplementedProvider implements SandboxProvider {
  constructor(public readonly kind: SandboxProviderKind) {}
  create(): Promise<Sandbox> {
    return Promise.reject(
      new Error(`SandboxProvider '${this.kind}' is not implemented yet (horizontal fill — see ROADMAP M1/M3).`),
    );
  }
}
