// The concurrency cap (G2) — a tiny, zero-dependency counting semaphore plus the default-derivation
// helper. The runner constructs ONE limiter per run (on `ctx`) and wraps each stage lane's
// `runNodeWithRetries` call in it, so a stage never spawns more than `maxConcurrent` real `pi`
// processes at once (replacing the previously-UNBOUNDED `Promise.all` fan-out). Adapted from the
// competitor's `createLimiter` (vendor/pi-dynamic-workflows/src/workflow.ts:1008-1024) — same FIFO
// counting-semaphore shape, typed and decoupled — but the default is a fixed, OS-process-conservative
// value (each lane is a full `pi` child, heavier than the competitor's in-memory sessions), not a
// CPU-derived one.

/** A counting semaphore (FIFO). `limit(fn)` runs `fn` once a slot is free; releases on settle. */
export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/** The hard ceiling on `maxConcurrent` — a too-large configured value clamps to this. */
export const MAX_CONCURRENT = 16;

/** The DEFAULT `maxConcurrent` when none is configured — a fixed, conservative value (each lane is a real `pi`). */
export const DEFAULT_CONCURRENT = 8;

/**
 * Build a FIFO counting semaphore admitting at most `limit` concurrent `fn`s. When `active >= limit`
 * the caller parks on a queued resolver; a settling `fn` (resolve OR reject) frees its slot via the
 * `finally`-`next()` and admits the next waiter in order. The runner's lanes never reject in practice
 * (lane isolation, runner.ts), so the `finally` is defense-in-depth. A `limit < 1` is the caller's
 * job to normalize (`normalizeConcurrent`), so the constructor needs no guard.
 */
export function createLimiter(limit: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = (): void => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

/**
 * Normalize a configured `maxConcurrent` to a usable slot count. PRECEDENCE: an explicit finite
 * value ≥ 1 wins (floored, clamped to `[1, max]`); `undefined` ⇒ the fixed `DEFAULT_CONCURRENT`;
 * a 0 / negative / NaN / non-finite value ⇒ 1 (so `--max-concurrent 0` degrades to SERIAL, never to
 * "unbounded" or a deadlock). The default is a FIXED constant (not `os.cpus()`-derived): a process-
 * per-node model is heavier than the competitor's sessions, so the cap is a hard safety valve.
 */
export function normalizeConcurrent(value: number | undefined, max = MAX_CONCURRENT): number {
  const n = value === undefined ? DEFAULT_CONCURRENT : value;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(max, Math.floor(n));
}
