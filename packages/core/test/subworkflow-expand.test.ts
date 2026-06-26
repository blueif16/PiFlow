// (G9) expandSubworkflow — inlines a `node.subworkflow` reference as a sub-DAG, mirroring the fusion
// expansion precedent. The load-bearing assertions: (1) X is REPLACED by the child's id-namespaced
// nodes; (2) child ENTRY nodes inherit X's upstream deps; (3) parent deps on X are rewired to the child
// TERMINAL; (4) after compile() the spliced edges form `upstream → child-entry → … → child-terminal →
// downstream`; (5) a no-subworkflow spec is returned untouched; (6) cycles / depth-cap / unresolvable
// refs throw loudly; (7) the child's realized prompts ride in-memory on the generated nodes. Built
// test-first against the stub (which returns the spec unchanged → the splice assertions go RED).

import { describe, it, expect } from 'vitest';
import {
  expandSubworkflow,
  SubworkflowConfigError,
  type SubworkflowExpandOpts,
} from '../src/workflow/subworkflow/expand.js';
import { compile } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/types.js';

/** A 2-node child sub-template `verify`: gather (entry) → judge (terminal). */
function verifyChild(): WorkflowSpec {
  const gather: NodeIntent = {
    label: 'gather',
    prompt: 'CHILD: gather the claims.',
    tools: {},
    io: { reads: [], produces: ['sub/claims.json'], dependsOn: [], artifacts: [{ path: 'sub/claims.json' }] },
  };
  const judge: NodeIntent = {
    label: 'judge',
    prompt: 'CHILD: judge the claims.',
    tools: {},
    io: { reads: [], produces: ['sub/verdict.json'], dependsOn: ['gather'], artifacts: [{ path: 'sub/verdict.json' }] },
  };
  return { meta: { name: 'verify', description: 'd' }, nodes: [gather, judge] };
}

/** A parent `prep → review(subworkflow?) → publish` chain (deps-wired, like a real template). */
function parentWith(sub: NodeIntent['subworkflow']): WorkflowSpec {
  const prep: NodeIntent = {
    label: 'prep',
    prompt: 'prep',
    tools: {},
    io: { reads: [], produces: ['out/topic.md'], dependsOn: [], artifacts: [{ path: 'out/topic.md' }] },
  };
  const review: NodeIntent = {
    label: 'review',
    prompt: 'review',
    tools: {},
    io: { reads: [], produces: ['out/final.md'], dependsOn: ['prep'], artifacts: [{ path: 'out/final.md' }] },
    ...(sub ? { subworkflow: sub } : {}),
  };
  const publish: NodeIntent = {
    label: 'publish',
    prompt: 'publish',
    tools: {},
    io: { reads: [], produces: ['out/done.md'], dependsOn: ['review'], artifacts: [{ path: 'out/done.md' }] },
  };
  return { meta: { name: 't', description: 'd' }, nodes: [prep, review, publish] };
}

/** loadChild over a fixed in-memory catalog; an unknown ref throws (the dangling-ref case). */
const catalog = (extra: Record<string, () => WorkflowSpec> = {}): SubworkflowExpandOpts['loadChild'] => {
  const map: Record<string, () => WorkflowSpec> = { verify: verifyChild, ...extra };
  return async (ref) => {
    const make = map[ref];
    if (!make) throw new Error(`no such template: ${ref}`);
    return make();
  };
};

const labels = (s: WorkflowSpec): string[] => s.nodes.map((n) => n.label).sort();
const find = (s: WorkflowSpec, label: string): NodeIntent => s.nodes.find((n) => n.label === label)!;
const edgesInto = (wf: ReturnType<typeof compile>, id: string): string[] =>
  wf.edges.filter((e) => e.to === id).map((e) => e.from).sort();

