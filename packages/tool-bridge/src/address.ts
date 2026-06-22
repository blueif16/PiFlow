// Address parsing. An MCP tool address is `mcp.<server>:<tool>` where BOTH the server and the tool keep
// their RAW spelling (dots/dashes intact) — the address is the SDK-facing id, and the bridge MUST call
// the server with the raw tool name parsed here, never pi's sanitized `piName`. (See packages/core
// tools/ingest.ts: `address = mcp.${server}:${tool}` built from the unsanitized names.)
//
// Split rule: strip the `mcp.` prefix, then split on the FIRST ':'. The server is everything before that
// colon (may contain dots, e.g. `chrome.devtools`); the tool is everything after (may contain dots/dashes,
// e.g. `take.screenshot`, and may itself contain further colons, which stay part of the tool name).

import { BridgeError } from './errors.js';

export interface ParsedAddress {
  /** Raw MCP server name (the config key to look up). */
  server: string;
  /** Raw MCP tool name — passed verbatim to `tools/call`. */
  tool: string;
}

const MCP_PREFIX = 'mcp.';

/**
 * Parse `mcp.<server>:<tool>` → `{ server, tool }` (raw spelling preserved). Throws a typed
 * {@link BridgeError}: `unsupported-address` for a non-`mcp.` address (this bridge handles MCP only —
 * `sdk` tools are a separate future seam), `malformed-address` when the server/tool halves are missing.
 */
export function parseAddress(address: string): ParsedAddress {
  if (!address.startsWith(MCP_PREFIX)) {
    throw new BridgeError(
      'unsupported-address',
      `unsupported address ${JSON.stringify(address)}: the tool-bridge handles only 'mcp.<server>:<tool>' addresses`,
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
