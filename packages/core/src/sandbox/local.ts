// ─────────────────────────────────────────────────────────────────────────────
// LocalSandbox / LocalSandboxProvider — the IN-PLACE sandbox (a first-class
// `'local'` kind), the semantic OPPOSITE of InMemorySandbox.
//
// Every OTHER provider (InMemory, Seatbelt) `mkdtemp`s a THROWAWAY workspace and
// `downloadDir`-copies outputs back, then wipes it on dispose. This provider runs a
// node IN-PLACE in a REAL existing directory (the user's working tree): the sandbox
// root IS `resolve(opts.workdir)` (NO temp dir), `downloadDir` is a GUARDED IDENTITY
// (a no-op when remote==local, a THROW on a real mismatch), and `dispose` NEVER
// deletes the tree. It is the SDK port of the live `pi-runner/run.mjs` RUN_CWD model.
//
// It is InMemorySandbox (src/sandbox/index.ts) with FOUR in-place deltas only:
//   create   — root = resolve(workdir) (mkdir -p), NOT mkdtemp        (the GAP-1 guard)
//   write    — resolve under the real root (unchanged from InMemory)
//   download — guarded-identity: no-op iff realpath(remote)===realpath(local), else THROW
//   dispose  — NO-OP (the workspace is the user's project tree — NEVER fs.rm the root)
// exec keeps the reference impl's detached process-group kill + closed-stdin, but is
// SECURE BY DEFAULT: on darwin it wraps the command in the SHARED `seatbeltExecPlan`
// (sandbox-exec, kernel-enforced read-scope) so a node reads ONLY its declared readScope
// + the toolchain — the whole reason a per-node swarm exists. Writes stay open (the
// in-place tree is the deliverable) and network stays open (the `pi` agent MUST reach its
// model gateway — UNLIKE Codex, which sandboxes shell sub-commands that need no network).
// Off darwin the wrap is a no-op (warns once) until the Linux bwrap backend lands. The jail
// is the DEFAULT; `enforceReadScope:false` is the loud `danger-full-access` escape hatch.
// There is NO `execCwd` argument: U1 staged each node under `_pi/<id>/`, so one shared
// workdir is collision-safe (the run.mjs reference carried execCwd to dodge a fixed-prompt-
// path clash; that cause is gone — dropped).
//
// Run-level isolation: `openRun` returns a TRIVIAL RunScope rooted at `repoRoot`
// whose `create` forwards to `provider.create` and whose `dispose` is a no-op — there
// is no shared backing resource to tear down (the filesystem IS the resource). This
// makes the in-place model the provider's EXPLICIT, documented behavior rather than
// relying on the runner's synthesized fallback.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
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
  RunScope,
  OpenRunOpts,
} from '../types.js';
import { tailAppend } from './capture.js';
import { seatbeltExecPlan } from './seatbelt.js';

export class LocalSandbox implements Sandbox {
  readonly kind = 'local' as const;

  private constructor(
    /** The REAL workspace this sandbox operates in-place — the writeFile/readFile/exec base. */
    public readonly root: string,
    public readonly workdir: string,
    private readonly env: Record<string, string>,
    /** Declared read roots (resolved absolute) granted to the kernel jail beyond the workdir + toolchain. */
    private readonly readScope: string[],
    /** Wrap exec in the read-scope jail (darwin). Default true; false ⇒ the danger-full-access bypass. */
    private readonly enforceReadScope: boolean,
  ) {}

  /**
   * Root the sandbox AT the given workdir (resolved absolute). Unlike InMemory there is NO mkdtemp —
   * we only ensure the real dir (and its output subdir) exist. All files live in the REAL tree.
   * `runtime.enforceReadScope` (default true) selects the secure-by-default read-scope jail; pass false
   * for the `danger-full-access` bypass.
   */
  static async create(
    opts: CreateOpts,
    runtime: { enforceReadScope?: boolean } = {},
  ): Promise<LocalSandbox> {
    const root = path.resolve(opts.workdir || '.');
    await fs.mkdir(root, { recursive: true });
    if (opts.outputDir) await fs.mkdir(path.resolve(root, opts.outputDir), { recursive: true });
    // Resolve declared scope to absolute (entries are absolute by contract; a relative one resolves
    // vs the in-place root to stay self-consistent), mirroring SeatbeltSandbox.create.
    const readScope = (opts.readScope ?? []).map((p) =>
      path.isAbsolute(p) ? p : path.resolve(root, p),
    );
    return new LocalSandbox(root, root, opts.env ?? {}, readScope, runtime.enforceReadScope ?? true);
  }

  private abs(p: string): string {
    return path.resolve(this.root, p);
  }

  async putFiles(files: { path: string; data: Uint8Array | string }[]): Promise<void> {
    for (const f of files) await this.writeFile(f.path, f.data);
  }

  async writeFile(p: string, data: Uint8Array | string): Promise<void> {
    const target = this.abs(p);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }

