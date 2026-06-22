// The connection pool. One MCP `Client` per server name, connected LAZILY on first use and REUSED across
// every `callTool` in the process (case 6 proves single-connect). Built on the verified
// @modelcontextprotocol/sdk@1.29.0 surface:
//   Client            — '@modelcontextprotocol/sdk/client/index.js' · new Client({name,version}); connect(transport); close()
//   StdioClientTransport       — '@modelcontextprotocol/sdk/client/stdio.js' · { command, args?, env?, cwd? }
//   StreamableHTTPClientTransport — '@modelcontextprotocol/sdk/client/streamableHttp.js' · new (URL, { requestInit:{headers} })
// (The 'inMemory' config variant hands us a pre-built Transport directly — used by tests and any host
// that wants to attach an in-process server.)

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { BridgeError } from './errors.js';
import type { McpServerConfig } from './types.js';

/** Identity the bridge presents to every MCP server it connects to. */
const CLIENT_INFO = { name: '@piflow/tool-bridge', version: '0.0.0' } as const;

/** A connected (or connecting) client, keyed by server name. The connect promise dedupes concurrent first-use. */
interface PooledClient {
  client: Client;
  /** Resolves once the client is connected; awaited by every caller so we connect EXACTLY once. */
  ready: Promise<void>;
}

const pool = new Map<string, PooledClient>();

/** Build the SDK transport described by a server's config. */
function makeTransport(server: string, cfg: McpServerConfig): Transport {
  switch (cfg.transport) {
    case 'stdio':
      return new StdioClientTransport({ command: cfg.command, args: cfg.args, env: cfg.env, cwd: cfg.cwd });
    case 'http':
      return new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      });
    case 'inMemory':
      return cfg.transportInstance;
    default: {
      // Exhaustiveness guard — a new transport kind must extend this switch.
      const _never: never = cfg;
      throw new BridgeError('unknown-server', `server ${JSON.stringify(server)} has an unsupported transport`, {
        cause: _never,
      });
    }
  }
}

/**
 * Get the connected client for `server`, connecting (once) on first use and reusing the cached client
 * thereafter. Concurrent first calls share one connect via the stored `ready` promise.
 */
export async function getClient(server: string, cfg: McpServerConfig): Promise<Client> {
  let pooled = pool.get(server);
  if (!pooled) {
    const client = new Client(CLIENT_INFO);
    const transport = makeTransport(server, cfg);
    const ready = client.connect(transport).catch((cause) => {
      // A failed connect must not poison the pool — drop it so a later call can retry.
      pool.delete(server);
      throw new BridgeError('connect-failed', `failed to connect to MCP server ${JSON.stringify(server)}`, { cause });
    });
    pooled = { client, ready };
    pool.set(server, pooled);
  }
  await pooled.ready;
  return pooled.client;
}

/** Close every cached client and empty the pool. Best-effort: a close error never masks others. */
export async function disposeClients(): Promise<void> {
  const entries = [...pool.values()];
  pool.clear();
  await Promise.allSettled(entries.map((p) => p.ready.then(() => p.client.close()).catch(() => undefined)));
}
