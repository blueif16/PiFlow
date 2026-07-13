// (P1 · MUST-1) A judge gate's REJECT must actually RE-RUN its producer — the bounded QA self-fix loop.
// Two independent bugs made the judge reroute INERT, and this test bites on BOTH:
//
//   Bug A — the reroute never reached `expandReroute`: `materializeJudgeNodes` attached a producer-side
//     `rerouteTo` OP (dead — nothing reads it), instead of setting the judge's `reroute` FIELD that
//     `expandReroute` consumes. Fixed ⇒ the slice `[producer … judge]` unrolls into `producer__r2`/`judge__r2`.
//   Bug B — the existence-oracle mis-fired: the reroute gate stat()'d the judge's FIRST produces
//     (`verdict.json`), but a judge writes `verdict.json` on BOTH accept AND reject (the outcome is the
//     file's CONTENT), so the gate always saw "pass" and marked the producer clone `reused` — the fix never
//     ran. Fixed ⇒ the gate stat()'s a PASS-SENTINEL (`_judge/<producer>/pass.ok`) the judge writes ONLY on
//     accept, so a reject (no sentinel) actually re-runs the producer clone.
//
// THE DISCRIMINATING GATES (test-discipline §0/§4):
//   • REJECT case — the biting one: the producer clone `produce-r2` REACHES the command builder (a spy on
//     the POSITIVE call-count) AND is not `reused`. This FAILS if Bug A is unfixed (no clone in the DAG at
//     all) OR if Bug B is unfixed (verdict.json exists ⇒ the gate short-circuits ⇒ the clone is `reused`,
//     never built). So a version that ONLY sets `judge.reroute` (Bug A fixed, Bug B not) STILL FAILS here.
//   • ACCEPT case — the non-vacuity guard: when the judge WRITES the pass-sentinel, the clone is `reused`
//     (call-count 0). This proves the oracle actually CONSULTS the sentinel — a naive "always re-run" fix
//     would pass the REJECT case but FAIL this one. Together they pin the oracle exactly.
//
// Runs offline through `runWorkflow` with a stub `buildCommand` (writes declared artifacts, never spawns `pi`).

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import { materializeJudgeNodes } from '../src/workflow/judge/materialize.js';
import { expandReroute } from '../src/workflow/reroute/expand.js';
import { runWorkflow } from '../src/runner/index.js';
import type { NodeIntent, NodeSpec, WorkflowSpec } from '../src/types.js';

async function tmpOut(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-judge-reroute-'));
}

// An ACTIVE tier map so the producer (`fast`) and the materialized judge (`deep`) resolve to a model
// offline (a `tier` with no model + inactive map throws ModelRoutingError before the node ever spawns).
const MODEL_ROUTING = {
  tiers: { active: true, tiers: { fast: 'weak-model', deep: 'strong-model' } },
  modelsIndex: new Map<string, string>(),
} as const;

/**
 * A stub command builder that RECORDS every node id it is asked to build (the spy) and returns a shell
 * command writing files into the node's sandbox output dir (collected back onto the run dir). A JUDGE node
 * (agentType:'judge') always writes its REQUIRED artifact `verdict.json`; it ALSO writes the pass-sentinel
 * (its non-artifact `io.produces` entry) ONLY when `judgeAccepts` — modelling accept (pass.ok present) vs
 * reject (pass.ok absent). A node whose body never spawns is never passed here ⇒ its id never appears in `built`.
 */
