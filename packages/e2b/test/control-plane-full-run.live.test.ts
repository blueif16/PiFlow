// L3 (LIVE) — the control-plane full-run tier that ACTUALLY boots a real e2b worker + a real model and
// asserts the greet deliverable. It closes the "L3 exercises nothing new" gap: the vitest-native twin of
// deploy/control-vm/smoke-live.mjs's D-check. A single greet node runs in a REAL E2B Firecracker VM under
// `pi` + a real (non-Claude) model, writes out/greet/greeting.txt, the runner collects it to the host, and an
// INDEPENDENT post-hoc fs probe (a fresh readFileSync at the contract path — NOT view.artifacts[].exists)
// asserts the bytes. Its teeth: an N-breach output-collection regression (prefix stripped → file lands at bare
// greeting.txt), a template that can't run pi, or a worker that never boots ALL red this — none of which the
// fake-backend L1 twin (nbreach-parity.test.ts, FakeE2bSdk) can catch.
//
// GATE: a real VM + real model call costs money, so it NEVER runs in a default `vitest run`. It is binned to
// the `live` project (vitest.config.ts LIVE[]) and self-skips unless opted in. Opt in (M3/mmgw shown — the
// same provider the live Railway smoke proved):
//   E2B_API_KEY=… E2B_TEMPLATE=riwrtwrfanz3tewd5pw6 PIFLOW_E2E=1 \
//   PIFLOW_E2E_PROVIDER=mmgw PIFLOW_E2E_MODEL=MiniMax-M3 \
//   npx vitest run --project live packages/e2b/test/control-plane-full-run.live.test.ts
//
// Reuse: piProviderStage() mirrors the CLI's parsePiProvider + is copied byte-faithful from
// sandbox-daytona-e2e.test.ts (module-local there, the standard reuse-by-copy for these live harnesses).

import { describe, it, expect } from 'vitest';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compile, runWorkflow, defaultSecretResolver } from '@piflow/core';
import type { WorkflowSpec } from '@piflow/core';
import { createE2bProvider } from '@piflow/e2b';

const E2B_KEY = process.env.E2B_API_KEY;
const E2B_TEMPLATE = process.env.E2B_TEMPLATE; // the pi-baked template id (deploy/e2b/build.md) — no `base` fallback for a real run
const E2E_PROVIDER = process.env.PIFLOW_E2E_PROVIDER ?? 'mmgw';
const E2E_MODEL = process.env.PIFLOW_E2E_MODEL ?? 'MiniMax-M3';
// Optional: a built-in provider's key env var to forward. A custom gateway with a $VAR key sets this from its
// models.json entry; a literal-key gateway (mmgw) needs NONE (the key rides in the staged config).
const E2E_CRED_VAR = process.env.PIFLOW_E2E_CRED_VAR;

/**
 * Stage a CUSTOM gateway's `~/.pi/agent/models.json` entry into the VM (mirrors the CLI's parsePiProvider):
 * scope to the selected provider + extract its `$VAR` cred refs. A built-in provider has no entry → no stage.
 */
function piProviderStage(provider: string): { stageHome?: Record<string, string>; credVars: string[] } {
  try {
    const m = JSON.parse(readFileSync(path.join(os.homedir(), '.pi', 'agent', 'models.json'), 'utf8')) as {
      providers?: Record<string, unknown>;
    };
    const entry = m?.providers?.[provider];
    if (!entry || typeof entry !== 'object') return { credVars: [] };
    const refs = new Set<string>();
    const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
    const scan = (v: unknown): void => {
      if (typeof v === 'string') for (const x of v.matchAll(re)) refs.add(x[1] ?? x[2]);
      else if (Array.isArray(v)) v.forEach(scan);
      else if (v && typeof v === 'object') Object.values(v).forEach(scan);
    };
    scan(entry);
    return { stageHome: { '.pi/agent/models.json': JSON.stringify({ providers: { [provider]: entry } }) }, credVars: [...refs] };
  } catch {
    return { credVars: [] };
  }
}

