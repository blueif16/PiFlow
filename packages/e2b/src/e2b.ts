// ─────────────────────────────────────────────────────────────────────────────
// E2bSandbox / E2bSandboxProvider — the OPEN-EGRESS CLOUD backend, LIVE-WIRED VIA AN ADAPTER.
//
// Mirrors `@piflow/core`'s `daytona.ts` method-for-method. This file is dependency-FREE on
// purpose: it imports only node builtins + TYPES from `@piflow/core`, and talks to E2B through a
// small dependency-inversion seam (`interface E2bSdk` + E2bVm/E2bFs/E2bProcess/E2bCommandHandle
// and the response types). The REAL `e2b` SDK is mapped onto that seam by `realE2bSdk()` in
// `./e2b-sdk.ts` (the ONLY file that imports the SDK); the convenience factory `createE2bProvider()`
// lives there too. This keeps the provider unit-testable with a FAKE SDK — see
// `test/sandbox-e2b-parity.test.ts`, which drives this exact provider against a real-fs-backed fake
// and proves the full lifecycle + the run-scoped one-VM-many-nodes path + streaming + cancel.
//
// The seam is GROUNDED against the live `e2b@^2.0.1` signatures (Context7 js-sdk reference v2.0.1 +
// the e2b-dev/e2b source). The real names it mirrors:
//   `Sandbox.create({ template?, env?, timeoutMs?, network? })` → `Sandbox` (object form; `template`
//     is also acceptable as a positional first arg). NOTE: create-time env is `env`; PER-COMMAND env
//     is `envs` — the seam keeps the names distinct.
//   `sandbox.files.write(path, data)` (single) / `write([{ path, data }])` (NATIVE BULK array),
//   `sandbox.files.read(path, { format: 'bytes' }) → Uint8Array`,
//   `sandbox.files.list(path, { depth }) → EntryInfo[]` (NATIVE recursive enumerate; filter
//     `EntryInfo.type === 'file'`),
//   `sandbox.commands.run(cmd, { cwd, envs, timeoutMs, onStdout, onStderr })` → `CommandResult`
//     `{ stdout, stderr, exitCode }` (streaming via the callbacks); and the BACKGROUND form
//     `commands.run(cmd, { background: true, ... }) → CommandHandle { pid, wait(), kill() }`.
//   `sandbox.kill()` → void (destroy the VM).
// Where the live API diverges from the Sandbox/ExecOpts contract, the gap is documented inline
// (search "SEAM FRICTION") — not papered over. The two real divergences:
//   • `commands.run`/`handle.wait()` THROW `CommandExitError` on a NON-ZERO exit code — so exec
//     wraps every call and reads the exit code OFF the error (it carries `{ exitCode, stdout, stderr }`),
//     turning a thrown nonzero into a normal `ExecResult`. (Daytona had no such throw.)
//   • No `AbortSignal` on `commands.run` — cancel is `handle.kill()` on the background handle.
// ─────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  Sandbox,
  SandboxProvider,
  SandboxProviderKind,
  CreateOpts,
  ExecOpts,
  ExecResult,
  RunScope,
  OpenRunOpts,
} from '@piflow/core';

// ── the SDK seam (the subset of `e2b` this file calls) ─────────────────────────
// A dependency-inversion adapter: these interfaces are the SMALLEST shape that typechecks against how
// this file uses the SDK, and they mirror the real `e2b@^2.0.1` names so `realE2bSdk()` (in
// ./e2b-sdk.ts) maps the live client onto them 1:1. They are EXPORTED so the adapter and the parity
// test can name them. Grounded in the Context7 js-sdk v2.0.1 reference.

/**
 * Mirrors `Sandbox.create({...})` params — the `SandboxOpts` subset we set. NOTE the field name:
 * create-time env is `env` (NOT `envs`; `envs` is the PER-COMMAND field, see {@link E2bRunOpts}).
 */
export interface E2bCreateParams {
  /** Pre-built E2B template name/ID to boot from (real `SandboxOpts.template`); `e2b template build` makes it. */
  template?: string;
  /** Per-VM environment baked at create time (real field: `env`). */
  env?: Record<string, string>;
  /** Sandbox auto-kill timeout in MILLISECONDS (real `SandboxOpts.timeoutMs`). */
  timeoutMs?: number;
  /**
   * Egress policy (real `SandboxOpts.network` → `{ allowOut?, denyOut? }`). E2B defaults to OPEN egress
   * (`allowInternetAccess: true`) — the WHY for this backend — so this is normally omitted; a host that
   * wants a per-sandbox allow/deny list passes selectors here (allow wins). Kept opaque (the selector
   * shape is E2B's; the seam never constructs one).
   */
  network?: unknown;
}

