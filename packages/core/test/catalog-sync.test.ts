// Catalog sync (`~/.piflow/catalog/`) — EXTERNAL-API GLUE gate (test-discipline §0): a RECORDED TAPE replays
// the MCP Official Registry's real `GET /v0.1/servers` responses deterministically — NO live net. The tape's
// shape is taken verbatim from the live API (registry.modelcontextprotocol.io/v0.1/servers): a
// `{ servers: [{ server, _meta }], metadata: { nextCursor } }` envelope, the official metadata under
// `_meta["io.modelcontextprotocol.registry/official"]` (status/updatedAt/isLatest), and `remotes[]`/`packages[]`
// on each server.json. The registry stores POINTERS, not tool schemas (tool-registry-maintenance §2): sync
// mirrors the SERVER DIRECTORY into `mcp.index.json` `servers` (the bridge run-config) + a `directory`
// (status/version) and advances the `sync.json` cursor — per-tool `entries` are a LATER introspection step.
//
// The behaviors that MUST hold (and fail loudly if broken):
//   • PAGINATION — follow `metadata.nextCursor` across pages until it is absent.
//   • DERIVE the bridge config: a streamable-http `remotes[0]` → `{transport:'http',url}`; an npm `packages[0]`
//     → `{command:'npx',args:['-y','<id>@<ver>']}`.
//   • TOMBSTONE — a `status:'deleted'` server is REMOVED from the slice (honours `include_deleted`).
//   • CURSOR — `sync.json.mcp.lastUpdatedSince` advances to `now`; the NEXT sync passes it as `updated_since`.
//   • ADDITIVE — pre-existing introspected `entries` are PRESERVED (sync never clobbers tool rows).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { syncMcpCatalog } from '../src/catalog/sync.js';
import { loadMcpCatalog } from '../src/catalog/client.js';
import type { ToolEntry } from '../src/types.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'piflow-home-'));
  prevHome = process.env.PIFLOW_HOME;
  process.env.PIFLOW_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const NOW = '2026-06-26T12:00:00.000Z';

/** Read a JSON file under the temp home's catalog dir. */
function readCatalog(file: string): any {
  return JSON.parse(readFileSync(path.join(home, 'catalog', file), 'utf8'));
}
/** Seed a JSON file under the temp home's catalog dir. */
function seedCatalog(file: string, body: unknown): void {
  const dir = path.join(home, 'catalog');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), JSON.stringify(body), 'utf8');
}

// ── The recorded tape (shape verbatim from the live registry) ────────────────────────────────────────
// Page 1: an http-remote server + an npm-package server, then a `nextCursor`. Page 2: a tombstoned server,
// no `nextCursor` (last page).
const PAGE1 = {
  servers: [
    {
      server: {
        name: 'ac.example/mcp',
        description: 'A remote MCP server.',
        version: '1.0.1',
        remotes: [{ type: 'streamable-http', url: 'https://a.example/mcp' }],
      },
      _meta: {
        'io.modelcontextprotocol.registry/official': { status: 'active', updatedAt: '2026-04-13T17:33:26Z', isLatest: true },
      },
    },
    {
      server: {
        name: 'io.github.acme/tool',
        description: 'An npm-packaged stdio MCP server.',
        version: '2.1.0',
        packages: [{ registryType: 'npm', identifier: '@acme/mcp-tool', version: '2.1.0', transport: { type: 'stdio' } }],
      },
      _meta: {
        'io.modelcontextprotocol.registry/official': { status: 'active', updatedAt: '2026-05-01T00:00:00Z', isLatest: true },
      },
    },
  ],
  metadata: { nextCursor: 'CURSOR_PAGE2', count: 2 },
};
const PAGE2 = {
  servers: [
    {
      server: { name: 'old.vendor/gone', description: 'Removed upstream.', version: '0.9.0' },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted', updatedAt: '2026-06-01T00:00:00Z', isLatest: true } },
    },
  ],
  metadata: { count: 1 }, // no nextCursor ⇒ last page
};

