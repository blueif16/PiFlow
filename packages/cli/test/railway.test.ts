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
  it('emits the runbook order: copy-dockerignore → secrets-set → deploy → domain → rm-dockerignore', () => {
    expect(railwayAdapter.upSteps(ctx()).map((s) => s.id)).toEqual([
      'copy-dockerignore',
      'secrets-set',
      'deploy',
      'domain',
      'rm-dockerignore',
    ]);
  });

  it('the secrets-set step shapes each pair as `railway variables --set K=V` (real values in the command)', () => {
    const set = railwayAdapter.upSteps(ctx()).find((s) => s.id === 'secrets-set')!;
    expect(set.command).toEqual([
      'railway',
      'variables',
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

  it('the deploy step is the paid one and WAITS for the build (no --detach) so the smoke never fires mid-build', () => {
    const deploy = railwayAdapter.upSteps(ctx()).find((s) => s.id === 'deploy')!;
    expect(deploy.paid).toBe(true);
    expect(deploy.outward).toBe(true);
    // NO `--detach`: `railway up` must block until the deploy completes (and exit non-zero on a build failure),
    // else the immediately-following smoke hits a not-yet-live service. (design: readiness before smoke.)
    expect(deploy.command).toEqual(['railway', 'up', '--service', 'the-svc']);
    expect(deploy.command).not.toContain('--detach');
    // the SAME control-vm Dockerfile is targeted via RAILWAY_DOCKERFILE_PATH (no image change across hosts)
    expect(deploy.env).toEqual({ RAILWAY_DOCKERFILE_PATH: 'deploy/control-vm/Dockerfile' });
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
