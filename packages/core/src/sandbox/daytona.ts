// ─────────────────────────────────────────────────────────────────────────────
// DaytonaSandbox / DaytonaSandboxProvider — the CLOUD backend, LIVE-WIRED VIA AN ADAPTER.
//
// This file is dependency-FREE on purpose: it imports only node builtins + `../types.js`,
// and talks to Daytona through a small dependency-inversion seam, `interface DaytonaSdk`
// (+ DaytonaVm/DaytonaFs/DaytonaProcess and the response types). The REAL `@daytona/sdk`
// is mapped onto that seam by `realDaytonaSdk()` in `./daytona-sdk.ts` (the ONLY file that
// imports the SDK); the convenience factory `createDaytonaProvider()` lives there too. This
// keeps the provider unit-testable with a fake SDK — see `test/sandbox-cloud-parity.test.ts`,
// which drives this exact provider against a real-fs-backed fake and proves local↔cloud share
// one lifecycle.
//
// The seam is GROUNDED against the live `@daytona/sdk@0.185.0` signatures (see
// docs/research/daytona-sdk-2026-06-21.md). The real names it mirrors:
//   `daytona.create({ image, envVars, resources, autoStopInterval, ... })` → `Sandbox`,
//   `sandbox.fs.uploadFile(Buffer, remotePath)` / `downloadFile(remotePath) → Buffer` /
//   `createFolder(path, mode)` / `searchFiles(path, pattern) → { files: string[] }`,
//   `sandbox.process.executeCommand(cmd, cwd?, env?, timeoutSec?)` → { exitCode, result },
//   `createSession(id)` / `executeSessionCommand(id, { command, runAsync }) → { cmdId }` /
//   `getSessionCommandLogs(id, cmdId, onStdout, onStderr): Promise<void>` (streaming form
//   resolves VOID — callbacks own the bytes) / `getSessionCommand(id, cmdId) → { exitCode? }`
//   (the real exit code after a runAsync command) / `deleteSession(id)`, `daytona.delete(vm)`.
// Where the live API diverges from the Sandbox/ExecOpts contract, the gap is documented inline
// (search "SEAM FRICTION") AND in the research note — not papered over.
// ─────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { tailAppend } from './capture.js';
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

// ── the SDK seam (the subset of @daytona/sdk this file calls) ──────────────────
// A dependency-inversion adapter: these interfaces are the SMALLEST shape that
// typechecks against how this file uses the SDK, and they mirror the real
// `@daytona/sdk@0.185.0` names so `realDaytonaSdk()` (in ./daytona-sdk.ts) maps the
// live client onto them 1:1. They are EXPORTED so the adapter and the parity test can
// name them. Grounded in docs/research/daytona-sdk-2026-06-21.md.

/** Mirrors `daytona.create({...})` params — `CreateSandboxFromImageParams` subset. */
export interface DaytonaCreateParams {
  /** Container image ref (real SDK also accepts an `Image` builder or a `snapshot`). */
  image?: string;
  /**
   * Pre-built Daytona SNAPSHOT name to boot from (real `CreateSandboxFromSnapshotParams.snapshot`) — a
   * permanent, instant image registered in Daytona's OWN store (no external registry). This is how a node
   * boots from our promoted `piflow-node-runtime` image; preferred over `image` when set.
   */
  snapshot?: string;
  /** Per-VM environment (real field: `envVars`). */
  envVars?: Record<string, string>;
  /** VM sizing — real `Resources` shape `{ cpu, memory, disk }` (memory/disk in GiB). */
  resources?: { cpu?: number; memory?: number; disk?: number };
  /** Idle auto-stop guard in MINUTES (0 = disabled, real default 15) so a crashed run can't leak a billed VM. */
  autoStopInterval?: number;
}

/** Mirrors `sandbox.process.executeCommand(...)` return (`ExecuteResponse`). `result` == stdout. */
export interface DaytonaExecResponse {
  exitCode: number;
  /** The command's stdout — the real SDK returns this as `result`. */
  result: string;
}

/** Mirrors `executeSessionCommand(...)` return (`SessionExecuteResponse`) — a handle to a backgrounded cmd. */
export interface DaytonaSessionCommand {
  /** Non-optional on the real response, but a runAsync start is the only thing we read off it. */
  cmdId?: string;
}

