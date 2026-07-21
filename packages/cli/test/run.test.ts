import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRunArgs,
  dryRunPlan,
  runTemplate,
  runFailureReport,
  resolveRunSandbox,
  type RunDeps,
} from '../src/run.js';
import {
  loadTemplate,
  compile,
  instantiateRun,
  piDir,
  nodeDir,
  nodePromptFile,
  LocalSandboxProvider,
  writeStatus,
  readRunJson,
  type RunFromTemplateOpts,
  type RunStatus,
} from '@piflow/core';

// loadTemplate (re)writes the template's generated workflow.json lock, so we run over a CLONE in a tmp
// dir (the load-template.test convention) — the source fixture stays pristine.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../core/test/fixtures/template-min');

let TEMPLATE_MIN: string;
beforeAll(async () => {
  TEMPLATE_MIN = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-run-tpl-'));
  await fs.cp(FIXTURE, TEMPLATE_MIN, { recursive: true });
});
afterAll(async () => {
  await fs.rm(TEMPLATE_MIN, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// (A0) THE MERGE — resolveRunSandbox: a context's `worker` IS the sandbox, `--sandbox` is the legacy override.
// Precedence flag > context-worker > inmemory-default. Pure — no fs. Mutation targets: the override branch, the
// cloud cascade, and the back-compat inmemory fallback for a plain local context.
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveRunSandbox — context worker ⇄ --sandbox (flag > context > default)', () => {
  const NONE = new Set<never>(); // no cloud-worker creds configured
  const railway = { baseUrl: 'https://x.up.railway.app', host: 'railway' as const };

  it('an explicit --sandbox is the LEGACY override — wins over the context worker (even inmemory)', () => {
    expect(resolveRunSandbox({ sandbox: 'local', sandboxExplicit: true }, railway, NONE)).toBe('local');
    expect(resolveRunSandbox({ sandbox: 'inmemory', sandboxExplicit: true }, railway, NONE)).toBe('inmemory');
  });
  it('no active context → the historical inmemory default', () => {
    expect(resolveRunSandbox({ sandbox: 'inmemory' }, undefined, NONE)).toBe('inmemory');
  });
  it('an explicit context worker drives the sandbox when no --sandbox is passed', () => {
    expect(resolveRunSandbox({ sandbox: 'inmemory' }, { baseUrl: 'http://127.0.0.1:5273', worker: 'daytona' }, NONE)).toBe('daytona');
  });
  it('a CLOUD context with no explicit worker cascades to its worker (e2b)', () => {
    expect(resolveRunSandbox({ sandbox: 'inmemory' }, railway, NONE)).toBe('e2b');
  });
  it('a plain local context (no worker) KEEPS inmemory — back-compat (the in-process default)', () => {
    expect(resolveRunSandbox({ sandbox: 'inmemory' }, { baseUrl: 'http://127.0.0.1:5273' }, NONE)).toBe('inmemory');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (A) ARG PARSING — the flat argv → { templateDir, dryRun, args (--arg k=v), run, workspace }.
// ─────────────────────────────────────────────────────────────────────────────
describe('parseRunArgs — the run subcommand flag surface', () => {
  it('takes the template dir positionally and collects repeated --arg k=v into args', () => {
    const p = parseRunArgs([TEMPLATE_MIN, '--arg', 'prompt=make a game', '--arg', 'projectDir=out/g1']);
    expect(p.templateDir).toBe(TEMPLATE_MIN);
    expect(p.args.prompt).toBe('make a game');
    expect(p.args.projectDir).toBe('out/g1');
  });

  it('reads --dry-run and --run <id>', () => {
    const p = parseRunArgs([TEMPLATE_MIN, '--dry-run', '--run', 'g1']);
    expect(p.dryRun).toBe(true);
    expect(p.run).toBe('g1');
  });

  it('a value with an = sign survives (only the FIRST = splits k from v)', () => {
    const p = parseRunArgs([TEMPLATE_MIN, '--arg', 'eq=a=b=c']);
    expect(p.args.eq).toBe('a=b=c');
  });

  it('reads --profile <name>', () => {
    const p = parseRunArgs([TEMPLATE_MIN, '--run', 'g1', '--profile', 'companion']);
    expect(p.profile).toBe('companion');
  });

  it('reads the real-run flags: --sandbox, --provider, --thinking, --model, --workspace, --from/--until', () => {
    const p = parseRunArgs([
      TEMPLATE_MIN,
      '--run', 'g1',
      '--workspace', '/w',
      '--sandbox', 'local',
      '--provider', 'mmgw',
      '--thinking', 'low',
      '--model', 'MiniMax-M3',
      '--from', 's2',
      '--until', 's5',
      '--arg', 'prompt=hi',
      '--arg', 'projectDir=out/g1',
    ]);
    expect(p.workspace).toBe('/w');
    expect(p.sandbox).toBe('local');
    expect(p.provider).toBe('mmgw');
    expect(p.thinking).toBe('low');
    expect(p.model).toBe('MiniMax-M3');
    expect(p.from).toBe('s2');
    expect(p.until).toBe('s5');
    // multiple --arg still collect together (the real-run flags don't disturb arg collection).
    expect(p.args.prompt).toBe('hi');
    expect(p.args.projectDir).toBe('out/g1');
  });

  it('defaults --sandbox to inmemory when the flag is absent', () => {
    const p = parseRunArgs([TEMPLATE_MIN, '--run', 'g1']);
    expect(p.sandbox).toBe('inmemory');
  });

  it('parses --max-concurrent into a number (the G2 concurrency cap)', () => {
    const p = parseRunArgs([TEMPLATE_MIN, '--run', 'g1', '--max-concurrent', '4']);
    expect(p.maxConcurrent).toBe(4);
  });

  it('leaves maxConcurrent undefined when --max-concurrent is absent (runner applies its default)', () => {
    const p = parseRunArgs([TEMPLATE_MIN, '--run', 'g1']);
    expect(p.maxConcurrent).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) DRY-RUN — builds + prints the per-node pi command WITHOUT invoking a model, and materializes
// the ${RUN}/.pi structure via instantiateRun.
// ─────────────────────────────────────────────────────────────────────────────
describe('piflowctl run --dry-run — realized commands, no model', () => {
  let dryWorkspace: string;
  let dryOut: string;
  beforeAll(async () => {
    dryWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-ws-'));
    dryOut = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-dry-'));
  });
  afterAll(async () => {
    await fs.rm(dryWorkspace, { recursive: true, force: true });
    await fs.rm(dryOut, { recursive: true, force: true });
  });

  it('dryRunPlan renders one realized `pi` command per node (the headless invocation)', async () => {
    const wf = compile(await loadTemplate(TEMPLATE_MIN));
    const plan = dryRunPlan(wf, { promptDir: '/run/_pi' });
    for (const id of ['w0-classify', 'w2a-levels', 'w2b-assets']) expect(plan).toContain(id);
    // each node line carries the headless pi invocation (the command builder's output), no model spawned
    expect(plan).toMatch(/\bpi\b/);
    expect(plan).toContain('--mode json');
    expect(plan).toContain('@'); // the prompt is referenced as @<file>
  });

  it('renders the per-node effective model (G1) — a node override vs the run default', async () => {
    const wf = compile({
      meta: { name: 't', description: 'd' },
      nodes: [
        { label: 'Router', prompt: 'x', tools: {}, model: 'm-node', io: { reads: [], produces: ['r.txt'], artifacts: [{ path: 'r.txt' }] } },
        { label: 'Plain', prompt: 'y', tools: {}, io: { reads: [], produces: ['p.txt'], artifacts: [{ path: 'p.txt' }] } },
      ],
    });
    const plan = dryRunPlan(wf, { promptDir: '/run/_pi', model: 'm-run' });
    expect(plan).toMatch(/\[router\][^\n]*--model m-node/); // node pin wins
    expect(plan).toMatch(/\[plain\][^\n]*--model m-run/);   // inherits the run default
  });

  it('renders --thinking faithfully — present when set, absent when not (a dry-run that drops a flag the LIVE run emits is a lying preview)', async () => {
    const wf = compile(await loadTemplate(TEMPLATE_MIN));
    // set ⇒ the cap appears on every realized command, mirroring defaultPiCommand's `opts.thinking` branch.
    expect(dryRunPlan(wf, { promptDir: '/run/_pi', thinking: 'low' })).toContain('--thinking low');
    // absent ⇒ no flag (the LIVE command omits it too) — guards against a spurious default.
    expect(dryRunPlan(wf, { promptDir: '/run/_pi' })).not.toContain('--thinking');
  });

  it('renders --mcp-config for a claude-code node with mcp.servers, never for a pi node (same lying-preview law)', async () => {
    const wf = compile({
      meta: { name: 't', description: 'd' },
      nodes: [
        { label: 'Writer', prompt: 'x', executor: 'claude-code', mcp: { servers: { snippets: { command: 'node', args: ['srv.mjs'] } } }, io: { reads: [], produces: ['index.html'], artifacts: [{ path: 'index.html' }] } },
        { label: 'Plain', prompt: 'y', tools: {}, io: { reads: [], produces: ['p.txt'], artifacts: [{ path: 'p.txt' }] } },
      ],
    });
    const plan = dryRunPlan(wf, { promptDir: '/run/_pi' });
    // mirrors node-lifecycle's CLAUDE_MCP_CONFIG_FILE staging layout (<stage>/<id>/claude-mcp.json)
    expect(plan).toMatch(/\[writer\][^\n]*--mcp-config '?\/run\/_pi\/writer\/claude-mcp\.json'?[^\n]*--strict-mcp-config/);
    expect(plan).not.toMatch(/\[plain\][^\n]*--mcp-config/);
  });

  it('run --dry-run materializes ${RUN}/.pi via instantiateRun and invokes NO model (runFromConfig not called)', async () => {
    let runFromConfigCalls = 0;
    const lines: string[] = [];
    const deps: RunDeps = {
      runFromConfig: async () => {
        runFromConfigCalls++;
        return { status: {} as never, outDir: dryOut };
      },
      print: (s) => lines.push(s),
    };
    await runTemplate(
      { templateDir: TEMPLATE_MIN, dryRun: true, run: 'gdry', args: { projectDir: dryOut }, workspace: dryWorkspace, outDir: dryOut },
      deps,
    );
    // NO model: the runFromConfig seam was never reached.
    expect(runFromConfigCalls).toBe(0);
    // the ${RUN}/.pi structure was materialized (state.json + each node folder).
    await expect(fs.stat(piDir(dryOut))).resolves.toBeDefined();
    await expect(fs.stat(nodeDir(dryOut, 'w0-classify'))).resolves.toBeDefined();
    // the realized command(s) were printed.
    const out = lines.join('\n');
    expect(out).toContain('w0-classify');
    expect(out).toMatch(/\bpi\b/);
  });

  // (G9) the dry-run must show the EXPANDED subworkflow sub-DAG — the SAME nodes the live run executes.
  // A preview that printed the un-expanded `gate` node (the subworkflow reference holder) and OMITTED the
  // spliced reviewer/consensus children would be a lying preview (run.ts promises the SAME expanded DAG).
  // Builds a parent template with a `gate` node referencing the shipped `verify` sub-template as a subdir,
  // then asserts the dry-run plan carries the namespaced child nodes and DROPS the un-expanded parent node.
  it('run --dry-run renders the EXPANDED subworkflow sub-DAG (namespaced children), not the un-expanded ref node', async () => {
    const verifySrc = path.resolve(HERE, '../../../templates/quality/verify');
    const tplSub = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-subwf-'));
    // parent: prep → gate(subworkflow→verify) → publish; verify is copied UNDER the parent so `ref` resolves.
    await fs.writeFile(
      path.join(tplSub, 'meta.json'),
      JSON.stringify({ id: 'sub-parent', name: 'sub-parent', description: 'subworkflow parent fixture', phases: ['prep', 'gate', 'publish'] }, null, 2),
    );
    const mkNode = async (id: string, def: object, prompt: string) => {
      const dir = path.join(tplSub, 'nodes', id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'node.json'), JSON.stringify(def, null, 2));
      await fs.writeFile(path.join(dir, 'prompt.md'), prompt);
    };
    const contract = (artifact: string) => ({ artifacts: [artifact], owns: [artifact], readScope: ['{{RUN}}'], returnMode: 'optional' });
    await mkNode('prep', { id: 'prep', phase: 'prep', deps: [], prompt: { file: 'prompt.md' }, tools: { allow: ['read', 'write', 'submit_result'] }, contract: contract('verify/subject.md') }, 'stage the subject');
    await mkNode('gate', { id: 'gate', phase: 'gate', deps: ['prep'], prompt: { file: 'prompt.md' }, tools: { allow: ['read', 'write', 'submit_result'] }, contract: contract('verify/verdict.json'), subworkflow: { ref: 'verify' } }, 'verify the subject');
    await mkNode('publish', { id: 'publish', phase: 'publish', deps: ['gate'], prompt: { file: 'prompt.md' }, tools: { allow: ['read', 'write', 'submit_result'] }, contract: contract('out/done.md') }, 'act on the verdict');
    await fs.cp(verifySrc, path.join(tplSub, 'verify'), { recursive: true });

    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-subwf-ws-'));
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-subwf-out-'));
    const lines: string[] = [];
    await runTemplate(
      { templateDir: tplSub, dryRun: true, run: 'subdry', args: {}, workspace: ws, outDir: out },
      { runFromConfig: async () => ({ status: {} as never, outDir: out }), print: (s) => lines.push(s) },
    );
    const printed = lines.join('\n');
    // the spliced sub-DAG (namespaced reviewers + consensus) AND the untouched prep/publish appear in the plan.
    for (const id of ['prep', 'gate-review-a', 'gate-review-b', 'gate-consensus', 'publish']) expect(printed).toContain(`[${id}]`);
    // the un-expanded subworkflow REFERENCE node must NOT survive as a standalone node — the splice REPLACED it.
    expect(printed).not.toMatch(/\[gate\]/);
    // 2 reviewers + consensus + prep + publish = 5 nodes (vs the lying 3-node un-expanded preview).
    expect(printed).toContain('5 nodes');
    for (const d of [tplSub, ws, out]) await fs.rm(d, { recursive: true, force: true });
  });

  // (Phase 2 · T2.4/T2.6) the dry-run must show the EXPANDED fusion DAG — the SAME sub-graph the live run
  // executes. A preview that printed the un-expanded `draft` node would be a lying preview.
  it('run --dry-run renders the EXPANDED fusion DAG (panel siblings + judge) with per-node models', async () => {
    const fusionSrc = path.resolve(HERE, '../../core/test/fixtures/template-fusion');
    const tplFusion = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-fusion-'));
    await fs.cp(fusionSrc, tplFusion, { recursive: true });
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-fusion-ws-'));
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-fusion-out-'));
    const lines: string[] = [];
    await runTemplate(
      { templateDir: tplFusion, dryRun: true, run: 'fzdry', args: {}, workspace: ws, outDir: out, model: 'run-default' },
      { runFromConfig: async () => ({ status: {} as never, outDir: out }), print: (s) => lines.push(s) },
    );
    const printed = lines.join('\n');
    // the panel siblings + the judge (original id) + the untouched successor all appear in the plan.
    for (const id of ['draft-p1', 'draft-p2', 'draft', 'publish']) expect(printed).toContain(`[${id}]`);
    // each sibling carries its panel model; the un-expanded `draft` (a single node) must NOT be the whole plan.
    expect(printed).toMatch(/\[draft-p1\][^\n]*--model fast/);
    expect(printed).toMatch(/\[draft-p2\][^\n]*--model deep/);
    expect(printed).toContain('4 nodes');
    for (const d of [tplFusion, ws, out]) await fs.rm(d, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (op-evidence/dry-run-guard) DRY-RUN × AN EXISTING RUN RECORD — reproduced live: `--dry-run --run <id>`
// against an id that ALREADY has a completed run materialized the dry plan INTO that run dir and REWROTE
// .pi/run.json, losing the real run's recorded args/usage/node history. The guard: refuse loudly when the
// target `--run <id>`'s `.pi/run.json` already records a NON-DRY run; stay a no-op (allowed) when the
// record is absent (fresh id) or is ITSELF a dry plan (idempotent re-dry — every node status 'dry').
// ─────────────────────────────────────────────────────────────────────────────
describe('piflowctl run --dry-run --run <id> — refuses to clobber an existing NON-DRY run record', () => {
  const realRunStatus = (id: string): RunStatus => ({
    run: id,
    startedAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:05:00.000Z',
    done: true,
    ok: true,
    durationMs: 300000,
    stage: null,
    totals: { nodes: 1, ok: 1, failed: 0 },
    args: { marker: 'REAL-RUN-DO-NOT-CLOBBER' },
    nodes: { n1: { id: 'n1', label: 'N1', status: 'ok', artifacts: [], issues: [] } },
  });
  const dryPlanStatus = (id: string): RunStatus => ({
    run: id,
    startedAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    done: true,
    ok: null,
    durationMs: null,
    stage: null,
    totals: null,
    nodes: { n1: { id: 'n1', label: 'N1', status: 'dry', artifacts: [], issues: [] } },
  });

  it('a --run id whose .pi/run.json already records a REAL run is refused loudly, naming the run dir — the record is left byte-for-byte untouched', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-dryguard-real-'));
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-dryguard-ws-'));
    try {
      await writeStatus(out, realRunStatus('clobber1'));
      const before = await readRunJson(out);

      let err: Error | undefined;
      try {
        await runTemplate(
          { templateDir: TEMPLATE_MIN, dryRun: true, run: 'clobber1', args: { projectDir: out }, workspace: ws, outDir: out },
          { print: () => {} },
        );
      } catch (e) {
        err = e as Error;
      }
      expect(err, 'a dry-run targeting an existing REAL run must refuse loudly (throw), never silently clobber').toBeDefined();
      expect(err!.message, 'the refusal names the run dir').toContain(out);
      expect(err!.message, 'the refusal suggests the escape hatch').toMatch(/--run/);

      // THE LOAD-BEARING PROOF: the original record — args, node history, usage — survived untouched.
      const after = await readRunJson(out);
      expect(after, 'the run record must be byte-for-byte unchanged, not partially overwritten').toEqual(before);
      expect(after?.args).toEqual({ marker: 'REAL-RUN-DO-NOT-CLOBBER' });
      expect(after?.nodes.n1.status).toBe('ok');
    } finally {
      await fs.rm(out, { recursive: true, force: true });
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it('a --run id with NO existing record dry-runs normally (a fresh preview, nothing to clobber)', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-dryguard-fresh-'));
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-dryguard-ws-'));
    try {
      await runTemplate(
        { templateDir: TEMPLATE_MIN, dryRun: true, run: 'freshdry1', args: { projectDir: out }, workspace: ws, outDir: out },
        { print: () => {} },
      );
      const after = await readRunJson(out);
      expect(after, 'the dry plan materialized').not.toBeNull();
      expect(Object.values(after!.nodes).every((n) => n.status === 'dry')).toBe(true);
    } finally {
      await fs.rm(out, { recursive: true, force: true });
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it('re-dry-running the SAME --run id whose existing record is ITSELF a dry plan is allowed (idempotent re-dry)', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-dryguard-redry-'));
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-dryguard-ws-'));
    try {
      await writeStatus(out, dryPlanStatus('redry1'));
      await runTemplate(
        { templateDir: TEMPLATE_MIN, dryRun: true, run: 'redry1', args: { projectDir: out }, workspace: ws, outDir: out },
        { print: () => {} },
      );
      const after = await readRunJson(out);
      expect(after, 'the re-dry must succeed and still be a dry plan').not.toBeNull();
      expect(Object.values(after!.nodes).every((n) => n.status === 'dry')).toBe(true);
    } finally {
      await fs.rm(out, { recursive: true, force: true });
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B2) DRY-RUN × SCRIPT TOOLS — the preview must run the SAME tool:<name> discovery the live
// node-lifecycle path runs (discoverScriptTools), or it lies twice: a valid script tool would read
// "tools unresolved" with the node's WHOLE tool list collapsed (builtins included, no -e), while the
// live run binds it and stages the generated extension. Preview-grade: a broken tool renders a
// per-tool WARN and the rest of the node's tools survive.
// ─────────────────────────────────────────────────────────────────────────────
describe('piflowctl run --dry-run — script tools (tool:<name>) discovered, never a lying preview', () => {
  // the shared-tools DEFINE dirs live in core's fixtures root; the templates' defs are {{WORKSPACE}}-relative.
  const CORE_FIXTURES = path.resolve(HERE, '../../core/test/fixtures');
  let TPL_SCRIPT: string;
  let TPL_BROKEN: string;
  beforeAll(async () => {
    // loadTemplate (re)writes the template's generated workflow.json lock → run over CLONES (the file convention).
    TPL_SCRIPT = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-script-tpl-'));
    await fs.cp(path.join(CORE_FIXTURES, 'template-script-tool'), TPL_SCRIPT, { recursive: true });
    TPL_BROKEN = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-script-broken-'));
    await fs.cp(path.join(CORE_FIXTURES, 'template-script-tool-broken'), TPL_BROKEN, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(TPL_SCRIPT, { recursive: true, force: true });
    await fs.rm(TPL_BROKEN, { recursive: true, force: true });
  });

  it('a valid tool:demo_probe lists demo_probe + the builtins on --tools AND stages the -e extension', async () => {
    const wf = compile(await loadTemplate(TPL_SCRIPT));
    const plan = dryRunPlan(wf, { promptDir: '/run/_pi', workspace: CORE_FIXTURES });
    const line = plan.split('\n').find((l) => l.includes('[probe]'));
    expect(line).toBeDefined();
    // the discovered script tool AND the declared builtin BOTH ride --tools (the live command's list).
    expect(line).toMatch(/--tools \S*\bdemo_probe\b/);
    expect(line).toMatch(/--tools \S*\bread\b/);
    // the generated tool extension is staged + referenced, mirroring the live `.pi/staged/<id>/tools.ts`.
    expect(line).toContain(`-e '/run/_pi/probe/tools.ts'`);
    // and the old collapse-everything path never fired.
    expect(line).not.toContain('tools unresolved at preview');
  });

  it('a BROKEN tool:demo_probe renders a per-tool WARN while the builtins survive on --tools', async () => {
    const wf = compile(await loadTemplate(TPL_BROKEN));
    const plan = dryRunPlan(wf, { promptDir: '/run/_pi', workspace: CORE_FIXTURES });
    const line = plan.split('\n').find((l) => l.includes('[probe]'));
    expect(line).toBeDefined();
    // the node's OTHER tools survive — never the whole-list collapse.
    expect(line).toMatch(/--tools \S*\bread\b/);
    // the per-tool warning names the address AND the concrete reason (the missing exec script).
    expect(line).toMatch(/WARN/);
    expect(line).toContain('tool:demo_probe');
    expect(line).toMatch(/exec script not found/);
    // the broken tool must NOT ride --tools (the live run would block; the preview must not claim it binds)…
    expect(line).not.toMatch(/--tools \S*\bdemo_probe\b/);
    // …and the old collapse-everything path never fired.
    expect(line).not.toContain('tools unresolved at preview');
  });

  // (optional defs) presence-based offering in the preview: an OPTIONAL tool whose dir is absent renders
  // the SAME "optional, not present" note the live preflight surfaces — never a WARN, never a collapse.
  it('an OPTIONAL tool whose dir is ABSENT renders the "optional, not present" NOTE; builtins survive', async () => {
    const tplOptional = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-script-opt-'));
    await fs.cp(path.join(CORE_FIXTURES, 'template-script-tool-optional'), tplOptional, { recursive: true });
    try {
      const wf = compile(await loadTemplate(tplOptional));
      const plan = dryRunPlan(wf, { promptDir: '/run/_pi', workspace: CORE_FIXTURES });
      const line = plan.split('\n').find((l) => l.includes('[probe]'));
      expect(line).toBeDefined();
      // the builtin survives; the absent optional tool is simply not offered.
      expect(line).toMatch(/--tools \S*\bread\b/);
      expect(line).not.toMatch(/--tools \S*\bghost_probe\b/);
      expect(line).not.toContain('-e '); // no extension staged for a builtins-only resolution
      // the pinned note is rendered — as a NOTE (informational), never a WARN (it is not a violation).
      expect(line).toContain('tool:ghost_probe — optional, not present for this run');
      expect(line).not.toMatch(/WARN/);
      expect(line).not.toContain('tools unresolved at preview');
    } finally {
      await fs.rm(tplOptional, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (C) RUN WIRING — the LIVE branch routes through core `runFromTemplate(dir, opts)` (the template-run
// join: loadTemplate → instantiateRun → compile → runWorkflow, INSIDE core). The CLI no longer hand-
// orchestrates those four seams; it just THREADS the resolved options. We assert via an injected
// `runFromTemplate` spy that EVERY required option arrives: args · workspace · the sandbox provider
// (LocalSandboxProvider vs none) · providerName · thinking · model · from/until · runDir.
// template-min is not runnable headless (seed/inject the fixture has no product seed for), so the spy
// stands in for the real run; a live E2E awaits a real template (T6).
// ─────────────────────────────────────────────────────────────────────────────
describe('piflowctl run — LIVE branch routes through core runFromTemplate, threading every option', () => {
  let out: string;
  beforeAll(async () => {
    out = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-wire-out-'));
  });
  afterAll(async () => {
    await fs.rm(out, { recursive: true, force: true });
  });

  it('threads args + workspace + a LocalSandboxProvider + providerName + thinking + model into runFromTemplate', async () => {
    let templateDirSeen: string | undefined;
    let optsSeen: RunFromTemplateOpts | undefined;

    const deps: RunDeps = {
      runFromTemplate: async (templateDir, opts) => {
        templateDirSeen = templateDir;
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      print: () => {},
    };

    await runTemplate(
      {
        templateDir: TEMPLATE_MIN,
        dryRun: false,
        run: 'gwire',
        args: { prompt: 'hi' },
        workspace: '/w',
        outDir: out,
        sandbox: 'local',
        provider: 'mmgw',
        thinking: 'low',
        model: 'MiniMax-M3',
        from: 's2',
        until: 's5',
        profile: 'companion',
        maxConcurrent: 4,
      },
      deps,
    );

    expect(templateDirSeen).toBe(TEMPLATE_MIN);
    // THE load-bearing assertion: every option threads through (drop any one in run.ts ⇒ this goes red).
    expect(optsSeen?.runDir).toBe(out);
    expect(optsSeen?.run).toBe('gwire');
    expect(optsSeen?.args).toEqual({ prompt: 'hi' });
    expect(optsSeen?.workspace).toBe('/w');
    expect(optsSeen?.providerName).toBe('mmgw');
    expect(optsSeen?.thinking).toBe('low');
    expect(optsSeen?.model).toBe('MiniMax-M3');
    expect(optsSeen?.from).toBe('s2');
    expect(optsSeen?.until).toBe('s5');
    expect(optsSeen?.profile).toBe('companion');
    expect(optsSeen?.maxConcurrent).toBe(4); // the G2 cap threads through to the runner
    // --sandbox local ⇒ a real LocalSandboxProvider instance is constructed and passed.
    expect(optsSeen?.provider).toBeInstanceOf(LocalSandboxProvider);
    expect((optsSeen?.provider as { kind?: string } | undefined)?.kind).toBe('local');
  });

  it('PI_RUNNER_IDLE_TIMEOUT=0 threads idleRequestMs:0 into runFromTemplate — the env DISABLE reaches the live path', async () => {
    // The 0-doesn't-disable regression (run 260714-02): the live template path resolves the PI_RUNNER_* timeout
    // knobs through loadConfig and threads them into runFromTemplate. Without that threading the env is read
    // NOWHERE on a live run and the runner default silently wins. Drop the watchdog threading in run.ts ⇒
    // idleRequestMs is undefined ⇒ this goes red. 0 must arrive as a real 0 (which the runner treats as OFF).
    const prev = process.env.PI_RUNNER_IDLE_TIMEOUT;
    process.env.PI_RUNNER_IDLE_TIMEOUT = '0';
    try {
      let optsSeen: RunFromTemplateOpts | undefined;
      const deps: RunDeps = {
        runFromTemplate: async (_dir, opts) => { optsSeen = opts; return { status: { ok: true } as never, outDir: opts.runDir }; },
        print: () => {},
      };
      await runTemplate(
        { templateDir: TEMPLATE_MIN, dryRun: false, run: 'gidle0', args: {}, outDir: out, sandbox: 'inmemory' },
        deps,
      );
      expect(optsSeen?.idleRequestMs).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.PI_RUNNER_IDLE_TIMEOUT;
      else process.env.PI_RUNNER_IDLE_TIMEOUT = prev;
    }
  });

  it('a live run with NO PI_RUNNER_IDLE_TIMEOUT leaves idleRequestMs undefined (the runner default applies)', async () => {
    const prev = process.env.PI_RUNNER_IDLE_TIMEOUT;
    delete process.env.PI_RUNNER_IDLE_TIMEOUT;
    try {
      let optsSeen: RunFromTemplateOpts | undefined;
      const deps: RunDeps = {
        runFromTemplate: async (_dir, opts) => { optsSeen = opts; return { status: { ok: true } as never, outDir: opts.runDir }; },
        print: () => {},
      };
      await runTemplate(
        { templateDir: TEMPLATE_MIN, dryRun: false, run: 'gidledef', args: {}, outDir: out, sandbox: 'inmemory' },
        deps,
      );
      expect(optsSeen?.idleRequestMs).toBeUndefined(); // absent ⇒ pruned ⇒ runWorkflow's `?? 720_000` wins
    } finally {
      if (prev !== undefined) process.env.PI_RUNNER_IDLE_TIMEOUT = prev;
    }
  });

  it('--sandbox inmemory OMITS the provider (core default) — no LocalSandboxProvider', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    const deps: RunDeps = {
      runFromTemplate: async (_dir, opts) => {
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      print: () => {},
    };
    await runTemplate(
      { templateDir: TEMPLATE_MIN, dryRun: false, run: 'gmem', args: {}, outDir: out, sandbox: 'inmemory' },
      deps,
    );
    expect(optsSeen?.provider).toBeUndefined();
  });

  it('--sandbox local is SECURE BY DEFAULT — the LocalSandboxProvider has the read-scope jail ON', async () => {
    // The default real-run path must enforce read scope. Drop the secure default in run.ts ⇒ this goes red.
    let optsSeen: RunFromTemplateOpts | undefined;
    const deps: RunDeps = {
      runFromTemplate: async (_dir, opts) => { optsSeen = opts; return { status: { ok: true } as never, outDir: opts.runDir }; },
      print: () => {},
    };
    await runTemplate(
      { templateDir: TEMPLATE_MIN, dryRun: false, run: 'gsecure', args: {}, outDir: out, sandbox: 'local' },
      deps,
    );
    expect(optsSeen?.provider).toBeInstanceOf(LocalSandboxProvider);
    expect((optsSeen?.provider as LocalSandboxProvider).enforceReadScope).toBe(true);
  });

  it('--sandbox danger-full-access ⇒ a LocalSandboxProvider with the jail OFF (the named escape hatch)', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    const deps: RunDeps = {
      runFromTemplate: async (_dir, opts) => { optsSeen = opts; return { status: { ok: true } as never, outDir: opts.runDir }; },
      print: () => {},
    };
    await runTemplate(
      { templateDir: TEMPLATE_MIN, dryRun: false, run: 'gdanger', args: {}, outDir: out, sandbox: 'danger-full-access' },
      deps,
    );
    // Still the real in-place provider — but the read-scope jail is explicitly disabled.
    expect(optsSeen?.provider).toBeInstanceOf(LocalSandboxProvider);
    expect((optsSeen?.provider as LocalSandboxProvider).enforceReadScope).toBe(false);
  });

  it('an unknown --sandbox value THROWS loudly (never silently degrades to inmemory/no-model)', async () => {
    const deps: RunDeps = {
      runFromTemplate: async (_dir, opts) => ({ status: { ok: true } as never, outDir: opts.runDir }),
      print: () => {},
    };
    await expect(
      runTemplate(
        { templateDir: TEMPLATE_MIN, dryRun: false, run: 'gbad', args: {}, outDir: out, sandbox: 'seatbelt' as never },
        deps,
      ),
    ).rejects.toThrow(/unknown --sandbox/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (G7) DETACH / UNATTENDED — `--detach` runs the workflow UNATTENDED: it threads the already-shipped
// (G5) `checkpointReply: 'default'` so a backgrounded run takes each checkpoint's declared default
// instead of parking forever. The CLI never threaded this before — the load-bearing G7 gap.
// ─────────────────────────────────────────────────────────────────────────────
describe('piflowctl run — --detach (unattended) threads checkpointReply', () => {
  it('parseRunArgs recognizes --detach', () => {
    expect(parseRunArgs([TEMPLATE_MIN, '--detach']).detach).toBe(true);
    expect(parseRunArgs([TEMPLATE_MIN]).detach).toBeFalsy();
  });

  it('runTemplate threads checkpointReply:"default" into runFromTemplate when --detach', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    const deps: RunDeps = {
      runFromTemplate: async (_dir, opts) => {
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      print: () => {},
    };
    await runTemplate(
      { templateDir: TEMPLATE_MIN, dryRun: false, run: 'gdetach', args: {}, sandbox: 'inmemory', detach: true },
      deps,
    );
    expect(optsSeen?.checkpointReply).toBe('default');
  });

  it('an ATTENDED run (no --detach) does NOT set checkpointReply (it parks for the courier)', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    const deps: RunDeps = {
      runFromTemplate: async (_dir, opts) => {
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      print: () => {},
    };
    await runTemplate(
      { templateDir: TEMPLATE_MIN, dryRun: false, run: 'gattended', args: {}, sandbox: 'inmemory' },
      deps,
    );
    expect(optsSeen?.checkpointReply).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B2) CANONICAL HOME WINS — a template under `.piflow/<wf>/template/` resolves the run to its canonical
// `.piflow/<wf>/runs/<id>/` home, and `--out` can NEVER relocate it (observation reads the fixed home).
// These FAIL if the precedence regresses to `parsed.outDir ?? canonicalHome` (the old --out-wins order).
// ─────────────────────────────────────────────────────────────────────────────
describe('piflowctl run — a canonical run home is never relocated by --out', () => {
  let canonRoot: string; // the product root (the `.piflow` PARENT) — templateLayout derives it from the template
  let wfRoot: string;    // <canonRoot>/.piflow/<wf>; its `template/` child gives runsHome = <wfRoot>/runs
  let canonTemplate: string;
  let elsewhere: string;
  beforeAll(async () => {
    // A REAL canonical layout: <root>/.piflow/<wf>/template. `templateLayout` (strict — requires the `.piflow`
    // ancestor) is what derives the canonical runs home now, so the fixture must be a genuine D9 tree.
    canonRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-canon-root-'));
    wfRoot = path.join(canonRoot, '.piflow', 'demo');
    canonTemplate = path.join(wfRoot, 'template');
    await fs.mkdir(wfRoot, { recursive: true });
    await fs.cp(FIXTURE, canonTemplate, { recursive: true });
    elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-canon-elsewhere-'));
  });
  afterAll(async () => {
    await fs.rm(canonRoot, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  });

  it('resolves runDir to the canonical <wf>/runs/<id> and IGNORES an explicit --out pointing elsewhere', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps: RunDeps = {
      runFromTemplate: async (_dir, opts) => {
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      print: () => {},
    };

    await runTemplate(
      { templateDir: canonTemplate, dryRun: false, run: 'canon1', args: {}, outDir: elsewhere, sandbox: 'inmemory' },
      deps,
    );

    // canonical home wins — NOT the --out path.
    expect(optsSeen?.runDir).toBe(path.join(wfRoot, 'runs', 'canon1'));
    expect(optsSeen?.runDir).not.toBe(elsewhere);
    // and the operator is told --out was ignored (a silent override would mislead).
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--out is ignored'));
    warn.mockRestore();
  });

  it('with NO --out, a canonical template still lands in <wf>/runs/<id> (no warning)', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps: RunDeps = {
      runFromTemplate: async (_dir, opts) => { optsSeen = opts; return { status: { ok: true } as never, outDir: opts.runDir }; },
      print: () => {},
    };
    await runTemplate(
      { templateDir: canonTemplate, dryRun: false, run: 'canon2', args: {}, sandbox: 'inmemory' },
      deps,
    );
    expect(optsSeen?.runDir).toBe(path.join(wfRoot, 'runs', 'canon2'));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (C2) AUTO-NAMING — when `--run/--id` is OMITTED the CLI mints a memorable `<adjective>-<pie>` run name
// (collision-checked against existing run dirs) and threads it as BOTH `run` and `name`; an explicit
// `--run` ALWAYS wins. A `--arg prompt`/`promptId` is carried as run METADATA (`promptId`), decoupling the
// run's identity from the prompt id. These FAIL if the old `?? 'run'` constant fallback returns, if an
// explicit id stops winning, or if the prompt metadata is dropped.
// ─────────────────────────────────────────────────────────────────────────────
describe('piflowctl run — Docker-style auto-naming when --run is omitted', () => {
  let out: string;
  beforeAll(async () => {
    out = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-name-out-'));
  });
  afterAll(async () => {
    await fs.rm(out, { recursive: true, force: true });
  });

  it('mints an auto-name (threaded as run + name) when --run is omitted, and carries promptId from --arg prompt', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    let existingSeen: string[] | undefined;
    const deps: RunDeps = {
      runFromTemplate: async (_dir, opts) => {
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      generateName: (existing) => {
        existingSeen = existing;
        return 'flaky-pecan';
      },
      listExistingRuns: () => ['golden-banoffee'], // the collision-check input the namer must receive
      print: () => {},
    };

    await runTemplate(
      { templateDir: TEMPLATE_MIN, dryRun: false, args: { prompt: 'p06' }, outDir: out, sandbox: 'inmemory' },
      deps,
    );

    // the minted name is threaded as BOTH the run id AND the memorable name (run.json `name`).
    expect(optsSeen?.run).toBe('flaky-pecan');
    expect(optsSeen?.name).toBe('flaky-pecan');
    // the namer was collision-checked against the existing run dirs.
    expect(existingSeen).toEqual(['golden-banoffee']);
    // the prompt id is carried as run METADATA, not as the run id.
    expect(optsSeen?.promptId).toBe('p06');
  });

  it('an EXPLICIT --run ALWAYS wins — the auto-namer is NOT called and the id is used verbatim', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    let nameGenCalls = 0;
    const deps: RunDeps = {
      runFromTemplate: async (_dir, opts) => {
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      generateName: () => {
        nameGenCalls++;
        return 'should-not-be-used';
      },
      print: () => {},
    };

    await runTemplate(
      { templateDir: TEMPLATE_MIN, dryRun: false, run: 'p06', args: {}, outDir: out, sandbox: 'inmemory' },
      deps,
    );

    expect(nameGenCalls).toBe(0); // explicit id ⇒ the generator is never consulted
    expect(optsSeen?.run).toBe('p06');
    expect(optsSeen?.name).toBe('p06');
    expect(optsSeen?.promptId).toBeUndefined(); // no --arg prompt ⇒ no prompt metadata
  });

  // (M1) The REAL default (no injected `deps.generateName`) is now `generateDateSeqName` — a scannable
  // `YYMMDD-NN` — NOT the Docker-style `<adjective>-<pie>` pick. This FAILS if the default generator
  // regresses back to `generateRunName` (agent-minted names must scale to hundreds of runs).
  it('the REAL default generator (no injected generateName) mints a "YYMMDD-NN" date-seq name', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    const deps: RunDeps = {
      runFromTemplate: async (_dir, opts) => {
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      // no generateName injected ⇒ exercises run.ts's own default wiring.
      listExistingRuns: () => [],
      print: () => {},
    };

    await runTemplate({ templateDir: TEMPLATE_MIN, dryRun: false, args: {}, outDir: out, sandbox: 'inmemory' }, deps);

    expect(optsSeen?.run).toMatch(/^\d{6}-\d{2}$/);
    expect(optsSeen?.name).toBe(optsSeen?.run);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (D) FAILURE SURFACING — a finished LIVE run that ended `done && ok===false` (a blocked resume preflight
// or an errored/blocked node) must produce a LOUD, specific verdict (the silent-no-op / empty-log / exit-0
// regression). runFailureReport is the pure core of that: it FAILS this suite if it drops the blocking
// node's issue, or reports on a healthy run.
// ─────────────────────────────────────────────────────────────────────────────
describe('runFailureReport — the loud verdict for a finished failed run', () => {
  const blockedResume = {
    done: true,
    ok: false,
    nodes: {
      'w2-scaffold': { id: 'w2-scaffold', label: 'w2', status: 'reused', artifacts: [], issues: [] },
      __resume__: {
        id: '__resume__', label: 'resume preflight', status: 'blocked', artifacts: [],
        issues: ['cannot --from "w4-execute-m2": missing upstream artifact(s): verify/report.M1.json (verify-2-m1)'],
      },
    },
  } as never;

  it('surfaces every blocked/errored node AND its issue text (drop the issue loop ⇒ red)', () => {
    const report = runFailureReport(blockedResume, 'out/p06');
    expect(report).not.toBeNull();
    expect(report).toContain('✗ FAILED');
    expect(report).toContain('__resume__');
    // the LOAD-BEARING line: the actual blocking reason must reach the user, not just a count.
    expect(report).toContain('missing upstream artifact(s): verify/report.M1.json (verify-2-m1)');
    expect(report).toContain('piflowctl status out/p06');
    // a `reused` (non-failed) node is not listed as a failure.
    expect(report).not.toContain('w2-scaffold');
  });

  it('returns null on a healthy run (ok) and on a still-running run (no false alarm)', () => {
    expect(runFailureReport({ done: true, ok: true, nodes: {} } as never, 'out/x')).toBeNull();
    expect(runFailureReport({ done: false, ok: null, nodes: {} } as never, 'out/x')).toBeNull();
  });

  // (op-integrity WS-I3) A node can carry MULTIPLE opFailures entries of DIFFERENT consequence — a warn
  // integrity violation (silent-unless-failing evidence) alongside the real BLOCKING reason. The report must
  // tell them apart by icon (⚠ warn vs ✗ block) — never a flat ✗ for both — and when the blocking entry
  // declares a `resultFile`, its `detail` already carries the LEDGER verdict (WS-I2), so the report must show
  // that verdict (the named failing check), never raw stderr noise.
  it('renders ⚠ for a warn-consequence op failure and keeps ✗ for the blocking one, showing the ledger verdict', () => {
    const blocked = {
      done: true,
      ok: false,
      nodes: {
        verify: {
          id: 'verify', label: 'verify', status: 'blocked', artifacts: [], issues: [],
          opFailures: [
            {
              detail: 'op stage integrity — min-bytes persona.md: 0 bytes (min 200000)',
              onFailure: 'warn' as const,
              integrity: [{ kind: 'min-bytes', ok: false, detail: 'persona.md: 0 bytes (min 200000)' }],
            },
            {
              detail: 'op verify failed — ledger/verify/output.json — ok=false · failing: answer_in_choices: choice not in options',
              onFailure: 'block' as const,
              resultFile: 'ledger/verify/output.json',
            },
          ],
        },
      },
    } as never;
    const report = runFailureReport(blocked, 'out/r1');
    expect(report).not.toBeNull();
    // the warn entry gets a DISTINCT icon — never the block ✗.
    expect(report).toMatch(/⚠ verify: op warn — op stage integrity/);
    // the blocking entry keeps ✗ and carries the LEDGER verdict, not a stderr line.
    expect(report).toMatch(/✗ verify: op FAILED — op verify failed — ledger\/verify\/output\.json/);
    expect(report).toContain('answer_in_choices');
    expect(report).not.toMatch(/MCP client unavailable|\[kp_cache\]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (E) PROFILE ELISION — the dry-run plan compiles against the ACTIVE profile (declared in meta.json as
// DATA), so the realized plan reflects the SAME reduced DAG the live run would execute. We clone
// template-min and inject a `profiles` block that elides the `build` phase (both leaf nodes), leaving
// only the `classify` root. Drop the applyProfileByName call in run.ts ⇒ these go red (the leaves reappear).
// ─────────────────────────────────────────────────────────────────────────────
describe('piflowctl run --dry-run --profile — the plan reflects the elided DAG', () => {
  let PROFILED: string; // a template-min clone with a profiles block
  let pOut: string;
  let pWs: string;
  beforeAll(async () => {
    PROFILED = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-profiled-tpl-'));
    await fs.cp(FIXTURE, PROFILED, { recursive: true });
    const meta = JSON.parse(await fs.readFile(path.join(PROFILED, 'meta.json'), 'utf8'));
    meta.profiles = { full: {}, lean: { elidePhases: ['build'] } };
    meta.defaultProfile = 'full';
    await fs.writeFile(path.join(PROFILED, 'meta.json'), JSON.stringify(meta, null, 2));
    pOut = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-profiled-out-'));
    pWs = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-profiled-ws-'));
  });
  afterAll(async () => {
    for (const d of [PROFILED, pOut, pWs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('--profile lean ELIDES the build-phase leaves (only the classify root survives in the plan)', async () => {
    const lines: string[] = [];
    await runTemplate(
      { templateDir: PROFILED, dryRun: true, run: 'lean', args: { projectDir: pOut }, workspace: pWs, outDir: pOut, profile: 'lean' },
      { print: (s) => lines.push(s) },
    );
    const out = lines.join('\n');
    expect(out).toContain('[profile: lean]');
    expect(out).toContain('w0-classify');     // the root survives
    expect(out).not.toContain('w2a-levels');  // the build leaves are ELIDED
    expect(out).not.toContain('w2b-assets');
    expect(out).toContain('1 nodes');          // exactly one node remains
  });

  it('the DEFAULT profile (full = {}) leaves the DAG unchanged — all three nodes present', async () => {
    const lines: string[] = [];
    await runTemplate(
      { templateDir: PROFILED, dryRun: true, run: 'full', args: { projectDir: pOut }, workspace: pWs, outDir: pOut },
      { print: (s) => lines.push(s) },
    );
    const out = lines.join('\n');
    for (const id of ['w0-classify', 'w2a-levels', 'w2b-assets']) expect(out).toContain(id);
    expect(out).toContain('3 nodes');
  });

  it('an UNKNOWN --profile errors loudly (lists the declared names), never a silent full DAG', async () => {
    await expect(
      runTemplate(
        { templateDir: PROFILED, dryRun: true, run: 'ghost', args: {}, workspace: pWs, outDir: pOut, profile: 'ghost' },
        { print: () => {} },
      ),
    ).rejects.toThrow(/unknown profile "ghost".*full.*lean/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (E2) ADDITIVE PROFILE OVERLAY on the DRY-RUN PATH — a `template/profiles/<name>.json` overlay that
// APPENDS an `agentic` gate must MERGE when `--profile <name>` is passed, so the dry-run plan shows the
// materialized `<producer>__judge` node — the SAME judge the live run would execute. The bug: the dry-run
// called loadTemplate(templateDir) with NO opts, so the overlay never merged and no judge appeared (a dead
// flag). These clone template-min, drop in an overlay, and assert the judge shows up ONLY via --profile.
// Drop the `{ profile }` threading in run.ts ⇒ the judge vanishes ⇒ these go red.
// ─────────────────────────────────────────────────────────────────────────────
describe('piflowctl run --dry-run --profile — an additive OVERLAY materializes the judge in the plan', () => {
  const JUDGE_ID = 'w0-classify-judge'; // slugify('w0-classify__judge') — the `__` collapses to `-`
  // Clone template-min and write a profile overlay adding an `agentic` gate to w0-classify (judge tier `deep`
  // differs from the producer's undefined tier — a valid judge). `declareLegacy` optionally ALSO declares the
  // name in meta.json.profiles (with the given elidePhases) — the reconciliation matrix.
  async function cloneWithOverlay(name: string, declareLegacy?: { elidePhases?: string[] }): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-overlay-tpl-'));
    await fs.cp(FIXTURE, dir, { recursive: true });
    const pdir = path.join(dir, 'profiles');
    await fs.mkdir(pdir, { recursive: true });
    await fs.writeFile(
      path.join(pdir, `${name}.json`),
      JSON.stringify({ nodes: { 'w0-classify': [{ type: 'agentic', judgeTier: 'deep', rubric: 'Exhaustive + consistent.' }] } }, null, 2),
    );
    if (declareLegacy) {
      const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
      meta.profiles = { ...(meta.profiles ?? {}), [name]: declareLegacy };
      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    }
    return dir;
  }
  async function dryPlan(dir: string, profile?: string): Promise<string> {
    const lines: string[] = [];
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-overlay-out-'));
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-overlay-ws-'));
    try {
      await runTemplate(
        { templateDir: dir, dryRun: true, run: 'ov', args: {}, workspace: ws, outDir: out, profile },
        { print: (s) => lines.push(s) },
      );
    } finally {
      for (const d of [out, ws]) await fs.rm(d, { recursive: true, force: true });
    }
    return lines.join('\n');
  }

  it('the overlay judge appears ONLY when --profile is passed (declared-legacy + overlay — the game-omni shape)', async () => {
    // The name is ALSO declared as an empty legacy profile (no elision) — mirrors game-omni's production/companion.
    const dir = await cloneWithOverlay('production', {});
    try {
      const bare = await dryPlan(dir); // no --profile ⇒ the overlay is inert
      expect(bare).not.toContain(JUDGE_ID);
      const profiled = await dryPlan(dir, 'production'); // --profile ⇒ the overlay merges → the judge materializes
      expect(profiled).toContain(JUDGE_ID);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('an OVERLAY-ONLY profile (no meta.json declaration) materializes the judge AND does not throw (reconciliation)', async () => {
    // No legacy declaration: applyProfileByName would throw UnknownProfileError for this name if it were reached —
    // the reconciliation must make it a NO-OP (the overlay already merged in loadTemplate). No throw + judge present.
    const dir = await cloneWithOverlay('production');
    try {
      const profiled = await dryPlan(dir, 'production');
      expect(profiled).toContain(JUDGE_ID);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('a profile carrying BOTH an overlay AND elidePhases: the judge materializes AND the elided leaves drop', async () => {
    // `lean` adds the judge to w0-classify (classify phase) AND elides the `build` phase (the two leaves).
    const dir = await cloneWithOverlay('lean', { elidePhases: ['build'] });
    try {
      const profiled = await dryPlan(dir, 'lean');
      expect(profiled).toContain(JUDGE_ID);       // overlay APPENDED the judge
      expect(profiled).not.toContain('w2a-levels'); // elidePhases REMOVED the build leaves
      expect(profiled).not.toContain('w2b-assets');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (A2 · ANTI-FOOTGUN) A run launched WITHOUT --workspace anchors {{WORKSPACE}} (and the sandbox read-jail,
// threaded as repoRoot) at the PRODUCT ROOT derived from the template's own `.piflow/<wf>/template/`
// placement — NEVER process.cwd(). This is the highest-value migration fix: pre-change the workspace
// defaulted to cwd, so a run kicked off from a FOREIGN dir resolved {{WORKSPACE}} to wherever it was
// invoked (and the read-jail anchored at cwd on every run because repoRoot was never passed). We build a
// canonical product tree, run from a cwd that is NOT the product root, and assert (a) the REAL dry-run
// instantiate materializes <run>/.pi/nodes/<id>/prompt.md with {{WORKSPACE}} = the product root, and
// (b) the live branch threads repoRoot = that product root into runFromTemplate.
// ─────────────────────────────────────────────────────────────────────────────
describe('piflowctl run — {{WORKSPACE}} + the read-jail anchor at the product root, not cwd (anti-footgun)', () => {
  let product: string; // <root> — the derived productRoot (the `.piflow` parent)
  let template: string; // <root>/.piflow/greet/template — a canonical D9 template
  beforeAll(async () => {
    product = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-anchor-prod-'));
    template = path.join(product, '.piflow', 'greet', 'template');
    await fs.mkdir(path.join(template, 'nodes', 'only'), { recursive: true });
    await fs.writeFile(
      path.join(template, 'meta.json'),
      JSON.stringify({ id: 'greet', name: 'greet', description: 'anchor fixture', phases: ['only'] }, null, 2),
    );
    await fs.writeFile(
      path.join(template, 'nodes', 'only', 'node.json'),
      JSON.stringify(
        { id: 'only', phase: 'only', deps: [], prompt: { file: 'prompt.md' }, tools: { allow: ['read', 'write', 'submit_result'] }, contract: { artifacts: ['out.md'], owns: ['out.md'], readScope: ['{{RUN}}'], returnMode: 'optional' } },
        null,
        2,
      ),
    );
    // the prompt PROSE carries {{WORKSPACE}} literally, so the materialized prompt physically reveals the root.
    await fs.writeFile(path.join(template, 'nodes', 'only', 'prompt.md'), 'canon={{WORKSPACE}}/skills — build under {{RUN}}');
  });
  afterAll(async () => {
    await fs.rm(product, { recursive: true, force: true });
  });

  it('with NO --workspace and a FOREIGN cwd, the REAL dry-run instantiate resolves {{WORKSPACE}} to the product root', async () => {
    // the run's cwd is the test process cwd (the piflow repo) — deliberately NOT the tmp product root.
    expect(process.cwd()).not.toBe(product);
    // NO --workspace, NO --out: workspace + the canonical run home must both derive from the template layout.
    await runTemplate(
      { templateDir: template, dryRun: true, run: 'anchor1', args: {}, sandbox: 'inmemory' },
      { print: () => {} },
    );
    // the run landed in its CANONICAL home (.piflow/greet/runs/anchor1), and instantiateRun materialized the
    // node prompt there with {{WORKSPACE}} resolved.
    const runDir = path.join(product, '.piflow', 'greet', 'runs', 'anchor1');
    const prompt = await fs.readFile(nodePromptFile(runDir, 'only'), 'utf8');
    // {{WORKSPACE}} resolved to the PRODUCT ROOT (the template's `.piflow` parent) — not the foreign cwd.
    expect(prompt).toContain(`canon=${product}/skills`);
    expect(prompt).not.toContain('{{WORKSPACE}}');
    expect(prompt).not.toContain(`canon=${process.cwd()}/skills`);
  });

  it('the LIVE branch threads repoRoot = the derived product root into runFromTemplate (the read-jail anchor)', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    await runTemplate(
      { templateDir: template, dryRun: false, run: 'anchor2', args: {}, sandbox: 'inmemory' },
      { runFromTemplate: async (_d, o) => { optsSeen = o; return { status: { ok: true } as never, outDir: o.runDir }; }, print: () => {} },
    );
    // both the workspace token root AND the sandbox read-jail anchor derive from the template layout, not cwd.
    expect(optsSeen?.workspace).toBe(product);
    expect(optsSeen?.repoRoot).toBe(product); // pre-change repoRoot was NEVER passed → the jail anchored at cwd.
  });
});
