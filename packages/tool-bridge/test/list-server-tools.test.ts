// Unit test for @piflow/tool-bridge `listServerTools` — the REAL `tools/list` client. Like the rest of
// the bridge suite this is EXTERNAL-API GLUE, so it runs against a REAL in-process MCP server (McpServer)
// connected to the bridge's real Client over the SDK's InMemoryTransport pair — NO mocks, NO stubbed
// client. The call traverses the real client → transport → server → `tools/list` path; only the wire is
// in-memory. It proves the listing comes back with the right names/descriptions/inputSchema.

import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import { listServerTools, disposeBridge } from '../src/index.js';
import type { McpServerConfig } from '../src/types.js';

// ── A real in-process MCP server with two tools (one with an inputSchema). Returns the CLIENT-side
//    transport to hand the bridge as an `inMemory` server config. ──
async function standUpServer(): Promise<{ clientTransport: Transport; close: () => Promise<void> }> {
  const server = new McpServer({ name: 'list-demo', version: '1.0.0' });

  // echo: carries a description AND an inputSchema (a single required string).
  server.registerTool(
    'echo',
    { description: 'Echo a message back', inputSchema: { msg: z.string() } },
    async ({ msg }) => ({ content: [{ type: 'text', text: `echo:${msg}` }] }),
  );

  // ping: a description but NO declared inputSchema fields.
  server.registerTool('ping', { description: 'Liveness ping' }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { clientTransport, close: () => server.close() };
}

afterEach(async () => {
  await disposeBridge();
});

describe('listServerTools — real tools/list over the in-memory transport', () => {
  it('returns the server`s tools with the right name/description/inputSchema', async () => {
    const h = await standUpServer();
    const config: McpServerConfig = { transport: 'inMemory', transportInstance: h.clientTransport };

    const tools = await listServerTools('list-demo', config);

    const byName = new Map(tools.map((t) => [t.name, t]));
    expect([...byName.keys()].sort()).toEqual(['echo', 'ping']);

    const echo = byName.get('echo')!;
    expect(echo.description).toBe('Echo a message back');
    // The inputSchema comes back as the JSON Schema the server declared — an object with a `msg` property.
    expect(echo.inputSchema).toMatchObject({
      type: 'object',
      properties: { msg: { type: 'string' } },
    });

    const ping = byName.get('ping')!;
    expect(ping.description).toBe('Liveness ping');

    await h.close();
  });
});
