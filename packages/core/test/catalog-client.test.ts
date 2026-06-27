// Catalog client (`~/.piflow/catalog/`) — PURE LOGIC gate (test-discipline §0): example tests with
// independently-justified assertions. The `PIFLOW_HOME` seam points the global dir at a temp dir so the
// real `~/.piflow` is never touched. This is the FEED that closes the live-path gap (tool-calling-architecture
// §5): the cached online-catalog slice is read off `~/.piflow/catalog/` and handed to `assembleRunTools` as
// `extraEntries` + merged into `mcpConfig`, so a node selecting `mcp.<server>:<tool>` BINDS (and its server is
// provisioned) instead of falling through to a bare builtins-only registry.
//
// The behaviors that MUST hold (and fail loudly if broken):
//   • catalogForSpec returns ONLY the entries a node selects, and provisions ONLY their servers.
//   • the catalog is LOAD-BEARING — remove the entry from the slice and the same address NO LONGER binds.
//   • the run path (resolveRunTools) seeds the server into mcpConfig.servers, node-authored config winning.
//   • ADDITIVE — no slice / no `mcp.*` selection ⇒ output is identical to `assembleRunTools({ spec })`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { catalogForSpec, loadMcpCatalog } from '../src/catalog/client.js';
import { assembleRunTools } from '../src/runner/tool-config.js';
import { resolveRunTools } from '../src/runner/entry.js';
import type { WorkflowSpec, NodeIntent, ToolEntry } from '../src/types.js';

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

/** The one catalog row the slice ships: an `everything` MCP server's `echo` tool. */
const ECHO_ENTRY: ToolEntry = {
  address: 'mcp.everything:echo',
  source: 'mcp',
  piName: 'everything_echo',
  description: 'echo',
  parameters: { type: 'object', properties: {} },
  origin: { kind: 'mcp-server', ref: 'everything' },
};
const ECHO_SERVER = { command: 'node', args: ['srv.js'] };

/** Write `~/.piflow/catalog/mcp.index.json` (the cached online slice) with the given body. */
function writeMcpIndex(body: unknown): void {
  const dir = path.join(home, 'catalog');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'mcp.index.json'), JSON.stringify(body), 'utf8');
}

/** A minimal one-node WorkflowSpec selecting the given tool addresses. */
function specSelecting(addresses: string[]): WorkflowSpec {
  const node: NodeIntent = {
    label: 'n',
    prompt: 'p',
    tools: { allow: addresses },
    io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
  };
  return { meta: { name: 'cat-wf', description: 'one node' }, nodes: [node] };
}

