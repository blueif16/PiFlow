// (M3 · G12 — fix) expandReroute must CHAIN + CONVERGE for DEPS-coordinated slices, not only file-coordinated.
// game-omni nodes coordinate through `io.dependsOn` with EMPTY `io.reads` (they depend by label, they do not
// read each other's artifacts). The original expandReroute remapped reads/produces (files) but copied
// `dependsOn` VERBATIM (expand.ts remapIo), so a cloned re-verify kept depending on the ORIGINAL executor
// (attempt 1), never its clone — and a deps-coordinated downstream kept converging on attempt 1. The unroll
// COMPILED but never CHAINED. The existing reroute suite is all file-coordinated, so it never caught this.
//
// These assertions go RED on that bug: the clone's `dependsOn` (and the compiled forward edge) is wrong.

import { describe, it, expect } from 'vitest';
import { expandReroute } from '../src/workflow/reroute/expand.js';
import { compile, stagesOf, inferEdges } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/types.js';

// A DEPS-coordinated QA loop (the game-omni shape): execute → verify → publish, wired ONLY through
// `io.dependsOn`. Each node produces an artifact but NO downstream node READS it — coordination is by label.
function depsSpec(reroute: NodeIntent['reroute']): WorkflowSpec {
  const execute: NodeIntent = {
    label: 'execute',
    prompt: 'EXECUTE the milestone.',
    tools: {},
    model: 'base-model',
    io: { reads: [], produces: ['MEMORY.exec.md'], dependsOn: [], artifacts: [{ path: 'MEMORY.exec.md' }] },
  };
  const verify: NodeIntent = {
    label: 'verify',
    prompt: 'VERIFY the milestone.',
    tools: {},
    model: 'base-model',
    io: { reads: [], produces: ['verify/report.json'], dependsOn: ['execute'], artifacts: [{ path: 'verify/report.json' }] },
    reroute,
  };
  const publish: NodeIntent = {
    label: 'publish',
    prompt: 'publish it',
    tools: {},
    io: { reads: [], produces: ['out/final.md'], dependsOn: ['verify'], artifacts: [{ path: 'out/final.md' }] },
  };
  return { meta: { name: 't', description: 'd' }, nodes: [execute, verify, publish] };
}

const find = (s: WorkflowSpec, label: string): NodeIntent => s.nodes.find((n) => n.label === label)!;

describe('expandReroute — deps-coordinated slices chain + converge (not only file-coordinated)', () => {
  // NOTE: a clone's LABEL keeps the `__r{i}` form (`verify__r2`), but its `dependsOn` carries the RESOLVABLE
  // SLUG id (`execute-r2`) — that is what `compile`/`inferEdges` look up (dag.ts keys nodes by slug). Copying
  // the raw label would leave `dependsOn` referencing an unknown node (the original bug's second face).
  it('the re-verify clone depends on the re-execute CLONE, not the original executor (chaining)', () => {
    const out = expandReroute(depsSpec({ onFail: 'execute', max: 2 }));
    const verifyR2 = find(out, 'verify__r2');
    // the in-slice dep must be remapped to THIS attempt's clone slug — not left pointing at attempt 1.
    expect(verifyR2.io.dependsOn).toContain('execute-r2');
    expect(verifyR2.io.dependsOn).not.toContain('execute');
    // and the compiled DAG draws the forward edge execute-r2 → verify-r2, still acyclic.
    const wf = compile(out);
    const { edges } = inferEdges(wf.nodes);
    expect(stagesOf(wf.nodes, edges).errors).toEqual([]);
    expect(wf.edges.some((e) => e.from === 'execute-r2' && e.to === 'verify-r2')).toBe(true);
  });

  it('a deps-coordinated downstream converges onto the LAST attempt (convergence)', () => {
    const out = expandReroute(depsSpec({ onFail: 'execute', max: 2 }));
    const publish = find(out, 'publish');
    // publish depended on `verify` (attempt 1); it must be re-pointed onto the last attempt's clone slug.
    expect(publish.io.dependsOn).toContain('verify-r2');
    expect(publish.io.dependsOn).not.toContain('verify');
    const wf = compile(out);
    expect(wf.edges.some((e) => e.from === 'verify-r2' && e.to === 'publish')).toBe(true);
  });

  it('still chains the deeper loop (max:3): each clone depends on its same-attempt predecessor clone', () => {
    const out = expandReroute(depsSpec({ onFail: 'execute', max: 3 }));
    expect(find(out, 'verify__r2').io.dependsOn).toContain('execute-r2');
    expect(find(out, 'verify__r3').io.dependsOn).toContain('execute-r3');
    // downstream converges on the FINAL attempt.
    expect(find(out, 'publish').io.dependsOn).toContain('verify-r3');
    const wf = compile(out);
    const { edges } = inferEdges(wf.nodes);
    expect(stagesOf(wf.nodes, edges).errors).toEqual([]); // acyclic at depth 2
  });
});
