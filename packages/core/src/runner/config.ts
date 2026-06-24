// ─────────────────────────────────────────────────────────────────────────────
// loadConfig — resolve the PI_RUNNER_* ENV + parsed ARGS into the run-opts subset `runFromConfig` consumes
// (D5 / sdk-canonical-build-plan U8). This is the ONE place env lives — `runFromConfig` itself is
// env-agnostic. PRECEDENCE: an explicit arg beats the env default beats the built-in default. Timeouts are
// SECONDS in the env (game-omni convention) → milliseconds here. The consumer-injected WorkflowSpec source
// (`workflowSpec`/`buildWorkflowSpec`) is NOT resolved here — the consumer adds it before calling runFromConfig.
//
// Env mapping (mirrors game-omni pi-runner/run.mjs): PI_RUNNER_PROVIDER→providerName · PI_RUNNER_MODEL→model
// · PI_RUNNER_THINKING→thinking · PI_RUNNER_NODE_TIMEOUT(s)→nodeTimeoutMs · PI_RUNNER_STALL_TIMEOUT(s)→stallMs
// · PI_RUNNER_FROM→from · PI_RUNNER_UNTIL→until. `run` (the instance id) is REQUIRED — a clear throw if absent.
// ─────────────────────────────────────────────────────────────────────────────

import type { RunOptions } from './runner.js';

/** Args (already parsed off the CLI by the caller) that OVERRIDE the env defaults. All optional except `run`. */
export interface ConfigArgs {
  /** The run/instance id — REQUIRED (keys the run dir; the one field with no env/default fallback). */
  run?: string;
  /** Host run dir override (default `out/<run>` is applied downstream by runWorkflow). */
  outDir?: string;
  /** Base checkout root for a run-scoped provider. */
  repoRoot?: string;
  providerName?: string;
  model?: string;
  thinking?: string | boolean;
  from?: string;
  until?: string;
  nodeTimeoutMs?: number;
  stallMs?: number;
  /** Run-level return-handshake default (the write-then-fence default; a node's own returnMode still wins). */
  returnProtocol?: RunOptions['returnProtocol'];
  /**
   * The run-level args (`--arg k=v` delivery) — a parsed map that `{{arg.<key>}}` tokens resolve against at
   * node launch. The CLI parses the repeated `--arg k=v` flags into this map (see `parseArgFlags`); a missing
   * `{{arg.x}}` token fails the node loudly (MissingArgError), never a silent ''. Carried straight through.
   */
  args?: Record<string, string>;
}

/** Inputs to `loadConfig`: the parsed args + the env map (injectable; default `process.env`). */
export interface LoadConfigInput {
  args: ConfigArgs;
  /** The env map (default `process.env`) — injected so the resolution is pure + testable. */
  env?: Record<string, string | undefined>;
}

/**
 * The env/arg-resolved run-opts object — the `RunOptions` subset `loadConfig` produces. A consumer spreads
 * it into `runFromConfig`'s config alongside the injected `workflowSpec`/`buildWorkflowSpec`.
 */
export type ResolvedRunOpts = Pick<
  RunOptions,
  | 'run'
  | 'outDir'
  | 'repoRoot'
  | 'providerName'
  | 'model'
  | 'thinking'
  | 'from'
  | 'until'
  | 'nodeTimeoutMs'
  | 'stallMs'
  | 'returnProtocol'
  | 'args'
>;

/**
 * Parse repeated `--arg k=v` CLI tokens into the args map (the `{{arg.<key>}}` channel). Accepts either the
 * `['--arg', 'k=v', …]` flag form OR bare `'k=v'` tokens; the value may itself contain `=` (only the FIRST
 * `=` splits). A token with no `=` or an empty key is ignored (the CLI surfaces a usage error separately).
 * Pure + injectable so `loadConfig`'s arg resolution stays testable.
 */
export function parseArgFlags(tokens: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    let kv = tokens[i];
    if (kv === '--arg') {
      kv = tokens[++i] ?? '';
    } else if (!kv.includes('=')) {
      continue;
    }
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    args[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return args;
}

/** Parse a seconds string from the env into milliseconds; undefined if absent/unparseable. */
function secondsToMs(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n * 1000 : undefined;
}

/** Drop the undefined-valued keys so a spread does not clobber `runWorkflow`'s own defaults with `undefined`. */
function pruneUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Resolve PI_RUNNER_* env + args → the run-opts object `runFromConfig` consumes. ARG > ENV > default.
 * Throws a clear error if the required `run` id is absent.
 */
export function loadConfig(input: LoadConfigInput): ResolvedRunOpts {
  const env = input.env ?? process.env;
  const { args } = input;

  if (!args.run) {
    throw new Error('loadConfig: `run` is required (the instance id — pass --run <id>); none in args.');
  }

  const resolved: ResolvedRunOpts = {
    run: args.run,
    outDir: args.outDir,
    repoRoot: args.repoRoot,
    // provider: arg > env > built-in default 'cp'.
    providerName: args.providerName ?? env.PI_RUNNER_PROVIDER ?? 'cp',
    model: args.model ?? env.PI_RUNNER_MODEL ?? undefined,
    thinking: args.thinking ?? env.PI_RUNNER_THINKING ?? undefined,
    from: args.from ?? env.PI_RUNNER_FROM ?? undefined,
    until: args.until ?? env.PI_RUNNER_UNTIL ?? undefined,
    nodeTimeoutMs: args.nodeTimeoutMs ?? secondsToMs(env.PI_RUNNER_NODE_TIMEOUT),
    stallMs: args.stallMs ?? secondsToMs(env.PI_RUNNER_STALL_TIMEOUT),
    returnProtocol: args.returnProtocol,
    // The `--arg k=v` channel — no env fallback (it is per-run CLI delivery). An empty map prunes away.
    args: args.args && Object.keys(args.args).length ? args.args : undefined,
  };
  return pruneUndefined(resolved);
}
