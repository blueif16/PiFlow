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

// ── OpenClaw `sdk` lane ─────────────────────────────────────────────────────────────────────────────
// A SHIPPED `openclaw.plugin.json` is NAMES-ONLY: `contracts.tools` is a bare `string[]` whose job is
// ownership routing ("which plugin owns each tool"), NOT schema carriage. `toolMetadata.<tool>` carries
// FLAGS only (`optional`/`replaySafe`/…) — never `description` or `parameters`. So a STATIC ingest yields
// a SKELETON `ToolEntry` (address/source/piName/origin/tags); the `description` + `parameters` are filled
// LATER by the capture-shim (openclaw-shim.ts) running the plugin's `register()`, NOT from the manifest.
// We therefore deliberately do NOT invent a description (left '') or a parameters schema (omitted).

/** The static `openclaw.plugin.json` fields we read. Extras (configSchema/setup/uiHints/…) are ignored. */
export interface OpenClawManifest {
  /** Plugin id — the address namespace + the piName prefix. */
  id: string;
  name?: string;
  description?: string;
  /** Ownership routing: the bare tool NAMES this plugin owns. NO schema, NO descriptions. */
  contracts?: { tools?: string[] };
  /** Per-tool FLAGS only (optional/replaySafe/authSignals/…) — never description/parameters. */
  toolMetadata?: Record<string, unknown>;
}

/** Knobs for OpenClaw ingestion. */
export interface OpenClawIngestOpts {
  /** Tags attached to every produced entry (feeds `registry.search`). */
  tags?: string[];
  /** Provenance pin recorded in `origin.ref` (e.g. `@openclaw/<pkg>@<ver>` or `<repo>@<commit>#…`). */
  ref?: string;
}

/**
 * Map a names-only `openclaw.plugin.json` into SKELETON Pi Flow `ToolEntry`s — one per
 * `contracts.tools[]` name: `address = oc.<plugin-id>:<tool>` (raw spelling), `source = 'sdk'`,
 * `piName = <plugin>_<tool>` (sanitized + prefixed), `origin = { kind: 'openclaw-plugin', ref? }`.
 * `description` is left '' and `parameters` is OMITTED — the manifest carries neither; the capture-shim
 * fills them. A manifest with no `contracts.tools` (a provider/channel plugin) yields an empty list.
 * Pure + deterministic — the caller owns the crawl + the later shim run.
 */
export function openClawPluginToEntries(manifest: OpenClawManifest, opts: OpenClawIngestOpts = {}): ToolEntry[] {
  const names = manifest.contracts?.tools ?? [];
  const piPrefix = sanitize(manifest.id);
  return names.map((name): ToolEntry => {
    const entry: ToolEntry = {
      address: `oc.${manifest.id}:${name}`,
      source: 'sdk',
      piName: `${piPrefix}_${sanitize(name)}`,
      description: '', // NEVER fabricated — the manifest has none; the capture-shim supplies it.
      origin: opts.ref ? { kind: 'openclaw-plugin', ref: opts.ref } : { kind: 'openclaw-plugin' },
    };
    if (opts.tags) entry.tags = opts.tags;
    // parameters intentionally OMITTED — not in the manifest; do not invent an empty schema.
    return entry;
  });
}
