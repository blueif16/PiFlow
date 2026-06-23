// End-to-end tests for @piflow/tool-bridge. These are EXTERNAL-API GLUE, so per test-discipline they
// run against a REAL in-process MCP server (McpServer) connected to the bridge's real Client over the
// SDK's InMemoryTransport pair — NOT mocks of callTool or a stubbed client. The call traverses the real
// client → transport → server → handler path every time.

import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import { callTool, configureBridge, disposeBridge, BridgeError, OPENCLAW_SERVER } from '../src/index.js';
import { parseAddress } from '../src/address.js';
// Internal config seam (NOT re-exported from index.ts on purpose) — the env-file resolution path with
// the new `$VAR`/`${VAR}` expansion. Importing the module directly keeps the public surface unchanged.
import { resolveConfig, resetConfig, CONFIG_ENV } from '../src/config.js';
import type { McpServerConfig } from '../src/types.js';

// ── A real in-process MCP server with a couple of tools + a connect counter. ──
// Returns the CLIENT-side transport to hand the bridge, plus the live counters the tests assert on.
interface Harness {
  clientTransport: Transport;
  /** How many times the server accepted a transport connection (proves single-connect reuse). */
  connectCount: () => number;
  /** The raw tool name the server's `echo`-style handler last received a call FOR. */
  lastCalledTool: () => string | undefined;
  close: () => Promise<void>;
}