/**
 * Mirrors the real `getSessionCommand(sessionId, cmdId)` → `Command` — how the real exit code of a
 * finished `runAsync` command is recovered (the streaming-logs promise does NOT carry it).
 */
export interface DaytonaSessionCommandInfo {
  exitCode?: number;
}

/** Mirrors `sandbox.fs` — the filesystem facet of a Daytona sandbox. */
export interface DaytonaFs {
  /** Upload bytes to `remotePath` inside the VM. Real: `uploadFile(file: Buffer, remotePath)`. */
  uploadFile(data: Uint8Array, remotePath: string): Promise<void>;
  /** Download `remotePath` from the VM as bytes. Real: `downloadFile(remotePath) => Buffer`. */
  downloadFile(remotePath: string): Promise<Uint8Array>;
  /** mkdir -p inside the VM. Real: `createFolder(path, mode)` — `mode` is required there; the adapter defaults it. */
  createFolder(remotePath: string, mode?: string): Promise<void>;
  /**
   * Search for files under `root` whose NAME matches the glob `pattern`, returning their paths.
   * Real: `searchFiles(path, pattern) => { files: string[] }`. (Note: the real `findFiles` is a GREP
   * over file CONTENT — wrong tool for collection — so the seam uses `searchFiles`.)
   */
  searchFiles(root: string, pattern: string): Promise<{ files: string[] }>;
}

/** Mirrors `sandbox.process` — the command facet of a Daytona sandbox. */
export interface DaytonaProcess {
  /**
   * Buffered exec. Real signature is POSITIONAL: `executeCommand(command, cwd?, env?, timeoutSec?)`.
   * NOTE: no AbortSignal, no streaming callbacks, timeout is in SECONDS. See "SEAM FRICTION" below.
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
   * STREAMING form of the session-command logs: invokes `onStdout`/`onStderr` per chunk. The callbacks
   * own the bytes (the real streaming overload returns `Promise<void>`, NOT a `{stdout,stderr}` object).
   * CRITICAL (live-verified): this promise resolves VOID only when the underlying `?follow=true` log
   * socket CLOSES — i.e. on SESSION TEARDOWN — NOT when the runAsync command exits. Awaiting it as a
   * completion signal hangs forever. Callers learn completion via `getSessionCommand` (below) instead,
   * and await this only to flush trailing bytes after they tear the session down.
   */
  getSessionCommandLogs(
    sessionId: string,
    cmdId: string,
    onStdout?: (chunk: string) => void,
    onStderr?: (chunk: string) => void,
  ): Promise<void>;
  /** Fetch a finished session command's info — the real exit code (real: `getSessionCommand`). */
  getSessionCommand(sessionId: string, cmdId: string): Promise<DaytonaSessionCommandInfo>;
  /** Best-effort interrupt of a running session command (used to honor ExecOpts.signal). */
  deleteSession(sessionId: string): Promise<void>;
}

/** Mirrors a live Daytona sandbox/VM handle (`daytona.create(...)` result, a `Sandbox`). */
export interface DaytonaVm {
  /** Stable id the SDK assigns (used for labels/logging). */
  readonly id: string;
  fs: DaytonaFs;
  process: DaytonaProcess;
}