describe('catalogForSpec — the cached MCP slice feeds the run so a node-selected mcp.* tool BINDS', () => {
  it('returns the selected entry + its server, and that entry BINDS through assembleRunTools', () => {
    writeMcpIndex({ entries: [ECHO_ENTRY], servers: { everything: ECHO_SERVER } });
    const spec = specSelecting(['mcp.everything:echo']);

    const cat = catalogForSpec(spec);
    // The slice yields exactly the row the spec selects + its server config (not the whole catalog).
    expect(cat.extraEntries).toEqual([ECHO_ENTRY]);
    expect(cat.servers).toEqual({ everything: ECHO_SERVER });

    // Handed to the pure assembler as extraEntries, the address resolves to its bare pi name — proof the
    // catalog row reached the registry (else `resolve` throws "unknown tool address").
    const { registry } = assembleRunTools({ spec, extraEntries: cat.extraEntries });
    const res = registry.resolve({ allow: ['mcp.everything:echo'] });
    expect(res.piTools).toContain('everything_echo');
  });

  it('seeds the server into the run-path mcpConfig (resolveRunTools), node-authored config winning', () => {
    writeMcpIndex({ entries: [ECHO_ENTRY], servers: { everything: ECHO_SERVER } });
    const spec = specSelecting(['mcp.everything:echo']);

    // The canonical run wiring (no explicit caller registry) sources the slice and merges its servers.
    const { mcpConfig } = resolveRunTools(spec, {});
    expect(mcpConfig?.servers?.everything).toEqual(ECHO_SERVER);
  });

  // PRECEDENCE: when BOTH the catalog slice and a node author the same server key, the node-authored config
  // WINS (a node may pin a different endpoint/creds than the cached default). Flipping the merge order must
  // be caught here.
  it('lets a node-authored mcp.servers entry override the catalog slice on a key conflict', () => {
    writeMcpIndex({ entries: [ECHO_ENTRY], servers: { everything: ECHO_SERVER } });
    const nodeCfg = { transport: 'http', url: 'https://node-authored/mcp/' };
    const node: NodeIntent = {
      label: 'n',
      prompt: 'p',
      tools: { allow: ['mcp.everything:echo'] },
      io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
      mcp: { servers: { everything: nodeCfg } },
    };
    const spec: WorkflowSpec = { meta: { name: 'cat-wf', description: '' }, nodes: [node] };

    const { mcpConfig } = resolveRunTools(spec, {});
    expect(mcpConfig?.servers?.everything).toEqual(nodeCfg);
  });

  // TEST-THE-TEST (mutation, baked in permanently): the catalog is LOAD-BEARING. Drop the row from the slice
  // and the SAME spec must no longer bind the address — so a green "binds" test above can only be green
  // because the slice actually carried it.
  it('does NOT bind the address when the slice omits the entry (catalog is load-bearing)', () => {
    writeMcpIndex({ entries: [], servers: { everything: ECHO_SERVER } });
    const spec = specSelecting(['mcp.everything:echo']);

    const cat = catalogForSpec(spec);
    expect(cat.extraEntries).toEqual([]);
    // No server provisioned either — nothing selected it.
    expect(cat.servers).toEqual({});
    // And the assembled registry has no such row ⇒ resolving the address throws (it is unbindable).
    const { registry } = assembleRunTools({ spec, extraEntries: cat.extraEntries });
    expect(() => registry.resolve({ allow: ['mcp.everything:echo'] })).toThrow(/unknown tool address/);
  });

  it('honors deny — a selected-then-denied mcp.* address is NOT in the slice', () => {
    writeMcpIndex({ entries: [ECHO_ENTRY], servers: { everything: ECHO_SERVER } });
    const node: NodeIntent = {
      label: 'n',
      prompt: 'p',
      tools: { allow: ['mcp.everything:echo'], deny: ['mcp.everything:echo'] },
      io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
    };
    const spec: WorkflowSpec = { meta: { name: 'cat-wf', description: '' }, nodes: [node] };

    const cat = catalogForSpec(spec);
    expect(cat.extraEntries).toEqual([]);
    expect(cat.servers).toEqual({});
  });

  it('provisions ONLY the servers the selected entries reference, not the whole catalog', () => {
    const otherEntry: ToolEntry = { ...ECHO_ENTRY, address: 'mcp.github:create_issue', piName: 'github_create_issue', origin: { kind: 'mcp-server', ref: 'github' } };
    writeMcpIndex({
      entries: [ECHO_ENTRY, otherEntry],
      servers: { everything: ECHO_SERVER, github: { command: 'gh', args: ['mcp'] } },
    });
    // The node selects only `everything` — `github` must NOT be provisioned.
    const cat = catalogForSpec(specSelecting(['mcp.everything:echo']));
    expect(cat.extraEntries).toEqual([ECHO_ENTRY]);
    expect(cat.servers).toEqual({ everything: ECHO_SERVER });
  });
});

