// ─────────────────────────────────────────────────────────────────────────────
// The ONLY file that imports `e2b`.
//
// `realE2bSdk()` maps the real `e2b` `Sandbox` factory onto the dependency-inversion `E2bSdk` seam
// that `./e2b.ts` is written against, absorbing every live-API divergence HERE (so the provider stays
// dependency-free and unit-testable with a fake). `createE2bProvider(opts)` is the convenience
// factory: build the create options, wrap the factory, return a wired `E2bSandboxProvider`.
//
// Signatures grounded in the Context7 e2b js-sdk reference v2.0.1 + the e2b-dev/e2b source.
// Divergences this adapter absorbs (verified against the INSTALLED e2b@2.31.0 `.d.ts`, which is the
// build's source of truth — it diverges from the older Context7 v2.0.1 reference where noted):
//   • create: real `Sandbox.create(opts)` — object form (`SandboxOpts.template/envs/timeoutMs/network`).
//     CREATE-time env is `SandboxOpts.envs` (PLURAL — the v2.0.1 docs said `env`; 2.31.0 is `envs`). The
//     seam keeps the logical name `E2bCreateParams.env` (VM-level env) and the adapter maps it → `envs`.
//   • files.write: real `files.write(path, data)` single + `files.write(WriteEntry[])` bulk; the seam
//     passes `Uint8Array | string` → forwarded as-is (the SDK accepts string | ArrayBuffer | Blob | …).
//   • files.read: real `files.read(path, { format: 'bytes' }) → Uint8Array` (default is a string).
//   • files.list: real `files.list(path, { depth }) → EntryInfo[]`; the adapter sets a deep `depth`
//     and normalizes each entry to `{ path, isDir }` (isDir = `EntryInfo.type === FileType.DIR` = 'dir').
//     (The v2.0.1 docs called the member `FileType.Directory`; 2.31.0 is `FileType.DIR`.)
//   • files.makeDir: real `files.makeDir(path) → WriteInfo` → seam returns void.
//   • commands.run: real `commands.run(cmd, opts) → CommandResult { stdout, stderr, exitCode }`, BUT it
//     THROWS `CommandExitError` (structurally a CommandResult) on a non-zero exit — the adapter CATCHES
//     it and returns the carried `{ stdout, stderr, exitCode }`, so the seam never throws on nonzero.
//   • commands.run({ background: true }): real → `CommandHandle { pid, wait(), kill() }`; `wait()` also
//     throws `CommandExitError` on nonzero → the adapter normalizes it the same way.
//   • teardown: real instance `sandbox.kill() → Promise<void>`.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Sandbox as E2bSandboxHandle,
  CommandExitError,
  FileType,
  type SandboxOpts,
  type CommandResult,
  type CommandHandle,
  type EntryInfo,
} from 'e2b';
import { E2bSandboxProvider } from './e2b.js';
import type {
  E2bSdk,
  E2bVm,
  E2bFs,
  E2bProcess,
  E2bCreateParams,
  E2bExecResult,
  E2bCommandHandle,
  E2bEntry,
  E2bRunOpts,
} from './e2b.js';

/** Recursion depth for `files.list` — large enough to cover any node's nested output subtree. */
const LIST_DEPTH = 100;

/**
 * SEAM FRICTION: E2B's `files.write` accepts `string | ArrayBuffer | Blob | ReadableStream` — NOT a
 * `Uint8Array` (unlike Daytona's `uploadFile(Buffer)`). The seam hands `Uint8Array | string`, so coerce a
 * `Uint8Array` to a clean, exactly-sized `ArrayBuffer` (slice the view so a pooled/larger backing buffer
 * isn't sent); strings pass through untouched.
 */
function toWriteData(data: Uint8Array | string): string | ArrayBuffer {
  if (typeof data === 'string') return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** Normalize a resolved `CommandResult` (or a thrown `CommandExitError`) to the seam's `E2bExecResult`. */
function toExecResult(r: CommandResult | CommandExitError): E2bExecResult {
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
}

/** Wrap a real E2B `Sandbox.files` as the seam's `E2bFs`. */
function adaptFs(sandbox: E2bSandboxHandle): E2bFs {
  return {
    async write(remotePath, data) {
      await sandbox.files.write(remotePath, toWriteData(data));
    },
    async writeMany(files) {
      // Native bulk form: files.write(WriteEntry[]). Coerce each Uint8Array payload to an ArrayBuffer.
      await sandbox.files.write(files.map((f) => ({ path: f.path, data: toWriteData(f.data) })));
    },
    read(remotePath) {
      // format: 'bytes' selects the Uint8Array overload (default returns a string).
      return sandbox.files.read(remotePath, { format: 'bytes' });
    },
    async list(root) {
      let entries: EntryInfo[];
      try {
        entries = await sandbox.files.list(root, { depth: LIST_DEPTH });
      } catch {
        return []; // missing dir → no files (a node that produced nothing), mirrors the Daytona fake
      }
      return entries.map(
        (e): E2bEntry => ({ path: e.path, isDir: e.type === FileType.DIR }),
      );
    },
    async makeDir(remotePath) {
      await sandbox.files.makeDir(remotePath);
    },
  };
}

/** Wrap a real E2B `Sandbox.commands` as the seam's `E2bProcess`. */
function adaptProcess(sandbox: E2bSandboxHandle): E2bProcess {
  return {
    async run(cmd, opts?: E2bRunOpts): Promise<E2bExecResult> {
      try {
        const res = await sandbox.commands.run(cmd, {
          ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts?.envs !== undefined ? { envs: opts.envs } : {}),
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });
        return toExecResult(res);
      } catch (err) {
        // A nonzero exit is reported as a thrown CommandExitError — read the carried result off it.
        if (err instanceof CommandExitError) return toExecResult(err);
        throw err;
      }
    },
    async runBackground(cmd, opts?: E2bRunOpts): Promise<E2bCommandHandle> {
      const handle: CommandHandle = await sandbox.commands.run(cmd, {
        background: true,
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts?.envs !== undefined ? { envs: opts.envs } : {}),
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts?.onStdout ? { onStdout: opts.onStdout } : {}),
        ...(opts?.onStderr ? { onStderr: opts.onStderr } : {}),
      });
      return {
        pid: handle.pid,
        async wait(): Promise<E2bExecResult> {
          try {
            return toExecResult(await handle.wait());
          } catch (err) {
            // wait() throws CommandExitError on a nonzero exit — normalize it to a resolved result.
            if (err instanceof CommandExitError) return toExecResult(err);
            throw err;
          }
        },
        kill() {
          // Real CommandHandle.kill() → Promise<void> (SIGKILL the command process).
          return handle.kill().then(() => undefined);
        },
      };
    },
  };
}

