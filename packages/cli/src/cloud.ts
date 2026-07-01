// A3 — `piflowctl cloud up|down`: born-in-cloud, authed. The one command that stands up the SAME control
// plane a laptop's `piflowctl serve` runs, on a durable Fly.io machine, and registers a `cloud` context so
// the CLI/GUI can point at it (`context use cloud`). It automates the `deploy/control-vm/README.md` runbook:
// mint the bearer token, project the pi gateway + Claude-subscription credentials onto the VM, `fly deploy`
// the control-VM image, smoke it, then switch the console over.
//
//   piflowctl cloud up   [--host <fly|railway|selfhost|docker>] [--app <name>] [--public-url <url>]
//                        [--provider <gw>] [--provider-secret <VAR>] [--context <name>] [--port <n>] [--execute]
//   piflowctl cloud down [--host <...>] [--app <name>] [--context <name>] [--port <n>] [--execute]
//
// The Fly path is now ONE adapter behind the `HostAdapter` seam (packages/cli/src/hosts/): `--host` picks the
// pathway, `cloud.ts` owns the shared core (mint · plan/render/gate · step factories), the adapter owns only
// the URL shape + provider-CLI argvs. `--host` defaults to `railway` (a managed builder); pass
// `--host fly|selfhost|docker` for another pathway — every existing `--host fly` invocation is unchanged.
//
// TWO modes, by design (the user law: PAUSE before an outward-facing / paid action):
//   • DEFAULT = PLAN. Mints the token, registers the `cloud` context row, and PRINTS the exact runbook.
//     It touches `fly` NEVER (no build, no deploy, no spend). This is what an agent runs.
//   • `--execute` = the one-click. piflowctl RUNS every step (secrets set → deploy → smoke) and, on a GREEN
//     smoke, `context use`s the cloud endpoint. The `--execute` flag IS the "spend money" opt-in — the paid
//     `fly deploy` is the operator's call. Steps 4/6 (deploy/smoke) hit Fly + spend; only pass it when ready.
//
// CREDENTIAL PROJECTION — the SAME decomposition the daytona/e2b node path uses (`run.ts` → `parsePiProvider`),
// so the control VM is just another target of one uniform model, not a bespoke path:
//   • the pi gateway's `~/.pi/agent/models.json` entry (`$VAR`-ref'd, SECRET-FREE) is staged into the VM as a
//     NON-secret env `PIFLOW_PI_MODELS_JSON` that the image's CMD writes to `~/.pi/agent/models.json` at boot —
//     the Fly-transport analog of the providers' `stageHomeFiles`. So a CUSTOM `--provider` resolves on the VM
//     exactly as on a laptop / in a daytona-e2b node.
//   • the entry's referenced cred var(s) (`credVars`, the cloud allowlist) + the Claude subscription token are
//     resolved through the `isCloud:true` `SecretResolver` seam (mint-not-forward) and set as Fly SECRETS.
//   • `PIFLOW_TOKEN` (the serve bearer) is freshly MINTED — a genuinely new secret with no prior store.
// With no `--provider` gateway entry, it falls back to a single env key (`--provider-secret`, the demo path).
// HARD BILLING GUARD: `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are NEVER staged (a non-empty API key silently
// outranks the OAuth token in `claude -p` → per-token billing); the provider secret var can't be one either.
//
// The PURE core (`mintCloudSecrets` / `buildFlyDeployPlan` / `renderPlan`) is unit-tested with injected RNG +
// resolvers + a fake step-runner, so no test ever mints a real token, shells out to `fly`, or writes ~/.piflow.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  cloudCredEnvAdditions,
  resolveClaudeOAuthToken,
  defaultSecretResolver,
  type SecretResolver,
} from '@piflow/core';
import { parsePiProvider } from './run.js';
import {
  readContexts,
  writeContexts,
  addContext,
  useContext,
  removeContext,
  type ContextEntry,
} from './context-store.js';
import type { HostAdapter, HostPlanContext } from './hosts/adapter.js';
import { flyAdapter } from './hosts/fly.js';
import { resolveAdapter } from './hosts/registry.js';

// ── constants (mirror deploy/control-vm/{fly.toml,README.md}) ──────────────────────────────────────