async function standUpServer(): Promise<Harness> {
  let connectCount = 0;
  let lastCalledTool: string | undefined;

  const server = new McpServer({ name: 'demo-server', version: '1.0.0' });

  // echo: returns the message back as text content + structured output.
  server.registerTool(
    'echo',
    { description: 'Echo a message back', inputSchema: { msg: z.string() } },
    async ({ msg }) => {
      lastCalledTool = 'echo';
      return { content: [{ type: 'text', text: `echo:${msg}` }], structuredContent: { echoed: msg } };
    },
  );

  // take.screenshot: a tool whose RAW MCP name carries a dot + dash. The handler records the name it
  // was actually invoked under — so a test can prove the bridge used the raw name, not a sanitized one.
  server.registerTool(
    'take.screenshot',
    { description: 'A tool whose name has a dot and dash', inputSchema: { region: z.string().optional() } },
    async () => {
      lastCalledTool = 'take.screenshot';
      return { content: [{ type: 'text', text: 'shot-taken' }] };
    },
  );

  // slow: never resolves on its own — used to exercise mid-flight abort.
  server.registerTool('slow', { description: 'Never resolves', inputSchema: {} }, async (_args, extra) => {
    await new Promise<void>((resolve) => {
      extra.signal.addEventListener('abort', () => resolve());
    });
    return { content: [{ type: 'text', text: 'should-not-reach' }] };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Count each accepted connection by wrapping the SERVER transport's start().
  const realStart = serverTransport.start.bind(serverTransport);
  serverTransport.start = async () => {
    connectCount += 1;
    return realStart();
  };

  await server.connect(serverTransport);

  return {
    clientTransport,
    connectCount: () => connectCount,
    lastCalledTool: () => lastCalledTool,
    close: () => server.close(),
  };
}

afterEach(async () => {
  await disposeBridge();
});

describe('callTool', () => {
  it('round-trips a happy-path call through the real in-memory server', async () => {
    const h = await standUpServer();
    configureBridge({ servers: { demo: { transport: 'inMemory', transportInstance: h.clientTransport } } });

    const result = await callTool('mcp.demo:echo', { msg: 'hi' });

    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('echo:hi');
    expect(result.isError).toBeFalsy();
    await h.close();
  });

  it('invokes a tool by its RAW dotted/dashed name, not a sanitized variant', async () => {
    const h = await standUpServer();
    configureBridge({ servers: { demo: { transport: 'inMemory', transportInstance: h.clientTransport } } });

    const result = await callTool('mcp.demo:take.screenshot', {});

    // The server handler records the name it was invoked under — must be the raw name.
    expect(h.lastCalledTool()).toBe('take.screenshot');
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('shot-taken');
    await h.close();
  });

  it('throws a typed error naming the missing server when it is unconfigured', async () => {
    configureBridge({ servers: {} });

    await expect(callTool('mcp.ghost:echo', {})).rejects.toThrow(BridgeError);
    await expect(callTool('mcp.ghost:echo', {})).rejects.toThrow(/ghost/);
  });

  it('throws the unsupported-address error for an address in neither family (mcp./oc.)', async () => {
    configureBridge({ servers: {} });

    // `builtin:read` is genuinely out of the bridge's scope (a pi native tool, not mcp./oc.).
    await expect(callTool('builtin:read', { q: 'x' })).rejects.toThrow(BridgeError);
    await expect(callTool('builtin:read', { q: 'x' })).rejects.toThrow(/unsupported address/i);
  });

  it('rejects/cancels the call when opts.signal is aborted', async () => {
    const h = await standUpServer();
    configureBridge({ servers: { demo: { transport: 'inMemory', transportInstance: h.clientTransport } } });

    const controller = new AbortController();
    const pending = callTool('mcp.demo:slow', {}, { signal: controller.signal });
    // Abort mid-flight.
    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toThrow();
    await h.close();
  });

  it('connects the client exactly once across two calls to the same server (reuse)', async () => {
    const h = await standUpServer();
    configureBridge({ servers: { demo: { transport: 'inMemory', transportInstance: h.clientTransport } } });

    await callTool('mcp.demo:echo', { msg: 'a' });
    await callTool('mcp.demo:echo', { msg: 'b' });

    expect(h.connectCount()).toBe(1);
    await h.close();
  });
});

// ── the `oc.<plugin>:<tool>` lane → the reserved `openclaw` MCP server + the RAW tool name ──────────
// A gateway-coupled OpenClaw tool compiles to `callTool("oc.<plugin>:<tool>", …)`. parseAddress maps it
// to the reserved `openclaw` server + the raw tool (the <plugin> is provenance only), and the bridge MUST
// send that raw name on the wire — these tests prove BOTH the parse and the real round-trip.

describe('parseAddress — the oc.<plugin>:<tool> family', () => {
  it('maps an oc address to the reserved openclaw server + the RAW tool (plugin is provenance)', () => {
    expect(parseAddress('oc.memory-core:memory_get')).toEqual({ server: 'openclaw', tool: 'memory_get' });
    // The reserved-name constant is the same one parse returns.
    expect(parseAddress('oc.firecrawl:firecrawl_search').server).toBe(OPENCLAW_SERVER);
    expect(parseAddress('oc.firecrawl:firecrawl_search').tool).toBe('firecrawl_search');
  });

  it('throws malformed-address for an oc address with no colon / no tool', () => {
    // No colon at all.
    let err: unknown;
    try { parseAddress('oc.x'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe('malformed-address');
    // Colon present but empty tail.
    expect(() => parseAddress('oc.plugin:')).toThrow(/malformed/i);
  });
});

describe('callTool — the oc.<plugin>:<tool> lane executes through the openclaw gateway', () => {
  /** A real in-process MCP server exposing a BARE `memory_get` tool, recording the raw name it is called with. */
  async function standUpOpenClawGateway(): Promise<{ clientTransport: Transport; lastCalledTool: () => string | undefined; close: () => Promise<void> }> {
    let lastCalledTool: string | undefined;
    const server = new McpServer({ name: 'openclaw-tools-serve', version: '1.0.0' });
    // tools-serve exposes the BARE tool name `memory_get` (NOT plugin-prefixed) — exactly what the oc lane must send.
    server.registerTool(
      'memory_get',
      { description: 'Read a memory entry', inputSchema: { path: z.string() } },
      async ({ path: p }) => {
        lastCalledTool = 'memory_get';
        return { content: [{ type: 'text', text: `memory:${p}` }], structuredContent: { path: p } };
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return { clientTransport, lastCalledTool: () => lastCalledTool, close: () => server.close() };
  }

  it('routes oc.memory-core:memory_get to the `openclaw` server and sends the RAW tool name', async () => {
    const gw = await standUpOpenClawGateway();
    // The host configures the gateway under the reserved server name.
    configureBridge({ servers: { [OPENCLAW_SERVER]: { transport: 'inMemory', transportInstance: gw.clientTransport } } });

    const result = await callTool('oc.memory-core:memory_get', { path: 'MEMORY.md' });

    // The gateway received the RAW bare name — NOT a plugin-prefixed (`memory-core_memory_get`) or sanitized variant.
    expect(gw.lastCalledTool()).toBe('memory_get');
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('memory:MEMORY.md');
    expect(result.isError).toBeFalsy();
    await gw.close();
  });

  it('throws unknown-server (not unsupported-address) when the `openclaw` gateway is unconfigured', async () => {
    // The oc lane is now SUPPORTED — an oc address with no openclaw server fails as a missing-server, proving
    // it got past the address gate and into resolution (a regression to unsupported-address would be caught here).
    configureBridge({ servers: {} });
    let err: unknown;
    try { await callTool('oc.memory-core:memory_get', { path: 'x' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe('unknown-server');
    expect((err as Error).message).toMatch(/openclaw/);
  });
});

// ── $VAR / ${VAR} expansion in the env-file config (the secret-porting half of gap A) ──────────────
// The runner writes `_pi/mcp.json` carrying only `$VAR` REFERENCES in secret-bearing fields; the real
// secrets ride as env vars in the spawned pi child. The bridge MUST expand those references against
// `process.env` right after JSON.parse — a literal `$VAR` must NEVER reach a server, and an unresolved
// reference must fail LOUD (distinct `missing-env`), not silently pass a bogus credential.

describe('loadEnvConfig — $VAR / ${VAR} expansion', () => {
  const SAVED = { ...process.env };
  let tmpDir: string;
  let cfgPath: string;

  /** Write a config object to a temp file and point PIFLOW_MCP_CONFIG at it (env-file resolution path). */
  async function writeConfig(servers: Record<string, unknown>): Promise<void> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-cfg-'));
    cfgPath = path.join(tmpDir, 'mcp.json');
    await fs.writeFile(cfgPath, JSON.stringify({ servers }));
    process.env[CONFIG_ENV] = cfgPath;
  }

  afterEach(async () => {
    resetConfig();
    // Restore the env to its pre-test snapshot (drop any vars a test set, restore the config var).
    for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
    Object.assign(process.env, SAVED);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('expands $VAR and ${VAR} in stdio env, http headers, url, and args from process.env', async () => {
    process.env.GH_TOKEN = 'ghp_secret123';
    process.env.SERVER_HOST = 'mcp.example.com';
    process.env.WORKDIR = '/srv/work';
    await writeConfig({
      gh: {
        transport: 'stdio',
        command: 'server',
        args: ['--root', '${WORKDIR}/sub', 'plain-arg'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '$GH_TOKEN', STATIC: 'literal' },
      },
      remote: {
        transport: 'http',
        url: 'https://${SERVER_HOST}/mcp',
        headers: { Authorization: 'Bearer $GH_TOKEN' },
      },
    });

    const cfg = resolveConfig();
    const gh = cfg.servers.gh as Extract<McpServerConfig, { transport: 'stdio' }>;
    const remote = cfg.servers.remote as Extract<McpServerConfig, { transport: 'http' }>;

    // stdio env: $VAR expanded, a literal left untouched, NO literal `$VAR` survives anywhere.
    expect(gh.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_secret123');
    expect(gh.env?.STATIC).toBe('literal');
    // args: ${VAR} expanded inline; a plain arg untouched.
    expect(gh.args).toEqual(['--root', '/srv/work/sub', 'plain-arg']);
    // http url + headers expanded.
    expect(remote.url).toBe('https://mcp.example.com/mcp');
    expect(remote.headers?.Authorization).toBe('Bearer ghp_secret123');
    // The whole resolved config must be free of any unexpanded reference.
    expect(JSON.stringify(cfg)).not.toMatch(/\$\{?[A-Za-z_]/);
  });

  it('throws a LOUD, DISTINCT missing-env error (not connect-failed/not-configured) on an unresolved reference', async () => {
    delete process.env.NOPE_TOKEN;
    await writeConfig({
      gh: { transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer $NOPE_TOKEN' } },
    });

    // Must throw at resolution time — BEFORE any transport is built — so the literal never reaches a server.
    let err: unknown;
    try {
      resolveConfig();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe('missing-env');
    // Distinct from the other resolution failures.
    expect((err as BridgeError).code).not.toBe('not-configured');
    expect((err as BridgeError).code).not.toBe('connect-failed');
    // The message names the unresolved variable so the failure is debuggable.
    expect((err as Error).message).toMatch(/NOPE_TOKEN/);
  });

  it('does NOT mangle a value that legitimately contains no reference (and an empty-string env var still counts as defined)', async () => {
    process.env.EMPTY_OK = '';
    await writeConfig({
      svc: {
        transport: 'http',
        url: 'https://host/path?q=a&b=c',
        headers: { 'X-Empty': '$EMPTY_OK', 'X-Plain': 'no-refs-here' },
      },
    });

    const cfg = resolveConfig();
    const svc = cfg.servers.svc as Extract<McpServerConfig, { transport: 'http' }>;
    expect(svc.url).toBe('https://host/path?q=a&b=c');
    // A defined-but-empty env var resolves to '' (defined ⇒ not a missing-env), not a throw.
    expect(svc.headers?.['X-Empty']).toBe('');
    expect(svc.headers?.['X-Plain']).toBe('no-refs-here');
  });
});
