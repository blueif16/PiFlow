// The retry/escalate FSM (cluster G) — runNodeWithRetries, the bounded retry-by-failure-class +
// escalate-with-evidence runtime around `runNode`. Extracted verbatim from runner.ts. It imports
// `RunContext` from the leaf ./run-context.js and `runNode` from ./node-lifecycle.js — a one-way edge
// into the lifecycle module (RISK 2: no import points back at runner.ts).

import type { NodeSpec, RunScope, RetrySpec, FailureClass } from '../types.js';
import type { RunContext } from './run-context.js';
import { classifyFailure, consultPreamble, legacyRetry } from '../checks.js';
import { resolveNodeModel, type EffectiveModel } from './model-routing.js';
import { actionsFromOp } from './op-dispatch.js';
import { writeStatus, type NodeStatusRecord } from './status.js';
import { runNode } from './node-lifecycle.js';

/**
 * (G12 — M4) The trigger-action runtime — the bounded retry-by-failure-class + escalate-with-evidence
 * lanes around `runNode`, ported from run.mjs `runNodeWithEscalation`. ADDITIVE: a node that declares
 * NEITHER `io.retry` NOR `io.escalate` runs `legacyRetry(io.retries)` — today's EXACT semantics (max
 * extra attempts on a transient error/blocked, classes ['infra','degenerate']; no escalation).
 *
 * On each failed attempt the runner DERIVES a `FailureClass` from the signals `runNode` captured (never a
 * self-score) and routes: `halt` → stop immediately (escalation can't manufacture a missing input);
 * a same-model `retry` while the class is in the retry set AND budget remains; else, once the retry
 * budget is spent (or `escalate.after` is reached), ONE cross-family `escalate` on the stronger
 * `escalate.tier`/`escalate.model`-resolved model fed `consultPreamble` evidence. The last attempt wins.
 */
