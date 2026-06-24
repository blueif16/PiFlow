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
  loadTemplate as coreLoadTemplate,
  instantiateRun as coreInstantiateRun,
  runFromTemplate as coreRunFromTemplate,
  LocalSandboxProvider,
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
  type RunFromTemplateOpts,
  type SandboxProvider,
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
  /** Library consumer path (holds a spec already). Kept intact for tests/consumers; LIVE uses runFromTemplate. */
  runFromConfig?: (config: ResolvedRunConfig) => Promise<RunResult>;
  /** The LIVE template-run join — loadTemplate → instantiateRun → compile → runWorkflow, INSIDE core. */
  runFromTemplate?: (templateDir: string, opts: RunFromTemplateOpts) => Promise<RunResult>;
  /** Factory for the `--sandbox local` real-exec provider (injectable so a test asserts the instance). */
  makeLocalProvider?: () => SandboxProvider;
  print?: (line: string) => void;
}

/** Which sandbox backend the LIVE run uses. `inmemory` = core default (no `pi`); `local` = real in-place exec. */
export type SandboxChoice = 'inmemory' | 'local';

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
  /** Sandbox backend: `inmemory` (default, core in-memory provider) or `local` (real in-place `pi` exec). */
  sandbox: SandboxChoice;
  /** The pi `--provider` gateway → threaded to the runner as `providerName`. */
  provider?: string;
  /** Reasoning-depth cap → `pi --thinking <v>`. */
  thinking?: string;
  /** Optional model pin → `pi --model <m>`. */
  model?: string;
}

/** Parse the flat `run` argv → `ParsedRunArgs`. First positional = the template dir. */
export function parseRunArgs(argv: string[]): ParsedRunArgs {
  const out: ParsedRunArgs = { templateDir: '', dryRun: false, args: {}, sandbox: 'inmemory' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') out.dryRun = true;
    else if (k === '--run' || k === '--id') out.run = argv[++i];
    else if (k === '--workspace') out.workspace = argv[++i];
    else if (k === '--out' || k === '--out-dir') out.outDir = argv[++i];
    else if (k === '--from') out.from = argv[++i];
    else if (k === '--until') out.until = argv[++i];
    else if (k === '--sandbox') out.sandbox = (argv[++i] as SandboxChoice) ?? 'inmemory';
    else if (k === '--provider') out.provider = argv[++i];
    else if (k === '--thinking') out.thinking = argv[++i];
    else if (k === '--model') out.model = argv[++i];
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
  /** Reasoning-depth cap → `pi --thinking <v>`. Rendered only when set, mirroring the LIVE command. */
  thinking?: string;
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
      const cmd = defaultPiCommand(node, resolved, { promptFile, provider, model: opts.model }, { thinking: opts.thinking });
      lines.push(`    [${id}] ${cmd}${note}`);
    }
  }
  return lines.join('\n');
}

/**
 * Drive a template run. DRY-RUN: loadTemplate → compile → instantiateRun (materialize `${RUN}/.pi`) →
 * print the realized commands, then STOP (no model). LIVE: route through core `runFromTemplate` (the
 * template-run join — loadTemplate → instantiateRun → compile → runWorkflow, INSIDE core), THREADING the
 * resolved options the CLI collected: `args` (`{{arg.*}}` delivery), `workspace` (`{{WORKSPACE}}` root),
 * the sandbox provider (`--sandbox local` ⇒ a real `LocalSandboxProvider`; `inmemory` ⇒ omit, core
 * default), `providerName` (pi `--provider`), `thinking`, `model`, and the from/until resume window.
 * `runFromConfig` stays in the seam for library consumers that already hold a spec.
 */
export async function runTemplate(parsed: ParsedRunArgs, deps: RunDeps = {}): Promise<RunResult | undefined> {
  const loadTemplate = deps.loadTemplate ?? coreLoadTemplate;
  const instantiateRun = deps.instantiateRun ?? coreInstantiateRun;
  const runFromTemplate = deps.runFromTemplate ?? coreRunFromTemplate;
  const makeLocalProvider = deps.makeLocalProvider ?? (() => new LocalSandboxProvider());
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
    print(dryRunPlan(wf, { promptDir: samplePromptDir, provider: parsed.provider ?? 'cp', model: parsed.model, thinking: parsed.thinking }));
    return undefined;
  }

  // ── LIVE: route through the core template-run join, threading every collected option. ──
  // --sandbox local ⇒ the real in-place exec provider; inmemory ⇒ omit (core's in-memory default).
  const provider = parsed.sandbox === 'local' ? makeLocalProvider() : undefined;
  return runFromTemplate(templateDir, {
    runDir: outDir,
    run: parsed.run,
    workspace,
    args: parsed.args,
    from: parsed.from,
    until: parsed.until,
    providerName: parsed.provider,
    thinking: parsed.thinking,
    model: parsed.model,
    ...(provider ? { provider } : {}),
  });
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
