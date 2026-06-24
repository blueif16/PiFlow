// ─────────────────────────────────────────────────────────────────────────────
// DRAFT — DaytonaSandbox / DaytonaSandboxProvider (the CLOUD backend).
//
// THIS IS AN UNCOMPILED-AGAINST-LIVE-SDK DRAFT, written to VALIDATE the run-scope
// seam (types.ts: Sandbox / SandboxProvider / RunScope / OpenRunOpts) against a
// real cloud provider. It is NOT wired: it is not exported from index.ts and not
// registered anywhere. `@daytonaio/sdk` is NOT a dependency of this package, so
// every SDK touch-point is expressed against a minimal LOCAL `interface DaytonaSdk`
// (the subset this file actually calls) and tagged `// DRAFT:`. To make it live:
//   1. `npm i @daytonaio/sdk`, 2. delete the local interfaces below, 3. import the
//   real `Daytona` class, 4. pass `new Daytona({ apiKey })` where this file takes a
//   `DaytonaSdk`, 5. re-check each `// DRAFT:` site against the live signatures.
//
// SDK shapes were grounded via Context7 (/daytonaio/daytona) on 2026-06-21. The
// real names this draft mirrors: `daytona.create({image, envVars, resources, ...})`,
// `sandbox.fs.uploadFile/downloadFile/createFolder/findFiles`,
// `sandbox.process.executeCommand(cmd, cwd?, env?, timeoutSec?)` → {exitCode,result},
// `sandbox.process.createSession / executeSessionCommand({command,runAsync}) /
// getSessionCommandLogs(id, cmdId, onStdout, onStderr)`, `daytona.delete(sandbox)`.
// Where the live API diverges from the seam, the gap is documented inline AND in the
// accompanying seam-friction report (see the return message), not papered over.
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
} from '../types.js';

// ── minimal local SDK surface (the subset this file calls) ─────────────────────
// DRAFT: replace this whole block with `import { Daytona } from '@daytonaio/sdk'`.
// These interfaces are deliberately the SMALLEST shape that typechecks against how
// this file uses the SDK — they mirror the real names so the swap is mechanical.

/** DRAFT: mirrors `daytona.create({...})` params (image/envVars/resources/autoStop). */
interface DaytonaCreateParams {
  /** Container image ref (real SDK also accepts an `Image` builder or a `snapshot`). */
  image?: string;
  /** Per-VM environment. The real field name is `envVars`. */
  envVars?: Record<string, string>;
  /** VM sizing — the real SDK shape is `{ cpu, memory, disk }`. */
  resources?: { cpu?: number; memory?: number; disk?: number };
  /** Idle auto-stop guard (minutes) so a crashed run can't leak a billed VM forever. */
  autoStopInterval?: number;
}

/** DRAFT: mirrors `sandbox.process.executeCommand(...)` return. ONE combined `result`. */
interface DaytonaExecResponse {
  exitCode: number;
  /** Combined stdout+stderr — the real SDK returns a single `result` string. */
  result: string;
}

/** DRAFT: mirrors `executeSessionCommand(...)` return — a handle to a backgrounded cmd. */
interface DaytonaSessionCommand {
  cmdId?: string;
}

/** DRAFT: mirrors `getSessionCommandLogs(...)` buffered return. */
interface DaytonaSessionLogs {
  stdout: string;
  stderr: string;
}

/** DRAFT: mirrors `sandbox.fs` — the filesystem facet of a Daytona sandbox. */
interface DaytonaFs {
  /** Upload bytes to `remotePath` inside the VM. Real: `uploadFile(file: Buffer, remotePath)`. */
  uploadFile(data: Uint8Array, remotePath: string): Promise<void>;
  /** Download `remotePath` from the VM as bytes. Real: `downloadFile(remotePath) => Buffer`. */
  downloadFile(remotePath: string): Promise<Uint8Array>;
  /** mkdir -p inside the VM. Real: `createFolder(path, mode)`. */
  createFolder(remotePath: string, mode?: string): Promise<void>;
  /** Recursively list files under `root` matching `pattern`. Real: `findFiles(root, pattern)`. */
  findFiles(root: string, pattern: string): Promise<{ file: string }[]>;
}

