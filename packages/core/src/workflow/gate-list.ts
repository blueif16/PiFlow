// (gate-list-and-additive-profiles.md §a) The additive typed gate LIST — the owner-decided node gating
// surface — and its LOAD-TIME fan-out onto the machinery that already exists.
//
// A node authors `gates: GateEntry[]` (three types: `execution`/`agentic`/`hitl`). There is NO on/off
// switch; composition is append-only. This module owns ONE pure transform, `fanoutGates`, that lowers the
// list onto the three existing carriers — REUSING, never duplicating, the existing lowering:
//
//   • execution → `lowerGate` (gate-authoring.ts): a `check` predicate → an `op.gate` whose Check folds
//     into `io.checks` (the two-layer post engine); a `cmd` script → an `op.run` the runner dispatches.
//   • agentic   → the node's `judgeGate` field → `materializeJudgeNodes` inserts a real `<id>__judge` node.
//   • hitl      → the node's `checkpoint` field (the G5 human-checkpoint runtime).
//
// A node has a SINGLE judge slot and a SINGLE checkpoint slot, so at most one `agentic` and one `hitl`
// entry are allowed; a second (or a collision with a directly-authored `judgeGate`/`checkpoint`, enforced
// by the caller) is a LOUD `GateListError`. `execution` gates stack freely.
//
// FILE FENCE: additive + pure. Consumes `gate-authoring.ts` (`lowerGate`) + `runner/op-dispatch.ts`
// (`gatesFromOp`). Does NOT touch the runner, the CLI, or index.ts's runtime.

import type { OpSpec, Check } from '../types.js';
import { lowerGate, type GateAuthorSpec, type GatePolicy } from './gate-authoring.js';
import { gatesFromOp } from '../runner/op-dispatch.js';

/** Thrown when a gate list is unbuildable (a second agentic/hitl entry, or a carrier collision). Loud. */
export class GateListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateListError';
  }
}

/** ONE typed additive gate. Discriminated on `type` — mirrors `gate-entry.schema.ts` / the spec §a table. */
export type GateEntry =
  | {
      /** Deterministic — "normally always holds true": EXACTLY one of a `check` predicate or a `cmd` script. */
      type: 'execution';
      check?: string;
      path?: string;
      param?: unknown;
      advisory?: boolean;
      cmd?: string;
      args?: string[];
      cwd?: string;
      policy?: GatePolicy;
    }
  | {
      /** A judge on a DIFFERENT model. `judgeTier` MUST differ from the producer's tier (no self-judging). */
      type: 'agentic';
      judgeTier: string;
      rubric: string;
      threshold?: string;
      policy?: GatePolicy;
    }
  | {
      /** A human checkpoint (G5). Lowers to the node's `checkpoint` field. */
      type: 'hitl';
      question: string;
      checkpointKind?: 'confirm' | 'input' | 'select';
      choices?: string[];
      policy?: GatePolicy;
    };

/** The `judgeGate` shape an `agentic` entry lowers to (the existing NodeIntent.judgeGate). */
export interface FanoutJudgeGate {
  judgeTier: string;
  rubric: string;
  threshold?: string;
  policy?: GatePolicy;
}

/** The `checkpoint` shape a `hitl` entry lowers to (the existing NodeIntent.checkpoint). */
export interface FanoutCheckpoint {
  kind: 'confirm' | 'input' | 'select';
  prompt: string;
  choices?: string[];
}

/** The result of fanning out a node's `gates[]` onto the three existing carriers. */
export interface GateFanout {
  /** `op[]` entries (execution `gate`/`run` bodies + any retry action) — appended to the node's `op`. */
  ops: OpSpec[];
  /** The post `Check[]` derived from the execution gate ops — merged into the node's `io.checks`. */
  checks: Check[];
  /** (≤1) The agentic entry, as a `judgeGate` — consumed later by `materializeJudgeNodes`. */
  judgeGate?: FanoutJudgeGate;
  /** (≤1) The hitl entry, as a `checkpoint`. INLINED onto `node.gate.checkpoint` by the loader (P3). */
  checkpoint?: FanoutCheckpoint;
  /** (P3) The hitl entry's policy — carried to `node.gate.policy` for observe + the reject budget. */
  hitlPolicy?: GatePolicy;
}

