// (SA-D · expert-representations) Self-correction L1 — retry.scope:'feedback' wiring.
//
// These tests assert the BEHAVIORAL contract introduced by SA-D:
//
//   1. actionsFromOp extracts the first retry/rerouteTo action from op[]; no action op → both undefined.
//   2. On a retry action with scope:'feedback', the SECOND invocation (the retry) receives the gate's
//      empirical critique (consultPreamble evidence) as a promptPrefix in its staged prompt file.
//      A blind same-input retry (no feedback) is the WRONG default and is detected by this test.
//   3. scope:'fix' stubs through to L1 feedback (not a crash, not a no-op — it uses the feedback path
//      until the memory system is built). This catches a regression where 'fix' silently became a blind retry.
//   4. A node with NO action ops (legacy io.retries path) is UNCHANGED — the feedback injection does not fire.
//
// test-discipline contract: test 2 FAILS without the SA-D wiring (before the change, the second invocation
// receives NO promptPrefix — the prompt file begins with the original prompt, not the critique). Tests 1, 3, 4
// FAIL without actionsFromOp or the scope routing.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { runWorkflow } from '../src/runner/runner.js';
import { actionsFromOp } from '../src/runner/op-dispatch.js';
import type { OpSpec } from '../src/types.js';

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────

const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });

async function tmpOut(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-l1-'));
}

// ── 1 · actionsFromOp — unit tests ───────────────────────────────────────────────────────────────

describe('actionsFromOp — extract retry and rerouteTo from op[]', () => {
  it('returns both undefined when op[] is empty or absent', () => {
    expect(actionsFromOp(undefined)).toEqual({ retryAction: undefined, rerouteAction: undefined });
    expect(actionsFromOp([])).toEqual({ retryAction: undefined, rerouteAction: undefined });
  });

  it('extracts the FIRST retry action (scope, max) from op[]', () => {
    const ops: OpSpec[] = [
      { when: 'on-failure', action: { kind: 'retry', max: 2, scope: 'feedback' } },
      // A second retry op is ignored (first wins — cost-ladder order from lowerGates is deterministic)
      { when: 'on-failure', action: { kind: 'retry', max: 5, scope: 'fix' } },
    ];
    const { retryAction } = actionsFromOp(ops);
    expect(retryAction, 'first retry action must be extracted').toBeDefined();
    expect(retryAction!.max).toBe(2);
    expect(retryAction!.scope).toBe('feedback');
  });

  it('extracts the FIRST rerouteTo action from op[]', () => {
    const ops: OpSpec[] = [
      { when: 'on-failure', action: { kind: 'rerouteTo', node: 'producer', max: 3 } },
    ];
    const { rerouteAction } = actionsFromOp(ops);
    expect(rerouteAction, 'rerouteTo action must be extracted').toBeDefined();
    expect(rerouteAction!.node).toBe('producer');
    expect(rerouteAction!.max).toBe(3);
  });

  it('extracts both retry and rerouteTo from a mixed op[] (judge-gate pattern)', () => {
    const ops: OpSpec[] = [
      { when: 'post', gate: { kind: 'exists', path: 'out.txt' } },
      { when: 'on-failure', action: { kind: 'rerouteTo', node: 'prod', max: 1 } },
      { when: 'on-failure', action: { kind: 'retry', max: 2, scope: 'feedback' } },
    ];
    const { retryAction, rerouteAction } = actionsFromOp(ops);
    expect(retryAction).toBeDefined();
    expect(rerouteAction).toBeDefined();
    expect(retryAction!.scope).toBe('feedback');
    expect(rerouteAction!.node).toBe('prod');
  });

  it('returns undefined for missing action kinds (only gate/run ops present)', () => {
    const ops: OpSpec[] = [
      { when: 'post', gate: { kind: 'exists', path: 'out.txt' } },
      { when: 'post', run: { cmd: 'true' } },
    ];
    const { retryAction, rerouteAction } = actionsFromOp(ops);
    expect(retryAction).toBeUndefined();
    expect(rerouteAction).toBeUndefined();
  });
});

// ── 2 · L1 feedback injection — the critique MUST reach the retry attempt ────────────────────────
//
// THE CORE BEHAVIORAL TEST. The builder function observes WHAT PROMPT the runner stages: the first
// invocation gets the raw resolved node prompt; the RETRY attempt MUST prepend the consultPreamble
// evidence. We capture each staged prompt file's content from the sandbox via a custom buildCommand
// that records it before echoing back as a failure (to exhaust the budget) or success (final attempt).

