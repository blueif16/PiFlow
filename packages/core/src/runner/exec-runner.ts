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
  ): Promise<{ result: ExecResult; killed: null | 'timeout' | 'stall' | 'tool-loop' | 'idle' }>;
}

/** Watchdog knobs handed to the exec runner. */
export interface ExecWatchdogOpts {
  /** Hard wall-clock cap for the node; on exceed → kill + `error` (killedTimeout). */
  nodeTimeoutMs: number;
  /** No stdout/stderr event for this long (0 = off) → kill + `error` (killedStall). */
  stallMs: number;
  /**
   * (REQUEST-LEVEL liveness watchdog) No stdout/stderr STREAM activity for this long (0 = off) ABORTS the
   * current pi REQUEST and RE-EXECS THE SAME command in place — a fresh request, NOT a node retry (the node's
   * retry/escalate budget in retry.ts is untouched). This is the fine-grained guard the coarse node-level
   * `nodeTimeoutMs` (tens of minutes) misses: a single gateway request that goes silent for 20-30 min was
   * previously invisible until the whole-node cap. WHY a stdout chunk is the signal (not a token stream): pi
   * emits its event stream per turn-END, not per token — even on the gateway a legitimate multi-minute think
   * is silent the WHOLE turn — so the window is GENEROUS (default ~9 min) to never cut a real mega-think, yet
   * still converts a silent 20-30 min hang into < 10 min. Bounded by `idleRequestRetries`; the node's hard
   * `nodeTimeoutMs` still caps the TOTAL wall-clock across every in-place re-exec.
   */
  idleRequestMs: number;
  /**
   * (REQUEST-LEVEL liveness) Max in-place request RE-EXECS on an idle trip before the node is surfaced
   * `killed: 'idle'` (a node error → the normal retry/escalate lanes). 0 ⇒ one shot (kill on the first idle).
   */
  idleRequestRetries: number;
  /** ms to wait after SIGTERM before SIGKILL (the kill grace). */
  killGraceMs: number;
  /**
   * (tool-loop breaker) The identical-args kill threshold — one tool called with the SAME args this many
   * times terminates the node (0 = off). This is the CONFIG knob node-lifecycle reads to arm the per-node
   * breaker; the exec runner itself does NOT detect loops (it has no parsed-event view) — it only honors the
   * `breakerSignal` the armed breaker aborts. Grouped with the other kill knobs (all live on `ctx.watchdog`).
   */
  toolLoopLimit: number;
  /**
   * (tool-loop breaker) A PER-NODE external abort trigger the exec runner honors: when it aborts, the exec is
   * killed through the SAME kill seam as the timeout/stall watchdogs and reported as `killed: 'tool-loop'`.
   * node-lifecycle arms a breaker (fed by the live event fold) that aborts it on the identical-args threshold.
   * Absent ⇒ no tool-loop kill (byte-identical to before — a test / the repair re-exec omit it).
   */
  breakerSignal?: AbortSignal;
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
 * The default exec primitive. Races `sandbox.exec` against three watchdogs: (a) a node-timeout, (b) a
 * silent-stall detector (`stallMs`, off by default — a node-level ERROR), and (c) the REQUEST-LEVEL idle
 * watchdog (`idleRequestMs`), the fine-grained guard for a gateway request that goes silent for many minutes.
 *
 * The idle watchdog is DISTINCT from stall/timeout in its CONSEQUENCE: on an idle trip it ABORTS the current
 * request and RE-EXECS THE SAME command IN PLACE (a fresh pi request, NOT a node retry — retry.ts's budget is
 * untouched), up to `idleRequestRetries` times; only when those are spent is the node surfaced `killed:'idle'`.
 * The node's hard `nodeTimeoutMs` and the tool-loop breaker span EVERY in-place re-exec (one terminal cap on
 * the total), so an idle-retry loop can never exceed the node budget.
 *
 * On any terminal trip it ABORTS the exec's `AbortSignal` — a signal-honoring provider (incl. InMemorySandbox)
 * kills the child's process group, so exec resolves (no orphan) and we report it as `killed`. A `killGraceMs`
 * liveness fallback settles/re-execs anyway if a provider IGNORES the signal (exactly the hung-gateway case
 * that motivates this watchdog), so a hung exec can neither hang the run nor deadlock the in-place retry.
 */