/** DRAFT: mirrors `sandbox.process` — the command facet of a Daytona sandbox. */
interface DaytonaProcess {
  /**
   * Buffered exec. Real signature is POSITIONAL: `executeCommand(command, cwd?, env?, timeoutSec?)`.
   * NOTE: no AbortSignal, no streaming callbacks, timeout is in SECONDS. See report §(e).
   */
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeoutSec?: number,
  ): Promise<DaytonaExecResponse>;
  /** Open a long-lived shell session (the streaming/async exec path). */
  createSession(sessionId: string): Promise<void>;
  /** Start a command in a session; `runAsync:true` returns immediately with a `cmdId`. */
  executeSessionCommand(
    sessionId: string,
    req: { command: string; runAsync?: boolean },
  ): Promise<DaytonaSessionCommand>;
  /**
   * Stream (or, with no callbacks, buffer-and-return) a session command's logs. The streaming
   * form invokes `onStdout`/`onStderr` and resolves when the command ENDS — this draft uses it
   * as the cancellable, streaming exec path. See report §(e).
   */
  getSessionCommandLogs(
    sessionId: string,
    cmdId: string,
    onStdout?: (chunk: string) => void,
    onStderr?: (chunk: string) => void,
  ): Promise<DaytonaSessionLogs>;
  /** Best-effort interrupt of a running session command (used to honor ExecOpts.signal). */
  deleteSession(sessionId: string): Promise<void>;
}

/** DRAFT: mirrors a live Daytona sandbox/VM handle (`daytona.create(...)` result). */
interface DaytonaVm {
  /** Stable id the SDK assigns (used for labels/logging). */
  readonly id: string;
  fs: DaytonaFs;
  process: DaytonaProcess;
}

/** DRAFT: mirrors the `Daytona` client. Construct with `new Daytona({ apiKey })`. */
interface DaytonaSdk {
  /** Boot ONE cloud VM. */
  create(params?: DaytonaCreateParams): Promise<DaytonaVm>;
  /** Destroy a VM. Real API exposes both `daytona.delete(vm)` and `vm.delete()`. */
  delete(vm: DaytonaVm): Promise<void>;
}

// ── helpers ────────────────────────────────────────────────────────────────────

/** Decode the SDK's `Uint8Array` payloads; honor the seam's `{ encoding: 'utf8' }` opt. */
function decode(data: Uint8Array, encoding?: 'utf8'): Uint8Array | string {
  return encoding === 'utf8' ? Buffer.from(data).toString('utf8') : data;
}

/** Coerce the seam's `Uint8Array | string` write payload to the bytes the SDK uploads. */
function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

/** A monotonically-unique session id per exec (Daytona sessions are per-shell, not per-cmd). */
let sessionSeq = 0;

// ── the per-node sandbox VIEW (NOT a VM — a view into the shared run VM) ─────────

/**
 * One node's view INSIDE the shared run VM. Each node gets its own `DaytonaSandbox`, but they all
 * delegate to the SAME `DaytonaVm` (the per-run resource booted in `openRun`). The node's files live
 * under a per-node subtree (`<rootDir>/<workdir>`) of the one VM's filesystem, so concurrent lanes in
 * a stage don't collide. `dispose()` on this view is a NO-OP w.r.t. the VM — the VM is torn down ONCE
 * by `RunScope.dispose`. (In the non-scoped `provider.create` path the view OWNS a throwaway VM and
 * `dispose` DOES destroy it; that's the `ownsVm` flag below.)
 */
export class DaytonaSandbox implements Sandbox {
  readonly kind = 'daytona' as const;

  private constructor(
    /** The shared (or throwaway) VM this view executes inside. */
    private readonly sdk: DaytonaSdk,
    private readonly vm: DaytonaVm,
    /** Absolute-in-VM root for THIS node (the per-node subtree of the shared VM). */
    private readonly workdir: string,
    /** The node's output dir, relative to `workdir` (collected by `downloadDir`). */
    private readonly outputDir: string,
    private readonly env: Record<string, string>,
    /** Node wall-clock cap → Daytona's per-command `timeoutSec`. */
    private readonly timeoutMs: number | undefined,
    /** True only for the non-scoped `provider.create` path: `dispose` destroys the VM. */
    private readonly ownsVm: boolean,
  ) {}

  /**
   * Build a per-node view. `createFolder` materializes the node's subtree + output dir in the VM so a
   * relative write/exec resolves the same way it does locally (mirrors InMemorySandbox.create's mkdir).
   */
  static async open(
    sdk: DaytonaSdk,
    vm: DaytonaVm,
    opts: CreateOpts,
    rootDir: string,
    ownsVm: boolean,
  ): Promise<DaytonaSandbox> {
    const workdir = path.posix.join(rootDir, opts.workdir || '.');
    const outputDir = opts.outputDir || 'out';
    // DRAFT: createFolder is `mkdir -p` in the VM — make the node's subtree + its output dir.
    await vm.fs.createFolder(workdir);
    await vm.fs.createFolder(path.posix.join(workdir, outputDir));
    return new DaytonaSandbox(sdk, vm, workdir, outputDir, opts.env ?? {}, opts.timeoutMs, ownsVm);
  }