describe('runWorkflow — retry.scope:feedback injects critique into the retry prompt', () => {
  it('the 2nd attempt prompt starts with the consultPreamble evidence (L1 feedback path)', async () => {
    // A node with `io.retry` (M4 budget of 1 extra attempt) AND an op.action{retry, scope:'feedback'}:
    // the SA-D wiring reads the action op, detects scope:'feedback', and passes consultPreamble(sig) as
    // the promptPrefix to runNode on the retry attempt. Without the wiring, promptPrefix is absent → the
    // 2nd attempt sees the same raw prompt as the 1st → the test FAILS.
    const node: NodeIntent = {
      label: 'Producer',
      prompt: 'produce the artifact',
      tools: {},
      io: {
        reads: [],
        produces: ['out.txt'],
        artifacts: [{ path: 'out.txt' }],
        // io.retry with max:1 gives runNodeWithRetries the budget for one extra attempt.
        retry: { max: 1 },
      },
      // op.action{kind:'retry', scope:'feedback'} is what SA-B gate-authoring emits (gate-authoring.ts:360).
      // The runner must read this and activate L1 feedback injection.
      op: [{ when: 'on-failure', action: { kind: 'retry', max: 1, scope: 'feedback' } }],
    };
    const g = compile(wf([node]));
    const outDir = await tmpOut();

    // The staged prompt file for each attempt is read from the sandbox.
    // We capture it by reading the staged file from the in-memory sandbox directly.
    // Since InMemorySandboxProvider is the default, promptFile is staged INTO the sandbox;
    // the buildCommand receives the promptFile path. We intercept via a recording buildCommand:
    // each invocation records the prompt (read from the sandbox via the command string), then fails.
    const stagdPrompts: string[] = [];
    let attempt = 0;

    // The buildCommand receives the node + resolved + ctx. We capture the promptFile path and, since
    // the sandbox writeFile already staged it, we defer reading until exec captures it. Instead, we
    // use the COMMAND STRING itself as the carrier: the default command's @<promptFile> argument.
    // We wrap the execRunner to intercept the command BEFORE running it and read the prompt content
    // from the sandbox — but since sandbox.readFile is not on the ExecRunner's sandbox type, we
    // instead record the promptFile path from the builder. To observe what was staged, we write a
    // command that cats the prompt file so the stdout carries its content.
    //
    // Simpler approach: write a custom buildCommand that reads the staged prompt via `cat` and echoes
    // it to stdout (which exec captures). We then assert the 2nd call's stdout contains the critique.
    const recordingBuilder = (
      node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } },
      _resolved: unknown,
      ctx: { promptFile: string },
    ): string => {
      attempt++;
      if (attempt === 1) {
        // First attempt: always fail (write nothing → artifact missing → error/blocked → retry triggered)
        return `cat ${ctx.promptFile} && echo '---PIFLOW-PROMPT-CAPTURE---' && exit 1`;
      }
      // Second attempt (the retry): write the artifact so the node succeeds. The prompt content is echoed.
      const out = node.sandbox.output;
      const art = node.io.artifacts[0].path;
      const dest = `${out}/${art}`;
      const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
      return `mkdir -p ${dir} && cat ${ctx.promptFile} && echo '---PIFLOW-PROMPT-CAPTURE---' && printf '%s' ok > ${dest}`;
    };

    // Custom exec: run the real shell command and capture stdout.
    const { defaultExecRunner } = await import('../src/runner/runner.js');
    const captureExec = async (sandbox: import('../src/types.js').Sandbox, cmd: string, opts: import('../src/runner/runner.js').ExecWatchdogOpts) => {
      const r = await defaultExecRunner(sandbox, cmd, opts);
      const capture = r.result.stdout;
      if (capture.includes('---PIFLOW-PROMPT-CAPTURE---')) {
        stagdPrompts.push(capture);
      }
      return r;
    };

    await runWorkflow(g, {
      run: 'l1-feedback',
      outDir,
      buildCommand: recordingBuilder as Parameters<typeof runWorkflow>[1]['buildCommand'],
      execRunner: captureExec,
    });

    // We must have seen 2 attempts (the first failed; the retry succeeded).
    expect(stagdPrompts).toHaveLength(2);

    // The FIRST attempt sees the raw node prompt — no critique prefix.
    expect(stagdPrompts[0]).toContain('produce the artifact');
    expect(stagdPrompts[0]).not.toMatch(/CONSULT|failure class|missing required artifact/i);

    // THE CRITICAL ASSERTION: the SECOND attempt (the L1 retry) must carry the consultPreamble
    // evidence BEFORE the node's own prompt. Without SA-D wiring this FAILS — the second attempt's
    // staged prompt file begins with the raw prompt (same as the first), not the critique.
    expect(stagdPrompts[1]).toMatch(/CONSULT|failure class|missing required artifact/i);
    // The critique precedes the original prompt (prepended, not replaced).
    const critiqueStart = stagdPrompts[1].search(/CONSULT|failure class/i);
    const promptStart = stagdPrompts[1].indexOf('produce the artifact');
    expect(critiqueStart).toBeLessThan(promptStart);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 3 · scope:'fix' stubs through to L1 feedback (not a crash, not a blind retry) ──────────────

describe('runWorkflow — retry.scope:fix stubs through to feedback (L2 not yet implemented)', () => {
  it('scope:fix activates L1 feedback path — critique reaches the retry attempt', async () => {
    // L2 is STUB: when scope:'fix' is present, SA-D falls through to the feedback (L1) path.
    // This test asserts: (a) no crash, (b) the retry receives the critique (not a blind re-run).
    // If L2 were implemented, it would patch the node's prompt/tool-wiring — but right now it MUST
    // still inject consultPreamble, so a 'fix' attempt is at least better than a blind retry.
    const node: NodeIntent = {
      label: 'FixNode',
      prompt: 'build the output',
      tools: {},
      io: {
        reads: [],
        produces: ['fix.txt'],
        artifacts: [{ path: 'fix.txt' }],
        retry: { max: 1 },
      },
      op: [{ when: 'on-failure', action: { kind: 'retry', max: 1, scope: 'fix' } }],
    };
    const g = compile(wf([node]));
    const outDir = await tmpOut();

    let attempt = 0;
    const stagdPrompts: string[] = [];
    const { defaultExecRunner } = await import('../src/runner/runner.js');

    const recordingBuilder = (
      node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } },
      _resolved: unknown,
      ctx: { promptFile: string },
    ): string => {
      attempt++;
      if (attempt === 1) {
        return `cat ${ctx.promptFile} && echo '---PIFLOW-PROMPT-CAPTURE---' && exit 1`;
      }
      const out = node.sandbox.output;
      const art = node.io.artifacts[0].path;
      const dest = `${out}/${art}`;
      const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
      return `mkdir -p ${dir} && cat ${ctx.promptFile} && echo '---PIFLOW-PROMPT-CAPTURE---' && printf '%s' ok > ${dest}`;
    };

    const captureExec = async (sandbox: import('../src/types.js').Sandbox, cmd: string, opts: import('../src/runner/runner.js').ExecWatchdogOpts) => {
      const r = await defaultExecRunner(sandbox, cmd, opts);
      if (r.result.stdout.includes('---PIFLOW-PROMPT-CAPTURE---')) {
        stagdPrompts.push(r.result.stdout);
      }
      return r;
    };

    // Must NOT throw (L2 stub is non-crashing).
    await expect(
      runWorkflow(g, { run: 'l1-fix', outDir, buildCommand: recordingBuilder as Parameters<typeof runWorkflow>[1]['buildCommand'], execRunner: captureExec }),
    ).resolves.toBeDefined();

    // 2 attempts ran.
    expect(stagdPrompts).toHaveLength(2);
    // The retry (attempt 2) receives the critique — even under scope:'fix', the stub uses L1 feedback.
    // Without the wiring this FAILS (blind retry = no critique).
    expect(stagdPrompts[1]).toMatch(/CONSULT|failure class|missing required artifact/i);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 4 · Legacy io.retries path is UNCHANGED (no feedback injection) ──────────────────────────────

describe('runWorkflow — legacy io.retries path (no op.action) is unchanged', () => {
  it('a node with only io.retries and NO op.action does NOT receive a feedback prefix on retry', async () => {
    // The additive invariant: a node that does NOT declare an op.action{retry} keeps the old behavior —
    // a blind same-input retry (no consultPreamble prefix). SA-D must not change this path.
    const node: NodeIntent = {
      label: 'Legacy',
      prompt: 'legacy produce',
      tools: {},
      io: {
        reads: [],
        produces: ['leg.txt'],
        artifacts: [{ path: 'leg.txt' }],
        retries: 1, // the legacy numeric retry field; io.retry and op[] are both absent
      },
    };
    const g = compile(wf([node]));
    const outDir = await tmpOut();

    let attempt = 0;
    const stagdPrompts: string[] = [];
    const { defaultExecRunner } = await import('../src/runner/runner.js');

    const recordingBuilder = (
      node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } },
      _resolved: unknown,
      ctx: { promptFile: string },
    ): string => {
      attempt++;
      if (attempt === 1) {
        return `cat ${ctx.promptFile} && echo '---PIFLOW-PROMPT-CAPTURE---' && exit 1`;
      }
      const out = node.sandbox.output;
      const art = node.io.artifacts[0].path;
      const dest = `${out}/${art}`;
      const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
      return `mkdir -p ${dir} && cat ${ctx.promptFile} && echo '---PIFLOW-PROMPT-CAPTURE---' && printf '%s' ok > ${dest}`;
    };

    const captureExec = async (sandbox: import('../src/types.js').Sandbox, cmd: string, opts: import('../src/runner/runner.js').ExecWatchdogOpts) => {
      const r = await defaultExecRunner(sandbox, cmd, opts);
      if (r.result.stdout.includes('---PIFLOW-PROMPT-CAPTURE---')) {
        stagdPrompts.push(r.result.stdout);
      }
      return r;
    };

    await runWorkflow(g, { run: 'l1-legacy', outDir, buildCommand: recordingBuilder as Parameters<typeof runWorkflow>[1]['buildCommand'], execRunner: captureExec });

    expect(stagdPrompts).toHaveLength(2);
    // The legacy retry MUST NOT inject a consultPreamble prefix (no op.action declared).
    expect(stagdPrompts[1]).not.toMatch(/CONSULT — the prior model/i);
    // It DOES still contain the original prompt (unchanged behavior).
    expect(stagdPrompts[1]).toContain('legacy produce');

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