/** A tape-backed fetcher: routes by the `cursor` query param, recording every URL it is asked for. */
function tapeFetch(calls: string[]) {
  return async (url: string) => {
    calls.push(url);
    return url.includes('cursor=CURSOR_PAGE2') ? PAGE2 : PAGE1;
  };
}

describe('syncMcpCatalog — mirrors the MCP Official Registry into the ~/.piflow slice (recorded tape, no net)', () => {
  it('paginates, derives bridge configs, and writes them into mcp.index.json servers', async () => {
    const calls: string[] = [];
    const res = await syncMcpCatalog({ fetchPage: tapeFetch(calls), now: NOW });

    // Followed BOTH pages (page 1, then page 2 via nextCursor) and stopped (no further cursor).
    expect(res.pages).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/v0.1/servers');
    expect(calls[0]).toContain('version=latest');
    expect(calls[1]).toContain('cursor=CURSOR_PAGE2');

    const index = readCatalog('mcp.index.json');
    // streamable-http remote → an http bridge config.
    expect(index.servers['ac.example/mcp']).toEqual({ transport: 'http', url: 'https://a.example/mcp' });
    // npm package → an `npx -y <id>@<ver>` stdio bridge config, carrying the `transport:'stdio'` discriminant
    // (without it the config FAILS the bridge's McpServerConfig union and `makeTransport` throws).
    expect(index.servers['io.github.acme/tool']).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@acme/mcp-tool@2.1.0'],
    });
  });

  it('removes a tombstoned (status:deleted) server from the slice', async () => {
    // Pre-seed the server as already-installed so the removal is observable.
    seedCatalog('mcp.index.json', { servers: { 'old.vendor/gone': { transport: 'http', url: 'https://gone/' } } });

    const res = await syncMcpCatalog({ fetchPage: tapeFetch([]), now: NOW });
    expect(res.removed).toBe(1);

    const index = readCatalog('mcp.index.json');
    expect(index.servers['old.vendor/gone']).toBeUndefined();
    expect(index.directory?.['old.vendor/gone']).toBeUndefined();
  });

  it('advances the sync.json cursor to `now`, and the NEXT sync passes it as updated_since', async () => {
    await syncMcpCatalog({ fetchPage: tapeFetch([]), now: NOW });
    expect(readCatalog('sync.json').mcp.lastUpdatedSince).toBe(NOW);

    // A second sync reads that cursor and sends it as the incremental `updated_since` filter.
    const calls: string[] = [];
    const NEXT = '2026-06-27T00:00:00.000Z';
    await syncMcpCatalog({ fetchPage: tapeFetch(calls), now: NEXT });
    expect(calls[0]).toContain(`updated_since=${encodeURIComponent(NOW)}`);
    expect(readCatalog('sync.json').mcp.lastUpdatedSince).toBe(NEXT);
  });

  it('PRESERVES pre-existing introspected entries (sync mirrors servers, never clobbers tool rows)', async () => {
    const echo: ToolEntry = {
      address: 'mcp.everything:echo',
      source: 'mcp',
      piName: 'everything_echo',
      description: 'echo',
      origin: { kind: 'mcp-server', ref: 'everything' },
    };
    seedCatalog('mcp.index.json', { entries: [echo], servers: { everything: { command: 'node', args: ['srv.js'] } } });

    await syncMcpCatalog({ fetchPage: tapeFetch([]), now: NOW });

    const cat = loadMcpCatalog(home);
    // The introspected entry survived, AND the synced servers are now visible through the read side.
    expect(cat.entries).toEqual([echo]);
    expect(cat.servers['everything']).toEqual({ command: 'node', args: ['srv.js'] });
    expect(cat.servers['ac.example/mcp']).toEqual({ transport: 'http', url: 'https://a.example/mcp' });
  });

  it('does a FULL pull (no updated_since) on the first sync when no cursor exists', async () => {
    const calls: string[] = [];
    await syncMcpCatalog({ fetchPage: tapeFetch(calls), now: NOW });
    expect(existsSync(path.join(home, 'catalog', 'sync.json'))).toBe(true);
    expect(calls[0]).not.toContain('updated_since');
  });
});