/** The Fly app name baked into `deploy/control-vm/fly.toml` — the default target (overridable with --app). */
export const DEFAULT_APP = 'piflow-control-plane';
/** The default hosting pathway. `railway` builds the SAME control-VM image on a managed builder (no local
 *  provider CLI or tunnel to babysit, ~$5/mo, first month free); pass `--host fly|selfhost|docker` to switch. */
export const DEFAULT_HOST = 'railway';
/** The default host port to publish (docker/selfhost); the control-VM image serves on 8080. */
export const DEFAULT_PORT = 8080;
/** The single env key the demo/plain path stages when no `--provider` gateway entry is found. */
export const DEFAULT_PROVIDER_SECRET = 'NEBIUS_API_KEY';
/** The context name `cloud up` registers + switches to (a row in ~/.piflow/contexts.json). */
export const DEFAULT_CONTEXT_NAME = 'cloud';
/** The control-VM Fly config + Dockerfile, relative to the repo root (the build context). */
export const DEFAULT_FLY_CONFIG = 'deploy/control-vm/fly.toml';
export const DEFAULT_DOCKERFILE = 'deploy/control-vm/Dockerfile';
/** The Claude subscription OAuth secret (auth precedence #5 in `claude -p`). */
const OAUTH_SECRET = 'CLAUDE_CODE_OAUTH_TOKEN';
/** The NON-secret env the image's CMD writes to ~/.pi/agent/models.json at boot (the gateway registry). */
export const MODELS_JSON_ENV = 'PIFLOW_PI_MODELS_JSON';
/** API-key vars a non-empty value of which silently OUTRANKS the OAuth token → per-token billing. NEVER stage. */
const FORBIDDEN_SECRETS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
/** The nodeId the mint seam passes to the SecretResolver (so a broker can scope a per-caller token). */
const MINT_NODE_ID = 'piflowctl-cloud-up';

/**
 * The public HTTPS origin Fly gives an app — the `cloud` context's baseUrl. The URL shape now LIVES in
 * `flyAdapter.appUrl`; this is a thin re-export so back-compat callers (and the fly tests) keep one name.
 */
export function flyAppUrl(app: string): string {
  return flyAdapter.appUrl(app, { port: 8080 });
}

// ── minting the secrets (the values the deploy stages; PURE given injected RNG + resolvers) ─────────

/** One staged Fly secret/env: a var name + its value. `displayValue` overrides the redacted `***` (config, not a secret). */
export interface CloudSecret {
  name: string;
  value: string;
  /** A safe label to show instead of `***` — used for the SECRET-FREE gateway config, never for a real secret. */
  displayValue?: string;
}

/** The minted deploy inputs: the bearer token + the `cloud` context entry + the ordered var set + the gateway file. */
export interface MintedSecrets {
  /** The freshly minted bearer token (the `PIFLOW_TOKEN` the serve requires + the context carries). */
  token: string;
  /** The public origin the control VM will answer on. */
  appUrl: string;
  /** The `cloud` context entry to register (baseUrl + the bearer token). */
  contextEntry: ContextEntry;
  /** The vars to `fly secrets set`, in order (PIFLOW_TOKEN first; provider cred(s) + OAuth only when resolved). */
  secrets: CloudSecret[];
  /** The scoped, SECRET-FREE `~/.pi/agent/models.json` gateway entry to stage (when a custom --provider resolved). */
  modelsJson?: string;
  /** The pi gateway name a custom `--provider` resolved to (for display); absent on the plain-key path. */
  provider?: string;
  /** Declared secrets that could NOT be resolved on this machine (the operator must supply them). */
  missing: string[];
}

/** The pi gateway decomposition (mirrors `run.ts`'s cloud-node path): the models.json entry + its $VAR cred names. */
export interface ProviderResolution {
  config?: string;
  credVars: string[];
}

/** Injectable boundaries for `mintCloudSecrets` — real defaults (crypto RNG + the core resolvers), fakes in tests. */
export interface MintDeps {
  /** Bearer-token minter. Default: 256 bits of crypto randomness, hex. */
  randomToken?: () => string;
  /** The scoped-token / vault broker. Default: reads `process.env` (`defaultSecretResolver`). */
  resolver?: SecretResolver;
  /** Provider-cred staging via the isCloud:true allowlist seam. Default: core `cloudCredEnvAdditions`. */
  cloudCred?: typeof cloudCredEnvAdditions;
  /** Claude subscription-token resolver. Default: core `resolveClaudeOAuthToken` (env → file → local login). */
  resolveOAuth?: typeof resolveClaudeOAuthToken;
  /** Resolve a pi gateway → its models.json entry + cred vars. Default: read ~/.pi/agent/models.json + parsePiProvider. */
  resolveProvider?: (provider: string) => ProviderResolution;
}

