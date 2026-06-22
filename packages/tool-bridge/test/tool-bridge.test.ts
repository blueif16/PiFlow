// End-to-end tests for @piflow/tool-bridge. These are EXTERNAL-API GLUE, so per test-discipline they
// run against a REAL in-process MCP server (McpServer) connected to the bridge's real Client over the
// SDK's InMemoryTransport pair — NOT mocks of callTool or a stubbed client. The call traverses the real
// client → transport → server → handler path every time.

import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import { callTool, configureBridge, disposeBridge, BridgeError } from '../src/index.js';

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

  it('throws the unsupported-address error for a non-mcp. address', async () => {
    configureBridge({ servers: {} });

    await expect(callTool('web:search', { q: 'x' })).rejects.toThrow(BridgeError);
    await expect(callTool('web:search', { q: 'x' })).rejects.toThrow(/unsupported address/i);
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
