import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { runFromConfig } from '../src/runner/index.js';

// A node factory (mirrors runner.test).
function n(label: string, reads: string[], produces: string[]): NodeIntent {
  return { label, prompt: `do ${label}`, tools: {}, io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) } };
}
const spec = (): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes: [n('Solo', [], ['s.txt'])] });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-entry-'));

// The offline stub builder (writes each declared artifact + a return fence) — reused from runner.test's shape.
function stubBuilder() {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => {
        const dest = `${node.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${node.id} done"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

describe('runFromConfig — the env-AGNOSTIC run entry (U8, D5)', () => {
  it('takes a resolved-config OBJECT with a workflowSpec, compiles + runs it, produces its artifacts', async () => {
    const outDir = await tmpOut();
    const result = await runFromConfig({
      workflowSpec: spec(),
      run: 'cfg',
      outDir,
      buildCommand: stubBuilder(),
    });
    expect(result.status.ok).toBe(true);
    expect(result.status.nodes.solo.status).toBe('ok');
    expect(await fs.readFile(path.join(outDir, 's.txt'), 'utf8')).toBe('solo');
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('accepts buildWorkflowSpec (a consumer-injected async factory) instead of a literal spec', async () => {
    const outDir = await tmpOut();
    let built = false;
    const result = await runFromConfig({
      buildWorkflowSpec: async () => {
        built = true;
        return spec();
      },
      run: 'cfg-build',
      outDir,
      buildCommand: stubBuilder(),
    });
    expect(built).toBe(true); // the injected factory was invoked
    expect(result.status.ok).toBe(true);
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('forwards run opts (returnProtocol) through to the run path', async () => {
    // returnProtocol:'required' on an artifact-backed node whose builder emits a fence ⇒ still ok, but the
    // node's effective returnMode proves the option threaded through.
    const outDir = await tmpOut();
    const result = await runFromConfig({
      workflowSpec: spec(),
      run: 'cfg-rp',
      outDir,
      buildCommand: stubBuilder(),
      returnProtocol: 'required',
    });
    expect(result.status.nodes.solo.returnMode).toBe('required');
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('FAILS LOUDLY when NEITHER workflowSpec nor buildWorkflowSpec is provided (no silent no-op)', async () => {
    await expect(runFromConfig({ run: 'cfg-empty' } as never)).rejects.toThrow(/workflowSpec|buildWorkflowSpec/i);
  });
});
