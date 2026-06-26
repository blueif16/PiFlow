// (M3 · G12) expandReroute — the spec-level transform that UNROLLS a bounded conditional reroute / self-fix
// loop into FORWARD-ONLY acyclic clones at compile time (the `expandFusion` move), so the EXISTING cycle
// gate (`checkCycles`) and `stagesOf` accept it with NO "cycle detected" and NO new DAG code. The
// load-bearing assertions: (1) a `reroute:{onFail:T,max:k}` clones the slice `[T…V]` into namespaced
// `T__r{i}`/`V__r{i}` stages chained forward (no back-edge); (2) `stagesOf` proves the result acyclic
// (the whole point — a runtime back-edge would be REJECTED); (3) the re-entry clone reads the prior
// attempt's evidence + carries a consultPreamble fix-prefix; (4) disjoint per-attempt artifact dirs;
// (5) a non-ancestor target / max<1 throws a loud RerouteConfigError; (6) a spec with NO reroute is
// returned REFERENTIALLY UNCHANGED (additivity — game-omni compiles identically).
//
// Written test-first against the absent `expandReroute` (the unroll assertions go RED: there is no pass).

import { describe, it, expect } from 'vitest';
import { expandReroute, RerouteConfigError } from '../src/workflow/reroute/expand.js';
import { compile, stagesOf, inferEdges } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/types.js';

/**
 * A producer `produce` → a `verify` that gates it. `verify` declares a bounded reroute back to `produce`
 * on failure (the QA loop). A downstream `publish` reads verify's artifact (so the unroll must keep
 * every downstream edge intact).
 */
function specWith(reroute: NodeIntent['reroute']): WorkflowSpec {
  const produce: NodeIntent = {
    label: 'produce',
    prompt: 'PRODUCE: write the draft.',
    tools: { allow: ['fs:read', 'fs:write'] },
    model: 'base-model',
    io: { reads: ['spec/blueprint.json'], produces: ['work/draft.md'], externalInputs: ['spec/blueprint.json'], artifacts: [{ path: 'work/draft.md' }] },
    sandbox: { read: ['spec'], write: ['work/**'] },
  };
  const verify: NodeIntent = {
    label: 'verify',
    prompt: 'VERIFY: check the draft.',
    tools: { allow: ['fs:read', 'fs:write'] },
    model: 'base-model',
    io: { reads: ['work/draft.md'], produces: ['verify/report.json'], artifacts: [{ path: 'verify/report.json' }] },
    sandbox: { read: ['work'], write: ['verify/**'] },
    reroute,
  };
  const publish: NodeIntent = {
    label: 'publish',
    prompt: 'publish it',
    tools: {},
    io: { reads: ['verify/report.json'], produces: ['out/final.md'], artifacts: [{ path: 'out/final.md' }] },
  };
  return { meta: { name: 't', description: 'd' }, nodes: [produce, verify, publish] };
}

const labels = (s: WorkflowSpec): string[] => s.nodes.map((n) => n.label).sort();
const find = (s: WorkflowSpec, label: string): NodeIntent => s.nodes.find((n) => n.label === label)!;

