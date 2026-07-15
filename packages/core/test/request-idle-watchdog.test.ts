// The REQUEST-LEVEL idle liveness watchdog (packages/core/src/runner/exec-runner.ts defaultExecRunner).
//
// WHY: the only pre-existing timeout was the coarse node-level `nodeTimeoutMs` (tens of minutes), so a single
// pi/gateway REQUEST that went silent for 20-30 min was invisible until the whole-node cap (run 260714-02 lost
// ~98 min to silent gateway hangs). The idle watchdog aborts a request that produces ZERO stream activity for
// `idleRequestMs` and RE-EXECS THE SAME command IN PLACE — a fresh request, NOT a node retry (retry.ts's budget
// is never touched: these re-execs all happen inside ONE `defaultExecRunner` call, which returns a single
// result to `runNodeWithRetries`). Only when `idleRequestRetries` are spent does it surface `killed:'idle'`.
//
// The liveness signal is a stdout/stderr chunk (pi emits per turn-END, not per token), so every fixture drives
// the watchdog through onStdout activity vs silence — never a real run.
//
// Run: npx vitest run packages/core/test/request-idle-watchdog.test.ts

import { describe, it, expect } from 'vitest';
import { defaultExecRunner } from '../src/runner/index.js';
import type { Sandbox, ExecOpts, ExecResult } from '../src/types.js';

/** One scripted exec behaviour — resolves/never-resolves the exec, given its opts (signal + onStdout). */
type Behaviour = (opts: ExecOpts | undefined, resolve: (r: ExecResult) => void) => void;

/** A Sandbox whose Nth `exec` runs the Nth scripted behaviour (the last one repeats), recording every cmd. */
function scriptedSandbox(behaviours: Behaviour[]): { sandbox: Sandbox; calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  const sandbox: Sandbox = {
    putFiles: async () => {},
    writeFile: async () => {},
    readFile: async () => '',
    downloadDir: async () => {},
    dispose: async () => {},
    exec: (cmd: string, opts?: ExecOpts): Promise<ExecResult> =>
      new Promise<ExecResult>((resolve) => {
        calls.push(cmd);
        behaviours[Math.min(n, behaviours.length - 1)](opts, resolve);
        n++;
      }),
  };
  return { sandbox, calls };
}

// ── behaviours ────────────────────────────────────────────────────────────────────────────────────────
/** Emit a stream chunk immediately, then finish clean — a live, responsive request. */
const active: Behaviour = (opts, resolve) => {
  opts?.onStdout?.('{"type":"turn_end"}\n');
  setTimeout(() => resolve({ stdout: 'ok', stderr: '', code: 0 }), 5);
};
/** Never emit anything; resolve `killed` ONLY when the watchdog aborts (a signal-HONORING silent request). */
const silentHonoring: Behaviour = (opts, resolve) => {
  opts?.signal?.addEventListener('abort', () => resolve({ stdout: '', stderr: 'killed', code: 124 }), { once: true });
};
/** Never emit AND never resolve — even on abort (a HUNG request that ignores the signal, the gateway case). */
const silentIgnoring: Behaviour = () => { /* the promise stays pending forever */ };
/**
 * Resolve FAST with a nonzero exit and ZERO stream activity — a re-exec that dies on its own (before the idle
 * window), the real-world case where our own abort corrupted pi's session / the gateway is still sick so the
 * re-run exits 1 immediately. The pre-fix watchdog settled THIS as the node's terminal result (killed=null,
 * exit 1) — converting a transient gateway hang into a fatal node error — instead of spending a re-exec.
 */
const failFast: Behaviour = (_o, resolve) => { setTimeout(() => resolve({ stdout: '', stderr: 'boom', code: 1 }), 5); };

const WATCHDOG = { nodeTimeoutMs: 10_000, stallMs: 0, killGraceMs: 20, toolLoopLimit: 0 };

