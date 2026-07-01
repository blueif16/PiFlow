// `piflowctl run <templateDir> [--dry-run] [--run <id>] [--arg k=v ...]` — DRIVE a template run.
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
  defaultSecretResolver,
  compile,
  seededRegistry,
  SUBMIT_RESULT_TOOL,
  dispatchCommand,
  effectiveModel,
  loadModelTiers,
  loadModelsIndex,
  expandFusion,
  expandSubworkflow,
  loadFusionConfig,
  nodePromptFile,
  generateRunName,
  writeStatus,
  nowISO,
  type Workflow,
  type WorkflowSpec,
  type RunStatus,
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
import os from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolveRemote, startRemoteRun, streamUrlFor, type StartRemoteResult, type RemoteOpts } from './remote.js';
import type { ContextEntry } from './context-store.js';

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
  /**
   * Factory for the `--sandbox local` real-exec provider (injectable so a test asserts the instance).
   * `dangerous:true` ⇒ the `danger-full-access` bypass (read-scope jail OFF); default ⇒ secure-by-default.
   */
  makeLocalProvider?: (opts?: { dangerous?: boolean }) => SandboxProvider;
  /**
   * Factory for the `--sandbox daytona` cloud provider (injectable so a test asserts the instance WITHOUT a
   * real Daytona client/VM). The default DYNAMICALLY `import('@piflow/daytona')`s the CHOOSE-TO-INSTALL
   * extension and calls its `createDaytonaProvider({ snapshot|image, apiKey: DAYTONA_API_KEY, stageHome })`;
   * on an absent package it throws a clear `npm i @piflow/daytona` message (async because the import is lazy).
   */
  makeDaytonaProvider?: (opts: {
    image?: string;
    snapshot?: string;
    apiKey?: string;
    stageHome?: Record<string, string>;
  }) => Promise<SandboxProvider>;
  /**
   * Factory for the `--sandbox e2b` cloud provider (injectable so a test asserts the instance WITHOUT a real
   * E2B client/sandbox). The default DYNAMICALLY `import('@piflow/e2b')`s the CHOOSE-TO-INSTALL extension and
   * calls its `createE2bProvider({ apiKey: E2B_API_KEY, template: E2B_TEMPLATE, stageHome })`; on an absent
   * package it throws a clear `npm i @piflow/e2b` message (async because the import is lazy).
   */
  makeE2bProvider?: (opts: {
    template?: string;
    apiKey?: string;
    stageHome?: Record<string, string>;
  }) => Promise<SandboxProvider>;
  /**
   * Factory for the `--sandbox docker` LOCAL container provider (injectable so a test asserts the instance
   * WITHOUT a real Docker daemon). The default DYNAMICALLY `import('@piflow/docker')`s the CHOOSE-TO-INSTALL
   * extension and calls its `createDockerProvider({ image: DOCKER_IMAGE, stageHome })`; on an absent package
   * it throws a clear `npm i @piflow/docker` message (async because the import is lazy).
   */
  makeDockerProvider?: (opts: {
    image?: string;
    stageHome?: Record<string, string>;
  }) => Promise<SandboxProvider>;
  /** Mint a memorable run name not in `existing` (default: core `generateRunName`; a test injects a stub). */
  generateName?: (existing: string[]) => string;
  /** List the run-name basenames already present under a runs home (default: read the dir; '' if absent). */
  listExistingRuns?: (runsHome: string) => string[];
  print?: (line: string) => void;
}

/**
 * Which sandbox backend the LIVE run uses:
 *   - `inmemory` (default) = core in-memory provider, NO `pi` (structural/dry).
 *   - `local` = real in-place `pi` exec, SECURE BY DEFAULT — each node's reads are jailed to its declared
 *     `readScope` + toolchain (kernel-enforced via seatbelt on darwin; unsandboxed-with-a-warning until the
 *     Linux bwrap backend lands).
 *   - `danger-full-access` = real in-place `pi` exec with the read-scope jail OFF (the agent can read the
 *     whole filesystem) — the loud, explicit escape hatch.
 *   - `daytona` = real `pi` exec inside a remote Daytona CLOUD VM (one VM per run, nodes subtree-namespaced).
 *     Reads `DAYTONA_API_KEY`/`DAYTONA_IMAGE` from env; the pi gateway credential crosses into the VM via the
 *     cloud allowlist (the var derived from `--provider`, or `--cloud-secret NAME`).
 *   - `e2b` = real `pi` exec inside a remote E2B CLOUD sandbox (one sandbox per run, nodes subtree-namespaced),
 *     with OPEN egress by default (the unblock for heterogeneous/remote MCP). Requires the CHOOSE-TO-INSTALL
 *     extension `@piflow/e2b` (`npm i @piflow/e2b`); the CLI loads it DYNAMICALLY only on `--sandbox e2b`. Reads
 *     `E2B_API_KEY`/`E2B_TEMPLATE` from env; the pi gateway credential crosses in exactly like daytona.
 *   - `docker` = real `pi` exec inside a LOCAL Docker container (one container per run, nodes subtree-namespaced)
 *     — the OFFLINE, FREE mirror of the cloud path: the SAME pi node-runtime image, credential injection, and
 *     tool binding as daytona/e2b, run on the host daemon instead of a cloud VM (NOT a stronger isolation tier
 *     than `local` seatbelt). Requires the CHOOSE-TO-INSTALL extension `@piflow/docker` (`npm i @piflow/docker`);
 *     loaded DYNAMICALLY only on `--sandbox docker`. The pi node-runtime image is AUTO-BUILT on first use (no
 *     setup); `DOCKER_IMAGE` overrides with a pre-built tag. The pi gateway credential crosses in exactly like
 *     the cloud backends.
 */