describe('expandReroute — bounded unroll into a forward-only DAG', () => {
  it('unrolls a bounded loop into a forward-only DAG that stagesOf accepts (no "cycle detected")', () => {
    const out = expandReroute(specWith({ onFail: 'produce', max: 2 }));
    // attempt 1 = the original produce/verify; attempt 2 = the cloned re-entry slice produce__r2/verify__r2.
    expect(labels(out)).toContain('produce__r2');
    expect(labels(out)).toContain('verify__r2');

    // THE LOAD-BEARING ASSERTION: the unroll is ACYCLIC — stagesOf does NOT report a cycle. (A runtime
    // back-edge produce→verify→produce would be `cycle detected`; the unroll replaces it with forward clones.)
    const wf = compile(out);
    const { edges } = inferEdges(wf.nodes);
    const { errors } = stagesOf(wf.nodes, edges);
    expect(errors).toEqual([]); // no "cycle detected among: …"

    // Forward chaining through the #17 existence-gate: verify (attempt 1) → verify__r2__gate → produce__r2
    // → verify__r2 → publish. The gate (reading attempt-1's canonical artifact) sits BETWEEN the attempts,
    // and no edge points BACKWARD into produce (attempt 1) from any clone.
    const intoGate = wf.edges.filter((e) => e.to === 'verify-r2-gate').map((e) => e.from);
    expect(intoGate).toContain('verify'); // the gate is fed by the failing attempt-1 verify's artifact
    const intoProduceR2 = wf.edges.filter((e) => e.to === 'produce-r2').map((e) => e.from);
    expect(intoProduceR2).toEqual(['verify-r2-gate']); // the re-entry root is gated, NOT a back-edge to verify
    const fromVerifyR2 = wf.edges.filter((e) => e.from === 'verify-r2').map((e) => e.to);
    expect(fromVerifyR2).toContain('publish'); // downstream survives, now fed by the LAST attempt
  });

  it('the re-entry clone reads the prior attempt evidence and carries a consultPreamble fix-prefix', () => {
    const out = expandReroute(specWith({ onFail: 'produce', max: 2, evidence: ['verify/report.json'] }));
    const produceR2 = find(out, 'produce__r2');
    // it READS the prior attempt's evidence artifact (so the fix is informed by the failure).
    expect(produceR2.io.reads).toContain('verify/report.json');
    // a consultPreamble prefix tells the clone the prior attempt FAILED — the original task is still present.
    expect(produceR2.prompt).toContain('PRODUCE: write the draft.'); // original task verbatim
    expect(produceR2.prompt.toLowerCase()).toContain('prior attempt'); // the fix-prefix
  });

  it('each cloned attempt writes into its OWN disjoint top-level dir (parallel-collect write-disjoint)', () => {
    const out = expandReroute(specWith({ onFail: 'produce', max: 2 }));
    const produceR2 = find(out, 'produce__r2');
    const verifyR2 = find(out, 'verify__r2');
    // the clone's produces are namespaced under a per-attempt dir, NOT the attempt-1 canonical path.
    expect(produceR2.io.produces.every((p) => p.startsWith('reroute-verify-r2/'))).toBe(true);
    expect(verifyR2.io.produces.every((p) => p.startsWith('reroute-verify-r2/'))).toBe(true);
    // and the sandbox write scope matches (write-disjoint ⇒ no parallel-collect race).
    expect(produceR2.sandbox?.write?.every((p) => p.startsWith('reroute-verify-r2/'))).toBe(true);
  });

  it('chains TWO re-entries for max:3 (gate→produce__r2→verify__r2→gate→produce__r3→verify__r3), all acyclic', () => {
    const out = expandReroute(specWith({ onFail: 'produce', max: 3 }));
    // each re-entry attempt emits its own zero-pi existence-gate (#17) BEFORE its cloned body.
    expect(labels(out)).toEqual(
      [
        'produce', 'produce__r2', 'produce__r3', 'publish', 'verify',
        'verify__r2', 'verify__r2__gate', 'verify__r3', 'verify__r3__gate',
      ].sort(),
    );
    const wf = compile(out);
    const { edges } = inferEdges(wf.nodes);
    expect(stagesOf(wf.nodes, edges).errors).toEqual([]); // still acyclic at depth 2
  });
});

describe('expandReroute — passthrough + loud failure', () => {
  it('returns the SAME spec object when no node declares reroute (additivity — game-omni unchanged)', () => {
    const spec = specWith(undefined);
    expect(expandReroute(spec)).toBe(spec); // referential — untouched
  });

  it('throws RerouteConfigError when onFail is not an ancestor of the verify node', () => {
    // `publish` is DOWNSTREAM of verify, not an ancestor — rerouting to it is unbuildable.
    expect(() => expandReroute(specWith({ onFail: 'publish', max: 2 }))).toThrow(RerouteConfigError);
  });

  it('throws RerouteConfigError for max < 1', () => {
    expect(() => expandReroute(specWith({ onFail: 'produce', max: 0 }))).toThrow(RerouteConfigError);
  });
});
