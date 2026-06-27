// Catalog sync — the FEDERATE write-side: mirror the MCP Official Registry's server directory into the cached
// `~/.piflow/catalog/` slice the run path reads (`client.ts`). The registry is an INDEX, not a mirror: it hosts
// `server.json` POINTERS (name + packages/remotes), and `GET /v0.1/servers` carries NO per-tool schemas
// (tool-registry-maintenance §2; confirmed live). So sync mirrors the SERVER DIRECTORY — it derives each
// server's bridge run-config into `mcp.index.json` `servers` (so a node selecting that server has something to
// run) + records status/version in `directory` (for tombstones + deprecation) — and advances the incremental
// cursor in `sync.json`. The per-tool `entries` are a SEPARATE, later step (introspect a server's `tools/list`
// once to capture the real schema), so sync PRESERVES any `entries` already in the slice and never writes them.
//
// Incremental + tombstone-correct (the package-manager pattern): `GET /v0.1/servers?version=latest` on the
// first pull, then `&updated_since=<lastUpdatedSince>` (the registry auto-sets `include_deleted` so tombstones
// arrive); follow `metadata.nextCursor` to exhaustion; a `status:'deleted'` server is REMOVED from the slice.
//
// Pure-of-ambient-I/O via injection: `fetchPage` (the network seam — default `globalThis.fetch` → `.json()`)
// and `now` (the cursor stamp) are injectable, so the recorded-tape test replays real responses with zero net.

import fssync from 'node:fs';
import path from 'node:path';
import { globalDir } from '../observe/registry.js';

/** The official MCP Registry list base. Override via `baseUrl` (e.g. a mirror). */
const DEFAULT_REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';
/** Backstop against a registry that never stops handing back a `nextCursor`. */
const DEFAULT_MAX_PAGES = 1000;
const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

/** One `remotes[]` entry of a `server.json` (a hosted endpoint). */
interface RegistryRemote {
  type?: string;
  url?: string;
}
/** One `packages[]` entry of a `server.json` (a runnable artifact pointer). */
interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
}
/** A `server.json` as carried in a list item. */
interface RegistryServer {
  name?: string;
  description?: string;
  version?: string;
  remotes?: RegistryRemote[];
  packages?: RegistryPackage[];
}
/** One `GET /v0.1/servers` list item: the `server.json` + the official registry `_meta` block. */
interface RegistryServerItem {
  server?: RegistryServer;
  _meta?: Record<string, { status?: string; updatedAt?: string; isLatest?: boolean } | undefined>;
}
/** The `GET /v0.1/servers` response envelope. */
interface RegistryListResponse {
  servers?: RegistryServerItem[];
  metadata?: { nextCursor?: string; count?: number };
}

/** Inputs to `syncMcpCatalog`. All optional; the two seams (`fetchPage`, `now`) make it deterministic in test. */
export interface SyncMcpCatalogOpts {
  /** The global home to write under. Default `PIFLOW_HOME ?? ~/.piflow` (reuses `globalDir`). */
  home?: string;
  /** The network seam: fetch one page's PARSED JSON for a URL. Default: `globalThis.fetch` → `.json()`. */
  fetchPage?: (url: string) => Promise<unknown>;
  /** RFC3339 stamp written as the new cursor (`sync.json.mcp.lastUpdatedSince`). Default `new Date().toISOString()`. */
  now?: string;
  /** Registry list base URL. Default the official registry. */
  baseUrl?: string;
  /** Max pages to follow (runaway-cursor backstop). Default 1000. */
  maxPages?: number;
}

/** What `syncMcpCatalog` returns — the run summary. */
export interface SyncResult {
  /** Pages fetched (≥1). */
  pages: number;
  /** Servers upserted (active/deprecated). */
  upserted: number;
  /** Servers removed by tombstone (status:deleted). */
  removed: number;
  /** The cursor written for the next incremental pull (= `now`). */
  lastUpdatedSince: string;
}

/** A per-server provenance record kept in `mcp.index.json.directory` (status drives tombstones/deprecation). */
interface DirectoryRecord {
  description?: string;
  version?: string;
  status?: string;
  updatedAt?: string;
}

/** The slice file body sync reads + rewrites (it only touches `servers`/`directory`; `entries` are preserved). */
interface SliceFile {
  entries?: unknown[];
  servers?: Record<string, unknown>;
  directory?: Record<string, DirectoryRecord>;
}

