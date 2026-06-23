// REAL OpenClaw gateway e2e for the oc.* lane. The gateway-coupled catalog tools (memory_get,
// file_fetch, …) can't run under bare `pi -e` — they execute INSIDE OpenClaw's runtime. The design
// routes `oc.<plugin>:<tool>` → the reserved `openclaw` MCP server, which a host points at OpenClaw's
// STANDALONE plugin-tool MCP server: `openclaw/dist/mcp/plugin-tools-serve.js` (NOT the CLI
// `openclaw mcp serve`, which bridges chat CHANNELS, not plugin tools). This test drives that real path:
// spawn plugin-tools-serve over stdio, call a REAL keyless OpenClaw tool (`memory_get`) through OUR
// bridge's oc.* lane, and assert it executed inside OpenClaw.
//
// openclaw is ~86 MB, so it is NOT a pinned devDependency — this suite SKIPS unless it is installed:
//   npm i --no-save openclaw@2026.6.9
// (memory_search needs an embeddings key; memory_get is keyless — so we exercise memory_get.)

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { callTool, configureBridge, disposeBridge, OPENCLAW_SERVER } from '../src/index.js';

const require = createRequire(import.meta.url);

/**
 * Locate the standalone plugin-tool MCP server, or undefined when openclaw isn't installed. openclaw's
 * `exports` map forbids resolving deep subpaths directly, so resolve the allowed main export and derive
 * the file from its package dir (dist/index.js → dist/mcp/plugin-tools-serve.js).
 */
function resolveServe(): string | undefined {
  try {
    const main = require.resolve('openclaw'); // '.' export → <pkg>/dist/index.js
    const serve = path.join(path.dirname(main), 'mcp', 'plugin-tools-serve.js');
    return existsSync(serve) ? serve : undefined;
  } catch {
    return undefined;
  }
}
const SERVE = resolveServe();

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');
}

describe.skipIf(!SERVE)('oc.* lane against the REAL OpenClaw plugin-tools-serve gateway', () => {
  let home: string;

  beforeAll(async () => {
    // Build the child's env from ours, then make it look like a NON-test, fully isolated environment:
    //   1. STRIP test-harness markers (VITEST*, JEST_WORKER_ID, NODE_ENV=test). OpenClaw's plugin loader
    //      detects a test harness and deliberately loads ZERO plugins — inheriting our `VITEST=true` is
    //      why a naive spawn reports "no plugin tools found".
    //   2. Pin OPENCLAW_HOME/STATE_DIR AND OPENCLAW_CONFIG_PATH at a temp dir — the config path resolves
    //      separately (defaults to ~/.openclaw/openclaw.json), so all three are needed for isolation.
    // With no config present, plugin-tools-serve then loads its default plugin set (incl. memory_get).
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-oc-'));
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k.startsWith('VITEST') || k === 'JEST_WORKER_ID') continue;
      if (k === 'NODE_ENV' && v === 'test') continue;
      childEnv[k] = v;
    }
    childEnv.OPENCLAW_HOME = home;
    childEnv.OPENCLAW_STATE_DIR = home;
    childEnv.OPENCLAW_CONFIG_PATH = path.join(home, 'openclaw.json');

    configureBridge({
      servers: {
        [OPENCLAW_SERVER]: {
          transport: 'stdio',
          command: 'node',
          args: [SERVE as string],
          env: childEnv,
        },
      },
    });
  }, 30_000);

  afterAll(async () => {
    await disposeBridge();
    if (home) await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  afterEach(() => {
    /* keep the single pooled connection across cases (no disposeBridge here) */
  });

  it('executes oc.memory-core:memory_get inside the real OpenClaw runtime (raw bare tool name on the wire)', async () => {
    const r = await callTool('oc.memory-core:memory_get', { path: 'MEMORY.md' });

    // It reached OpenClaw and ran: not an error, and the structured return echoes the requested path.
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(r));
    expect(parsed).toHaveProperty('path', 'MEMORY.md');
  }, 30_000);
});