export type SandboxChoice = 'inmemory' | 'local' | 'danger-full-access' | 'daytona' | 'e2b' | 'docker';

/** The accepted `--sandbox` values — a typo (e.g. `seatbelt`) must error loudly, not silently degrade to inmemory. */
export const SANDBOX_CHOICES: readonly SandboxChoice[] = ['inmemory', 'local', 'danger-full-access', 'daytona', 'e2b', 'docker'];

/** The accepted `--executor` values — a typo must error loudly (never silently pick the wrong agent binary). */
export const EXECUTOR_CHOICES: readonly ['pi', 'claude-code'] = ['pi', 'claude-code'];

/** Validate + narrow a `--executor` value; throws loudly on a typo (so a mistyped executor never silently degrades). */
function parseExecutorValue(v: string, ctxLabel: string): 'pi' | 'claude-code' {
  if ((EXECUTOR_CHOICES as readonly string[]).includes(v)) return v as 'pi' | 'claude-code';
  throw new Error(`piflowctl run: unknown --executor ${ctxLabel}"${v}" (expected one of ${EXECUTOR_CHOICES.join(', ')}).`);
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
  /**
   * G4: force a FULL re-run, IGNORING the prior run's `.pi/journal.json` (the content-hash resume).
   * Omit ⇒ the journal decides (reuse provably-unchanged nodes, re-run changed nodes + descendants).
   */
  noResume?: boolean;
  /** Active run PROFILE name → resolved against the template's declared `profiles` (elides nodes before compile). */
  profile?: string;
  args: Record<string, string>;
  /** Sandbox backend: `inmemory` (default) · `local` (real in-place, read-scope-jailed) · `danger-full-access`. */
  sandbox: SandboxChoice;
  /** The pi `--provider` gateway → threaded to the runner as `providerName`. */
  provider?: string;
  /**
   * (M1 · cloud) Explicit provider-credential env var NAME to forward into a cloud VM (e.g. `NEBIUS_API_KEY`),
   * overriding the name derived from `--provider`. Only consulted on `--sandbox daytona`.
   */
  cloudSecret?: string;
  /** Reasoning-depth cap → `pi --thinking <v>`. */
  thinking?: string;
  /** Optional model pin → `pi --model <m>`. */
  model?: string;
  /**
   * Run-level EXECUTOR default — `--executor pi|claude-code` (no `=`): pick the executor for EVERY node at
   * run start WITHOUT editing the template. A per-node `--executor <nodeId>=…` entry wins over this.
   */
  executor?: 'pi' | 'claude-code';
  /**
   * PER-NODE executor overrides — `--executor <nodeId>=pi|claude-code` (repeatable): pick the executor for
   * SPECIFIC nodes at run start. A per-node entry wins over the run-level `executor` default and the node's
   * authored `executor`.
   */
  executorOverride?: Record<string, 'pi' | 'claude-code'>;
  /** Max node processes in-flight at once (the G2 concurrency cap) → runner `maxConcurrent`. Default 8, clamped [1,16]. */
  maxConcurrent?: number;
  /**
   * (G7) UNATTENDED mode — threads the (G5) `checkpointReply: 'default'` so any human checkpoint takes its
   * declared default instead of parking forever (a backgrounded run never hangs). The run itself is already
   * durable/detached (it survives the controller dying); pair `--detach` with `&` or a background runner to
   * detach the PROCESS. Omit ⇒ ATTENDED: a checkpoint parks for the courier reply.
   */
  detach?: boolean;
  /**
   * (P7) `--context <name>` — pick the control plane to run against. Omit/`local` ⇒ run in-process on THIS
   * host (the unchanged local path). A REMOTE context ⇒ POST `/api/runs/start` to that serve, which launches
   * the run there; the CLI prints the returned run id + stream URL (observe it via the same remote context).
   */
  context?: string;
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
    else if (k === '--cloud-secret') out.cloudSecret = argv[++i];
    else if (k === '--thinking') out.thinking = argv[++i];
    else if (k === '--model') out.model = argv[++i];
    else if (k === '--executor') {
      // TWO forms, both repeatable: `--executor claude-code` (run-level default) and
      // `--executor <nodeId>=claude-code` (per-node override, wins over the default). A per-node form has an
      // '=' AFTER the first char (a run-level value never does); validate both loudly.
      const raw = argv[++i] ?? '';
      const eq = raw.indexOf('=');
      if (eq > 0) {
        const nodeId = raw.slice(0, eq);
        (out.executorOverride ??= {})[nodeId] = parseExecutorValue(raw.slice(eq + 1), `for node "${nodeId}": `);
      } else {
        out.executor = parseExecutorValue(raw, '');
      }
    }
    else if (k === '--max-concurrent') out.maxConcurrent = Number(argv[++i]);
    else if (k === '--context') out.context = argv[++i];
    else if (k === '--detach' || k === '--unattended') out.detach = true;
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
  /** Run-level executor default (mirrors the LIVE run-start override) — pick pi vs claude-code for every node. */
  executor?: 'pi' | 'claude-code';
  /** Per-node executor overrides (keyed by node id) — win over `executor`, mirroring the LIVE run. */
  executorOverride?: Record<string, 'pi' | 'claude-code'>;
}

