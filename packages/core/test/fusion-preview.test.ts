// The FUSION PREVIEW pair — the SDK half of the GUI's "fusion mode" so the DAG transform is NEVER a
// view-local rewrite. `withNodeFusion` is the author-level toggle (set/strip a node's `fusion` by id);
// `previewView` projects a COMPILED Workflow → the run-view contract WITHOUT a run on disk. The
// load-bearing claim (the last test): `previewView(compile(expandFusion(spec)))` renders the EXACT
// siblings→judge DAG a live run would execute — so the preview IS the real expansion, not a mock of it.
// Test-first against deliberately-wrong stubs (withNodeFusion returns the spec unchanged; previewView
// returns an empty structure) ⇒ the set/strip + stage/edge/node assertions go RED.

import { describe, it, expect } from 'vitest';
import { expandFusion, withNodeFusion } from '../src/workflow/fusion/expand.js';
import { previewView } from '../src/observe/runView.js';
import { compile } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/types.js';

/** A plain two-node pipeline `alpha → beta` (beta reads alpha's artifact). */
function linear(): WorkflowSpec {
  const alpha: NodeIntent = {
    label: 'alpha',
    prompt: 'write a',
    tools: { allow: ['fs:write'] },
    model: 'm-a',
    io: { reads: [], produces: ['out/a.md'], artifacts: [{ path: 'out/a.md' }] },
  };
  const beta: NodeIntent = {
    label: 'beta',
    prompt: 'write b',
    tools: {},
    agentType: 'general-purpose',
    io: { reads: ['out/a.md'], produces: ['out/b.md'], artifacts: [{ path: 'out/b.md' }] },
  };
  return { meta: { name: 'lin', description: 'd' }, nodes: [alpha, beta] };
}

/** A single bare producer `synth` (no fusion) — the target the toggle activates. */
function bare(): WorkflowSpec {
  const synth: NodeIntent = {
    label: 'synth',
    prompt: 'p',
    tools: {},
    io: { reads: [], produces: ['out/x.md'], artifacts: [{ path: 'out/x.md' }] },
  };
  return { meta: { name: 't', description: 'd' }, nodes: [synth] };
}

describe('withNodeFusion — the author-level fusion toggle', () => {
  it('SETS a fusion block on the node matched by id, leaving the rest of the node intact', () => {
    const out = withNodeFusion(bare(), 'synth', { mode: 'best-of-n', n: 3 });
    expect(out.nodes[0].fusion).toEqual({ mode: 'best-of-n', n: 3 });
    expect(out.nodes[0].prompt).toBe('p'); // the rest of the node is untouched
  });

  it('STRIPS the fusion block when passed null (the "off" choice)', () => {
    const activated = withNodeFusion(bare(), 'synth', { mode: 'moa', panel: ['fast', 'deep'] });
    const off = withNodeFusion(activated, 'synth', null);
    expect(off.nodes[0].fusion).toBeUndefined();
  });

  it('is a no-op for an unknown id, and never mutates the input spec', () => {
    const spec = bare();
    const out = withNodeFusion(spec, 'does-not-exist', { mode: 'best-of-n' });
    expect(out.nodes[0].fusion).toBeUndefined(); // nothing matched ⇒ unchanged
    withNodeFusion(spec, 'synth', { mode: 'best-of-n' }); // a real set on the same input…
    expect(spec.nodes[0].fusion).toBeUndefined(); // …must NOT mutate the caller's spec
  });
});

describe('previewView — compiled Workflow → run-view (no run on disk)', () => {
  it('projects each compiled stage to a RunViewStage (index, nodeIds, null phase → "—")', () => {
    const view = previewView(compile(linear()));
    expect(view.stages).toEqual([
      { index: 1, phase: '—', parallel: false, nodeIds: ['alpha'] },
      { index: 2, phase: '—', parallel: false, nodeIds: ['beta'] },
    ]);
  });

  it('projects nodes as telemetry-free + pending, placed by stage column / lane row, carrying model + agentType', () => {
    const view = previewView(compile(linear()));
    expect(view.nodes).toHaveLength(2); // fail HERE (not throw) under the empty stub
    const a = view.nodes.find((n) => n.id === 'alpha')!;
    const b = view.nodes.find((n) => n.id === 'beta')!;
    expect(a.status).toBe('pending');
    expect(a.model).toBe('m-a');
    expect(a.stageIndex).toBe(1);
    expect(a.lane).toBe(0);
    expect(a.toolCalls).toBe(0);
    expect(a.tokens).toBeUndefined(); // no telemetry invented
    expect(b.stageIndex).toBe(2);
    expect(b.agentType).toBe('general-purpose'); // branding rides through for the GUI catalog
  });

  it('projects each compiled edge to a RunViewEdge (from, to, the produced path)', () => {
    const view = previewView(compile(linear()));
    expect(view.edges).toEqual([{ from: 'alpha', to: 'beta', path: 'out/a.md' }]);
  });

  it('stamps the run id / provider from opts (defaulting the id to the workflow name)', () => {
    const wf = compile(linear());
    expect(previewView(wf).run).toBe('lin');
    expect(previewView(wf, { run: 'preview-1', provider: 'cp' }).run).toBe('preview-1');
    expect(previewView(wf, { provider: 'cp' }).provider).toBe('cp');
  });

  it('renders the EXACT fusion expansion: siblings share one parallel stage feeding the judge', () => {
    const moa: WorkflowSpec = {
      meta: { name: 't', description: 'd' },
      nodes: [
        {
          label: 'synth',
          prompt: 'TASK',
          tools: { allow: ['fs:read', 'fs:write'] },
          model: 'base',
          io: { reads: [], produces: ['out/answer.md'], artifacts: [{ path: 'out/answer.md' }] },
          sandbox: { read: ['src'], write: ['out/**'] },
          fusion: { mode: 'moa', panel: ['model-a', 'model-b'] },
        },
        {
          label: 'publish',
          prompt: 'pub',
          tools: {},
          io: { reads: ['out/answer.md'], produces: ['out/final.md'], artifacts: [{ path: 'out/final.md' }] },
        },
      ],
    };
    const view = previewView(compile(expandFusion(moa)));
    // the two siblings sit together in ONE parallel stage…
    const parallel = view.stages.find((s) => s.parallel);
    expect([...(parallel?.nodeIds ?? [])].sort()).toEqual(['synth-p1', 'synth-p2']);
    // …both feed the judge (kept id `synth`), which still feeds `publish`.
    expect(view.edges.filter((e) => e.to === 'synth').map((e) => e.from).sort()).toEqual(['synth-p1', 'synth-p2']);
    expect(view.edges.filter((e) => e.from === 'synth').map((e) => e.to)).toEqual(['publish']);
    // the judge carries the fusion preset agentType so the GUI brands it with the fusion icon.
    expect(view.nodes.find((n) => n.id === 'synth')?.agentType).toBe('fusion-judge-moa');
  });
});
