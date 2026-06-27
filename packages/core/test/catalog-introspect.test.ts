// Catalog introspect (`~/.piflow/catalog/`) — EXTERNAL-API GLUE gate (test-discipline §0): a RECORDED TAPE
// replays a server's `tools/list` result deterministically — NO live net. sync.ts mirrors the SERVER
// DIRECTORY (`servers`/`directory`) but the registry list carries NO per-tool schemas; introspect is the
// SEPARATE later step that fetches one server's `tools/list` ONCE and writes the per-tool `entries` into the
// slice so a node selecting `mcp.<server>:<tool>` BINDS.
//
// The behaviors that MUST hold (and fail loudly if broken):
//   • INGEST — map the listing via the shared `mcpToolsToEntries` (address `mcp.<server>:<tool>`, piName
//     `<server>_<tool>`, `parameters` = the inputSchema verbatim) and write them into the slice `entries`.
//   • BIND — the written rows flow through the read side (`catalogForSpec` → `assembleRunTools`) so the
//     selected address resolves to its `piTools` piName.
//   • REFRESH (idempotent) — re-introspecting a server REPLACES its prior rows (no duplicates), and leaves
//     OTHER servers' entries plus the `servers`/`directory` maps untouched.
//   • LOAD-BEARING — a tool dropped from the tape is ABSENT from the slice and does NOT bind.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { introspectMcpServer } from '../src/catalog/introspect.js';
import { loadMcpCatalog, catalogForSpec } from '../src/catalog/client.js';
import { assembleRunTools } from '../src/runner/tool-config.js';
import type { McpToolListing } from '../src/tools/ingest.js';
import type { ToolEntry, WorkflowSpec } from '../src/types.js';

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

// ── The recorded tape (a `tools/list` result for server `everything`) ────────────────────────────────
// `echo` (no schema) + `add` (a real inputSchema, carried verbatim into ToolEntry.parameters).
const ADD_SCHEMA = {
  type: 'object',
  properties: { a: { type: 'number' }, b: { type: 'number' } },
  required: ['a', 'b'],
};
const TAPE: McpToolListing[] = [
  { name: 'echo', description: 'Echo back the input.' },
  { name: 'add', description: 'Add two numbers.', inputSchema: ADD_SCHEMA },
];

/** A tape-backed `listTools` seam: records each call, returns the supplied listing. */
function tapeListTools(tools: McpToolListing[], calls: number[] = []) {
  return async () => {
    calls.push(1);
    return tools;
  };
}

/** A minimal spec whose single node selects the given mcp addresses. */
function specSelecting(...allow: string[]): WorkflowSpec {
  return { nodes: [{ id: 'n1', tools: { allow } }] } as unknown as WorkflowSpec;
}