/** Mirrors `commands.run(...)` per-call options we set. NOTE: per-command env is `envs` (plural). */
export interface E2bRunOpts {
  /** Working directory for the command (real `CommandStartOpts.cwd`). */
  cwd?: string;
  /** Per-command environment (real `CommandStartOpts.envs` — plural, distinct from create-time `env`). */
  envs?: Record<string, string>;
  /** Per-command timeout in MILLISECONDS (real `CommandStartOpts.timeoutMs`). */
  timeoutMs?: number;
  /** Streaming stdout callback (real `CommandStartOpts.onStdout`). */
  onStdout?: (chunk: string) => void;
  /** Streaming stderr callback (real `CommandStartOpts.onStderr`). */
  onStderr?: (chunk: string) => void;
}

/**
 * Mirrors a finished `commands.run(...)` result (`CommandResult`). `exitCode` is the field name (NOT
 * `code`). The real SDK THROWS `CommandExitError` (which structurally IS a CommandResult) on a
 * non-zero exit — the adapter normalizes both the resolved value and the thrown error to this shape.
 */
export interface E2bExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Mirrors a backgrounded command handle (`CommandHandle`). `wait()` resolves the result on a 0 exit
 * and (in the real SDK) THROWS `CommandExitError` on non-zero — the adapter catches and normalizes
 * that to a resolved `E2bExecResult` so this seam NEVER throws on a nonzero exit. `kill()` terminates
 * the running command (used to honor `ExecOpts.signal`).
 */
export interface E2bCommandHandle {
  /** Process id of the background command. */
  readonly pid: number;
  /** Wait for completion; resolves the normalized result (never throws on a nonzero exit — see above). */
  wait(): Promise<E2bExecResult>;
  /** Best-effort SIGKILL of the running command (real `CommandHandle.kill() → Promise<void>`). */
  kill(): Promise<void>;
}

/** Mirrors one entry from `files.list(...)` (`EntryInfo`). `isDir` is the normalized `type === 'dir'`. */
export interface E2bEntry {
  /** Absolute in-VM path of the entry (real `EntryInfo.path`). */
  path: string;
  /** True when the entry is a directory (real `EntryInfo.type === FileType.DIR`). */
  isDir: boolean;
}

/** Mirrors `sandbox.files` — the filesystem facet of an E2B sandbox. */
export interface E2bFs {
  /** Write bytes to `remotePath` inside the VM (real `files.write(path, data)` — creates parent dirs). */
  write(remotePath: string, data: Uint8Array | string): Promise<void>;
  /**
   * NATIVE BULK write (real `files.write(WriteEntry[])`) — better than Daytona, which had no bulk form.
   * Each entry is `{ path, data }`; parent dirs are created.
   */
  writeMany(files: { path: string; data: Uint8Array | string }[]): Promise<void>;
  /** Read `remotePath` from the VM as bytes (real `files.read(path, { format: 'bytes' }) → Uint8Array`). */
  read(remotePath: string): Promise<Uint8Array>;
  /**
   * Recursively enumerate entries under `root` (real `files.list(path, { depth }) → EntryInfo[]`).
   * The `depth` is large enough to cover a node's output subtree; entries carry `isDir` so the caller
   * keeps only files. Returns [] when `root` is absent (a node that produced nothing).
   */
  list(root: string): Promise<E2bEntry[]>;
  /** mkdir -p inside the VM (real `files.makeDir(path)`). */
  makeDir(remotePath: string): Promise<void>;
}

/** Mirrors `sandbox.commands` — the command facet of an E2B sandbox. */
export interface E2bProcess {
  /**
   * Buffered exec. Real `commands.run(cmd, { cwd, envs, timeoutMs }) → CommandResult`. The adapter
   * NORMALIZES the `CommandExitError` the real SDK throws on a non-zero exit into a resolved result,
   * so this seam returns `{ stdout, stderr, exitCode }` for ANY exit code and never throws on nonzero.
   */
  run(cmd: string, opts?: E2bRunOpts): Promise<E2bExecResult>;
  /**
   * STREAMING + BACKGROUND exec. Real `commands.run(cmd, { background: true, cwd, envs, timeoutMs,
   * onStdout, onStderr }) → CommandHandle`. Callbacks fire per chunk in real time (feeding the runner's
   * stall detector); `handle.wait()` gives the real exit code; `handle.kill()` cancels. This is E2B's
   * answer to the streaming+cancel contract — and it is SIMPLER than Daytona (a real exit code from
   * `wait()`, no completion-poll loop, no "follow-socket never resolves" trap).
   */
  runBackground(cmd: string, opts?: E2bRunOpts): Promise<E2bCommandHandle>;
}

