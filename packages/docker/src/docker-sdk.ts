// ─────────────────────────────────────────────────────────────────────────────
// The ONLY file that spawns the `docker` CLI.
//
// `realDockerSdk()` maps `docker run`/`exec`/`rm` onto the dependency-inversion `DockerSdk` seam that
// `./docker.ts` is written against, absorbing every CLI detail HERE (so the provider stays dependency-free
// and unit-testable with a fake). `createDockerProvider(opts)` is the convenience factory: wire the real
// CLI seam and return a `DockerSandboxProvider`.
//
// The container is booted with `docker run -d <image> tail -f /dev/null` — a keep-alive so `docker exec`
// can run each node's command inside it (the image's default CMD would exit immediately under `-d`). Files
// cross via `docker exec` (cat/mkdir/find) rather than `docker cp`, so a path is passed through an env var
// (`-e PIFLOW_*`) and never interpolated into the shell — no quoting hazards. Reads/writes are byte-exact.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, type ChildProcess } from 'node:child_process';
import { DockerSandboxProvider } from './docker.js';
import { PI_RUNTIME_IMAGE, PI_RUNTIME_DOCKERFILE } from './pi-runtime.generated.js';
import type {
  DockerSdk,
  DockerContainer,
  DockerCreateParams,
  DockerExecResult,
  DockerCommandHandle,
  DockerEntry,
  DockerRunOpts,
} from './docker.js';

/** Result of one `docker` subprocess: stdout kept as BYTES (so `read` is byte-exact), stderr as text. */
interface RawResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

interface LaunchOpts {
  /** Bytes piped to the process stdin (for `write` = `cat > file`). */
  input?: Uint8Array | string;
  /** Kill the process after this many ms and report code 124 (the runner kill convention). */
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/** Spawn one `docker …` invocation (argv — never a shell, so args need no escaping). */
function launch(bin: string, args: string[], opts: LaunchOpts = {}): { child: ChildProcess; done: Promise<RawResult> } {
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdoutChunks: Buffer[] = [];
  let stderr = '';
  let timedOut = false;

  child.stdout?.on('data', (d: Buffer) => {
    stdoutChunks.push(d);
    opts.onStdout?.(d.toString('utf8'));
  });
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString('utf8');
    stderr += s;
    opts.onStderr?.(s);
  });

  if (opts.input !== undefined) {
    child.stdin?.end(typeof opts.input === 'string' ? Buffer.from(opts.input, 'utf8') : Buffer.from(opts.input));
  } else {
    child.stdin?.end();
  }

  const done = new Promise<RawResult>((resolve) => {
    // `docker` missing / not runnable → 'error' (code 127 unless we already timed out).
    child.on('error', (err) => resolve({ stdout: Buffer.concat(stdoutChunks), stderr: stderr || String(err), code: timedOut ? 124 : 127 }));
    child.on('close', (code) => resolve({ stdout: Buffer.concat(stdoutChunks), stderr, code: timedOut ? 124 : code ?? 0 }));
  });

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, opts.timeoutMs);
    void done.finally(() => clearTimeout(timer));
  }

  return { child, done };
}

/** Coerce the seam's write payload to bytes. */
function toBuffer(data: Uint8Array | string): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
}

/** Build the shared `docker exec [-w cwd] [-e K=V …] <id> sh -c` prefix for a command. */
function execArgs(id: string, sh: string, extra: { cwd?: string; envs?: Record<string, string>; interactive?: boolean } = {}): string[] {
  const args = ['exec'];
  if (extra.interactive) args.push('-i');
  if (extra.cwd) args.push('-w', extra.cwd);
  for (const [k, v] of Object.entries(extra.envs ?? {})) args.push('-e', `${k}=${v}`);
  args.push(id, 'sh', '-c', sh);
  return args;
}

