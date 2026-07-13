// (P3 · MUST-2) The INLINE hitl gate runtime — the post-model human pause on a PRODUCER node. UNLIKE the
// standalone `runCheckpoint` (node-lanes.ts), this does NOT finish the node: the producer already ran its
// model and node-lifecycle owns the verdict. It ASKS the human (write marker, park on the injectable wait
// seam, validate the reply) and returns an ACCEPT/REJECT decision + reason — the caller sets `st` and, on a
// reject, re-runs the producer through the retry engine. Reuses the PURE checkpoint helpers verbatim.
//
// WHY a separate function, not `runCheckpoint` (as the task first suggested): `runCheckpoint` FINISHES the
// node (finishCheckpoint stamps the record + writes a journal entry + flips the marker), and its crash-replay
// would REPLAY a `false` reject on every same-question re-attempt (the question hash is unchanged across
// attempts) → an infinite reject loop that never re-asks the human about the NEW output. The inline gate must
// re-ask each attempt, so it keeps its own thin ask-and-interpret path and journals only an ACCEPT as
// resolved. It also avoids a module cycle: node-lanes.ts imports `finishNode` FROM node-lifecycle.ts, so
// node-lifecycle.ts cannot import back from node-lanes.ts — this leaf module (importing only checkpoint.ts's
// pure helpers + the RunContext type + status.nowISO) is the one-way seam node-lifecycle can call.

import type { NodeSpec, CheckpointSpec } from '../types.js';
import type { RunContext } from './run-context.js';
import { nowISO } from './status.js';
import {
  type CheckpointReply,
  type InlineCheckpointDecision,
  buildMarker,
  validateReply,
  interpretCheckpointReply,
  writeMarker,
  readReply,
  journalCheckpoint,
} from './checkpoint.js';

/**
 * Ask the human at a producer's INLINE checkpoint and return an accept/reject DECISION (never finishes the
 * node). Writes the pending marker + journals the pending wait (crash-safety/observe), parks on the injectable
 * wait seam for an ATTENDED run (or takes the headless policy on a DETACHED run — never hangs), then
 * interprets the reply into accept/reject + a reason. On ACCEPT it flips the marker + journal to RESOLVED so
 * observe sees the gate cleared; a REJECT leaves the marker pending (a fresh re-ask rides the warm re-run).
 */
export async function runInlineCheckpoint(
  ctx: RunContext,
  node: NodeSpec,
  spec: CheckpointSpec,
): Promise<InlineCheckpointDecision> {
  const marker = buildMarker(node.id, node.label, spec, nowISO());
  await writeMarker(ctx.outDir, marker);
  await journalCheckpoint(ctx.outDir, node.id, { status: 'pending', hash: marker.hash, askedAt: marker.askedAt });

  // ASK: an ATTENDED run (`checkpointReply:'interactive'`) parks on the injectable wait seam; a DETACHED run
  // (`'default'`) takes the headless policy NOW (never hangs) — the same `checkpointReply` contract the
  // standalone lane honors. The runner is the authority: only a reply that validates against the marker ends
  // the wait.
  let reply: CheckpointReply | null = null;
  if (ctx.checkpointReply === 'interactive') {
    const deadline = spec.timeoutMs !== undefined ? Date.now() + spec.timeoutMs : Infinity;
    reply = await ctx.checkpointWait({
      run: ctx.outDir,
      nodeId: node.id,
      deadline,
      read: () => readReply(ctx.outDir, node.id),
      accept: (r) => validateReply(marker, r).ok,
    });
  }

  // RESOLVE the reply → a value + reason; else the headless SAFETY policy (`abort` ⇒ reject; `default` ⇒ take
  // the declared `default`, so an unattended run promotes on the author's chosen fallback — the never-hang law).
  let value: unknown;
  let reason: string | undefined;
  if (reply) {
    const v = validateReply(marker, reply);
    value = v.ok ? v.value : undefined;
    reason = reply.reason;
  } else if ((marker.headless ?? 'default') === 'abort') {
    return { accept: false, reason: 'checkpoint aborted: no reply and headless:abort' };
  } else {
    value = spec.default;
  }

  const decision = interpretCheckpointReply(spec, value, reason);
  if (decision.accept) {
    marker.status = 'resolved';
    await writeMarker(ctx.outDir, marker);
    await journalCheckpoint(ctx.outDir, node.id, {
      status: 'resolved',
      hash: marker.hash,
      askedAt: marker.askedAt,
      reply: value,
      resolvedAt: nowISO(),
    });
  }
  return decision;
}