/** Mirrors the `Daytona` client. Construct the real one with `new Daytona({ apiKey })`. */
export interface DaytonaSdk {
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

/** Sleep `ms` — used to space out the completion poll in `execSession`. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Completion-poll backoff bounds for the streaming session exec (see `execSession`): start tight so a
 * fast command returns promptly, back off to a cap so a long-running node doesn't hammer the control plane.
 */
const SESSION_POLL_MIN_MS = 100;
const SESSION_POLL_MAX_MS = 2000;

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
    // createFolder is `mkdir -p` in the VM — make the node's subtree + its output dir.
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
    // Ensure the parent dir exists in the VM (the runner stages reads at nested rel paths).
    const dir = path.posix.dirname(target);
    if (dir && dir !== '.' && dir !== '/') await this.vm.fs.createFolder(dir);
    // sandbox.fs.uploadFile(Buffer, remotePath).
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
   * SEAM FRICTION (see research note §5): the buffered `executeCommand` returns ONE `result` string
   * (== stdout), so `stderr` is left '' and everything lands in `stdout` (the seam explicitly allows
   * this — ExecResult's doc: "Combined-output backends fill `stdout` and leave `stderr` ''"). And
   * `timeoutMs` becomes a SECONDS arg; sub-second precision is lost.
   */
  exec(cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const cwd = opts.cwd ? this.abs(opts.cwd) : this.workdir;
    const env = { ...this.env, ...opts.env };
    const streaming = Boolean(opts.onStdout || opts.onStderr);
    const wantsCancel = Boolean(opts.signal);

    if (streaming || wantsCancel) return this.execSession(cmd, cwd, env, opts);
    return this.execBuffered(cmd, cwd, env);
  }

  /** Buffered exec — the simple path. executeCommand(cmd, cwd, env, timeoutSec). */
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
   * Streaming + cancellable exec via a session. This is the closest Daytona offers to the
   * InMemorySandbox/Seatbelt process-group kill the seam's `signal` doc demands — but it is NOT the
   * same primitive (SEAM FRICTION, research note §5). On abort we tear down the SESSION, which stops
   * the streamed command; Daytona exposes no documented per-process-group SIGTERM→SIGKILL, so the
   * runner's killGrace liveness fallback (runner.ts defaultExecRunner) is what ultimately bounds a
   * hung exec.
   *
   * Completion (LIVE-VERIFIED FIX): the streaming `getSessionCommandLogs` promise does NOT resolve when
   * the runAsync command exits — it follows a `?follow=true` log socket that closes only on session
   * teardown, so awaiting it for completion hangs forever (this is the bug the offline fake couldn't
   * catch). So we stream logs in the BACKGROUND (callbacks fire per chunk in real time → the runner's
   * stall detector keeps seeing output), and learn completion by POLLING `getSessionCommand(id, cmdId)`
   * until its `exitCode` is populated — the only signal a finished runAsync command gives. Once done we
   * tear the session down (closing the log socket) and await the background stream so trailing bytes are
   * flushed. The poll is bounded by the runner's node-timeout/stall watchdog (it aborts → loop exits).
   *
   * Output: the streaming overload returns void — the callbacks own the bytes — so we wrap the caller's
   * `onStdout`/`onStderr` to ALSO accumulate into local buffers, giving a faithful `{stdout, stderr}`.
   * Exit code: from the completion poll. On abort, or if the lookup can't answer, we fall back to
   * 124 (runner kill convention) / 1.
   */
  private async execSession(
    cmd: string,
    cwd: string,
    env: Record<string, string>,
    opts: ExecOpts,
  ): Promise<ExecResult> {
    const sessionId = `pi-${this.vm.id}-${process.pid}-${sessionSeq++}`;
    // Daytona sessions have no per-session cwd/env; bake them into the command line so the command runs
    // where the buffered path would. (`cd` then exec under one `sh -c`.)
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ');
    const wrapped = `cd ${JSON.stringify(cwd)} && ${envPrefix ? envPrefix + ' ' : ''}${cmd}`;

    await this.vm.process.createSession(sessionId);
    let aborted = false;
    let sessionGone = false;
    // Idempotent teardown — closes the streaming log socket (so the background `streaming` promise below
    // resolves) and stops a still-running command. Safe from the abort handler, the happy path, and the
    // finally block; it deletes the session at most once.
    const closeSession = async (): Promise<void> => {
      if (sessionGone) return;
      sessionGone = true;
      await this.vm.process.deleteSession(sessionId).catch(() => { /* already gone */ });
    };
    const onAbort = (): void => {
      aborted = true;
      // Best-effort interrupt — tearing the session down stops the running command. This is a SOFT
      // cancel, not the seam's promised SIGTERM→SIGKILL process-group kill (research note §5).
      void closeSession();
    };
    const signal = opts.signal;
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    // The streaming overload returns void — we accumulate the bytes ourselves while forwarding to the
    // caller's callbacks, so ExecResult carries a faithful stdout/stderr.
    let stdout = '';
    let stderr = '';
    const collectStdout = (chunk: string): void => { stdout = tailAppend(stdout, chunk); opts.onStdout?.(chunk); };
    const collectStderr = (chunk: string): void => { stderr = tailAppend(stderr, chunk); opts.onStderr?.(chunk); };

    try {
      // runAsync starts the command and returns a cmdId.
      const started = await this.vm.process.executeSessionCommand(sessionId, {
        command: wrapped,
        runAsync: true,
      });
      const cmdId = started.cmdId ?? '';

      // Stream the command's logs in the BACKGROUND. Its callbacks fire per chunk in real time (feeding
      // the runner's stall detector); we do NOT await it for completion (it only resolves on session
      // teardown, never on command exit). We await it later, AFTER teardown, to flush trailing bytes. A
      // late rejection (socket cut on teardown/abort) is expected — swallow it.
      const streaming = Promise.resolve(
        this.vm.process.getSessionCommandLogs(sessionId, cmdId, collectStdout, collectStderr),
      ).catch(() => { /* socket closed on teardown/abort */ });

      // Learn completion by polling getSessionCommand for a populated exitCode (the only signal a
      // finished runAsync command gives). Backoff-spaced; bounded by the runner's watchdog → abort.
      let code: number | undefined;
      let wait = SESSION_POLL_MIN_MS;
      while (!aborted) {
        const info = await this.vm.process.getSessionCommand(sessionId, cmdId);
        if (info.exitCode != null) { code = info.exitCode; break; }
        await delay(wait);
        wait = Math.min(wait * 2, SESSION_POLL_MAX_MS);
      }

      // Tear the session down (closes the log socket → `streaming` resolves), then await the stream so
      // any trailing bytes land in our buffers before we return.
      await closeSession();
      await streaming;

      // Aborted runs report 124 (runner kill convention); otherwise the polled code (0 if unknown).
      return { stdout, stderr, code: aborted ? 124 : (code ?? 0) };
    } catch (err) {
      return { stdout, stderr: stderr || String(err), code: aborted ? 124 : 1 };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      await closeSession();
    }
  }

  async readFile(p: string, opts: { encoding?: 'utf8' } = {}): Promise<Uint8Array | string> {
    // sandbox.fs.downloadFile(remotePath) => bytes.
    const bytes = await this.vm.fs.downloadFile(this.abs(p));
    return decode(bytes, opts.encoding);
  }

  /**
   * Collect an output dir back to the host. The seam's portable contract: copy `<remote>` (in-VM) to
   * `<local>` (on the host run dir). Daytona has no "download a whole folder" call, so we enumerate
   * with `searchFiles` (a name-glob search returning paths) and `downloadFile` each, re-rooting onto
   * the host. SEAM FRICTION (research note §5): at scale this is N round-trips — a tar-on-VM-then-
   * single-download would be the production shape.
   */
  async downloadDir(remote: string, local: string): Promise<void> {
    const remoteRoot = this.abs(remote);
    const localRoot = path.resolve(process.cwd(), local);
    // searchFiles(root, '*') → paths of every file under the output dir.
    const { files } = await this.vm.fs.searchFiles(remoteRoot, '*');
    for (const file of files) {
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
      // daytona.delete(vm) — only when THIS view owns a throwaway VM (non-scoped path).
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
    // daytona.delete(vm) — the single destroy of the per-run VM.
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
 * The constructor takes a `DaytonaSdk` seam (the real client is mapped on via `realDaytonaSdk()` in
 * `./daytona-sdk.ts`; `createDaytonaProvider()` is the convenience factory) so the file is dependency-
 * free and unit-testable with a fake SDK.
 */
export class DaytonaSandboxProvider implements SandboxProvider {
  readonly kind: SandboxProviderKind = 'daytona';

  constructor(
    private readonly sdk: DaytonaSdk,
    /**
     * Run-level VM defaults the per-node CreateOpts can't carry (research note §3/§5). OpenRunOpts has
     * no image/region/resources, so these come from provider construction (env/config) instead.
     */
    private readonly vmDefaults: {
      image?: string;
      /** Pre-built Daytona SNAPSHOT name to boot from (preferred over `image`) — our promoted node-runtime. */
      snapshot?: string;
      resources?: { cpu?: number; memory?: number; disk?: number };
      /** Idle auto-stop guard so a crashed run can't leak a billed VM. */
      autoStopInterval?: number;
      /** In-VM home the run dir nests under (Daytona's default user home). */
      homeDir?: string;
      /**
       * (M1b) Run-level files staged into the VM home BEFORE any node runs, keyed by home-relative path →
       * content. The load-bearing case is `'.pi/agent/models.json'`: a CUSTOM gateway (`--provider nebius`/
       * `mmgw`) is defined ONLY in the host's `~/.pi/agent/models.json` (baseUrl/api/models), which the image
       * does NOT bake — so pi in the VM cannot resolve `--provider <gw>` without it. The staged config carries
       * `$VAR` apiKey REFERENCES (pi's official value syntax), never literal secrets; the actual key crosses
       * separately via the cloud cred allowlist (`runner.ts` `cloudCredEnvAdditions`). Built-in providers
       * (anthropic/…) need no entry, so this is omitted for them.
       */
      stageHome?: Record<string, string>;
    } = {},
  ) {}

  /**
   * (M1b) Write each run-level home file into the booted VM at `<home>/<relPath>` (mkdir -p the parent).
   * Idempotent-safe (uploadFile overwrites). No-op when nothing is declared.
   */
  private async stageHomeFiles(vm: DaytonaVm, home: string): Promise<void> {
    const files = this.vmDefaults.stageHome;
    if (!files) return;
    for (const [rel, content] of Object.entries(files)) {
      const target = path.posix.join(home, rel);
      const dir = path.posix.dirname(target);
      if (dir && dir !== '.' && dir !== '/') await vm.fs.createFolder(dir);
      await vm.fs.uploadFile(toBytes(content), target);
    }
  }

  /** Boot ONE VM for the whole run and return a scope whose per-node views live inside it. */
  async openRun(opts: OpenRunOpts): Promise<RunScope> {
    // Boot the per-run VM. NOTE the seam mismatch (research note §5): CreateOpts.image/env/timeoutMs
    // are PER-NODE, but the VM is created HERE from OpenRunOpts (which has none of them). So the VM's
    // image/resources come from `vmDefaults` (provider config), and per-node `env`/`image` are applied
    // LATER, at the node level — `env` per `exec`, and a per-node `image` is simply UNSUPPORTED in the
    // shared-VM model (you can't reimage a running VM per node).
    const vm = await this.sdk.create({
      // Prefer our pre-built snapshot; fall back to a raw image ref. (A snapshot name is NOT an image ref —
      // the API distinguishes them — so this must forward `snapshot`, not stuff the name into `image`.)
      snapshot: this.vmDefaults.snapshot,
      image: this.vmDefaults.snapshot ? undefined : this.vmDefaults.image,
      resources: this.vmDefaults.resources,
      autoStopInterval: this.vmDefaults.autoStopInterval,
      // The run id is the natural VM label; passed via env for traceability (OpenRunOpts.run).
      envVars: { PI_RUN: opts.run },
    });
    // The run's in-VM root: nest under the VM home so node subtrees are siblings (a worktree analogue).
    const home = this.vmDefaults.homeDir ?? '/home/daytona';
    const rootDir = path.posix.join(home, 'pi', opts.run);
    // createFolder the run root once so every node's create() nests cleanly.
    await vm.fs.createFolder(rootDir);
    // (M1b) Stage run-level home files (e.g. the pi provider config) ONCE, before any node — so a custom
    // gateway resolves for every node in this VM.
    await this.stageHomeFiles(vm, home);
    return new DaytonaRunScope(this.sdk, vm, opts, rootDir);
  }

  /**
   * Non-scoped fallback: one throwaway VM for a single node. The returned view OWNS the VM, so the
   * runner's per-node `dispose` destroys it (no RunScope teardown in this path).
   */
  async create(opts: CreateOpts): Promise<Sandbox> {
    // A per-node VM CAN honor CreateOpts.image (unlike the shared-VM path) — this is the only path
    // where per-node image actually works (research note §5).
    const vm = await this.sdk.create({
      // A per-node image override wins; else the run-level snapshot (preferred) or image default.
      snapshot: opts.image ? undefined : this.vmDefaults.snapshot,
      image: opts.image ?? (this.vmDefaults.snapshot ? undefined : this.vmDefaults.image),
      resources: this.vmDefaults.resources,
      autoStopInterval: this.vmDefaults.autoStopInterval,
      envVars: opts.env,
    });
    const home = this.vmDefaults.homeDir ?? '/home/daytona';
    // (M1b) Stage run-level home files into the throwaway VM too (parity with the openRun path).
    await this.stageHomeFiles(vm, home);
    return DaytonaSandbox.open(this.sdk, vm, opts, home, /* ownsVm */ true);
  }
}
