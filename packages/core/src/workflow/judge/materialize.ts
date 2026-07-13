// (expert-representations · "Judge expansion") materializeJudgeNodes — the LOAD-TIME transform that turns
// an authored `judgeGate` on a producer node into a REAL judge pi node wired into the DAG.
//
// THE GAP this closes: `lowerGates`/`compileNodeBase` already emit a `judgeNode` SHAPE + a producer-side
// `rerouteTo` op, but nothing inserted that node into the compiled WorkflowSpec — so a judge gate ran no
// judge. This module is the missing consumer: a PURE intent→intent spec transform (the `expandReroute`/
// `expandFusion` precedent) that, for every node carrying a `judgeGate`:
//
//   1. RE-USES the SA-B lowering (`lowerGates([gate], producerId)`) — never reinvents the prompt/reroute math;
//   2. INSERTS a real `<producer>__judge` NodeIntent — agentType:'judge', tier=judgeTier, prompt=the rubric,
//      `io.reads` = the producer's produced artifacts, `io.produces` = a verdict artifact + an accept-only
//      pass-sentinel (so the reads⋈produces join orders it AFTER the producer);
//   3. SETS the judge's `reroute` FIELD (`{onFail:producer, max, evidence:[verdict], passSentinel}`) — the
//      bounded judge-fail loop that `expandReroute` UNROLLS into a re-run of the producer at RUN time. (Not a
//      producer-side op: that op was DEAD — nothing read it, and `expandReroute` only consumes `node.reroute`.)
//   4. RE-POINTS the producer's downstream CONSUMERS to also depend on the judge (via `io.dependsOn`), so the
//      judge GATES the hand-off — a consumer never runs before the verdict exists;
//   5. GUARDS the design invariant: the judge tier MUST DIFFER from the producer's tier (no self-judging —
//      self-verifiers false-accept per TeamBench). A same-tier judge is a loud `JudgeConfigError`.
//
// Runs at LOAD time (in `loadTemplate`, before the spec is returned) — NOT a workflow.json mutation. The
// runner needs ZERO changes: the judge is a normal pi node and the reroute is `expandReroute`'s existing unroll.
//
// FILE FENCE: additive; consumes gate-authoring.ts (`lowerGates`) + types.ts. Does NOT touch the runner,
// the CLI, or index.ts.

import type { WorkflowSpec, NodeIntent } from '../../types.js';
import { lowerGates } from '../gate-authoring.js';
import type { GateAuthorSpec } from '../gate-authoring.js';
import { slugify } from '../../dag.js';
import { insertNodeAfter, rewireDownstream } from '../graph-rewrite.js';

/** Thrown when a judge gate is unbuildable (the judge tier equals the producer tier). Loud, never silent. */
export class JudgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeConfigError';
  }
}

/** The verdict artifact a materialized judge produces (RUN-relative). One per producer, namespaced by id. */
function verdictPath(producerLabel: string): string {
  return `_judge/${producerLabel}/verdict.json`;
}

/** The accept-only PASS-SENTINEL a materialized judge writes ONLY when it accepts (the reroute existence
 *  gate's signal — see `RerouteSpec.passSentinel`). One per producer, in the judge's verdict namespace. */
function passPath(producerLabel: string): string {
  return `_judge/${producerLabel}/pass.ok`;
}

/**
 * The concrete OUTPUT-FILE contract appended to the judge prompt (the run-relative paths are only known at
 * materialize time). Two files, one rule each — authored per agentic-prompt-design (observable, motivated):
 * the verdict file exists on EVERY outcome (the re-run's evidence); the pass-sentinel exists ONLY on accept
 * (its mere existence is what releases the workflow vs. re-running the producer — never create it on a fail).
 */
function judgeOutputContract(verdictFile: string, passSentinelFile: string): string {
  return `

## Output files (REQUIRED — the run reads these, not your chat)

- ALWAYS write your full verdict JSON (the same object as the fenced block above) to \`${verdictFile}\`. This
  file MUST exist on every outcome; on "fail" it MUST contain the actionable critique — it is the re-run's evidence.
- ONLY when your verdict is "pass" (ACCEPT), ALSO create \`${passSentinelFile}\` (contents irrelevant — its
  EXISTENCE is the accept signal). On "fail", do NOT create it: its absence is what re-runs the producer. Never
  create it for a failing verdict.`;
}