/** Default gateway resolver — the same source `run.ts` reads for a daytona/e2b node (never throws → {credVars:[]}). */
function resolveProviderDefault(provider: string): ProviderResolution {
  try {
    return parsePiProvider(readFileSync(path.join(os.homedir(), '.pi', 'agent', 'models.json'), 'utf8'), provider);
  } catch {
    return { credVars: [] };
  }
}

/**
 * Mint the deploy inputs. The bearer token is FRESH (never forwarded). If a custom `--provider` resolves to a
 * `~/.pi/agent/models.json` gateway entry, that (secret-free) entry becomes `modelsJson` (staged as a file on the
 * VM) and its referenced `$VAR`(s) become the cred allowlist; otherwise the single `--provider-secret` is used.
 * Each cred var + the Claude OAuth token resolve through the `isCloud:true` SecretResolver seam (mint-not-forward);
 * an unresolved one is reported in `missing`, never staged empty.
 *
 * BILLING GUARD (throws): neither the provider secret var nor any resolved cred name may be an `ANTHROPIC_*`
 * API-key var — a non-empty API key silently wins in `claude -p` (per-token billing).
 */
export async function mintCloudSecrets(
  opts: { appUrl: string; provider?: string; providerSecret: string },
  deps: MintDeps = {},
): Promise<MintedSecrets> {
  const randomToken = deps.randomToken ?? (() => randomBytes(32).toString('hex'));
  const resolver = deps.resolver ?? defaultSecretResolver;
  const cloudCred = deps.cloudCred ?? cloudCredEnvAdditions;
  const resolveOAuth = deps.resolveOAuth ?? resolveClaudeOAuthToken;
  const resolveProvider = deps.resolveProvider ?? resolveProviderDefault;

  const token = randomToken();
  // The adapter now owns the URL shape — mint just carries the origin the caller computed.
  const appUrl = opts.appUrl;

  // The gateway decomposition — the SAME (models.json entry + $VAR cred allowlist) a daytona/e2b node gets.
  // A custom --provider with a real entry → stage the file + use ITS cred vars; otherwise the single env key.
  let modelsJson: string | undefined;
  let providerName: string | undefined;
  let credVarNames: string[];
  const gw = opts.provider ? resolveProvider(opts.provider) : undefined;
  if (gw?.config) {
    modelsJson = gw.config;
    providerName = opts.provider;
    credVarNames = gw.credVars;
  } else {
    credVarNames = [opts.providerSecret];
  }
  // BILLING GUARD: the vars we're about to stage must not include an ANTHROPIC_* API key (whether it arrived
  // as a gateway cred ref or the --provider-secret) — a non-empty API key silently outranks the OAuth token in
  // `claude -p` (per-token billing). Guarding what actually gets STAGED covers both paths (no separate check).
  for (const name of credVarNames) {
    if (FORBIDDEN_SECRETS.has(name)) {
      const src = modelsJson ? `gateway "${opts.provider}" references` : `--provider-secret`;
      throw new Error(`${src} ${name} — an API-key var that silently outranks the Claude OAuth token in \`claude -p\` (per-token billing); refusing to stage it.`);
    }
  }

  const secrets: CloudSecret[] = [{ name: 'PIFLOW_TOKEN', value: token }];
  const missing: string[] = [];

  // Provider cred(s): the isCloud:true allowlist seam (mint-not-forward). Returns only the resolved names.
  const provEnv = await cloudCred(credVarNames, true, MINT_NODE_ID, resolver);
  for (const name of credVarNames) {
    if (provEnv[name]) secrets.push({ name, value: provEnv[name] });
    else missing.push(name);
  }

  // Claude subscription token: the layered host-side resolver (env → ~/.piflow/claude-code.json → login).
  const oauth = await resolveOAuth({ resolver, nodeId: MINT_NODE_ID });
  if (oauth) secrets.push({ name: OAUTH_SECRET, value: oauth });
  else missing.push(OAUTH_SECRET);

  // Defense-in-depth: never let a forbidden API-key var ride along, whatever a broker returned.
  for (const s of secrets) {
    if (FORBIDDEN_SECRETS.has(s.name)) {
      throw new Error(`refusing to stage ${s.name} as a Fly secret (it forces per-token API billing in \`claude -p\`)`);
    }
  }

  return { token, appUrl, contextEntry: { baseUrl: appUrl, token }, secrets, modelsJson, provider: providerName, missing };
}

