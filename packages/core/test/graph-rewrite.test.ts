// (expert-representations · refactor) graph-rewrite — the shared LOAD-TIME graph-rewrite primitives the
// four DAG-expansion modules (reroute/judge/fusion/subworkflow) each re-implemented. These oracles pin the
// PURE behavior every caller (and L2's future `materializeFixNodes`) depends on:
//
//   • insertNodeAfter — appends the generated node; the producer must exist (else a loud throw); the node's
//     own io is what places it after the producer (the existing reads⋈produces / dependsOn join), so the
//     primitive only validates + appends, it does NOT mutate the inserted node's edges.
//   • rewireDownstream — a downstream consumer of the producer (reads its produces OR dependsOn it) gains a
//     `dependsOn` on the GATE's slug id; the producer itself, the gate, and any `skip` id are NEVER rewired.
//   • attachRerouteLoop — appends a `{when:'on-failure', action:{kind:'rerouteTo', node, max}}` op onto the
//     node's `op[]`, preserving any existing ops; carries `evidence` only when present.
//   • remapDeps — rewrites a `dependsOn` list through a (label→label) rename fn, slug-aware at the call site;
//     returns the SAME array reference when nothing changed (the additivity contract the callers rely on).
//
// Built test-first against an empty module (every assertion goes RED: the symbol is undefined).

import { describe, it, expect } from 'vitest';
import { slugify } from '../src/dag.js';
import {
  insertNodeAfter,
  rewireDownstream,
  attachRerouteLoop,
  remapDeps,
} from '../src/workflow/graph-rewrite.js';
import type { NodeIntent, WorkflowSpec } from '../src/types.js';

/** A producer P with two downstream consumers: C1 reads P's artifact, C2 dependsOn P by slug id. */
function specPC(): WorkflowSpec {
  const producer: NodeIntent = {
    label: 'prod',
    prompt: 'make it',
    tools: {},
    io: { reads: [], produces: ['out/p.json'], dependsOn: [], artifacts: [{ path: 'out/p.json' }] },
  };
  const c1: NodeIntent = {
    label: 'c1',
    prompt: 'read p',
    tools: {},
    io: { reads: ['out/p.json'], produces: ['out/c1.json'], dependsOn: [], artifacts: [{ path: 'out/c1.json' }] },
  };
  const c2: NodeIntent = {
    label: 'c2',
    prompt: 'after p',
    tools: {},
    io: { reads: [], produces: ['out/c2.json'], dependsOn: [slugify('prod', 0)], artifacts: [{ path: 'out/c2.json' }] },
  };
  return { meta: { name: 't', description: 'd' }, nodes: [producer, c1, c2] };
}

const gateNode = (label: string, reads: string[]): NodeIntent => ({
  label,
  prompt: 'gate',
  tools: {},
  io: { reads, produces: [`_g/${label}.json`], dependsOn: [], artifacts: [{ path: `_g/${label}.json` }] },
});

describe('insertNodeAfter — append a generated node after an existing producer', () => {
  it('appends the node to the spec (and the spec is a NEW object — pure)', () => {
    const spec = specPC();
    const g = gateNode('prod__judge', ['out/p.json']);
    const out = insertNodeAfter(spec, 'prod', g);
    expect(out).not.toBe(spec); // pure: returns a new spec
    expect(out.nodes.map((n) => n.label)).toContain('prod__judge');
    // appended LAST (the generated tail — what every expansion does)
    expect(out.nodes[out.nodes.length - 1].label).toBe('prod__judge');
    // the inserted node's io is carried verbatim (the primitive does NOT rewire it)
    expect(out.nodes[out.nodes.length - 1].io.reads).toEqual(['out/p.json']);
  });

  it('does NOT mutate the original spec or its node list', () => {
    const spec = specPC();
    const before = spec.nodes.length;
    insertNodeAfter(spec, 'prod', gateNode('prod__judge', []));
    expect(spec.nodes.length).toBe(before); // original untouched
  });

  it('THROWS when the producer label is absent (a loud miswire, never a silent no-op)', () => {
    const spec = specPC();
    expect(() => insertNodeAfter(spec, 'nope', gateNode('x', []))).toThrow(/nope/);
  });
});

