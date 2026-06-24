import { describe, it, expect } from 'vitest';
import { compile, tryCompile, WorkflowError } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';

/** A NodeIntent factory: declares reads/produces; artifacts default to produces. */
function n(
  label: string,
  reads: string[],
  produces: string[],
  io: Partial<NodeIntent['io']> = {},
): NodeIntent {
  return {
    label,
    prompt: `do ${label}`,
    tools: {},
    io: { reads, produces, artifacts: produces.map((p) => ({ path: p })), ...io },
  };
}

const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });

describe('compile — data-flow edge inference', () => {
  it('infers an edge from a produced file that another node reads', () => {
    const g = compile(wf([n('A', [], ['a.txt']), n('B', ['a.txt'], ['b.txt'])]));
    expect(g.edges).toEqual([{ from: 'a', to: 'b', files: ['a.txt'] }]);
    expect(g.stages.map((s) => s.nodeIds)).toEqual([['a'], ['b']]);
  });

  it('puts independent producers in one parallel stage and the consumer after', () => {
    const g = compile(wf([n('A', [], ['a.txt']), n('B', [], ['b.txt']), n('C', ['a.txt', 'b.txt'], ['c.txt'])]));
    expect(g.stages[0]).toMatchObject({ index: 1, parallel: true, nodeIds: ['a', 'b'] });
    expect(g.stages[1]).toMatchObject({ index: 2, parallel: false, nodeIds: ['c'] });
    expect(g.edges).toEqual([
      { from: 'a', to: 'c', files: ['a.txt'] },
      { from: 'b', to: 'c', files: ['b.txt'] },
    ]);
  });

  it('honors an explicit dependsOn edge with no data-flow', () => {
    const b = n('B', [], []);
    b.io.dependsOn = ['a'];
    const g = compile(wf([n('A', [], []), b]));
    expect(g.edges).toEqual([{ from: 'a', to: 'b', files: [] }]);
    expect(g.stages.map((s) => s.nodeIds)).toEqual([['a'], ['b']]);
  });

  it('de-duplicates node ids by suffixing', () => {
    const g = compile(wf([n('My Node', [], ['x']), n('My Node', ['x'], ['y'])]));
    expect(Object.keys(g.nodes)).toEqual(['my-node', 'my-node-2']);
  });
});

describe('compile — validation (each must reject a broken graph)', () => {
  it('rejects a read with no producer', () => {
    const { errors } = tryCompile(wf([n('B', ['ghost.txt'], ['b.txt'])]));
    expect(errors.join('\n')).toMatch(/missing producer.*ghost\.txt/);
    expect(() => compile(wf([n('B', ['ghost.txt'], ['b.txt'])]))).toThrow(WorkflowError);
  });

  it('accepts a read with no producer when declared as an externalInput', () => {
    const g = compile(wf([n('B', ['raw.csv'], ['b.txt'], { externalInputs: ['raw.csv'] })]));
    expect(g.edges).toEqual([]); // raw input → B is a root
    expect(g.stages[0]?.nodeIds).toEqual(['b']);
  });

  it('rejects two nodes producing the same file', () => {
    const { errors } = tryCompile(wf([n('A', [], ['dup.txt']), n('B', [], ['dup.txt'])]));
    expect(errors.join('\n')).toMatch(/duplicate producer.*dup\.txt/);
  });

  it('rejects a cycle', () => {
    // A reads b.txt (from B) and produces a.txt; B reads a.txt (from A) and produces b.txt.
    const g = wf([n('A', ['b.txt'], ['a.txt']), n('B', ['a.txt'], ['b.txt'])]);
    expect(tryCompile(g).errors.join('\n')).toMatch(/cycle/);
    expect(() => compile(g)).toThrow(WorkflowError);
  });

  it('rejects a dependsOn to an unknown node', () => {
    const b = n('B', [], ['b.txt']);
    b.io.dependsOn = ['nope'];
    expect(tryCompile(wf([b])).errors.join('\n')).toMatch(/unknown node.*nope/);
  });
});
