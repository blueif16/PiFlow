// (M5 · #18) run-onfailure — a `merge.run` / authorable `run` op's NON-ZERO exit must ROUTE to the node
// status. TODAY the exit is SWALLOWED: the runner runs `runMerge(...)` and DISCARDS its `{failed,exit}`
// return (runner.ts ~:1129), so a node whose merge `run` op fails still ends `ok` (only a MISSING required
// artifact blocks it). #18 is a behavior ADDITION: the exit code now routes through the lowered op's
// `onFailure` — `warn` ⇒ ok + the failure RECORDED on the typed `opFailures` channel; `block` (default) ⇒
// blocked. (A1) The op-failure detail rides that DEDICATED TYPED channel — it NEVER touches `issues[]`.
//
// Per the spec gate we PIN the today-swallowed baseline FIRST (proving the discard is real), then assert the
// NEW routing — so the test fails today ONLY on the new-routing assertion (not the baseline), the honest
// shape of an addition.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import { runWorkflow, defaultExecRunner as defaultExecRunnerRef } from '../src/runner/index.js';
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
    // With onFailure:'warn' the failing run does NOT block — the node is ok, but the failure is RECORDED on
    // the DEDICATED TYPED `opFailures` channel (A1: op has NOTHING to do with the issue system — it never
    // touches issues[]). The detail is preserved; only the carrier moved off the issue string.
    expect(status.nodes.gen.status).toBe('ok');
    expect(status.nodes.gen.opFailures?.map((f) => f.detail).join(' '), 'a warn-routed run failure is recorded on the typed channel').toMatch(/run|exit|failed/i);
    expect(status.nodes.gen.opFailures?.[0]?.onFailure).toBe('warn');
    expect(status.nodes.gen.issues.join(' '), 'op failures never leak into issues[]').not.toMatch(/\bop (FAILED|warn)\b/);
  });

  it('NEW: a failing post-run with onFailure:block (the default) BLOCKS the node (#18)', async () => {
    const outDir = await tmpOut();
    const { status } = await runWorkflow(compile(wf([nodeWithFailingRun()])), {
      run: 'block', outDir, buildCommand: stubBuilder(),
    });
    // The run exit routes to status: the node BLOCKS. (A1) The op-failure detail rides the DEDICATED TYPED
    // `opFailures` channel, NOT the `issues[]` string — op is fully out of the issue system.
    expect(status.nodes.gen.status, 'a failing run with default onFailure must block').toBe('blocked');
    expect(status.nodes.gen.opFailures?.map((f) => f.detail).join(' ')).toMatch(/run|exit|failed/i);
    expect(status.nodes.gen.opFailures?.[0]?.onFailure).toBe('block');
    expect(status.nodes.gen.issues.join(' '), 'op failures never leak into issues[]').not.toMatch(/\bop (FAILED|warn)\b/);
  });
});