/** Mirrors a live E2B sandbox handle (`Sandbox.create(...)` result). */
export interface E2bVm {
  /** Stable id the SDK assigns (used for labels/logging; real `sandbox.sandboxId`). */
  readonly id: string;
  files: E2bFs;
  commands: E2bProcess;
  /** Destroy this VM (real instance `sandbox.kill() → Promise<void>`). */
  kill(): Promise<void>;
}

/** Mirrors the `e2b` SDK entry point. The real one is `Sandbox.create` (a static factory). */
export interface E2bSdk {
  /** Boot ONE cloud VM (real `Sandbox.create(opts)`). */
  create(params?: E2bCreateParams): Promise<E2bVm>;
}

// ── helpers ────────────────────────────────────────────────────────────────────

/** Decode the SDK's `Uint8Array` payloads; honor the seam's `{ encoding: 'utf8' }` opt. */
function decode(data: Uint8Array, encoding?: 'utf8'): Uint8Array | string {
  return encoding === 'utf8' ? Buffer.from(data).toString('utf8') : data;
}

/** Coerce the seam's `Uint8Array | string` write payload to the bytes the SDK writes. */
function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

// ── the per-node sandbox VIEW (NOT a VM — a view into the shared run VM) ─────────

/**
 * One node's view INSIDE the shared run VM. Each node gets its own `E2bSandbox`, but they all delegate
 * to the SAME `E2bVm` (the per-run resource booted in `openRun`). The node's files live under a
 * per-node subtree (`<rootDir>/<workdir>`) of the one VM's filesystem, so concurrent lanes in a stage
 * don't collide. `dispose()` on this view is a NO-OP w.r.t. the VM — the VM is torn down ONCE by
 * `RunScope.dispose`. (In the non-scoped `provider.create` path the view OWNS a throwaway VM and
 * `dispose` DOES kill it; that's the `ownsVm` flag below.) Mirrors `DaytonaSandbox`.
 */
export class E2bSandbox implements Sandbox {
  readonly kind = 'e2b' as const;

  private constructor(
    /** The shared (or throwaway) VM this view executes inside. */
    private readonly vm: E2bVm,
    /** Absolute-in-VM root for THIS node (the per-node subtree of the shared VM). */
    private readonly workdir: string,
    /** The node's output dir, relative to `workdir` (collected by `downloadDir`). */
    private readonly outputDir: string,
    private readonly env: Record<string, string>,
    /** Node wall-clock cap → E2B's per-command `timeoutMs` (already ms — no seconds conversion). */
    private readonly timeoutMs: number | undefined,
    /** True only for the non-scoped `provider.create` path: `dispose` kills the VM. */
    private readonly ownsVm: boolean,
  ) {}

  /**
   * Build a per-node view. `makeDir` materializes the node's subtree + output dir in the VM so a
   * relative write/exec resolves the same way it does locally (mirrors `DaytonaSandbox.open`).
   */
  static async open(
    vm: E2bVm,
    opts: CreateOpts,
    rootDir: string,
    ownsVm: boolean,
  ): Promise<E2bSandbox> {
    const workdir = path.posix.join(rootDir, opts.workdir || '.');
    const outputDir = opts.outputDir || 'out';
    await vm.files.makeDir(workdir);
    await vm.files.makeDir(path.posix.join(workdir, outputDir));
    return new E2bSandbox(vm, workdir, outputDir, opts.env ?? {}, opts.timeoutMs, ownsVm);
  }

  /** Resolve an in-sandbox path (relative → under this node's workdir; absolute kept as-is). */
  private abs(p: string): string {
    return path.posix.isAbsolute(p) ? p : path.posix.join(this.workdir, p);
  }

  /** Stage files into the VM. Uses E2B's NATIVE bulk `writeMany` (one round-trip), unlike Daytona's loop. */
  async putFiles(files: { path: string; data: Uint8Array | string }[]): Promise<void> {
    if (files.length === 0) return;
    await this.vm.files.writeMany(files.map((f) => ({ path: this.abs(f.path), data: f.data })));
  }

