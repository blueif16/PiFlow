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

import type { OpSpec, GateBody, CheckKind, OnFailure, ActionBody, GatePolicy } from '../types.js';

// ── 1 · AUTHORING SHAPES ─────────────────────────────────────────────────────

// (P2 · unified gate policy) `GatePolicy` — the ONE on-fail vocabulary every gate kind shares — now lives
// on the spine (types.ts). Re-exported here so existing `import { GatePolicy } from './gate-authoring'`
// sites (gate-list.ts, index.ts) are unchanged. See `types.ts` for the field docs + the back-compat aliases.
export type { GatePolicy };

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
      // (P2) The reroute budget: the canonical `max`, or its back-compat `retryMax` alias. Default 1.
      const retryMax = gate.policy?.max ?? gate.policy?.retryMax ?? 1;
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

/**
 * Map a unified gate policy's `onFail` (the P2 superset) down to the `OnFailure` value the OpSpec's own
 * consequence carries. `'block'`/`'warn'`/`'stop'`/`'escalate'` pass through unchanged (pre-P2 meaning).
 * `'retry'` and `'reroute'` block the op FIRST — the retry rides a separate retry action op (below); the
 * reroute rides the judge's `reroute` field / a `rerouteTo` action, never the op's own onFailure. `'halt'`
 * is the documented `stop` alias (refuse to proceed); `'accept'` is a non-fatal `warn` (record, don't fail).
 * Default 'block'.
 */
function resolveOnFailure(policy: GatePolicy | undefined): OnFailure {
  switch (policy?.onFail ?? 'block') {
    case 'retry':
    case 'reroute':
      return 'block';
    case 'halt':
      return 'stop';
    case 'accept':
      return 'warn';
    default:
      return (policy?.onFail ?? 'block') as OnFailure; // 'block' | 'warn' | 'stop' | 'escalate'
  }
}

/**
 * Emit a retry action op from a gate policy. The budget is the canonical `max` (or its `retryMax` alias);
 * `scope` keeps the L1/L2 corrective LANE (default 'feedback'); `session` carries the P2 RESUME(warm)/
 * RERUN(cold) knob — default 'warm', so an existing policy that named only `retryScope:'feedback'|'fix'`
 * still lowers to a warm feedback retry unchanged (byte-identical to pre-P2 for those callers).
 */
function makeRetryAction(policy: GatePolicy): OpSpec {
  const retryAction: Extract<ActionBody, { kind: 'retry' }> = {
    kind: 'retry',
    max: policy.max ?? policy.retryMax ?? 1,
    scope: policy.retryScope ?? 'feedback',
    session: policy.session ?? 'warm',
  };
  return { when: 'on-failure', action: retryAction };
}

/**
 * Build the judge node's REASONING + verdict contract from the rubric + threshold. Names the acceptance bar
 * explicitly and pins the verdict schema; the CRITIQUE requirement is motivated (it is fed to the producer's
 * re-run, so it must be actionable). The concrete OUTPUT-FILE contract (which file the verdict is written to
 * and the accept-only pass-sentinel) is APPENDED by `materializeJudgeNodes` where the run-relative paths are
 * known — a judge on the FUSION path (no reroute) uses this reasoning contract alone. Authored per the
 * agentic-prompt-design skill; kept crisp because a judge is a frontier (deep-tier) model.
 */
function buildJudgePrompt(rubric: string, threshold: string): string {
  return `You are a senior QA judge evaluating a producer node's output against a fixed rubric. You are a
DIFFERENT model than the producer — your job is to catch what it missed, not to rubber-stamp it.

## Rubric

${rubric}

## Acceptance bar

ACCEPT (verdict "pass") only if the output MEETS OR EXCEEDS: **${threshold}**. If ANY rubric requirement is
unmet, REJECT (verdict "fail") — never pass a near-miss.

## Your verdict

Decide "pass" or "fail" against the bar, then:
- On "fail", write a SPECIFIC, ACTIONABLE critique: name each unmet requirement and the concrete change that
  fixes it. This critique is fed VERBATIM to the producer's re-run — "improve the quality" wastes the retry;
  "section 3 omits the error-handling case; add it" gets fixed.
- On "pass", one line of justification is enough.

Emit your verdict as a fenced JSON block at the END of your response:
\`\`\`json
{ "verdict": "pass" | "fail", "score": "<your score if applicable>", "critique": "<actionable reason>" }
\`\`\`
Do NOT emit verdict:"pass" if the bar is not met.`;
}