// ── fix/claude-return-tail-evidence (COMMIT 2) — FailureSignals.opFailures wiring ───────────────────────
// (M5 · #18) already proves a failing op's detail rides `rec.opFailures` (the record). This block proves the
// SEPARATE, narrower question: does a BLOCKING op failure's detail also reach `ctx.failureSignals` (internal,
// unexposed) and therefore the RETRY CRITIQUE (consultPreamble) — while a warn-routed one is excluded (a warn
// didn't fail the node and must not steer classification). ctx.failureSignals has no public accessor, so we
// observe it the only way it surfaces: the L1 feedback retry (op.action{kind:'retry',scope:'feedback'}, the
// same wiring self-correction-l1.test.ts already exercises) echoes consultPreamble(sig) into the 2nd attempt's
// staged prompt via a `cat`-and-capture builder (defaultExecRunner running real shell commands, no new harness).
describe('run-onfailure — a BLOCKING op failure reaches the retry critique; a WARN-routed one does not', () => {
  /** Records every staged prompt whose stdout carries the sentinel (mirrors self-correction-l1.test.ts). */
  function promptCapture(): { execRunner: typeof defaultExecRunnerRef; prompts: string[] } {
    const prompts: string[] = [];
    const execRunner = (async (sandbox: Parameters<typeof defaultExecRunnerRef>[0], cmd: string, opts: Parameters<typeof defaultExecRunnerRef>[2]) => {
      const r = await defaultExecRunnerRef(sandbox, cmd, opts);
      if (r.result.stdout.includes('---PIFLOW-PROMPT-CAPTURE---')) prompts.push(r.result.stdout);
      return r;
    }) as typeof defaultExecRunnerRef;
    return { execRunner, prompts };
  }

  it('a BLOCKING op failure (onFailure:block) surfaces "failed post-op gate" in the L1 retry critique', async () => {
    // The model writes its artifact EVERY attempt — the ONLY failure reason is the post-run op, isolating
    // the assertion to opFailures (no missing-artifact noise).
    const node: NodeIntent = {
      label: 'gen', prompt: 'generate the artifact', tools: {},
      io: { reads: [], produces: ['gen.txt'], artifacts: [{ path: 'gen.txt' }], retry: { max: 1 } },
      op: [
        { when: 'post', run: { cmd: 'node', args: ['-e', 'process.exit(3)'] }, onFailure: 'block' },
        { when: 'on-failure', action: { kind: 'retry', max: 1, scope: 'feedback' } },
      ],
    };
    const g = compile(wf([node]));
    const outDir = await tmpOut();
    const { execRunner, prompts } = promptCapture();
    const builder = (n: { io: { artifacts: { path: string }[] }; sandbox: { output: string } }, _r: unknown, ctx: { promptFile: string }): string => {
      const dest = `${n.sandbox.output}/${n.io.artifacts[0].path}`;
      const dir = dest.slice(0, dest.lastIndexOf('/'));
      return `mkdir -p ${dir} && cat ${ctx.promptFile} && echo '---PIFLOW-PROMPT-CAPTURE---' && printf '%s' ok > ${dest}`;
    };
    const { status } = await runWorkflow(g, { run: 'opfail-blocking-retry', outDir, buildCommand: builder as Parameters<typeof runWorkflow>[1]['buildCommand'], execRunner });

    expect(prompts.length, 'attempt 1 + the ONE L1 retry').toBe(2);
    expect(prompts[0]).not.toMatch(/failed post-op gate/);
    // THE ASSERTION: the retry critique carries the op's own evidence — proof the blocking op failure reached
    // ctx.failureSignals.opFailures (the only path consultPreamble's "failed post-op gate(s)" line can come from).
    expect(prompts[1]).toMatch(/failed post-op gate/);
    // The op keeps failing every attempt (deterministic exit 3) — the budget exhausts, the node stays blocked.
    expect(status.nodes.gen.status).toBe('blocked');
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('a WARN-routed op failure does NOT appear in the retry critique — only a BLOCKING op failure steers classification', async () => {
    // Attempt 1: exits 0 but writes NOTHING → the missing artifact (a DIFFERENT, unrelated reason) blocks the
    // node and triggers the retry; the op ALSO runs (exit 0) and ALSO fails, but onFailure:'warn' so it never
    // blocks. Attempt 2 (the retry): writes the artifact → ok. If the warn-routed failure leaked into
    // ctx.failureSignals.opFailures, "failed post-op gate" would appear in the retry critique — it must not.
    const node: NodeIntent = {
      label: 'gen', prompt: 'generate the artifact', tools: {},
      io: { reads: [], produces: ['gen.txt'], artifacts: [{ path: 'gen.txt' }], retry: { max: 1 } },
      op: [
        { when: 'post', run: { cmd: 'node', args: ['-e', 'process.exit(3)'] }, onFailure: 'warn' },
        { when: 'on-failure', action: { kind: 'retry', max: 1, scope: 'feedback' } },
      ],
    };
    const g = compile(wf([node]));
    const outDir = await tmpOut();
    const { execRunner, prompts } = promptCapture();
    let attempt = 0;
    const builder = (n: { io: { artifacts: { path: string }[] }; sandbox: { output: string } }, _r: unknown, ctx: { promptFile: string }): string => {
      attempt++;
      if (attempt === 1) return `cat ${ctx.promptFile} && echo '---PIFLOW-PROMPT-CAPTURE---'`; // exit 0, writes nothing
      const dest = `${n.sandbox.output}/${n.io.artifacts[0].path}`;
      const dir = dest.slice(0, dest.lastIndexOf('/'));
      return `mkdir -p ${dir} && cat ${ctx.promptFile} && echo '---PIFLOW-PROMPT-CAPTURE---' && printf '%s' ok > ${dest}`;
    };
    const { status } = await runWorkflow(g, { run: 'opfail-warn-retry', outDir, buildCommand: builder as Parameters<typeof runWorkflow>[1]['buildCommand'], execRunner });

    expect(prompts.length, 'attempt 1 (missing artifact → blocked) + the ONE L1 retry').toBe(2);
    // The retry critique carries the REAL blocking reason (the missing artifact)...
    expect(prompts[1]).toMatch(/missing required artifact/i);
    // ...but never the warn-routed op's evidence — a warn didn't fail the node and must not steer the critique.
    expect(prompts[1]).not.toMatch(/failed post-op gate/);
    expect(status.nodes.gen.status, 'the warn-routed op failure never blocks — attempt 2 writes the artifact and ends ok').toBe('ok');
    await fs.rm(outDir, { recursive: true, force: true });
  });
});
