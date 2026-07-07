// P6 — the single-writer run.lock lease. A mid-run migration hands ONE run between two runner
// processes (laptop ⇄ cloud VM). The journal writer already serializes PARALLEL LANES within one
// process (journal.ts writeChains), but nothing stops TWO RUNNER PROCESSES from both writing
// `.pi/journal.json` if the frozen source runner and the resumed target runner overlap. This lease is
// that guard: a runner acquires it at start, heartbeats it between stages, and releases it on
// freeze/exit; a second runner refuses to start while a LIVE lease is held, and STEALS a lease only
// when the prior holder is provably gone (stale heartbeat OR dead pid). Windmill's `SKIP LOCKED` and
// Restate's single-processor lease are the prior art; the migration orchestrator relies on this so the
// two runners are never live at once.
//
// The lock is `${run}/.pi/run.lock`. Ownership is `(pid, host, acquiredAt)` — a stolen lease gets a new
// `acquiredAt`, so the prior holder's `renew`/`release` become no-ops (it can no longer clobber the
// new owner). Cross-host liveness can't be probed, so a foreign-host holder is only ever reclaimed via
// the ttl (heartbeat age); same-host holders also check the real pid.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import { piDir } from './layout.js';
import path from 'node:path';
import { isProcessAlive } from './liveness.js';

/** The on-disk lease identity. Timestamps are epoch-ms (a plain number, host-comparable via ttl). */
export interface LeaseInfo {
  pid: number;
  host: string;
  /** When THIS holder first acquired (or stole) the lease — the ownership key. */
  acquiredAt: number;
  /** Last heartbeat; a holder renews this between stages so a healthy runner is never mistaken for gone. */
  heartbeatAt: number;
}

/** A held lease handle — heartbeat it while running, release it on freeze/exit. */
export interface Lease {
  readonly info: LeaseInfo;
  /** Refresh the heartbeat (call between stages). No-op if this holder was already stolen. */
  renew(): Promise<void>;
  /** Drop the lock so the next runner acquires cleanly. No-op if this holder was already stolen. */
  release(): Promise<void>;
}

/** Thrown when a LIVE lease is held by another process — the migration orchestrator must wait/quiesce. */
export class LeaseHeldError extends Error {
  constructor(public readonly holder: LeaseInfo) {
    super(`run.lock is held by pid ${holder.pid} on ${holder.host} (heartbeat ${new Date(holder.heartbeatAt).toISOString()})`);
    this.name = 'LeaseHeldError';
  }
}

export interface AcquireOpts {
  /** Default `process.pid`. */
  pid?: number;
  /** Default `os.hostname()`. */
  host?: string;
  /** Epoch-ms clock; injectable so staleness is deterministic in tests. Default `Date.now`. */
  now?: () => number;
  /** Stale threshold (ms): a heartbeat older than this ⇒ the holder is presumed gone. Default 30s. */
  ttlMs?: number;
  /**
   * Liveness probe for the holder. Default: same-host holders are probed with `process.kill(pid,0)`
   * (EPERM still means alive); a foreign-host holder can't be probed, so it's assumed alive (only the
   * ttl reclaims it). Injected in tests for determinism.
   */
  isAlive?: (pid: number, host: string) => boolean;
}

const DEFAULT_TTL_MS = 30_000;

/** `${run}/.pi/run.lock` — the single-writer lease file (sibling of journal.json/run.json). */
export const lockFile = (run: string): string => path.join(piDir(run), 'run.lock');

function defaultIsAlive(pid: number, host: string): boolean {
  if (host !== os.hostname()) return true; // can't probe another machine's process table → trust the ttl
  return isProcessAlive(pid);
}

/** Read the current lease identity, or `null` if unlocked / unparseable. */
export async function readLease(run: string): Promise<LeaseInfo | null> {
  try {
    return JSON.parse(await fs.readFile(lockFile(run), 'utf8')) as LeaseInfo;
  } catch {
    return null;
  }
}

async function writeLock(run: string, info: LeaseInfo, exclusive: boolean): Promise<void> {
  const dir = piDir(run);
  await fs.mkdir(dir, { recursive: true });
  const body = JSON.stringify(info, null, 2);
  if (exclusive) {
    // Atomic create-or-fail: EEXIST means someone else holds it (or a stale lock is present).
    await fs.writeFile(lockFile(run), body, { flag: 'wx' });
  } else {
    // Steal / renew: publish atomically via temp+rename (last-writer-wins over a stale/owned lock).
    const tmp = path.join(dir, `.run.lock.${info.pid}.${info.heartbeatAt}.tmp`);
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, lockFile(run));
  }
}

/**
 * Acquire the run lease. Succeeds if the lock is free OR the current holder is provably gone (stale
 * heartbeat past `ttlMs`, or a dead same-host pid). Throws `LeaseHeldError` if a LIVE holder is present.
 */
export async function acquireLease(run: string, opts: AcquireOpts = {}): Promise<Lease> {
  const pid = opts.pid ?? process.pid;
  const host = opts.host ?? os.hostname();
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const isAlive = opts.isAlive ?? defaultIsAlive;

  const mkInfo = (): LeaseInfo => {
    const t = now();
    return { pid, host, acquiredAt: t, heartbeatAt: t };
  };

  // Fast path: no lock yet → exclusive create wins.
  try {
    const info = mkInfo();
    await writeLock(run, info, true);
    return makeLease(run, info, now);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }

  // A lock exists. Reclaim it ONLY if the holder is provably gone.
  const existing = await readLease(run);
  if (existing) {
    const stale = now() - existing.heartbeatAt > ttlMs || !isAlive(existing.pid, existing.host);
    if (!stale) throw new LeaseHeldError(existing);
  }
  // Stale, dead, or vanished-mid-read → steal via temp+rename.
  const info = mkInfo();
  await writeLock(run, info, false);
  return makeLease(run, info, now);
}

function makeLease(run: string, info: LeaseInfo, now: () => number): Lease {
  // Ownership: the lock on disk must still be THIS (pid,host,acquiredAt). If a later runner stole it,
  // our renew/release must not clobber the new owner — so both become no-ops.
  const stillOurs = async (): Promise<boolean> => {
    const cur = await readLease(run);
    return !!cur && cur.pid === info.pid && cur.host === info.host && cur.acquiredAt === info.acquiredAt;
  };
  return {
    info,
    async renew() {
      if (!(await stillOurs())) return;
      info.heartbeatAt = now();
      await writeLock(run, info, false);
    },
    async release() {
      if (!(await stillOurs())) return;
      await fs.rm(lockFile(run), { force: true });
    },
  };
}