/**
 * Render the realized per-node `pi` command(s) for a compiled workflow — the dry-run preview. PURE: it
 * resolves each node's toolset (the SEEDED registry the canonical run path now assembles via
 * `assembleRunTools`) and builds the headless command via `dispatchCommand` (executor-aware), but spawns NOTHING. A node
 * whose declared tools are not in the catalog still renders — its unresolved tools are NOTED rather than
 * crashing the free preview. (G11) Seeding here stops the free preview from falsely reporting `oc.*`/`mcp.*`
 * as unresolved.
 */
export function dryRunPlan(wf: Workflow, opts: DryRunPlanOpts = {}): string {
  // `seededRegistry()` alone DROPS the first-party `submit_result` (catalog.ts:58), so re-add it — the SAME
  // superset `assembleRunTools` builds — else a node declaring `submit_result` falsely reads UNRESOLVED.
  const registry = seededRegistry([SUBMIT_RESULT_TOOL]);
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
      // Run-start executor override (mirrors the LIVE resolveExecutor precedence: per-node → run-level →
      // authored) so the free preview shows the SAME agent binary the live run will spawn — never lie.
      const effExec = opts.executorOverride?.[id] ?? opts.executor ?? node.executor;
      const eNode = effExec === node.executor ? node : { ...node, executor: effExec };
      // Resolve THIS node's effective model/provider (precedence in core's model-routing.ts, executor-aware:
      // a claude-code node resolves via the parallel `claude` tier block). An unresolvable tier is NOTED in
      // the preview rather than crashing the free dry-run.
      let eff: { model?: string; provider?: string } = { model: opts.model, provider };
      try {
        eff = effectiveModel(eNode, { model: opts.model, provider, tiers, modelsIndex });
      } catch (e) {
        note += `  # NOTE: model routing — ${(e as Error).message}`;
      }
      // dispatchCommand routes pi vs claude-code off `eNode.executor` (the same seam the runner uses).
      const cmd = dispatchCommand(eNode, resolved, { promptFile, provider: eff.provider ?? provider, model: eff.model }, { thinking: opts.thinking });
      lines.push(`    [${id}] ${cmd}${note}`);
    }
  }
  return lines.join('\n');
}

/**
 * (M1 · cloud) Derive the provider/gateway credential env var NAME pi reads for a given `--provider`, so a
 * cloud VM gets a model credential forwarded (the VM does NOT inherit host env, and the pi command stamps no
 * key). Maps the common providers to their well-known `*_API_KEY` (pi's `env-api-keys.ts` vocabulary). A
 * custom/unknown gateway returns `undefined` — the FALLBACK only: for a custom gateway the cred var is read
 * authoritatively from its `~/.pi/agent/models.json` entry's `$VAR` apiKey ref (`parsePiProvider`); this map
 * is the built-in-provider default when no entry exists. An explicit `--cloud-secret` overrides both.
 */
/**
 * (M1c) The DEFAULT Daytona snapshot `--sandbox daytona` boots from when neither `DAYTONA_SNAPSHOT` nor
 * `DAYTONA_IMAGE` is set — the promoted `piflow-node-runtime` image (`deploy/daytona/promote-snapshot.mjs`
 * registers this exact name). A snapshot is permanent + instant; making it the default means `--sandbox
 * daytona` needs ZERO image config. Keep this string in sync with the promote script's `SNAPSHOT`.
 */
export const DEFAULT_DAYTONA_SNAPSHOT = 'piflow-node-runtime-0-80-2';

export function providerCredVar(provider?: string): string | undefined {
  const map: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    cp: 'ANTHROPIC_API_KEY', // pi's Claude-proxy gateway reads the Anthropic key
    deepseek: 'DEEPSEEK_API_KEY',
    nebius: 'NEBIUS_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
  };
  return provider ? map[provider] : undefined;
}

/**
 * (M1b) Scope a pi `~/.pi/agent/models.json` to the SELECTED provider and extract what a cloud VM needs: the
 * minimal `{providers:{[name]:entry}}` config to STAGE (so a CUSTOM gateway's `baseUrl`/`api`/`models` resolve
 * in the VM — the image bakes none), and the `$VAR`/`${VAR}` env-var name(s) the entry references (pi's value
 * syntax for `apiKey`/`headers`) = the cloud cred allowlist. The official shape is `docs/models.md`
 * (`{ providers: { <name>: { baseUrl, api, apiKey: "$VAR", models:[…] } } }`). A BUILT-IN provider (no entry)
 * returns `{ credVars: [] }` with NO config — it needs neither. Pure + total: a malformed/empty file or an
 * absent provider yields `{ credVars: [] }`, never a throw. Staging carries only `$VAR` REFERENCES, never the
 * resolved secret (that crosses via the runner's cloud cred allowlist).
 */
