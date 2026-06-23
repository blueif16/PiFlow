// Address parsing. The bridge handles two address families, both transported over the SAME MCP path:
//   - `mcp.<server>:<tool>` — a plain MCP tool. BOTH halves keep their RAW spelling (dots/dashes intact):
//     the address is the SDK-facing id, and the bridge MUST call the server with the raw tool name parsed
//     here, never pi's sanitized `piName`. (See packages/core tools/ingest.ts: `address =
//     mcp.${server}:${tool}` built from the unsanitized names.)
//   - `oc.<plugin>:<tool>` — a gateway-coupled OpenClaw tool. It routes to ONE reserved MCP server named
//     `openclaw` (the OpenClaw `plugin-tools-serve` gateway the host configures under that key), sending
//     the RAW tool name (everything after the first colon). The `<plugin>` segment is PROVENANCE only —
//     OpenClaw's tools-serve exposes BARE tool names (`memory_get`), not plugin-prefixed ones — so it
//     never reaches the wire. (See packages/core tools/ingest.ts openClawPluginToEntries: `address =
//     oc.${plugin}:${tool}`; the entries are gateway-coupled / git-source-pinned so compile routes them
//     through this bridge by their `oc.` address rather than binding a native plugin module.)
//
// Split rule (both families): strip the prefix, then split on the FIRST ':'. For `mcp.` the server is
// everything before that colon (may contain dots, e.g. `chrome.devtools`) and the tool everything after
// (may contain dots/dashes, e.g. `take.screenshot`, and further colons, which stay part of the tool name).
// For `oc.` the server is always `openclaw` and the tool is everything after the first colon.

import { BridgeError } from './errors.js';

export interface ParsedAddress {
  /** Raw MCP server name (the config key to look up). */
  server: string;
  /** Raw MCP tool name — passed verbatim to `tools/call`. */
  tool: string;
}

const MCP_PREFIX = 'mcp.';
const OC_PREFIX = 'oc.';

/**
 * The reserved MCP server name every `oc.<plugin>:<tool>` address routes to — the key the host MUST
 * configure the OpenClaw gateway under in its `mcpConfig.servers`. Two example configs a host supplies
 * (both keyed `openclaw`):
 *   - local stdio:
 *       { transport: 'stdio', command: 'node',
 *         args: ['<abs>/openclaw/dist/mcp/plugin-tools-serve.js'], env: { OPENCLAW_HOME: '…' } }
 *   - remote http:
 *       { transport: 'http', url: 'https://…/mcp', headers: { Authorization: 'Bearer $OPENCLAW_TOKEN' } }
 */
export const OPENCLAW_SERVER = 'openclaw';

/**
 * Parse a tool address → `{ server, tool }` (raw spelling preserved). Two families:
 * `mcp.<server>:<tool>` → its server + tool; `oc.<plugin>:<tool>` → the reserved {@link OPENCLAW_SERVER}
 * + the raw tool (the `<plugin>` is provenance only). Throws a typed {@link BridgeError}:
 * `unsupported-address` for any other prefix (e.g. a `builtin:`/`sdk.` address — out of this bridge's
 * scope), `malformed-address` when the server/tool halves are missing.
 */
export function parseAddress(address: string): ParsedAddress {
  if (address.startsWith(OC_PREFIX)) {
    // `oc.<plugin>:<tool>` → the reserved `openclaw` server + the RAW tool (everything after the first
    // colon). The `<plugin>` segment before the colon is provenance only — the gateway exposes bare names.
    const rest = address.slice(OC_PREFIX.length);
    const colon = rest.indexOf(':');
    if (colon < 0) {
      throw new BridgeError(
        'malformed-address',
        `malformed OpenClaw address ${JSON.stringify(address)}: expected 'oc.<plugin>:<tool>'`,
      );
    }
    const tool = rest.slice(colon + 1);
    if (!tool) {
      throw new BridgeError(
        'malformed-address',
        `malformed OpenClaw address ${JSON.stringify(address)}: a <tool> is required after the colon`,
      );
    }
    return { server: OPENCLAW_SERVER, tool };
  }

  if (!address.startsWith(MCP_PREFIX)) {
    throw new BridgeError(
      'unsupported-address',
      `unsupported address ${JSON.stringify(address)}: the tool-bridge handles only 'mcp.<server>:<tool>' and 'oc.<plugin>:<tool>' addresses`,
    );
  }
  const rest = address.slice(MCP_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon < 0) {
    throw new BridgeError(
      'malformed-address',
      `malformed MCP address ${JSON.stringify(address)}: expected 'mcp.<server>:<tool>'`,
    );
  }
  const server = rest.slice(0, colon);
  const tool = rest.slice(colon + 1);
  if (!server || !tool) {
    throw new BridgeError(
      'malformed-address',
      `malformed MCP address ${JSON.stringify(address)}: both <server> and <tool> are required`,
    );
  }
  return { server, tool };
}
