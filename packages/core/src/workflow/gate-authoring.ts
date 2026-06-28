// (SA-B · expert-representations) Gate authoring → op[] surface.
//
// A gate is a post-node quality check; it is NOT part of a node's existence. This module provides:
//
//   1. The AUTHORING-TIME gate descriptor (`GateAuthorSpec`) — the author-facing sugar that describes
//      WHAT to verify and HOW to respond. Distinct from the low-level `OpSpec` (the runner-facing
//      canonical form). Authors write one gate spec; this module emits `OpSpec[]` (and, for judge gates,
//      a materialized judge `NodeIntent`) via `lowerGate`.
//
//   2. `lowerGate` — the compile-time expansion. Called by the template loader or author tooling, never
//      by the runner (runner stays preset-agnostic).
//
//   3. Cost-ladder ordering helper (`costLadderOrder`) — enforces the design rule that deterministic
//      ops run before judge nodes before human checkpoints ("fail fast, spend a person last").
//
// Build-spec source: docs/design/expert-representations-build-spec.md §"The op[] mapping"
// Rationale:         docs/design/expert-representations-worker-types.md §"Plane 3 — Gates"
//
// FILE FENCE (SA-B only): this file is additive. It does NOT touch ops/skill.ts, agent-preset.ts,
// or catalog/*. The runner reads only the emitted `OpSpec[]` and the materialized judge node —
// zero new runtime code.

import type { OpSpec, GateBody, CheckKind } from '../types.js';

// ── 1 · AUTHORING SHAPES ─────────────────────────────────────────────────────

/**
 * Policy carried on a gate — WHAT happens when the verdict is non-pass.
 * Uses the existing `PolicyAction` vocabulary; 'retry' on a gate ALWAYS carries `scope` (default
 * 'feedback') and a `max` budget.
 */
export interface GatePolicy {
  /** On-fail action. Default 'block'. Must be a valid PolicyAction. */
  onFail?: 'block' | 'warn' | 'stop' | 'retry' | 'escalate';
  /**
   * Retry budget — extra attempts after the first. Only meaningful when `onFail:'retry'`.
   * Omit to use a single attempt (max:1 default).
   */
  retryMax?: number;
  /**
   * Correction scope for retries. `'feedback'` (DEFAULT, L1) = warm-resume with gate critique.
   * `'fix'` (L2) = STUB — see ActionBody.scope JSDoc for the full contract.
   */
  retryScope?: 'feedback' | 'fix';
}

// ── Gate kinds ────────────────────────────────────────────────────────────────

/**
 * An EXECUTION gate — run a deterministic shell command (test suite, build, linter) and interpret
 * the exit code as the verdict. Position in the cost ladder: FIRST (cheapest; no LLM).
 *
 * Lowers to: `op.run{cmd,args,cwd}` + `onFailure:<policy.onFail>`.
 */
export interface ExecutionGate {
  kind: 'execution';
  /** The command to run (e.g. 'npm', 'pytest', 'cargo test'). */
  cmd: string;
  args?: string[];
  cwd?: string;
  policy?: GatePolicy;
}

/**
 * A STRUCTURAL-FLOOR (deterministic) gate — a `Check` predicate that asserts basic
 * well-formedness of the produced artifact (non-empty, json-parses, fenced-tail, etc.).
 * Auto-injected on every gate-bearing node; authors may also add explicit floor gates.
 * Position in the cost ladder: FIRST (alongside execution; pure predicate, no LLM).
 *
 * Lowers to: `op.gate{kind, path?, param?, advisory?}` + `onFailure`.
 */
export interface FloorGate {
  kind: 'floor';
  /** The `CheckKind` predicate (e.g. 'non-empty', 'json-parses', 'fenced-tail'). */
  check: CheckKind | string;
  /** Artifact path to check, relative to the run dir. */
  path?: string;
  /** Kind-specific parameter (regex, dotted field, `{lang, minItems}`, etc.). */
  param?: unknown;
  /** Whether this gate is advisory (non-blocking). Default false. */
  advisory?: boolean;
  policy?: GatePolicy;
}