  async writeFile(p: string, data: Uint8Array | string): Promise<void> {
    // files.write creates parent dirs, so no explicit mkdir is needed (unlike Daytona's uploadFile).
    await this.vm.files.write(this.abs(p), data);
  }

  /**
   * Run a command in the shared VM. The seam's ExecOpts asks for streaming `onStdout`/`onStderr`,
   * `signal` cancellation, and a buffered `{stdout, stderr, code}` return — E2B gives all three cleanly:
   *
   * - Streaming OR a signal → the BACKGROUND path (`runBackground` + `handle.wait()`/`handle.kill()`).
   *   `wait()` returns the real exit code (no poll loop, no socket trap — the Daytona pain points are
   *   gone), and `kill()` on abort is a real per-command SIGKILL.
   * - Otherwise → the simple buffered `run`.
   *
   * Both backends report a faithful, SEPARATE stdout and stderr (E2B's `CommandResult` splits them) —
   * so unlike Daytona, stderr is NOT collapsed into stdout.
   */
  exec(cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const cwd = opts.cwd ? this.abs(opts.cwd) : this.workdir;
    const envs = { ...this.env, ...opts.env };
    const streaming = Boolean(opts.onStdout || opts.onStderr);
    const wantsCancel = Boolean(opts.signal);

    if (streaming || wantsCancel) return this.execBackground(cmd, cwd, envs, opts);
    return this.execBuffered(cmd, cwd, envs);
  }

  /** Buffered exec — the simple path. `commands.run(cmd, { cwd, envs, timeoutMs })`. */
  private async execBuffered(
    cmd: string,
    cwd: string,
    envs: Record<string, string>,
  ): Promise<ExecResult> {
    // The adapter normalizes the `CommandExitError` thrown on a nonzero exit into a resolved result,
    // so a nonzero exit code arrives here as a plain `{ stdout, stderr, exitCode }` — not a throw.
    const res = await this.vm.commands.run(cmd, { cwd, envs, timeoutMs: this.timeoutMs });
    return { stdout: res.stdout, stderr: res.stderr, code: res.exitCode };
  }

