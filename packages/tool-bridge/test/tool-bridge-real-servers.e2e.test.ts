// REAL-SERVER e2e for @piflow/tool-bridge. The inMemory suite proves the client→transport→server path
// but ONLY over an in-process pipe; it never exercises makeTransport()'s `stdio` and `http` branches.
// These tests do — by driving callTool against REAL, published, keyless MCP servers (the official
// reference servers an OpenClaw gateway itself consumes over `mcp.servers`), NOT a hand-rolled in-test
// server. So a green run is evidence the bridge wires an ARBITRARY real MCP server over real stdio and
// real Streamable HTTP, across genres.
//
// Servers under test (devDependencies, no API keys, no network):
//   @modelcontextprotocol/server-everything — echo / get-sum; runs BOTH stdio and streamableHttp
//   @modelcontextprotocol/server-memory      — read_graph (knowledge-graph genre); stdio
//
// These SPAWN real child processes (and bind a TCP port for the HTTP case), so they carry generous
// timeouts and explicit teardown. They are kept in their own file so the offline inMemory suite stays
// pure.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

import { callTool, configureBridge, disposeBridge } from '../src/index.js';

const require = createRequire(import.meta.url);
// Resolve each server's entry from the installed package — robust to the package's own bin wiring.
const EVERYTHING = require.resolve('@modelcontextprotocol/server-everything/dist/index.js');
const MEMORY = require.resolve('@modelcontextprotocol/server-memory/dist/index.js');

/** Flatten a PiToolResult's text content blocks. */
function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');
}

afterEach(async () => {
  await disposeBridge();
});

// ── stdio transport: a REAL spawned MCP server over the bridge's StdioClientTransport branch ─────────
describe('real MCP servers over stdio (makeTransport stdio branch)', () => {
  it('echoes through a REAL spawned server-everything', async () => {
    configureBridge({ servers: { everything: { transport: 'stdio', command: 'node', args: [EVERYTHING, 'stdio'] } } });

    const r = await callTool('mcp.everything:echo', { message: 'over-stdio' });

    expect(textOf(r)).toContain('Echo: over-stdio');
    expect(r.isError).toBeFalsy();
  }, 30_000);

  it('passes structured numeric args to a REAL tool (get-sum)', async () => {
    configureBridge({ servers: { everything: { transport: 'stdio', command: 'node', args: [EVERYTHING, 'stdio'] } } });

    const r = await callTool('mcp.everything:get-sum', { a: 2, b: 40 });

    expect(textOf(r)).toContain('42');
  }, 30_000);

  it('wires a DIFFERENT real server + genre — server-memory read_graph', async () => {
    configureBridge({
      servers: {
        mem: {
          transport: 'stdio',
          command: 'node',
          args: [MEMORY],
          // Keep the graph file out of node_modules; PATH etc. ride along so `node` resolves.
          env: { ...process.env, MEMORY_FILE_PATH: `/tmp/piflow-mem-${process.pid}.json` } as Record<string, string>,
        },
      },
    });

    const r = await callTool('mcp.mem:read_graph', {});
    const graph = JSON.parse(textOf(r));

    expect(graph).toHaveProperty('entities');
    expect(graph).toHaveProperty('relations');
  }, 30_000);
});

// ── Streamable HTTP transport: the SAME real server over the bridge's StreamableHTTPClientTransport ───
describe('real MCP server over Streamable HTTP (makeTransport http branch)', () => {
  let http: ChildProcess | undefined;
  let port = 0;

  beforeAll(async () => {
    http = spawn('node', [EVERYTHING, 'streamableHttp'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    // The server prints "…listening on port <N>" once ready — wait for it and capture the port.
    port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server-everything (streamableHttp) did not start in time')), 15_000);
      const onData = (d: Buffer) => {
        const m = String(d).match(/listening on port (\d+)/i);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      };
      http!.stdout?.on('data', onData);
      http!.stderr?.on('data', onData);
      http!.once('error', reject);
    });
  }, 20_000);

  afterAll(() => {
    http?.kill();
  });

  it('echoes through a REAL server-everything over Streamable HTTP', async () => {
    configureBridge({ servers: { everything: { transport: 'http', url: `http://127.0.0.1:${port}/mcp` } } });

    const r = await callTool('mcp.everything:echo', { message: 'over-http' });

    expect(textOf(r)).toContain('Echo: over-http');
    expect(r.isError).toBeFalsy();
  }, 30_000);
});
