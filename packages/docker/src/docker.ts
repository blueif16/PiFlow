// ─────────────────────────────────────────────────────────────────────────────
// DockerSandbox / DockerSandboxProvider — the LOCAL CONTAINER backend, the offline mirror of the
// cloud path (Daytona/E2B) run on the host's own Docker daemon instead of a cloud VM.
//
// Mirrors `@piflow/e2b`'s `e2b.ts` method-for-method (which itself mirrors core's `daytona.ts`): ONE
// long-lived container per run, per-node workdir subtrees inside it, torn down once. The point is NOT
// stronger isolation than `--sandbox local` (seatbelt gives finer, kernel-enforced per-node readScope);
// it is a FAITHFUL, FREE, OFFLINE mirror of the cloud image + credential injection — boot the SAME pi
// node-runtime image (deploy/docker/Dockerfile, the shared spec in deploy/pi-runtime) locally to test the
// cloud path without a cloud account or per-minute billing. So `docker` is a CLOUD_KIND for env-staging
// (a container inherits no host env — creds cross via the declared allowlist, models.json is staged in).
//
// This file is dependency-FREE on purpose: it imports only node builtins + TYPES from `@piflow/core`, and
// talks to Docker through a small dependency-inversion seam (`interface DockerSdk` +
// DockerContainer/DockerFs/DockerProcess/DockerCommandHandle). The REAL client — `docker` CLI subprocess
// calls — is mapped onto that seam by `realDockerSdk()` in `./docker-sdk.ts` (the ONLY file that spawns
// `docker`); the convenience factory `createDockerProvider()` lives there too. This keeps the provider
// unit-testable with a FAKE SDK — see `test/sandbox-docker-parity.test.ts`, which drives this exact
// provider against a real-fs-backed fake and proves the full lifecycle + the run-scoped
// one-container-many-nodes path + streaming + cancel.
//
// SEAM FRICTION (documented, not papered over):
//   • Cancel: the seam's `signal` asks for a SIGTERM→SIGKILL process-GROUP kill. A background command
//     runs via `docker exec`; killing the `docker exec` CLIENT ends OUR wait (its pipes close) and we
//     return 124, but the in-CONTAINER process is best-effort — it is reaped for certain when the run's
//     container is force-removed (`DockerContainer.kill` = `docker rm -f`). The runner's killGrace
//     liveness fallback backstops it, exactly as it does for E2B's per-command kill and Daytona's soft
//     cancel. (The FAKE SDK spawns local processes in their own group, so cancel is exact under test.)
//   • Collection: `downloadDir` enumerates + reads each file (N round-trips through `docker exec cat`);
//     a tar-then-single-read would be the production shape (same note as E2B/Daytona).
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

// ── the SDK seam (the subset of the `docker` CLI this file drives) ──────────────
// A dependency-inversion adapter: the SMALLEST shape that typechecks against how this file uses Docker.
// `realDockerSdk()` (in ./docker-sdk.ts) maps `docker run`/`exec`/`cp`/`rm` onto it. EXPORTED so the
// adapter and the parity test can name them. Mirrors `@piflow/e2b`'s `E2bSdk` seam.

/** Mirrors the `docker run` params we set when booting ONE container for a run. */
export interface DockerCreateParams {
  /**
   * The image tag to boot — the pi node-runtime image (build it: `docker build -t <tag> deploy/docker`).
   * REQUIRED (unlike E2B's optional `template`): a local container has no default image with pi baked.
   */
  image: string;
  /** Per-container environment baked at `docker run` time (`-e KEY=VALUE`). */
  env?: Record<string, string>;
  /** Optional container name (`--name`); omit ⇒ Docker assigns one. */
  name?: string;
  /**
   * `docker run --network <value>` (e.g. `none` to cut egress, `host`, or a user network). Omit ⇒
   * Docker's default bridge = egress OPEN (parity with E2B's open-by-default egress — the MCP unblock).
   */
  network?: string;
}

/** Mirrors a `docker exec` invocation's per-call options. */
export interface DockerRunOpts {
  /** Working directory inside the container (`docker exec -w <cwd>`). */
  cwd?: string;
  /** Per-command environment (`docker exec -e KEY=VALUE`). */
  envs?: Record<string, string>;
  /** Per-command timeout in MILLISECONDS — the adapter kills the exec + returns 124 on expiry. */
  timeoutMs?: number;
  /** Streaming stdout callback (fed the exec child's stdout chunks in real time). */
  onStdout?: (chunk: string) => void;
  /** Streaming stderr callback. */
  onStderr?: (chunk: string) => void;
}

