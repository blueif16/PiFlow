// `piflowctl context` STORE — the pure read/write side of `~/.piflow/contexts.json`, the kubectl/docker-style
// registry of named control-plane endpoints (a `local` and any number of `cloud` `serve` targets) that the CLI
// and GUI point at. This is the persistence + resolution logic ONLY (no arg-parse, no print — that is
// context.ts); it is deterministic and home-dir-overridable via `PIFLOW_HOME` (reusing @piflow/core's ONE
// home resolver, `globalDir`) so it is unit-testable against a tmp dir.
//
// The store lives under the global home `~/.piflow/` (alongside products.json / model-tiers.json) — NEVER in
// the repo/SDK (the architectural law: global mapping/config there, never in packages/ or a product).
//
// An implicit `local` context (the `serve-cli.ts` default endpoint `http://127.0.0.1:5273`) is ALWAYS present,
// even with no file on disk — seeded lazily on every read so `context ls` / resolution never come up empty.
//
// resolveActive precedence (the UNANIMOUS kubectl/docker/gcloud ladder):
//   opts.flagContext  (a `--context <name>` flag)          — highest
//   process.env.PIFLOW_CONTEXT                              — the env override
//   file.current      (the persisted `context use` pointer)
//   'local'           (the implicit default)                — lowest

import fssync from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { globalDir } from '@piflow/core';

/**
 * The control-plane hosting pathway a context runs on — the `--host` kinds plus the implicit `local` serve.
 * `local` is the laptop; everything else is a remote (cloud) control plane.
 */
export type HostKind = 'local' | 'fly' | 'railway' | 'selfhost' | 'docker';

/**
 * Where a context's WORKERS (each node's `pi`) execute — the persistent default for `--sandbox`. `local` runs
 * on the same machine as the control plane; `e2b`/`daytona` are cloud sandboxes. (`docker` is deferred: its
 * name is ambiguous between a local container and a docker-hosted plane, so it is NOT in the worker cascade —
 * `--sandbox docker` still works as a per-run override.)
 */
export type WorkerKind = 'local' | 'daytona' | 'e2b';

/** Cloud workers in preference order — a cloud host cascades to the first of these that is set up. */
export const CLOUD_WORKERS: readonly WorkerKind[] = ['e2b', 'daytona'];
/** Full worker precedence (cloud-first, then local) — the ORDER is the contract (a mutation test flips it). */
export const WORKER_PRECEDENCE: readonly WorkerKind[] = ['e2b', 'daytona', 'local'];

/**
 * One named context — the two axes we switch between: WHERE the control plane runs (`baseUrl`/`token` +
 * `host`) and WHERE its workers run (`worker`). `host`/`worker` are optional for back-compat: a legacy entry
 * with neither resolves via the cascade (loopback baseUrl ⇒ local; a remote baseUrl ⇒ a cloud plane).
 */
export interface ContextEntry {
  baseUrl: string;
  token?: string;
  /** The control-plane pathway (`context host use`); inferred from baseUrl when absent. */
  host?: HostKind;
  /** The persistent worker default (`context worker use`); cascade-derived when absent or host-incompatible. */
  worker?: WorkerKind;
}

/** The `contexts.json` body: the active-context pointer + the name→endpoint map. */
export interface ContextsFile {
  /** The persisted `context use` pointer (rung 3 of the ladder); null when never set / cleared. */
  current: string | null;
  /** The named endpoints. Always includes the implicit `local` after `readContexts` seeds it. */
  contexts: Record<string, ContextEntry>;
}

/** The reserved implicit context name + its endpoint (the local `serve` default, serve-cli.ts:26-27). */
export const LOCAL_CONTEXT = 'local';
export const LOCAL_BASE_URL = 'http://127.0.0.1:5273';

/** The global home `~/.piflow` — reuses @piflow/core's `globalDir` so `PIFLOW_HOME` is honored identically. */
function homeDir(): string {
  // `globalDir` already resolves `PIFLOW_HOME ?? ~/.piflow`; the `os.homedir()` fallback is defence-in-depth
  // only (should never be reached — kept so this module is self-contained if the helper ever changes shape).
  return globalDir() ?? path.join(os.homedir(), '.piflow');
}

/** `~/.piflow/contexts.json` — the named-context registry (honors `PIFLOW_HOME`). */
export function contextsFile(): string {
  return path.join(homeDir(), 'contexts.json');
}

/** Seed the implicit `local` context if absent — mutates + returns the same object (idempotent). */
function seedLocal(file: ContextsFile): ContextsFile {
  if (!file.contexts[LOCAL_CONTEXT]) file.contexts[LOCAL_CONTEXT] = { baseUrl: LOCAL_BASE_URL };
  return file;
}

/**
 * Read `contexts.json`, tolerating an absent/corrupt file (→ a fresh `{current:null, contexts:{}}`), then
 * ALWAYS seed the implicit `local`. NEVER throws — a broken file degrades to defaults so the CLI keeps working.
 */
export function readContexts(): ContextsFile {
  let file: ContextsFile = { current: null, contexts: {} };
  const p = contextsFile();
  if (fssync.existsSync(p)) {
    try {
      const parsed = JSON.parse(fssync.readFileSync(p, 'utf8')) as Partial<ContextsFile>;
      file = {
        current: typeof parsed.current === 'string' ? parsed.current : null,
        contexts:
          parsed.contexts && typeof parsed.contexts === 'object' ? (parsed.contexts as Record<string, ContextEntry>) : {},
      };
    } catch {
      file = { current: null, contexts: {} };
    }
  }
  return seedLocal(file);
}