export const defaultExecRunner: ExecRunner = (sandbox, cmd, opts) =>
  new Promise((resolve) => {
    let settled = false;
    let trippedAs: null | 'timeout' | 'stall' | 'tool-loop' | 'idle' = null;
    let lastEventAt = Date.now();
    // `?? 0` is defensive: the production runner always fills the full watchdog, but a directly-injected
    // exec runner (tests) may pass a partial opts object — a missing idle window then reads as OFF, not NaN.
    const idleRequestMs = opts.idleRequestMs ?? 0;
    let idleRetriesLeft = Math.max(0, opts.idleRequestRetries ?? 0);
    // `restarting` = an idle abort is in flight; the currently-live attempt must be ABANDONED and a fresh one
    // started, NOT resolved. `attemptId` tags each exec so a late result from an abandoned attempt is dropped.
    let restarting = false;
    // `intervened` = the idle watchdog has aborted at least once, so this call is now in RECOVERY: a subsequent
    // attempt that fails ON ITS OWN (nonzero exit, before the idle window) is the watchdog's mess to clean up
    // (a corrupted/duplicate pi session or a still-sick gateway from our abort), NOT a genuine node error — so
    // it spends a re-exec instead of settling verbatim. Latches true; never resets (the first attempt is clean).
    let intervened = false;
    let attemptId = 0;
    let currentAc: AbortController | null = null;
    let graceTimer: NodeJS.Timeout | undefined;
    let restartGrace: NodeJS.Timeout | undefined;
    const settle = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearInterval(stallTimer);
      clearInterval(idleTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (restartGrace) clearTimeout(restartGrace);
      resolve({ result, killed: trippedAs });
    };
    const trip = (kind: 'timeout' | 'stall' | 'tool-loop' | 'idle'): void => {
      if (settled || trippedAs) return;
      trippedAs = kind;
      try { currentAc?.abort(); } catch { /* no-op */ } // real kill: a signal-honoring provider reaps the group
      // Liveness fallback: if a provider ignores the signal, settle after the kill grace anyway so a
      // hung exec never hangs the run (that path can orphan; a compliant provider's exec resolves first).
      graceTimer = setTimeout(() => settle({ stdout: '', stderr: `killed: ${kind}`, code: 124 }), opts.killGraceMs);
      graceTimer.unref?.();
    };
    // The node-level HARD cap + the legacy stall + the tool-loop breaker all SPAN every in-place re-exec (they
    // call `trip`, a terminal). `restarting` suppresses the stall check during an abort→re-exec handoff.
    const timeoutTimer = setTimeout(() => trip('timeout'), opts.nodeTimeoutMs);
    const stallTimer = opts.stallMs > 0
      ? setInterval(() => { if (!restarting && Date.now() - lastEventAt > opts.stallMs) trip('stall'); }, Math.max(25, Math.floor(opts.stallMs / 4)))
      : (setInterval(() => {}, 1 << 30) as NodeJS.Timeout); // inert sentinel cleared in settle()
    // (REQUEST-LEVEL idle) On no stream activity for `idleRequestMs`: re-exec the SAME command in place while
    // retries remain (abort the hung request → the .then/.catch or the restart-grace starts the next attempt);
    // once spent, a terminal `killed:'idle'`. Fires ON TOP of the same `lastEventAt` liveness the stall reads.
    const idleTimer = idleRequestMs > 0
      ? setInterval(() => {
          if (settled || trippedAs || restarting) return;
          if (Date.now() - lastEventAt <= idleRequestMs) return;
          if (idleRetriesLeft > 0) {
            idleRetriesLeft--;
            restarting = true;
            intervened = true; // we are now in RECOVERY — a later self-failing attempt is ours to retry, not fatal
            try { currentAc?.abort(); } catch { /* no-op */ } // signal-honoring providers reap → .then/.catch re-execs
            // Restart-grace: a hung request that IGNORES the abort would never settle its promise and thus
            // never trigger the re-exec — so start the next attempt anyway after the kill grace. The abandoned
            // promise's late result is dropped by the `attemptId` guard in `runAttempt`.
            restartGrace = setTimeout(doRestart, opts.killGraceMs);
            restartGrace.unref?.();
          } else {
            trip('idle'); // retries spent — the request is genuinely dead → a node error (retry/escalate lanes)
          }
        }, Math.max(25, Math.floor(idleRequestMs / 4)))
      : (setInterval(() => {}, 1 << 30) as NodeJS.Timeout); // inert sentinel cleared in settle()
    // (tool-loop breaker) An armed breaker (node-lifecycle, fed by the live event fold) aborts this signal on
    // the identical-args threshold → the SAME kill path as timeout/stall, reported as `killed: 'tool-loop'`.
    if (opts.breakerSignal) {
      if (opts.breakerSignal.aborted) trip('tool-loop');
      else opts.breakerSignal.addEventListener('abort', () => trip('tool-loop'), { once: true });
    }
    // ONE guarded re-exec per abandonment — reached from EITHER the aborted attempt's settle path OR the
    // restart-grace timer (whichever wins). The `restarting` flag makes it idempotent so only one fires.
    function doRestart(): void {
      if (!restarting || settled || trippedAs) return;
      restarting = false;
      if (restartGrace) { clearTimeout(restartGrace); restartGrace = undefined; }
      runAttempt();
    }
    const touch = (): void => { lastEventAt = Date.now(); };
    function runAttempt(): void {
      const myId = ++attemptId;
      const ac = new AbortController();
      currentAc = ac;
      lastEventAt = Date.now(); // reset the liveness clock at each (re-)exec start so the window is per-attempt
      const onOutcome = (result: ExecResult): void => {
        if (myId !== attemptId) return; // a stale/abandoned attempt's late result — drop it
        if (restarting && !trippedAs && !settled) { doRestart(); return; } // OUR idle abort → discard, next attempt
        if (settled || trippedAs) { settle(result); return; } // a terminal (timeout/stall/tool-loop/idle) already owns it
        // (REQUEST-LEVEL idle recovery) A watchdog intervention must NEVER convert a transient gateway hang into a
        // FATAL node error. Once we have aborted at least once, an attempt that fails ON ITS OWN — a nonzero exit
        // that arrives BEFORE the idle window (a corrupted/duplicate pi session or a still-sick gateway that our
        // own abort produced) — is treated like a silent trip: spend a remaining re-exec, else surface the terminal
        // `killed:'idle'` (classifies INFRA, greppable) CARRYING the real failing result — rather than settling it
        // verbatim as `killed:null` "nonzero exit 1", which misclassifies the hang as a node/capability error and
        // burns a whole NODE retry. The FIRST attempt (intervened===false) is untouched: a clean failure settles as-is.
        if (intervened && result.code !== 0) {
          if (idleRetriesLeft > 0) { idleRetriesLeft--; runAttempt(); return; }
          trippedAs = 'idle'; // terminal idle verdict; keep the real failing result for the stderr/exit forensics
          settle(result);
          return;
        }
        settle(result);
      };
      sandbox
        // Relay onSpawn through to the sandbox so the runner's pid-persist fires the instant the child exists.
        .exec(cmd, { signal: ac.signal, onStdout: touch, onStderr: touch, onSpawn: opts.onSpawn })
        .then((result) => onOutcome(result))
        .catch((err) => onOutcome({ stdout: '', stderr: String(err), code: 1 }));
    }
    runAttempt();
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
