// (claude warm-resume) A claude-code node's L1 feedback retry must resume the session CLAUDE minted —
// the UUID captured off the prior attempt's `result` event — never the pi node-id convention.
// Live bug (run 260715-01, gameplay): the warm retry built `claude -p --resume gameplay` → fatal
// "--resume requires a valid session ID" → both feedback retries died at spawn with 0 tokens, so the
// gate critique never reached the model. Contract under test:
//   1. attempt-2's session opts carry resume:true + resumeRef = the captured UUID (claudeCommand turns
//      resumeRef into `--resume <uuid>`; that mapping is pinned in claude-command.test.ts).
//   2. with NO captured UUID (attempt 1 emitted no result event), attempt 2 DEGRADES COLD — a resume
//      that would be guaranteed-fatal is never requested.
//   3. the node record/journal carries the claude-minted UUID (the CLI `node --resume` finds it).

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, InMemorySandboxProvider } from '../src/index.js';
import type { NodeIntent, WorkflowSpec, NodeSpec, Sandbox, CreateOpts, SandboxProvider } from '../src/index.js';
import { runWorkflow } from '../src/runner/runner.js';
import { loadJournal } from '../src/runner/journal.js';
import type { PiCommandOptions } from '../src/types.js';

const UUID = '051c8666-f8c3-45e2-81ce-7f2edd03aa64';
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 'cwr', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cwr-'));

/** kind:'local' (warm-eligible) provider backed by in-memory sandboxes — mirrors warm-resume-l1.test.ts. */
function localKindProvider(): SandboxProvider {
  const base = new InMemorySandboxProvider();
  return { kind: 'local', create: (opts: CreateOpts): Promise<Sandbox> => base.create(opts) };
}

/** A producer with one artifact + an L1 feedback retry (the warm path). */
const producer = (): NodeIntent => ({
  label: 'Producer',
  prompt: 'produce the artifact',
  tools: {},
  io: { reads: [], produces: ['out.txt'], artifacts: [{ path: 'out.txt' }], retry: { max: 1 } },
  op: [{ when: 'on-failure', action: { kind: 'retry', max: 1, scope: 'feedback' } }],
});

/**
 * Builder stub: attempt 1 prints a claude `result` event (optionally with session_id) and writes NO
 * artifact (gate fails → warm L1 retry); attempt 2 writes the artifact + an ok result event. Captures the
 * runner-injected session opts per attempt — the seam claudeCommand consumes.
 */
function claudeStub(outDir: string, attempts: Array<PiCommandOptions['session']>, withSessionId: boolean) {
  return ((node: NodeSpec, _r: unknown, _c: unknown, opts?: PiCommandOptions): string => {
    const i = attempts.length;
    attempts.push(opts?.session);
    const evt = (extra: string) =>
      `{"type":"result","subtype":"success","is_error":false${extra},"usage":{"input_tokens":1,"output_tokens":1}}`;
    const sid = withSessionId ? `,"session_id":"${UUID}"` : '';
    if (i === 0) return `echo '${evt(sid)}'`; // no artifact → gate fails → L1 retry
    const dest = path.join(outDir, node.io.artifacts[0].path);
    return `mkdir -p ${path.dirname(dest)} && printf '%s' ok > ${dest} && echo '${evt(sid)}'`;
  }) as unknown as Parameters<typeof runWorkflow>[1]['buildCommand'];
}

describe('claude-code warm resume — the session ref is the claude-minted UUID, never the node id', () => {
  it('attempt 2 resumes with resumeRef = the captured UUID, and the journal records it', async () => {
    const g = compile(wf([producer()]));
    const outDir = await tmpOut();
    const attempts: Array<PiCommandOptions['session']> = [];
    const { status } = await runWorkflow(g, {
      run: 'cwr-1',
      outDir,
      provider: localKindProvider(),
      buildCommand: claudeStub(outDir, attempts, true),
      executorOverride: { producer: 'claude-code' },
      secretResolver: (name) => (name === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'test-oauth-token' : undefined),
    });

    expect(attempts).toHaveLength(2);
    // attempt 1: create — never a resume.
    expect(attempts[0]?.resume).toBeFalsy();
    // attempt 2: warm resume addressed by the UUID claude minted, NOT the pi node-id convention.
    expect(attempts[1]?.resume).toBe(true);
    expect(attempts[1]?.resumeRef).toBe(UUID);

    // The record + journal carry the claude UUID (the CLI `node --resume` contract).
    expect(status.nodes['producer'].sessionId).toBe(UUID);
    const j = await loadJournal(outDir);
    expect(j?.nodes['producer']?.sessionId).toBe(UUID);
  });

  it('with NO captured UUID the retry degrades COLD — never a guaranteed-fatal --resume', async () => {
    const g = compile(wf([producer()]));
    const outDir = await tmpOut();
    const attempts: Array<PiCommandOptions['session']> = [];
    await runWorkflow(g, {
      run: 'cwr-2',
      outDir,
      provider: localKindProvider(),
      buildCommand: claudeStub(outDir, attempts, false),
      executorOverride: { producer: 'claude-code' },
      secretResolver: (name) => (name === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'test-oauth-token' : undefined),
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.resume, 'no UUID captured ⇒ the retry must stay cold').toBeFalsy();
    expect(attempts[1]?.resumeRef).toBeUndefined();
  });
});
