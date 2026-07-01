import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';
import { loadJournal } from '../src/runner/journal.js';
import { requestFreeze, freezeFile } from '../src/runner/migrate.js';
import { existsSync } from 'node:fs';

// ── harness (mirrors runner.test.ts) ────────────────────────────────────────────────────────────────
function n(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return { label, prompt: `do ${label}`, tools: {}, io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) }, ...over };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 'freeze-t', description: 'd' }, nodes });
async function tmpOut(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-freeze-'));
}
/** Offline builder: each node writes its declared artifacts into its sandbox output dir + an ok return. */
function stubBuilder() {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => `mkdir -p ${node.sandbox.output} && printf '%s' ${node.id} > ${node.sandbox.output}/${a.path}`)
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok"}\\n\`\`\`'`;
    return `${writes} && ${ret}`;
  };
}
// A → B (B reads A's artifact) ⇒ two topological stages.
const twoStage = () => compile(wf([n('A', [], ['a.txt']), n('B', ['a.txt'], ['b.txt'])]));

// P6 — freeze-at-node-boundary: a running runner quiesces between stages and parks for migration.
describe('runWorkflow freeze-at-node-boundary', () => {
  it('parks after the current stage: later stages stay pending, run is frozen (not done), journal keeps the done node', async () => {
    const outDir = await tmpOut();
    // freezeSignal fires immediately ⇒ after the FIRST stage completes, the boundary check parks the run.
    const res = await runWorkflow(twoStage(), {
      outDir,
      buildCommand: stubBuilder() as never,
      freezeSignal: () => true,
      lease: false,
    });

    expect(res.status.frozen).toBe(true);
    expect(res.status.done).toBe(false); // the WORKFLOW is not complete — it's parked
    expect(res.status.nodes['a'].status).toBe('ok'); // stage-1 node ran
    expect(res.status.nodes['b'].status).toBe('pending'); // stage-2 node NEVER ran

    // The journal recorded the completed node ⇒ a resumed runner will REUSE it, not re-run it.
    const j = await loadJournal(outDir);
    expect(j?.nodes['a']).toBeTruthy();
    expect(j?.nodes['b']).toBeUndefined();
  });

  it('resumes a frozen run on the same run-dir: the done node is REUSED, the pending node RUNS, run completes', async () => {
    const outDir = await tmpOut();
    // 1) freeze after stage 1.
    await runWorkflow(twoStage(), { outDir, buildCommand: stubBuilder() as never, freezeSignal: () => true, lease: false });

    // 2) resume — no freeze this time (the migration "reload"): journal drives reuse of A, B runs.
    const res = await runWorkflow(twoStage(), { outDir, buildCommand: stubBuilder() as never, freezeSignal: () => false, lease: false });

    expect(res.status.done).toBe(true);
    expect(res.status.ok).toBe(true);
    expect(res.status.frozen).toBeFalsy();
    expect(res.status.nodes['a'].status).toBe('reused'); // proven-unchanged ⇒ skipped
    expect(res.status.nodes['b'].status).toBe('ok'); // the remaining work ran
    expect(existsSync(path.join(outDir, 'b.txt'))).toBe(true);
  });

  it('resumes a frozen run at a DIFFERENT run-dir path (cross-host migration): a {{RUN}}-token node is REUSED, not re-run', async () => {
    // A node whose prompt embeds {{RUN}} — after migrating to another host the token resolves to a NEW
    // absolute path, but the node's IDENTITY is unchanged, so the journal must STILL drive REUSE. This is
    // the freeze→bundle→adopt promise ("done nodes reused, the tail runs") in the REAL cloud condition
    // (the target run-dir path always differs from the source). A same-run-dir resume can't catch this.
    const spec = () =>
      compile(wf([n('A', [], ['a.txt'], { prompt: 'do A reading {{RUN}}/spec/req.json' }), n('B', ['a.txt'], ['b.txt'])]));
    const src = await tmpOut();
    // 1) run + freeze after stage 1 at the SOURCE path (the "laptop").
    await runWorkflow(spec(), { outDir: src, buildCommand: stubBuilder() as never, freezeSignal: () => true, lease: false });

    // 2) migrate = bundle→adopt: replicate the frozen run-dir at a DIFFERENT physical path (the "cloud host").
    const dst = `${src}-cloud`;
    await fs.cp(src, dst, { recursive: true });

    // 3) resume at the NEW path: A must be REUSED even though {{RUN}} now resolves to `dst`, not `src`.
    const res = await runWorkflow(spec(), { outDir: dst, buildCommand: stubBuilder() as never, freezeSignal: () => false, lease: false });

    expect(res.status.done).toBe(true);
    expect(res.status.ok).toBe(true);
    expect(res.status.nodes['a'].status).toBe('reused'); // path changed, identity did NOT ⇒ REUSE (bug re-ran it)
    expect(res.status.nodes['b'].status).toBe('ok');
    expect(existsSync(path.join(dst, 'b.txt'))).toBe(true);
  });

  it('the default freeze seam watches the .pi/freeze file: writing it parks the run', async () => {
    const outDir = await tmpOut();
    await fs.mkdir(path.join(outDir, '.pi'), { recursive: true });
    await requestFreeze(outDir); // what POST /freeze does — no injected signal, the file IS the signal

    const res = await runWorkflow(twoStage(), { outDir, buildCommand: stubBuilder() as never, lease: false });
    expect(res.status.frozen).toBe(true);
    expect(res.status.nodes['b'].status).toBe('pending');
    expect(existsSync(freezeFile(outDir))).toBe(true);
  });

  it('no freeze ⇒ the run completes normally (parking is off by default)', async () => {
    const outDir = await tmpOut();
    const res = await runWorkflow(twoStage(), { outDir, buildCommand: stubBuilder() as never, lease: false });
    expect(res.status.done).toBe(true);
    expect(res.status.ok).toBe(true);
    expect(res.status.frozen).toBeFalsy();
    expect(res.status.nodes['b'].status).toBe('ok');
  });
});