  /** Resolve an in-sandbox path (relative → under this node's workdir; absolute kept as-is). */
  private abs(p: string): string {
    return path.posix.isAbsolute(p) ? p : path.posix.join(this.workdir, p);
  }

  async putFiles(files: { path: string; data: Uint8Array | string }[]): Promise<void> {
    for (const f of files) await this.writeFile(f.path, f.data);
  }

  async writeFile(p: string, data: Uint8Array | string): Promise<void> {
    const target = this.abs(p);
    // DRAFT: ensure the parent dir exists in the VM (the runner stages reads at nested rel paths).
    const dir = path.posix.dirname(target);
    if (dir && dir !== '.' && dir !== '/') await this.vm.fs.createFolder(dir);
    // DRAFT: sandbox.fs.uploadFile(Buffer, remotePath).
    await this.vm.fs.uploadFile(toBytes(data), target);
  }

  /**
   * Run a command in the shared VM. The seam's ExecOpts asks for THREE things Daytona splits across
   * two different exec APIs: (1) streaming `onStdout`/`onStderr`, (2) `signal` cancellation, (3) a
   * buffered `{stdout, stderr, code}` return.
   *
   * - If the caller wants streaming OR passes a signal → use the SESSION path (`executeSessionCommand`
   *   runAsync + `getSessionCommandLogs` with callbacks), which is the only Daytona API that streams
   *   and that we can interrupt (by tearing the session down on abort).
   * - Otherwise → the simpler buffered `executeCommand`.
   *
   * MAPPING GAPS (see report §e): Daytona returns ONE combined `result` string, so `stderr` is left
   * '' and everything lands in `stdout` (the seam explicitly allows this — see ExecResult's doc:
   * "Combined-output backends fill `stdout` and leave `stderr` ''"). And `timeoutMs` becomes a
   * SECONDS arg; sub-second precision is lost.
   */
  exec(cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const cwd = opts.cwd ? this.abs(opts.cwd) : this.workdir;
    const env = { ...this.env, ...opts.env };
    const streaming = Boolean(opts.onStdout || opts.onStderr);
    const wantsCancel = Boolean(opts.signal);

    if (streaming || wantsCancel) return this.execSession(cmd, cwd, env, opts);
    return this.execBuffered(cmd, cwd, env);
  }

  /** Buffered exec — the simple path. DRAFT: executeCommand(cmd, cwd, env, timeoutSec). */
  private async execBuffered(
    cmd: string,
    cwd: string,
    env: Record<string, string>,
  ): Promise<ExecResult> {
    const timeoutSec = this.timeoutMs ? Math.ceil(this.timeoutMs / 1000) : undefined;
    // The seam runs the command FROM the node's workdir; Daytona's executeCommand has no shell-level
    // cwd persistence across calls, so we pass cwd explicitly each time.
    const res = await this.vm.process.executeCommand(cmd, cwd, env, timeoutSec);
    // Combined-output backend: stdout carries everything, stderr stays '' (ExecResult contract).
    return { stdout: res.result, stderr: '', code: res.exitCode };
  }