/** Map one deterministic `execution` entry → the existing author-spec (`floor` for a check, `execution` for a cmd). */
function executionToAuthorSpec(entry: Extract<GateEntry, { type: 'execution' }>, nodeId: string): GateAuthorSpec {
  const hasCheck = entry.check !== undefined;
  const hasCmd = entry.cmd !== undefined;
  // The schema already enforces exactly-one; this guard keeps the pure function honest if called directly.
  if (hasCheck === hasCmd) {
    throw new GateListError(`node "${nodeId}": an execution gate needs EXACTLY one of \`check\` or \`cmd\``);
  }
  if (hasCheck) {
    return {
      kind: 'floor',
      check: entry.check!,
      ...(entry.path !== undefined ? { path: entry.path } : {}),
      ...(entry.param !== undefined ? { param: entry.param } : {}),
      ...(entry.advisory !== undefined ? { advisory: entry.advisory } : {}),
      ...(entry.policy !== undefined ? { policy: entry.policy } : {}),
    };
  }
  return {
    kind: 'execution',
    cmd: entry.cmd!,
    ...(entry.args !== undefined ? { args: entry.args } : {}),
    ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
    ...(entry.policy !== undefined ? { policy: entry.policy } : {}),
  };
}

/**
 * Fan a node's `gates[]` out onto the three existing carriers. PURE — no I/O. `execution` entries lower via
 * the existing `lowerGate` (their post Check[] is re-derived via `gatesFromOp` for `io.checks`); `agentic`
 * and `hitl` map to the single `judgeGate`/`checkpoint` slots (a second of either is a loud `GateListError`).
 */
export function fanoutGates(gates: GateEntry[], nodeId: string): GateFanout {
  const ops: OpSpec[] = [];
  let judgeGate: FanoutJudgeGate | undefined;
  let checkpoint: FanoutCheckpoint | undefined;
  let hitlPolicy: GatePolicy | undefined;
  let hasHitl = false;
  let execRetry = false; // an execution gate lowered its OWN reject retry action (its own budget)

  for (const g of gates) {
    switch (g.type) {
      case 'execution': {
        const lowered = lowerGate(executionToAuthorSpec(g, nodeId), nodeId);
        ops.push(...lowered.ops);
        if (g.policy?.onFail === 'retry') execRetry = true;
        break;
      }
      case 'agentic': {
        if (judgeGate) {
          throw new GateListError(
            `node "${nodeId}": a node may carry at most ONE agentic gate (a single judge slot) — a second was authored`,
          );
        }
        judgeGate = {
          judgeTier: g.judgeTier,
          rubric: g.rubric,
          ...(g.threshold !== undefined ? { threshold: g.threshold } : {}),
          ...(g.policy !== undefined ? { policy: g.policy } : {}),
        };
        break;
      }
      case 'hitl': {
        if (checkpoint) {
          throw new GateListError(
            `node "${nodeId}": a node may carry at most ONE hitl gate (a single checkpoint slot) — a second was authored`,
          );
        }
        hasHitl = true;
        // (P3 · MUST-2) A hitl gate INLINES on the producer: lower it through the SAME `lowerGate` human case
        // so the reject `retry` op-action rides `ops` (default warm) alongside the checkpoint patch. The
        // checkpoint + its policy travel on the fanout for the loader to attach to `node.gate` (NOT
        // `node.checkpoint` — that would route the producer to the no-pi lane before its model ever ran).
        const lowered = lowerGate(
          {
            kind: 'human',
            question: g.question,
            ...(g.checkpointKind !== undefined ? { checkpointKind: g.checkpointKind } : {}),
            ...(g.choices !== undefined ? { choices: g.choices } : {}),
            ...(g.policy !== undefined ? { policy: g.policy } : {}),
          },
          nodeId,
        );
        ops.push(...lowered.ops);
        // lowerGate's human case always returns a checkpointPatch (kind/prompt/choices).
        checkpoint = lowered.checkpointPatch!;
        if (g.policy !== undefined) hitlPolicy = g.policy;
        break;
      }
    }
  }

  // (P3 · H2 — separate budget) A hitl gate emits its OWN reject `retry` action; an execution retry-gate
  // emits ANOTHER. But `runNodeWithRetries` reads ONE `retryAction` and decrements ONE shared `retriesLeft`,
  // so the two budgets would collide (the execution's check-retries and the human's reject-retries drawing
  // down one counter, and only the FIRST action's config honored). Forbid the combination LOUDLY rather than
  // silently merge them — split the gates across nodes, or drop one gate's retry consequence.
  if (hasHitl && execRetry) {
    throw new GateListError(
      `node "${nodeId}": a hitl gate and an execution gate with onFail:'retry' cannot share ONE node — ` +
        `their retry budgets would collide on a single retriesLeft counter. Split them across nodes, or drop one gate's retry.`,
    );
  }

  // The execution gates' POST predicates feed `io.checks` (the two-layer post engine) — re-derived from the
  // lowered ops via the same `gatesFromOp` the loader's `collectChecks` uses for directly-authored op gates.
  const checks = gatesFromOp(ops).post;
  return { ops, checks, judgeGate, checkpoint, ...(hitlPolicy !== undefined ? { hitlPolicy } : {}) };
}