/** Wrap a real E2B `Sandbox` handle as the seam's `E2bVm`. */
function adaptVm(sandbox: E2bSandboxHandle): E2bVm {
  return {
    id: sandbox.sandboxId,
    files: adaptFs(sandbox),
    commands: adaptProcess(sandbox),
    async kill() {
      // Real instance teardown: sandbox.kill() → Promise<void>.
      await sandbox.kill();
    },
  };
}

/**
 * Map the real `e2b` `Sandbox` factory onto the `E2bSdk` seam `./e2b.ts` is written against. Pass the
 * result to `new E2bSandboxProvider(realE2bSdk(opts), vmDefaults)`. `opts` carries the API key (else the
 * SDK falls back to `E2B_API_KEY`) and any base-domain override.
 */
export function realE2bSdk(opts: { apiKey?: string; domain?: string } = {}): E2bSdk {
  return {
    async create(params?: E2bCreateParams): Promise<E2bVm> {
      const createOpts: SandboxOpts = {
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
        ...(opts.domain !== undefined ? { domain: opts.domain } : {}),
        ...(params?.template !== undefined ? { template: params.template } : {}),
        // Seam `env` (VM-level) → real `SandboxOpts.envs` (plural in 2.31.0; was `env` in v2.0.1 docs).
        ...(params?.env !== undefined ? { envs: params.env } : {}),
        ...(params?.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        // The network selector shape is E2B's own (SandboxNetworkOpts); the seam keeps it opaque and
        // forwards it verbatim when a host set one.
        ...(params?.network !== undefined ? { network: params.network as SandboxOpts['network'] } : {}),
      };
      const sandbox = await E2bSandboxHandle.create(createOpts);
      return adaptVm(sandbox);
    },
  };
}

/** Options for {@link createE2bProvider}. */
export interface CreateE2bProviderOpts {
  /** E2B API key. If omitted, the real SDK falls back to `E2B_API_KEY` (and throws if unset). */
  apiKey?: string;
  /** API base domain override (real `SandboxOpts.domain`; env `E2B_DOMAIN`). */
  domain?: string;
  /**
   * Pre-built E2B TEMPLATE name/ID to boot from — our promoted node-runtime (`deploy/e2b/`, built with
   * `e2b template build`). Omit ⇒ E2B's default `base` template (no pi baked → fine only for smoke tests).
   */
  template?: string;
  /** VM auto-kill timeout in MILLISECONDS so a crashed run can't leak a billed VM. */
  timeoutMs?: number;
  /**
   * Egress policy (real `SandboxOpts.network` = `{ allowOut?, denyOut? }`). Omit ⇒ E2B's OPEN-by-default
   * egress (the WHY for this backend); pass a selector to lock it down per-sandbox (allow wins). Opaque.
   */
  network?: unknown;
  /** In-VM home the run dir nests under (default `/home/user`). */
  homeDir?: string;
  /**
   * Files staged into the VM home before any node, keyed by home-relative path → content. The host
   * (CLI) passes `{ '.pi/agent/models.json': <provider config> }` so a CUSTOM gateway resolves in the VM.
   */
  stageHome?: Record<string, string>;
}

/**
 * Convenience factory: adapt the real `e2b` `Sandbox` factory onto the seam and return a wired
 * `E2bSandboxProvider`. The one-liner a runner uses to get a live E2B backend.
 */
export function createE2bProvider(opts: CreateE2bProviderOpts = {}): E2bSandboxProvider {
  return new E2bSandboxProvider(
    realE2bSdk({ apiKey: opts.apiKey, domain: opts.domain }),
    {
      template: opts.template,
      timeoutMs: opts.timeoutMs,
      network: opts.network,
      homeDir: opts.homeDir,
      stageHome: opts.stageHome,
    },
  );
}