export function parsePiProvider(modelsJson: string, provider?: string): { config?: string; credVars: string[] } {
  if (!provider) return { credVars: [] };
  let entry: unknown;
  try {
    entry = (JSON.parse(modelsJson) as { providers?: Record<string, unknown> })?.providers?.[provider];
  } catch {
    return { credVars: [] };
  }
  if (!entry || typeof entry !== 'object') return { credVars: [] };
  const ref = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  const names = new Set<string>();
  const scan = (v: unknown): void => {
    if (typeof v === 'string') for (const m of v.matchAll(ref)) names.add(m[1] ?? m[2]);
    else if (Array.isArray(v)) for (const x of v) scan(x);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) scan(x);
  };
  scan(entry);
  return { config: JSON.stringify({ providers: { [provider]: entry } }), credVars: [...names] };
}

/** (M1b) Best-effort load of the host's `~/.pi/agent/models.json`, scoped to `provider`. Never throws. */
function loadPiProviderConfig(provider?: string): { config?: string; credVars: string[] } {
  try {
    return parsePiProvider(readFileSync(path.join(os.homedir(), '.pi', 'agent', 'models.json'), 'utf8'), provider);
  } catch {
    return { credVars: [] };
  }
}

/**
 * Drive a template run. DRY-RUN: loadTemplate → compile → instantiateRun (materialize `${RUN}/.pi`) →
 * print the realized commands, then STOP (no model). LIVE: route through core `runFromTemplate` (the
 * template-run join — loadTemplate → instantiateRun → compile → runWorkflow, INSIDE core), THREADING the
 * resolved options the CLI collected: `args` (`{{arg.*}}` delivery), `workspace` (`{{WORKSPACE}}` root),
 * the sandbox provider (`--sandbox local` ⇒ a real `LocalSandboxProvider`, read-scope-jailed by default;
 * `danger-full-access` ⇒ the jail OFF; `inmemory` ⇒ omit, core default), `providerName` (pi `--provider`),
 * `thinking`, `model`, and the from/until resume window.
 * `runFromConfig` stays in the seam for library consumers that already hold a spec.
 */