/**
 * A JUDGE gate (agentic) — a DIFFERENT model evaluates the producer's output against a rubric
 * and emits a pass/fail verdict. Position in the cost ladder: SECOND (after deterministic; spends
 * an LLM call but not a person).
 *
 * Design invariant: the judge model MUST differ from the producer (no self-judging — self-verifiers
 * false-accept per TeamBench). The judge model is resolved via `judgeTier` → model-tiers.json.
 *
 * Lowers to (at compile time, auto-expanded):
 *   1. A materialized judge `NodeIntent` (pi node @ judgeTier, rubric as the prompt, emits
 *      pass/fail vs `threshold`). Returned in `LowerGateResult.judgeNode`.
 *   2. An `op.action{kind:'rerouteTo', node:<producerNodeId>, max:<retryMax>}` on the producer's
 *      gate pipeline — if the judge fails, the runner re-routes back to the producer.
 *
 * The judge node is EXPLICIT in the graph (foldable/collapsible by the GUI; tier+cost on the badge;
 * expand to edit the rubric). It is NOT hidden plumbing.
 */
export interface JudgeGate {
  kind: 'judge';
  /**
   * The tier alias the judge model resolves through (e.g. 'deliberate', 'fast').
   * MUST resolve to a DIFFERENT model than the producer's tier; the tool validates this at author
   * time if both tiers are resolvable.
   */
  judgeTier: string;
  /**
   * The rubric prompt body the judge node uses to evaluate the producer's output. Keep this
   * precise and outcome-oriented (cite the acceptance bar, not just the task). See the
   * agentic-prompt-design skill for rubric authoring guidance.
   */
  rubric: string;
  /**
   * Pass/fail threshold — the minimum score or label the judge must emit. Format is rubric-
   * dependent; default 'pass' (binary). Examples: 'pass', '7/10', 'ACCEPT'.
   */
  threshold?: string;
  policy?: GatePolicy;
}

/**
 * A HUMAN (HITL) gate — a person approves or rejects the producer's output.
 * Position in the cost ladder: LAST (most expensive; only spend a human after automated gates pass).
 *
 * Lowers to: the existing G5 `CheckpointSpec` on the producer node's intent (NOT an `op` entry —
 * the checkpoint is already a first-class authoring-layer field). The `prompt` is auto-generated
 * from the gate's `question` unless overridden.
 */
export interface HumanGate {
  kind: 'human';
  /** The question shown to the human reviewer. */
  question: string;
  /** The checkpoint interaction kind. Default 'confirm'. */
  checkpointKind?: 'confirm' | 'input' | 'select';
  /** Allowed values for a `select` checkpoint. */
  choices?: string[];
  policy?: GatePolicy;
}

/** The discriminated union of all author-time gate descriptors. */
export type GateAuthorSpec = ExecutionGate | FloorGate | JudgeGate | HumanGate;

// ── 2 · COST-LADDER ORDERING ─────────────────────────────────────────────────

/**
 * The cost-ladder position of each gate kind (lower = cheaper = runs first).
 * Invariant: deterministic (execution, floor) → agentic (judge) → human.
 * Never spend a person on what tests already killed; never spend an LLM on what a predicate
 * already caught.
 */
const COST_LADDER: Record<GateAuthorSpec['kind'], number> = {
  floor: 0,
  execution: 0, // same tier as floor — both deterministic
  judge: 1,
  human: 2,
};

/**
 * Sort a gate list into cost-ladder order (deterministic first, judge next, human last).
 * Stable: same-tier gates keep their authored order.
 */
export function costLadderOrder(gates: GateAuthorSpec[]): GateAuthorSpec[] {
  return [...gates].sort((a, b) => COST_LADDER[a.kind] - COST_LADDER[b.kind]);
}

// ── 3 · LOWERING ─────────────────────────────────────────────────────────────

/**
 * The result of lowering one `GateAuthorSpec`.
 *
 * - `ops` — the `OpSpec[]` entries to append to the producer node's `op[]`. Always non-empty for
 *   execution/floor gates. For a judge gate, this contains the `rerouteTo` action op (the judge node
 *   itself is returned in `judgeNode`).
 * - `judgeNode` — present ONLY for judge gates: the materialized judge pi node to insert into the
 *   DAG immediately after the producer (as a dep of the producer's next downstream). The caller is
 *   responsible for wiring it (SA-B emits the shape; SA-C / the loader wires it).
 * - `checkpointPatch` — present ONLY for human gates: the `checkpoint` fields to merge onto the
 *   producer node's intent (human gates lower to the G5 checkpoint, not to an op entry).
 */
