import { describe, it, expect } from 'vitest';
import { DefaultToolRegistry } from '../src/index.js';

describe('DefaultToolRegistry.resolve', () => {
  it('maps builtin addresses to bare pi names', () => {
    const r = new DefaultToolRegistry();
    expect(r.resolve({ allow: ['fs:read', 'sh:bash'] })).toEqual({ piTools: ['read', 'bash'] });
  });

  it('applies deny after allow', () => {
    const r = new DefaultToolRegistry();
    expect(r.resolve({ allow: ['fs:read', 'fs:write'], deny: ['fs:write'] }).piTools).toEqual(['read']);
  });

  it('defaults an empty selection to all builtins', () => {
    const r = new DefaultToolRegistry();
    const tools = r.resolve({}).piTools;
    expect(tools).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'grep', 'find', 'ls', 'bash']));
  });

  it('throws on an unknown address', () => {
    const r = new DefaultToolRegistry();
    expect(() => r.resolve({ allow: ['nope:tool'] })).toThrow(/unknown tool address/);
  });

  it('generates a real -e extension that binds sdk tools, and conflict-guards the bare name', () => {
    const r = new DefaultToolRegistry();
    r.register({ address: 'web:search', source: 'sdk', piName: 'search', description: 'web search' });
    const res = r.resolve({ allow: ['web:search'] });
    expect(res.piTools).toEqual(['search']);
    // not a placeholder anymore — resolve emits loadable extension source that registers the tool.
    expect(res.extension).toContain('registerTool');
    expect(res.extension).toContain('name: "search"');

    // an sdk tool whose piName collides with a builtin must be prefixed, never shadow the builtin
    r.register({ address: 'http:read', source: 'sdk', piName: 'read', description: 'http read' });
    expect(r.resolve({ allow: ['http:read'] }).piTools).toEqual(['sdk_read']);
    expect(r.resolve({ allow: ['fs:read'] }).piTools).toEqual(['read']);
  });

  it('emits NO extension when a selection is all builtins', () => {
    const r = new DefaultToolRegistry();
    expect(r.resolve({ allow: ['fs:read', 'sh:bash'] }).extension).toBeUndefined();
  });
});

describe('DefaultToolRegistry.search', () => {
  it('matches on address, description, and tags', () => {
    const r = new DefaultToolRegistry();
    expect(r.search('bash').map((e) => e.address)).toContain('sh:bash');
    expect(r.search('file').length).toBeGreaterThan(0); // "Read a file." etc.
    r.register({ address: 'web:search', source: 'sdk', piName: 'search', description: 'search the web', tags: ['http'] });
    expect(r.search('http', { source: 'sdk' }).map((e) => e.address)).toEqual(['web:search']);
  });
});
