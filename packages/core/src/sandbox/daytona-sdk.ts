// ─────────────────────────────────────────────────────────────────────────────
// The ONLY file that imports `@daytona/sdk`.
//
// `realDaytonaSdk(client)` maps the real `Daytona` client onto the dependency-inversion
// `DaytonaSdk` seam that `./daytona.ts` is written against, absorbing every live-API
// divergence HERE (so the provider stays dependency-free and unit-testable with a fake).
// `createDaytonaProvider(opts)` is the convenience factory: build the real client, wrap it,
// return a wired `DaytonaSandboxProvider`.
//
// Signatures grounded in docs/research/daytona-sdk-2026-06-21.md against @daytona/sdk@0.185.0.
// Divergences this adapter absorbs:
//   • create: real `daytona.create(CreateSandboxFromImageParams)` — image|envVars|resources|
//     autoStopInterval map 1:1; the seam's `Sandbox` handle is the real `Sandbox`.
//   • fs.uploadFile: seam passes `Uint8Array`; real takes a `Buffer` → wrap with `Buffer.from`.
//   • fs.downloadFile: real returns a `Buffer` (⊂ `Uint8Array`) → returned as-is.
//   • fs.createFolder: real `mode` is REQUIRED → default to '755' when the seam omits it.
//   • fs.searchFiles: real `searchFiles(path, pattern) → { files: string[] }` (name-glob; NOT the
//     content-grep `findFiles`).
//   • process.executeCommand: real `ExecuteResponse` `{ exitCode, result, artifacts? }` → seam reads
//     `{ exitCode, result }`.
//   • process.executeSessionCommand: real `SessionExecuteRequest` `{ command, runAsync? }` →
//     `SessionExecuteResponse` `{ cmdId, ... }`.
//   • process.getSessionCommandLogs: real STREAMING overload `(id, cmdId, onStdout, onStderr) =>
//     Promise<void>` — used directly; the callbacks own the bytes.
//   • process.getSessionCommand: real `getSessionCommand(id, cmdId) → Command { exitCode? }` — the
//     finished-command exit code.
//   • delete: real `daytona.delete(sandbox, timeout?)`.
// ─────────────────────────────────────────────────────────────────────────────

import { Daytona, type DaytonaConfig, type Sandbox as DaytonaSandboxHandle } from '@daytona/sdk';
import { DaytonaSandboxProvider } from './daytona.js';
import type {
  DaytonaSdk,
  DaytonaVm,
  DaytonaFs,
  DaytonaProcess,
  DaytonaCreateParams,
  DaytonaExecResponse,
  DaytonaSessionCommand,
  DaytonaSessionCommandInfo,
} from './daytona.js';

/** Default octal dir mode — the real `fs.createFolder` requires a `mode` arg. */
const DEFAULT_DIR_MODE = '755';

/** Wrap a real Daytona `Sandbox.fs` as the seam's `DaytonaFs`. */
function adaptFs(sandbox: DaytonaSandboxHandle): DaytonaFs {
  return {
    async uploadFile(data, remotePath) {
      // Real overload: uploadFile(file: Buffer, remotePath, timeout?). The seam hands a Uint8Array.
      await sandbox.fs.uploadFile(Buffer.from(data), remotePath);
    },
    downloadFile(remotePath) {
      // Real overload (no localPath): downloadFile(remotePath, timeout?) => Buffer ⊂ Uint8Array.
      return sandbox.fs.downloadFile(remotePath);
    },
    async createFolder(remotePath, mode) {
      await sandbox.fs.createFolder(remotePath, mode ?? DEFAULT_DIR_MODE);
    },
    searchFiles(root, pattern) {
      // Real: searchFiles(path, pattern) => SearchFilesResponse { files: string[] }.
      return sandbox.fs.searchFiles(root, pattern);
    },
  };
}

/** Wrap a real Daytona `Sandbox.process` as the seam's `DaytonaProcess`. */
function adaptProcess(sandbox: DaytonaSandboxHandle): DaytonaProcess {
  return {
    async executeCommand(command, cwd, env, timeoutSec): Promise<DaytonaExecResponse> {
      const res = await sandbox.process.executeCommand(command, cwd, env, timeoutSec);
      return { exitCode: res.exitCode, result: res.result };
    },
    createSession(sessionId) {
      return sandbox.process.createSession(sessionId);
    },
    async executeSessionCommand(sessionId, req): Promise<DaytonaSessionCommand> {
      const res = await sandbox.process.executeSessionCommand(sessionId, {
        command: req.command,
        runAsync: req.runAsync,
      });
      return { cmdId: res.cmdId };
    },
    getSessionCommandLogs(sessionId, cmdId, onStdout, onStderr) {
      // The seam's streaming contract: callbacks own the bytes, resolves void. The real streaming
      // overload requires BOTH callbacks; supply no-op fallbacks if the caller omitted one.
      return sandbox.process.getSessionCommandLogs(
        sessionId,
        cmdId,
        onStdout ?? (() => {}),
        onStderr ?? (() => {}),
      );
    },
    async getSessionCommand(sessionId, cmdId): Promise<DaytonaSessionCommandInfo> {
      const cmd = await sandbox.process.getSessionCommand(sessionId, cmdId);
      return { exitCode: cmd.exitCode };
    },
    deleteSession(sessionId) {
      return sandbox.process.deleteSession(sessionId);
    },
  };
}