export async function runTemplate(parsed: ParsedRunArgs, deps: RunDeps = {}): Promise<RunResult | undefined> {
  const loadTemplate = deps.loadTemplate ?? coreLoadTemplate;
  const instantiateRun = deps.instantiateRun ?? coreInstantiateRun;
  const runFromTemplate = deps.runFromTemplate ?? coreRunFromTemplate;
  const makeLocalProvider =
    deps.makeLocalProvider ?? ((o?: { dangerous?: boolean }) => new LocalSandboxProvider({ enforceReadScope: !o?.dangerous }));
  // The Daytona backend is a CHOOSE-TO-INSTALL extension (`@piflow/daytona`), NOT a core dependency — so it
  // is loaded with a DYNAMIC import only on `--sandbox daytona`, and an absent package becomes a clear,
  // actionable install message rather than a raw module-not-found at CLI startup.
  const makeDaytonaProvider =
    deps.makeDaytonaProvider ??
    (async (o: { image?: string; snapshot?: string; apiKey?: string; stageHome?: Record<string, string> }) => {
      let mod: typeof import('@piflow/daytona');
      try {
        mod = await import('@piflow/daytona');
      } catch {
        throw new Error('--sandbox daytona requires the @piflow/daytona extension — run: npm i @piflow/daytona');
      }
      return mod.createDaytonaProvider(o);
    });
  // The E2B backend is a CHOOSE-TO-INSTALL extension (`@piflow/e2b`), NOT a core dependency — so it is
  // loaded with a DYNAMIC import only on `--sandbox e2b`, and an absent package becomes a clear, actionable
  // install message rather than a raw module-not-found at CLI startup.
  const makeE2bProvider =
    deps.makeE2bProvider ??
    (async (o: { template?: string; apiKey?: string; stageHome?: Record<string, string> }) => {
      let mod: typeof import('@piflow/e2b');
      try {
        mod = await import('@piflow/e2b');
      } catch {
        throw new Error('--sandbox e2b requires the @piflow/e2b extension — run: npm i @piflow/e2b');
      }
      return mod.createE2bProvider(o);
    });
  // The local-Docker backend is a CHOOSE-TO-INSTALL extension (`@piflow/docker`), NOT a core dependency —
  // loaded with a DYNAMIC import only on `--sandbox docker`, an absent package becoming a clear install message.
  const makeDockerProvider =
    deps.makeDockerProvider ??
    (async (o: { image?: string; stageHome?: Record<string, string> }) => {
      let mod: typeof import('@piflow/docker');
      try {
        mod = await import('@piflow/docker');
      } catch {
        throw new Error('--sandbox docker requires the @piflow/docker extension — run: npm i @piflow/docker');
      }
      return mod.createDockerProvider(o);
    });
  const generateName = deps.generateName ?? ((existing: string[]) => generateRunName(existing));
  const listExistingRuns = deps.listExistingRuns ?? listExistingRunNames;
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'));

  const { templateDir } = parsed;
  if (!templateDir) throw new Error('piflowctl run: a template directory is required (piflowctl run <templateDir>).');

  const workspace = parsed.workspace ?? process.cwd();
  const tdir = path.resolve(templateDir);
  // The run's CANONICAL HOME is `.piflow/<wf>/runs/<id>` (sdk-canonical-build-plan §D9) — the single place
  // discovery + the global index read runs from. Derive the `runs/` parent from the template's own
  // `.piflow/<wf>/template/` layout so a bare `piflowctl run <templateDir>` lands under it; a template outside
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
    console.warn(`piflowctl run: --out is ignored — the run lands in its canonical home ${canonicalHome}; a canonical run is never relocated (export a copy instead).`);
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
    let spec = applyProfileByName(loaded, parsed.profile);
    // (G9) Inline subworkflow-activated nodes as sub-DAGs — AFTER profile, BEFORE fusion + compile —
    // mirroring core's runFromTemplate (entry.ts) so the dry-run preview shows the SAME expanded DAG the
    // live run executes (the child template loads through the same fail-closed §8 gate). Never lie.
    spec = await expandSubworkflow(spec, { loadChild: (ref) => coreLoadTemplate(path.resolve(templateDir, ref)) });
    // (Phase 2) Expand fusion nodes (siblings + judge) — AFTER profile, BEFORE compile — so the dry-run
    // preview shows the SAME expanded DAG the live run (core's runFromTemplate) executes. Never lie.
    spec = expandFusion(spec, { defaults: loadFusionConfig().defaults, tiers: loadModelTiers() });
    const wf = compile(spec);
    await instantiateRun(templateDir, outDir, { workspace });
    // Make the dry-run plan VIEWABLE, not just printable: persist the resolved DAG + a `dry`-status run.json
    // so discovery + every observe surface (GUI/TUI/`status`) render the SAME expanded graph the plan prints
    // — WITHOUT invoking a model. `.pi/workflow.json` is the authoritative topology `buildRunView` draws from
    // (mirrors the live runner's write); each node carries the reserved `dry` status (status.ts) + `done:true`
    // so a surface labels it "planned, not run" and never polls it. This is what lets a free dry-run seed a
    // GUI-openable demo (and the per-node fusion toggle then re-expands the DAG live on top of it).
    await writeFile(
      path.join(outDir, '.pi', 'workflow.json'),
      JSON.stringify({ meta: wf.meta, profile: parsed.profile ?? null, stages: wf.stages, edges: wf.edges }, null, 2) + '\n',
    );
    const ts = nowISO();
    const dryStatus: RunStatus = {
      run: runId,
      name: runId,
      ...(promptId ? { promptId } : {}),
      source: wf.meta.name,
      profile: parsed.profile ?? null,
      provider: parsed.provider ?? 'cp',
      model: parsed.model ?? null,
      startedAt: ts,
      updatedAt: ts,
      done: true,
      ok: null,
      durationMs: null,
      stage: null,
      totals: null,
      nodes: Object.fromEntries(
        Object.values(wf.nodes).map((n) => [
          n.id,
          { id: n.id, label: n.label, ...(n.agentType ? { agentType: n.agentType } : {}), status: 'dry' as const, artifacts: [], issues: [] },
        ]),
      ),
    };
    await writeStatus(outDir, dryStatus);
    // reference the actual realized prompt path the run materialized (engine-owned layout helper).
    const samplePromptDir = nodePromptFile(outDir, '<id>').replace(/\/<id>\/prompt\.md$/, '');
    print(dryRunPlan(wf, { promptDir: samplePromptDir, provider: parsed.provider ?? 'cp', model: parsed.model, thinking: parsed.thinking, profile: parsed.profile, executor: parsed.executor, executorOverride: parsed.executorOverride }));
    print(`piflowctl run: dry-run materialized a viewable plan at ${outDir} (open it: piflowctl gui / piflowctl status ${outDir}). Nodes are status "dry" — no model ran.`);
    return undefined;
  }

  // ── LIVE: route through the core template-run join, threading every collected option. ──
  // Reject a typo'd backend loudly rather than silently degrading to `inmemory` (= no model, a confusing
  // no-op for someone who asked for isolation).
  if (!SANDBOX_CHOICES.includes(parsed.sandbox)) {
    throw new Error(
      `piflowctl run: unknown --sandbox "${parsed.sandbox}" (expected one of ${SANDBOX_CHOICES.join(', ')}).`,
    );
  }
  // Provider selection. `inmemory` ⇒ omit (core's in-memory default, no model). `local` ⇒ the real
  // in-place exec provider, SECURE BY DEFAULT (read-scope jail on). `danger-full-access` ⇒ the same
  // provider with the jail OFF — surfaced loudly so the bypass is never silent.
  let provider: SandboxProvider | undefined;
  // (M1) The cloud provider-credential allowlist: the env var(s) the pi agent needs IN the VM (the VM does
  // NOT inherit host env). Set ONLY on the cloud (daytona) branch — local/inmemory leave it undefined so the
  // gateway key never needlessly enters a (non-existent) cloud allowlist. The default secretResolver reads
  // it host-side from process.env; a host can swap in a scoped-token broker.
  let cloudSecrets: string[] | undefined;
  if (parsed.sandbox === 'local') {
    provider = makeLocalProvider();
    print(
      process.platform === 'darwin'
        ? 'piflowctl run: read-scope isolation ON — each PI node is jailed to its declared readScope (seatbelt, kernel-enforced). NOTE: programmatic nodes run UNSANDBOXED on the host (host spawnSync) — their readScope is ignored.'
        : `piflowctl run: ⚠ read-scope isolation is NOT enforced on ${process.platform} yet (Linux bwrap backend unwired) — running UNSANDBOXED. Run on macOS for enforcement.`,
    );
  } else if (parsed.sandbox === 'danger-full-access') {
    provider = makeLocalProvider({ dangerous: true });
    print('piflowctl run: ⚠ DANGER — read-scope isolation BYPASSED (--sandbox danger-full-access): the agent can read your entire filesystem.');
  } else if (parsed.sandbox === 'daytona') {
    // Real pi exec inside a remote Daytona CLOUD VM. The image + API key come from the environment
    // (DAYTONA_IMAGE / DAYTONA_API_KEY); an absent key makes the real client throw at construction (loud).
    // (M1b) A CUSTOM gateway (nebius/mmgw/…) lives ONLY in the host's ~/.pi/agent/models.json; stage its
    // entry into the VM so pi resolves --provider there (the image bakes none), and read the cred var(s)
    // from that entry's $VAR apiKey refs (authoritative). A built-in provider has no entry → no staging.
    const pi = loadPiProviderConfig(parsed.provider);
    const stageHome = pi.config ? { '.pi/agent/models.json': pi.config } : undefined;
    // (M1c) Boot from the promoted SNAPSHOT by default (zero config). A raw `DAYTONA_IMAGE` ref overrides
    // (and suppresses the snapshot); `DAYTONA_SNAPSHOT` picks a different snapshot name.
    const rawImage = process.env.DAYTONA_IMAGE;
    const snapshot = process.env.DAYTONA_SNAPSHOT ?? (rawImage ? undefined : DEFAULT_DAYTONA_SNAPSHOT);
    provider = await makeDaytonaProvider({
      ...(rawImage ? { image: rawImage } : {}),
      ...(snapshot ? { snapshot } : {}),
      apiKey: process.env.DAYTONA_API_KEY,
      ...(stageHome ? { stageHome } : {}),
    });
    // Forward the pi gateway credential into the VM: an explicit --cloud-secret wins, else the entry's $VAR(s),
    // else the well-known var for a built-in provider. The runner resolves each through the SAME
    // SecretResolver+allowlist as MCP creds (the raw value never leaves the resolver seam).
    const fallback = providerCredVar(parsed.provider);
    cloudSecrets = parsed.cloudSecret
      ? [parsed.cloudSecret]
      : pi.credVars.length
        ? pi.credVars
        : fallback
          ? [fallback]
          : [];
    const credList = cloudSecrets.join(', ');
    const bootFrom = rawImage ? `image ${rawImage}` : `snapshot ${snapshot}`;
    print(`piflowctl run: cloud (daytona) — booting from ${bootFrom}.`);
    print(
      cloudSecrets.length
        ? `piflowctl run: cloud (daytona) — ${stageHome ? `staged ~/.pi/agent/models.json[${parsed.provider}] + ` : ''}forwarding ${credList} into the VM (allowlisted; the raw value never leaves the resolver seam).`
        : `piflowctl run: ⚠ cloud (daytona) — no provider config/credential resolved for --provider "${parsed.provider ?? '(default)'}"; add a custom gateway to ~/.pi/agent/models.json, or declare the key with --cloud-secret NAME, or pi in the VM will have no model key.`,
    );
  } else if (parsed.sandbox === 'e2b') {
    // Real pi exec inside a remote E2B CLOUD sandbox (open egress by default — the MCP unblock). The
    // template + API key come from the environment (E2B_TEMPLATE / E2B_API_KEY); an absent key makes the
    // real client throw at sandbox boot (loud). The `@piflow/e2b` extension is loaded DYNAMICALLY by
    // `makeE2bProvider` — an absent package gives the `npm i @piflow/e2b` install message.
    // (M1b parity) A CUSTOM gateway lives ONLY in the host's ~/.pi/agent/models.json; stage its entry into
    // the sandbox so pi resolves --provider there, and read the cred var(s) from that entry's $VAR refs.
    const pi = loadPiProviderConfig(parsed.provider);
    const stageHome = pi.config ? { '.pi/agent/models.json': pi.config } : undefined;
    const template = process.env.E2B_TEMPLATE;
    provider = await makeE2bProvider({
      ...(template ? { template } : {}),
      apiKey: process.env.E2B_API_KEY,
      ...(stageHome ? { stageHome } : {}),
    });
    // Forward the pi gateway credential into the sandbox (SAME allowlist/resolver path as daytona + MCP).
    const fallback = providerCredVar(parsed.provider);
    cloudSecrets = parsed.cloudSecret
      ? [parsed.cloudSecret]
      : pi.credVars.length
        ? pi.credVars
        : fallback
          ? [fallback]
          : [];
    const credList = cloudSecrets.join(', ');
    const bootFrom = template ? `template ${template}` : 'the E2B default base template (no pi baked — set E2B_TEMPLATE)';
    print(`piflowctl run: cloud (e2b) — booting from ${bootFrom}; egress OPEN by default.`);
    print(
      cloudSecrets.length
        ? `piflowctl run: cloud (e2b) — ${stageHome ? `staged ~/.pi/agent/models.json[${parsed.provider}] + ` : ''}forwarding ${credList} into the sandbox (allowlisted; the raw value never leaves the resolver seam).`
        : `piflowctl run: ⚠ cloud (e2b) — no provider config/credential resolved for --provider "${parsed.provider ?? '(default)'}"; add a custom gateway to ~/.pi/agent/models.json, or declare the key with --cloud-secret NAME, or pi in the sandbox will have no model key.`,
    );
  } else if (parsed.sandbox === 'docker') {
    // Real pi exec inside a LOCAL Docker container — the offline mirror of the cloud path. The managed pi
    // node-runtime image is AUTO-BUILT on first use (zero setup); `DOCKER_IMAGE` overrides with a pre-built
    // tag. The `@piflow/docker` extension is loaded DYNAMICALLY by `makeDockerProvider` — an absent package
    // gives the `npm i @piflow/docker` install message.
    // A container inherits NO host env (docker is a CLOUD_KIND), so — exactly like daytona/e2b — a CUSTOM
    // gateway from ~/.pi/agent/models.json is staged into the container home and its cred var(s) cross via
    // the allowlist. A built-in provider has no entry → no staging.
    const pi = loadPiProviderConfig(parsed.provider);
    const stageHome = pi.config ? { '.pi/agent/models.json': pi.config } : undefined;
    const image = process.env.DOCKER_IMAGE;
    provider = await makeDockerProvider({
      ...(image ? { image } : {}),
      ...(stageHome ? { stageHome } : {}),
    });
    // Forward the pi gateway credential into the container (SAME allowlist/resolver path as the cloud backends).
    const fallback = providerCredVar(parsed.provider);
    cloudSecrets = parsed.cloudSecret
      ? [parsed.cloudSecret]
      : pi.credVars.length
        ? pi.credVars
        : fallback
          ? [fallback]
          : [];
    const credList = cloudSecrets.join(', ');
    const bootFrom = image ? `image ${image}` : 'the auto-built pi node-runtime image (built on first use)';
    print(`piflowctl run: local (docker) — booting one container per run from ${bootFrom}; egress OPEN by default.`);
    print(
      cloudSecrets.length
        ? `piflowctl run: local (docker) — ${stageHome ? `staged ~/.pi/agent/models.json[${parsed.provider}] + ` : ''}forwarding ${credList} into the container (allowlisted; the raw value never leaves the resolver seam).`
        : `piflowctl run: ⚠ local (docker) — no provider config/credential resolved for --provider "${parsed.provider ?? '(default)'}"; add a custom gateway to ~/.pi/agent/models.json, or declare the key with --cloud-secret NAME, or pi in the container will have no model key.`,
    );
  }
  // (G7) `--detach` ⇒ UNATTENDED: take each (G5) checkpoint's declared default so a backgrounded run never
  // hangs on a human gate. The run is already durable; the caller backgrounds the process (`&`/harness).
  if (parsed.detach) {
    print(`piflowctl run: detached/unattended — checkpoints take their default; run dir: ${outDir} (monitor: piflowctl watch ${outDir})`);
  }
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
    // Run-start executor selection (run-level default + per-node overrides) — pick pi vs claude-code WITHOUT
    // editing the template. Threaded through RunOptions (executor/executorOverride) to node-lifecycle's
    // resolveExecutor. Omitted when absent so a run with no --executor stays byte-identical.
    ...(parsed.executor ? { executor: parsed.executor } : {}),
    ...(parsed.executorOverride ? { executorOverride: parsed.executorOverride } : {}),
    ...(parsed.maxConcurrent !== undefined ? { maxConcurrent: parsed.maxConcurrent } : {}),
    ...(parsed.detach ? { checkpointReply: 'default' as const } : {}),
    ...(provider ? { provider } : {}),
    // (M1) cloud-only: the provider-cred allowlist + a default host-side resolver (process.env). Local/
    // inmemory leave cloudSecrets undefined, so the gateway key crosses ONLY into a cloud VM.
    ...(cloudSecrets !== undefined ? { cloudSecrets, secretResolver: defaultSecretResolver } : {}),
  });
}

