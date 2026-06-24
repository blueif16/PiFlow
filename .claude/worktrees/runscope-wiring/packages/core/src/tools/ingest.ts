// Ingestion — the "effortless fetch" that populates the registry. An MCP server's `tools/list`
// result (and the official MCP Registry's server.json) hand us {name, description, inputSchema}
// per tool, which maps 1:1 onto a `ToolEntry`. This module is the PURE transform: no network — the
// caller fetches the listing (over stdio/http, the MCP-bridge seam), we turn it into registry rows.
//
// Address vs piName: `address` (`mcp.<server>:<tool>`) is the SDK-facing id and may carry the raw
// server/tool spelling (the colon namespace tolerates dots/dashes). `piName` is the BARE name pi
// will see, so it is sanitized to pi's charset [a-zA-Z0-9_] and prefixed with the server (the
// pi-mcp-adapter `<server>_<tool>` convention) so two servers' identically-named tools never collide.

import type { ToolEntry } from '../types.js';

/** One row of an MCP server's `tools/list` result (the fields we map; extras are ignored). */
export interface McpToolListing {
  name: string;
  description?: string;
  /** JSON Schema (MCP standard `inputSchema`) — stored verbatim in `ToolEntry.parameters`. */
  inputSchema?: unknown;
}

/** Knobs for ingestion. */
export interface McpIngestOpts {
  /** Tags attached to every produced entry (feeds `registry.search`). */
  tags?: string[];
}

/** pi bare names are restricted to [a-zA-Z0-9_]; collapse everything else to '_'. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Map an MCP server's `tools/list` result into Pi Flow `ToolEntry`s. Each tool becomes one row:
 * `address = mcp.<server>:<tool>` (raw spelling), `piName = <server>_<tool>` (sanitized, prefixed),
 * `parameters` = the server's JSON Schema verbatim (omitted when the server declares none, so we
 * never invent an empty schema). Pure + deterministic — the caller owns the actual fetch.
 */
export function mcpToolsToEntries(server: string, tools: McpToolListing[], opts: McpIngestOpts = {}): ToolEntry[] {
  const piPrefix = sanitize(server);
  return tools.map((t): ToolEntry => {
    const entry: ToolEntry = {
      address: `mcp.${server}:${t.name}`,
      source: 'mcp',
      piName: `${piPrefix}_${sanitize(t.name)}`,
      description: t.description ?? '',
      origin: { kind: 'mcp-server', ref: server },
    };
    if (opts.tags) entry.tags = opts.tags;
    if (t.inputSchema !== undefined) entry.parameters = t.inputSchema;
    return entry;
  });
}
