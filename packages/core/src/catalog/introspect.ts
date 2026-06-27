// Catalog introspect — the INTROSPECTION step the FEDERATE design owes (capability-catalog.md §4): sync.ts
// mirrors the registry's SERVER DIRECTORY into the slice (`servers` + `directory`), but the registry list
// carries NO per-tool schemas (tool-registry-maintenance §2). This module is the separate, later step that
// fetches ONE server's `tools/list` ONCE and writes the per-tool `entries` into the cached
// `<home>/catalog/mcp.index.json` slice — so a node selecting `mcp.<server>:<tool>` BINDS through the read
// side (client.ts `catalogForSpec` → tool-config.ts `assembleRunTools`).
//
// REUSE, don't reinvent: the listing→rows transform is the SHARED pure `mcpToolsToEntries` (ingest.ts) —
// the same one `assembleRunTools` uses — so the SDK-facing `address`/`piName`/`parameters` shape can never
// drift between introspect-write and run-time-ingest.
//
// REFRESH-correct upsert (the package-manager pattern): re-introspecting a server REPLACES every prior row
// for THAT server (every `mcp.<server>:` address) before appending the fresh rows, so it refreshes a stale
// schema and NEVER duplicates. All other servers' `entries`, plus the `servers`/`directory` maps sync owns,
// are preserved verbatim — introspect touches ONLY this server's `entries`.
//
// Pure-of-ambient-I/O via injection: `listTools` (the network seam — the actual `tools/list` fetch) and
// `now` (the introspectedAt stamp) are injectable, so the recorded-tape test replays a real `tools/list`
// with zero net. The DEFAULT seam is the REAL `tools/list` client: when no `listTools` is passed, introspect
// resolves a bridge config (`opts.serverConfig`, else the slice's `servers[server]`) and defaults to
// `() => listServerTools(server, config)` (packages/tool-bridge) — connecting through the real MCP client.
// It throws a clear, actionable error ONLY when there is NEITHER a seam NOR any resolvable config (never a
// fabricated transport).

import fssync from 'node:fs';
import path from 'node:path';
// Type-only import (erased at compile) — core stays statically bridge-free; the real client is loaded
// LAZILY (dynamic import below) ONLY when the default introspection path actually connects, so importing
// `@piflow/core` never eagerly pulls the MCP SDK for a consumer that doesn't introspect.
import type { McpServerConfig } from '@piflow/tool-bridge';
import { globalDir } from '../observe/registry.js';
import type { ToolEntry } from '../types.js';
import { mcpToolsToEntries, type McpToolListing } from '../tools/ingest.js';

/** Inputs to `introspectMcpServer`. `listTools` (the network seam) makes it deterministic in test. */
export interface IntrospectMcpServerOpts {
  /** The MCP server name — the address namespace (`mcp.<server>:<tool>`) + the `directory` key. */
  server: string;
  /**
   * The INJECTED network seam: fetch this server's `tools/list` listing. OPTIONAL — when omitted, introspect
   * DEFAULTS to the real `listServerTools` bridge client against the resolved `serverConfig` (below). Pass it
   * to replay a recorded tape with zero net.
   */
  listTools?: () => Promise<McpToolListing[]>;
  /**
   * The bridge connection config to introspect through when no `listTools` seam is given. Takes precedence
   * over the slice's `servers[server]` lookup. When BOTH this and the slice lack a config (and no seam is
   * passed), introspect throws — it never fabricates a transport.
   */
  serverConfig?: McpServerConfig;
  /** The global home to write under. Default `PIFLOW_HOME ?? ~/.piflow` (reuses `globalDir`, as sync.ts). */
  home?: string;
  /** RFC3339 stamp written as `directory[server].introspectedAt` (when that record exists). Default `now()`. */
  now?: string;
}

/** What `introspectMcpServer` returns — the run summary (the server + its freshly-written tool rows). */
export interface IntrospectResult {
  /** The server introspected. */
  server: string;
  /** Tool rows written for this server (= the listing length). */
  toolCount: number;
  /** The `mcp.<server>:<tool>` addresses written, in listing order. */
  addresses: string[];
}