const SENTINEL = 'CONTROL-VM-OK';
const ARTIFACT = 'out/greet/greeting.txt';
// The greet contract from deploy/control-vm/e2e-template/nodes/greet: artifacts=[out/greet/greeting.txt],
// output="." (identity collection — the N-breach parity config), write+submit only (no bash).
function greetSpec(): WorkflowSpec {
  return {
    meta: { name: 'control-plane-full-run-e2e', description: 'one greet node, real model call in a real e2b VM' },
    nodes: [
      {
        label: 'greet',
        prompt: `Write exactly the text "${SENTINEL}" (no quotes, no other text) to the file ${ARTIFACT}, then submit your result.`,
        tools: { allow: ['fs:write', 'contract:submit_result'], deny: ['bash'] },
        io: { reads: [], produces: [ARTIFACT], artifacts: [{ path: ARTIFACT }] },
        sandbox: { output: '.' },
      },
    ],
  };
}

const stage = piProviderStage(E2E_PROVIDER);
// The cred var to forward: explicit override, else the gateway entry's first $VAR (a literal-key gateway has none).
const credVar = E2E_CRED_VAR ?? (stage.stageHome ? stage.credVars[0] : undefined);
// A literal-key gateway needs no env var (key is in the staged config); otherwise the env var must be present.
const keyReachable = stage.stageHome ? (!credVar || !!process.env[credVar]) : !!(credVar && process.env[credVar]);
const optedIn = !!E2B_KEY && !!E2B_TEMPLATE && !!process.env.PIFLOW_E2E && keyReachable;

describe('control-plane full-run e2e — greet in a REAL e2b VM writes CONTROL-VM-OK (gated)', () => {
  if (!optedIn) {
    const missing = [
      !E2B_KEY && 'E2B_API_KEY',
      !E2B_TEMPLATE && 'E2B_TEMPLATE',
      !process.env.PIFLOW_E2E && 'PIFLOW_E2E=1',
      !keyReachable && `the ${E2E_PROVIDER} model key (${credVar ?? 'literal in models.json'})`,
    ]
      .filter(Boolean)
      .join(', ');
    it.skip(`SKIPPED — needs ${missing}`, () => {});
  }

  it.skipIf(!optedIn)(
    `boots greet in a real e2b VM (${E2E_PROVIDER}/${E2E_MODEL}); collects out/greet/greeting.txt=${SENTINEL} to the host`,
    async () => {
      const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-e2b-e2e-'));
      try {
        // EXACTLY what the CLI's `--sandbox e2b` branch constructs: the pi-baked template + the staged
        // custom-gateway config (M1b) + the cloud key allowlist (M1).
        const provider = createE2bProvider({
          apiKey: E2B_KEY,
          template: E2B_TEMPLATE,
          ...(stage.stageHome ? { stageHome: stage.stageHome } : {}),
        });

        const result = await runWorkflow(compile(greetSpec()), {
          run: 'control-plane-full-run',
          outDir,
          provider,
          providerName: E2E_PROVIDER,
          model: E2E_MODEL,
          recordEvents: true,
          // Forward the provider key into the VM (when there IS an env-var key). A literal-key gateway omits this.
          ...(credVar && process.env[credVar] ? { cloudSecrets: [credVar], secretResolver: defaultSecretResolver } : {}),
          nodeTimeoutMs: 180_000,
        });

        // (1) verdict: the run + the greet node are ok.
        expect(result.status.ok).toBe(true);
        expect(result.status.nodes.greet.status).toBe('ok');
        // (2) INDEPENDENT post-hoc probe — a fresh fs read at the contract stat path (NOT view.artifacts[].exists).
        const artifact = path.resolve(outDir, ARTIFACT);
        expect(existsSync(artifact), `expected greet artifact at ${artifact}`).toBe(true);
        expect(readFileSync(artifact, 'utf8')).toContain(SENTINEL);
        // (3) path-equality invariant (N-breach teeth): identity collection did NOT strip the out/greet/ prefix.
        expect(existsSync(path.resolve(outDir, 'greeting.txt'))).toBe(false);
      } finally {
        await fs.rm(outDir, { recursive: true, force: true });
      }
    },
    600_000,
  );
});