/** Wrap a real Daytona `Sandbox` handle as the seam's `DaytonaVm`. */
function adaptVm(sandbox: DaytonaSandboxHandle): DaytonaVm {
  return {
    id: sandbox.id,
    fs: adaptFs(sandbox),
    process: adaptProcess(sandbox),
  };
}

/**
 * Map a real `Daytona` client onto the `DaytonaSdk` seam `./daytona.ts` is written against. Pass the
 * result to `new DaytonaSandboxProvider(realDaytonaSdk(client), vmDefaults)`.
 */
export function realDaytonaSdk(client: Daytona): DaytonaSdk {
  // Track the real handle per seam-VM so `delete` can pass the original `Sandbox` back to the client.
  const handles = new WeakMap<DaytonaVm, DaytonaSandboxHandle>();
  return {
    async create(params?: DaytonaCreateParams): Promise<DaytonaVm> {
      // Real `create(CreateSandboxFromImageParams)` — only forward fields we set; undefined image is
      // fine (the client falls back to its default snapshot).
      const sandbox = await client.create({
        // Prefer a pre-built snapshot (our promoted `piflow-node-runtime`); else an image ref. The real
        // client splits these into `CreateSandboxFromSnapshotParams` vs `…FromImageParams` — forwarding
        // both is harmless when one is undefined, and `snapshot` wins where the API distinguishes them.
        ...(params?.snapshot !== undefined ? { snapshot: params.snapshot } : {}),
        ...(params?.image !== undefined ? { image: params.image } : {}),
        ...(params?.envVars !== undefined ? { envVars: params.envVars } : {}),
        ...(params?.resources !== undefined ? { resources: params.resources } : {}),
        ...(params?.autoStopInterval !== undefined ? { autoStopInterval: params.autoStopInterval } : {}),
      });
      const vm = adaptVm(sandbox);
      handles.set(vm, sandbox);
      return vm;
    },
    async delete(vm: DaytonaVm): Promise<void> {
      const sandbox = handles.get(vm);
      // Real `daytona.delete(sandbox, timeout?)`.
      if (sandbox) await client.delete(sandbox);
    },
  };
}

/** Options for {@link createDaytonaProvider}. */
export interface CreateDaytonaProviderOpts {
  /** Daytona API key. If omitted, the real client falls back to `DAYTONA_API_KEY` (and throws if unset). */
  apiKey?: string;
  /** API base URL override (real default `https://app.daytona.io/api`, env `DAYTONA_API_URL`). */
  apiUrl?: string;
  /** Target region for sandboxes (env `DAYTONA_TARGET`). */
  target?: string;
  /** Run-level VM image ref (the per-run shared VM and per-node throwaway VMs default to this). */
  image?: string;
  /**
   * Pre-built Daytona SNAPSHOT name to boot from (preferred over `image`) — our promoted node-runtime image
   * (`deploy/daytona/promote-snapshot.mjs`). A snapshot is permanent + instant (no rebuild, no external
   * registry); this is the normal production path.
   */
  snapshot?: string;
  /** Run-level VM sizing (cpu cores; memory/disk in GiB). */
  resources?: { cpu?: number; memory?: number; disk?: number };
  /** Idle auto-stop guard in MINUTES so a crashed run can't leak a billed VM. */
  autoStopInterval?: number;
  /** In-VM home the run dir nests under (default `/home/daytona`). */
  homeDir?: string;
  /**
   * (M1b) Files staged into the VM home before any node, keyed by home-relative path → content. The host
   * (CLI) passes `{ '.pi/agent/models.json': <provider config> }` so a CUSTOM gateway resolves in the VM.
   */
  stageHome?: Record<string, string>;
}

/**
 * Convenience factory: construct the real `Daytona` client, adapt it onto the seam, and return a wired
 * `DaytonaSandboxProvider`. The one-liner a runner uses to get a live cloud backend.
 */
export function createDaytonaProvider(opts: CreateDaytonaProviderOpts = {}): DaytonaSandboxProvider {
  const config: DaytonaConfig = {
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.apiUrl !== undefined ? { apiUrl: opts.apiUrl } : {}),
    ...(opts.target !== undefined ? { target: opts.target } : {}),
  };
  const client = new Daytona(config);
  return new DaytonaSandboxProvider(realDaytonaSdk(client), {
    image: opts.image,
    snapshot: opts.snapshot,
    resources: opts.resources,
    autoStopInterval: opts.autoStopInterval,
    homeDir: opts.homeDir,
    stageHome: opts.stageHome,
  });
}
