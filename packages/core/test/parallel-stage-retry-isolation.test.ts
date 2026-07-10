import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, InMemorySandboxProvider } from '../src/index.js';
import type { NodeIntent, WorkflowSpec, NodeSpec } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';

// ── PARALLEL-STAGE RETRY ISOLATION (run 260710-02, gap #3) ────────────────────────────────────────────
// A parallel tier (`workflow.json` parallel:true stage) dispatched all 7 siblings as ONE batch; when
// `juice` crashed, the runner re-issued the FULL prompt to all 7 sessions — even the 6 that had already
// reached submit_result — twice, burning ~921s of dead wait coupled to one node's crash-loop.
//
// The invariant this test LOCKS: within one parallel stage, a node that FAILED its own attempt retries
// ONLY itself; every sibling that already produced its artifact executes EXACTLY ONCE and is never
// re-dispatched by another lane's failure. If a future refactor reintroduces a stage-level (whole-batch)
// retry, the sibling call-counts below go to 2 and this test goes red.

function n(label: string, produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return { label, prompt: `do ${label}`, tools: {}, io: { reads: [], produces, artifacts: produces.map((p) => ({ path: p })) }, ...over };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-parallel-iso-'));

describe('parallel-stage retry isolation — one lane failing never re-dispatches its siblings', () => {
  it('a sibling that reached submit_result executes exactly once; only the failed lane retries', async () => {
    // Three nodes with NO deps between them → compiled into ONE parallel stage (all in flight together).
    // `mid` fails its FIRST attempt (produces nothing → contract breach → same-model retry) then succeeds;
    // `left`/`right` succeed on attempt 1. All three carry `retries:1` so a stage-wide re-dispatch (the
    // bug) would show up as a SECOND builder call on the already-succeeded siblings.
    const g = compile(
      wf([
        n('Left', ['left.txt'], { io: { reads: [], produces: ['left.txt'], artifacts: [{ path: 'left.txt' }], retries: 1 } }),
        n('Mid', ['mid.txt'], { io: { reads: [], produces: ['mid.txt'], artifacts: [{ path: 'mid.txt' }], retries: 1 } }),
        n('Right', ['right.txt'], { io: { reads: [], produces: ['right.txt'], artifacts: [{ path: 'right.txt' }], retries: 1 } }),
      ]),
    );
    const outDir = await tmpOut();

    // Per-node builder-invocation counter. `mid`'s first invocation produces NOTHING (fails its own
    // contract → one retry); its second produces the artifact. Siblings always produce on the first call.
    const calls = new Map<string, number>();
    const builder = (nodeSpec: NodeSpec & { sandbox: { output: string } }): string => {
      const id = nodeSpec.id;
      const seen = (calls.get(id) ?? 0) + 1;
      calls.set(id, seen);
      const out = nodeSpec.sandbox.output;
      const artifact = nodeSpec.io.produces[0];
      if (id === 'mid' && seen === 1) return 'true'; // attempt 1: produce nothing → the failing lane
      return `mkdir -p ${out} && printf '%s' done > ${out}/${artifact}`;
    };

    const { status } = await runWorkflow(g, {
      run: 'iso',
      outDir,
      provider: new InMemorySandboxProvider(),
      buildCommand: builder as never,
    });

    // All three nodes ended OK (mid recovered on its own retry).
    expect(status.nodes.left.status).toBe('ok');
    expect(status.nodes.mid.status).toBe('ok');
    expect(status.nodes.right.status).toBe('ok');

    // THE INVARIANT: the failed lane ran twice; each sibling ran EXACTLY ONCE (never re-dispatched by
    // mid's failure). A whole-batch retry would make these 2.
    expect(calls.get('mid')).toBe(2);
    expect(calls.get('left')).toBe(1);
    expect(calls.get('right')).toBe(1);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