/** Mirrors a finished `docker exec` result. `exitCode` is the field name (parity with the seam). */
export interface DockerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Mirrors a backgrounded command handle. `wait()` resolves the result (never throws on a nonzero exit —
 * a nonzero code arrives as `{ stdout, stderr, exitCode }`). `kill()` terminates the running exec (used
 * to honor `ExecOpts.signal`).
 */
export interface DockerCommandHandle {
  /** Process id of the `docker exec` client (best-effort; used for logging/parity — see SEAM FRICTION). */
  readonly pid: number;
  /** Wait for completion; resolves the normalized result. */
  wait(): Promise<DockerExecResult>;
  /** Best-effort kill of the running command. */
  kill(): Promise<void>;
}

/** Mirrors one file entry under a root (`docker exec find <root> -type f`). */
export interface DockerEntry {
  /** Absolute in-container path of the entry. */
  path: string;
  /** True when the entry is a directory. */
  isDir: boolean;
}

/** Mirrors the filesystem facet of a container (via `docker exec` cat/mkdir/find). */
export interface DockerFs {
  /** Write bytes to `remotePath` inside the container (creates parent dirs). */
  write(remotePath: string, data: Uint8Array | string): Promise<void>;
  /** Bulk write (no native Docker bulk — the adapter loops; parity with Daytona). */
  writeMany(files: { path: string; data: Uint8Array | string }[]): Promise<void>;
  /** Read `remotePath` from the container as bytes. */
  read(remotePath: string): Promise<Uint8Array>;
  /**
   * Enumerate FILE entries under `root` (`find <root> -type f`). Entries carry `isDir` for parity with
   * the E2B seam (this backend returns files only, which is all `downloadDir` consumes). Returns [] when
   * `root` is absent (a node that produced nothing).
   */
  list(root: string): Promise<DockerEntry[]>;
  /** mkdir -p inside the container. */
  makeDir(remotePath: string): Promise<void>;
}

/** Mirrors the command facet of a container (via `docker exec`). */
export interface DockerProcess {
  /** Buffered exec (`docker exec ... sh -c <cmd>`) → `{ stdout, stderr, exitCode }` for ANY exit code. */
  run(cmd: string, opts?: DockerRunOpts): Promise<DockerExecResult>;
  /** Streaming + cancellable exec — callbacks fire per chunk; `wait()` gives the exit code; `kill()` cancels. */
  runBackground(cmd: string, opts?: DockerRunOpts): Promise<DockerCommandHandle>;
}

/** Mirrors a live container handle (a booted `docker run` result). */
export interface DockerContainer {
  /** The container id `docker run -d` printed. */
  readonly id: string;
  files: DockerFs;
  commands: DockerProcess;
  /** Force-remove this container (`docker rm -f`) — kills every process inside it. */
  kill(): Promise<void>;
}

/** Mirrors the `docker` CLI entry point. The real one boots a container with `docker run -d`. */
export interface DockerSdk {
  /** Boot ONE container (`docker run -d <image> sleep infinity`). */
  create(params: DockerCreateParams): Promise<DockerContainer>;
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

// ── the per-node sandbox VIEW (NOT a container — a view into the shared run container) ───

/**
 * One node's view INSIDE the shared run container. Each node gets its own `DockerSandbox`, but they all
 * delegate to the SAME `DockerContainer` (the per-run resource booted in `openRun`). The node's files
 * live under a per-node subtree (`<rootDir>/<workdir>`), so concurrent lanes don't collide. `dispose()`
 * is a NO-OP w.r.t. the container in the run-scoped path — the container is torn down ONCE by
 * `DockerRunScope.dispose`. Only the non-scoped `provider.create` path (`ownsContainer === true`) removes
 * the throwaway container here. Mirrors `E2bSandbox`.
 */
export class DockerSandbox implements Sandbox {
  readonly kind = 'docker' as const;

  private constructor(
    private readonly container: DockerContainer,
    /** Absolute-in-container root for THIS node (the per-node subtree of the shared container). */
    private readonly workdir: string,
    /** The node's output dir, relative to `workdir` (collected by `downloadDir`). */
    private readonly outputDir: string,
    private readonly env: Record<string, string>,
    /** Node wall-clock cap → the per-command `timeoutMs`. */
    private readonly timeoutMs: number | undefined,
    /** True only for the non-scoped `provider.create` path: `dispose` removes the container. */
    private readonly ownsContainer: boolean,
  ) {}

  /** Build a per-node view; `makeDir` materializes the node's subtree + output dir. Mirrors `E2bSandbox.open`. */
  static async open(
    container: DockerContainer,
    opts: CreateOpts,
    rootDir: string,
    ownsContainer: boolean,
  ): Promise<DockerSandbox> {
    const workdir = path.posix.join(rootDir, opts.workdir || '.');
    const outputDir = opts.outputDir || 'out';
    await container.files.makeDir(workdir);
    await container.files.makeDir(path.posix.join(workdir, outputDir));
    return new DockerSandbox(container, workdir, outputDir, opts.env ?? {}, opts.timeoutMs, ownsContainer);
  }

