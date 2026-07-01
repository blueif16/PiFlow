import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  mintCloudSecrets,
  buildFlyDeployPlan,
  buildDeployPlan,
  renderPlan,
  runCloudUp,
  runCloudDown,
  runCloudCli,
  flyAppUrl,
  MODELS_JSON_ENV,
  type MintDeps,
  type CloudDeps,
  type DeployStep,
} from '../src/cloud.js';
import type { HostAdapter, HostPlanContext } from '../src/hosts/adapter.js';
import { flyAdapter } from '../src/hosts/fly.js';
import { railwayAdapter } from '../src/hosts/railway.js';
import { selfhostAdapter } from '../src/hosts/selfhost.js';
import { dockerAdapter } from '../src/hosts/docker.js';
import { resolveAdapter, ADAPTERS } from '../src/hosts/registry.js';

// A fixed resolver set so no test mints a real token, reads ~/.pi, shells out, or writes ~/.piflow.
const OAUTH_VALUE = 'oauth-SUBSCRIPTION-secret';
const PROVIDER_VALUE = 'nebius-KEY-secret';
const fixedMintDeps = (over: Partial<MintDeps> = {}): MintDeps => ({
  randomToken: () => 'MINTED-BEARER',
  cloudCred: (async (names: string[]) => Object.fromEntries(names.map((n) => [n, PROVIDER_VALUE]))) as MintDeps['cloudCred'],
  resolveOAuth: (async () => OAUTH_VALUE) as MintDeps['resolveOAuth'],
  resolveProvider: () => ({ credVars: [] }),
  ...over,
});