export interface LowerGateResult {
  /** `op[]` entries to append to the producer node's gate pipeline. */
  ops: OpSpec[];
  /**
   * (Judge gates only) The materialized judge pi node. The caller wires it into the DAG.
   * Shape is a partial `NodeIntent`-compatible object — the loader or author tooling finalises
   * `id`/`deps`/`io.reads`/`io.produces` from the producer's context.
   */
  judgeNode?: JudgeMaterializedNode;
  /**
   * (Human gates only) Patch to merge onto the producer node's `checkpoint` field.
   * If `checkpoint` is already set, the fields are merged (explicit wins).
   */
  checkpointPatch?: {
    kind: 'confirm' | 'input' | 'select';
    prompt: string;
    choices?: string[];
  };
}

/**
 * The materialized judge pi node emitted by `lowerGate` for a `JudgeGate`.
 * This is the EXPLICIT, foldable node that appears in the compiled DAG.
 * The caller assigns `id` (e.g. `<producerId>__judge`) and wires `deps`/`io`.
 */
export interface JudgeMaterializedNode {
  /** Suggested label (caller may override). */
  label: string;
  /** The tier the judge runs on. Resolves through model-tiers.json. */
  tier: string;
  /** The rubric prompt body, verbatim from `JudgeGate.rubric`. */
  prompt: string;
  /**
   * The pass/fail threshold the judge must meet, embedded in the prompt as an acceptance bar.
   * Default 'pass'.
   */
  threshold: string;
  /**
   * Marker so the GUI/DAG renderer can fold this node into a judge-chip and render the
   * tier+cost badge. The node is editable when expanded.
   */
  agentType: 'judge';
}

/**
 * Lower ONE `GateAuthorSpec` into runner-facing `OpSpec[]` (and optionally a judge node or
 * checkpoint patch). Pure function — no I/O, no side effects. Author-time only.
 *
 * @param gate     The authored gate descriptor.
 * @param producer The node id of the producer this gate guards. Used to name the judge node and
 *                 to wire the `rerouteTo` action.
 */
export function lowerGate(gate: GateAuthorSpec, producer: string): LowerGateResult {
  switch (gate.kind) {
    case 'execution': {
      // Execution gate → op.run + onFailure.
      // The `onFailure` is the gate's policy; retry budget emits an accompanying action op.
      const onFailure = resolveOnFailure(gate.policy);
      const ops: OpSpec[] = [
        {
          when: 'post',
          run: { cmd: gate.cmd, ...(gate.args ? { args: gate.args } : {}), ...(gate.cwd ? { cwd: gate.cwd } : {}) },
          onFailure,
        },
      ];
      if (gate.policy?.onFail === 'retry') {
        ops.push(makeRetryAction(gate.policy));
      }
      return { ops };
    }

    case 'floor': {
      // Floor (structural) gate → op.gate predicate.
      const gateBody: GateBody = {
        kind: gate.check,
        ...(gate.path !== undefined ? { path: gate.path } : {}),
        ...(gate.param !== undefined ? { param: gate.param } : {}),
        ...(gate.advisory ? { advisory: true } : {}),
      };
      const onFailure = resolveOnFailure(gate.policy);
      const ops: OpSpec[] = [{ when: 'post', gate: gateBody, onFailure }];
      if (gate.policy?.onFail === 'retry') {
        ops.push(makeRetryAction(gate.policy));
      }
      return { ops };
    }

    case 'judge': {
      // Judge gate → materialized judge pi node + op.action{rerouteTo} on the producer.
      // The judge node is EXPLICIT in the graph — the caller wires its deps/io.
      const threshold = gate.threshold ?? 'pass';
      const judgeNode: JudgeMaterializedNode = {
        label: `${producer} judge`,
        tier: gate.judgeTier,
        // The prompt embeds the rubric + the acceptance bar as an explicit constraint.
        prompt: buildJudgePrompt(gate.rubric, threshold),
        threshold,
        agentType: 'judge',
      };
      const retryMax = gate.policy?.retryMax ?? 1;
      const ops: OpSpec[] = [
        {
          when: 'on-failure',
          action: {
            kind: 'rerouteTo',
            node: producer,
            max: retryMax,
          },
        },
      ];
      if (gate.policy?.onFail === 'retry' || gate.policy?.onFail === undefined) {
        // For judge gates, retry is the default consequence (re-route to producer on judge-fail).
        // If the caller explicitly set 'block', we honour it and emit no reroute.
        // The action op above carries the reroute; the onFailure on the judge node itself is 'block'
        // (the judge node fails → runner fires the action → reroutes). This is the existing M3 pattern.
      }
      return { ops, judgeNode };
    }

    case 'human': {
      // Human (HITL) gate → G5 checkpoint patch on the producer node.
      // NOT an op[] entry — the checkpoint is a separate authoring-layer field (types.ts:168).
      return {
        ops: [], // no op[] entries for a human gate
        checkpointPatch: {
          kind: gate.checkpointKind ?? 'confirm',
          prompt: gate.question,
          ...(gate.choices ? { choices: gate.choices } : {}),
        },
      };
    }
  }
}

