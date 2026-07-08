// `finalizeRun` — the explicit, human-invoked closure of a STUCK run record. The residual gap the already-
// merged LIVE orphan-detection (`observe/read.ts`'s `isRunOrphaned`) cannot resolve on its own:
//   - a `!done` run with NO `controllerPid` recorded at all (predates the field, or died before its first
//     status write) can never be verified dead by a liveness probe — `isRunOrphaned` deliberately returns
//     false rather than guess.
//   - a `frozen:true` run (a deliberate P6 migration pause) is EXCLUDED from live detection even when its
//     controller is confirmed dead — in practice it may simply never get resumed, and a human may want to
//     force-close it anyway.
// `isRunOrphaned` computes an EPHEMERAL "reads as done" verdict live, on every read, and never touches disk.
// `finalizeRun` is the opposite: a ONE-TIME, EXPLICIT write that actually flips `.pi/run.json` so every
// future read — the live-detection path included — sees the SAME terminal record forever after.
//
// This is pure orchestration over the two primitives that already exist for exactly this: `readRunJson`
// (observe/read.ts) reads the current record, `writeStatus` (./status.js, this module's sibling) is the
// ONLY thing that ever writes a byte of `.pi/run.json` — its header explains why (serialized + atomic:
// concurrent-writer interleaving + torn-read protection). `finalizeRun` never hand-rolls a raw file write.

import { readRunJson } from '../observe/read.js';
import { writeStatus } from './status.js';
import type { RunStatus } from './status.js';

/** Options for `finalizeRun`. */
export interface FinalizeRunOpts {
  /**
   * The terminal verdict to record. Default `false` — a force-closed run is being CLOSED, not celebrated;
   * pass `true` only when the caller has independent evidence the run actually succeeded (e.g. every
   * declared artifact verified present) and merely never got its final status write.
   */
  ok?: boolean;
}

/** The outcome of a `finalizeRun` call — did it write, and if not, why. NEVER throws. */
export type FinalizeResult =
  | { wrote: true; before: RunStatus; after: RunStatus }
  | { wrote: false; reason: string };

/**
 * Finalize an EXISTING, STUCK (`!done`) run at `dir`: read its `.pi/run.json`; refuse (no write) when there
 * is nothing readable there, or when it is already `done:true` (finalize is for stuck records only — it is
 * not a way to re-stamp a run that already has a verdict). Otherwise write a terminal record via
 * `writeStatus`: `done:true`, `ok: opts.ok ?? false`, every other field (nodes, totals, controllerPid,
 * frozen, etc.) preserved VERBATIM — this closes the record, it never re-judges the run's nodes.
 */
export async function finalizeRun(dir: string, opts: FinalizeRunOpts = {}): Promise<FinalizeResult> {
  const before = await readRunJson(dir);
  if (!before) {
    return { wrote: false, reason: `finalizeRun: no readable .pi/run.json under ${dir} — nothing to finalize.` };
  }
  if (before.done) {
    return {
      wrote: false,
      reason: `finalizeRun: run "${before.run}" at ${dir} is already done:true (ok:${before.ok}) — finalize is for STUCK (!done) records only.`,
    };
  }
  const after: RunStatus = { ...before, done: true, ok: opts.ok ?? false };
  await writeStatus(dir, after);
  return { wrote: true, before, after };
}