/**
 * The loud top-level verdict for a FINISHED live run: `null` when it succeeded (or is still running),
 * else the multi-line failure report the CLI prints to stderr before exiting non-zero — the blocking
 * node(s) (`error`/`blocked`, e.g. the synthetic `__resume__` preflight) each followed by their `issues`,
 * and a `piflowctl status` hint. PURE (no process/stderr side effects) so it is unit-tested directly: a
 * blocked resume MUST surface its `__resume__` issue; an `ok` run MUST report nothing.
 */
export function runFailureReport(status: RunResult['status'], runDir: string): string | null {
  if (!status?.done || status.ok !== false) return null;
  const failed = Object.values(status.nodes ?? {}).filter(
    (n) => n.status === 'error' || n.status === 'blocked',
  );
  const lines = [`piflowctl run: ✗ FAILED — ${failed.length || 'a'} node(s) blocked/errored`];
  for (const n of failed) for (const issue of n.issues ?? []) lines.push(`  ✗ ${n.id}: ${issue}`);
  lines.push(`  → inspect: piflowctl status ${runDir}`);
  return lines.join('\n');
}

/**
 * (P7) Map the parsed `run` argv → the `POST /api/runs/start` StartBody the remote serve accepts. PURE (no
 * I/O) so the mapping is unit-tested. The `templateDir` is sent ABSOLUTE (the server resolves it against its
 * own filesystem / allow-list). Only the flags the server understands are forwarded; local-only concerns
 * (workspace/out/from/until/no-resume/max-concurrent) are NOT — the remote run owns its own layout. Fields
 * are omitted when unset so the JSON stays minimal (and byte-stable across runs with no such flag).
 */