function readJsonSafe(file: string): unknown {
  try {
    return JSON.parse(fssync.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Derive a bridge run-config from a `server.json`: a streamable-http remote → `{transport:'http',url}`; else
 * an npm package → `{command:'npx',args:['-y','<id>[@<ver>]']}`; else a pypi package → `{command:'uvx',args:['<id>']}`.
 * Returns undefined when nothing runnable is declared (recorded in `directory` only — not in `servers`).
 */
function bridgeConfigFor(server: RegistryServer): Record<string, unknown> | undefined {
  const remote = server.remotes?.find((r) => r.type === 'streamable-http' && r.url);
  if (remote?.url) return { transport: 'http', url: remote.url };

  const pkg = server.packages?.find((p) => p.identifier);
  if (pkg?.identifier) {
    if (pkg.registryType === 'npm') {
      const id = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
      return { command: 'npx', args: ['-y', id] };
    }
    if (pkg.registryType === 'pypi') {
      return { command: 'uvx', args: [pkg.identifier] };
    }
  }
  return undefined;
}

/** Build the `GET /v0.1/servers` URL for a page (always `version=latest`; `updated_since`/`cursor` when present). */
function pageUrl(base: string, updatedSince: string | undefined, cursor: string | undefined): string {
  const params = new URLSearchParams({ version: 'latest' });
  if (updatedSince) params.set('updated_since', updatedSince);
  if (cursor) params.set('cursor', cursor);
  return `${base.replace(/\/$/, '')}/v0.1/servers?${params.toString()}`;
}

/** The default network fetch: `globalThis.fetch` → parsed JSON. Throws loudly on a non-2xx. */
async function defaultFetchPage(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`syncMcpCatalog: registry GET ${url} → HTTP ${res.status}`);
  return res.json();
}

/**
 * Mirror the MCP Official Registry's server directory into `<home>/catalog/mcp.index.json` (`servers` +
 * `directory`) and advance `<home>/catalog/sync.json`'s incremental cursor. Pre-existing `entries` (the
 * introspected per-tool rows) are preserved untouched. Paginates via `metadata.nextCursor`; honours
 * `status:'deleted'` tombstones (removes the server). Deterministic under the injected `fetchPage`/`now`.
 */
export async function syncMcpCatalog(opts: SyncMcpCatalogOpts = {}): Promise<SyncResult> {
  const home = opts.home ?? globalDir();
  const fetchPage = opts.fetchPage ?? defaultFetchPage;
  const now = opts.now ?? new Date().toISOString();
  const base = opts.baseUrl ?? DEFAULT_REGISTRY_BASE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  const dir = path.join(home, 'catalog');
  const indexPath = path.join(dir, 'mcp.index.json');
  const syncPath = path.join(dir, 'sync.json');

  // Load the existing slice (preserve `entries`; merge into `servers`/`directory`).
  const slice: SliceFile = (() => {
    const raw = readJsonSafe(indexPath);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as SliceFile;
    if (Array.isArray(raw)) return { entries: raw as unknown[] }; // a bare ToolEntry[] index ⇒ keep it as entries.
    return {};
  })();
  const servers: Record<string, unknown> = { ...(slice.servers ?? {}) };
  const directory: Record<string, DirectoryRecord> = { ...(slice.directory ?? {}) };

  // The incremental cursor: the prior `lastUpdatedSince` (undefined ⇒ a full first pull).
  const prior = readJsonSafe(syncPath) as { mcp?: { lastUpdatedSince?: string } } | undefined;
  const updatedSince = prior?.mcp?.lastUpdatedSince;

  let upserted = 0;
  let removed = 0;
  let pages = 0;
  let cursor: string | undefined;

  do {
    const body = (await fetchPage(pageUrl(base, updatedSince, cursor))) as RegistryListResponse;
    pages++;
    for (const item of body.servers ?? []) {
      const name = item.server?.name;
      if (!name) continue;
      const official = item._meta?.[OFFICIAL_META];
      const status = official?.status;
      if (status === 'deleted') {
        // Tombstone: drop the server from the slice (refuse to keep a deleted pointer).
        if (name in servers) delete servers[name];
        if (name in directory) delete directory[name];
        removed++;
        continue;
      }
      directory[name] = {
        description: item.server?.description,
        version: item.server?.version,
        status,
        updatedAt: official?.updatedAt,
      };
      const cfg = bridgeConfigFor(item.server ?? {});
      if (cfg) servers[name] = cfg;
      upserted++;
    }
    cursor = body.metadata?.nextCursor || undefined;
  } while (cursor && pages < maxPages);

  // Write the slice (entries preserved verbatim) + advance the cursor.
  fssync.mkdirSync(dir, { recursive: true });
  const out: SliceFile = { ...slice, servers, directory };
  fssync.writeFileSync(indexPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  fssync.writeFileSync(syncPath, `${JSON.stringify({ mcp: { lastUpdatedSince: now, fetchedAt: now } }, null, 2)}\n`, 'utf8');

  return { pages, upserted, removed, lastUpdatedSince: now };
}