/** A per-server provenance record kept in `mcp.index.json.directory` (sync.ts owns it; we only stamp it). */
interface DirectoryRecord {
  description?: string;
  version?: string;
  status?: string;
  updatedAt?: string;
  introspectedAt?: string;
}

/** The slice file body: introspect touches ONLY `entries`; `servers`/`directory` are preserved verbatim. */
interface SliceFile {
  entries?: ToolEntry[];
  servers?: Record<string, unknown>;
  directory?: Record<string, DirectoryRecord>;
}

/** Read + JSON-parse a file, tolerating absent/corrupt → undefined (matches sync.ts/client.ts posture). */
function readJsonSafe(file: string): unknown {
  try {
    return JSON.parse(fssync.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Introspect ONE MCP server: fetch its `tools/list` (via the injected `listTools` seam), map the listing to
 * `ToolEntry` rows with the shared `mcpToolsToEntries`, and UPSERT them into `<home>/catalog/mcp.index.json`
 * `entries` — REPLACING every prior `mcp.<server>:` row (refresh, no dupes) then appending the fresh rows.
 * All other entries plus the `servers`/`directory` maps are preserved verbatim. Optionally stamps
 * `directory[server].introspectedAt` (only when that record already exists — never creating one). Returns
 * the summary. Deterministic under the injected `listTools`/`now`.
 */
export async function introspectMcpServer(opts: IntrospectMcpServerOpts): Promise<IntrospectResult> {
  const { server } = opts;
  const home = opts.home ?? globalDir();
  const now = opts.now ?? new Date().toISOString();

  const dir = path.join(home, 'catalog');
  const indexPath = path.join(dir, 'mcp.index.json');

  // Load the existing slice FIRST (tolerate absent/corrupt/bare-array → an empty envelope, as client.ts does)
  // — both to resolve a default bridge config from `servers[server]` and to upsert `entries` below.
  const slice: SliceFile = (() => {
    const raw = readJsonSafe(indexPath);
    if (Array.isArray(raw)) return { entries: raw as ToolEntry[] }; // a bare ToolEntry[] index ⇒ keep as entries.
    if (raw && typeof raw === 'object') return raw as SliceFile;
    return {};
  })();

  // Resolve the listTools seam. Given one, use it. Else resolve a bridge config (the explicit `serverConfig`
  // arg wins; else the slice's `servers[server]`) and DEFAULT to the real `listServerTools` bridge client.
  // Throw only when there is NEITHER a seam NOR a resolvable config — never fabricate a transport.
  const config = (opts.serverConfig ?? slice.servers?.[server]) as McpServerConfig | undefined;
  const listTools =
    opts.listTools ??
    (config
      ? async () => {
          const { listServerTools } = await import('@piflow/tool-bridge');
          return listServerTools(server, config);
        }
      : () => {
          throw new Error(
            `introspectMcpServer: cannot introspect ${JSON.stringify(server)} — no listTools seam and no ` +
              `serverConfig (pass opts.serverConfig or register the server in <home>/catalog/mcp.index.json)`,
          );
        });

  // Fetch the listing (the ONE network call) and map it to rows via the SHARED transform — no reinvention.
  const listings = await listTools();
  const rows = mcpToolsToEntries(server, listings);

  // UPSERT: drop every PRIOR row for THIS server (refresh, never duplicate), keep all others, append fresh.
  const serverPrefix = `mcp.${server}:`;
  const kept = (slice.entries ?? []).filter((e) => !e.address.startsWith(serverPrefix));
  const entries: ToolEntry[] = [...kept, ...rows];

  // Stamp introspectedAt ONLY if a directory record for this server already exists (don't fabricate one).
  const directory = slice.directory;
  if (directory && Object.prototype.hasOwnProperty.call(directory, server)) {
    directory[server] = { ...directory[server], introspectedAt: now };
  }

  // Write back: entries upserted; servers/directory preserved verbatim (pretty JSON + trailing \n, as sync.ts).
  fssync.mkdirSync(dir, { recursive: true });
  const out: SliceFile = { ...slice, entries };
  fssync.writeFileSync(indexPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');

  return { server, toolCount: rows.length, addresses: rows.map((r) => r.address) };
}
