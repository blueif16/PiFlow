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
  applyProfileByName,
  LocalSandboxProvider,
  compile,
  DefaultToolRegistry,
  defaultPiCommand,
  resolveNodeModel,
  loadModelTiers,
  loadModelsIndex,
  nodePromptFile,
  generateRunName,
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
import path from 'node:path';
import { readdirSync } from 'node:fs';

/**
 * List the run-NAME basenames already present under a runs home (the canonical `.piflow/<wf>/runs/`), so
 * auto-naming collision-checks against real on-disk runs. Returns [] when the dir is absent/unreadable (a
 * first run) — never throws. The DEFAULT for `RunDeps.listExistingRuns`; a test injects a fixed set.
 */
export function listExistingRunNames(runsHome: string): string[] {
  try {
    return readdirSync(runsHome, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

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
  /** Mint a memorable run name not in `existing` (default: core `generateRunName`; a test injects a stub). */
  generateName?: (existing: string[]) => string;
  /** List the run-name basenames already present under a runs home (default: read the dir; '' if absent). */
  listExistingRuns?: (runsHome: string) => string[];
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
  /**
   * G4: force a FULL re-run, IGNORING the prior run's `.pi/journal.json` (the content-hash resume).
   * Omit ⇒ the journal decides (reuse provably-unchanged nodes, re-run changed nodes + descendants).
   */
  noResume?: boolean;
  /** Active run PROFILE name → resolved against the template's declared `profiles` (elides nodes before compile). */
  profile?: string;
  args: Record<string, string>;
  /** Sandbox backend: `inmemory` (default, core in-memory provider) or `local` (real in-place `pi` exec). */
  sandbox: SandboxChoice;
  /** The pi `--provider` gateway → threaded to the runner as `providerName`. */
  provider?: string;
  /** Reasoning-depth cap → `pi --thinking <v>`. */
  thinking?: string;
  /** Optional model pin → `pi --model <m>`. */
  model?: string;
  /** Max node processes in-flight at once (the G2 concurrency cap) → runner `maxConcurrent`. Default 8, clamped [1,16]. */
  maxConcurrent?: number;
}

/** Parse the flat `run` argv → `ParsedRunArgs`. First positional = the template dir. */
export function parseRunArgs(argv: string[]): ParsedRunArgs {
  const out: ParsedRunArgs = { templateDir: '', dryRun: false, args: {}, sandbox: 'inmemory' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') out.dryRun = true;
    else if (k === '--no-resume') out.noResume = true;
    else if (k === '--run' || k === '--id') out.run = argv[++i];
    else if (k === '--workspace') out.workspace = argv[++i];
    else if (k === '--out' || k === '--out-dir') out.outDir = argv[++i];
    else if (k === '--from') out.from = argv[++i];
    else if (k === '--until') out.until = argv[++i];
    else if (k === '--profile') out.profile = argv[++i];
    else if (k === '--sandbox') out.sandbox = (argv[++i] as SandboxChoice) ?? 'inmemory';
    else if (k === '--provider') out.provider = argv[++i];
    else if (k === '--thinking') out.thinking = argv[++i];
    else if (k === '--model') out.model = argv[++i];
    else if (k === '--max-concurrent') out.maxConcurrent = Number(argv[++i]);
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
  /** Active profile name → noted in the header (so the plan shows WHICH reduced DAG it reflects). */
  profile?: string;
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
  // G1 — resolve the SAME per-node effective model/provider the runner will (read-only global config).
  const tiers = loadModelTiers();
  const modelsIndex = loadModelsIndex();
  const profileNote = opts.profile ? ` [profile: ${opts.profile}]` : '';
  const lines: string[] = [
    `dry-run plan for "${wf.meta.name}"${profileNote} — ${Object.keys(wf.nodes).length} nodes, ${wf.stages.length} stages (no model invoked)`,
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
      // Resolve THIS node's effective model/provider (precedence in core's model-routing.ts). An
      // unresolvable tier is NOTED in the preview rather than crashing the free dry-run.
      let eff: { model?: string; provider?: string } = { model: opts.model, provider };
      try {
        eff = resolveNodeModel(node, { model: opts.model, provider, tiers, modelsIndex });
      } catch (e) {
        note += `  # NOTE: model routing — ${(e as Error).message}`;
      }
      const cmd = defaultPiCommand(node, resolved, { promptFile, provider: eff.provider ?? provider, model: eff.model }, { thinking: opts.thinking });
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
  const generateName = deps.generateName ?? ((existing: string[]) => generateRunName(existing));
  const listExistingRuns = deps.listExistingRuns ?? listExistingRunNames;
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'));

  const { templateDir } = parsed;
  if (!templateDir) throw new Error('piflow run: a template directory is required (piflow run <templateDir>).');

  const workspace = parsed.workspace ?? process.cwd();
  const tdir = path.resolve(templateDir);
  // The run's CANONICAL HOME is `.piflow/<wf>/runs/<id>` (sdk-canonical-build-plan §D9) — the single place
  // discovery + the global index read runs from. Derive the `runs/` parent from the template's own
  // `.piflow/<wf>/template/` layout so a bare `piflow run <templateDir>` lands under it; a template outside
  // that layout has no canonical home (falls back to `out/<id>`).
  const runsHome = path.basename(tdir) === 'template' ? path.join(path.dirname(tdir), 'runs') : null;
  // The directory a sibling run lands in (and so the collision-check namespace): the canonical `runs/`
  // home, else the parent of an explicit `--out`, else the `out/` fallback. Auto-naming checks against
  // the run dirs ALREADY present there, so a fresh name never overwrites a prior run in EITHER layout.
  const landingHome = runsHome ?? (parsed.outDir ? path.dirname(path.resolve(parsed.outDir)) : path.resolve('out'));
  // RUN NAME: an explicit `--run/--id` ALWAYS wins (identical behavior to before). When omitted, mint a
  // memorable Docker-style `<adjective>-<pie>` name (decoupling the run's identity from any prompt id),
  // COLLISION-CHECKED against the existing run dirs. This replaces the old `?? 'run'` constant fallback
  // that overwrote a prior `out/run` on every unnamed run.
  const runId = parsed.run ?? generateName(listExistingRuns(landingHome));
  const canonicalHome = runsHome ? path.join(runsHome, runId) : null;
  // A resolvable canonical home ALWAYS wins: `--out` must NEVER relocate a canonical run — every
  // observation surface (discovery, the global index, status/watch) reads from the fixed
  // `.piflow/<wf>/runs/<id>/` home, so moving it would split the source of truth. `--out` therefore
  // applies ONLY when there is no canonical home (a loose template outside `.piflow/<wf>/template/`).
  if (canonicalHome && parsed.outDir) {
    console.warn(`piflow run: --out is ignored — the run lands in its canonical home ${canonicalHome}; a canonical run is never relocated (export a copy instead).`);
  }
  const outDir = canonicalHome ?? parsed.outDir ?? `out/${runId}`;
  // PROMPT METADATA: carry an `--arg prompt`/`--arg promptId` as run metadata (run.json `promptId`), so the
  // run is traceable to its prompt WITHOUT the run id BEING the prompt id.
  const promptId = parsed.args.promptId ?? parsed.args.prompt;

  // ── DRY-RUN: build + materialize + print, but invoke NO model. ──
  if (parsed.dryRun) {
    const loaded = await loadTemplate(templateDir);
    // Apply the active profile (elide nodes by the declared predicate) so the dry-run plan reflects the
    // SAME reduced DAG the live run would execute — an unknown name errors loudly here too.
    const spec = applyProfileByName(loaded, parsed.profile);
    const wf = compile(spec);
    await instantiateRun(templateDir, outDir, { workspace });
    // reference the actual realized prompt path the run materialized (engine-owned layout helper).
    const samplePromptDir = nodePromptFile(outDir, '<id>').replace(/\/<id>\/prompt\.md$/, '');
    print(dryRunPlan(wf, { promptDir: samplePromptDir, provider: parsed.provider ?? 'cp', model: parsed.model, thinking: parsed.thinking, profile: parsed.profile }));
    return undefined;
  }

  // ── LIVE: route through the core template-run join, threading every collected option. ──
  // --sandbox local ⇒ the real in-place exec provider; inmemory ⇒ omit (core's in-memory default).
  const provider = parsed.sandbox === 'local' ? makeLocalProvider() : undefined;
  return runFromTemplate(templateDir, {
    runDir: outDir,
    run: runId,
    // The resolved memorable identity (explicit `--run` or the auto-minted name) + the prompt metadata —
    // recorded into run.json by the core writer (status.name / status.promptId).
    name: runId,
    ...(promptId ? { promptId } : {}),
    workspace,
    args: parsed.args,
    from: parsed.from,
    until: parsed.until,
    ...(parsed.noResume ? { noResume: true } : {}),
    profile: parsed.profile,
    providerName: parsed.provider,
    thinking: parsed.thinking,
    model: parsed.model,
    ...(parsed.maxConcurrent !== undefined ? { maxConcurrent: parsed.maxConcurrent } : {}),
    ...(provider ? { provider } : {}),
  });
}

/**
 * The loud top-level verdict for a FINISHED live run: `null` when it succeeded (or is still running),
 * else the multi-line failure report the CLI prints to stderr before exiting non-zero — the blocking
 * node(s) (`error`/`blocked`, e.g. the synthetic `__resume__` preflight) each followed by their `issues`,
 * and a `piflow status` hint. PURE (no process/stderr side effects) so it is unit-tested directly: a
 * blocked resume MUST surface its `__resume__` issue; an `ok` run MUST report nothing.
 */
export function runFailureReport(status: RunResult['status'], runDir: string): string | null {
  if (!status?.done || status.ok !== false) return null;
  const failed = Object.values(status.nodes ?? {}).filter(
    (n) => n.status === 'error' || n.status === 'blocked',
  );
  const lines = [`piflow run: ✗ FAILED — ${failed.length || 'a'} node(s) blocked/errored`];
  for (const n of failed) for (const issue of n.issues ?? []) lines.push(`  ✗ ${n.id}: ${issue}`);
  lines.push(`  → inspect: piflow status ${runDir}`);
  return lines.join('\n');
}

/** `piflow run <templateDir> [--dry-run] [--run <id>] [--arg k=v ...]` — the bin body. */
export async function runRunCli(argv: string[]): Promise<void> {
  const parsed = parseRunArgs(argv);
  if (!parsed.templateDir) {
    process.stderr.write('piflow run: a template directory is required (piflow run <templateDir>)\n');
    process.exitCode = 1;
    return;
  }
  const result = await runTemplate(parsed);
  // SURFACE FAILURE — a LIVE run that ends `done && ok===false` (a blocked resume preflight, or an
  // errored/blocked node) MUST NOT exit 0 in silence: print the blocking node(s) + their issues to stderr
  // and exit non-zero. Without this a blocked `--from` resume wrote an EMPTY log and returned 0 — the only
  // signal was a separate `piflow status`. The status/event archives stay the deep view; this is the loud
  // top-level verdict every CLI consumer (and a backgrounded run's exit code) can rely on. (dry-run → no result.)
  // Use the RESULT's resolved `outDir` for the status hint — it is the real run dir, including any
  // auto-generated `<adjective>-<pie>` name (which the caller can't reconstruct from `parsed.run`).
  const report = result?.status ? runFailureReport(result.status, result.outDir) : null;
  if (report) {
    process.stderr.write(report + '\n');
    process.exitCode = 1;
  }
}