// ── the deploy plan (PURE — the ordered runbook the README documents) ──────────────────────────────

// 'host' = any provider-CLI-touching step (fly/railway/docker/cloudflared/serve). 'local' + 'smoke' were
// never host-specific. The outward/paid/idempotent flags carry the blast semantics, so nothing downstream
// keys on the literal — the render tag now keys on plan.hostId.
export type StepKind = 'local' | 'host' | 'smoke';

/** One ordered deploy step: an execute-ready argv + a REDACTED display form + its blast/idempotency flags. */
export interface DeployStep {
  id: string;
  kind: StepKind;
  /** The argv to run (real secret values inlined where a command requires them, e.g. `fly secrets set`). */
  command: string[];
  /** The human display — secret values shown as `***` so the runbook is safe to print/scrollback. */
  display: string;
  /** Extra env for the step's process (the smoke's PIFLOW_CLOUD_URL/PIFLOW_TOKEN); values redacted in display. */
  env?: Record<string, string>;
  /** Touches Fly / spends money / runs a real model — an agent must not auto-run these. */
  outward: boolean;
  /** The specific paid `fly deploy` — the pause point the runbook centers on. */
  paid?: boolean;
  /** A failure is tolerable (e.g. `fly apps create` when the app already exists) — execute-mode continues. */
  idempotent?: boolean;
  note?: string;
}

export interface DeployPlan {
  app: string;
  appUrl: string;
  /** The resolving adapter's id ('fly' | 'railway' | 'selfhost' | 'docker') — the render tag keys on it. */
  hostId: string;
  steps: DeployStep[];
}

// ── shared step factories (extracted ONCE from the old buildFlyDeployPlan body; every adapter uses these) ──
//
// These are the host-NEUTRAL steps the design (§3.5) lifts out so redaction + the .dockerignore dance + the
// smoke live in exactly one place. An adapter contributes them from its `upSteps` (fly/railway/docker need the
// dockerignore copy/rm; selfhost-via-serve doesn't), and `buildDeployPlan` appends only the smoke.

/**
 * The `<CLI> secrets set …` step (fly `fly secrets set`, railway `railway variables --set`, …). Builds the
 * `NAME=VALUE` pairs (incl. the labeled NON-secret gateway `MODELS_JSON_ENV` when present), passes them to the
 * host's `argv` shaper for the command, and renders each value as `***` — displayValue overrides only the
 * secret-free gateway config. THE one place redaction of the staged secrets lives.
 */
export function secretsSetStep(
  ctx: HostPlanContext,
  argv: (pairs: string[]) => string[],
): DeployStep {
  const setPairs = [...ctx.secrets];
  if (ctx.modelsJson)
    setPairs.push({ name: MODELS_JSON_ENV, value: ctx.modelsJson, displayValue: `<gateway:${ctx.provider ?? 'pi'}>` });
  const secretArgs = setPairs.map((s) => `${s.name}=${s.value}`);
  const command = argv(secretArgs);
  // The display mirrors the command's shape but redacts every value — so `argv` is applied to the redacted pairs
  // too, keeping display and command structurally identical regardless of the host's flag layout.
  const display = argv(setPairs.map((s) => `${s.name}=${s.displayValue ?? '***'}`)).join(' ');
  return {
    id: 'secrets-set',
    kind: 'host',
    command,
    display,
    outward: true,
    note: `encrypted at rest; injected as env at runtime. ${MODELS_JSON_ENV} is secret-free gateway config (the image writes it to ~/.pi/agent/models.json at boot).`,
  };
}

/**
 * A `docker run -e NAME=VALUE` / `--env-file`-style step for docker/selfhost: inlines the REAL values in
 * `command` but `***` in `display`, via the same redaction the secrets-set step uses. `argv` receives the
 * per-secret env args (`-e NAME=VALUE`, redacted in the display pass) and returns the full command.
 */