  /** Resolve an in-container path (relative → under this node's workdir; absolute kept as-is). */
  private abs(p: string): string {
    return path.posix.isAbsolute(p) ? p : path.posix.join(this.workdir, p);
  }

  async putFiles(files: { path: string; data: Uint8Array | string }[]): Promise<void> {
    if (files.length === 0) return;
    await this.container.files.writeMany(files.map((f) => ({ path: this.abs(f.path), data: f.data })));
  }

  async writeFile(p: string, data: Uint8Array | string): Promise<void> {
    await this.container.files.write(this.abs(p), data);
  }

  /**
   * Run a command in the shared container. Streaming OR a signal → the BACKGROUND path (`runBackground` +
   * `handle.wait()`/`handle.kill()`); otherwise → the simple buffered `run`. Both report a faithful,
   * SEPARATE stdout and stderr. Mirrors `E2bSandbox.exec`.
   */
  exec(cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const cwd = opts.cwd ? this.abs(opts.cwd) : this.workdir;
    const envs = { ...this.env, ...opts.env };
    const streaming = Boolean(opts.onStdout || opts.onStderr);
    const wantsCancel = Boolean(opts.signal);

    if (streaming || wantsCancel) return this.execBackground(cmd, cwd, envs, opts);
    return this.execBuffered(cmd, cwd, envs);
  }

  /** Buffered exec — the simple path. */
  private async execBuffered(
    cmd: string,
    cwd: string,
    envs: Record<string, string>,
  ): Promise<ExecResult> {
    const res = await this.container.commands.run(cmd, { cwd, envs, timeoutMs: this.timeoutMs });
    return { stdout: res.stdout, stderr: res.stderr, code: res.exitCode };
  }