/** Wrap a booted container id as the seam's `DockerContainer`. */
function makeContainer(bin: string, id: string): DockerContainer {
  return {
    id,
    files: {
      async write(remotePath, data) {
        // Path via env (no shell interpolation); create parents, then stream bytes from stdin.
        const res = await launch(
          bin,
          execArgs(id, 'mkdir -p "$(dirname "$PIFLOW_WP")" && cat > "$PIFLOW_WP"', { envs: { PIFLOW_WP: remotePath }, interactive: true }),
          { input: toBuffer(data) },
        ).done;
        if (res.code !== 0) throw new Error(`docker exec write ${remotePath} failed (code ${res.code}): ${res.stderr.trim()}`);
      },
      async writeMany(files) {
        for (const f of files) await this.write(f.path, f.data);
      },
      async read(remotePath) {
        const res = await launch(bin, execArgs(id, 'cat "$PIFLOW_RP"', { envs: { PIFLOW_RP: remotePath } })).done;
        if (res.code !== 0) throw new Error(`docker exec read ${remotePath} failed (code ${res.code}): ${res.stderr.trim()}`);
        return new Uint8Array(res.stdout);
      },
      async list(root) {
        // `2>/dev/null` swallows "No such file" so a node that produced nothing → [] (parity with the fakes).
        const res = await launch(bin, execArgs(id, 'find "$PIFLOW_LR" -type f 2>/dev/null', { envs: { PIFLOW_LR: root } })).done;
        return res.stdout
          .toString('utf8')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((p): DockerEntry => ({ path: p, isDir: false }));
      },
      async makeDir(remotePath) {
        const res = await launch(bin, execArgs(id, 'mkdir -p "$PIFLOW_MD"', { envs: { PIFLOW_MD: remotePath } })).done;
        if (res.code !== 0) throw new Error(`docker exec mkdir ${remotePath} failed (code ${res.code}): ${res.stderr.trim()}`);
      },
    },
    commands: {
      async run(cmd, opts?: DockerRunOpts): Promise<DockerExecResult> {
        const res = await launch(bin, execArgs(id, cmd, { cwd: opts?.cwd, envs: opts?.envs }), {
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        }).done;
        return { stdout: res.stdout.toString('utf8'), stderr: res.stderr, exitCode: res.code };
      },
      async runBackground(cmd, opts?: DockerRunOpts): Promise<DockerCommandHandle> {
        const { child, done } = launch(bin, execArgs(id, cmd, { cwd: opts?.cwd, envs: opts?.envs }), {
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts?.onStdout ? { onStdout: opts.onStdout } : {}),
          ...(opts?.onStderr ? { onStderr: opts.onStderr } : {}),
        });
        let killed = false;
        return {
          pid: child.pid ?? -1,
          async wait(): Promise<DockerExecResult> {
            const res = await done;
            // A killed exec reports nonzero; the provider overrides with 124 on abort. Never throws here.
            return { stdout: res.stdout.toString('utf8'), stderr: res.stderr, exitCode: killed ? 137 : res.code };
          },
          async kill(): Promise<void> {
            killed = true;
            // Best-effort: kill the `docker exec` client (ends our wait). The in-container process is
            // reaped for certain when the run container is `docker rm -f`'d — see SEAM FRICTION in docker.ts.
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
          },
        };
      },
    },
    async kill() {
      // Force-remove the container (kills every process inside). Best-effort — a teardown throw must not
      // mask the run verdict (the runner wraps dispose in try/catch), but we MUST attempt it or it leaks.
      await launch(bin, ['rm', '-f', id]).done;
    },
  };
}

/**
 * Make the pi node-runtime image available locally. Already built ⇒ no-op (a fast `image inspect`). MISSING
 * AND our managed default tag ⇒ AUTO-BUILD from the embedded Dockerfile via `docker build -t <tag> -` (the
 * Dockerfile piped on stdin with an EMPTY context — the recipe has no COPY), so `--sandbox docker` is a
 * single line with ZERO setup. A MISSING custom image (a `DOCKER_IMAGE` override) is a loud error — we can't
 * build an arbitrary tag. Build progress streams to stderr (the first build is slow: apt + `npm i -g pi`).
 */