// ── mintCloudSecrets — the value minting (PURE given injected RNG + resolvers) ─────────────────────
describe('mintCloudSecrets', () => {
  it('mints a fresh PIFLOW_TOKEN and derives the cloud context entry + app url', async () => {
    const m = await mintCloudSecrets({ appUrl: flyAppUrl('my-app'), providerSecret: 'NEBIUS_API_KEY' }, fixedMintDeps());
    expect(m.token).toBe('MINTED-BEARER');
    expect(m.appUrl).toBe('https://my-app.fly.dev');
    expect(m.contextEntry).toEqual({ baseUrl: 'https://my-app.fly.dev', token: 'MINTED-BEARER' });
    expect(m.secrets[0]).toEqual({ name: 'PIFLOW_TOKEN', value: 'MINTED-BEARER' });
  });

  it('plain path (no --provider): stages the single --provider-secret + OAuth, no gateway file', async () => {
    const m = await mintCloudSecrets({ appUrl: flyAppUrl('a'), providerSecret: 'NEBIUS_API_KEY' }, fixedMintDeps());
    expect(m.modelsJson).toBeUndefined();
    expect(m.provider).toBeUndefined();
    expect(m.secrets.map((s) => s.name)).toEqual(['PIFLOW_TOKEN', 'NEBIUS_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    expect(m.missing).toEqual([]);
  });

  it('custom gateway (--provider): stages the models.json entry + ITS cred vars (not the fallback key)', async () => {
    const m = await mintCloudSecrets(
      { appUrl: flyAppUrl('a'), provider: 'mmgw', providerSecret: 'NEBIUS_API_KEY' },
      fixedMintDeps({ resolveProvider: () => ({ config: '{"providers":{"mmgw":{}}}', credVars: ['MMGW_KEY'] }) }),
    );
    expect(m.modelsJson).toBe('{"providers":{"mmgw":{}}}');
    expect(m.provider).toBe('mmgw');
    expect(m.secrets.map((s) => s.name)).toEqual(['PIFLOW_TOKEN', 'MMGW_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('reports an UNRESOLVED provider cred + OAuth as missing (never staged empty)', async () => {
    const m = await mintCloudSecrets(
      { appUrl: flyAppUrl('a'), providerSecret: 'NEBIUS_API_KEY' },
      fixedMintDeps({
        cloudCred: (async () => ({})) as MintDeps['cloudCred'],
        resolveOAuth: (async () => undefined) as MintDeps['resolveOAuth'],
      }),
    );
    expect(m.missing).toEqual(['NEBIUS_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    expect(m.secrets.map((s) => s.name)).toEqual(['PIFLOW_TOKEN']); // only the minted bearer resolved
  });

  // These isolate the STAGE-INTENT guard: an ANTHROPIC_* var must be rejected because we'd DECLARE it a Fly
  // secret — independent of whether it resolves on this machine (a non-resolving cloudCred, so the reject can
  // only come from the credVarNames guard, not from the resolved-secrets defense-in-depth check downstream).
  const nonResolving = (over: Partial<MintDeps> = {}) => fixedMintDeps({ cloudCred: (async () => ({})) as MintDeps['cloudCred'], ...over });

  it('BILLING GUARD: refuses an ANTHROPIC_* API key as the --provider-secret, even when it does not resolve', async () => {
    await expect(
      mintCloudSecrets({ appUrl: flyAppUrl('a'), providerSecret: 'ANTHROPIC_API_KEY' }, nonResolving()),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('BILLING GUARD: refuses a gateway whose cred vars include an ANTHROPIC_* API key, even when it does not resolve', async () => {
    await expect(
      mintCloudSecrets(
        { appUrl: flyAppUrl('a'), provider: 'evil', providerSecret: 'NEBIUS_API_KEY' },
        nonResolving({ resolveProvider: () => ({ config: '{}', credVars: ['ANTHROPIC_API_KEY'] }) }),
      ),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

// ── buildFlyDeployPlan — the ordered runbook (PURE) ────────────────────────────────────────────────
describe('buildFlyDeployPlan', () => {
  const base = { app: 'the-app', appUrl: flyAppUrl('the-app'), config: 'deploy/control-vm/fly.toml', dockerfile: 'deploy/control-vm/Dockerfile', token: 'BEARER', secrets: [{ name: 'PIFLOW_TOKEN', value: 'BEARER' }, { name: 'NEBIUS_API_KEY', value: 'NK' }] };

  it('emits the six steps in runbook order', () => {
    const plan = buildFlyDeployPlan(base);
    expect(plan.steps.map((s) => s.id)).toEqual([
      'copy-dockerignore',
      'apps-create',
      'secrets-set',
      'deploy',
      'rm-dockerignore',
      'smoke',
    ]);
  });

  it('the deploy step is the paid one and carries --config/--dockerfile/-a <app>/. from the repo root', () => {
    const plan = buildFlyDeployPlan(base);
    const deploy = plan.steps.find((s) => s.id === 'deploy')!;
    expect(deploy.paid).toBe(true);
    expect(deploy.command).toEqual([
      'fly', 'deploy', '--config', 'deploy/control-vm/fly.toml', '--dockerfile', 'deploy/control-vm/Dockerfile', '-a', 'the-app', '.',
    ]);
  });

  it('apps-create is idempotent (its failure is tolerated in execute mode)', () => {
    const plan = buildFlyDeployPlan(base);
    expect(plan.steps.find((s) => s.id === 'apps-create')!.idempotent).toBe(true);
  });

  it('secrets-set inlines the REAL values in the command but redacts them in display', () => {
    const plan = buildFlyDeployPlan(base);
    const set = plan.steps.find((s) => s.id === 'secrets-set')!;
    expect(set.command).toContain('NEBIUS_API_KEY=NK'); // execute form has the real value
    expect(set.display).toContain('NEBIUS_API_KEY=***'); // display redacts it
    expect(set.display).not.toContain('=NK');
  });

  it('when a gateway models.json is present it rides secrets-set as a NON-secret labeled env', () => {
    const plan = buildFlyDeployPlan({ ...base, modelsJson: '{"providers":{"mmgw":{"apiKey":"$MMGW_KEY"}}}', provider: 'mmgw' });
    const set = plan.steps.find((s) => s.id === 'secrets-set')!;
    expect(set.command.some((a) => a.startsWith(`${MODELS_JSON_ENV}={`))).toBe(true); // the real config in the command
    expect(set.display).toContain(`${MODELS_JSON_ENV}=<gateway:mmgw>`); // labeled, not the blob, in display
    expect(set.display).not.toContain('$MMGW_KEY');
  });

  it('the smoke step carries the app url + token in its env (redacted in display)', () => {
    const plan = buildFlyDeployPlan(base);
    const smoke = plan.steps.find((s) => s.id === 'smoke')!;
    expect(smoke.env).toEqual({ PIFLOW_CLOUD_URL: 'https://the-app.fly.dev', PIFLOW_TOKEN: 'BEARER' });
    expect(smoke.display).toContain('PIFLOW_TOKEN=***');
    expect(smoke.display).not.toContain('BEARER');
  });
});

// ── renderPlan — the runbook a user reads (redaction is the critical property) ──────────────────────
describe('renderPlan', () => {
  const mkMint = (over = {}) => ({ token: 'BEARER', appUrl: flyAppUrl('a'), contextEntry: { baseUrl: flyAppUrl('a'), token: 'BEARER' }, secrets: [{ name: 'PIFLOW_TOKEN', value: 'BEARER' }, { name: 'NEBIUS_API_KEY', value: PROVIDER_VALUE }, { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: OAUTH_VALUE }], missing: [] as string[], ...over });

  it('NEVER leaks a resolved secret value (all shown ***)', () => {
    const mint = mkMint();
    const plan = buildFlyDeployPlan({ app: 'a', appUrl: mint.appUrl, config: 'c', dockerfile: 'd', token: mint.token, secrets: mint.secrets });
    const out = renderPlan(plan, mint, { contextName: 'cloud' });
    expect(out).not.toContain(PROVIDER_VALUE);
    expect(out).not.toContain(OAUTH_VALUE);
    expect(out).toContain('***');
  });

  it('warns about unresolved secrets and points at claude setup-token for the OAuth one', () => {
    const mint = mkMint({ missing: ['CLAUDE_CODE_OAUTH_TOKEN'] });
    const plan = buildFlyDeployPlan({ app: 'a', appUrl: mint.appUrl, config: 'c', dockerfile: 'd', token: mint.token, secrets: mint.secrets });
    const out = renderPlan(plan, mint, { contextName: 'cloud' });
    expect(out).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(out).toContain('claude setup-token');
  });

  it('marks it a PLAN, warns off ANTHROPIC_API_KEY, and gives the context-use next step', () => {
    const mint = mkMint();
    const plan = buildFlyDeployPlan({ app: 'a', appUrl: mint.appUrl, config: 'c', dockerfile: 'd', token: mint.token, secrets: mint.secrets });
    const out = renderPlan(plan, mint, { contextName: 'cloud' });
    expect(out).toContain('PLAN');
    expect(out).toContain('NEVER set ANTHROPIC_API_KEY');
    expect(out).toContain('piflowctl context use cloud');
  });
});

// ── runCloudUp — the orchestration (injected boundaries; no spawn / no ~/.piflow write) ─────────────
describe('runCloudUp', () => {
  const upOpts = { host: 'fly', app: 'a', port: 8080, providerSecret: 'NEBIUS_API_KEY', contextName: 'cloud', config: 'deploy/control-vm/fly.toml', dockerfile: 'deploy/control-vm/Dockerfile' };

  it('PLAN mode: registers the context row, prints the plan, and runs NO outward step', async () => {
    const registered: { name: string; entry: unknown }[] = [];
    const runStep = vi.fn();
    const switchContext = vi.fn();
    const printed: string[] = [];
    const deps: CloudDeps = {
      ...fixedMintDeps(),
      registerContext: async (name, entry) => { registered.push({ name, entry }); },
      runStep: runStep as unknown as CloudDeps['runStep'],
      switchContext: switchContext as unknown as CloudDeps['switchContext'],
      print: (s) => printed.push(s),
    };
    await runCloudUp({ ...upOpts, execute: false }, deps);
    expect(registered).toEqual([{ name: 'cloud', entry: { baseUrl: 'https://a.fly.dev', token: 'MINTED-BEARER' } }]);
    expect(runStep).not.toHaveBeenCalled();
    expect(switchContext).not.toHaveBeenCalled();
    expect(printed.join('\n')).toContain('PLAN');
  });

  it('EXECUTE mode: runs every step in order, then switches context on success', async () => {
    const ran: string[] = [];
    const switched: string[] = [];
    const deps: CloudDeps = {
      ...fixedMintDeps(),
      registerContext: async () => {},
      runStep: async (s: DeployStep) => { ran.push(s.id); return { ok: true }; },
      switchContext: async (name: string) => { switched.push(name); },
      print: () => {},
    };
    await runCloudUp({ ...upOpts, execute: true }, deps);
    expect(ran).toEqual(['copy-dockerignore', 'apps-create', 'secrets-set', 'deploy', 'rm-dockerignore', 'smoke']);
    expect(switched).toEqual(['cloud']); // switch happens AFTER all steps, only on success
  });

  it('EXECUTE mode: a HARD step failure halts before the context switch', async () => {
    const switchContext = vi.fn();
    const deps: CloudDeps = {
      ...fixedMintDeps(),
      registerContext: async () => {},
      runStep: async (s: DeployStep) => (s.id === 'deploy' ? { ok: false, code: 1 } : { ok: true }),
      switchContext: switchContext as unknown as CloudDeps['switchContext'],
      print: () => {},
    };
    await expect(runCloudUp({ ...upOpts, execute: true }, deps)).rejects.toThrow(/step "deploy" failed/);
    expect(switchContext).not.toHaveBeenCalled();
  });

  it('EXECUTE mode: an IDEMPOTENT step failure (apps-create) is tolerated and the switch still happens', async () => {
    const ran: string[] = [];
    const switched: string[] = [];
    const deps: CloudDeps = {
      ...fixedMintDeps(),
      registerContext: async () => {},
      runStep: async (s: DeployStep) => { ran.push(s.id); return s.id === 'apps-create' ? { ok: false, code: 1 } : { ok: true }; },
      switchContext: async (name: string) => { switched.push(name); },
      print: () => {},
    };
    await runCloudUp({ ...upOpts, execute: true }, deps);
    expect(ran).toContain('deploy'); // continued past the tolerated apps-create failure
    expect(switched).toEqual(['cloud']);
  });
});

// ── runCloudDown — teardown ────────────────────────────────────────────────────────────────────────
describe('runCloudDown', () => {
  it('PLAN mode: prints the teardown, runs no step, removes no context', async () => {
    const runStep = vi.fn();
    const removeContextFn = vi.fn();
    const printed: string[] = [];
    await runCloudDown({ host: 'fly', app: 'a', port: 8080, contextName: 'cloud', execute: false }, {
      runStep: runStep as unknown as CloudDeps['runStep'],
      removeContextFn: removeContextFn as unknown as CloudDeps['removeContextFn'],
      print: (s) => printed.push(s),
    });
    expect(runStep).not.toHaveBeenCalled();
    expect(removeContextFn).not.toHaveBeenCalled();
    expect(printed.join('\n')).toContain('PLAN');
  });

  it('EXECUTE mode: destroys the app then removes the context', async () => {
    const ran: string[] = [];
    const removed: string[] = [];
    await runCloudDown({ host: 'fly', app: 'a', port: 8080, contextName: 'cloud', execute: true }, {
      runStep: async (s: DeployStep) => { ran.push(s.command.join(' ')); return { ok: true }; },
      removeContextFn: async (name: string) => { removed.push(name); },
      print: () => {},
    });
    expect(ran).toEqual(['fly apps destroy a --yes']);
    expect(removed).toEqual(['cloud']);
  });

  it('EXECUTE mode: a failed destroy does NOT remove the context', async () => {
    const removeContextFn = vi.fn();
    await expect(
      runCloudDown({ host: 'fly', app: 'a', port: 8080, contextName: 'cloud', execute: true }, {
        runStep: async () => ({ ok: false, code: 1 }),
        removeContextFn: removeContextFn as unknown as CloudDeps['removeContextFn'],
        print: () => {},
      }),
    ).rejects.toThrow(/failed/);
    expect(removeContextFn).not.toHaveBeenCalled();
  });
});

// ── the HostAdapter seam (foundation: fly adapter + registry + the generic buildDeployPlan) ─────────
//
// These guard the refactor's INVARIANTS the follow-up adapters depend on: the generic builder reproduces the
// fly path byte-for-byte, the registry validates a host, and the fail-fast guard fires for a non-host-derived
// URL. All PURE / injected-fake — zero I/O.

// A minimal HostPlanContext for the fly adapter (same inputs the old buildFlyDeployPlan wrapper feeds it).
const flyCtx = (over: Partial<HostPlanContext> = {}): HostPlanContext => ({
  app: 'the-app',
  appUrl: flyAppUrl('the-app'),
  config: 'deploy/control-vm/fly.toml',
  dockerfile: 'deploy/control-vm/Dockerfile',
  port: 8080,
  token: 'BEARER',
  secrets: [{ name: 'PIFLOW_TOKEN', value: 'BEARER' }, { name: 'NEBIUS_API_KEY', value: 'NK' }],
  ...over,
});

describe('buildDeployPlan(flyAdapter, …)', () => {
  it('reproduces the SAME ordered steps as the buildFlyDeployPlan wrapper', () => {
    const viaGeneric = buildDeployPlan(flyAdapter, flyCtx());
    const viaWrapper = buildFlyDeployPlan({
      app: 'the-app',
      appUrl: flyAppUrl('the-app'),
      config: 'deploy/control-vm/fly.toml',
      dockerfile: 'deploy/control-vm/Dockerfile',
      token: 'BEARER',
      secrets: [{ name: 'PIFLOW_TOKEN', value: 'BEARER' }, { name: 'NEBIUS_API_KEY', value: 'NK' }],
    });
    // Byte-identical steps AND the same hostId tag — the wrapper is just buildDeployPlan(flyAdapter, …).
    expect(viaGeneric).toEqual(viaWrapper);
    expect(viaGeneric.steps.map((s) => s.id)).toEqual([
      'copy-dockerignore',
      'apps-create',
      'secrets-set',
      'deploy',
      'rm-dockerignore',
      'smoke',
    ]);
    expect(viaGeneric.hostId).toBe('fly');
  });

  it('secrets-set inlines the REAL value in command but *** in display (the one redaction site)', () => {
    const plan = buildDeployPlan(flyAdapter, flyCtx());
    const set = plan.steps.find((s) => s.id === 'secrets-set')!;
    expect(set.command).toContain('NEBIUS_API_KEY=NK'); // execute form has the real value
    expect(set.display).toContain('NEBIUS_API_KEY=***'); // display redacts it
    expect(set.display).not.toContain('=NK'); // the value never leaks into the printable runbook
  });

  it('the smoke env is always {PIFLOW_CLOUD_URL, PIFLOW_TOKEN} regardless of the ctx', () => {
    const plan = buildDeployPlan(flyAdapter, flyCtx({ app: 'zz', appUrl: 'https://zz.fly.dev' }));
    const smoke = plan.steps.at(-1)!;
    expect(smoke.id).toBe('smoke');
    expect(smoke.env).toEqual({ PIFLOW_CLOUD_URL: 'https://zz.fly.dev', PIFLOW_TOKEN: 'BEARER' });
    expect(smoke.display).not.toContain('BEARER');
  });
});

describe('flyAdapter.appUrl', () => {
  it('shapes the .fly.dev origin from the app name', () => {
    expect(flyAdapter.appUrl('a', { port: 8080 })).toBe('https://a.fly.dev');
  });
  it('is host-derived (needs no --public-url)', () => {
    expect(flyAdapter.urlIsHostDerived).toBe(true);
  });
});

describe('resolveAdapter (the registry gate)', () => {
  it('resolves every registered host to its adapter', () => {
    expect(resolveAdapter('fly')).toBe(flyAdapter);
    expect(resolveAdapter('railway')).toBe(railwayAdapter);
    expect(resolveAdapter('selfhost')).toBe(selfhostAdapter);
    expect(resolveAdapter('docker')).toBe(dockerAdapter);
  });
  it('throws on an unknown host, naming the full known set', () => {
    expect(() => resolveAdapter('bogus')).toThrow(/unknown --host "bogus"/);
    expect(() => resolveAdapter('bogus')).toThrow(/known: docker, fly, railway, selfhost/);
  });
});

// A tiny stub adapter that (like docker/selfhost) does NOT derive its own URL — so the fail-fast guard can be
// asserted at the foundation stage, before those real adapters exist. Registered only for this test.
const stubNonDerived: HostAdapter = {
  id: 'stub',
  label: 'stub',
  urlIsHostDerived: false,
  appUrl: (_app, { publicUrl, port }) => publicUrl ?? `http://127.0.0.1:${port}`,
  upSteps: () => [],
  downSteps: () => [],
};

describe('runCloudUp fail-fast guard (--public-url required when the URL is not host-derived)', () => {
  const baseUp = {
    host: 'stub',
    app: 'a',
    port: 8080,
    providerSecret: 'NEBIUS_API_KEY',
    contextName: 'cloud',
    config: '',
    dockerfile: '',
  };
  const deps = (over: Partial<CloudDeps> = {}): CloudDeps => ({
    ...fixedMintDeps(),
    registerContext: async () => {},
    runStep: (async () => ({ ok: true })) as CloudDeps['runStep'],
    switchContext: (async () => {}) as CloudDeps['switchContext'],
    print: () => {},
    ...over,
  });

  // Register the stub only for these cases (foundation ships only fly) — and un-register after, so the
  // registry stays fly-only for the `resolveAdapter('bogus')` known-set assertion elsewhere.
  beforeAll(() => { ADAPTERS.stub = stubNonDerived; });
  afterAll(() => { delete ADAPTERS.stub; });

  it('--execute WITHOUT --public-url THROWS before any step', async () => {
    const runStep = vi.fn(async () => ({ ok: true }));
    await expect(
      runCloudUp({ ...baseUp, execute: true }, deps({ runStep: runStep as unknown as CloudDeps['runStep'] })),
    ).rejects.toThrow(/requires --public-url/);
    expect(runStep).not.toHaveBeenCalled(); // fails BEFORE running anything
  });

  it('--execute WITH --public-url does not trip the guard', async () => {
    const switched: string[] = [];
    await runCloudUp(
      { ...baseUp, publicUrl: 'https://x.example', execute: true },
      deps({ switchContext: (async (n: string) => { switched.push(n); }) as CloudDeps['switchContext'] }),
    );
    expect(switched).toEqual(['cloud']); // reached the end (no steps, but the switch fired)
  });

  it('PLAN mode (no --execute) does NOT throw even without --public-url', async () => {
    const printed: string[] = [];
    await runCloudUp({ ...baseUp, execute: false }, deps({ print: (s) => printed.push(s) }));
    expect(printed.join('\n')).toContain('PLAN'); // the runbook still prints (with the placeholder)
  });
});

describe('runCloudUp/down dispatch over --host fly (the fly pathway)', () => {
  it('runCloudUp --host fly runs the fly steps in order then switches context', async () => {
    const ran: string[] = [];
    const switched: string[] = [];
    await runCloudUp(
      { host: 'fly', app: 'a', port: 8080, providerSecret: 'NEBIUS_API_KEY', contextName: 'cloud', config: 'c', dockerfile: 'd', execute: true },
      {
        ...fixedMintDeps(),
        registerContext: async () => {},
        runStep: async (s: DeployStep) => { ran.push(s.id); return { ok: true }; },
        switchContext: async (name: string) => { switched.push(name); },
        print: () => {},
      },
    );
    expect(ran).toEqual(['copy-dockerignore', 'apps-create', 'secrets-set', 'deploy', 'rm-dockerignore', 'smoke']);
    expect(switched).toEqual(['cloud']);
  });

  it('runCloudDown --host fly runs the fly teardown then removes the context', async () => {
    const ran: string[] = [];
    const removed: string[] = [];
    await runCloudDown(
      { host: 'fly', app: 'a', port: 8080, contextName: 'cloud', execute: true },
      {
        runStep: async (s: DeployStep) => { ran.push(s.command.join(' ')); return { ok: true }; },
        removeContextFn: async (name: string) => { removed.push(name); },
        print: () => {},
      },
    );
    expect(ran).toEqual(['fly apps destroy a --yes']);
    expect(removed).toEqual(['cloud']);
  });
});

// ── the CLI default host (no --host) resolves to DEFAULT_HOST = railway ──────────────────────────────
//
// runCloudCli is where `--host`'s absence becomes a concrete pathway. These drive the CLI end-to-end with the
// injected fakes and assert the RAILWAY plan runs — so if DEFAULT_HOST regressed to 'fly' the step sequences
// diverge (fly has `apps-create` + `fly apps destroy`; railway has `domain` + `railway down`) and both go red.
describe('runCloudCli default host (no --host) → railway', () => {
  it('`cloud up --execute` with no --host runs the RAILWAY up steps then switches context', async () => {
    const ran: string[] = [];
    const switched: string[] = [];
    await runCloudCli(['up', '--execute'], {
      ...fixedMintDeps(),
      registerContext: async () => {},
      runStep: async (s: DeployStep) => { ran.push(s.id); return { ok: true }; },
      switchContext: async (name: string) => { switched.push(name); },
      print: () => {},
    });
    // railway plan = its upSteps + the invariant smoke: NO fly `apps-create`; HAS railway's `domain`.
    expect(ran).toEqual(['copy-dockerignore', 'secrets-set', 'deploy', 'domain', 'rm-dockerignore', 'smoke']);
    expect(switched).toEqual(['cloud']);
  });

  it('`cloud down --execute` with no --host runs the RAILWAY teardown (not `fly apps destroy`)', async () => {
    const ran: string[] = [];
    const removed: string[] = [];
    await runCloudCli(['down', '--execute'], {
      runStep: async (s: DeployStep) => { ran.push(s.command.join(' ')); return { ok: true }; },
      removeContextFn: async (name: string) => { removed.push(name); },
      print: () => {},
    });
    expect(ran).toEqual(['railway down --yes']);
    expect(removed).toEqual(['cloud']);
  });
});
