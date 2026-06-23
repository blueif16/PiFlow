// `piflow run <templateDir> [--dry-run] [--run <id>] [--arg k=v ...]` — DRIVE a template run.
//
// The orchestrator over the T5 seam: it RESOLVES the env+args (`loadConfig`), LOADS + compiles the
// authored template into a `WorkflowSpec` (`loadTemplate` — runs the §8 static gate), MATERIALIZES a
// runnable `${RUN}/.pi` thread from it (`instantiateRun`), then RUNS it (`runFromConfig`, handing the
// loaded spec as the consumer-injected `workflowSpec` bridge — a TEMPLATE run gets its spec straight
// from `loadTemplate`, so there is NO separate bridge to inject). It REIMPLEMENTS no run logic; every
// step is a core call.
//
//   --dry-run  builds + materializes the run AND prints the realized per-node `pi` command(s), but
//              STOPS before `runFromConfig` — no model is ever spawned (free).
//
// The four seam functions are INJECTABLE (`RunDeps`) so a test drives the wiring with spies and a
// deterministic in-memory spec; the defaults are the real @piflow/core calls.

import {
  loadConfig as coreLoadConfig,
  loadTemplate as coreLoadTemplate,
  instantiateRun as coreInstantiateRun,
  runFromConfig as coreRunFromConfig,
  compile,
  DefaultToolRegistry,
  defaultPiCommand,
  nodePromptFile,
  type Workflow,
  type WorkflowSpec,
  type LoadConfigInput,
  type ResolvedRunOpts,
  type InstantiateRunOpts,
  type InstantiateRunResult,
  type ResolvedRunConfig,
  type RunResult,
} from '@piflow/core';

/** The injectable seam — defaults are the real core calls; a test passes spies + an in-memory spec. */
export interface RunDeps {
  loadConfig?: (input: LoadConfigInput) => ResolvedRunOpts;
  loadTemplate?: (dir: string) => Promise<WorkflowSpec>;
  instantiateRun?: (
    templateDir: string,
    runDir: string,
    opts: InstantiateRunOpts,
  ) => Promise<InstantiateRunResult>;
  runFromConfig?: (config: ResolvedRunConfig) => Promise<RunResult>;
  print?: (line: string) => void;
}

/** The parsed `run` argv. `args` carries the repeated `--arg k=v` pairs (and the run id, mirrored in). */
export interface ParsedRunArgs {
  templateDir: string;
  dryRun: boolean;
  run?: string;
  /** The read-only `{{WORKSPACE}}` root (skills/templates/registry). Default cwd. */
  workspace?: string;
  /** Host run dir (= `{{RUN}}`). Default `out/<run>`. */
  outDir?: string;
  from?: string;
  until?: string;
  args: Record<string, string>;
}

