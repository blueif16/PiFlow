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
import {
  loadTemplate,
  compile,
  instantiateRun,
  piDir,
  nodeDir,
  LocalSandboxProvider,
  type RunFromTemplateOpts,
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

  it('renders --thinking faithfully — present when set, absent when not (a dry-run that drops a flag the LIVE run emits is a lying preview)', async () => {
    const wf = compile(await loadTemplate(TEMPLATE_MIN));
    // set ⇒ the cap appears on every realized command, mirroring defaultPiCommand's `opts.thinking` branch.
    expect(dryRunPlan(wf, { promptDir: '/run/_pi', thinking: 'low' })).toContain('--thinking low');
    // absent ⇒ no flag (the LIVE command omits it too) — guards against a spurious default.
    expect(dryRunPlan(wf, { promptDir: '/run/_pi' })).not.toContain('--thinking');
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
// (C) RUN WIRING — the LIVE branch routes through core `runFromTemplate(dir, opts)` (the template-run
// join: loadTemplate → instantiateRun → compile → runWorkflow, INSIDE core). The CLI no longer hand-
// orchestrates those four seams; it just THREADS the resolved options. We assert via an injected
// `runFromTemplate` spy that EVERY required option arrives: args · workspace · the sandbox provider
// (LocalSandboxProvider vs none) · providerName · thinking · model · from/until · runDir.
// template-min is not runnable headless (seed/inject the fixture has no product seed for), so the spy
// stands in for the real run; a live E2E awaits a real template (T6).
// ─────────────────────────────────────────────────────────────────────────────
describe('piflow run — LIVE branch routes through core runFromTemplate, threading every option', () => {
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
    // --sandbox local ⇒ a real LocalSandboxProvider instance is constructed and passed.
    expect(optsSeen?.provider).toBeInstanceOf(LocalSandboxProvider);
    expect((optsSeen?.provider as { kind?: string } | undefined)?.kind).toBe('local');
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
});