describe('expandSubworkflow — splice', () => {
  it('REPLACES the activated node with the child nodes, id-namespaced under it', async () => {
    const out = await expandSubworkflow(parentWith({ ref: 'verify' }), { loadChild: catalog() });
    // `review` is gone; its child is spliced in namespaced as `review__gather`, `review__judge`.
    expect(labels(out)).toEqual(['prep', 'publish', 'review__gather', 'review__judge']);
    expect(out.nodes.find((n) => n.label === 'review')).toBeUndefined();
    expect(find(out, 'review__judge').subworkflow).toBeUndefined(); // no re-expansion marker left
  });

  it('carries the child realized prompts in-memory onto the spliced nodes', async () => {
    const out = await expandSubworkflow(parentWith({ ref: 'verify' }), { loadChild: catalog() });
    expect(find(out, 'review__gather').prompt).toBe('CHILD: gather the claims.');
    expect(find(out, 'review__judge').prompt).toBe('CHILD: judge the claims.');
  });

  it('child ENTRY nodes inherit the activated node\'s upstream deps', async () => {
    const out = await expandSubworkflow(parentWith({ ref: 'verify' }), { loadChild: catalog() });
    // gather had no in-child deps ⇒ it inherits review's deps (`prep`).
    expect(find(out, 'review__gather').io.dependsOn).toEqual(['prep']);
  });

  it('compiles to upstream → child-entry → child-terminal → downstream', async () => {
    const wf = compile(await expandSubworkflow(parentWith({ ref: 'verify' }), { loadChild: catalog() }));
    expect(edgesInto(wf, 'review-gather')).toEqual(['prep']); // prep → entry
    expect(edgesInto(wf, 'review-judge')).toEqual(['review-gather']); // entry → terminal (in-child edge, namespaced)
    expect(edgesInto(wf, 'publish')).toEqual(['review-judge']); // terminal → downstream (X's edge survives)
  });
});

describe('expandSubworkflow — passthrough', () => {
  it('returns the SAME spec object when no node activates a subworkflow', async () => {
    const spec = parentWith(undefined);
    expect(await expandSubworkflow(spec, { loadChild: catalog() })).toBe(spec); // referential — untouched
  });
});

describe('expandSubworkflow — nesting, cycles, depth, dangling ref', () => {
  it('flattens nested subworkflows (a child that itself references another)', async () => {
    // `outer` contains a node that references `verify`.
    const outer = (): WorkflowSpec => ({
      meta: { name: 'outer', description: 'd' },
      nodes: [
        {
          label: 'wrap',
          prompt: 'OUTER wrap',
          tools: {},
          io: { reads: [], produces: ['o/x.json'], dependsOn: [], artifacts: [{ path: 'o/x.json' }] },
          subworkflow: { ref: 'verify' },
        },
      ],
    });
    const out = await expandSubworkflow(parentWith({ ref: 'outer' }), { loadChild: catalog({ outer }) });
    // review → (outer) → wrap → (verify) → gather/judge ; fully flattened, double-namespaced.
    expect(labels(out)).toEqual(['prep', 'publish', 'review__wrap__gather', 'review__wrap__judge']);
  });

  it('throws SubworkflowConfigError on a self/mutual reference cycle', async () => {
    const cyclic = (): WorkflowSpec => ({
      meta: { name: 'cyclic', description: 'd' },
      nodes: [
        {
          label: 'loop',
          prompt: 'loop',
          tools: {},
          io: { reads: [], produces: ['c/x.json'], dependsOn: [], artifacts: [{ path: 'c/x.json' }] },
          subworkflow: { ref: 'cyclic' },
        },
      ],
    });
    await expect(
      expandSubworkflow(parentWith({ ref: 'cyclic' }), { loadChild: catalog({ cyclic }) }),
    ).rejects.toThrow(SubworkflowConfigError);
  });

  it('throws SubworkflowConfigError when nesting exceeds maxDepth', async () => {
    const lvl1 = (): WorkflowSpec => ({
      meta: { name: 'lvl1', description: 'd' },
      nodes: [
        {
          label: 'n1',
          prompt: 'n1',
          tools: {},
          io: { reads: [], produces: ['l/1.json'], dependsOn: [], artifacts: [{ path: 'l/1.json' }] },
          subworkflow: { ref: 'verify' }, // a 2nd level
        },
      ],
    });
    await expect(
      expandSubworkflow(parentWith({ ref: 'lvl1' }), { loadChild: catalog({ lvl1 }), maxDepth: 1 }),
    ).rejects.toThrow(SubworkflowConfigError);
  });

  it('throws SubworkflowConfigError on an unresolvable ref (dangling)', async () => {
    await expect(
      expandSubworkflow(parentWith({ ref: 'nope' }), { loadChild: catalog() }),
    ).rejects.toThrow(SubworkflowConfigError);
  });
});
