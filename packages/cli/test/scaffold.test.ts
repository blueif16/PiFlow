import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTemplate, compile } from '@piflow/core';
import { scaffoldNew, scaffoldAddNode, runNewCli, runAddNodeCli } from '../src/scaffold.js';

// The scaffolder EMITS schema-valid meta.json + node.json from flags so an agent only Writes prose
// (prompt.md). The load-bearing gate is the ROUND-TRIP: emit a template, then run it through the REAL
// `loadTemplate` (the §8 compile gate — ajv schema + dep/cycle/producer checks). If the emitter drops a
// required field, mis-defaults the contract, or mis-wires a dep, `loadTemplate` THROWS and these go red.
// No mock of the loader — the whole point is that the emitted JSON is the one the engine actually accepts.

let DIR: string;
beforeEach(async () => {
  DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-scaffold-'));
});
afterEach(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

const readJson = async (p: string): Promise<any> => JSON.parse(await fs.readFile(p, 'utf8'));

// Stand in for the AGENT's half of authoring: the scaffolder emits config only; `loadTemplate`'s
// `checkRefs` requires each node's prompt.md to EXIST on disk (a missing prose body is a dangling ref),
// so the real flow is scaffold-config → Write-prose → load. We simulate the Write here.
const writeProse = (id: string): Promise<void> =>
  fs.writeFile(path.join(DIR, 'nodes', id, 'prompt.md'), `prose for ${id}\n`);

describe('scaffold — emit a template the real loadTemplate accepts', () => {
  it('emits a 2-node template that loadTemplate compiles into the authored DAG', async () => {
    await scaffoldNew(DIR, { name: 'acad', description: 'a 2-node demo' });
    await scaffoldAddNode(DIR, {
      id: 'research',
      artifacts: ['findings/findings.md'],
      tools: ['read', 'write', 'submit_result', 'mcp.deepwiki:ask_question'],
      deny: ['bash', 'edit'],
      mcp: { deepwiki: { transport: 'http', url: 'https://mcp.deepwiki.com/mcp' } },
    });
    await scaffoldAddNode(DIR, {
      id: 'build',
      deps: ['research'],
      artifacts: ['src/binary-search.mjs'],
      tools: ['read', 'write', 'edit', 'bash', 'submit_result'],
      inject: ['{{RUN}}/findings/findings.md'],
    });
    await writeProse('research');
    await writeProse('build');

    // The REAL compile gate — throws TemplateError on any §8 violation. If it resolves, the emitted
    // JSON is engine-valid.
    const spec = await loadTemplate(DIR);
    expect(spec.nodes.map((n) => n.label).sort()).toEqual(['build', 'research']);

    const build = spec.nodes.find((n) => n.label === 'build')!;
    expect(build.io.dependsOn).toContain('research');

    const wf = compile(spec);
    expect(Object.keys(wf.nodes)).toHaveLength(2);
    // research (root) then build — two topological levels.
    expect(wf.stages).toHaveLength(2);
  });

  it('defaults owns + readScope so a node is schema-valid from id + artifacts alone', async () => {
    await scaffoldNew(DIR, { name: 'solo', description: 'one node' });
    // No --owns, no --read: the contract REQUIRES owns + readScope (node.schema.ts:129), so if the
    // builder fails to default them, loadTemplate throws here and the test goes red.
    await scaffoldAddNode(DIR, { id: 'only', artifacts: ['out.md'] });
    await writeProse('only');

    await expect(loadTemplate(DIR)).resolves.toBeDefined();

    const node = await readJson(path.join(DIR, 'nodes', 'only', 'node.json'));
    expect(node.contract.owns).toEqual(['out/**']);
    expect(node.contract.readScope).toEqual(['{{RUN}}']);
  });

  it('the CLI arg-parse layer emits the same fields as the builder', async () => {
    await runNewCli([DIR, '--name', 'x', '--description', 'd']);
    await runAddNodeCli([
      DIR,
      '--id', 'research',
      '--artifact', 'f.md',
      '--tool', 'read',
      '--tool', 'submit_result',
      '--mcp', 'deepwiki=https://mcp.deepwiki.com/mcp',
    ]);

    const node = await readJson(path.join(DIR, 'nodes', 'research', 'node.json'));
    expect(node.id).toBe('research');
    expect(node.deps).toEqual([]);
    expect(node.contract.artifacts).toEqual(['f.md']);
    expect(node.tools.allow).toEqual(['read', 'submit_result']);
    expect(node.mcp.servers.deepwiki).toEqual({ transport: 'http', url: 'https://mcp.deepwiki.com/mcp' });
  });

  it('re-emitting a node overwrites node.json but never touches an existing prompt.md', async () => {
    await scaffoldNew(DIR, { name: 'x', description: 'd' });
    await scaffoldAddNode(DIR, { id: 'n', artifacts: ['a.md'] });
    // The agent owns the prose — write it, then re-emit the node config with new flags.
    const promptPath = path.join(DIR, 'nodes', 'n', 'prompt.md');
    await fs.writeFile(promptPath, 'MY PROSE');
    await scaffoldAddNode(DIR, { id: 'n', artifacts: ['b.md'] });

    const node = await readJson(path.join(DIR, 'nodes', 'n', 'node.json'));
    expect(node.contract.artifacts).toEqual(['b.md']); // CLI-owned config: overwritten.
    expect(await fs.readFile(promptPath, 'utf8')).toBe('MY PROSE'); // agent-owned prose: untouched.
  });
});