async function ensureImage(bin: string, image: string): Promise<void> {
  const inspect = await launch(bin, ['image', 'inspect', image]).done;
  if (inspect.code === 0) return; // already present
  if (image !== PI_RUNTIME_IMAGE) {
    throw new Error(
      `--sandbox docker: image "${image}" is not available locally (or Docker is not running). It is a custom ` +
        `DOCKER_IMAGE override, so build it yourself, or unset DOCKER_IMAGE to use the managed default ` +
        `"${PI_RUNTIME_IMAGE}" (auto-built). (details: ${inspect.stderr.trim() || 'docker not found'})`,
    );
  }
  process.stderr.write(`piflowctl: building the pi node-runtime image "${image}" (first run; ~1–3 min: apt + npm i -g pi)…\n`);
  const build = await launch(bin, ['build', '-t', image, '-'], {
    input: PI_RUNTIME_DOCKERFILE,
    onStdout: (c) => process.stderr.write(c),
    onStderr: (c) => process.stderr.write(c),
  }).done;
  if (build.code !== 0) {
    throw new Error(`--sandbox docker: failed to build "${image}" (code ${build.code}). Is Docker running? Build output is above.`);
  }
  process.stderr.write(`piflowctl: built "${image}".\n`);
}

/**
 * Map the real `docker` CLI onto the `DockerSdk` seam `./docker.ts` is written against. `dockerBin`
 * overrides the binary (default `docker`, or `$PIFLOW_DOCKER_BIN`). `create` ensures the image exists —
 * auto-building the managed default on first use (`ensureImage`) — which also proves Docker is reachable.
 */
export function realDockerSdk(opts: { dockerBin?: string } = {}): DockerSdk {
  const bin = opts.dockerBin ?? process.env.PIFLOW_DOCKER_BIN ?? 'docker';
  return {
    async create(params: DockerCreateParams): Promise<DockerContainer> {
      await ensureImage(bin, params.image);
      const runArgs = ['run', '-d'];
      if (params.name) runArgs.push('--name', params.name);
      if (params.network) runArgs.push('--network', params.network);
      for (const [k, v] of Object.entries(params.env ?? {})) runArgs.push('-e', `${k}=${v}`);
      // Keep-alive so the container stays up for `docker exec`; overrides the image's default CMD.
      runArgs.push(params.image, 'tail', '-f', '/dev/null');
      const res = await launch(bin, runArgs).done;
      if (res.code !== 0) throw new Error(`--sandbox docker: 'docker run' failed (code ${res.code}): ${res.stderr.trim()}`);
      const id = res.stdout.toString('utf8').trim();
      if (!id) throw new Error("--sandbox docker: 'docker run -d' returned no container id");
      return makeContainer(bin, id);
    },
  };
}

/** Options for {@link createDockerProvider}. */
export interface CreateDockerProviderOpts {
  /**
   * The image tag to boot. Omit ⇒ the managed default {@link DEFAULT_DOCKER_IMAGE}, AUTO-BUILT from the
   * embedded pi node-runtime Dockerfile on first use. Set a custom tag only if you built it yourself.
   */
  image?: string;
  /** `docker run --network` value (e.g. `none` to cut egress); omit ⇒ default bridge (egress open). */
  network?: string;
  /** In-container home the run dir nests under (default `/home/user`). */
  homeDir?: string;
  /** Files staged into the container home before any node (the CLI passes `{ '.pi/agent/models.json': … }`). */
  stageHome?: Record<string, string>;
  /** Override the `docker` binary (default `docker` / `$PIFLOW_DOCKER_BIN`). */
  dockerBin?: string;
}

/** The default image tag — the versioned pi node-runtime, pinned to the shared spec (auto-built on first use). */
export const DEFAULT_DOCKER_IMAGE = PI_RUNTIME_IMAGE;

/**
 * Convenience factory: wire the real `docker` CLI onto the seam and return a `DockerSandboxProvider`. The
 * one-liner a runner uses to get a live local-Docker backend.
 */
export function createDockerProvider(opts: CreateDockerProviderOpts = {}): DockerSandboxProvider {
  return new DockerSandboxProvider(realDockerSdk({ dockerBin: opts.dockerBin }), {
    image: opts.image ?? DEFAULT_DOCKER_IMAGE,
    network: opts.network,
    homeDir: opts.homeDir,
    stageHome: opts.stageHome,
  });
}
