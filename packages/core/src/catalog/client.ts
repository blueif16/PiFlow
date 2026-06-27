// Catalog client — the host-side FEEDER that turns the cached `~/.piflow/catalog/` slice into the inputs the
// canonical run path already accepts (`assembleRunTools` `extraEntries` + the merged `mcpConfig.servers`).
//
// The disease (tool-calling-architecture §5): the bind→execute pipeline is fully built, but the canonical CLI
// run path seeds NO catalog/`mcpConfig`, so a node selecting `mcp.<server>:<tool>` has no registry row to bind
// AND no server to reach. This module is that missing caller: it reads the cached online-catalog slice off
// `~/.piflow/catalog/mcp.index.json` (the FEDERATE design — capability-catalog.md §4: the index is online, the
// SDK ships only this CLIENT, the DATA lives under `~/.piflow/`, NEVER in `packages/`) and, for the `mcp.*`
// addresses a spec actually selects, returns BOTH the catalog rows (so the address binds) and the matching
// server configs (so the bridge has a server to call).
//
// Pure-ish + best-effort: reads files, performs NO network (the refresh/`sync()` of the slice is a separate,
// later step). Tolerates an absent/corrupt slice → empty, so a bad catalog NEVER fails a run (same posture as
// `observe/registry.ts` `loadRegistry`). The home is `PIFLOW_HOME ?? ~/.piflow`, reusing the ONE resolver
// (`observe/registry.ts` `globalDir`) so the catalog and the product registry can never disagree on the home.

import fssync from 'node:fs';
import path from 'node:path';
import type { WorkflowSpec, ToolEntry } from '../types.js';
import { globalDir } from '../observe/registry.js';

/** The loaded MCP slice: the catalog rows + the per-server config map (either may be empty). */
export interface McpCatalog {
  /** `ToolEntry[]` — one row per `mcp.<server>:<tool>`, exactly the shape `mcpToolsToEntries` emits. */
  entries: ToolEntry[];
  /** `{ <server>: <config> }` — the MCP server configs the bridge stages into `_pi/mcp.json`. */
  servers: Record<string, unknown>;
}

/** The per-run slice: the catalog rows a spec selected + ONLY the server configs those rows reference. */
export interface CatalogSlice {
  /** Rows to hand `assembleRunTools` as `extraEntries` so the selected `mcp.*` addresses bind. */
  extraEntries: ToolEntry[];
  /** The server configs to merge into the run's `mcpConfig.servers` (only the ones a selection references). */
  servers: Record<string, unknown>;
}

const MCP_PREFIX = 'mcp.';

/** Read + JSON-parse a file, tolerating absent/corrupt → undefined (NEVER throws; a bad catalog can't fail a run). */
function readJsonSafe(file: string): unknown {
  try {
    return JSON.parse(fssync.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** A plain (non-array) object — the envelope/server-map shape. */
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Load the cached MCP slice from `<home>/catalog/`. The index (`mcp.index.json`) is either a bare
 * `ToolEntry[]` OR a `{ entries, servers }` envelope; an optional sibling `mcp.servers.json` (a bare server
 * map, or a `{ servers }` envelope) supplies/augments the server configs. On a key conflict the index
 * envelope's inline `servers` WIN over the separate file. Absent/corrupt anything ⇒ that part is empty.
 */
export function loadMcpCatalog(home: string = globalDir()): McpCatalog {
  const dir = path.join(home, 'catalog');

  let entries: ToolEntry[] = [];
  let inlineServers: Record<string, unknown> = {};
  const index = readJsonSafe(path.join(dir, 'mcp.index.json'));
  if (Array.isArray(index)) {
    entries = index as ToolEntry[];
  } else if (isObject(index)) {
    if (Array.isArray(index.entries)) entries = index.entries as ToolEntry[];
    if (isObject(index.servers)) inlineServers = index.servers;
  }

  // Optional separate server map: a bare `{ <server>: cfg }` or a `{ servers: {...} }` envelope.
  let fileServers: Record<string, unknown> = {};
  const sep = readJsonSafe(path.join(dir, 'mcp.servers.json'));
  if (isObject(sep)) fileServers = isObject(sep.servers) ? sep.servers : sep;

  // Index-inline servers win on key conflict (they ship alongside the rows they describe).
  return { entries, servers: { ...fileServers, ...inlineServers } };
}

/** The raw MCP server name a `mcp.<server>:<tool>` address references (the config key). `undefined` if not an mcp address. */
function serverOf(address: string): string | undefined {
  if (!address.startsWith(MCP_PREFIX)) return undefined;
  const rest = address.slice(MCP_PREFIX.length);
  const colon = rest.indexOf(':'); // server = everything before the FIRST colon (may contain dots) — see address.ts.
  if (colon <= 0) return undefined;
  return rest.slice(0, colon);
}

/** Every `mcp.*` address the spec selects = the union over nodes of (`tools.allow` − `tools.deny`). */
function selectedMcpAddresses(spec: WorkflowSpec): Set<string> {
  const selected = new Set<string>();
  for (const node of spec.nodes) {
    const allow = node.tools?.allow ?? [];
    const deny = new Set(node.tools?.deny ?? []);
    for (const addr of allow) {
      if (addr.startsWith(MCP_PREFIX) && !deny.has(addr)) selected.add(addr);
    }
  }
  return selected;
}

/**
 * Resolve the run's MCP slice: load the cached catalog, keep ONLY the rows whose `address` the spec selects
 * (allow − deny across every node), and provision ONLY the server configs those selected rows reference. A
 * row the spec selects but the slice lacks is simply absent (it stays unbindable — the catalog is
 * load-bearing). No `mcp.*` selection (or no slice) ⇒ `{ extraEntries: [], servers: {} }` (fully additive).
 */
export function catalogForSpec(spec: WorkflowSpec, home: string = globalDir()): CatalogSlice {
  const selected = selectedMcpAddresses(spec);
  if (selected.size === 0) return { extraEntries: [], servers: {} };

  const { entries, servers } = loadMcpCatalog(home);
  const extraEntries = entries.filter((e) => selected.has(e.address));

  // Provision only the servers the SELECTED, FOUND rows reference (so an unmatched selection provisions
  // nothing, and an unrelated catalog server never leaks into the run).
  const needed: Record<string, unknown> = {};
  for (const e of extraEntries) {
    const server = serverOf(e.address);
    if (server && !(server in needed) && Object.prototype.hasOwnProperty.call(servers, server)) {
      needed[server] = servers[server];
    }
  }
  return { extraEntries, servers: needed };
}
