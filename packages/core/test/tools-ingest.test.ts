import { describe, it, expect } from 'vitest';
import { mcpToolsToEntries, DefaultToolRegistry, openClawPluginToEntries } from '../src/index.js';
import type { McpToolListing, OpenClawManifest } from '../src/index.js';

// A realistic slice of an MCP server's `tools/list` reply (the shape the effortless fetch consumes).
const GITHUB_LIST: McpToolListing[] = [
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string' }, title: { type: 'string' } },
      required: ['repo', 'title'],
    },
  },
  { name: 'list_repos', description: 'List repositories for the authenticated user.' }, // no inputSchema
];

describe('mcpToolsToEntries — the effortless catalog fill', () => {
  it('maps each MCP tool 1:1 onto a ToolEntry (address, source, piName, params, origin)', () => {
    const entries = mcpToolsToEntries('github', GITHUB_LIST);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      address: 'mcp.github:create_issue',
      source: 'mcp',
      piName: 'github_create_issue',
      description: 'Open a new issue in a repository.',
      parameters: GITHUB_LIST[0].inputSchema,
      origin: { kind: 'mcp-server', ref: 'github' },
    });
  });

  it('omits parameters when the server declares no inputSchema (does not invent an empty one)', () => {
    const [, listRepos] = mcpToolsToEntries('github', GITHUB_LIST);
    expect(listRepos.address).toBe('mcp.github:list_repos');
    expect('parameters' in listRepos).toBe(false);
  });

  it('sanitizes the piName to pi\'s bare-name charset while keeping the raw address', () => {
    // a server/tool with dots + dashes — illegal in a pi bare name, fine in the colon address.
    const [e] = mcpToolsToEntries('chrome-devtools', [{ name: 'take.screenshot', description: 'snap' }]);
    expect(e.address).toBe('mcp.chrome-devtools:take.screenshot'); // address preserves raw spelling
    expect(e.piName).toBe('chrome_devtools_take_screenshot'); // wire name is sanitized + server-prefixed
    expect(e.piName).toMatch(/^[a-zA-Z0-9_]+$/);
  });

  it('attaches tags when asked (so registry.search can find ingested tools)', () => {
    const [e] = mcpToolsToEntries('github', [GITHUB_LIST[0]], { tags: ['mcp', 'github'] });
    expect(e.tags).toEqual(['mcp', 'github']);
  });

  it('round-trips into the registry: register → resolve yields the sanitized piName; search finds it', () => {
    const reg = new DefaultToolRegistry();
    for (const e of mcpToolsToEntries('github', GITHUB_LIST, { tags: ['mcp', 'github'] })) reg.register(e);

    // the design-agent declares the SDK address; resolve compiles it to the bare pi name + flags an extension.
    const res = reg.resolve({ allow: ['mcp.github:create_issue'] });
    expect(res.piTools).toEqual(['github_create_issue']);
    expect(res.extension).toBeTruthy(); // a non-builtin tool requires a generated -e extension

    // discovery works off the ingested description/tags.
    expect(reg.search('issue', { source: 'mcp' }).map((x) => x.address)).toContain('mcp.github:create_issue');
    expect(reg.search('github').length).toBe(2);
  });
});

// ── OpenClaw `sdk` lane: the names-only manifest → skeleton ToolEntry[] ─────────────────────────────
// A SHIPPED `openclaw.plugin.json` carries tool NAMES ONLY — never description/parameters (those live in
// the plugin's register() body, recovered later by the capture-shim). So the static ingest yields a
// SKELETON entry; it must NOT invent a description or a parameters schema.

const MEMORY_MANIFEST: OpenClawManifest = {
  id: 'memory-core',
  name: 'Memory Core',
  description: 'Long-term memory for the agent.',
  contracts: { tools: ['memory_get', 'memory_search'] },
  toolMetadata: { memory_get: { replaySafe: true }, memory_search: { optional: true } },
};

describe('openClawPluginToEntries — the names-only OpenClaw manifest ingest', () => {
  it('maps each contracts.tools name to a skeleton sdk ToolEntry (address/source/piName/origin)', () => {
    const entries = openClawPluginToEntries(MEMORY_MANIFEST);
    expect(entries).toHaveLength(2);
    expect(entries[0].address).toBe('oc.memory-core:memory_get');
    expect(entries[0].source).toBe('sdk');
    expect(entries[0].piName).toBe('memory_core_memory_get'); // sanitized (dash→_) + plugin-prefixed
    expect(entries[0].origin).toEqual({ kind: 'openclaw-plugin' });
    expect(entries[1].address).toBe('oc.memory-core:memory_search');
  });

  it('does NOT fabricate description or parameters (the manifest carries neither)', () => {
    const [e] = openClawPluginToEntries(MEMORY_MANIFEST);
    // description is empty (not a made-up string); parameters is absent entirely (not an empty schema).
    expect(e.description).toBe('');
    expect('parameters' in e).toBe(false);
  });

  it('sanitizes the piName to pi\'s bare charset while the address keeps the raw plugin/tool spelling', () => {
    const manifest: OpenClawManifest = {
      id: 'web-readability',
      contracts: { tools: ['extract.main'] },
    };
    const [e] = openClawPluginToEntries(manifest);
    expect(e.address).toBe('oc.web-readability:extract.main'); // raw spelling in the address
    expect(e.piName).toBe('web_readability_extract_main'); // sanitized + prefixed
    expect(e.piName).toMatch(/^[a-zA-Z0-9_]+$/);
  });

  it('records the pin in origin.ref when a module/ref is supplied (for the generated -e import)', () => {
    const [e] = openClawPluginToEntries(MEMORY_MANIFEST, { ref: '@openclaw/memory-core@2026.6.8' });
    expect(e.origin).toEqual({ kind: 'openclaw-plugin', ref: '@openclaw/memory-core@2026.6.8' });
  });

  it('attaches tags when asked (so registry.search finds the sdk tools)', () => {
    const [e] = openClawPluginToEntries(MEMORY_MANIFEST, { tags: ['openclaw', 'memory-core'] });
    expect(e.tags).toEqual(['openclaw', 'memory-core']);
  });

  it('yields an empty list when the manifest declares no contracts.tools (provider/channel plugin)', () => {
    expect(openClawPluginToEntries({ id: 'discord' })).toEqual([]);
    expect(openClawPluginToEntries({ id: 'discord', contracts: {} })).toEqual([]);
  });

  it('round-trips into the registry: register → resolve yields the piName + flags an extension', () => {
    const reg = new DefaultToolRegistry();
    for (const e of openClawPluginToEntries(MEMORY_MANIFEST, { tags: ['openclaw'] })) reg.register(e);
    const res = reg.resolve({ allow: ['oc.memory-core:memory_get'] });
    expect(res.piTools).toEqual(['memory_core_memory_get']);
    expect(res.extension).toBeTruthy(); // a non-builtin (sdk) tool requires a generated -e extension
  });
});