  /**
   * Run a command in the real workspace. The process-group kill + closed-stdin + ExecOpts.signal
   * handling is copied EXACTLY from InMemorySandbox (the exec contract): detached → the command is its
   * own process-group leader, so on cancel we kill the WHOLE tree; stdin closed so a headless CLI never
   * blocks on EOF; on abort SIGTERM the group then SIGKILL-escalate.
   */
  exec(cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      const cwd = opts.cwd ? this.abs(opts.cwd) : this.workdir;
      // Secure by default: wrap in the shared read-scope jail (darwin) so reads outside the declared
      // scope EPERM. The per-exec profile is written to the OS tmpdir — NEVER littered into the user's
      // in-place tree. `null` ⇒ off-darwin or the danger bypass ⇒ run the bare command (unsandboxed).
      const plan =
        this.enforceReadScope && cmd
          ? seatbeltExecPlan(cmd, {
              workdir: this.workdir,
              readScope: [...this.readScope, cwd], // grant the workdir + declared scope + the exec cwd
              profileDir: os.tmpdir(),
            })
          : null;
      const child = spawn(plan ? plan.file : cmd, plan ? plan.argv : [], {
        cwd,
        env: { ...process.env, ...this.env, ...opts.env },
        // bare path uses the shell (InMemory parity); the wrapped path runs OUR argv (sandbox-exec) directly.
        shell: plan ? false : true,
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
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
        if (plan) { try { fsSync.unlinkSync(plan.profilePath); } catch { /* already gone */ } }
      };
      const finish = (r: ExecResult): void => { if (done) return; done = true; cleanup(); resolve(r); };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      child.stdout?.on('data', (d: Buffer) => {
        const s = d.toString();
        stdout = tailAppend(stdout, s);
        opts.onStdout?.(s);
      });
      child.stderr?.on('data', (d: Buffer) => {
        const s = d.toString();
        stderr = tailAppend(stderr, s);
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

  /**
   * GUARDED IDENTITY. In-place means the node ran directly in the real workspace, so its output already
   * lives at the host location — when `remote` and `local` resolve to the SAME real path there is NOTHING
   * to collect (a copy would be a self-copy or, worse, clone the tree into itself). So this is a no-op
   * iff `realpath(remote) === realpath(local)`. A REAL mismatch (the caller asked to collect somewhere
   * the output does NOT already live) is an ERROR, not a silent no-op — we THROW so the misuse surfaces
   * rather than silently dropping the deliverable. (`remote` resolves under the sandbox root; `local`
   * against the host cwd, matching the other providers' downloadDir base.)
   */
  async downloadDir(remote: string, local: string): Promise<void> {
    const remoteAbs = this.abs(remote);
    const localAbs = path.resolve(process.cwd(), local);
    // realpath canonicalizes symlinks so a symlinked-but-same dir still reads as identity. A `local`
    // that does NOT exist canNOT be the identity target (the in-place output lives at an existing path),
    // so fall back to its resolved absolute path → it won't equal `remoteReal` → we take the throw branch
    // with the clear misuse message (rather than leaking the raw ENOENT from realpath).
    const remoteReal = await fs.realpath(remoteAbs);
    const localReal = await fs.realpath(localAbs).catch(() => localAbs);
    if (remoteReal === localReal) return; // identity — already on the host disk, nothing to collect
    throw new Error(
      `LocalSandbox.downloadDir: in-place collection is identity-only, but remote (${remoteReal}) ` +
        `!== local (${localReal}). The output already lives at the in-place root; a non-identity ` +
        `target is a misuse (the runner should download a 'local' node's output to its own location).`,
    );
  }

  /** NO-OP. NEVER delete the real workspace — it is the user's project tree (the in-place contract). */
  async dispose(): Promise<void> {
    /* intentionally empty — the workspace is the user's tree; preserving it is the whole point. */
  }
}

/**
 * A trivial run scope rooted at `repoRoot`, made by `LocalSandboxProvider.openRun`. It owns NO shared
 * backing resource (the filesystem itself is the resource): `create` forwards to `provider.create`
 * (each node gets its own in-place LocalSandbox, the per-node `dispose` no-op being the only teardown),
 * and the run-level `dispose` is a no-op. Same shape the runner synthesizes for a provider WITHOUT
 * `openRun`; making it explicit documents the in-place run model on the provider itself.
 */
class LocalRunScope implements RunScope {
  readonly root: string;
  constructor(private readonly provider: LocalSandboxProvider, repoRoot: string) {
    this.root = repoRoot;
  }
  create(opts: CreateOpts): Promise<Sandbox> {
    return this.provider.create(opts); // inherits the provider's enforceReadScope policy
  }
  async dispose(): Promise<void> {
    /* no shared resource — the filesystem IS the resource; per-node dispose (a no-op) is the teardown. */
  }
}

export class LocalSandboxProvider implements SandboxProvider {
  readonly kind: SandboxProviderKind = 'local';

  /**
   * SECURE BY DEFAULT (true): every node's exec is wrapped in the read-scope jail (darwin), so the
   * in-place run reads ONLY its declared scope + toolchain. Construct with `{ enforceReadScope: false }`
   * for the `danger-full-access` escape hatch (the agent can read the whole filesystem). Public + readonly
   * so a caller/test can assert which posture a CLI flag selected.
   */
  readonly enforceReadScope: boolean;

  constructor(opts: { enforceReadScope?: boolean } = {}) {
    this.enforceReadScope = opts.enforceReadScope ?? true;
  }

  create(opts: CreateOpts): Promise<Sandbox> {
    return LocalSandbox.create(opts, { enforceReadScope: this.enforceReadScope });
  }

  /**
   * Run-level isolation. There is no shared resource to stand up — the run executes in-place — so this
   * returns a trivial `RunScope` rooted at `repoRoot` whose `create` forwards to `create` and whose
   * `dispose` is a no-op. (A provider could OMIT openRun and let the runner synthesize the same scope;
   * we implement it so the in-place model is the provider's documented behavior, with `root === repoRoot`.)
   */
  async openRun(opts: OpenRunOpts): Promise<RunScope> {
    return new LocalRunScope(this, path.resolve(opts.repoRoot));
  }
}
