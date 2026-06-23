import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRunArgs,
  dryRunPlan,
  runTemplate,
  type RunDeps,
} from '../src/run.js';
import { loadTemplate, compile, instantiateRun, piDir, nodeDir } from '@piflow/core';

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
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) DRY-RUN — builds + prints the per-node pi command WITHOUT invoking a model, and materializes
// the ${RUN}/.pi structure via instantiateRun.
// ─────────────────────────────────────────────────────────────────────────────
describe('piflow run --dry-run — realized commands, no model', () => {
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
});

// ─────────────────────────────────────────────────────────────────────────────
// (C) RUN WIRING — drive loadConfig → loadTemplate → instantiateRun → runFromConfig with the right args.
// template-min is NOT runnable headless (its nodes declare `submit_result`, absent from the builtin
// catalog → a tool-bind block, plus seed/inject the fixture has no product seed for). So we assert the
// WIRING via injected spies (the right calls, the right args) and FLAG that a live E2E awaits a real
// template (T6).
// ─────────────────────────────────────────────────────────────────────────────
describe('piflow run — wires loadConfig→loadTemplate→instantiateRun→runFromConfig', () => {
  let ws: string;
  let out: string;
  beforeAll(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-wire-ws-'));
    out = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-wire-out-'));
  });
  afterAll(async () => {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  });

  it('passes the env/arg-resolved config AND the loadTemplate spec into runFromConfig', async () => {
    const order: string[] = [];
    let configSeen: { run?: string } | undefined;
    let specPassed = false;
    const realSpec = await loadTemplate(TEMPLATE_MIN);

    const deps: RunDeps = {
      loadConfig: (input) => {
        order.push('loadConfig');
        // it must receive the parsed run id as the required arg.
        expect(input.args.run).toBe('gwire');
        return { run: input.args.run!, providerName: 'cp' };
      },
      loadTemplate: async (dir) => {
        order.push('loadTemplate');
        expect(dir).toBe(TEMPLATE_MIN);
        return realSpec;
      },
      instantiateRun: async (templateDir, runDir, opts) => {
        order.push('instantiateRun');
        expect(templateDir).toBe(TEMPLATE_MIN);
        expect(runDir).toBe(out);
        expect(opts.workspace).toBe(ws);
        return { runDir, nodes: [] };
      },
      runFromConfig: async (config) => {
        order.push('runFromConfig');
        configSeen = config as { run?: string };
        // the workflowSpec source is the SAME object loadTemplate returned (bridge = the template spec).
        specPassed = (config as { workflowSpec?: unknown }).workflowSpec === realSpec;
        // and the resolved config threaded through (the run id from loadConfig).
        expect((config as { run?: string }).run).toBe('gwire');
        return { status: { ok: true } as never, outDir: runDir(out) };
      },
      print: () => {},
    };
    function runDir(d: string): string {
      return d;
    }

    await runTemplate(
      { templateDir: TEMPLATE_MIN, dryRun: false, run: 'gwire', args: { run: 'gwire' }, workspace: ws, outDir: out },
      deps,
    );

    // the four seams ran IN ORDER (the load-bearing wiring).
    expect(order).toEqual(['loadConfig', 'loadTemplate', 'instantiateRun', 'runFromConfig']);
    expect(specPassed).toBe(true);
    expect(configSeen?.run).toBe('gwire');
  });
});
