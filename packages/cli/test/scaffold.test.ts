import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTemplate, compile, derivesFromOp } from '@piflow/core';
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

  // The --executor flag → buildNode → node.json carry. Scaffold OWNS the emitted SHAPE; the
  // schema-accepts + loader-carries + compile-passes round-trip is owned (and mutation-checked) by core's
  // load-template.test.ts ('carries the authored `executor` selector onto the compiled NodeSpec'), which
  // imports the worktree src directly — the reliable home for a cross-package core feature.
  it('the --executor flag emits a schema-valid executor onto node.json', async () => {
    await runNewCli([DIR, '--name', 'x', '--description', 'd']);
    await runAddNodeCli([DIR, '--id', 'fixer', '--artifact', 'f.md', '--executor', 'claude-code']);

    const node = await readJson(path.join(DIR, 'nodes', 'fixer', 'node.json'));
    expect(node.executor).toBe('claude-code');
  });

  it('a node with no --executor flag omits the key (additive ⇒ pi default, byte-identical to today)', async () => {
    await runNewCli([DIR, '--name', 'x', '--description', 'd']);
    await runAddNodeCli([DIR, '--id', 'plain', '--artifact', 'f.md']);
    const node = await readJson(path.join(DIR, 'nodes', 'plain', 'node.json'));
    expect(node.executor).toBeUndefined();
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

// The scaffolder emits the CANONICAL `op[]` envelope for the derive hooks (seed/project/merge/promote/
// registryProject) — NOT the deprecated `hooks` alias — because authoring `op[]` short-circuits the loader's
// alias-lowering (lower.ts:48 — `if (def.op) return def.op`). `op[]` is the SOLE derive rep (the legacy
// `node.ops` + its back-fill were retired in U6); the runner reads each derive family off `op[]` via
// `derivesFromOp`, so we assert the round-tripped op[] reconstructs the SAME five executor inputs. The
// load-bearing RED guard is the channel round-trip: a promote emitted as op[] resolves a downstream
// `{{state.X}}`; if buildNode DROPS the hook flags, the channel dangles and `loadTemplate`'s `checkChannels` THROWS.
describe('scaffold — hook flags emit a canonical op[] the real loadTemplate compiles', () => {
  it('ALL FIVE derive families emit op[]; inject FOLDS into op[]; derivesFromOp reconstructs them; a consumer resolves', async () => {
    await scaffoldNew(DIR, { name: 'h', description: 'hooks demo' });
    // a producing node carrying every flag-emittable derive + an inject (which must fold INTO op[]).
    await scaffoldAddNode(DIR, {
      id: 'setup',
      artifacts: ['out/pipeline.json'],
      returnMode: 'required',
      inject: ['{{RUN}}/in.json'],
      seed: [{ to: 'spec/seed.json', from: '{{WORKSPACE}}/skel.json' }],
      project: [{ to: 'out/projected.json', from: 'in/raw.json' }],
      mergeRun: [{ cmd: 'node', args: ['gen.mjs'] }],
      promote: [{ from: '@return:camelId', to: 'camelId' }],
      registryProject: { source: 'out/pipeline.json', mapRef: '{{WORKSPACE}}/index.json', key: 'setup' },
    });
    // a consumer whose PROSE reads {{state.camelId}} — if setup never promotes it, checkChannels dangles.
    await scaffoldAddNode(DIR, { id: 'use', deps: ['setup'], artifacts: ['out/result.md'] });
    await writeProse('setup');
    await fs.writeFile(path.join(DIR, 'nodes', 'use', 'prompt.md'), 'build from {{state.camelId}}\n');

    // RED guard: throws `dangling channel` if the promote flag was dropped (no op[] emitted).
    const spec = await loadTemplate(DIR);
    const setup = compile(spec).nodes['setup'];

    // The runner reads each derive family off the canonical `op[]` via `derivesFromOp` (op[] is the SOLE
    // derive rep — node.ops retired in U6). The reconstructed executor inputs must match all five flags.
    const d = derivesFromOp(setup.op);
    expect(d.seeds).toEqual([{ to: 'spec/seed.json', from: '{{WORKSPACE}}/skel.json' }]);
    expect(d.projects).toEqual([{ to: 'out/projected.json', from: 'in/raw.json' }]);
    expect(d.merges).toEqual([{ ops: [{ run: { cmd: 'node', args: ['gen.mjs'] } }] }]);
    expect(d.promotes).toEqual([{ from: '@return:camelId', to: 'camelId' }]);
    expect(d.registryProjects).toEqual([{ source: 'out/pipeline.json', mapRef: '{{WORKSPACE}}/index.json', key: 'setup' }]);

    // The emitted node.json carries `op` (canonical) — NOT the legacy `hooks`/`inject` keys.
    const nodeJson = await readJson(path.join(DIR, 'nodes', 'setup', 'node.json'));
    expect(nodeJson.op, 'derive hooks emit the canonical op[]').toBeDefined();
    expect(nodeJson.hooks, 'never the deprecated hooks alias').toBeUndefined();
    expect(nodeJson.inject, 'inject folds INTO op[] when derive hooks are present').toBeUndefined();
    // inject became a pre read-op folded into op[] — so io.reads carries it (runRel-stripped).
    expect(setup.io.reads).toContain('in.json');
    // the op[] entries are well-formed (each exactly one body) in the canonical order pre→post.
    const kinds = (nodeJson.op as any[]).map((o) => o.transform?.kind ?? (o.run ? 'run' : o.reads ? 'read' : '?'));
    expect(kinds).toEqual(['read', 'seed', 'project', 'projectRegistry', 'merge', 'promote']);
  });

  it('an inject-only node (no derive hooks) still emits the legacy inject key (op[] only when hooks present)', async () => {
    await scaffoldNew(DIR, { name: 'i', description: 'inject only' });
    await scaffoldAddNode(DIR, { id: 'n', artifacts: ['a.md'], inject: ['{{RUN}}/x.md'] });
    const node = await readJson(path.join(DIR, 'nodes', 'n', 'node.json'));
    expect(node.inject).toEqual(['{{RUN}}/x.md']); // unchanged: no hooks ⇒ no op[], inject stays the alias.
    expect(node.op).toBeUndefined();
  });

  // The CLI STRING layer (`runAddNodeCli`) parses each derive flag's value-grammar (design §3) into the same
  // op[] the builder emits. This exercises what the builder test (which passes structured objects) cannot: the
  // PARSERS — the `--promote …:reducer` suffix, the `--project …,…` comma-array, and `--merge-run`'s
  // first-colon cmd split / colon-preserving args / trailing `@cwd`. It reddens if any parser mis-splits.
  it('the CLI flag layer parses all five derive grammars into the canonical op[]', async () => {
    await runNewCli([DIR, '--name', 'h', '--description', 'd']);
    await runAddNodeCli([
      DIR,
      '--id', 'setup',
      '--artifact', 'out/pipeline.json',
      '--return-mode', 'required',
      '--inject', '{{RUN}}/in.json',
      '--seed', 'spec/seed.json={{WORKSPACE}}/skel.json',
      '--project', 'public/manifest.json=spec/classification.json,public/assets',
      '--merge-run', 'node:gen.mjs,--out:dist@build',
      '--promote', '@return:archetype=archetype:set',
      '--registry-project', 'source=out/pipeline.json,mapRef={{WORKSPACE}}/index.json,key=setup',
    ]);
    await fs.writeFile(path.join(DIR, 'nodes', 'setup', 'prompt.md'), 'emit the pipeline\n');

    const spec = await loadTemplate(DIR);
    const setup = compile(spec).nodes['setup'];
    const d = derivesFromOp(setup.op);

    expect(d.seeds).toEqual([{ to: 'spec/seed.json', from: '{{WORKSPACE}}/skel.json' }]);
    // --project comma-list → `from` is an ARRAY (the derivedHook string|array form); a single from stays a string.
    expect(d.projects).toEqual([{ to: 'public/manifest.json', from: ['spec/classification.json', 'public/assets'] }]);
    // --merge-run: cmd is the token before the FIRST `:` (so the `--out:dist` arg keeps its colon); a trailing
    // `@cwd` is split off; args are comma-listed.
    expect(d.merges).toEqual([{ ops: [{ run: { cmd: 'node', args: ['gen.mjs', '--out:dist'], cwd: 'build' } }] }]);
    // --promote from=to:reducer — the `:set` suffix is the reducer (NAME-FLIP reducer→merge in derivesFromOp).
    expect(d.promotes).toEqual([{ from: '@return:archetype', to: 'archetype', merge: 'set' }]);
    expect(d.registryProjects).toEqual([{ source: 'out/pipeline.json', mapRef: '{{WORKSPACE}}/index.json', key: 'setup' }]);
    // inject folded into op[] as a PRE read → io.reads carries it (runRel-stripped).
    expect(setup.io.reads).toContain('in.json');
  });
});
