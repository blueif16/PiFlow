// M1 — the credential-gated CLOUD e2e: ONE node in a REAL Daytona VM produces its artifact via a REAL
// model call, with the provider gateway key injected by M1's cloud allowlist.
//
// Design: docs/design/daytona-cloud-integration.md §Milestone 2 + docs/design/credential-architecture.md §4.
// This is the stronger proof above the unit (`cloud-provider-cred.test.ts`): the unit pins that the declared
// provider var crosses the SAME SecretResolver+allowlist as MCP creds; THIS proves it end-to-end — pi boots
// in the remote VM, makes a real model call with the forwarded key, and writes the declared artifact, which
// the runner collects back to the host. It asserts on the WRITTEN ARTIFACT + the agent's OWN event stream
// (a tool_execution_end), never on prose.
//
// GATE: skipIf(!DAYTONA_API_KEY) — a real VM costs money + needs a real cloud account, so it never runs in a
// default `vitest run` (CI). The unit carries the always-on red bar.

import { describe, it, expect } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compile, runWorkflow, defaultSecretResolver } from '../src/index.js';
import { createDaytonaProvider } from '../src/sandbox/daytona-sdk.js';
import type { WorkflowSpec } from '../src/index.js';

// ── The credential gate. DAYTONA_API_KEY authorizes the VM; the provider key (ANTHROPIC_API_KEY by default)
// is the credential M1 forwards INTO the VM — both must be present for a real model call. ─────────────────
const DAYTONA_KEY = process.env.DAYTONA_API_KEY;
// A built-in pi provider (anthropic) reads its key straight from <PROVIDER>_API_KEY with NO models.json entry
// — so M1's env forwarding alone suffices. A CUSTOM gateway (cp/nebius/tokenrouter) is defined in
// ~/.pi/agent/models.json, which M1 does NOT stage into the VM — see the NEXT-MILESTONE note below.
const E2E_PROVIDER = process.env.PIFLOW_E2E_PROVIDER ?? 'anthropic';
const E2E_CRED_VAR = process.env.PIFLOW_E2E_CRED_VAR ?? 'ANTHROPIC_API_KEY';
const E2E_MODEL = process.env.PIFLOW_E2E_MODEL ?? 'claude-3-5-haiku-latest';
// The VM image ref MUST already contain pi + node (see deploy/daytona/Dockerfile). M0 built it via Daytona's
// DECLARATIVE Image builder (no registry push), so a usable image STRING ref is supplied out-of-band.
const E2E_IMAGE = process.env.DAYTONA_IMAGE;

// A minimal ONE-node workflow: the model writes a deterministic line to out/result.txt via fs:write +
// submit_result. No OpenClaw/MCP bridge — isolates the PROVIDER-CREDENTIAL path (does pi reach its model in
// the VM?) from tool-wiring. The artifact's presence on the host AFTER collection is the proof.
const SENTINEL = 'piflow-daytona-m1-ok';
function oneNodeSpec(): WorkflowSpec {
  return {
    meta: { name: 'daytona-m1-e2e', description: 'one node, real model call in a real VM' },
    nodes: [
      {
        label: 'write-result',
        prompt: `Write exactly the text "${SENTINEL}" (no quotes, no other text) to the file out/result.txt, then submit your result.`,
        tools: { allow: ['fs:write', 'contract:submit_result'], deny: ['bash'] },
        io: {
          reads: [],
          produces: ['out/result.txt'],
          artifacts: [{ path: 'out/result.txt' }],
        },
      },
    ],
  };
}

// Why this is SKIPPED even WITH DAYTONA_API_KEY until the operator opts in fully:
//   1) it bills a real VM + real model tokens, and
//   2) a usable image STRING ref (DAYTONA_IMAGE) + the provider key (E2E_CRED_VAR) must BOTH be present.
// Opt in by exporting DAYTONA_API_KEY + DAYTONA_IMAGE + the provider key, then `PIFLOW_E2E=1 vitest run`.
const optedIn =
  !!DAYTONA_KEY && !!E2E_IMAGE && !!process.env[E2E_CRED_VAR] && !!process.env.PIFLOW_E2E;

describe('daytona cloud e2e — ONE node makes a REAL model call in a REAL VM (gated)', () => {
  if (!optedIn) {
    // NEXT-MILESTONE: a CUSTOM gateway (--provider cp/nebius/tokenrouter) ALSO needs its ~/.pi/agent/models.json
    // provider entry staged INSIDE the VM (the M0 image bakes NO models.json; credential-architecture §1). M1
    // forwards only the KEY, which is sufficient for a BUILT-IN provider (anthropic/deepseek/…) that reads
    // <PROVIDER>_API_KEY directly. Staging models.json in-VM for custom gateways is a SEPARATE milestone
    // (daytona-cloud-integration §"determine whether the VM's pi also needs the models.json entry") — do NOT
    // over-build it here. This e2e is therefore written against a BUILT-IN provider and stays SKIPPED until the
    // operator supplies DAYTONA_API_KEY + DAYTONA_IMAGE + a built-in provider key + PIFLOW_E2E=1.
    const missing = [
      !DAYTONA_KEY && 'DAYTONA_API_KEY',
      !E2E_IMAGE && 'DAYTONA_IMAGE',
      !process.env[E2E_CRED_VAR] && E2E_CRED_VAR,
      !process.env.PIFLOW_E2E && 'PIFLOW_E2E=1',
    ].filter(Boolean).join(', ');
    it.skip(`SKIPPED — needs ${missing} (real VM + real model tokens; built-in provider only — custom gateways await in-VM models.json staging)`, () => {});
  }

  it.skipIf(!optedIn)(
    `boots one node in a real VM (${E2E_PROVIDER}/${E2E_MODEL}); the forwarded ${E2E_CRED_VAR} lets pi write out/result.txt back to the host`,
    async () => {
      const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-daytona-e2e-'));
      // The cloud provider — exactly what the CLI's `--sandbox daytona` branch constructs.
      const provider = createDaytonaProvider({
        image: E2E_IMAGE,
        apiKey: DAYTONA_KEY,
        autoStopInterval: 5, // bill guard: auto-stop the VM after 5 idle minutes
      });

      const result = await runWorkflow(compile(oneNodeSpec()), {
        run: 'daytona-m1',
        outDir,
        provider,
        providerName: E2E_PROVIDER,
        model: E2E_MODEL,
        recordEvents: true,
        // THE M1 SURFACE UNDER TEST: forward the provider gateway key into the VM exec env via the cloud
        // allowlist + the default host-side resolver (reads process.env[E2E_CRED_VAR]). Without this, pi in
        // the VM boots with no model credential and the node never writes the artifact.
        cloudSecrets: [E2E_CRED_VAR],
        secretResolver: defaultSecretResolver,
        nodeTimeoutMs: 180_000,
      });

      // PROOF 1 — the artifact was produced by a real model call AND collected back to the host. A node that
      // never reached its model (missing credential) produces nothing → this file is absent.
      const artifact = path.join(outDir, 'out', 'result.txt');
      expect(existsSync(artifact), `expected collected artifact at ${artifact}`).toBe(true);
      const body = await fs.readFile(artifact, 'utf8');
      expect(body).toContain(SENTINEL);

      // PROOF 2 — the run verdict is ok (the node bound its tools, executed, and satisfied its contract).
      expect(result.status.ok).toBe(true);
      expect(result.status.nodes['write-result'].status).toBe('ok');

      await fs.rm(outDir, { recursive: true, force: true });
    },
    600_000,
  );
});
