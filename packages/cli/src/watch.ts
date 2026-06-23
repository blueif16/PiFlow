// `piflow watch <rundir> [--notify]` — the wake-on-event SENTINEL over the engine-owned `.pi/` run
// layout. It polls `.pi/run.json` (via @piflow/core's `runJsonFile` helper — NEVER a hardcoded path,
// NEVER the legacy `run-status.json`) and stays SILENT until exactly one thing worth a decision
// happens, then prints ONE line and resolves:
//   • the run finished        (done:true)                        → DONE ✓ / FAILED ✗
//   • a node errored/blocked   (status:error|blocked)            → a contract breach / kill
//   • a node DEAD-stalled      (status:running, run-status went stale past the dead-stall threshold)
//
// Why it exists: a console/agent that launched the run in the background wants to be pinged ONLY on
// the event that needs it — so it produces no context spam until then. The poll source is INJECTABLE
// (`opts.poll`) so tests drive a deterministic snapshot SEQUENCE with no real wall-clock sleep; the
// default source reads the file off disk.
//
// Stall taxonomy (the baked-in lesson from watch.mjs): the cheap-model provider can go fully silent
// for ~60–90s — a transient pause that self-recovers. So this only declares a DEAD stall after the
// run-status stops advancing for `deadStallMs` (default 10 min), well past any transient pause; the
// real hard guard is the driver's own --node-timeout.

import { promises as fs } from 'node:fs';
import { runJsonFile, type RunStatus, type NodeStatusRecord } from '@piflow/core';

export type WatchReason = 'done' | 'node-failed' | 'dead-stall' | 'driver-gone' | 'max-polls';

export interface WatchResult {
  reason: WatchReason;
  ok: boolean | null;
  /** The offending node id, when `reason` is node-failed / dead-stall. */
  node?: string;
  line: string;
}

export interface WatchOpts {
  /** Run dir holding `.pi/run.json` (used by the DEFAULT poll source). */
  rundir?: string;
  /** Injectable poll source — returns the next snapshot (or null if unreadable). Overrides `rundir`. */
  poll?: () => Promise<RunStatus | null>;
  print?: (line: string) => void;
  /** Desktop notification on the terminal event (best-effort; macOS/Linux). */
  notify?: boolean;
  /** Poll cadence for the default file source (ignored when the snapshot sequence is finite). */
  pollMs?: number;
  /** A node that's been `running` with run-status stale longer than this is a DEAD stall (default 600s). */
  deadStallMs?: number;
  /** Test seam: give up (reason:max-polls) after this many polls regardless. */
  maxPolls?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The default poll source: read + parse `.pi/run.json` off disk (null when absent/torn). */
function fileSource(rundir: string): () => Promise<RunStatus | null> {
  return async () => {
    try {
      return JSON.parse(await fs.readFile(runJsonFile(rundir), 'utf8')) as RunStatus;
    } catch {
      return null;
    }
  };
}

const isFailed = (n: NodeStatusRecord): boolean => n.status === 'error' || n.status === 'blocked';

function notifyDesktop(title: string, msg: string): void {
  // Best-effort, fire-and-forget; never block or throw the watcher.
  void title;
  void msg;
  // (Intentionally minimal: the spawn path is platform glue, not load-bearing logic. A consumer that
  //  wants desktop pings wires osascript/notify-send here; the return value is the announcement.)
}

/**
 * Poll until a terminal condition, then announce ONCE and resolve. Pure over the injected `poll`
 * source (the file source is the default) — so a test drives a deterministic snapshot sequence.
 */
export async function watchRun(opts: WatchOpts = {}): Promise<WatchResult> {
  const print = opts.print ?? ((s) => process.stdout.write(s + '\n'));
  const poll = opts.poll ?? fileSource(opts.rundir ?? '.');
  const pollMs = opts.pollMs ?? 20_000;
  const deadStallMs = opts.deadStallMs ?? 600_000;
  // When the caller INJECTS a poll source, that source's snapshot SEQUENCE is the clock — drive polls
  // back-to-back with no wall-clock wait (deterministic, no real timer in tests), and bound the loop so
  // a finite, non-terminating sequence stops cleanly (max-polls) instead of spinning forever. The
  // default file source paces itself with the real `pollMs` and runs unbounded unless the caller caps it.
  const injected = opts.poll != null;
  const maxPolls = opts.maxPolls ?? (injected ? 10_000 : undefined);
  const waitBetween = injected ? (): Promise<void> => Promise.resolve() : (): Promise<void> => sleep(pollMs);

  const fire = (reason: WatchReason, ok: boolean | null, line: string, node?: string): WatchResult => {
    print(line);
    if (opts.notify) notifyDesktop('piflow watch', line);
    return { reason, ok, node, line };
  };

  let polls = 0;
  for (;;) {
    const s = await poll();
    polls += 1;

    if (s) {
      // 1) the run finished.
      if (s.done) {
        const tag = s.ok === false ? '✗ FAILED' : '✓ DONE';
        return fire('done', s.ok, `[watch] ${tag}  run=${s.run}  ok=${s.ok}  durationMs=${s.durationMs}`);
      }
      // 2) a node errored / blocked (contract breach) — fire BEFORE the run rolls up done.
      const bad = Object.values(s.nodes ?? {}).find(isFailed);
      if (bad) {
        const why = bad.issues?.[0] ?? bad.summary ?? `(${bad.status})`;
        return fire('node-failed', false, `[watch] ✗ ${bad.status.toUpperCase()}  node ${bad.id}: ${why}`, bad.id);
      }
      // 3) a DEAD stall — a running node while the run-status stopped advancing past the threshold.
      const running = Object.values(s.nodes ?? {}).find((n) => n.status === 'running');
      if (running) {
        const staleMs = Date.now() - new Date(s.updatedAt).getTime();
        if (Number.isFinite(staleMs) && staleMs > deadStallMs) {
          return fire(
            'dead-stall',
            null,
            `[watch] ⚠ DEAD STALL  node ${running.id} — run-status not advanced in ${Math.round(staleMs / 1000)}s`,
            running.id,
          );
        }
      }
    }

    if (maxPolls != null && polls >= maxPolls) {
      return fire('max-polls', null, `[watch] still running after ${polls} poll(s) — gave up (maxPolls)`);
    }
    await waitBetween();
  }
}

/** `piflow watch <rundir> [--notify] [--poll <s>] [--dead-stall <s>]` — the bin body. */
export async function runWatchCli(argv: string[]): Promise<void> {
  let dir: string | undefined;
  let notify = false;
  let pollMs: number | undefined;
  let deadStallMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--notify') notify = true;
    else if (k === '--poll') pollMs = Number(argv[++i]) * 1000;
    else if (k === '--dead-stall') deadStallMs = Number(argv[++i]) * 1000;
    else if (!k.startsWith('-')) dir = k;
  }
  await watchRun({ rundir: dir && dir.trim() ? dir : '.', notify, pollMs, deadStallMs });
}