  /**
   * Streaming + cancellable exec via a session. DRAFT: this is the closest Daytona offers to the
   * InMemorySandbox/Seatbelt process-group kill the seam's `signal` doc demands — but it is NOT the
   * same primitive (see report §e). On abort we tear down the SESSION, which stops the streamed
   * command; Daytona exposes no documented per-process-group SIGTERM→SIGKILL, so the runner's
   * killGrace liveness fallback (runner.ts defaultExecRunner) is what ultimately bounds a hung exec.
   */
  private async execSession(
    cmd: string,
    cwd: string,
    env: Record<string, string>,
    opts: ExecOpts,
  ): Promise<ExecResult> {
    const sessionId = `pi-${this.vm.id}-${process.pid}-${sessionSeq++}`;
    // DRAFT: Daytona sessions have no per-session cwd/env; bake them into the command line so the
    // command runs where the buffered path would. (`cd` then exec under one `sh -c`.)
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ');
    const wrapped = `cd ${JSON.stringify(cwd)} && ${envPrefix ? envPrefix + ' ' : ''}${cmd}`;

    await this.vm.process.createSession(sessionId);
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      // DRAFT: best-effort interrupt — tearing the session down stops the running command. This is a
      // SOFT cancel, not the seam's promised SIGTERM→SIGKILL process-group kill. See report §e.
      this.vm.process.deleteSession(sessionId).catch(() => { /* already gone */ });
    };
    const signal = opts.signal;
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      // DRAFT: runAsync starts the command and returns a cmdId; we then stream its logs.
      const started = await this.vm.process.executeSessionCommand(sessionId, {
        command: wrapped,
        runAsync: true,
      });
      const cmdId = started.cmdId ?? '';
      // DRAFT: streaming form — callbacks fire per chunk; resolves when the command ENDS.
      const logs = await this.vm.process.getSessionCommandLogs(
        sessionId,
        cmdId,
        opts.onStdout,
        opts.onStderr,
      );
      // NOTE: the SDK's streaming logs return does NOT carry an exit code (see report §e). We can't
      // know the real code without a second `executeCommand 'echo $?'`, which a torn-down/aborted
      // session can't answer — so an aborted exec reports 124 (matching the runner's kill convention)
      // and a clean finish reports 0. A production impl would poll session-command status for the code.
      const code = aborted ? 124 : 0;
      return { stdout: logs.stdout, stderr: logs.stderr, code };
    } catch (err) {
      return { stdout: '', stderr: String(err), code: aborted ? 124 : 1 };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!aborted) {
        // DRAFT: clean up the session (the abort path already deleted it).
        await this.vm.process.deleteSession(sessionId).catch(() => { /* already gone */ });
      }
    }
  }

  async readFile(p: string, opts: { encoding?: 'utf8' } = {}): Promise<Uint8Array | string> {
    // DRAFT: sandbox.fs.downloadFile(remotePath) => bytes.
    const bytes = await this.vm.fs.downloadFile(this.abs(p));
    return decode(bytes, opts.encoding);
  }

  /**
   * Collect an output dir back to the host. The seam's portable contract: copy `<remote>` (in-VM) to
   * `<local>` (on the host run dir). Daytona has no "download a whole folder" call, so we enumerate
   * with `findFiles` and `downloadFile` each, re-rooting onto the host. DRAFT: at scale this is N
   * round-trips (see report §f) — a tar-on-VM-then-single-download would be the production shape.
   */
  async downloadDir(remote: string, local: string): Promise<void> {
    const remoteRoot = this.abs(remote);
    const localRoot = path.resolve(process.cwd(), local);
    // DRAFT: findFiles(root, '*') → every file under the output dir.
    const found = await this.vm.fs.findFiles(remoteRoot, '*');
    for (const { file } of found) {
      // Re-root each in-VM path under the host `local` dir, preserving the subtree.
      const rel = path.posix.relative(remoteRoot, file);
      if (!rel || rel.startsWith('..')) continue; // defensive: skip anything outside the root
      const dest = path.resolve(localRoot, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const bytes = await this.vm.fs.downloadFile(file);
      await fs.writeFile(dest, bytes);
    }
  }

  /**
   * Per-node teardown. CRITICAL to the seam: in the RUN-SCOPED path this is a NO-OP — the shared VM
   * outlives every node and is destroyed ONCE by `DaytonaRunScope.dispose`. Only the non-scoped
   * `provider.create` path (`ownsVm === true`) destroys the throwaway VM here.
   */
  async dispose(): Promise<void> {
    if (this.ownsVm) {
      // DRAFT: daytona.delete(vm) — only when THIS view owns a throwaway VM (non-scoped path).
      await this.sdk.delete(this.vm);
    }
    // else: run-scoped view — do NOT touch the shared VM. RunScope.dispose owns its lifetime.
  }
}

// ── the run scope: ONE VM for the whole run; per-node views inside it ─────────────

/**
 * The per-run resource lifecycle the seam exists for. Holds the ONE VM booted in `openRun`; `create`
 * makes per-node `DaytonaSandbox` views inside it; `dispose` collects (best-effort) and DESTROYS the
 * VM exactly once after the last node.
 */
class DaytonaRunScope implements RunScope {
  /** The in-VM root all nodes live under (the run's filesystem-as-contract namespace). */
  readonly root: string;

  constructor(
    private readonly sdk: DaytonaSdk,
    private readonly vm: DaytonaVm,
    private readonly opts: OpenRunOpts,
    /** In-VM base dir for this run, e.g. `/home/daytona/pi/<run>`. */
    rootDir: string,
  ) {
    this.root = rootDir;
  }

