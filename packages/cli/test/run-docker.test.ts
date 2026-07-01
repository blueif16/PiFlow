// The `--sandbox docker` CLI branch (no Docker daemon, no real container).
//
// Mirrors run-daytona.test.ts: `docker` is a LOCAL-container branch that, exactly like the cloud VMs,
//   (a) constructs a Docker provider (kind 'docker') via the injectable `makeDockerProvider` factory (the
//       real factory reads DOCKER_IMAGE from env + dynamically imports @piflow/docker; the test injects a
//       fake so NO real daemon/container is touched), and
//   (b) threads a `cloudSecrets` allowlist (the provider gateway env var) + a default `secretResolver` into
//       `runFromTemplate` — because a container inherits NO host env (docker is a CLOUD_KIND), so the pi
//       gateway key must cross on the SAME allowlist as the cloud VMs and MCP creds.
//
// These FAIL if the docker branch is removed (no provider, or the wrong kind) or if the provider-cred var
// is not forwarded (cloudSecrets missing/empty) — the load-bearing bar for a CLOUD_KIND run locally.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTemplate, parseRunArgs, type RunDeps } from '../src/run.js';
import type { RunFromTemplateOpts, SandboxProvider } from '@piflow/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../core/test/fixtures/template-min');

let TEMPLATE_MIN: string;
let OUT: string;
beforeAll(async () => {
  TEMPLATE_MIN = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-docker-tpl-'));
  await fs.cp(FIXTURE, TEMPLATE_MIN, { recursive: true });
  OUT = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-docker-out-'));
});
afterAll(async () => {
  await fs.rm(TEMPLATE_MIN, { recursive: true, force: true });
  await fs.rm(OUT, { recursive: true, force: true });
});

// A minimal fake provider with kind 'docker' — stands in for createDockerProvider so no real daemon/
// container is constructed. The branch under test calls the injected factory and threads its result.
function fakeDockerProvider(opts: { image?: string }): SandboxProvider {
  return { kind: 'docker', __opts: opts } as unknown as SandboxProvider;
}

describe('parseRunArgs — docker surface', () => {
  it('accepts --sandbox docker', () => {
    expect(parseRunArgs([TEMPLATE_MIN, '--sandbox', 'docker']).sandbox).toBe('docker');
  });
});

describe('piflowctl run — --sandbox docker constructs a local-container provider and forwards the gateway cred', () => {
  it('builds a kind:"docker" provider via the injected factory and threads it into runFromTemplate', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    let factoryOpts: { image?: string } | undefined;
    const deps: RunDeps = {
      makeDockerProvider: async (o) => {
        factoryOpts = o;
        return fakeDockerProvider(o);
      },
      runFromTemplate: async (_dir, opts) => {
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      print: () => {},
    };
    await runTemplate(
      { templateDir: TEMPLATE_MIN, dryRun: false, run: 'gdock', args: {}, outDir: OUT, sandbox: 'docker', provider: 'anthropic' },
      deps,
    );
    // THE load-bearing branch assertion: a provider of kind 'docker' is constructed and passed.
    expect(optsSeen?.provider).toBeDefined();
    expect((optsSeen?.provider as { kind?: string } | undefined)?.kind).toBe('docker');
    expect(factoryOpts).toBeDefined(); // the docker factory was actually invoked (not the local one)
  });

  it('derives the provider-cred allowlist from --provider and forwards it as cloudSecrets (+ a default secretResolver)', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    const deps: RunDeps = {
      makeDockerProvider: async (o) => fakeDockerProvider(o),
      runFromTemplate: async (_dir, opts) => {
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      print: () => {},
    };
    await runTemplate(
      { templateDir: TEMPLATE_MIN, dryRun: false, run: 'gdock2', args: {}, outDir: OUT, sandbox: 'docker', provider: 'anthropic' },
      deps,
    );
    // provider 'anthropic' ⇒ ANTHROPIC_API_KEY joins the allowlist (a container has no host env). Drop the
    // forwarding ⇒ this goes red. A default secretResolver is threaded (host-side process.env read).
    expect(optsSeen?.cloudSecrets).toContain('ANTHROPIC_API_KEY');
    expect(optsSeen?.secretResolver).toBeDefined();
  });

  it('an explicit --cloud-secret NAME overrides the provider-derived var', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    const deps: RunDeps = {
      makeDockerProvider: async (o) => fakeDockerProvider(o),
      runFromTemplate: async (_dir, opts) => {
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      print: () => {},
    };
    await runTemplate(
      {
        templateDir: TEMPLATE_MIN, dryRun: false, run: 'gdock3', args: {}, outDir: OUT,
        sandbox: 'docker', provider: 'anthropic', cloudSecret: 'NEBIUS_API_KEY',
      },
      deps,
    );
    expect(optsSeen?.cloudSecrets).toContain('NEBIUS_API_KEY');
  });
});