  /**
   * Streaming + cancellable exec via a BACKGROUND command. Callbacks fire per chunk (feeding the runner's
   * stall detector); `handle.wait()` gives the exit code. On abort we call `handle.kill()` and return 124
   * (the runner kill convention) — see SEAM FRICTION in the file header. Mirrors `E2bSandbox.execBackground`.
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
    const handle = await this.container.commands.runBackground(cmd, {
      cwd,
      envs,
      timeoutMs: this.timeoutMs,
      onStdout,
      onStderr,
    });

    const onAbort = (): void => {
      aborted = true;
      void handle.kill().catch(() => { /* already gone */ });
    };
    const signal = opts.signal;
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await handle.wait();
      return {
        stdout: res.stdout || stdout,
        stderr: res.stderr || stderr,
        code: aborted ? 124 : res.exitCode,
      };
    } catch (err) {
      return { stdout, stderr: stderr || String(err), code: aborted ? 124 : 1 };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async readFile(p: string, opts: { encoding?: 'utf8' } = {}): Promise<Uint8Array | string> {
    const bytes = await this.container.files.read(this.abs(p));
    return decode(bytes, opts.encoding);
  }

  /**
   * Collect an output dir back to the host: enumerate files under `<remote>` (in-container), read each,
   * re-root onto the host `<local>`. Mirrors `E2bSandbox.downloadDir` (N round-trips — see SEAM FRICTION).
   */
  async downloadDir(remote: string, local: string): Promise<void> {
    const remoteRoot = this.abs(remote);
    const localRoot = path.resolve(process.cwd(), local);
    const entries = await this.container.files.list(remoteRoot);
    for (const entry of entries) {
      if (entry.isDir) continue;
      const rel = path.posix.relative(remoteRoot, entry.path);
      if (!rel || rel.startsWith('..')) continue; // defensive: skip anything outside the root
      const dest = path.resolve(localRoot, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const bytes = await this.container.files.read(entry.path);
      await fs.writeFile(dest, bytes);
    }
  }

  /**
   * Per-node teardown. In the RUN-SCOPED path this is a NO-OP — the shared container outlives every node
   * and is removed ONCE by `DockerRunScope.dispose`. Only the non-scoped `provider.create` path
   * (`ownsContainer === true`) removes the throwaway container here.
   */
  async dispose(): Promise<void> {
    if (this.ownsContainer) {
      await this.container.kill();
    }
  }
}

// ── the run scope: ONE container for the whole run; per-node views inside it ──────

/**
 * The per-run resource lifecycle. Holds the ONE container booted in `openRun`; `create` makes per-node
 * `DockerSandbox` views inside it; `dispose` REMOVES the container exactly once after the last node.
 * Mirrors `E2bRunScope`.
 */
class DockerRunScope implements RunScope {
  /** The in-container root all nodes live under (the run's filesystem-as-contract namespace). */
  readonly root: string;

  constructor(
    private readonly container: DockerContainer,
    /** In-container base dir for this run, e.g. `/home/user/pi/<run>`. */
    rootDir: string,
  ) {
    this.root = rootDir;
  }

  /** Make one node's sandbox view INSIDE the shared container (`ownsContainer:false` — dispose is a no-op). */
  create(opts: CreateOpts): Promise<Sandbox> {
    return DockerSandbox.open(this.container, opts, this.root, /* ownsContainer */ false);
  }

  /** Run-level teardown: remove the ONE container (best-effort; the runner wraps this in try/catch). */
  async dispose(): Promise<void> {
    await this.container.kill();
  }
}

// ── the provider ─────────────────────────────────────────────────────────────────

/**
 * The local Docker provider. Implements BOTH lifecycles (mirrors `E2bSandboxProvider`):
 *   - `openRun` (the run-scoped path): boot ONE container, return a `DockerRunScope`.
 *   - `create` (the non-scoped fallback): boot a THROWAWAY container for one node, view OWNS it.
 *
 * The constructor takes a `DockerSdk` seam (the real `docker` CLI client is mapped on via
 * `realDockerSdk()` in `./docker-sdk.ts`; `createDockerProvider()` is the convenience factory) so the
 * file is dependency-free and unit-testable with a fake SDK.
 */
export class DockerSandboxProvider implements SandboxProvider {
  readonly kind: SandboxProviderKind = 'docker';

  constructor(
    private readonly sdk: DockerSdk,
    /** Run-level container defaults the per-node CreateOpts can't carry (mirrors E2B's `vmDefaults`). */
    private readonly vmDefaults: {
      /** The pi node-runtime image tag to boot (REQUIRED — `docker build -t <tag> deploy/docker`). */
      image: string;
      /** `docker run --network` value; omit ⇒ default bridge (egress open). */
      network?: string;
      /** In-container home the run dir nests under (the image's WORKDIR `/home/user`). */
      homeDir?: string;
      /**
       * Run-level files staged into the container home BEFORE any node, keyed by home-relative path →
       * content. The load-bearing case is `'.pi/agent/models.json'`: a CUSTOM gateway (`--provider
       * nebius`/`mmgw`) is defined ONLY in the host's `~/.pi/agent/models.json`, which the image does NOT
       * bake — so pi in the container cannot resolve `--provider <gw>` without it. The staged config
       * carries `$VAR` apiKey REFERENCES, never literal secrets; the key crosses separately via the cloud
       * cred allowlist (`runner` `cloudCredEnvAdditions`). Mirrors E2B/Daytona.
       */
      stageHome?: Record<string, string>;
    },
  ) {}

  /** Default in-container home (the image's `user` account home). */
  private get home(): string {
    return this.vmDefaults.homeDir ?? '/home/user';
  }

  /** The create params shared by both lifecycles, derived from `vmDefaults`. */
  private createParams(): DockerCreateParams {
    return {
      image: this.vmDefaults.image,
      ...(this.vmDefaults.network !== undefined ? { network: this.vmDefaults.network } : {}),
    };
  }

  /** Write each run-level home file into the booted container at `<home>/<relPath>`. No-op when none declared. */
  private async stageHomeFiles(container: DockerContainer): Promise<void> {
    const files = this.vmDefaults.stageHome;
    if (!files) return;
    const entries = Object.entries(files).map(([rel, content]) => ({
      path: path.posix.join(this.home, rel),
      data: toBytes(content),
    }));
    if (entries.length) await container.files.writeMany(entries);
  }

  /** Boot ONE container for the whole run and return a scope whose per-node views live inside it. */
  async openRun(opts: OpenRunOpts): Promise<RunScope> {
    const container = await this.sdk.create({
      ...this.createParams(),
      env: { PI_RUN: opts.run },
    });
    const rootDir = path.posix.join(this.home, 'pi', opts.run);
    await container.files.makeDir(rootDir);
    await this.stageHomeFiles(container);
    return new DockerRunScope(container, rootDir);
  }

  /**
   * Non-scoped fallback: one throwaway container for a single node. The returned view OWNS the container,
   * so the runner's per-node `dispose` removes it.
   */
  async create(opts: CreateOpts): Promise<Sandbox> {
    const container = await this.sdk.create({
      ...this.createParams(),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
    await this.stageHomeFiles(container);
    return DockerSandbox.open(container, opts, this.home, /* ownsContainer */ true);
  }
}
