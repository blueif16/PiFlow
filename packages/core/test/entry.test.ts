import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeIntent, WorkflowSpec, Sandbox, SandboxProvider, CreateOpts } from '../src/index.js';
import { InMemorySandboxProvider } from '../src/index.js';
import { runFromConfig, runFromTemplate } from '../src/runner/index.js';
import { nodeDir, runJsonFile } from '../src/runner/layout.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARG_TEMPLATE = path.join(HERE, 'fixtures', 'template-arg');

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

// ── S5: runFromTemplate — the TEMPLATE-run join (loadTemplate → instantiateRun → compile → runWorkflow) ──

describe('runFromTemplate — the template-run join (U8, §10)', () => {
  // A provider that records every staged write (so the test can capture the RESOLVED prompt on disk).
  function recorder(): { provider: SandboxProvider; writes: { path: string; data: string }[] } {
    const writes: { path: string; data: string }[] = [];
    const base = new InMemorySandboxProvider();
    const provider: SandboxProvider = {
      kind: 'inmemory',
      async create(opts: CreateOpts): Promise<Sandbox> {
        const sb = await base.create(opts);
        const orig = sb.writeFile.bind(sb);
        sb.writeFile = async (p: string, d: Uint8Array | string) => {
          writes.push({ path: p, data: typeof d === 'string' ? d : Buffer.from(d).toString('utf8') });
          return orig(p, d);
        };
        return sb;
      },
    };
    return { provider, writes };
  }

  // The offline stub: write each declared artifact (run-relative path) into the sandbox output, + a fence.
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

  it('materializes ${RUN}/.pi/nodes/<id>/ AND runs (stub exec) to a terminal run.json; {{arg.x}} resolves', async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-tpl-run-'));
    const { provider, writes } = recorder();

    const result = await runFromTemplate(ARG_TEMPLATE, {
      run: 'argrun',
      runDir,
      provider,
      buildCommand: stubBuilder(),
      args: { greeting: 'hello-from-arg' }, // ← the --arg k=v delivery the resolver makes physical
    });

    // (1) THE INSTANTIATE HALF: the run thread folder was materialized (.pi/nodes/<id>/ with node.json+prompt).
    const ndir = nodeDir(runDir, 'greet');
    expect(await fs.readFile(path.join(ndir, 'node.json'), 'utf8')).toContain('"id": "greet"');
    expect(await fs.stat(path.join(ndir, 'prompt.md'))).toBeTruthy();

    // (2) THE RUN HALF: it ran to a TERMINAL run.json (done:true, ok:true) — the spec-compile and folder-
    // materialize halves are joined into one end-to-end run.
    expect(result.status.done).toBe(true);
    expect(result.status.ok).toBe(true);
    expect(result.status.nodes.greet.status).toBe('ok');
    const onDisk = JSON.parse(await fs.readFile(runJsonFile(runDir), 'utf8'));
    expect(onDisk).toMatchObject({ run: 'argrun', done: true, ok: true });

    // (3) THE ARG CHANNEL: the staged prompt has {{arg.greeting}} RESOLVED to the supplied value (proving
    // args threaded RunOptions → resolver ctx → node launch). The recorder captured the on-disk prompt.
    const stagedPrompt = writes.find((w) => w.path.endsWith('prompt.md'))?.data ?? '';
    expect(stagedPrompt).toContain('hello-from-arg');
    expect(stagedPrompt).not.toContain('{{arg.greeting}}');

    await fs.rm(runDir, { recursive: true, force: true });
  });

  it('a MISSING {{arg.x}} fails the node loudly (MissingArgError), never a silent empty', async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-tpl-argmiss-'));
    const result = await runFromTemplate(ARG_TEMPLATE, {
      run: 'argmiss',
      runDir,
      buildCommand: stubBuilder(),
      // no `args` → {{arg.greeting}} has no value → the node errors on prompt resolution.
    });
    expect(result.status.nodes.greet.status).toBe('error');
    expect(result.status.nodes.greet.issues?.join(' ')).toMatch(/arg|greeting/i);
    await fs.rm(runDir, { recursive: true, force: true });
  });
});
