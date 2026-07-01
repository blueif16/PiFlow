import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemplate, compile, derivesFromOp, expandReroute, expandFusion, expandSubworkflow } from '@piflow/core';
import { scaffoldNew, scaffoldAddNode, runNewCli, runAddNodeCli } from '../src/scaffold.js';

// The scaffolder EMITS schema-valid meta.json + node.json from flags so an agent only Writes prose
// (prompt.md). The load-bearing gate is the ROUND-TRIP: emit a template, then run it through the REAL
// `loadTemplate` (the §8 compile gate — ajv schema + dep/cycle/producer checks). If the emitter drops a
// required field, mis-defaults the contract, or mis-wires a dep, `loadTemplate` THROWS and these go red.
// No mock of the loader — the whole point is that the emitted JSON is the one the engine actually accepts.

// Hermetic agents catalog: the in-repo preset seeds, copied into a temp PIFLOW_HOME so `--agent-type`
// resolves a preset (e.g. market-research) without the dev's real ~/.piflow/agents (absent in clean CI).
const AGENT_SEEDS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
  '.claude/skills/piflow-init/references/agent-presets',
);

let DIR: string;
let HOME_DIR: string;
let SAVED_HOME: string | undefined;
beforeEach(async () => {
  DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-scaffold-'));
  HOME_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-home-'));
  await fs.cp(AGENT_SEEDS, path.join(HOME_DIR, 'agents'), { recursive: true });
  SAVED_HOME = process.env.PIFLOW_HOME;
  process.env.PIFLOW_HOME = HOME_DIR;
});
afterEach(async () => {
  if (SAVED_HOME === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = SAVED_HOME;
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.rm(HOME_DIR, { recursive: true, force: true });
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

  // A4 — the flag is `--artifact-schema` (renamed from the ambiguous `--schema`, which read like the
  // structured-RETURN handshake). It maps to `contract.schema` = per-ARTIFACT output validation.
  it('the --artifact-schema flag emits contract.schema (per-artifact output validation)', async () => {
    await runNewCli([DIR, '--name', 'x', '--description', 'd']);
    await runAddNodeCli([DIR, '--id', 'validated', '--artifact', 'out.json', '--artifact-schema', 'schemas/out.json']);
    const node = await readJson(path.join(DIR, 'nodes', 'validated', 'node.json'));
    expect(node.contract.schema).toBe('schemas/out.json');
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

// (G6) `--agent-type <id>` binds a BASE AGENT preset (~/.piflow/agents/<id>.md) into the node via the REAL
// `mergePreset` (no re-implementation) — drift-free. It folds ONLY node.json-resident config: tools.allow
// (preset base UNION the explicit --tool), tools.deny (preset ∪ --deny, deny wins), prompt.skill (--skill
// wins, else the preset's first skill), and the agentType LABEL (which observe → the GUI key the icon off).
// It NEVER writes prompt.md (the role-prompt stays the author's). These tests use the REAL catalog under
// ~/.piflow/agents/ (the six base agents ship there) and the REAL loadTemplate, so a dropped fold reddens.
describe('scaffold — --agent-type binds a base agent preset (mergePreset, observable label)', () => {
  it('folds the preset tools + skill + agentType LABEL and round-trips through loadTemplate', async () => {
    await scaffoldNew(DIR, { name: 'mr', description: 'market-research lane' });
    // Only the id + the preset — no --tool/--skill: every tool + the skill come FROM the preset.
    await runAddNodeCli([DIR, '--id', 'research', '--artifact', 'brief.md', '--agent-type', 'market-research']);
    await writeProse('research');

    const node = await readJson(path.join(DIR, 'nodes', 'research', 'node.json'));
    // Item 1 — the preset's four tools + its skill + the branding label, all on node.json.
    expect(node.tools.allow).toEqual(
      expect.arrayContaining(['fs:read', 'fs:write', 'oc.firecrawl:firecrawl_search', 'oc.tavily:tavily_search']),
    );
    expect(node.prompt.skill).toBe('multi-source-research');
    expect(node.agentType).toBe('market-research');

    // Item 5 — the emitted node.json is engine-valid: the REAL loadTemplate accepts it AND carries the
    // agentType label onto the compiled intent (observe reads it from there). Throws on any §8 violation.
    const spec = await loadTemplate(DIR);
    const research = spec.nodes.find((n) => n.label === 'research')!;
    expect(research.agentType).toBe('market-research');
  });

  it('composes additively with an explicit --tool (union, no dupes) and --skill wins over the preset', async () => {
    await scaffoldNew(DIR, { name: 'mr', description: 'compose' });
    await runAddNodeCli([
      DIR,
      '--id', 'research',
      '--artifact', 'brief.md',
      '--agent-type', 'market-research',
      '--tool', 'mcp.apollo:search', // an ADDED tool on top of the preset's four
      '--tool', 'fs:read',           // a DUP of a preset tool — must not double
      '--skill', 'my-own-skill',     // explicit --skill WINS over the preset's multi-source-research
    ]);
    await writeProse('research');

    const node = await readJson(path.join(DIR, 'nodes', 'research', 'node.json'));
    // Item 2 — all four preset tools AND the added one; the dup collapses (set semantics in mergePreset).
    expect(node.tools.allow).toEqual(
      expect.arrayContaining([
        'fs:read', 'fs:write', 'oc.firecrawl:firecrawl_search', 'oc.tavily:tavily_search', 'mcp.apollo:search',
      ]),
    );
    expect(node.tools.allow.filter((t: string) => t === 'fs:read')).toHaveLength(1); // no dupe
    expect(node.prompt.skill).toBe('my-own-skill'); // node wins
    expect(node.agentType).toBe('market-research');
    await expect(loadTemplate(DIR)).resolves.toBeDefined();
  });

  it('an unknown preset id THROWS (non-zero) and writes NO node.json', async () => {
    await scaffoldNew(DIR, { name: 'x', description: 'd' });
    // Item 3 — the scaffolder never invents a preset; the unknown id is fail-closed.
    await expect(
      runAddNodeCli([DIR, '--id', 'research', '--artifact', 'brief.md', '--agent-type', 'does-not-exist']),
    ).rejects.toThrow(/unknown agent preset/);
    // No node.json written — the throw precedes the write (buildNode throws before scaffoldAddNode's fs.writeFile).
    await expect(fs.access(path.join(DIR, 'nodes', 'research', 'node.json'))).rejects.toThrow();
  });

  it('re-stamping a node that has a prompt.md with --agent-type leaves the prose UNTOUCHED', async () => {
    await scaffoldNew(DIR, { name: 'x', description: 'd' });
    await scaffoldAddNode(DIR, { id: 'research', artifacts: ['brief.md'] });
    // Item 4 — the author wrote the prose (role-prompt + task); re-stamping with the preset must not clobber it.
    const promptPath = path.join(DIR, 'nodes', 'research', 'prompt.md');
    await fs.writeFile(promptPath, 'ROLE PROMPT + my task');
    await runAddNodeCli([DIR, '--id', 'research', '--artifact', 'brief.md', '--agent-type', 'market-research']);

    const node = await readJson(path.join(DIR, 'nodes', 'research', 'node.json'));
    expect(node.agentType).toBe('market-research'); // config: re-stamped.
    expect(await fs.readFile(promptPath, 'utf8')).toBe('ROLE PROMPT + my task'); // prose: untouched.
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
});

// The check vocabulary the loader HONORS is richer than `{kind, path}`: a `check` carries `severity`
// (fail|warn) and a kind-specific `param` (dotted field, regex, or an object like {min,path}), in a `pre`
// OR `post` lane (node.schema.ts:$defs/check; collectChecks reads all four → io.checks). The lossy `--check`
// (kind:path only) forced agents to hand-edit node.json for the documented `field-present + param + severity`
// shape (templates/quality/verify). These prove the scaffolder now emits the FULL check shape and the real
// loadTemplate carries severity+param onto the runtime `io.checks` — the post-check engine actually enforces.
describe('scaffold — full check vocabulary (severity, param, pre/post lane) + policy.warn', () => {
  it('--check kind:path:severity:param emits the full post-check and loadTemplate carries it onto io.checks', async () => {
    await scaffoldNew(DIR, { name: 'c', description: 'rich check' });
    await runAddNodeCli([
      DIR,
      '--id', 'review',
      '--artifact', 'verify/review.json',
      '--check', 'json-parses:verify/review.json',
      '--check', 'field-present:verify/review.json:warn:verdict',
    ]);
    await writeProse('review');

    const node = await readJson(path.join(DIR, 'nodes', 'review', 'node.json'));
    // The lossy emitter dropped severity+param; the full emitter keeps them. RED until buildNode carries them.
    expect(node.checks.post).toEqual([
      { kind: 'json-parses', path: 'verify/review.json' },
      { kind: 'field-present', path: 'verify/review.json', severity: 'warn', param: 'verdict' },
    ]);

    // The load-bearing round-trip: the REAL loadTemplate accepts it AND collectChecks carries severity+param
    // onto the runtime io.checks (the post-check engine). Throws on any §8 violation.
    const spec = await loadTemplate(DIR);
    const review = spec.nodes.find((n) => n.label === 'review')!;
    expect(review.io.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'field-present', param: 'verdict', severity: 'warn' }),
      ]),
    );
  });

  it('an object param (count-floor {min,path}) is parsed from JSON, not left a string', async () => {
    await scaffoldNew(DIR, { name: 'c', description: 'object param' });
    await runAddNodeCli([
      DIR,
      '--id', 'gather',
      '--artifact', 'out/items.json',
      '--check', 'count-floor:out/items.json:fail:{"min":3,"path":"items"}',
    ]);
    const node = await readJson(path.join(DIR, 'nodes', 'gather', 'node.json'));
    // RED if the param stays a string — count-floor's predicate needs an object {min, path}.
    expect(node.checks.post[0].param).toEqual({ min: 3, path: 'items' });
  });

  it('--check-pre lands in the pre lane (over staged inputs) and loadTemplate accepts it', async () => {
    await scaffoldNew(DIR, { name: 'c', description: 'pre check' });
    await runAddNodeCli([
      DIR,
      '--id', 'build',
      '--artifact', 'out.md',
      '--inject', '{{RUN}}/spec.md',
      '--check-pre', 'non-empty:spec.md',
    ]);
    await writeProse('build');
    await fs.writeFile(path.join(DIR, 'spec.md'), 'a staged input\n'); // the injected read must exist on disk

    const node = await readJson(path.join(DIR, 'nodes', 'build', 'node.json'));
    expect(node.checks.pre).toEqual([{ kind: 'non-empty', path: 'spec.md' }]);
    expect(node.checks.post).toBeUndefined(); // the pre lane never bleeds into post
    await expect(loadTemplate(DIR)).resolves.toBeDefined();
  });

  it('--on-warn emits policy.warn alongside --on-fail (both verdict→action lanes)', async () => {
    await scaffoldNew(DIR, { name: 'c', description: 'policy warn' });
    await runAddNodeCli([
      DIR,
      '--id', 'n',
      '--artifact', 'a.md',
      '--check', 'non-empty:a.md',
      '--on-fail', 'block',
      '--on-warn', 'warn',
    ]);
    const node = await readJson(path.join(DIR, 'nodes', 'n', 'node.json'));
    expect(node.policy).toEqual({ fail: 'block', warn: 'warn' });
  });

  it('the terse --check kind:path form is unchanged (back-compat: no severity/param keys leak in)', async () => {
    await scaffoldNew(DIR, { name: 'c', description: 'terse' });
    await runAddNodeCli([DIR, '--id', 'n', '--artifact', 'a.md', '--check', 'non-empty:a.md']);
    const node = await readJson(path.join(DIR, 'nodes', 'n', 'node.json'));
    expect(node.checks.post).toEqual([{ kind: 'non-empty', path: 'a.md' }]);
  });
});

// JUDGE GATE + CHECKPOINT — the two agentic/human gates the loader materializes at LOAD. A `judgeGate`
// (node.schema.ts:264) becomes a real `<id>__judge` pi node via materializeJudgeNodes; the rubric is an
// INLINE string the CLI reads from the sibling `judge.md` (the SDK never sees that file — prose-in-md, like
// prompt.md). A `checkpoint` (node.schema.ts:214) is the G5 HITL block — and unlike a programmatic node it
// STILL needs a prompt block + an on-disk prompt.md (checkRefs). These round-trip through the REAL loader:
// a judge gate that mis-emits `kind` or collides the tier, or a checkpoint missing its prompt.md, THROWS.
describe('scaffold — judge gate (materialized) + checkpoint (G5 HITL)', () => {
  it('--judge tier[:threshold] inlines judge.md into judgeGate and loadTemplate MATERIALIZES the judge node', async () => {
    await scaffoldNew(DIR, { name: 'j', description: 'judge demo' });
    // The agent's job: Write the rubric prose to judge.md FIRST (the CLI inlines it, never authors it).
    await fs.mkdir(path.join(DIR, 'nodes', 'classify'), { recursive: true });
    await fs.writeFile(path.join(DIR, 'nodes', 'classify', 'judge.md'), 'The classification must be exhaustive and self-consistent.\n');
    await runAddNodeCli([
      DIR,
      '--id', 'classify',
      '--artifact', 'spec/classification.json',
      '--tier', 'fast', // producer tier — MUST differ from the judge tier (the no-self-judge invariant)
      '--judge', 'deep:7/10',
      '--judge-on-fail', 'block',
      '--judge-retry-max', '2',
    ]);
    await writeProse('classify');

    const node = await readJson(path.join(DIR, 'nodes', 'classify', 'node.json'));
    expect(node.judgeGate).toEqual({
      judgeTier: 'deep',
      rubric: 'The classification must be exhaustive and self-consistent.', // inlined from judge.md (trimmed)
      threshold: '7/10',
      policy: { onFail: 'block', retryMax: 2 },
    });
    expect(node.judgeGate.kind).toBeUndefined(); // `kind` is implied by the field name — never emitted

    // The load-bearing round-trip: the REAL loadTemplate MATERIALIZES the judge into a real node with
    // agentType:'judge' (materialize.ts). If buildNode mis-shaped judgeGate, loadTemplate throws here.
    const spec = await loadTemplate(DIR);
    expect(spec.nodes.some((n) => n.agentType === 'judge'), 'a judge node was materialized').toBe(true);
  });

  it('--judge with tier === judgeTier is rejected by the CLI (no self-judging) before any write', async () => {
    await scaffoldNew(DIR, { name: 'j', description: 'self-judge' });
    await fs.mkdir(path.join(DIR, 'nodes', 'n'), { recursive: true });
    await fs.writeFile(path.join(DIR, 'nodes', 'n', 'judge.md'), 'rubric\n');
    await expect(
      runAddNodeCli([DIR, '--id', 'n', '--artifact', 'a.md', '--tier', 'deep', '--judge', 'deep']),
    ).rejects.toThrow(/self-judg|same tier|differ/i);
    await expect(fs.access(path.join(DIR, 'nodes', 'n', 'node.json'))).rejects.toThrow(); // no node.json written
  });

  it('--judge with no sibling judge.md throws a clear CLI error (the rubric prose is the agent’s to write)', async () => {
    await scaffoldNew(DIR, { name: 'j', description: 'no rubric' });
    await expect(
      runAddNodeCli([DIR, '--id', 'n', '--artifact', 'a.md', '--tier', 'fast', '--judge', 'deep']),
    ).rejects.toThrow(/judge\.md/);
  });

  it('--checkpoint kind:prompt (+ choices/default/headless) emits the G5 block and loadTemplate accepts it', async () => {
    await scaffoldNew(DIR, { name: 'k', description: 'checkpoint' });
    await runAddNodeCli([
      DIR,
      '--id', 'gate-ship',
      '--checkpoint', 'select:Ship A or B?',
      '--checkpoint-choice', 'A',
      '--checkpoint-choice', 'B',
      '--checkpoint-default', 'A',
      '--checkpoint-headless', 'default',
      '--checkpoint-timeout', '0',
    ]);
    await writeProse('gate-ship'); // a checkpoint node is NOT programmatic — checkRefs demands prompt.md

    const node = await readJson(path.join(DIR, 'nodes', 'gate-ship', 'node.json'));
    expect(node.checkpoint).toEqual({
      kind: 'select',
      prompt: 'Ship A or B?',
      choices: ['A', 'B'],
      default: 'A',
      headless: 'default',
      timeoutMs: 0,
    });
    expect(node.prompt).toEqual({ file: 'prompt.md' }); // still a prompt block (not programmatic)
    await expect(loadTemplate(DIR)).resolves.toBeDefined();
  });
});

// EXECUTION GATE + CONTROL ACTIONS — the op[] beyond derives. An execution gate is a POST `op.run` whose
// non-zero exit BLOCKS the node (node-lifecycle); escalate/reroute are `op.action` bodies the loader lowers
// to the M4/M3 NodeIO primitives (via→io.escalate.tier, node→io.reroute.onFail; lower.ts lowerActions).
// All three ride the SAME `node.op[]` the scaffolder builds for derives — and once `op[]` exists, `inject`
// MUST fold into it (the legacy alias is dead once `def.op` is present, lower.ts). These assert the LOWERED
// runtime fields (not just the emitted JSON), so a wrong field name (e.g. `tier` instead of `via`) reddens.
describe('scaffold — execution gate + escalate/reroute control actions (op[])', () => {
  it('--gate-run emits a POST op.run gate (onFailure:block) and loadTemplate accepts it', async () => {
    await scaffoldNew(DIR, { name: 'g', description: 'exec gate' });
    await runAddNodeCli([DIR, '--id', 'verify', '--artifact', 'verify/report.json', '--gate-run', 'npm:test']);
    await writeProse('verify');

    const node = await readJson(path.join(DIR, 'nodes', 'verify', 'node.json'));
    expect(node.op).toEqual([{ when: 'post', run: { cmd: 'npm', args: ['test'] }, onFailure: 'block' }]);
    await expect(loadTemplate(DIR)).resolves.toBeDefined();
  });

  it('--escalate <tier> emits an on-failure escalate action that lowers to io.escalate.tier', async () => {
    await scaffoldNew(DIR, { name: 'e', description: 'escalate' });
    await runAddNodeCli([DIR, '--id', 'verify', '--artifact', 'r.json', '--escalate', 'deep']);
    await writeProse('verify');

    const node = await readJson(path.join(DIR, 'nodes', 'verify', 'node.json'));
    // Author `via` (NOT `tier`) — lowerActions reads `via` and IGNORES a `tier` key; this is the anti-drift trap.
    expect(node.op).toEqual([{ when: 'on-failure', action: { kind: 'escalate', via: 'deep' } }]);

    // The load-bearing round-trip: lowerActions flips via→tier onto io.escalate. RED if buildNode emitted `tier`.
    const spec = await loadTemplate(DIR);
    const verify = spec.nodes.find((n) => n.label === 'verify')!;
    expect(verify.io.escalate).toMatchObject({ tier: 'deep' });
  });

  it('--reroute <node[:max]> emits a bounded rerouteTo that lowers to io.reroute and survives expandReroute', async () => {
    await scaffoldNew(DIR, { name: 'r', description: 'reroute' });
    await scaffoldAddNode(DIR, { id: 'produce', artifacts: ['work/draft.md'], owns: ['work/**'] });
    await runAddNodeCli([DIR, '--id', 'verify', '--dep', 'produce', '--artifact', 'verify/report.json', '--reroute', 'produce:2']);
    await writeProse('produce');
    await writeProse('verify');

    const node = await readJson(path.join(DIR, 'nodes', 'verify', 'node.json'));
    expect(node.op).toEqual([{ when: 'on-failure', action: { kind: 'rerouteTo', node: 'produce', max: 2 } }]);

    // loadTemplate lowers node→onFail; expandReroute then validates `produce` is a strict ancestor (it is).
    // RED if buildNode mis-named the field or the target weren't a real upstream node.
    const spec = await loadTemplate(DIR);
    const verify = spec.nodes.find((n) => n.label === 'verify')!;
    // reroute lowers to the INTENT-level `reroute` (top-level, like checkpoint/fusion), NOT io.reroute —
    // expandReroute consumes it pre-compile (loader.ts:188; op-action-lower.test.ts:64). Escalate, by
    // contrast, lowers to io.escalate. Asserting the wrong surface is exactly the drift this cross-references.
    expect((verify as { reroute?: unknown }).reroute).toMatchObject({ onFail: 'produce', max: 2 });
    expect(() => expandReroute(spec)).not.toThrow(); // the ancestor constraint holds
  });

  it('a gate-only node (no derive hooks) still folds inject INTO op[] (the alias is dead once op[] exists)', async () => {
    await scaffoldNew(DIR, { name: 'g', description: 'gate + inject' });
    await runAddNodeCli([
      DIR,
      '--id', 'verify',
      '--artifact', 'verify/report.json',
      '--inject', '{{RUN}}/spec.md',
      '--gate-run', 'npm:test',
    ]);
    await writeProse('verify');
    await fs.writeFile(path.join(DIR, 'spec.md'), 'spec\n');

    const node = await readJson(path.join(DIR, 'nodes', 'verify', 'node.json'));
    // RED if buildNode only folds inject when DERIVE hooks are present (the old `if (derive.length)` gate):
    // a gate-only node would have left inject as a dead alias under an authored op[].
    expect(node.op).toEqual([
      { when: 'pre', reads: ['{{RUN}}/spec.md'] },
      { when: 'post', run: { cmd: 'npm', args: ['test'] }, onFailure: 'block' },
    ]);
    expect(node.inject).toBeUndefined();
    const spec = await loadTemplate(DIR);
    expect(spec.nodes.find((n) => n.label === 'verify')!.io.reads).toContain('spec.md');
  });
});

// TOPOLOGY (fusion, subworkflow) + CONTRACT EXTRAS (fullAccess, fillSentinel). loadTemplate does NOT expand
// fusion/subworkflow — those run in the run-path — so these tests carry the block through loadTemplate AND
// drive the real expander (expandFusion / expandSubworkflow) to prove the emitted shape actually expands.
// fusion/subworkflow are TOP-LEVEL node fields; fullAccess/fillSentinel live INSIDE contract — emitting either
// in the wrong place trips an additionalProperties:false boundary and loadTemplate THROWS.
describe('scaffold — fusion + subworkflow topology + contract extras (fullAccess, fillSentinel)', () => {
  it('--fusion best-of-n (+ -n) emits a top-level fusion block that loadTemplate carries and expandFusion expands', async () => {
    await scaffoldNew(DIR, { name: 'f', description: 'fusion' });
    await runAddNodeCli([DIR, '--id', 'synth', '--artifact', 'out/synth.md', '--fusion', 'best-of-n', '--fusion-n', '5']);
    await writeProse('synth');

    const node = await readJson(path.join(DIR, 'nodes', 'synth', 'node.json'));
    expect(node.fusion).toEqual({ mode: 'best-of-n', n: 5 });

    const spec = await loadTemplate(DIR);
    expect(spec.nodes.find((n) => n.label === 'synth')!.fusion).toEqual({ mode: 'best-of-n', n: 5 });
    // best-of-n expands into n sibling producers + the node as judge — proves the emitted shape is buildable.
    const expanded = expandFusion(spec);
    expect(expanded.nodes.length).toBeGreaterThan(spec.nodes.length);
  });

  it('--fusion moa (+ --fusion-panel/--fusion-judge) emits the panel and loadTemplate accepts it', async () => {
    await scaffoldNew(DIR, { name: 'f', description: 'moa' });
    await runAddNodeCli([
      DIR, '--id', 'synth', '--artifact', 'out/synth.md',
      '--fusion', 'moa', '--fusion-panel', 'fast', '--fusion-panel', 'deep', '--fusion-judge', 'deep', '--fusion-obligations',
    ]);
    await writeProse('synth');

    const node = await readJson(path.join(DIR, 'nodes', 'synth', 'node.json'));
    expect(node.fusion).toEqual({ mode: 'moa', panel: ['fast', 'deep'], judge: 'deep', obligations: true });
    const spec = await loadTemplate(DIR);
    expect(expandFusion(spec).nodes.length).toBeGreaterThan(spec.nodes.length); // moa: panel siblings + judge
  });

  it('--subworkflow <ref> emits the block and the ref RESOLVES through expandSubworkflow (real child template)', async () => {
    await scaffoldNew(DIR, { name: 's', description: 'subworkflow' });
    // The child sub-template the ref points at (parent-root-relative). A real, loadable 1-node template.
    const subNode = path.join(DIR, 'sub', 'nodes', 'work');
    await fs.mkdir(subNode, { recursive: true });
    await fs.writeFile(path.join(DIR, 'sub', 'meta.json'), JSON.stringify({ id: 'sub', name: 'sub', description: 'd' }));
    await fs.writeFile(path.join(subNode, 'node.json'), JSON.stringify({
      id: 'work', phase: 'work', deps: [], prompt: { file: 'prompt.md' },
      contract: { artifacts: ['out/done.md'], owns: ['out/**'], readScope: ['{{RUN}}'] },
    }));
    await fs.writeFile(path.join(subNode, 'prompt.md'), 'do work\n');

    await runAddNodeCli([DIR, '--id', 'gate', '--artifact', 'out/gate.md', '--subworkflow', 'sub']);
    await writeProse('gate');

    const node = await readJson(path.join(DIR, 'nodes', 'gate', 'node.json'));
    expect(node.subworkflow).toEqual({ ref: 'sub' });

    const spec = await loadTemplate(DIR);
    expect(spec.nodes.find((n) => n.label === 'gate')!.subworkflow).toEqual({ ref: 'sub' });
    // The ref must resolve to the real child — RED if buildNode emitted a wrong ref or shape.
    const inlined = await expandSubworkflow(spec, { loadChild: (ref: string) => loadTemplate(path.resolve(DIR, ref)) });
    expect(inlined.nodes.some((n) => n.label.includes('work'))).toBe(true);
  });

  it('--full-access + --fill-sentinel emit INSIDE contract; loadTemplate threads fullAccess onto the sandbox', async () => {
    await scaffoldNew(DIR, { name: 'c', description: 'contract extras' });
    await runAddNodeCli([DIR, '--id', 'n', '--artifact', 'a.md', '--full-access', '--fill-sentinel', '<FILL:']);
    await writeProse('n');

    const node = await readJson(path.join(DIR, 'nodes', 'n', 'node.json'));
    expect(node.contract.fullAccess).toBe(true); // boolean, not the string "true" (schema rejects a string)
    expect(node.contract.fillSentinel).toBe('<FILL:');
    expect(node.fullAccess, 'belongs INSIDE contract, never top-level').toBeUndefined();

    const wf = compile(await loadTemplate(DIR));
    expect(wf.nodes['n'].sandbox.fullAccess).toBe(true); // threaded onto the per-node jail-off posture
  });

  it('--fusion with an invalid mode is rejected by the CLI before any write', async () => {
    await scaffoldNew(DIR, { name: 'f', description: 'bad mode' });
    await expect(
      runAddNodeCli([DIR, '--id', 'n', '--artifact', 'a.md', '--fusion', 'ensemble']),
    ).rejects.toThrow(/moa|best-of-n|mode/i);
    await expect(fs.access(path.join(DIR, 'nodes', 'n', 'node.json'))).rejects.toThrow();
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