function stub(built: string[], judgeAccepts: boolean) {
  return (node: NodeSpec): string => {
    built.push(node.id);
    const isJudge = node.agentType === 'judge';
    // Non-judge: write declared artifacts. Judge: verdict.json always; the pass-sentinel only on accept.
    const paths = isJudge
      ? judgeAccepts
        ? [...node.io.produces] // verdict.json + pass.ok → ACCEPT
        : node.io.artifacts.map((a) => a.path) // verdict.json only (pass.ok absent) → REJECT
      : node.io.artifacts.map((a) => a.path);
    const writes = paths
      .map((p) => {
        const dest = `${node.sandbox.output}/${p}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

/** produce (with a judge gate, retryMax 2) → publish (consumes the producer's artifact). */
function judgedSpec(): WorkflowSpec {
  const produce: NodeIntent = {
    label: 'produce',
    prompt: 'PRODUCE the draft.',
    tier: 'fast', // MUST differ from the judge tier (no self-judging)
    tools: {},
    io: { reads: [], produces: ['spec/draft.json'], artifacts: [{ path: 'spec/draft.json' }] },
    judgeGate: { judgeTier: 'deep', rubric: 'The draft must be complete.', threshold: 'pass', policy: { retryMax: 2 } },
  };
  const publish: NodeIntent = {
    label: 'publish',
    prompt: 'PUBLISH it.',
    tools: {},
    io: { reads: ['spec/draft.json'], produces: ['out/final.md'], artifacts: [{ path: 'out/final.md' }] },
  };
  return { meta: { name: 't', description: 'd' }, nodes: [produce, publish] };
}

/** The load-order transform: materialize the judge (attaches its reroute), then unroll the reroute, then compile. */
function build(): ReturnType<typeof compile> {
  return compile(expandReroute(materializeJudgeNodes(judgedSpec())));
}

describe('judge gate REJECT re-runs the producer (bounded QA self-fix loop)', () => {
  it('REJECT (no pass-sentinel) ⇒ the producer clone `produce-r2` RE-RUNS (built, not reused)', async () => {
    const wf = build();
    // PREMISE (so the built-count below is NOT vacuous): the judge reroute really unrolled the producer
    // clone into the DAG. Without Bug A's fix there is no `reroute` field ⇒ no clone ⇒ this is undefined.
    expect(wf.nodes['produce-r2'], 'the judge reroute must unroll a producer clone into the DAG (Bug A)').toBeDefined();
    expect(wf.nodes['produce-judge-r2'], 'the judge clone must unroll too').toBeDefined();

    const built: string[] = [];
    const outDir = await tmpOut();
    // judgeAccepts:false ⇒ the judge writes verdict.json but NOT pass.ok (a REJECT).
    const { status } = await runWorkflow(wf, { run: 'reject', outDir, buildCommand: stub(built, false), modelRouting: MODEL_ROUTING });

    // attempt-1 bodies DID spawn.
    expect(built).toContain('produce');
    expect(built).toContain('produce-judge');
    // THE DISCRIMINATING ASSERTION: on a REJECT the producer clone MUST re-run — it reaches the builder.
    // Bug B unfixed ⇒ the gate stat()'s the always-present verdict.json ⇒ short-circuits ⇒ `produce-r2` is
    // `reused`, never built ⇒ RED here.
    expect(built, 'a rejected judge must RE-RUN the producer clone').toContain('produce-r2');
    expect(status.nodes['produce-r2']?.status, 'the re-run clone must NOT be short-circuited').not.toBe('reused');
  });

  it('ACCEPT (pass-sentinel written) ⇒ the producer clone is short-circuited (reused, never built)', async () => {
    const wf = build();
    expect(wf.nodes['produce-r2']).toBeDefined(); // same DAG — only the run outcome differs

    const built: string[] = [];
    const outDir = await tmpOut();
    // judgeAccepts:true ⇒ the judge writes the pass-sentinel `_judge/produce/pass.ok` (an ACCEPT).
    const { status } = await runWorkflow(wf, { run: 'accept', outDir, buildCommand: stub(built, true), modelRouting: MODEL_ROUTING });

    expect(status.ok).toBe(true);
    // NON-VACUITY GUARD: the oracle CONSULTS the sentinel — an accept short-circuits the clone. A fix that
    // "always re-runs" (ignoring the sentinel) would pass the REJECT test but FAIL here.
    expect(built, 'an accepted judge must NOT re-run the producer clone').not.toContain('produce-r2');
    expect(status.nodes['produce-r2']?.status, 'an accepted attempt short-circuits the clone').toBe('reused');
  });
});