export function envRunStep(
  id: string,
  ctx: HostPlanContext,
  argv: (envArgs: string[]) => string[],
  opts: { outward?: boolean; paid?: boolean; idempotent?: boolean; note?: string } = {},
): DeployStep {
  const envArg = (name: string, value: string): string[] => ['-e', `${name}=${value}`];
  const command = argv(ctx.secrets.flatMap((s) => envArg(s.name, s.value)));
  const display = argv(ctx.secrets.flatMap((s) => envArg(s.name, '***'))).join(' ');
  return {
    id,
    kind: 'host',
    command,
    display,
    outward: opts.outward ?? true,
    ...(opts.paid !== undefined ? { paid: opts.paid } : {}),
    ...(opts.idempotent !== undefined ? { idempotent: opts.idempotent } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  };
}

/** Copy the control-vm .dockerignore to the build-context root (fly/railway/docker read only a root one). */
export function copyDockerignoreStep(): DeployStep {
  return {
    id: 'copy-dockerignore',
    kind: 'local',
    command: ['cp', 'deploy/control-vm/.dockerignore', '.dockerignore'],
    display: 'cp deploy/control-vm/.dockerignore .dockerignore',
    outward: false,
    note: 'the builder reads ONLY a context-root .dockerignore; without this copy, COPY . . ships secrets/junk.',
  };
}

/** Remove the temporary context-root .dockerignore copy (paired with copyDockerignoreStep). */
export function rmDockerignoreStep(): DeployStep {
  return {
    id: 'rm-dockerignore',
    kind: 'local',
    command: ['rm', '.dockerignore'],
    display: 'rm .dockerignore',
    outward: false,
    idempotent: true,
    note: 'clean up the temporary context-root copy.',
  };
}

/** The invariant smoke gate — identical for every host; keys only on the origin + the minted token. */
export function smokeStep(appUrl: string, token: string): DeployStep {
  return {
    id: 'smoke',
    kind: 'smoke',
    command: ['node', 'deploy/control-vm/smoke-live.mjs'],
    env: { PIFLOW_CLOUD_URL: appUrl, PIFLOW_TOKEN: token },
    display: `PIFLOW_CLOUD_URL=${appUrl} PIFLOW_TOKEN=*** node deploy/control-vm/smoke-live.mjs`,
    outward: true,
    note: 'the P5 gate: A(auth)→B(start)→C(SSE done)→D(run-view)→E(in-VM bwrap/OAuth invariants).',
  };
}

/**
 * The GENERIC deploy-plan builder — an adapter's full `up` runbook + the invariant smoke. Every host's plan is
 * `[...adapter.upSteps(ctx), smokeStep(...)]`; the adapter owns the provider-CLI steps + the .dockerignore
 * dance, this owns only the smoke. `hostId` = the render tag.
 */
export function buildDeployPlan(adapter: HostAdapter, ctx: HostPlanContext): DeployPlan {
  return {
    app: ctx.app,
    appUrl: ctx.appUrl,
    hostId: adapter.id,
    steps: [...adapter.upSteps(ctx), smokeStep(ctx.appUrl, ctx.token)],
  };
}

/**
 * Back-compat: the ORIGINAL Fly runbook builder, now a 1-line wrapper over `buildDeployPlan(flyAdapter, …)`.
 * The `secrets` are inlined into the `fly secrets set` command (execute form) but rendered as `***`; the
 * SECRET-FREE gateway `modelsJson` rides the same command as a NON-secret labeled env. `-a <app>` is stamped
 * on every `fly` command so the plan overrides the config's app name explicitly.
 */
export function buildFlyDeployPlan(opts: {
  app: string;
  appUrl: string;
  config: string;
  dockerfile: string;
  secrets: CloudSecret[];
  token: string;
  modelsJson?: string;
  provider?: string;
}): DeployPlan {
  return buildDeployPlan(flyAdapter, { ...opts, port: 8080 });
}

// ── rendering the plan (the runbook a user reads; secrets redacted) ─────────────────────────────────

/** Render the PLAN as a numbered runbook — never leaks a resolved secret value (all shown `***`). */
export function renderPlan(plan: DeployPlan, mint: MintedSecrets, opts: { contextName: string }): string {
  const lines: string[] = [];
  lines.push(`piflowctl cloud up — PLAN for app "${plan.app}" → ${plan.appUrl}`);
  lines.push('');
  lines.push(`  Minted bearer token → registered as context "${opts.contextName}" in ~/.piflow/contexts.json`);
  lines.push(`  (the smoke needs it too: PIFLOW_TOKEN is in that file, or copy it from step 3 when you run it).`);
  if (mint.provider) {
    lines.push(`  pi gateway "${mint.provider}" → staged as ${MODELS_JSON_ENV} (the VM writes ~/.pi/agent/models.json at boot).`);
  }
  lines.push('');
  lines.push('  This is a PLAN — nothing outward-facing has run (no fly build/deploy, no spend). Run the steps');
  lines.push('  below yourself, or re-run with --execute to have piflowctl run them (step 4 spends money).');
  lines.push('');
  plan.steps.forEach((s, i) => {
    const tag = s.paid ? `${plan.hostId}·$$` : s.kind;
    lines.push(`  ${i + 1}. [${tag}] ${s.display}`);
    if (s.note) lines.push(`       — ${s.note}`);
  });
  if (mint.missing.length) {
    lines.push('');
    lines.push(`  ⚠ not found on this machine — set these yourself before/at step 3: ${mint.missing.join(', ')}`);
    if (mint.missing.includes(OAUTH_SECRET)) {
      lines.push(`    mint the Claude subscription token with:  claude setup-token`);
    }
  }
  lines.push('');
  lines.push('  ⚠ NEVER set ANTHROPIC_API_KEY as a Fly secret — it silently forces per-token billing in `claude -p`.');
  lines.push('');
  lines.push(`  After a green smoke:  piflowctl context use ${opts.contextName}`);
  return lines.join('\n');
}

// ── the CLI orchestration ────────────────────────────────────────────────────────────────────────

/** The result of running one step (an execute-mode `runStep` returns this). */
export interface StepResult {
  ok: boolean;
  code?: number;
}

/** Injectable side-effect boundaries — real defaults (spawn + ~/.piflow writes), fakes in tests (no I/O). */
export interface CloudDeps extends MintDeps {
  /** Run one step (spawn `fly`/`node`/`cp`/`rm`). Default: spawnSync, stdio inherited. */
  runStep?: (step: DeployStep) => Promise<StepResult>;
  /** Register the `cloud` context row (add, DO NOT switch). Default: read→add→write ~/.piflow/contexts.json. */
  registerContext?: (name: string, entry: ContextEntry) => Promise<void>;
  /** Switch the active context (after a green smoke). Default: read→use→write. */
  switchContext?: (name: string) => Promise<void>;
  /** Remove a context row (`cloud down`). Default: read→remove→write. */
  removeContextFn?: (name: string) => Promise<void>;
  print?: (s: string) => void;
}

/** Default step runner — spawn the command with inherited stdio; the smoke gets its extra env. */
function runStepDefault(step: DeployStep): Promise<StepResult> {
  const res = spawnSync(step.command[0], step.command.slice(1), {
    stdio: 'inherit',
    env: step.env ? { ...process.env, ...step.env } : process.env,
  });
  return Promise.resolve({ ok: res.status === 0, code: res.status ?? undefined });
}

const registerContextDefault = async (name: string, entry: ContextEntry): Promise<void> => {
  await writeContexts(addContext(readContexts(), name, entry));
};
const switchContextDefault = async (name: string): Promise<void> => {
  await writeContexts(useContext(readContexts(), name));
};
const removeContextDefault = async (name: string): Promise<void> => {
  await writeContexts(removeContext(readContexts(), name));
};

export interface CloudUpOpts {
  /** Which hosting pathway (`--host`). Resolved via `resolveAdapter`; defaults to `railway`. */
  host: string;
  app: string;
  /** The public HTTPS origin for docker/selfhost (`--public-url`); ignored when the host derives its own. */
  publicUrl?: string;
  /** Host port to publish (docker/selfhost); 8080 default. */
  port: number;
  provider?: string;
  providerSecret: string;
  contextName: string;
  config: string;
  dockerfile: string;
  /** Run the outward-facing steps (secrets set → deploy → smoke) + switch context on a green smoke. */
  execute: boolean;
}

/**
 * `cloud up`. PLAN mode (default): mint, register the `cloud` context row, print the runbook — no `fly`.
 * EXECUTE mode (`--execute`): run every step in order (an idempotent step's failure is tolerated), then, only
 * on a GREEN smoke, switch the active context to the cloud endpoint. Throws on a hard step failure (halts
 * before the switch, so the console never points at a half-deployed endpoint).
 */
export async function runCloudUp(opts: CloudUpOpts, deps: CloudDeps = {}): Promise<void> {
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'));
  const registerContext = deps.registerContext ?? registerContextDefault;

  // Resolve the pathway, then compute the origin its way (host-derived, or the operator's --public-url).
  const adapter = resolveAdapter(opts.host);
  const appUrl = adapter.appUrl(opts.app, { publicUrl: opts.publicUrl, port: opts.port });

  const mint = await mintCloudSecrets({ appUrl, provider: opts.provider, providerSecret: opts.providerSecret }, deps);
  const plan = buildDeployPlan(adapter, {
    app: opts.app,
    appUrl: mint.appUrl,
    config: opts.config,
    dockerfile: opts.dockerfile,
    port: opts.port,
    secrets: mint.secrets,
    token: mint.token,
    modelsJson: mint.modelsJson,
    provider: mint.provider,
  });

  // Register the row up front (a harmless local write) so `context use cloud` works the moment it's live.
  await registerContext(opts.contextName, mint.contextEntry);

  if (!opts.execute) {
    print(renderPlan(plan, mint, { contextName: opts.contextName }));
    return;
  }

  // FAIL-FAST guard: for a host whose URL the operator must supply (docker/selfhost), refuse `--execute`
  // without `--public-url` — otherwise the context baseUrl + smoke would point at the 127.0.0.1 placeholder,
  // not the durable origin. PLAN mode above still prints the runbook with the placeholder + instructions.
  if (!adapter.urlIsHostDerived && !opts.publicUrl) {
    throw new Error(
      `cloud up --host ${adapter.id} --execute requires --public-url (the durable HTTPS origin) — ` +
        `${adapter.id} can't derive one; the context baseUrl + smoke would otherwise point at ${appUrl}.`,
    );
  }

  // EXECUTE — the one-click. Each outward step runs in order; a hard failure halts before the context switch.
  const runStep = deps.runStep ?? runStepDefault;
  const switchContext = deps.switchContext ?? switchContextDefault;
  print(`piflowctl cloud up --execute — deploying "${opts.app}" → ${mint.appUrl}`);
  if (mint.missing.length) print(`  ⚠ unresolved secrets (set them via 'fly secrets set' yourself): ${mint.missing.join(', ')}`);
  for (const step of plan.steps) {
    print(`▸ ${step.display}`);
    const res = await runStep(step);
    if (!res.ok) {
      if (step.idempotent) {
        print(`  (step "${step.id}" exited ${res.code ?? '?'} — tolerated as idempotent, continuing)`);
        continue;
      }
      throw new Error(`cloud up: step "${step.id}" failed (exit ${res.code ?? '?'}) — halted before switching context`);
    }
  }
  await switchContext(opts.contextName);
  print(`✓ deployed + smoke-green. switched to context "${opts.contextName}" (${mint.appUrl}).`);
}

export interface CloudDownOpts {
  /** Which hosting pathway (`--host`). Resolved via `resolveAdapter`; defaults to `railway`. */
  host: string;
  app: string;
  /** Host port (for the docker/selfhost teardown display); 8080 default. */
  port: number;
  contextName: string;
  execute: boolean;
}

/**
 * `cloud down`. PLAN mode prints the teardown; EXECUTE runs the adapter's teardown step(s) then removes the
 * context. A host with no teardown step (selfhost) prints a manual-teardown note and just removes the context.
 */
export async function runCloudDown(opts: CloudDownOpts, deps: CloudDeps = {}): Promise<void> {
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'));
  const adapter = resolveAdapter(opts.host);
  const steps = adapter.downSteps({ app: opts.app, port: opts.port });

  if (!opts.execute) {
    print(`piflowctl cloud down — PLAN for app "${opts.app}" (host ${adapter.id})`);
    print('');
    if (steps.length === 0) {
      print(`  1. [manual] ${adapter.id} has no remote teardown — stop the supervisor + tunnel yourself.`);
    } else {
      steps.forEach((s, i) => {
        print(`  ${i + 1}. [host] ${s.display}`);
        if (s.note) print(`       — ${s.note}`);
      });
    }
    print(`  ${steps.length + 1}. [local] remove the "${opts.contextName}" context from ~/.piflow/contexts.json`);
    print('');
    print('  This is a PLAN — nothing has been destroyed. Re-run with --execute to tear it down.');
    return;
  }

  const runStep = deps.runStep ?? runStepDefault;
  const removeContextFn = deps.removeContextFn ?? removeContextDefault;
  if (steps.length === 0) {
    print(`  (host ${adapter.id} has no remote teardown — stop the supervisor + tunnel yourself.)`);
  }
  for (const step of steps) {
    print(`▸ ${step.display}`);
    const res = await runStep(step);
    if (!res.ok) throw new Error(`cloud down: '${step.display}' failed (exit ${res.code ?? '?'})`);
  }
  await removeContextFn(opts.contextName);
  print(`✓ tore down "${opts.app}" and removed the "${opts.contextName}" context.`);
}

// ── arg parsing + dispatch (the thin wrapper; mirrors context.ts) ──────────────────────────────────

function fail(msg: string): void {
  process.stderr.write(`piflowctl cloud: ${msg}\n`);
  process.exitCode = 1;
}

const UP_USAGE =
  'usage: piflowctl cloud up [--host <railway|fly|selfhost|docker>] [--app <name>] [--public-url <https://…>] ' +
  '[--provider <gw>] [--provider-secret <VAR>] [--context <name>] [--config <fly.toml>] [--dockerfile <path>] ' +
  '[--port <n>] [--execute]  (--host defaults to railway)';
const DOWN_USAGE =
  'usage: piflowctl cloud down [--host <railway|fly|selfhost|docker>] [--app <name>] [--context <name>] ' +
  '[--port <n>] [--execute]';

/**
 * `piflowctl cloud <up|down> [...]` — parse flags, dispatch, map errors to stderr + a non-zero exit.
 * `deps` is the injection seam runCloudUp/runCloudDown already expose (defaults to the real impls) — so a
 * test can drive the CLI's default-flag resolution (e.g. no `--host` → the DEFAULT_HOST pathway) with fakes.
 */
export async function runCloudCli(argv: string[], deps: CloudDeps = {}): Promise<void> {
  const [verb, ...rest] = argv;

  // Shared flag parse (both verbs accept --host/--app/--port/--context/--execute; up also takes
  // provider/config/dockerfile/public-url).
  let host = DEFAULT_HOST;
  let app = DEFAULT_APP;
  let publicUrl: string | undefined;
  let port = DEFAULT_PORT;
  let provider: string | undefined;
  let providerSecret = DEFAULT_PROVIDER_SECRET;
  let contextName = DEFAULT_CONTEXT_NAME;
  let config = DEFAULT_FLY_CONFIG;
  let dockerfile = DEFAULT_DOCKERFILE;
  let execute = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--host') host = rest[++i];
    else if (a === '--app') app = rest[++i];
    else if (a === '--public-url') publicUrl = rest[++i];
    else if (a === '--port') port = Number(rest[++i]);
    else if (a === '--provider') provider = rest[++i];
    else if (a === '--provider-secret') providerSecret = rest[++i];
    else if (a === '--context') contextName = rest[++i];
    else if (a === '--config') config = rest[++i];
    else if (a === '--dockerfile') dockerfile = rest[++i];
    else if (a === '--execute' || a === '--yes') execute = true;
    else return fail(`unknown flag "${a}"`);
  }
  if (!host) return fail('--host requires a value');
  if (!app) return fail('--app requires a value');
  if (!contextName) return fail('--context requires a value');
  if (!Number.isFinite(port) || port <= 0) return fail('--port requires a positive number');
  // Validate the pathway up front (a typo never reaches --execute) — same guard for both verbs.
  try {
    resolveAdapter(host);
  } catch (e) {
    return fail((e as Error).message ?? String(e));
  }

  switch (verb) {
    case 'up':
      try {
        await runCloudUp({ host, app, publicUrl, port, provider, providerSecret, contextName, config, dockerfile, execute }, deps);
      } catch (e) {
        return fail((e as Error).message ?? String(e));
      }
      return;

    case 'down':
      try {
        await runCloudDown({ host, app, port, contextName, execute }, deps);
      } catch (e) {
        return fail((e as Error).message ?? String(e));
      }
      return;

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${UP_USAGE}\n${DOWN_USAGE}\n`);
      return;

    default:
      return fail(`unknown verb "${verb}". Use: up | down`);
  }
}