describe('request-level idle watchdog — in-place re-exec, not a node retry', () => {
  it('aborts a silent request and RE-EXECS the SAME command in place; the live re-exec finishes clean (killed=null)', async () => {
    const { sandbox, calls } = scriptedSandbox([silentHonoring, active]);
    const { result, killed } = await defaultExecRunner(sandbox, 'pi run node-x', {
      ...WATCHDOG, idleRequestMs: 40, idleRequestRetries: 2,
    });
    // The first (silent) request was aborted at the idle window and the SAME command re-run in place; the
    // second request streamed activity and exited 0. ONE defaultExecRunner call → no node retry was spent.
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c === 'pi run node-x')).toBe(true);
    expect(killed).toBeNull();
    expect(result.code).toBe(0);
  });

  it('surfaces killed="idle" only after EVERY in-place re-exec stays silent (retries exhausted)', async () => {
    const { sandbox, calls } = scriptedSandbox([silentHonoring]); // always silent
    const { killed } = await defaultExecRunner(sandbox, 'pi run node-y', {
      ...WATCHDOG, idleRequestMs: 40, idleRequestRetries: 2,
    });
    // 1 initial + 2 in-place re-execs = 3 silent requests, then the terminal idle kill.
    expect(calls.length).toBe(3);
    expect(killed).toBe('idle');
  });

  it('a HUNG request that ignores the abort still re-execs (the restart-grace fallback), never deadlocking', async () => {
    const { sandbox, calls } = scriptedSandbox([silentIgnoring, active]);
    const { killed, result } = await defaultExecRunner(sandbox, 'pi run node-z', {
      ...WATCHDOG, idleRequestMs: 40, idleRequestRetries: 2,
    });
    // The first request never resolved even after abort; the restart-grace timer started the next attempt
    // anyway, which finished clean. The abandoned attempt's (never-arriving) result is dropped by attemptId.
    expect(calls.length).toBe(2);
    expect(killed).toBeNull();
    expect(result.code).toBe(0);
  });

  it('a re-exec that DIES FAST after an idle abort is NOT surfaced as a fatal node error — it spends the remaining re-execs, then a terminal killed="idle"', async () => {
    // The Case-B regression (run 260714-02 w2-scaffold): the watchdog aborted a silent request, the in-place
    // re-exec exited 1 immediately (a corrupted/duplicate session, or a still-sick gateway), and the pre-fix
    // runner SETTLED that exit-1 as the node result (killed=null) — a fatal "nonzero exit 1" that then burned a
    // whole NODE retry. A watchdog intervention must NEVER convert a transient hang into a fatal node error:
    // once we have intervened, a self-failing attempt spends a re-exec, and only exhaustion yields killed:'idle'.
    const { sandbox, calls } = scriptedSandbox([silentHonoring, failFast, failFast]);
    const { killed, result } = await defaultExecRunner(sandbox, 'pi run node-ff', {
      ...WATCHDOG, idleRequestMs: 40, idleRequestRetries: 2,
    });
    // 1 silent (aborted) + 2 in-place re-execs (each died fast) = 3 attempts, then the terminal idle verdict.
    expect(calls.length).toBe(3);
    expect(killed).toBe('idle');       // classified INFRA (transient gateway hang), NOT killed=null "exit 1".
    expect(result.code).not.toBe(0);   // the real failing result is preserved, but TAGGED as the idle terminal.
  });

  it('a re-exec that RECOVERS after an idle abort settles clean even though the first re-exec died fast', async () => {
    // Robustness: a self-failing re-exec must not abandon the recovery — the NEXT re-exec can still succeed.
    const { sandbox, calls } = scriptedSandbox([silentHonoring, failFast, active]);
    const { killed, result } = await defaultExecRunner(sandbox, 'pi run node-rec', {
      ...WATCHDOG, idleRequestMs: 40, idleRequestRetries: 2,
    });
    expect(calls.length).toBe(3);
    expect(killed).toBeNull();
    expect(result.code).toBe(0);
  });

  it('a FIRST attempt that fails on its own (no watchdog intervention) settles as-is — byte-identical to pre-watchdog', async () => {
    // NEGATIVE CONTROL: the intervened-recovery path must NOT hijack a plain, un-aborted first-attempt failure
    // (a genuine node error) — that still surfaces verbatim (killed=null, its exit code), no re-exec.
    const { sandbox, calls } = scriptedSandbox([failFast]);
    const { killed, result } = await defaultExecRunner(sandbox, 'pi run node-firstfail', {
      ...WATCHDOG, idleRequestMs: 40, idleRequestRetries: 2,
    });
    expect(calls.length).toBe(1);
    expect(killed).toBeNull();
    expect(result.code).toBe(1);
  });

  it('records each watchdog ACTION via onWatchdog (fired-at surface: silence measured + attempt # + re-exec cause)', async () => {
    // DO#3: a re-exec must be visible in the node event stream, not reconstructed from a pi "Unhandled stop
    // reason: abort". Drive the Case-B shape (1 silent abort → 2 fast-failing re-execs → terminal) and assert
    // the watchdog narrates it: an idle-abort (with a real silence measurement), then a refail, then exhaustion.
    const seen: { action: string; silenceMs: number; attempt: number; retriesLeft: number; code?: number }[] = [];
    const { sandbox } = scriptedSandbox([silentHonoring, failFast, failFast]);
    const { killed } = await defaultExecRunner(sandbox, 'pi run node-tel', {
      ...WATCHDOG, idleRequestMs: 40, idleRequestRetries: 2, onWatchdog: (ev) => seen.push(ev),
    });
    expect(killed).toBe('idle');
    const actions = seen.map((e) => e.action);
    expect(actions).toEqual(['idle-abort', 'idle-refail', 'idle-exhausted']);
    expect(seen[0].silenceMs).toBeGreaterThan(40);   // the abort carries a REAL measured silence, not a placeholder
    expect(seen[0].retriesLeft).toBe(1);             // one re-exec remained after the first abort
    expect(seen[1].code).toBe(1);                    // the refail names the failing exit code
    expect(seen[2].code).toBe(1);                    // exhaustion preserves the failing exit code
  });

  it('emits NO watchdog actions when the request is healthy (a clean first attempt)', async () => {
    const seen: unknown[] = [];
    const { sandbox } = scriptedSandbox([active]);
    await defaultExecRunner(sandbox, 'pi run node-clean', {
      ...WATCHDOG, idleRequestMs: 40, idleRequestRetries: 2, onWatchdog: (ev) => seen.push(ev),
    });
    expect(seen).toEqual([]);
  });

  it('is OFF when idleRequestMs=0: a silent request is left to the node-level cap, no in-place re-exec', async () => {
    const { sandbox, calls } = scriptedSandbox([
      // resolve clean shortly after start WITHOUT any stream activity — idle would trip if it were armed.
      (_o, resolve) => setTimeout(() => resolve({ stdout: 'done', stderr: '', code: 0 }), 80),
    ]);
    const { killed } = await defaultExecRunner(sandbox, 'pi run node-off', {
      ...WATCHDOG, idleRequestMs: 0, idleRequestRetries: 2,
    });
    expect(calls.length).toBe(1); // no re-exec — the watchdog was disabled
    expect(killed).toBeNull();
  });
});