/**
 * Build the materialized judge `NodeIntent` for one producer carrying a `judgeGate`.
 * REUSES `lowerGates` for the prompt + threshold (never reinvents the math). The judge carries its OWN
 * judge-fail loop as a `reroute` FIELD (consumed by `expandReroute` at run time); the caller only wires
 * consumers. @returns the judge node to insert after the producer.
 */
function buildJudge(producer: NodeIntent): NodeIntent {
  const gate = producer.judgeGate!;
  // GUARD the design invariant up front (a same-tier judge is forbidden — self-judging false-accepts).
  if (producer.tier !== undefined && producer.tier === gate.judgeTier) {
    throw new JudgeConfigError(
      `judge gate on "${producer.label}": judgeTier "${gate.judgeTier}" must DIFFER from the producer's ` +
        `tier "${producer.tier}" — a judge MUST be a different model than the producer (no self-judging).`,
    );
  }

  // REUSE the SA-B lowering: emits the judge prompt (rubric + acceptance bar) and the rerouteTo op.
  const authored: GateAuthorSpec = {
    kind: 'judge',
    judgeTier: gate.judgeTier,
    rubric: gate.rubric,
    ...(gate.threshold !== undefined ? { threshold: gate.threshold } : {}),
    ...(gate.policy !== undefined ? { policy: gate.policy } : {}),
  };
  const lowered = lowerGates([authored], producer.label);
  const jn = lowered.judgeNode!; // a judge gate always materializes a judgeNode (gate-authoring.ts)
  // The lowered judge gate carries a `rerouteTo(producer, retryMax)` op; lift ONLY its retry BUDGET — the
  // judge-fail loop itself is expressed as the judge's `reroute` field below (what `expandReroute` consumes),
  // not the lowered op (that op is dead: nothing at runtime reads a producer-side judge rerouteTo).
  const rerouteOp = lowered.ops.find((o) => (o.action as { kind?: string } | undefined)?.kind === 'rerouteTo')!;
  const retryMax = (rerouteOp.action as { kind: 'rerouteTo'; node: string; max: number }).max;

  const producedByProducer = producer.io.produces ?? [];
  const verdict = verdictPath(producer.label);
  const passSentinel = passPath(producer.label);

  const judge: NodeIntent = {
    label: `${producer.label}__judge`,
    // The reasoning/verdict contract (rubric + bar + verdict schema) from `lowerGates`, PLUS the concrete
    // output-file contract only known here (the run-relative paths): the verdict file is written on BOTH
    // outcomes (the re-run evidence); the pass-sentinel is created ONLY on accept (the gate's release signal).
    prompt: `${jn.prompt}${judgeOutputContract(verdict, passSentinel)}`,
    agentType: 'judge',
    tier: jn.tier,
    // INHERIT the producer's tools so the judge can WRITE its verdict + pass-sentinel (the fusion-judge
    // precedent, fusion/expand.ts). Its sandbox jails writes to the verdict namespace regardless.
    tools: { ...(producer.tools ?? {}) },
    phase: producer.phase,
    io: {
      // READ the producer's produced artifact(s) → the reads⋈produces join orders the judge AFTER the producer.
      reads: [...producedByProducer],
      // PRODUCE the verdict artifact FIRST (produces[0] — the downstream/evidence pointer), THEN the
      // accept-only pass-sentinel. The sentinel is a `produces` entry so `expandReroute` namespaces it per
      // attempt, but NOT a required artifact (below) — a REJECT legitimately writes no sentinel and must not block.
      produces: [verdict, passSentinel],
      externalInputs: [],
      // Explicit dep on the producer too, so a producer with zero declared artifacts still orders correctly.
      // `dependsOn` resolves against SLUG ids (dag.ts), so reference the producer by its slug id.
      dependsOn: [slugify(producer.label, 0)],
      // ONLY the verdict is REQUIRED — the pass-sentinel is conditional (accept-only), so it stays OUT of the
      // contract (an artifact here would block the judge on every reject).
      artifacts: [{ path: verdict }],
      // The judge is a zero-artifact-gate-ish node: it MUST return a verdict (the runner enforces a return).
      returnMode: 'required',
    },
    // BUG A + BUG B: the judge-fail loop lives HERE, on the judge (V), as a `reroute` field `expandReroute`
    // consumes — NOT a dead producer-side op. `onFail` unrolls `[target … judge]` into a bounded re-run; the
    // DEFAULT target is the producer (a strict ancestor of the judge via the reads/dependsOn edge, so the
    // ancestor-strict guard passes). (P2) a policy `target` re-points the loop further back to a named
    // strict-ancestor label (a non-ancestor is a loud RerouteConfigError in expandReroute). `passSentinel`
    // makes the existence gate stat the ACCEPT-only sentinel (not the always-written verdict), so a REJECT
    // actually re-runs; `evidence:[verdict]` feeds the judge's critique to the re-entered clone.
    reroute: { onFail: gate.policy?.target ?? producer.label, max: retryMax, evidence: [verdict], passSentinel },
    sandbox: {
      // Read the run dir (where the producer's artifacts live); write only its own verdict namespace.
      read: producedByProducer.length ? [...producedByProducer] : [],
      write: [verdict, passSentinel],
    },
  };
  return judge;
}

