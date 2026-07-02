// railwayAdapter — the Railway host pathway. PURE `DeployStep[]`/string builder (no spawn, no I/O), so these
// assert argv + `***` redaction + URL shaping with zero side effects (design: §4-railway + §8 tests). The one
// property with teeth is redaction: a secret value must NEVER appear in a step's `display` (the printable
// runbook) — the §4 test-the-test on that assertion is done by hand in-review (flip `***`→the real value and
// this test goes red).

import { describe, it, expect } from 'vitest';
import { railwayAdapter } from '../src/hosts/railway.js';
import { MODELS_JSON_ENV } from '../src/cloud.js';
import type { HostPlanContext } from '../src/hosts/adapter.js';

// A minimal HostPlanContext for railway — the same shape mint feeds runCloudUp.
const ctx = (over: Partial<HostPlanContext> = {}): HostPlanContext => ({
  app: 'the-svc',
  appUrl: 'https://the-svc.up.railway.app',
  config: '',
  dockerfile: 'deploy/control-vm/Dockerfile',
  port: 8080,
  token: 'BEARER',
  secrets: [
    { name: 'PIFLOW_TOKEN', value: 'BEARER' },
    { name: 'NEBIUS_API_KEY', value: 'NK-SECRET' },
  ],
  ...over,
});

describe('railwayAdapter identity', () => {
  it('is the railway host, host-derived, with matching id/label', () => {
    expect(railwayAdapter.id).toBe('railway');
    expect(railwayAdapter.label).toBe('railway');
    expect(railwayAdapter.urlIsHostDerived).toBe(true);
  });
});

describe('railwayAdapter.appUrl', () => {
  it('shapes the .up.railway.app origin from the service name (the deterministic guess)', () => {
    expect(railwayAdapter.appUrl('a', { port: 8080 })).toBe('https://a.up.railway.app');
  });
  it('prefers an operator-supplied --public-url (railway domain confirms it)', () => {
    expect(railwayAdapter.appUrl('a', { publicUrl: 'https://custom.example', port: 8080 })).toBe(
      'https://custom.example',
    );
  });
});

describe('railwayAdapter.upSteps', () => {
  it('emits the runbook order: copy-dockerignore → secrets-set → dockerfile-path → deploy → domain → rm-dockerignore', () => {
    expect(railwayAdapter.upSteps(ctx()).map((s) => s.id)).toEqual([
      'copy-dockerignore',
      'secrets-set',
      'dockerfile-path',
      'deploy',
      'domain',
      'rm-dockerignore',
    ]);
  });

  it('sets RAILWAY_DOCKERFILE_PATH as a SERVICE variable (a local env var never reaches the server-side builder)', () => {
    const step = railwayAdapter.upSteps(ctx()).find((s) => s.id === 'dockerfile-path')!;
    // MUST be `railway variables --set` (persisted on the service, read at build time), NOT a process env —
    // otherwise Railway ignores our monorepo Dockerfile and falls back to Railpack (Node auto-detect) → build fails.
    expect(step.command).toEqual(['railway', 'variables', '--skip-deploys', '--set', 'RAILWAY_DOCKERFILE_PATH=deploy/control-vm/Dockerfile']);
    // it precedes the deploy so the builder sees it
    const ids = railwayAdapter.upSteps(ctx()).map((s) => s.id);
    expect(ids.indexOf('dockerfile-path')).toBeLessThan(ids.indexOf('deploy'));
  });

  it('the secrets-set step shapes each pair as `railway variables --skip-deploys --set K=V` (real values, no premature deploy)', () => {
    const set = railwayAdapter.upSteps(ctx()).find((s) => s.id === 'secrets-set')!;
    expect(set.command).toEqual([
      'railway',
      'variables',
      '--skip-deploys',
      '--set',
      'PIFLOW_TOKEN=BEARER',
      '--set',
      'NEBIUS_API_KEY=NK-SECRET',
    ]);
  });

  it('secrets-set REDACTS every secret value in display — a real value NEVER leaks into the runbook', () => {
    const set = railwayAdapter.upSteps(ctx()).find((s) => s.id === 'secrets-set')!;
    expect(set.display).toContain('NEBIUS_API_KEY=***');
    expect(set.display).not.toContain('NK-SECRET'); // the value must never appear in the printable form
    expect(set.display).not.toContain('=BEARER'); // nor the bearer token
  });

  it('a gateway models.json rides secrets-set as a NON-secret labeled env (config, not `***`)', () => {
    const set = railwayAdapter
      .upSteps(ctx({ modelsJson: '{"providers":{"mmgw":{"apiKey":"$MMGW_KEY"}}}', provider: 'mmgw' }))
      .find((s) => s.id === 'secrets-set')!;
    // the real config is in the execute-form command, the label is in the display, the $VAR never leaks
    expect(set.command.some((a) => a.startsWith(`${MODELS_JSON_ENV}={`))).toBe(true);
    expect(set.display).toContain(`${MODELS_JSON_ENV}=<gateway:mmgw>`);
    expect(set.display).not.toContain('$MMGW_KEY');
  });

  it('the deploy step is the paid one and WAITS for the build via --ci (streams then exits non-zero on failure)', () => {
    const deploy = railwayAdapter.upSteps(ctx()).find((s) => s.id === 'deploy')!;
    expect(deploy.paid).toBe(true);
    expect(deploy.outward).toBe(true);
    // `--ci`: stream the build logs then exit with the build's status — so cloud up WAITS for the deploy and
    // HALTS on a build failure (bare `railway up` returns on upload in a non-TTY spawn; --detach never waits).
    expect(deploy.command).toEqual(['railway', 'up', '--ci', '--service', 'the-svc']);
    expect(deploy.command).not.toContain('--detach');
    // the Dockerfile is targeted by the `dockerfile-path` SERVICE-variable step, NOT a process env on deploy.
    expect(deploy.env?.RAILWAY_DOCKERFILE_PATH).toBeUndefined();
  });

  it('the domain step is idempotent (railway domain re-run is safe) and touches the provider', () => {
    const domain = railwayAdapter.upSteps(ctx()).find((s) => s.id === 'domain')!;
    expect(domain.command).toEqual(['railway', 'domain']);
    expect(domain.idempotent).toBe(true);
    expect(domain.outward).toBe(true);
  });
});

describe('railwayAdapter.downSteps', () => {
  it('tears the service down with `railway down --yes`', () => {
    const steps = railwayAdapter.downSteps({ app: 'the-svc', port: 8080 });
    expect(steps.map((s) => s.command)).toEqual([['railway', 'down', '--yes']]);
    expect(steps[0].outward).toBe(true);
  });
});