describe('catalogForSpec — additivity (no slice / no mcp.* ⇒ output unchanged)', () => {
  it('returns an empty slice when no catalog dir exists', () => {
    const cat = catalogForSpec(specSelecting(['fs:read', 'mcp.everything:echo']));
    expect(cat.extraEntries).toEqual([]);
    expect(cat.servers).toEqual({});
  });

  it('returns an empty slice when the node selects no mcp.* address (slice present but unselected)', () => {
    writeMcpIndex({ entries: [ECHO_ENTRY], servers: { everything: ECHO_SERVER } });
    const cat = catalogForSpec(specSelecting(['fs:read', 'oc.calc:add']));
    expect(cat.extraEntries).toEqual([]);
    expect(cat.servers).toEqual({});
  });

  it('resolveRunTools with no mcp selection matches assembleRunTools({ spec }) — no mcpConfig, same binds', () => {
    writeMcpIndex({ entries: [ECHO_ENTRY], servers: { everything: ECHO_SERVER } });
    const spec = specSelecting(['oc.calc:add', 'contract:submit_result', 'fs:write']);

    const wired = resolveRunTools(spec, {});
    const baseline = assembleRunTools({ spec });

    // No node authored mcp.servers and nothing selected a catalog server ⇒ no mcpConfig (byte-identical to
    // the all-native baseline: an unrelated slice never leaks a server into the run).
    expect(wired.mcpConfig).toBeUndefined();
    expect(baseline.mcpConfig).toBeUndefined();
    // The registry binds the same set the baseline does (the slice added nothing the node didn't select).
    const sel = spec.nodes[0].tools;
    expect(wired.registry!.resolve(sel).piTools).toEqual(baseline.registry.resolve(sel).piTools);
  });

  it('explicit-caller-wins — a caller-supplied registry bypasses the catalog entirely', () => {
    writeMcpIndex({ entries: [ECHO_ENTRY], servers: { everything: ECHO_SERVER } });
    const spec = specSelecting(['mcp.everything:echo']);
    const sentinel = assembleRunTools({ spec: specSelecting(['fs:read']) }).registry;

    const { registry, mcpConfig } = resolveRunTools(spec, { registry: sentinel });
    expect(registry).toBe(sentinel);
    // The guard returns the caller's inputs verbatim — the catalog is NOT consulted, so no mcpConfig is added.
    expect(mcpConfig).toBeUndefined();
  });
});

describe('loadMcpCatalog — slice envelope shapes', () => {
  it('accepts a bare ToolEntry[] index (no servers)', () => {
    writeMcpIndex([ECHO_ENTRY]);
    const cat = loadMcpCatalog(home);
    expect(cat.entries).toEqual([ECHO_ENTRY]);
    expect(cat.servers).toEqual({});
  });

  it('accepts a { entries, servers } envelope', () => {
    writeMcpIndex({ entries: [ECHO_ENTRY], servers: { everything: ECHO_SERVER } });
    const cat = loadMcpCatalog(home);
    expect(cat.entries).toEqual([ECHO_ENTRY]);
    expect(cat.servers).toEqual({ everything: ECHO_SERVER });
  });

  it('merges a separate catalog/mcp.servers.json (index envelope wins on key conflict)', () => {
    writeMcpIndex({ entries: [ECHO_ENTRY] });
    writeFileSync(path.join(home, 'catalog', 'mcp.servers.json'), JSON.stringify({ everything: ECHO_SERVER }), 'utf8');
    const cat = loadMcpCatalog(home);
    expect(cat.servers).toEqual({ everything: ECHO_SERVER });
  });

  it('returns empty (never throws) on an absent index', () => {
    expect(loadMcpCatalog(home)).toEqual({ entries: [], servers: {} });
  });

  it('returns empty (never throws) on a corrupt index — a bad catalog never fails a run', () => {
    mkdirSync(path.join(home, 'catalog'), { recursive: true });
    writeFileSync(path.join(home, 'catalog', 'mcp.index.json'), '{ not json', 'utf8');
    expect(loadMcpCatalog(home)).toEqual({ entries: [], servers: {} });
  });
});