/** Parse the flat `run` argv → `ParsedRunArgs`. First positional = the template dir. */
export function parseRunArgs(argv: string[]): ParsedRunArgs {
  const out: ParsedRunArgs = { templateDir: '', dryRun: false, args: {} };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') out.dryRun = true;
    else if (k === '--run' || k === '--id') out.run = argv[++i];
    else if (k === '--workspace') out.workspace = argv[++i];
    else if (k === '--out' || k === '--out-dir') out.outDir = argv[++i];
    else if (k === '--from') out.from = argv[++i];
    else if (k === '--until') out.until = argv[++i];
    else if (k === '--arg') {
      const kv = argv[++i] ?? '';
      const eq = kv.indexOf('='); // only the FIRST '=' splits k from v (values may contain '=').
      if (eq > 0) out.args[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (!k.startsWith('-') && !out.templateDir) out.templateDir = k;
  }
  // mirror the instance id into args so `loadConfig` (which reads args.run) sees it.
  if (out.run && out.args.run === undefined) out.args.run = out.run;
  return out;
}

/** Options for `dryRunPlan`. `promptDir` is the in-sandbox dir the realized prompt is referenced from. */
export interface DryRunPlanOpts {
  /** Where the staged prompt lives (referenced as `@<file>`). Default a placeholder `_pi` dir. */
  promptDir?: string;
  /** Provider name the command builder stamps (`pi --provider`). Default 'cp'. */
  provider?: string;
  /** Model pin, if any. */
  model?: string;
}

/**
 * Render the realized per-node `pi` command(s) for a compiled workflow — the dry-run preview. PURE: it
 * resolves each node's toolset (the same `DefaultToolRegistry` the runner uses) and builds the headless
 * command via `defaultPiCommand`, but spawns NOTHING. A node whose declared tools are not in the builtin
 * catalog (a template that binds runtime-only tools like `submit_result`) still renders — its unresolved
 * tools are NOTED rather than crashing the free preview.
 */
export function dryRunPlan(wf: Workflow, opts: DryRunPlanOpts = {}): string {
  const registry = new DefaultToolRegistry();
  const promptDir = opts.promptDir ?? '_pi';
  const provider = opts.provider ?? 'cp';
  const lines: string[] = [
    `dry-run plan for "${wf.meta.name}" — ${Object.keys(wf.nodes).length} nodes, ${wf.stages.length} stages (no model invoked)`,
  ];
  for (const stage of wf.stages) {
    const tag = stage.parallel ? ' (parallel lane)' : '';
    lines.push(`  stage ${stage.index}/${wf.stages.length}${tag}:`);
    for (const id of stage.nodeIds) {
      const node = wf.nodes[id];
      const promptFile = `${promptDir}/${id}/prompt.md`;
      let resolved;
      let note = '';
      try {
        resolved = registry.resolve(node.tools ?? {});
      } catch (e) {
        // unresolved tools (catalog miss) — render a minimal command + flag, never crash the preview.
        resolved = { piTools: [] as string[] };
        note = `  # NOTE: tools unresolved at preview (${(e as Error).message})`;
      }
      const cmd = defaultPiCommand(node, resolved, { promptFile, provider, model: opts.model });
      lines.push(`    [${id}] ${cmd}${note}`);
    }
  }
  return lines.join('\n');
}

/**
 * Drive a template run. DRY-RUN: loadTemplate → compile → instantiateRun (materialize `${RUN}/.pi`) →
 * print the realized commands, then STOP (no model). LIVE: loadConfig → loadTemplate → instantiateRun →
 * runFromConfig (the loaded spec is the consumer-injected `workflowSpec` — a template run needs no
 * separate bridge).
 */
export async function runTemplate(parsed: ParsedRunArgs, deps: RunDeps = {}): Promise<RunResult | undefined> {
  const loadConfig = deps.loadConfig ?? coreLoadConfig;
  const loadTemplate = deps.loadTemplate ?? coreLoadTemplate;
  const instantiateRun = deps.instantiateRun ?? coreInstantiateRun;
  const runFromConfig = deps.runFromConfig ?? coreRunFromConfig;
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'));

  const { templateDir } = parsed;
  if (!templateDir) throw new Error('piflow run: a template directory is required (piflow run <templateDir>).');

  const workspace = parsed.workspace ?? process.cwd();
  // outDir defaults to out/<run> (mirrors runWorkflow's default); a dry-run still needs a concrete dir to
  // materialize ${RUN}/.pi into.
  const runId = parsed.run ?? 'run';
  const outDir = parsed.outDir ?? `out/${runId}`;

  // ── DRY-RUN: build + materialize + print, but invoke NO model. ──
  if (parsed.dryRun) {
    const spec = await loadTemplate(templateDir);
    const wf = compile(spec);
    await instantiateRun(templateDir, outDir, { workspace });
    // reference the actual realized prompt path the run materialized (engine-owned layout helper).
    const samplePromptDir = nodePromptFile(outDir, '<id>').replace(/\/<id>\/prompt\.md$/, '');
    print(dryRunPlan(wf, { promptDir: samplePromptDir, provider: 'cp' }));
    return undefined;
  }

  // ── LIVE: resolve env+args → load+materialize → run. ──
  const config = loadConfig({ args: { run: parsed.run, outDir, from: parsed.from, until: parsed.until } });
  const spec = await loadTemplate(templateDir);
  await instantiateRun(templateDir, outDir, { workspace });
  return runFromConfig({ workflowSpec: spec, ...config, outDir });
}

/** `piflow run <templateDir> [--dry-run] [--run <id>] [--arg k=v ...]` — the bin body. */
export async function runRunCli(argv: string[]): Promise<void> {
  const parsed = parseRunArgs(argv);
  if (!parsed.templateDir) {
    process.stderr.write('piflow run: a template directory is required (piflow run <templateDir>)\n');
    process.exitCode = 1;
    return;
  }
  await runTemplate(parsed);
}