export function remoteStartBody(parsed: ParsedRunArgs): Record<string, unknown> {
  return {
    templateDir: path.resolve(parsed.templateDir),
    ...(parsed.run ? { run: parsed.run } : {}),
    ...(Object.keys(parsed.args).length ? { args: parsed.args } : {}),
    // `inmemory` is the parser default (no `--sandbox`); forward a sandbox only when the user actually chose one.
    ...(parsed.sandbox !== 'inmemory' ? { sandbox: parsed.sandbox } : {}),
    ...(parsed.profile ? { profile: parsed.profile } : {}),
    ...(parsed.provider ? { provider: parsed.provider } : {}),
    ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.dryRun ? { dryRun: true } : {}),
    ...(parsed.detach ? { detach: true } : {}),
    ...(parsed.executor ? { executor: parsed.executor } : {}),
    ...(parsed.executorOverride ? { executorOverride: parsed.executorOverride } : {}),
  };
}

/** Injectable seam for the remote-run path (default = the real `startRemoteRun` + stdout), so a test spies it. */
export interface RemoteRunDeps {
  startRemoteRun?: (entry: ContextEntry, body: object, opts?: RemoteOpts) => Promise<StartRemoteResult>;
  print?: (line: string) => void;
}

/**
 * (P7) LAUNCH a run on a REMOTE serve: POST the mapped StartBody to the active context's `/api/runs/start`,
 * then surface the RETURNED run id + how to observe it (via the SAME remote context). The run lives on the
 * remote host — this never touches the local filesystem. Returns the parsed 202 body (for the caller/tests).
 */