  /**
   * Streaming + cancellable exec via a BACKGROUND command. The callbacks fire per chunk in real time
   * (so the runner's stall detector keeps seeing output); `handle.wait()` gives the real exit code.
   *
   * Cancel (SEAM FRICTION): the seam's `signal` doc demands a SIGTERM→SIGKILL process-GROUP kill;
   * E2B's `handle.kill()` is a SIGKILL of the command process (no documented group/soft-then-hard
   * sequence). On abort we call `handle.kill()` and return 124 (the runner kill convention); the
   * runner's killGrace liveness fallback backstops it, exactly as it does for Daytona's soft cancel.
   * (E2B's `kill()` is still a real per-command interrupt — strictly better than Daytona's
   * tear-down-the-whole-session cancel.)
   *
   * We ALSO accumulate the streamed bytes into local buffers (the callbacks own them, but ExecResult
   * needs a faithful stdout/stderr) — and `wait()` returns the full result too, so we prefer its
   * buffers when present.
   */
  private async execBackground(
    cmd: string,
    cwd: string,
    envs: Record<string, string>,
    opts: ExecOpts,
  ): Promise<ExecResult> {
    let stdout = '';
    let stderr = '';
    const onStdout = (chunk: string): void => { stdout += chunk; opts.onStdout?.(chunk); };
    const onStderr = (chunk: string): void => { stderr += chunk; opts.onStderr?.(chunk); };

    let aborted = false;
    const handle = await this.vm.commands.runBackground(cmd, {
      cwd,
      envs,
      timeoutMs: this.timeoutMs,
      onStdout,
      onStderr,
    });

    const onAbort = (): void => {
      aborted = true;
      // Best-effort SIGKILL of the running command (the closest E2B offers to the seam's group kill).
      void handle.kill().catch(() => { /* already gone */ });
    };
    const signal = opts.signal;
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      // wait() is normalized by the adapter to NEVER throw on a nonzero exit — it resolves the result.
      const res = await handle.wait();
      // Prefer the result's buffers (the full output); fall back to the streamed accumulation.
      return {
        stdout: res.stdout || stdout,
        stderr: res.stderr || stderr,
        code: aborted ? 124 : res.exitCode,
      };
    } catch (err) {
      // A non-exit-code failure (transport/kill race) — surface what we streamed, with the kill code.
      return { stdout, stderr: stderr || String(err), code: aborted ? 124 : 1 };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async readFile(p: string, opts: { encoding?: 'utf8' } = {}): Promise<Uint8Array | string> {
    const bytes = await this.vm.files.read(this.abs(p));
    return decode(bytes, opts.encoding);
  }

  /**
   * Collect an output dir back to the host. The seam's portable contract: copy `<remote>` (in-VM) to
   * `<local>` (on the host run dir). E2B has a NATIVE recursive `files.list(root, { depth })` (cleaner
   * than Daytona's name-glob `searchFiles`), so we enumerate, keep only files (entries carry `isDir`),
   * read each, and re-root onto the host. SEAM FRICTION (same as Daytona): at scale this is N
   * round-trips — a tar-on-VM-then-single-read would be the production shape.
   */
  async downloadDir(remote: string, local: string): Promise<void> {
    const remoteRoot = this.abs(remote);
    const localRoot = path.resolve(process.cwd(), local);
    const entries = await this.vm.files.list(remoteRoot);
    for (const entry of entries) {
      if (entry.isDir) continue; // dirs are recreated implicitly by the file writes below
      const rel = path.posix.relative(remoteRoot, entry.path);
      if (!rel || rel.startsWith('..')) continue; // defensive: skip anything outside the root
      const dest = path.resolve(localRoot, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const bytes = await this.vm.files.read(entry.path);
      await fs.writeFile(dest, bytes);
    }
  }

  /**
   * Per-node teardown. CRITICAL to the seam: in the RUN-SCOPED path this is a NO-OP — the shared VM
   * outlives every node and is killed ONCE by `E2bRunScope.dispose`. Only the non-scoped
   * `provider.create` path (`ownsVm === true`) kills the throwaway VM here.
   */
  async dispose(): Promise<void> {
    if (this.ownsVm) {
      await this.vm.kill();
    }
    // else: run-scoped view — do NOT touch the shared VM. RunScope.dispose owns its lifetime.
  }
}

// ── the run scope: ONE VM for the whole run; per-node views inside it ─────────────

/**
 * The per-run resource lifecycle the seam exists for. Holds the ONE VM booted in `openRun`; `create`
 * makes per-node `E2bSandbox` views inside it; `dispose` DESTROYS the VM exactly once after the last
 * node. Mirrors `DaytonaRunScope`. (E2B sandboxes are long-lived and accept concurrent
 * `commands.run`, so one VM serving every node — including parallel lanes — is the native shape.)
 */
class E2bRunScope implements RunScope {
  /** The in-VM root all nodes live under (the run's filesystem-as-contract namespace). */
  readonly root: string;

  constructor(
    private readonly vm: E2bVm,
    private readonly opts: OpenRunOpts,
    /** In-VM base dir for this run, e.g. `/home/user/pi/<run>`. */
    rootDir: string,
  ) {
    this.root = rootDir;
  }

  /**
   * Make one node's sandbox view INSIDE the shared VM. `ownsVm:false` is the load-bearing argument —
   * it guarantees the per-node `dispose` does NOT destroy the shared VM.
   */
  create(opts: CreateOpts): Promise<Sandbox> {
    return E2bSandbox.open(this.vm, opts, this.root, /* ownsVm */ false);
  }

  /**
   * Run-level teardown: destroy the ONE VM. Best-effort per the seam — a teardown throw must not mask
   * the run verdict (the runner wraps this in try/catch), but we MUST attempt the kill or the VM leaks
   * (billed until its create-time `timeoutMs` auto-kill fires).
   */
  async dispose(): Promise<void> {
    await this.vm.kill();
  }
}

// ── the provider ─────────────────────────────────────────────────────────────────

/**
 * The E2B cloud provider. Implements BOTH lifecycles (mirrors `DaytonaSandboxProvider`):
 *   - `openRun` (the run-scoped path): boot ONE VM, return an `E2bRunScope`.
 *   - `create` (the non-scoped fallback, parity with inmemory/seatbelt): boot a THROWAWAY VM for one
 *     node and hand back a view that OWNS it (so its `dispose` destroys it).
 *
 * The constructor takes an `E2bSdk` seam (the real client is mapped on via `realE2bSdk()` in
 * `./e2b-sdk.ts`; `createE2bProvider()` is the convenience factory) so the file is dependency-free and
 * unit-testable with a fake SDK.
 */
export class E2bSandboxProvider implements SandboxProvider {
  readonly kind: SandboxProviderKind = 'e2b';

  constructor(
    private readonly sdk: E2bSdk,
    /**
     * Run-level VM defaults the per-node CreateOpts can't carry. OpenRunOpts has no template/network/
     * timeout, so these come from provider construction (env/config) instead — mirrors Daytona's
     * `vmDefaults`.
     */
    private readonly vmDefaults: {
      /** Pre-built E2B template name/ID to boot from (our promoted node-runtime; `e2b template build`). */
      template?: string;
      /** VM auto-kill timeout in MILLISECONDS (so a crashed run can't leak a billed VM). */
      timeoutMs?: number;
      /** Egress policy (omit ⇒ E2B's OPEN-by-default egress — the WHY for this backend). Opaque selector. */
      network?: unknown;
      /** In-VM home the run dir nests under (E2B's default user home `/home/user`). */
      homeDir?: string;
      /**
       * Run-level files staged into the VM home BEFORE any node runs, keyed by home-relative path →
       * content. The load-bearing case is `'.pi/agent/models.json'`: a CUSTOM gateway (`--provider
       * nebius`/`mmgw`) is defined ONLY in the host's `~/.pi/agent/models.json`, which the image does NOT
       * bake — so pi in the VM cannot resolve `--provider <gw>` without it. The staged config carries
       * `$VAR` apiKey REFERENCES (pi's value syntax), never literal secrets; the actual key crosses
       * separately via the cloud cred allowlist (`runner.ts` `cloudCredEnvAdditions`). Mirrors Daytona.
       */
      stageHome?: Record<string, string>;
    } = {},
  ) {}

  /** Default in-VM home for E2B sandboxes (the `user` account home). */
  private get home(): string {
    return this.vmDefaults.homeDir ?? '/home/user';
  }

  /** The create params shared by both lifecycles, derived from `vmDefaults`. */
  private createParams(): E2bCreateParams {
    return {
      ...(this.vmDefaults.template !== undefined ? { template: this.vmDefaults.template } : {}),
      ...(this.vmDefaults.timeoutMs !== undefined ? { timeoutMs: this.vmDefaults.timeoutMs } : {}),
      ...(this.vmDefaults.network !== undefined ? { network: this.vmDefaults.network } : {}),
    };
  }

  /**
   * Write each run-level home file into the booted VM at `<home>/<relPath>`. Idempotent-safe
   * (files.write overwrites + creates parent dirs). No-op when nothing is declared. Mirrors Daytona's
   * `stageHomeFiles`.
   */
  private async stageHomeFiles(vm: E2bVm): Promise<void> {
    const files = this.vmDefaults.stageHome;
    if (!files) return;
    const entries = Object.entries(files).map(([rel, content]) => ({
      path: path.posix.join(this.home, rel),
      data: toBytes(content),
    }));
    if (entries.length) await vm.files.writeMany(entries);
  }

  /** Boot ONE VM for the whole run and return a scope whose per-node views live inside it. */
  async openRun(opts: OpenRunOpts): Promise<RunScope> {
    // Per-node CreateOpts.env/timeoutMs are PER-NODE (applied later, at exec); the VM's template/
    // network/timeout come from `vmDefaults`. The run id is baked as a create-time env var for
    // traceability (mirrors Daytona's `envVars: { PI_RUN }`).
    const vm = await this.sdk.create({
      ...this.createParams(),
      env: { PI_RUN: opts.run },
    });
    // The run's in-VM root: nest under the VM home so node subtrees are siblings (a worktree analogue).
    const rootDir = path.posix.join(this.home, 'pi', opts.run);
    await vm.files.makeDir(rootDir);
    // Stage run-level home files (e.g. the pi provider config) ONCE, before any node.
    await this.stageHomeFiles(vm);
    return new E2bRunScope(vm, opts, rootDir);
  }

  /**
   * Non-scoped fallback: one throwaway VM for a single node. The returned view OWNS the VM, so the
   * runner's per-node `dispose` destroys it (no RunScope teardown in this path).
   */
  async create(opts: CreateOpts): Promise<Sandbox> {
    const vm = await this.sdk.create({
      ...this.createParams(),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
    // Stage run-level home files into the throwaway VM too (parity with the openRun path).
    await this.stageHomeFiles(vm);
    return E2bSandbox.open(vm, opts, this.home, /* ownsVm */ true);
  }
}