/**
 * Expand every `judgeGate`-bearing producer in a WorkflowSpec into a materialized `<producer>__judge` node
 * wired into the DAG (deps after the producer; the producer's downstream consumers re-pointed to depend on
 * the judge; the producer-side `rerouteTo` judge-fail loop attached). A spec with no `judgeGate` is returned
 * REFERENTIALLY UNCHANGED (the additivity early-return). PURE — no I/O, no model calls. Runs at LOAD time.
 *
 * Throws `JudgeConfigError` when a judge's tier equals its producer's tier (the no-self-judge invariant).
 */
export function materializeJudgeNodes(spec: WorkflowSpec): WorkflowSpec {
  if (!spec.nodes.some((n) => n.judgeGate)) return spec;

  // The set of producer labels carrying a judge gate — `rewireDownstream` excludes each (a producer never
  // gates on its own judge) AND each generated judge is excluded from the next iteration's consumer scan.
  const judgedProducers = spec.nodes.filter((n) => n.judgeGate).map((n) => n.label);
  const judgeLabels = judgedProducers.map((p) => `${p}__judge`);
  const judgeLabelSet = new Set(judgeLabels);

  let out = spec;
  for (const producerLabel of judgedProducers) {
    const producer = out.nodes.find((n) => n.label === producerLabel)!;
    const judge = buildJudge(producer);

    // (1) INSERT the materialized judge after the producer (its io.reads ⋈ produces orders it after).
    out = insertNodeAfter(out, producerLabel, judge);

    // (2) The producer itself: just STRIP the consumed `judgeGate`. The judge-fail loop lives on the JUDGE's
    //     `reroute` field (set in buildJudge), consumed by `expandReroute` at run time — the producer carries
    //     NO reroute op (that op was dead: `expandReroute` reads only `node.reroute`, and nothing else read it).
    out = {
      ...out,
      nodes: out.nodes.map((n) => {
        if (n.label !== producerLabel) return n;
        const { judgeGate: _drop, ...rest } = n;
        return rest as NodeIntent;
      }),
    };

    // (3) RE-POINT the producer's downstream consumers (reads its produces OR dependsOn it) onto the judge,
    //     so the judge GATES the hand-off. Skip the OTHER judges (they read the producer's artifact too but
    //     must not be pushed after a sibling judge) — the chain stays producer → judge → consumer.
    out = rewireDownstream(out, producerLabel, judge.label, {
      skip: judgeLabels.filter((l) => l !== judge.label),
    });
  }

  // Keep the canonical node ORDER (authored nodes first, generated judges as the tail) the original
  // emitted: collect every materialized judge and re-append it after the authored set.
  const authored = out.nodes.filter((n) => !judgeLabelSet.has(n.label));
  const judges = out.nodes.filter((n) => judgeLabelSet.has(n.label));
  return { ...out, nodes: [...authored, ...judges] };
}
