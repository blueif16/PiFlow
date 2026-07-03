// The injectable exec/checkpoint primitives + their seam types — extracted verbatim from runner.ts
// (the §2.1 cluster B + the A-subset seam interfaces). Re-exported from runner.ts so the barrel and the
// internal-importing tests (self-correction-l1 / warm-resume-l1) keep resolving these from runner.ts.

import type { Sandbox, ExecResult } from '../types.js';
import type { CheckpointReply } from './checkpoint.js';

/** How the runner spawns the agent command — the kill-seam-bearing exec primitive (injectable). */
export interface ExecRunner {
  /**
   * Run `cmd` in `sandbox` under a node-timeout + silent-stall watchdog. Resolves with the buffered
   * result AND how it ended (`killed`). The DEFAULT races `sandbox.exec` against the timeout and, on
   * a watchdog trip, calls `killSeam` (SIGTERM→SIGKILL semantics live there) then abandons the wait —
   * so a hung exec can never hang the run. A test can inject its own to drive the watchdog offline.
   */
  (
    sandbox: Sandbox,
    cmd: string,
    opts: ExecWatchdogOpts,
  ): Promise<{ result: ExecResult; killed: null | 'timeout' | 'stall' }>;
}

/** Watchdog knobs handed to the exec runner. */
export interface ExecWatchdogOpts {
  /** Hard wall-clock cap for the node; on exceed → kill + `error` (killedTimeout). */
  nodeTimeoutMs: number;
  /** No stdout/stderr event for this long (0 = off) → kill + `error` (killedStall). */
  stallMs: number;
  /** ms to wait after SIGTERM before SIGKILL (the kill grace). */
  killGraceMs: number;
  /**
   * (per-node stop) Forwarded VERBATIM into `sandbox.exec`'s `ExecOpts.onSpawn` — fired once with the
   * spawned child's pid. The runner threads a callback here that persists the node's pid to
   * `.pi/nodes/<id>/pid.json` so a separate `--stop` can signal it. Optional/additive: an injected exec
   * runner that ignores it (a test) is unchanged, and the default just relays it to the sandbox.
   */
  onSpawn?: (pid: number) => void;
}

/** The checkpoint wait seam — polls for a reply until `accept` passes or the deadline elapses (G5). */
export interface CheckpointWaiter {
  (args: {
    run: string;
    nodeId: string;
    /** Epoch-ms deadline; `Infinity` ⇒ wait indefinitely (an attended, untimed checkpoint). */
    deadline: number;
    /** Read the current reply file (or null when absent/torn). */
    read: () => Promise<CheckpointReply | null>;
    /** True iff this reply is a VALID resolution for the marker (the runner's authority). */
    accept: (reply: CheckpointReply) => boolean;
    /** Abort promptly when the run is torn down (none today; reserved). */
    signal?: AbortSignal;
  }): Promise<CheckpointReply | null>;
}

// ── the default exec runner: race sandbox.exec against the watchdogs, kill on a trip ──────────────

/**
 * The default exec primitive. Races `sandbox.exec` against (a) a node-timeout and (b) a silent-stall
 * detector that fires when no stdout/stderr chunk arrives for `stallMs`. On a trip it ABORTS the
 * exec's `AbortSignal` — a signal-honoring provider (incl. InMemorySandbox) kills the child's process
 * group, so exec resolves (no orphan) and we report it as `killed`. A `killGraceMs` liveness fallback
 * settles anyway if a provider ignores the signal, so a hung exec can never hang the run.
 */
export const defaultExecRunner: ExecRunner = (sandbox, cmd, opts) =>
  new Promise((resolve) => {
    let settled = false;
    let trippedAs: null | 'timeout' | 'stall' = null;
    let lastEventAt = Date.now();
    const ac = new AbortController();
    let graceTimer: NodeJS.Timeout | undefined;
    const settle = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearInterval(stallTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ result, killed: trippedAs });
    };
    const trip = (kind: 'timeout' | 'stall'): void => {
      if (settled || trippedAs) return;
      trippedAs = kind;
      try { ac.abort(); } catch { /* no-op */ } // real kill: a signal-honoring provider reaps the group
      // Liveness fallback: if a provider ignores the signal, settle after the kill grace anyway so a
      // hung exec never hangs the run (that path can orphan; a compliant provider's exec resolves first).
      graceTimer = setTimeout(() => settle({ stdout: '', stderr: `killed: ${kind}`, code: 124 }), opts.killGraceMs);
      graceTimer.unref?.();
    };
    const timeoutTimer = setTimeout(() => trip('timeout'), opts.nodeTimeoutMs);
    const stallTimer = opts.stallMs > 0
      ? setInterval(() => { if (Date.now() - lastEventAt > opts.stallMs) trip('stall'); }, Math.max(25, Math.floor(opts.stallMs / 4)))
      : (setInterval(() => {}, 1 << 30) as NodeJS.Timeout); // inert sentinel cleared in settle()
    const touch = (): void => { lastEventAt = Date.now(); };
    sandbox
      // Relay onSpawn through to the sandbox so the runner's pid-persist fires the instant the child exists.
      .exec(cmd, { signal: ac.signal, onStdout: touch, onStderr: touch, onSpawn: opts.onSpawn })
      .then((result) => settle(result))
      .catch((err) => settle({ stdout: '', stderr: String(err), code: 1 }));
  });

// ── (G5) the default checkpoint waiter: poll the reply file on the watchRun cadence until valid/deadline ──

/**
 * The default checkpoint wait seam. Polls `read()` on the `watchRun` cadence (700ms) and resolves with the
 * first reply that `accept`s; resolves `null` when the deadline elapses. This is the ONLY place that sleeps
 * on real wall-clock — tests inject a fast/zero-sleep poller via `RunOptions.checkpointWait`, so the suite
 * is deterministic. A torn/missing file simply makes `read()` return null and the wait persists.
 */
export const defaultCheckpointWait: CheckpointWaiter = async ({ deadline, read, accept, signal }) => {
  const pollMs = 700;
  for (;;) {
    if (signal?.aborted) return null;
    const reply = await read();
    if (reply && accept(reply)) return reply;
    if (Date.now() >= deadline) return null;
    const remaining = deadline === Infinity ? pollMs : Math.min(pollMs, deadline - Date.now());
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.max(0, remaining));
      // NB: do NOT unref() this timer. During an ATTENDED park this poll timer is frequently the ONLY
      // pending work (e.g. a run windowed `--until <checkpoint>`, or the checkpoint being the last live
      // lane). Unref'ing it lets Node drain the event loop and EXIT (code 0) with the checkpoint still
      // `awaiting-input` — the run silently "un-parks" itself and no live process is left to accept the
      // reply. Keeping the timer REFERENCED holds the process at the gate until a valid reply arrives or
      // the deadline elapses — the intended attended-checkpoint block. (A DETACHED run never reaches here:
      // `checkpointReply:'default'` skips the wait entirely, node-lanes.ts.)
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
};
