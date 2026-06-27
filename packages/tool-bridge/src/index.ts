// @piflow/tool-bridge — the MCP transport RUNTIME the generated pi `-e` extension imports.
//
// The compiler (packages/core tools/compile.ts) emits, per outside tool:
//     import { callTool } from "@piflow/tool-bridge";
//     async execute(toolCallId, params, signal) {
//       return callTool("mcp.github:create_issue", params, { toolCallId, signal });
//     }
// So `callTool` is the fixed call site: parse the `mcp.<server>:<tool>` address, look up the server's
// config, lazily connect+cache an MCP Client, perform the JSON-RPC `tools/call` with the RAW tool name,
// and map the MCP result back to pi's tool-execute shape ({ content[], details?, isError? }).

import { parseAddress } from './address.js';
import { getClient, disposeClients } from './clients.js';
import { resetConfig, resolveConfig } from './config.js';
import { BridgeError } from './errors.js';
import type { McpServerConfig, McpToolListing, PiContentBlock, PiToolResult } from './types.js';

export { BridgeError } from './errors.js';
export type { BridgeErrorCode } from './errors.js';
export { configureBridge } from './config.js';
export { CONFIG_ENV } from './config.js';
// The reserved server name every `oc.<plugin>:<tool>` address routes to — re-exported so hosts/the runner
// can reference the key under which they must configure the OpenClaw gateway in their mcpConfig.servers.
export { OPENCLAW_SERVER } from './address.js';
export type { BridgeConfig, McpServerConfig, McpToolListing, PiContentBlock, PiToolResult } from './types.js';

/** Per-call options. Matches the generated `execute(toolCallId, params, signal)` call site. */
export interface CallToolOpts {
  /** pi's tool-call id (forwarded for tracing; the MCP `tools/call` has no slot for it today). */
  toolCallId?: string;
  /** Cancellation — aborting it cancels the in-flight `tools/call`. */
  signal?: AbortSignal;
}

/** The shape of an MCP `tools/call` result we read (CallToolResultSchema — content + optional extras). */
interface McpCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

/** Map an MCP `tools/call` result onto pi's tool-execute result. Content passes through verbatim. */
function mapResult(raw: McpCallResult): PiToolResult {
  const content = Array.isArray(raw.content) ? (raw.content as PiContentBlock[]) : [];
  const result: PiToolResult = { content };
  if (raw.structuredContent !== undefined) result.details = raw.structuredContent;
  if (raw.isError !== undefined) result.isError = raw.isError;
  return result;
}

/**
 * Call a bridged tool by its address and return a pi tool-execute result. Two address families:
 * `mcp.<server>:<tool>` (a plain MCP tool) and `oc.<plugin>:<tool>` (a gateway-coupled OpenClaw tool,
 * routed to the reserved `openclaw` server with its raw tool name) — see {@link parseAddress}.
 *
 * @param address `mcp.<server>:<tool>` or `oc.<plugin>:<tool>` — the tool name is sent verbatim to the
 *                server (NEVER pi's sanitized piName). An address in neither family throws a typed
 *                {@link BridgeError} (`unsupported-address`).
 * @param params  Tool arguments — forwarded as the MCP `tools/call` `arguments`.
 * @param opts    `{ toolCallId?, signal? }` — `signal` cancels the in-flight call.
 */
export async function callTool(address: string, params: unknown, opts: CallToolOpts = {}): Promise<PiToolResult> {
  const { server, tool } = parseAddress(address);

  const config = resolveConfig();
  const serverConfig = config.servers[server];
  if (!serverConfig) {
    throw new BridgeError(
      'unknown-server',
      `no MCP server configured named ${JSON.stringify(server)} (from address ${JSON.stringify(address)})`,
    );
  }

  // Honor an already-aborted signal before we touch the network.
  opts.signal?.throwIfAborted();

  const client = await getClient(server, serverConfig);

  // `tools/call` with the RAW tool name. `arguments` must be an object/record; coerce undefined → {}.
  const args = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const raw = (await client.callTool(
    { name: tool, arguments: args },
    undefined,
    { signal: opts.signal },
  )) as McpCallResult;

  return mapResult(raw);
}

/** The shape of an MCP `tools/list` result we read (ListToolsResultSchema — a `tools[]` of name/desc/schema). */
interface McpListResult {
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}

/**
 * INTROSPECT a server's tool listing: connect (lazily, pooled — same `getClient` path as `callTool`),
 * perform the JSON-RPC `tools/list`, and map each `tools[]` row to a plain `{name, description?,
 * inputSchema?}`. The catalog introspection step (packages/core) calls this to capture a server's real
 * per-tool schemas. `serverConfig` is passed directly (this is the LIST analogue of `callTool`'s
 * resolve-by-address; the catalog supplies the config it derived from the registry).
 *
 * @param server       The server name — used only as the pool key + in any connect error message.
 * @param serverConfig The connection config (stdio/http/inMemory) — built into the SDK transport.
 */
export async function listServerTools(server: string, serverConfig: McpServerConfig): Promise<McpToolListing[]> {
  const client = await getClient(server, serverConfig);
  const raw = (await client.listTools()) as McpListResult;
  return (raw.tools ?? []).map((t) => {
    const listing: McpToolListing = { name: t.name };
    if (t.description !== undefined) listing.description = t.description;
    if (t.inputSchema !== undefined) listing.inputSchema = t.inputSchema;
    return listing;
  });
}

/** Close every cached MCP client and reset config. Call on host teardown / between tests. */
export async function disposeBridge(): Promise<void> {
  await disposeClients();
  resetConfig();
}

// Best-effort cleanup if the process exits without an explicit disposeBridge() (e.g. a spawned pi node
// ending). `beforeExit` fires when the loop drains; we kick off client close without blocking exit.
process.once('beforeExit', () => {
  void disposeClients();
});
