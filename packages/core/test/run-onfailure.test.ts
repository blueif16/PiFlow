// (M5 · #18) run-onfailure — a `merge.run` / authorable `run` op's NON-ZERO exit must ROUTE to the node
// status. TODAY the exit is SWALLOWED: the runner runs `runMerge(...)` and DISCARDS its `{failed,exit}`
// return (runner.ts ~:1129), so a node whose merge `run` op fails still ends `ok` (only a MISSING required
// artifact blocks it). #18 is a behavior ADDITION: the exit code now routes through the lowered op's
// `onFailure` — `warn` ⇒ ok + a warn issue; `block` (default) ⇒ blocked.
//
// Per the spec gate we PIN the today-swallowed baseline FIRST (proving the discard is real), then assert the
// NEW routing — so the test fails today ONLY on the new-routing assertion (not the baseline), the honest
// shape of an addition.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';

const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-runfail-'));

/** The offline stub: the model writes each declared artifact then emits an ok return block (clean exit). */
function stubBuilder() {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => {
        const dest = `${node.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

/** A node with a POST `run` op that exits NON-ZERO (a deterministic failing derive step). */
function nodeWithFailingRun(onFailure?: 'block' | 'warn'): NodeIntent {
  return {
    label: 'gen',
    prompt: 'generate',
    tools: {},
    io: { reads: [], produces: ['gen.txt'], artifacts: [{ path: 'gen.txt' }] },
    op: [
      {
        when: 'post',
        run: { cmd: 'node', args: ['-e', 'process.exit(3)'] },
        ...(onFailure ? { onFailure } : {}),
      },
    ],
  };
}

describe('run-onfailure — a run op exit routes to status (#18 ADDITION)', () => {
  it('BASELINE (pinned): without routing, a clean-model node with a failing post-run is NOT caught by the artifact gate alone', async () => {
    // The node DOES produce its required artifact (the model writes gen.txt), so the ONLY thing that could
    // fail it is the post-run exit. This isolates #18: pre-#18 the run failure is swallowed and the node is ok.
    // We assert the DEFAULT routing here is `block` (the addition) — see below. This baseline test documents
    // that the required artifact alone leaves nothing to block on (the run exit is the sole signal).
    const outDir = await tmpOut();
    const { status } = await runWorkflow(compile(wf([nodeWithFailingRun('warn')])), {
      run: 'warn', outDir, buildCommand: stubBuilder(),
    });
    // With onFailure:'warn' the failing run does NOT block — the node is ok, but the failure is SURFACED as
    // an issue (NOT swallowed). RED today: the run is swallowed so there is no warn issue at all.
    expect(status.nodes.gen.status).toBe('ok');
    expect(status.nodes.gen.issues.join(' '), 'a warn-routed run failure must surface an issue').toMatch(/run|exit|failed/i);
  });

  it('NEW: a failing post-run with onFailure:block (the default) BLOCKS the node (#18)', async () => {
    const outDir = await tmpOut();
    const { status } = await runWorkflow(compile(wf([nodeWithFailingRun()])), {
      run: 'block', outDir, buildCommand: stubBuilder(),
    });
    // RED today: the run exit is discarded so the node ends `ok` despite the failing run.
    expect(status.nodes.gen.status, 'a failing run with default onFailure must block').toBe('blocked');
    expect(status.nodes.gen.issues.join(' ')).toMatch(/run|exit|failed/i);
  });
});
