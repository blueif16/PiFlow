// M1 — the `--sandbox daytona` CLI branch (no creds, no real VM).
//
// Design: docs/design/daytona-cloud-integration.md §Milestone 1 + docs/design/credential-architecture.md §4.
// The CLI handled `local`/`danger-full-access`/`inmemory` only; `daytona` is the cloud branch that
//   (a) constructs a Daytona provider (kind 'daytona') via the injectable `makeDaytonaProvider` factory
//       (the real factory reads DAYTONA_IMAGE/DAYTONA_API_KEY from env; the test injects a fake so NO real
//       SDK/VM is touched), and
//   (b) threads a cloud `cloudSecrets` allowlist (the provider gateway env var) + a default `secretResolver`
//       into `runFromTemplate`, so the pi gateway key crosses into the VM on the SAME allowlist as MCP creds.
//
// These FAIL if the daytona branch is removed (no provider, or the wrong kind) or if the provider-cred var
// is not forwarded (cloudSecrets missing/empty) — the load-bearing M1 bar.

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
  TEMPLATE_MIN = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-daytona-tpl-'));
  await fs.cp(FIXTURE, TEMPLATE_MIN, { recursive: true });
  OUT = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-daytona-out-'));
});
afterAll(async () => {
  await fs.rm(TEMPLATE_MIN, { recursive: true, force: true });
  await fs.rm(OUT, { recursive: true, force: true });
});

// A minimal fake provider with kind 'daytona' — stands in for createDaytonaProvider so no real client/VM
// is constructed. The branch under test calls the injected factory and threads its result as `provider`.
function fakeDaytonaProvider(opts: { image?: string; apiKey?: string }): SandboxProvider {
  return { kind: 'daytona', __opts: opts } as unknown as SandboxProvider;
}

describe('parseRunArgs — daytona surface', () => {
  it('accepts --sandbox daytona', () => {
    expect(parseRunArgs([TEMPLATE_MIN, '--sandbox', 'daytona']).sandbox).toBe('daytona');
  });

  it('reads an explicit --cloud-secret NAME (the provider-cred var override)', () => {
    const p = parseRunArgs([TEMPLATE_MIN, '--sandbox', 'daytona', '--cloud-secret', 'NEBIUS_API_KEY']);
    expect(p.cloudSecret).toBe('NEBIUS_API_KEY');
  });
});

describe('piflowctl run — --sandbox daytona constructs a cloud provider and forwards the gateway cred', () => {
  it('builds a kind:"daytona" provider via the injected factory and threads it into runFromTemplate', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    let factoryOpts: { image?: string; apiKey?: string } | undefined;
    const deps: RunDeps = {
      makeDaytonaProvider: async (o) => {
        factoryOpts = o;
        return fakeDaytonaProvider(o);
      },
      runFromTemplate: async (_dir, opts) => {
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      print: () => {},
    };
    await runTemplate(
      { templateDir: TEMPLATE_MIN, dryRun: false, run: 'gday', args: {}, outDir: OUT, sandbox: 'daytona', provider: 'anthropic' },
      deps,
    );
    // THE load-bearing branch assertion: a cloud provider of kind 'daytona' is constructed and passed.
    expect(optsSeen?.provider).toBeDefined();
    expect((optsSeen?.provider as { kind?: string } | undefined)?.kind).toBe('daytona');
    expect(factoryOpts).toBeDefined(); // the daytona factory was actually invoked (not the local one)
  });

  it('derives the provider-cred allowlist from --provider and forwards it as cloudSecrets (+ a default secretResolver)', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    const deps: RunDeps = {
      makeDaytonaProvider: async (o) => fakeDaytonaProvider(o),
      runFromTemplate: async (_dir, opts) => {
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      print: () => {},
    };
    await runTemplate(
      { templateDir: TEMPLATE_MIN, dryRun: false, run: 'gday2', args: {}, outDir: OUT, sandbox: 'daytona', provider: 'anthropic' },
      deps,
    );
    // provider 'anthropic' ⇒ the well-known ANTHROPIC_API_KEY joins the cloud allowlist (so pi in the VM has
    // a model credential). Drop the forwarding ⇒ this goes red.
    expect(optsSeen?.cloudSecrets).toContain('ANTHROPIC_API_KEY');
    // a default secretResolver is threaded (host-side process.env read) so the var resolves on cloud.
    expect(optsSeen?.secretResolver).toBeDefined();
  });

  it('an explicit --cloud-secret NAME overrides the provider-derived var', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    const deps: RunDeps = {
      makeDaytonaProvider: async (o) => fakeDaytonaProvider(o),
      runFromTemplate: async (_dir, opts) => {
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      print: () => {},
    };
    await runTemplate(
      {
        templateDir: TEMPLATE_MIN, dryRun: false, run: 'gday3', args: {}, outDir: OUT,
        sandbox: 'daytona', provider: 'anthropic', cloudSecret: 'NEBIUS_API_KEY',
      },
      deps,
    );
    expect(optsSeen?.cloudSecrets).toContain('NEBIUS_API_KEY');
  });

  it('the LOCAL branch never sets cloudSecrets (the gateway cred crosses only into a cloud VM)', async () => {
    let optsSeen: RunFromTemplateOpts | undefined;
    const deps: RunDeps = {
      runFromTemplate: async (_dir, opts) => {
        optsSeen = opts;
        return { status: { ok: true } as never, outDir: opts.runDir };
      },
      print: () => {},
    };
    await runTemplate(
      { templateDir: TEMPLATE_MIN, dryRun: false, run: 'gdaylocal', args: {}, outDir: OUT, sandbox: 'local', provider: 'anthropic' },
      deps,
    );
    expect(optsSeen?.cloudSecrets).toBeUndefined();
  });
});