export async function runNodeWithRetries(ctx: RunContext, node: NodeSpec, scope: RunScope): Promise<NodeStatusRecord> {
  const retry: RetrySpec = node.io.retry ?? legacyRetry(node.io.retries);
  const escalate = node.io.escalate;
  const retryAllows = (cls: FailureClass): boolean => (retry.on ? retry.on.includes(cls) : cls !== 'halt');
  const escAllows = (cls: FailureClass): boolean => (escalate?.on ? escalate.on.includes(cls) : cls !== 'halt');

  // ── (SA-D · expert-representations) L1 / L2 / L3 self-correction wiring ─────────────────────────
  //
  // SA-B (gate-authoring.ts:359–365) emits `op.action { kind:'retry', scope:'feedback'|'fix', max }` as
  // canonical op[] entries on the node. We read them here ONCE and use them to override/supplement the
  // per-node `io.retry`/`io.retries` budget with the gate's feedback-aware semantics.
  //
  // L1 (scope:'feedback', DEFAULT, BUILD): on each failed attempt, inject the gate's critique — the
  // EMPIRICAL failure evidence (`consultPreamble`) — into the retry attempt. This is Reflexion / Self-Refine
  // semantics: the producer receives its failure reason and is asked to fix it. The feedback MUST reach the
  // retry attempt; a blind same-input retry is the WRONG default.
  //
  // (P2 · unified gate policy) The retry action carries a `session` knob (`GatePolicy.session`) that picks
  // HOW the feedback is delivered, DECOUPLED from the mere presence of the action:
  //   • warm (DEFAULT — RESUME): resume the per-node pi session (id = the node id) so the producer continues
  //     its OWN conversation, the critique delivered as the next turn (`resumeSessionId` → `--session <id>` +
  //     a FEEDBACK-ONLY prompt). Warm is HONORED only where the session dir persists across attempts (in-place/
  //     local); on every other provider `runNode` ignores it and stays cold.
  //   • cold (RERUN): a fresh pi process, the full resolved prompt re-sent with the critique PREPENDED (no
  //     `resumeSessionId`). This is the only path pre-P2 offered; it is now selectable independently.
  //
  // L2 (scope:'fix') — STUB. When the gate emits `scope:'fix'`, the intended behavior is:
  //   1. Infer the problem class from the failure signals (classifyFailure already does this).
  //   2. Consult the per-workflow fix/issue memory (a run-scoped, recorded structure — NOT yet built).
  //   3. Patch THIS node's prompt/tool-wiring for this run instance ONLY (ephemeral, recorded).
  //   4. Resume with the patched node — still a cold re-invocation until warm-resume lands.
  //   Best-effort, no guarantee. Promotion of the patch to the template = L3 (held-out check + human gate).
  //   Reference: docs/research/2026-06-28-loop-engineering-self-improving-systems.md (loop engineering,
  //   §"Memory-augmented loops" / "Reflexion" / "per-run fix memory"); build-spec §Self-correction.
  //   Owned by SA-D + the memory system. NOT YET IMPLEMENTED — falls through to L1 feedback for now.
  //
  // L3 — STUB. Between-run DAG-level optimization (patch promotion to template, held-out check, human
  //   gate). Owned by Hermes / `piflow-enhance` (between-runs, human-gated). NOT in scope for SA-D.
  //   Reference: docs/design/expert-representations-build-spec.md §Self-correction (decision 6).
  const { retryAction } = actionsFromOp(node.op);
  // Determine the effective retry budget: the op[] action op's `max` wins over `io.retry`/`io.retries`
  // when a gate-authored retry action is present (the gate author set an explicit budget).
  const opRetryMax = retryAction?.max;
  const effectiveRetryMax = opRetryMax !== undefined ? Math.max(0, opRetryMax) : Math.max(0, retry.max);
  // Only L1 (scope:'feedback') and the default (undefined = 'feedback') are wired. L2 (scope:'fix') stubs
  // through to L1 feedback: the scope is read, logged implicitly via the seam comment, but NOT executed.
  const l1Active = retryAction !== undefined && (retryAction.scope === 'feedback' || retryAction.scope === undefined || retryAction.scope === 'fix');
  // ── end SA-D wiring header ─────────────────────────────────────────────────────────────────────────

  // (TRUTHFUL DURATION — run 260710-02) Every `runNode` call re-stamps `rec.startedAt`/`durationMs` to its
  // OWN attempt, so a node that CRASHED-then-RECOVERED reports only its LAST attempt's time — silently
  // dropping every earlier (crashed) attempt's wall-clock from run.json and thus from telemetry/optimize/
  // triage (gameplay recorded 1147s of a real 3204s span; w4-m2 512s of 1019s). Capture the node's TRUE
  // start before ANY attempt and, IFF more than one attempt runs, re-stamp the terminal record to the true
  // span (first attempt's start → now, INCLUDING backoff/recovery between attempts). Single-attempt nodes
  // are byte-identical (the guard below never fires), so the happy path is untouched.
  const nodeT0 = Date.now();

  let rec = await runNode(ctx, node, scope);
  const firstStartedAt = rec.startedAt;
  let retriesLeft = opRetryMax !== undefined ? effectiveRetryMax : Math.max(0, retry.max);
  let escalatedYet = false;
  // `escalate.after` (default: after the retry budget is spent) gates how many same-model attempts run
  // before the consult. With no explicit `after`, escalation waits until `retriesLeft` reaches 0.
  let attemptsRun = 1;

  while (rec.status === 'error' || rec.status === 'blocked') {
    const sig = ctx.failureSignals.get(node.id);
    if (!sig) break; // no captured signals (e.g. a pre-exec bind/stage error) — nothing to classify.
    const cls = classifyFailure(sig);
    if (cls === 'halt') break; // a missing upstream input — refuse to spin a retry/escalate.

    const afterReached = escalate?.after !== undefined ? attemptsRun >= escalate.after : retriesLeft <= 0;
    if (retriesLeft > 0 && retryAllows(cls) && !(escalate && afterReached && escAllows(cls))) {
      retriesLeft--;
      attemptsRun++;
      if (l1Active) {
        // L1 — scope:'feedback': inject the gate critique into the retry. consultPreamble builds a
        // DRIVER-VERIFIED evidence block (missing artifacts, schema errors, failed checks, stderr tail,
        // watchdog kills) — NEVER a model self-score. The producer sees EXACTLY what failed and is asked to
        // fix it. This is the Reflexion / Self-Refine pattern.
        //
        // L2 NOTE: if retryAction.scope === 'fix', the fix memory lookup would happen HERE before invoking
        // runNode — patch the node's prompt/tool-wiring, then call runNode with the patched node. The stub
        // falls through to feedback (same evidence prefix); `scope` is orthogonal to the `session` knob below.
        //
        // (P2 · unified gate policy) RESUME(warm) vs RERUN(cold) is chosen from the retry action's `session`
        // knob — NOT the mere PRESENCE of the action (the pre-P2 conflation made "cold + feedback" unrequestable).
        //   • warm (DEFAULT, RESUME): set `resumeSessionId` = the node id → `runNode` emits `--session <id>` and a
        //     FEEDBACK-ONLY prompt; the producer continues its OWN conversation (§4c). Preserves pre-P2 behavior
        //     (an authored retry action with no `session` defaults warm here via `!== 'cold'`).
        //   • cold (RERUN): leave `resumeSessionId` unset → `runNode` re-runs fresh, the full resolved prompt
        //     re-sent with the critique PREPENDED (a new session, not a resume).
        // The warm path is HONORED only where the session dir persists across attempts (in-place/local); on every
        // other provider `runNode` ignores `resumeSessionId` and stays cold (`--no-session`) regardless.
        // Escalation (the branch below) NEVER sets it, so a model swap stays cold (§4d).
        const warm = retryAction?.session !== 'cold';
        rec = await runNode(ctx, node, scope, {
          promptPrefix: consultPreamble(sig),
          ...(warm ? { resumeSessionId: node.id } : {}),
        });
      } else {
        // Same-model retry: a FRESH attempt (re-seed + re-exec), no consult prefix, the node's own model.
        rec = await runNode(ctx, node, scope);
      }
    } else if (escalate && !escalatedYet && escAllows(cls)) {
      // Cross-family CONSULT: resolve the stronger target through model-routing, prepend the verified
      // evidence. ONE escalation only (a second would just re-spend on the same class).
      escalatedYet = true;
      attemptsRun++;
      let eff: EffectiveModel;
      try {
        eff = resolveNodeModel(
          { model: escalate.model, tier: escalate.tier },
          { model: ctx.model, provider: ctx.providerName, tiers: ctx.modelRouting.tiers, modelsIndex: ctx.modelRouting.modelsIndex },
        );
      } catch {
        break; // an unresolvable escalation tier ⇒ keep the failed record (loud via its own issue).
      }
      rec = await runNode(ctx, node, scope, { promptPrefix: consultPreamble(sig), model: eff.model, provider: eff.provider });
    } else {
      break; // budget spent and no escalation applies — the failed record stands.
    }
  }

  // (TRUTHFUL DURATION) The node needed a retry/escalate — the terminal `rec` carries only the WINNING
  // attempt's startedAt/durationMs. Re-stamp it to the node's true wall-clock (first attempt → now) so the
  // crashed attempts' time is never invisible, then persist so run.json + every downstream instrument read
  // the honest number. Guarded on >1 attempt: a clean single-attempt node keeps its exact prior record.
  if (attemptsRun > 1) {
    if (firstStartedAt) rec.startedAt = firstStartedAt;
    rec.durationMs = Date.now() - nodeT0;
    await writeStatus(ctx.outDir, ctx.status);
  }
  return rec;
}