/** Persist `contexts.json` (mkdir -p the home first; pretty-printed + trailing newline, matching the registry). */
export async function writeContexts(file: ContextsFile): Promise<void> {
  await fs.mkdir(homeDir(), { recursive: true });
  await fs.writeFile(contextsFile(), JSON.stringify(file, null, 2) + '\n');
}

/**
 * Resolve the ACTIVE context name via the ladder: `--context` flag > `PIFLOW_CONTEXT` env > persisted `current`
 * > `'local'`. Each `??` is a rung — the order here IS the contract (the mutation test flips it). Only a
 * NON-EMPTY string counts at each rung (an empty flag/env falls through, so `--context ""` never wins).
 */
export function resolveActive(opts: { flagContext?: string } = {}): string {
  const flag = opts.flagContext?.trim() || undefined;
  const env = process.env.PIFLOW_CONTEXT?.trim() || undefined;
  const current = readContexts().current || undefined;
  return flag ?? env ?? current ?? LOCAL_CONTEXT;
}

/** Upsert a named endpoint (create or replace baseUrl/token/host/worker). Returns the mutated file for chaining. */
export function addContext(file: ContextsFile, name: string, entry: ContextEntry): ContextsFile {
  file.contexts[name] = {
    baseUrl: entry.baseUrl,
    ...(entry.token ? { token: entry.token } : {}),
    ...(entry.host ? { host: entry.host } : {}),
    ...(entry.worker ? { worker: entry.worker } : {}),
  };
  return file;
}

/**
 * Remove a named endpoint. If it was the `current` pointer, clear `current` (→ resolution falls to `local`).
 * Removing the implicit `local` is a no-op on the pointer but drops any custom override; the next read
 * re-seeds the default, so `local` can never truly be deleted. Returns the mutated file.
 */
export function removeContext(file: ContextsFile, name: string): ContextsFile {
  delete file.contexts[name];
  if (file.current === name) file.current = null;
  return file;
}

/**
 * Set the `current` pointer to `name`. THROWS if `name` is unknown (kubectl `use-context` errors on an
 * unknown name rather than silently pointing at nothing). The implicit `local` is always a valid target.
 */
export function useContext(file: ContextsFile, name: string): ContextsFile {
  if (!file.contexts[name]) {
    throw new Error(`unknown context "${name}" (known: ${Object.keys(file.contexts).sort().join(', ')})`);
  }
  file.current = name;
  return file;
}

// ── the host/worker cascade (PURE) ─────────────────────────────────────────────────────────────────
//
// Two axes: the control-plane host (where the orchestrator serves) and the worker (where each node's `pi`
// runs). They are correlated but not identical — a CLOUD control plane physically can't reach your laptop's
// local sandbox, so switching the host cascades a worker default. These are the deterministic rules the CLI
// (`context use`/`host use`/`worker use`) and the run path (`--sandbox` default) both consult.

/** `local` is the laptop; every other host kind is a remote (cloud) control plane. */
export function isCloudHost(host: HostKind): boolean {
  return host !== LOCAL_CONTEXT;
}

/** True when a context runs a remote control plane. Explicit `host` wins; else a non-loopback baseUrl ⇒ cloud. */
export function isCloudEntry(entry: ContextEntry): boolean {
  if (entry.host) return isCloudHost(entry.host);
  try {
    const h = new URL(entry.baseUrl).hostname;
    return !(h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0');
  } catch {
    return false; // an unparseable baseUrl is treated as local (the safe, no-remote default).
  }
}

/** The low-level compat rule keyed on cloud-ness: a cloud plane can't drive the `local` worker; local drives any. */
function workerOkForCloud(cloud: boolean, worker: WorkerKind): boolean {
  return cloud ? worker !== LOCAL_CONTEXT : true;
}

/** The low-level default keyed on cloud-ness: local ⇒ `local`; cloud ⇒ the top CONFIGURED cloud worker (or the
 *  top cloud worker overall as a setup-on-miss signal the caller surfaces). */
function defaultWorkerForCloud(cloud: boolean, configured: ReadonlySet<WorkerKind>): WorkerKind {
  if (!cloud) return LOCAL_CONTEXT;
  return CLOUD_WORKERS.find((w) => configured.has(w)) ?? CLOUD_WORKERS[0];
}

/** Can this control-plane host drive this worker? (For `context worker use` validation, where the host is known.) */
export function isWorkerCompatible(host: HostKind, worker: WorkerKind): boolean {
  return workerOkForCloud(isCloudHost(host), worker);
}

/**
 * The worker a host cascades to, given which cloud workers are CONFIGURED (creds present). Local host → `local`;
 * cloud host → the highest-PRECEDENCE configured cloud worker, or the top cloud worker if none is set up yet
 * (the caller prompts to set it up). `configured` is injected so this stays pure (the CLI reads env for it).
 */
export function defaultWorkerFor(host: HostKind, configured: ReadonlySet<WorkerKind>): WorkerKind {
  return defaultWorkerForCloud(isCloudHost(host), configured);
}

/**
 * Resolve a context's EFFECTIVE worker: an explicit, still-compatible `worker` is kept as-is; a missing or
 * host-incompatible one is promoted to the cascade default. `promoted` is true only when an explicit worker was
 * overridden (a cloud plane rejecting a stored `local` worker) — so the CLI can print `workers → e2b`.
 */
export function resolveWorker(
  entry: ContextEntry,
  configured: ReadonlySet<WorkerKind>,
): { worker: WorkerKind; promoted: boolean; cloud: boolean } {
  const cloud = isCloudEntry(entry);
  const stored = entry.worker;
  if (stored && workerOkForCloud(cloud, stored)) return { worker: stored, promoted: false, cloud };
  return { worker: defaultWorkerForCloud(cloud, configured), promoted: stored != null, cloud };
}