export async function runTemplateRemote(
  entry: ContextEntry,
  contextName: string,
  parsed: ParsedRunArgs,
  deps: RemoteRunDeps = {},
): Promise<StartRemoteResult> {
  const start = deps.startRemoteRun ?? startRemoteRun;
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'));
  const res = await start(entry, remoteStartBody(parsed));
  print(`piflowctl run: launched on context "${contextName}" (${entry.baseUrl}) — run "${res.run}".`);
  // Prefer the server-returned streamUrl (absolute-ized against the base); else derive the canonical one.
  const streamUrl = res.streamUrl
    ? `${entry.baseUrl.replace(/\/$/, '')}${res.streamUrl}`
    : streamUrlFor(entry, res.run);
  print(`  → observe: piflowctl watch ${res.run} --context ${contextName}   (stream: ${streamUrl})`);
  print(`  → status:  piflowctl status ${res.run} --context ${contextName}`);
  return res;
}

/** `piflowctl run <templateDir> [--dry-run] [--run <id>] [--arg k=v ...] [--context <name>]` — the bin body. */
export async function runRunCli(argv: string[]): Promise<void> {
  const parsed = parseRunArgs(argv);
  if (!parsed.templateDir) {
    process.stderr.write('piflowctl run: a template directory is required (piflowctl run <templateDir>)\n');
    process.exitCode = 1;
    return;
  }
  // (P7) REMOTE context ⇒ launch on that serve (POST /api/runs/start) and surface the returned run id — NOT a
  // local run. LOCAL/unset ⇒ the unchanged in-process path below. An unknown --context surfaces loudly.
  let remote: ReturnType<typeof resolveRemote>;
  try {
    remote = resolveRemote(parsed.context);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  if (remote) {
    try {
      await runTemplateRemote(remote.entry, remote.name, parsed);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  const result = await runTemplate(parsed);
  // SURFACE FAILURE — a LIVE run that ends `done && ok===false` (a blocked resume preflight, or an
  // errored/blocked node) MUST NOT exit 0 in silence: print the blocking node(s) + their issues to stderr
  // and exit non-zero. Without this a blocked `--from` resume wrote an EMPTY log and returned 0 — the only
  // signal was a separate `piflowctl status`. The status/event archives stay the deep view; this is the loud
  // top-level verdict every CLI consumer (and a backgrounded run's exit code) can rely on. (dry-run → no result.)
  // Use the RESULT's resolved `outDir` for the status hint — it is the real run dir, including any
  // auto-generated `<adjective>-<pie>` name (which the caller can't reconstruct from `parsed.run`).
  const report = result?.status ? runFailureReport(result.status, result.outDir) : null;
  if (report) {
    process.stderr.write(report + '\n');
    process.exitCode = 1;
  }
}
