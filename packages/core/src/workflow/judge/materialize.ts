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
//      `io.reads` = the producer's produced artifacts, `io.produces` = a verdict artifact (so the
//      reads⋈produces join orders it AFTER the producer);
//   3. ATTACHES the producer-side `rerouteTo(producer, max)` op (the judge-fail loop) onto the producer's `op[]`;
//   4. RE-POINTS the producer's downstream CONSUMERS to also depend on the judge (via `io.dependsOn`), so the
//      judge GATES the hand-off — a consumer never runs before the verdict exists;
//   5. GUARDS the design invariant: the judge tier MUST DIFFER from the producer's tier (no self-judging —
//      self-verifiers false-accept per TeamBench). A same-tier judge is a loud `JudgeConfigError`.
//
// Runs at LOAD time (in `loadTemplate`, before the spec is returned) — NOT a workflow.json mutation. The
// runner needs ZERO changes: the judge is a normal pi node and `rerouteTo` is an existing dispatched action.
//
// FILE FENCE: additive; consumes gate-authoring.ts (`lowerGates`) + types.ts. Does NOT touch the runner,
// the CLI, or index.ts.

import type { WorkflowSpec, NodeIntent } from '../../types.js';
import { lowerGates } from '../gate-authoring.js';
import type { GateAuthorSpec } from '../gate-authoring.js';
import { slugify } from '../../dag.js';
import { insertNodeAfter, rewireDownstream, attachRerouteLoop } from '../graph-rewrite.js';

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

/**
 * Build the materialized judge `NodeIntent` for one producer carrying a `judgeGate`.
 * REUSES `lowerGates` for the prompt + threshold (never reinvents the math). The caller wires consumers.
 *
 * @returns `{ judge, retryMax }` — the judge node to insert + the producer-side reroute retry budget the
 *   caller attaches via `attachRerouteLoop` (the shared graph-rewrite primitive).
 */
function buildJudge(producer: NodeIntent): { judge: NodeIntent; retryMax: number } {
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
  // The lowered judge gate carries a `rerouteTo(producer, retryMax)` op; lift its budget — the caller
  // re-builds the identical op via the shared `attachRerouteLoop` primitive (the producer-side judge-fail loop).
  const rerouteOp = lowered.ops.find((o) => (o.action as { kind?: string } | undefined)?.kind === 'rerouteTo')!;
  const retryMax = (rerouteOp.action as { kind: 'rerouteTo'; node: string; max: number }).max;

  const producedByProducer = producer.io.produces ?? [];
  const verdict = verdictPath(producer.label);

  const judge: NodeIntent = {
    label: `${producer.label}__judge`,
    prompt: jn.prompt,
    agentType: 'judge',
    tier: jn.tier,
    tools: {},
    phase: producer.phase,
    io: {
      // READ the producer's produced artifact(s) → the reads⋈produces join orders the judge AFTER the producer.
      reads: [...producedByProducer],
      // PRODUCE a verdict artifact → a real output the downstream consumers gate on.
      produces: [verdict],
      externalInputs: [],
      // Explicit dep on the producer too, so a producer with zero declared artifacts still orders correctly.
      // `dependsOn` resolves against SLUG ids (dag.ts), so reference the producer by its slug id.
      dependsOn: [slugify(producer.label, 0)],
      artifacts: [{ path: verdict }],
      // The judge is a zero-artifact-gate-ish node: it MUST return a verdict (the runner enforces a return).
      returnMode: 'required',
    },
    sandbox: {
      // Read the run dir (where the producer's artifacts live); write only its own verdict namespace.
      read: producedByProducer.length ? [...producedByProducer] : [],
      write: [verdict],
    },
  };
  return { judge, retryMax };
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
    const { judge, retryMax } = buildJudge(producer);

    // (1) INSERT the materialized judge after the producer (its io.reads ⋈ produces orders it after).
    out = insertNodeAfter(out, producerLabel, judge);

    // (2) The producer itself: strip the consumed `judgeGate` + ATTACH the producer-side reroute judge-fail
    //     loop via the shared primitive (the identical op `lowerGates` emitted, rebuilt here).
    out = {
      ...out,
      nodes: out.nodes.map((n) => {
        if (n.label !== producerLabel) return n;
        const { judgeGate: _drop, ...rest } = n;
        return attachRerouteLoop(rest as NodeIntent, producerLabel, retryMax);
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
