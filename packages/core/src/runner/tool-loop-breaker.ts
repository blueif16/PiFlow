// tool-loop-breaker.ts — the LIVE, deterministic tool-loop circuit breaker. A BACKUP guard on the critical
// path: when one tool is called with IDENTICAL args past a threshold, the run plane terminates the node —
// exactly like the timeout/silent-stall watchdogs — so a runaway loop is killed instead of grinding a node to
// context exhaustion (the wa13 failure mode: a node called one tool 15× with identical args → 159 model calls
// / 169k ctx before a hand-kill).
//
// It rides the SAME detector the post-hoc telemetry anomaly reads. Instead of a second definition of "identical
// args", it folds each streamed event through the node's OWN driver accumulator (createNodeAccumulator /
// createClaudeAccumulator — the driver-agnostic seam) and reads that reducer's `maxToolRepeat`. So the live
// kill and the `tool-loop` telemetry anomaly are ONE detector with TWO consumers (live + post-hoc), and both
// name the loop through the shared `toolLoopDetail` — the single-data-path law.
//
// It has NO kill authority of its own: on a trip it calls `onTrip`, and the caller (node-lifecycle) aborts the
// exec through the EXISTING watchdog kill seam (exec-runner's AbortController), so a tool-loop kill flows
// through the same SIGTERM→SIGKILL path as a timeout/stall.

import type { PiEvent } from './events.js';
import type { NodeAccumulator } from '../observe/distill.js';
import { toolLoopDetail } from '../observe/distill.js';

/**
 * The DEFAULT identical-args kill threshold. A DELIBERATE backstop ABOVE the advisory `tool-loop` anomaly
 * threshold (`DEFAULT_THRESHOLDS.toolRepeat = 3`, telemetry.ts): the anomaly SURFACES a loop at 3 identical-args
 * calls; this deterministic KILL only fires at 10 — so legitimate short repetition (a couple of identical
 * retries) trips the advisory surface but never the kill, and when the kill DOES fire the anomaly is already
 * showing (both read the SAME `maxToolRepeat`). wa13 ran to 15 identical calls before a hand-kill; 10 stops that
 * class well before context exhaustion while leaving generous headroom over the advisory floor.
 */
export const DEFAULT_TOOL_LOOP_LIMIT = 10;

export interface ToolLoopBreaker {
  /** Fold one streamed event; trips (once) and calls `onTrip` the instant identical-args repeat reaches `limit`. */
  push(ev: PiEvent): void;
  /** True after the breaker has tripped. */
  readonly tripped: boolean;
  /** The reason string (`<tool> called <n>× with identical args`) — the EXACT telemetry anomaly detail, or null. */
  readonly reason: string | null;
}

/**
 * Create a live tool-loop breaker over `acc` — the node's driver accumulator (the SAME reducer telemetry
 * replays post-hoc). Each `push(ev)` folds the event, reads the reducer's identical-args `maxToolRepeat`, and
 * when it reaches `limit` trips ONCE: records the reason via the shared `toolLoopDetail` and calls `onTrip`
 * (the caller aborts the exec). `limit <= 0` DISABLES the breaker (the off switch — it never accumulates and
 * never trips).
 */
export function createToolLoopBreaker(acc: NodeAccumulator, limit: number, onTrip: () => void): ToolLoopBreaker {
  let tripped = false;
  let reason: string | null = null;
  return {
    push(ev: PiEvent): void {
      if (tripped || limit <= 0) return;
      acc.push(ev);
      const m = acc.metrics();
      if (m.repeatedTool && m.maxToolRepeat >= limit) {
        tripped = true;
        reason = toolLoopDetail(m.repeatedTool, m.maxToolRepeat);
        onTrip();
      }
    },
    get tripped() { return tripped; },
    get reason() { return reason; },
  };
}