  /**
   * Make one node's sandbox view INSIDE the shared VM. `ownsVm:false` is the load-bearing argument —
   * it guarantees the per-node `dispose` (runner.ts runNode finally) does NOT destroy the shared VM.
   */
  create(opts: CreateOpts): Promise<Sandbox> {
    return DaytonaSandbox.open(this.sdk, this.vm, opts, this.root, /* ownsVm */ false);
  }

  /**
   * Run-level teardown: destroy the ONE VM. (Run-level collection already happened per-node via the
   * runner's `downloadDir` after each node; a provider that batched collection would do it here.)
   * Best-effort per the seam — a teardown throw must not mask the run verdict (runner.ts wraps this
   * in try/catch), but we MUST attempt the delete or the VM leaks (billed).
   */
  async dispose(): Promise<void> {
    // DRAFT: daytona.delete(vm) — the single destroy of the per-run VM.
    await this.sdk.delete(this.vm);
  }
}

// ── the provider ─────────────────────────────────────────────────────────────────

/**
 * The Daytona cloud provider. Implements BOTH lifecycles:
 *   - `openRun` (the run-scoped path the seam was added for): boot ONE VM, return a `DaytonaRunScope`.
 *   - `create` (the non-scoped fallback, parity with inmemory/seatbelt): boot a THROWAWAY VM for one
 *     node and hand back a view that OWNS it (so its `dispose` destroys it).
 *
 * The constructor takes a `DaytonaSdk` (DRAFT: `new Daytona({ apiKey })`) so the file is dependency-
 * free and unit-testable with a fake SDK.
 */
export class DaytonaSandboxProvider implements SandboxProvider {
  readonly kind: SandboxProviderKind = 'daytona';

  constructor(
    private readonly sdk: DaytonaSdk,
    /**
     * Run-level VM defaults the per-node CreateOpts can't carry (see report §b/§c). OpenRunOpts has
     * no image/region/resources, so these come from provider construction (env/config) instead.
     */
    private readonly vmDefaults: {
      image?: string;
      resources?: { cpu?: number; memory?: number; disk?: number };
      /** Idle auto-stop guard so a crashed run can't leak a billed VM. */
      autoStopInterval?: number;
      /** In-VM home the run dir nests under (Daytona's default user home). */
      homeDir?: string;
    } = {},
  ) {}

  /** Boot ONE VM for the whole run and return a scope whose per-node views live inside it. */
  async openRun(opts: OpenRunOpts): Promise<RunScope> {
    // DRAFT: boot the per-run VM. NOTE the seam mismatch (report §c): CreateOpts.image/env/timeoutMs
    // are PER-NODE, but the VM is created HERE from OpenRunOpts (which has none of them). So the VM's
    // image/resources come from `vmDefaults` (provider config), and per-node `env`/`image` are applied
    // LATER, at the node level — `env` per `exec`, and a per-node `image` is simply UNSUPPORTED in the
    // shared-VM model (you can't reimage a running VM per node). See report §c.
    const vm = await this.sdk.create({
      image: this.vmDefaults.image,
      resources: this.vmDefaults.resources,
      autoStopInterval: this.vmDefaults.autoStopInterval,
      // The run id is the natural VM label; passed via env for traceability (OpenRunOpts.run).
      envVars: { PI_RUN: opts.run },
    });
    // The run's in-VM root: nest under the VM home so node subtrees are siblings (a worktree analogue).
    const home = this.vmDefaults.homeDir ?? '/home/daytona';
    const rootDir = path.posix.join(home, 'pi', opts.run);
    // DRAFT: createFolder the run root once so every node's create() nests cleanly.
    await vm.fs.createFolder(rootDir);
    return new DaytonaRunScope(this.sdk, vm, opts, rootDir);
  }

  /**
   * Non-scoped fallback: one throwaway VM for a single node. The returned view OWNS the VM, so the
   * runner's per-node `dispose` destroys it (no RunScope teardown in this path).
   */
  async create(opts: CreateOpts): Promise<Sandbox> {
    // DRAFT: a per-node VM CAN honor CreateOpts.image (unlike the shared-VM path) — this is the only
    // path where per-node image actually works (report §c).
    const vm = await this.sdk.create({
      image: opts.image ?? this.vmDefaults.image,
      resources: this.vmDefaults.resources,
      autoStopInterval: this.vmDefaults.autoStopInterval,
      envVars: opts.env,
    });
    const home = this.vmDefaults.homeDir ?? '/home/daytona';
    return DaytonaSandbox.open(this.sdk, vm, opts, home, /* ownsVm */ true);
  }
}
