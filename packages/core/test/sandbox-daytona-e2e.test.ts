// M1 — the credential-gated CLOUD e2e: ONE node in a REAL Daytona VM produces its artifact via a REAL
// model call. Covers BOTH provider shapes:
//   • a BUILT-IN provider (anthropic/deepseek/…) — pi reads `<PROVIDER>_API_KEY`; M1 forwards it via the
//     cloud allowlist (`cloudSecrets`).
//   • a CUSTOM gateway (mmgw/nebius/…) — defined ONLY in the host's `~/.pi/agent/models.json`; M1b stages
//     that entry into the VM (`stageHome`) so pi resolves `--provider <gw>` there, and forwards the entry's
//     `$VAR` key (or, for a literal-key gateway, the key rides IN the staged config — no env var needed).
// M1c lets the VM boot from a pre-built SNAPSHOT (the promoted `piflow-node-runtime`), not just a raw image.
//
// This is the stronger proof above the units: pi boots in the remote VM, makes a real model call, and writes
// the declared artifact, which the runner collects back to the host. Asserts on the WRITTEN ARTIFACT + the
// run verdict, never on prose.
//
// GATE: a real VM costs money + needs a real account, so it never runs in a default `vitest run`. Opt in:
//   built-in:  DAYTONA_API_KEY=… DAYTONA_SNAPSHOT=piflow-node-runtime-0-80-2 ANTHROPIC_API_KEY=… PIFLOW_E2E=1 \
//              npx vitest run packages/core/test/sandbox-daytona-e2e.test.ts
//   mmgw:      DAYTONA_API_KEY=… DAYTONA_SNAPSHOT=piflow-node-runtime-0-80-2 PIFLOW_E2E=1 \
//              PIFLOW_E2E_PROVIDER=mmgw PIFLOW_E2E_MODEL=MiniMax-M3 npx vitest run …

import { describe, it, expect } from 'vitest';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compile, runWorkflow, defaultSecretResolver } from '../src/index.js';
import { createDaytonaProvider } from '../src/sandbox/daytona-sdk.js';
import type { WorkflowSpec } from '../src/index.js';

const DAYTONA_KEY = process.env.DAYTONA_API_KEY;
const E2E_PROVIDER = process.env.PIFLOW_E2E_PROVIDER ?? 'anthropic';
const E2E_MODEL = process.env.PIFLOW_E2E_MODEL ?? 'claude-3-5-haiku-latest';
// Optional: a built-in provider's key env var to forward. A custom gateway with a $VAR key sets this from its
// models.json entry; a literal-key gateway (mmgw) needs NONE (the key rides in the staged config).
const E2E_CRED_VAR = process.env.PIFLOW_E2E_CRED_VAR;
// Boot from a pre-built snapshot (preferred) or a raw image ref — at least one must be set.
const E2E_SNAPSHOT = process.env.DAYTONA_SNAPSHOT;
const E2E_IMAGE = process.env.DAYTONA_IMAGE;

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

const SENTINEL = 'piflow-daytona-m1-ok';
function oneNodeSpec(): WorkflowSpec {
  return {
    meta: { name: 'daytona-m1-e2e', description: 'one node, real model call in a real VM' },
    nodes: [
      {
        label: 'write-result',
        prompt: `Write exactly the text "${SENTINEL}" (no quotes, no other text) to the file out/result.txt, then submit your result.`,
        tools: { allow: ['fs:write', 'contract:submit_result'], deny: ['bash'] },
        io: { reads: [], produces: ['out/result.txt'], artifacts: [{ path: 'out/result.txt' }] },
      },
    ],
  };
}

const stage = piProviderStage(E2E_PROVIDER);
// The cred var to forward: explicit override, else the gateway entry's first $VAR (built-ins use ANTHROPIC_…).
const credVar = E2E_CRED_VAR ?? (stage.stageHome ? stage.credVars[0] : 'ANTHROPIC_API_KEY');
const bootRef = E2E_SNAPSHOT ?? E2E_IMAGE;
// Opt-in: a Daytona key, a boot ref, PIFLOW_E2E, AND the model key is reachable (a literal-key gateway needs
// no env var — the key is in the staged config; otherwise the env var must be present).
const keyReachable = stage.stageHome ? (!credVar || !!process.env[credVar]) : !!process.env[credVar ?? ''];
const optedIn = !!DAYTONA_KEY && !!bootRef && !!process.env.PIFLOW_E2E && keyReachable;

describe('daytona cloud e2e — ONE node makes a REAL model call in a REAL VM (gated)', () => {
  if (!optedIn) {
    const missing = [
      !DAYTONA_KEY && 'DAYTONA_API_KEY',
      !bootRef && 'DAYTONA_SNAPSHOT|DAYTONA_IMAGE',
      !process.env.PIFLOW_E2E && 'PIFLOW_E2E=1',
      !keyReachable && `the ${E2E_PROVIDER} model key (${credVar ?? 'env var'} or a literal in models.json)`,
    ].filter(Boolean).join(', ');
    it.skip(`SKIPPED — needs ${missing}`, () => {});
  }

  it.skipIf(!optedIn)(
    `boots one node in a real VM (${E2E_PROVIDER}/${E2E_MODEL}, boot=${E2E_SNAPSHOT ? 'snapshot' : 'image'}); writes out/result.txt back to the host`,
    async () => {
      const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-daytona-e2e-'));
      // EXACTLY what the CLI's `--sandbox daytona` branch constructs: snapshot|image, the staged custom-gateway
      // config (M1b), the bill-guard autoStop, and the cloud key allowlist (M1).
      const provider = createDaytonaProvider({
        ...(E2E_SNAPSHOT ? { snapshot: E2E_SNAPSHOT } : {}),
        ...(E2E_IMAGE ? { image: E2E_IMAGE } : {}),
        apiKey: DAYTONA_KEY,
        autoStopInterval: 5,
        ...(stage.stageHome ? { stageHome: stage.stageHome } : {}),
      });

      const result = await runWorkflow(compile(oneNodeSpec()), {
        run: 'daytona-m1',
        outDir,
        provider,
        providerName: E2E_PROVIDER,
        model: E2E_MODEL,
        recordEvents: true,
        // Forward the provider key into the VM (when there IS an env-var key). A literal-key gateway omits this
        // — the key is already in the staged models.json.
        ...(credVar && process.env[credVar] ? { cloudSecrets: [credVar], secretResolver: defaultSecretResolver } : {}),
        nodeTimeoutMs: 180_000,
      });

      const artifact = path.join(outDir, 'out', 'result.txt');
      expect(existsSync(artifact), `expected collected artifact at ${artifact}`).toBe(true);
      expect(await fs.readFile(artifact, 'utf8')).toContain(SENTINEL);
      expect(result.status.ok).toBe(true);
      expect(result.status.nodes['write-result'].status).toBe('ok');

      await fs.rm(outDir, { recursive: true, force: true });
    },
    600_000,
  );
});
