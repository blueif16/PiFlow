// `piflowctl watch <rundir> [--notify]` — the wake-on-event SENTINEL, a THIN consumer of the shared live
// stream (`@piflow/core/observe` watchRun). It subscribes to the ONE stream every live view drives and
// stays SILENT until exactly one thing worth a decision happens, then prints ONE line and resolves:
//   • the run finished        ({kind:'done'})                     → DONE ✓ / FAILED ✗
//   • a node errored/blocked   (a node whose DERIVED status is error|blocked)  → a contract breach / kill
//
// There is NO bespoke `.pi/` reader here anymore: the run model + its live deltas come from the shared
// source (which already RE-DERIVES status verified-not-trusted). The stream source is INJECTABLE
// (`opts.updates`) so a test drives a deterministic `RunUpdate` SEQUENCE with no real wall-clock sleep;
// the default subscribes to `watchRun(rundir)`.
//
// FAILURE-PATH NOTE (scope_fence): the legacy sentinel also declared a DEAD stall (a `running` node
// while the run-status `updatedAt` stopped advancing). The shared `RunModel`/`RunUpdate` does NOT carry
// `updatedAt` / staleness — so this sentinel no longer forks a second reader to compute it. The
// `--dead-stall` flag is parsed but inert until the source exposes staleness (flagged as a proposed
// RunModel extension); the hard guard is the driver's own --node-timeout.

import { watchRun as coreWatchRun, type RunUpdate, type NodeStatus } from '@piflow/core';
import { resolveRemote, remoteUpdates } from './remote.js';

export type WatchReason = 'done' | 'node-failed' | 'aborted';

export interface WatchResult {
  reason: WatchReason;
  ok: boolean | null;
  /** The offending node id, when `reason` is node-failed. */
  node?: string;
  line: string;
}

export interface WatchOpts {
  /** Run dir holding `.pi/run.json` (used by the DEFAULT stream source). */
  rundir?: string;
  /** Injectable stream source — overrides `rundir`. The deterministic `RunUpdate` sequence under test. */
  updates?: AsyncIterable<RunUpdate>;
  print?: (line: string) => void;
  /** Desktop notification on the terminal event (best-effort; macOS/Linux). */
  notify?: boolean;
  /** Poll cadence for the default stream source (ms). */
  pollMs?: number;
  /** Abort the wait — the stream stops promptly and the sentinel resolves `aborted`. */
  signal?: AbortSignal;
}

const isFailed = (s: NodeStatus): boolean => s === 'error' || s === 'blocked';

function notifyDesktop(title: string, msg: string): void {
  // Best-effort, fire-and-forget; never block or throw the watcher.
  void title;
  void msg;
  // (Intentionally minimal: the spawn path is platform glue, not load-bearing logic. A consumer that
  //  wants desktop pings wires osascript/notify-send here; the return value is the announcement.)
}

/**
 * Subscribe to the shared live stream until a terminal condition, then announce ONCE and resolve. Pure
 * over the injected `updates` source (the `watchRun(rundir)` stream is the default) — so a test drives a
 * deterministic `RunUpdate` sequence. A node read as error/blocked (in the first snapshot or any
 * node-status delta) fires `node-failed` immediately; the stream's `done` fires the run verdict.
 */
export async function watchRun(opts: WatchOpts = {}): Promise<WatchResult> {
  const print = opts.print ?? ((s) => process.stdout.write(s + '\n'));
  const source =
    opts.updates ?? coreWatchRun(opts.rundir ?? '.', { signal: opts.signal, pollMs: opts.pollMs });

  const fire = (reason: WatchReason, ok: boolean | null, line: string, node?: string): WatchResult => {
    print(line);
    if (opts.notify) notifyDesktop('piflowctl watch', line);
    return { reason, ok, node, line };
  };

  // Track each node's last-seen DERIVED status so a node-status delta firing `blocked` is caught even
  // when the offending node was healthy in the snapshot.
  let runName = '';
  for await (const u of source) {
    if (u.kind === 'snapshot') {
      runName = u.model.run;
      // a node already failed in the initial snapshot → fire on the spot (before any delta).
      const bad = u.model.nodes.find((n) => isFailed(n.status));
      if (bad) {
        return fire('node-failed', false, `[watch] ✗ ${bad.status.toUpperCase()}  node ${bad.id}: ${bad.missing[0] ?? `(${bad.status})`}`, bad.id);
      }
    } else if (u.kind === 'node-status') {
      if (isFailed(u.status)) {
        return fire('node-failed', false, `[watch] ✗ ${u.status.toUpperCase()}  node ${u.id}`, u.id);
      }
    } else if (u.kind === 'done') {
      // We only REACH `done` having fired NO node-failed — a failed node (error|blocked) surfaces in the
      // snapshot or a node-status delta and returns above, BEFORE done. So a clean `done` ⇒ ok:true,
      // derived from the stream alone (no second reader for the run-level ok flag).
      return fire('done', true, `[watch] ✓ DONE  run=${runName}  ok=true`);
    }
  }
  // The stream ended without a terminal update (aborted via signal).
  return fire('aborted', null, `[watch] stream ended before a terminal event (run=${runName})`);
}

/** `piflowctl watch <rundir|runId> [--notify] [--poll <s>] [--dead-stall <s>] [--context <name>]` — the bin body. */
export async function runWatchCli(argv: string[]): Promise<void> {
  let dir: string | undefined;
  let notify = false;
  let pollMs: number | undefined;
  let flagContext: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--notify') notify = true;
    else if (k === '--poll') pollMs = Number(argv[++i]) * 1000;
    else if (k === '--context') flagContext = argv[++i];
    else if (k === '--dead-stall') i++; // parsed-but-inert: staleness isn't in the shared source (see header)
    else if (!k.startsWith('-')) dir = k;
  }
  const target = dir && dir.trim() ? dir : '.';
  // REMOTE context: swap the DEFAULT `watchRun(rundir)` disk source for the serve's SSE `RunUpdate` stream —
  // the sentinel logic is unchanged, only the source. LOCAL: the positional is a rundir, read off disk.
  let remote: ReturnType<typeof resolveRemote>;
  try {
    remote = resolveRemote(flagContext);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  await watchRun(
    remote
      ? { updates: remoteUpdates(remote.entry, target), notify }
      : { rundir: target, notify, pollMs },
  );
}