describe('introspectMcpServer — writes a server`s tools/list into the ~/.piflow slice (recorded tape, no net)', () => {
  it('ingests the listing into mcp.index.json entries (address/piName/parameters), and returns a summary', async () => {
    const res = await introspectMcpServer({ server: 'everything', listTools: tapeListTools(TAPE), home, now: NOW });

    // The summary reflects the two tools and their addresses.
    expect(res).toEqual({
      server: 'everything',
      toolCount: 2,
      addresses: ['mcp.everything:echo', 'mcp.everything:add'],
    });

    const { entries } = loadMcpCatalog(home);
    const byAddr = new Map(entries.map((e) => [e.address, e]));

    const echo = byAddr.get('mcp.everything:echo');
    expect(echo).toBeDefined();
    expect(echo!.piName).toBe('everything_echo');

    const add = byAddr.get('mcp.everything:add');
    expect(add).toBeDefined();
    expect(add!.piName).toBe('everything_add');
    // The inputSchema is carried VERBATIM into ToolEntry.parameters.
    expect(add!.parameters).toEqual(ADD_SCHEMA);
  });

  it('BIND PROOF: an introspected address flows through catalogForSpec → assembleRunTools to a piTool', async () => {
    await introspectMcpServer({ server: 'everything', listTools: tapeListTools(TAPE), home, now: NOW });

    const spec = specSelecting('mcp.everything:echo');
    const { extraEntries } = catalogForSpec(spec, home);
    expect(extraEntries.map((e) => e.address)).toContain('mcp.everything:echo');

    const { registry } = assembleRunTools({ spec, extraEntries });
    // `piTools` is the array of bare pi names the address resolves to.
    const piTools = registry.resolve({ allow: ['mcp.everything:echo'] }).piTools;
    expect(piTools).toContain('everything_echo');
  });

  it('REFRESH: re-introspecting REPLACES the server`s stale rows (no dupes) and PRESERVES other servers + servers/directory', async () => {
    // Seed a stale `everything:echo` row, an UNRELATED server's row, and `servers`/`directory` maps.
    const staleEcho: ToolEntry = {
      address: 'mcp.everything:echo',
      source: 'mcp',
      piName: 'everything_echo',
      description: 'STALE',
      origin: { kind: 'mcp-server', ref: 'everything' },
    };
    const otherRow: ToolEntry = {
      address: 'mcp.other:ping',
      source: 'mcp',
      piName: 'other_ping',
      description: 'ping',
      origin: { kind: 'mcp-server', ref: 'other' },
    };
    seedCatalog('mcp.index.json', {
      entries: [staleEcho, otherRow],
      servers: { everything: { command: 'node', args: ['srv.js'] }, other: { command: 'node', args: ['o.js'] } },
      directory: { everything: { description: 'all', version: '1.0.0' } },
    });

    const res = await introspectMcpServer({ server: 'everything', listTools: tapeListTools(TAPE), home, now: NOW });
    expect(res.toolCount).toBe(2);

    const index = readCatalog('mcp.index.json');
    const entries: ToolEntry[] = index.entries;

    // Exactly the two FRESH `everything` rows survive (stale STALE-description echo replaced, no dupe).
    const everythingRows = entries.filter((e) => e.address.startsWith('mcp.everything:'));
    expect(everythingRows.map((e) => e.address).sort()).toEqual(['mcp.everything:add', 'mcp.everything:echo']);
    const refreshedEcho = everythingRows.find((e) => e.address === 'mcp.everything:echo')!;
    expect(refreshedEcho.description).toBe('Echo back the input.'); // refreshed, NOT 'STALE'

    // The unrelated server's row is preserved verbatim.
    expect(entries.find((e) => e.address === 'mcp.other:ping')).toEqual(otherRow);

    // The servers + directory maps are untouched.
    expect(index.servers).toEqual({
      everything: { command: 'node', args: ['srv.js'] },
      other: { command: 'node', args: ['o.js'] },
    });
    // directory.everything is preserved (an introspectedAt stamp may be added, but the seeded fields stay).
    expect(index.directory.everything.description).toBe('all');
    expect(index.directory.everything.version).toBe('1.0.0');
  });

  it('test-the-test: a tool DROPPED from the tape is ABSENT from the slice and does NOT bind', async () => {
    const ECHO_ONLY: McpToolListing[] = [{ name: 'echo', description: 'Echo back the input.' }];
    await introspectMcpServer({ server: 'everything', listTools: tapeListTools(ECHO_ONLY), home, now: NOW });

    const { entries } = loadMcpCatalog(home);
    expect(entries.map((e) => e.address)).toContain('mcp.everything:echo');
    expect(entries.map((e) => e.address)).not.toContain('mcp.everything:add');

    // The dropped tool does not bind: no catalog row → no extraEntry → the address is unregistered, so the
    // registry refuses to resolve it (it can never reach pi as a tool).
    const spec = specSelecting('mcp.everything:add');
    const { extraEntries } = catalogForSpec(spec, home);
    expect(extraEntries).toHaveLength(0);
    const { registry } = assembleRunTools({ spec, extraEntries });
    expect(() => registry.resolve({ allow: ['mcp.everything:add'] })).toThrow(/unknown tool address/);
  });
});