describe('rewireDownstream — push the producer\'s consumers AFTER a gate node', () => {
  it('a consumer that READS the producer\'s artifact gains a dep on the gate slug', () => {
    const spec = specPC();
    const out = rewireDownstream(spec, 'prod', 'prod__judge');
    const c1 = out.nodes.find((n) => n.label === 'c1')!;
    expect(c1.io.dependsOn).toContain(slugify('prod__judge', 0)); // 'prod-judge'
  });

  it('a consumer that DEPENDS ON the producer (by id) ALSO gains the gate dep', () => {
    const spec = specPC();
    const out = rewireDownstream(spec, 'prod', 'prod__judge');
    const c2 = out.nodes.find((n) => n.label === 'c2')!;
    expect(c2.io.dependsOn).toContain(slugify('prod__judge', 0));
    expect(c2.io.dependsOn).toContain(slugify('prod', 0)); // its original dep is preserved
  });

  it('NEVER rewires the producer itself, the gate node, or a `skip` id', () => {
    const spec = specPC();
    // gate `prod__judge` reads the producer artifact too — it must NOT be made to depend on itself.
    const withGate: WorkflowSpec = { ...spec, nodes: [...spec.nodes, gateNode('prod__judge', ['out/p.json'])] };
    const out = rewireDownstream(withGate, 'prod', 'prod__judge', { skip: ['c2'] });
    const prod = out.nodes.find((n) => n.label === 'prod')!;
    const judge = out.nodes.find((n) => n.label === 'prod__judge')!;
    const c2 = out.nodes.find((n) => n.label === 'c2')!;
    expect(prod.io.dependsOn ?? []).not.toContain(slugify('prod__judge', 0)); // producer never self-deps
    expect(judge.io.dependsOn ?? []).not.toContain(slugify('prod__judge', 0)); // gate never self-deps
    expect(c2.io.dependsOn ?? []).not.toContain(slugify('prod__judge', 0)); // skipped consumer untouched
    // c1 (not skipped, reads the producer) is still rewired.
    const c1 = out.nodes.find((n) => n.label === 'c1')!;
    expect(c1.io.dependsOn).toContain(slugify('prod__judge', 0));
  });

  it('is a no-op (same node refs) for a node that is not a consumer', () => {
    const spec = specPC();
    const out = rewireDownstream(spec, 'prod', 'prod__judge');
    // c2 IS a consumer (deps on prod) → changed; an unrelated node would be referentially identical.
    const unrelated: NodeIntent = { label: 'iso', prompt: 'x', tools: {}, io: { reads: [], produces: [], dependsOn: [] } };
    const out2 = rewireDownstream({ ...spec, nodes: [...spec.nodes, unrelated] }, 'prod', 'prod__judge');
    expect(out2.nodes.find((n) => n.label === 'iso')).toBe(unrelated); // untouched ⇒ same ref
  });
});

describe('attachRerouteLoop — append the producer-side rerouteTo op', () => {
  it('appends a {when:on-failure, action:rerouteTo} op pointing at the target with max', () => {
    const node: NodeIntent = { label: 'prod', prompt: 'x', tools: {}, io: { reads: [], produces: [], dependsOn: [] } };
    const out = attachRerouteLoop(node, 'prod', 2);
    const op = (out.op ?? []).find((o) => (o.action as any)?.kind === 'rerouteTo');
    expect(op).toBeDefined();
    expect((op!.action as any).node).toBe('prod');
    expect((op!.action as any).max).toBe(2);
    expect(op!.when).toBe('on-failure');
  });

  it('PRESERVES existing ops (appends, never replaces) and is pure (new node)', () => {
    const existing = { when: 'after' as const, gate: { kind: 'non-empty' } } as any;
    const node: NodeIntent = { label: 'prod', prompt: 'x', tools: {}, op: [existing], io: { reads: [], produces: [], dependsOn: [] } };
    const out = attachRerouteLoop(node, 'prod', 1);
    expect(out).not.toBe(node);
    expect(out.op).toHaveLength(2);
    expect(out.op![0]).toBe(existing); // the prior op survives, first
  });

  it('carries `evidence` only when present', () => {
    const node: NodeIntent = { label: 'prod', prompt: 'x', tools: {}, io: { reads: [], produces: [], dependsOn: [] } };
    const withEv = attachRerouteLoop(node, 'prod', 1, ['e/fail.json']);
    expect(((withEv.op ?? []).find((o) => (o.action as any)?.kind === 'rerouteTo')!.action as any).evidence).toEqual(['e/fail.json']);
    const without = attachRerouteLoop(node, 'prod', 1);
    expect('evidence' in ((without.op ?? []).find((o) => (o.action as any)?.kind === 'rerouteTo')!.action as any)).toBe(false);
  });
});

describe('remapDeps — slug-aware rewrite of a dependsOn list through a rename fn', () => {
  it('rewrites the deps that the rename fn changes, leaving the rest', () => {
    const out = remapDeps(['execute', 'other'], (l) => (l === 'execute' ? 'execute-r2' : l));
    expect(out).toEqual(['execute-r2', 'other']);
  });

  it('returns the SAME array reference when NOTHING changed (additivity contract)', () => {
    const deps = ['a', 'b'];
    const out = remapDeps(deps, (l) => l); // identity ⇒ no change
    expect(out).toBe(deps);
  });

  it('is a POSITIONAL map (no de-dup) — preserves the caller\'s edge multiplicity byte-for-byte', () => {
    // The callers used `deps.map(rename)` (no de-dup); the primitive must match exactly, else a reroute
    // clone whose two deps collapse would silently lose an edge vs the original behavior.
    const out = remapDeps(['verify', 'verify-old'], () => 'verify-r2');
    expect(out).toEqual(['verify-r2', 'verify-r2']); // positional: both positions map, NOT collapsed
  });

  it('handles an empty / undefined dep list as an empty result', () => {
    expect(remapDeps([], (l) => l)).toEqual([]);
    expect(remapDeps(undefined, (l) => 'x')).toEqual([]);
  });
});
