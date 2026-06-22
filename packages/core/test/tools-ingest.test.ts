import { describe, it, expect } from 'vitest';
import { mcpToolsToEntries, DefaultToolRegistry } from '../src/index.js';
import type { McpToolListing } from '../src/index.js';

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
