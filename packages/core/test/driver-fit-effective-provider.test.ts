// driver-fit preflight must judge the EFFECTIVE run-level backend, not the authored per-node provider.
// The chosen sandbox backend is RUN-level (status.sandbox / ctx.providerKind); a node's `sandbox.provider`
// field is the materialize DEFAULT ('inmemory') unless authored. Judging fit on the authored field produced
// a live false positive: `--sandbox local --executor claude-code` warned "cannot run on sandbox provider
// inmemory" three times per node (run 260715-01 gameplay) while the command ran fine on the local backend.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, InMemorySandboxProvider } from '../src/index.js';
import type { NodeIntent, WorkflowSpec, NodeSpec, Sandbox, CreateOpts, SandboxProvider } from '../src/index.js';
import { runWorkflow } from '../src/runner/runner.js';

const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 'fit', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-fit-'));

function localKindProvider(): SandboxProvider {
  const base = new InMemorySandboxProvider();
  return { kind: 'local', create: (opts: CreateOpts): Promise<Sandbox> => base.create(opts) };
}

const producer = (): NodeIntent => ({
  label: 'Producer',
  prompt: 'produce',
  tools: {},
  io: { reads: [], produces: ['out.txt'], artifacts: [{ path: 'out.txt' }] },
});

/** Stub: write the artifact + a claude ok result event so the lifecycle completes clean. */
function okClaudeStub(outDir: string) {
  return ((node: NodeSpec): string => {
    const dest = path.join(outDir, node.io.artifacts[0].path);
    return `mkdir -p ${path.dirname(dest)} && printf '%s' ok > ${dest} && echo '{"type":"result","subtype":"success","is_error":false}'`;
  }) as unknown as Parameters<typeof runWorkflow>[1]['buildCommand'];
}

afterEach(() => vi.restoreAllMocks());

describe('driver-fit judges the effective run-level backend', () => {
  it('claude-code on a LOCAL-kind run does NOT warn, even though the node authored the inmemory default', async () => {
    const g = compile(wf([producer()]));
    expect(g.nodes.producer.sandbox.provider).toBe('inmemory'); // the materialize default — the false-positive input
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outDir = await tmpOut();
    await runWorkflow(g, {
      run: 'fit-local',
      outDir,
      provider: localKindProvider(),
      buildCommand: okClaudeStub(outDir),
      executorOverride: { producer: 'claude-code' },
      secretResolver: (name) => (name === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'test-oauth-token' : undefined),
    });
    const fitWarns = warn.mock.calls.filter((c) => String(c[0]).includes('[driver-fit]'));
    expect(fitWarns, `unexpected driver-fit warns: ${fitWarns.map((c) => c[0]).join(' | ')}`).toEqual([]);
  });

  it('claude-code on a genuinely INMEMORY run still warns (the real misfit is not masked)', async () => {
    const g = compile(wf([producer()]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outDir = await tmpOut();
    await runWorkflow(g, {
      run: 'fit-inmem',
      outDir,
      // default provider: InMemory (kind 'inmemory') — claude-code genuinely cannot run there.
      buildCommand: okClaudeStub(outDir),
      executorOverride: { producer: 'claude-code' },
      secretResolver: (name) => (name === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'test-oauth-token' : undefined),
    });
    const fitWarns = warn.mock.calls.filter((c) => String(c[0]).includes('[driver-fit]'));
    expect(fitWarns.length).toBeGreaterThan(0);
    expect(String(fitWarns[0][0])).toContain('inmemory');
  });
});
