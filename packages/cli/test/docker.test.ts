// The Docker host adapter — generic `docker run` the SAME control-vm image anywhere; the operator brings the
// public origin (--public-url) via their own reverse proxy / TLS (design: control-plane-hosting-uniform.md
// §4-docker). Adapters are PURE DeployStep[]/string builders — they NEVER spawn — so these tests assert
// argv/redaction with zero I/O, mirroring cloud.test.ts's fly-adapter tests.
//
// NOTE ON LOCATION: the task named `packages/cli/src/hosts/docker.test.ts`, but the repo's vitest gate only
// collects `packages/*/test/**/*.test.ts` (root vitest.config.ts `include`) — a src-colocated test would never
// run. So this file lives under test/ (where every other cli test lives) to actually gate; the adapter itself
// stays at src/hosts/docker.ts as specified.

import { describe, it, expect } from 'vitest';
import type { DeployStep } from '../src/cloud.js';
import type { HostPlanContext } from '../src/hosts/adapter.js';
import { dockerAdapter } from '../src/hosts/docker.js';

// A minimal HostPlanContext for the docker adapter. Secrets carry the bearer + a provider cred so the
// -e redaction is exercised on a real (non-empty) value.
const dockerCtx = (over: Partial<HostPlanContext> = {}): HostPlanContext => ({
  app: 'ctl',
  appUrl: 'https://ctl.example.com',
  config: '', // docker has no fly.toml
  dockerfile: 'deploy/control-vm/Dockerfile',
  port: 8080,
  token: 'BEARER',
  secrets: [
    { name: 'PIFLOW_TOKEN', value: 'BEARER' },
    { name: 'NEBIUS_API_KEY', value: 'NK' },
  ],
  ...over,
});

const stepById = (steps: DeployStep[], id: string): DeployStep => {
  const s = steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step "${id}" (got: ${steps.map((x) => x.id).join(', ')})`);
  return s;
};

// ── identity ────────────────────────────────────────────────────────────────────────────────────────
describe('dockerAdapter identity', () => {
  it('is the docker pathway and is NOT host-derived (operator must supply --public-url)', () => {
    expect(dockerAdapter.id).toBe('docker');
    expect(dockerAdapter.label).toBe('docker');
    expect(dockerAdapter.urlIsHostDerived).toBe(false);
  });
});

// ── appUrl — the operator brings the origin ───────────────────────────────────────────────────────────
describe('dockerAdapter.appUrl', () => {
  it('returns the operator-supplied publicUrl verbatim (their reverse-proxy origin)', () => {
    expect(dockerAdapter.appUrl('ctl', { publicUrl: 'https://ctl.example.com', port: 8080 })).toBe(
      'https://ctl.example.com',
    );
  });

  it('falls back to the localhost:<port> placeholder when no publicUrl is given', () => {
    expect(dockerAdapter.appUrl('ctl', { port: 9090 })).toBe('http://127.0.0.1:9090');
  });
});

// ── upSteps — build → run, argv + redaction ───────────────────────────────────────────────────────────
describe('dockerAdapter.upSteps', () => {
  it('emits build then run, in that order', () => {
    const steps = dockerAdapter.upSteps(dockerCtx());
    expect(steps.map((s) => s.id)).toEqual(['build', 'run']);
  });

  it('build uses -f <dockerfile> -t <app>:latest . (the SAME control-vm image, built locally)', () => {
    const build = stepById(dockerAdapter.upSteps(dockerCtx()), 'build');
    expect(build.command).toEqual([
      'docker',
      'build',
      '-f',
      'deploy/control-vm/Dockerfile',
      '-t',
      'ctl:latest',
      '.',
    ]);
    expect(build.display).toBe('docker build -f deploy/control-vm/Dockerfile -t ctl:latest .');
    // building locally is not an outward/paid action (unlike fly/railway deploy).
    expect(build.outward).toBe(false);
  });

  it('run detaches, names the container, publishes <port>:8080, and runs <app>:latest', () => {
    const run = stepById(dockerAdapter.upSteps(dockerCtx({ port: 9090 })), 'run');
    // structural argv: docker run -d --name ctl <-e …> -p 9090:8080 ctl:latest
    expect(run.command.slice(0, 4)).toEqual(['docker', 'run', '-d', '--name']);
    expect(run.command[4]).toBe('ctl');
    // the publish mapping is host <port> → container 8080, right before the image ref.
    expect(run.command.at(-3)).toBe('-p');
    expect(run.command.at(-2)).toBe('9090:8080');
    expect(run.command.at(-1)).toBe('ctl:latest');
    expect(run.outward).toBe(true);
  });

  it('publishes 8080:8080 at the default port', () => {
    const run = stepById(dockerAdapter.upSteps(dockerCtx()), 'run');
    expect(run.command).toContain('-p');
    const pIdx = run.command.indexOf('-p');
    expect(run.command[pIdx + 1]).toBe('8080:8080');
  });

  // THE critical property — the bearer + cred ride `docker run -e` as REAL values in the command but MUST be
  // `***` in the printable display. A mutation that leaks a value into display MUST fail this test (§4).
  it('run inlines -e NAME=VALUE with REAL values in command but *** in display', () => {
    const run = stepById(dockerAdapter.upSteps(dockerCtx()), 'run');
    // execute form carries the real secret values (docker run needs them at boot)
    expect(run.command).toContain('-e');
    expect(run.command).toContain('PIFLOW_TOKEN=BEARER');
    expect(run.command).toContain('NEBIUS_API_KEY=NK');
    // display redacts every value
    expect(run.display).toContain('PIFLOW_TOKEN=***');
    expect(run.display).toContain('NEBIUS_API_KEY=***');
  });

  it('run NEVER leaks a real secret value into the printable display', () => {
    const run = stepById(dockerAdapter.upSteps(dockerCtx()), 'run');
    expect(run.display).not.toContain('=BEARER');
    expect(run.display).not.toContain('=NK');
    expect(run.display).not.toContain('BEARER');
    expect(run.display).not.toContain('NK');
  });
});

// ── downSteps — idempotent teardown ───────────────────────────────────────────────────────────────────
describe('dockerAdapter.downSteps', () => {
  it('removes the container by name with -f, and is idempotent (already-gone is tolerated)', () => {
    const steps = dockerAdapter.downSteps({ app: 'ctl', port: 8080 });
    expect(steps.map((s) => s.id)).toEqual(['docker-rm']);
    const rm = steps[0];
    expect(rm.command).toEqual(['docker', 'rm', '-f', 'ctl']);
    expect(rm.display).toBe('docker rm -f ctl');
    expect(rm.idempotent).toBe(true);
    expect(rm.outward).toBe(true);
  });
});