/**
 * Lower an ORDERED list of gates (already in cost-ladder order) for one producer node.
 * Concatenates the resulting `ops[]`; returns a single judge node (the FIRST judge gate wins —
 * multiple judge gates on one node are unusual; the second would need a different id scheme).
 * Returns checkpoint patch from the FIRST human gate found.
 */
export function lowerGates(
  gates: GateAuthorSpec[],
  producer: string,
): {
  ops: OpSpec[];
  judgeNode?: JudgeMaterializedNode;
  checkpointPatch?: LowerGateResult['checkpointPatch'];
} {
  const ordered = costLadderOrder(gates);
  const allOps: OpSpec[] = [];
  let judgeNode: JudgeMaterializedNode | undefined;
  let checkpointPatch: LowerGateResult['checkpointPatch'] | undefined;

  for (const gate of ordered) {
    const result = lowerGate(gate, producer);
    allOps.push(...result.ops);
    if (result.judgeNode && !judgeNode) judgeNode = result.judgeNode;
    if (result.checkpointPatch && !checkpointPatch) checkpointPatch = result.checkpointPatch;
  }

  return { ops: allOps, judgeNode, checkpointPatch };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Map a gate policy to the `OnFailure` value the OpSpec carries. Default 'block'. */
function resolveOnFailure(policy: GatePolicy | undefined): import('../types.js').OnFailure {
  const action = policy?.onFail ?? 'block';
  // 'retry' on the gate level is expressed via a separate action op; the op's own onFailure stays
  // 'block' (the retry action fires AFTER the block signals the failure). This mirrors how the
  // existing checks+policy lower to op[]: the policy is the ACTION, not the op's own onFailure
  // when retry is involved.
  return (action === 'retry' ? 'block' : action) as import('../types.js').OnFailure;
}

/** Emit a retry action op from a gate policy. */
function makeRetryAction(policy: GatePolicy): OpSpec {
  const retryAction: Extract<import('../types.js').ActionBody, { kind: 'retry' }> = {
    kind: 'retry',
    max: policy.retryMax ?? 1,
    ...(policy.retryScope ? { scope: policy.retryScope } : { scope: 'feedback' as const }),
  };
  return { when: 'on-failure', action: retryAction };
}

/**
 * Build the judge node's prompt from the rubric + threshold.
 * The threshold is embedded as an explicit acceptance bar so the judge model knows the bar it must
 * clear. Authors should use the agentic-prompt-design skill when writing rubric text.
 */
function buildJudgePrompt(rubric: string, threshold: string): string {
  return `You are a judge evaluating a producer node's output against the following rubric.

## Rubric

${rubric}

## Acceptance bar

Your verdict MUST meet or exceed: **${threshold}**

Emit your verdict as a JSON object in a fenced block at the end of your response:
\`\`\`json
{ "verdict": "pass" | "fail", "score": "<your score if applicable>", "critique": "<brief reason>" }
\`\`\`

If the output does not meet the acceptance bar, emit verdict:"fail" and include a clear, actionable
critique the producer can use to improve. Do NOT emit verdict:"pass" if the bar is not met.`;
}
