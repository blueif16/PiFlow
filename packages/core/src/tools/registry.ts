// The tool registry — addresses tools by `namespace:name`, resolves a node's selection to the bare
// names pi sees (`--tools`), and searches the catalog. `namespace:name` is a pure SDK abstraction;
// pi only ever sees flat `piName`s. Built-ins resolve directly; sdk/mcp tools (ROADMAP M2) also
// require a generated `-e` extension, flagged here via `ResolveResult.extension`.

import type { ToolEntry, ToolRegistry, ToolSelection, ResolveResult, ToolSource } from '../types.js';
import { compileToolExtension, bundleExtension } from './compile.js';

/** pi's native built-in tools, addressed under `fs:` / `sh:`. */
export const BUILTIN_TOOLS: ToolEntry[] = [
  { address: 'fs:read', source: 'builtin', piName: 'read', description: 'Read a file.', origin: { kind: 'native' } },
  { address: 'fs:write', source: 'builtin', piName: 'write', description: 'Write a file.', origin: { kind: 'native' } },
  { address: 'fs:edit', source: 'builtin', piName: 'edit', description: 'Edit a file in place.', origin: { kind: 'native' } },
  { address: 'fs:grep', source: 'builtin', piName: 'grep', description: 'Search file contents.', origin: { kind: 'native' } },
  { address: 'fs:find', source: 'builtin', piName: 'find', description: 'Find files by name.', origin: { kind: 'native' } },
  { address: 'fs:ls', source: 'builtin', piName: 'ls', description: 'List a directory.', origin: { kind: 'native' } },
  { address: 'sh:bash', source: 'builtin', piName: 'bash', description: 'Run a shell command.', origin: { kind: 'native' } },
];

export class DefaultToolRegistry implements ToolRegistry {
  private readonly byAddress = new Map<string, ToolEntry>();
  private readonly piNames = new Set<string>();

  constructor(seed: ToolEntry[] = BUILTIN_TOOLS) {
    for (const e of seed) this.register(e);
  }

  register(entry: ToolEntry): void {
    let piName = entry.piName;
    // conflict-guard: a non-builtin tool must not collide with an existing bare name → prefix it.
    const existing = this.byAddress.get(entry.address);
    const collides = this.piNames.has(piName) && existing?.piName !== piName;
    if (entry.source !== 'builtin' && collides) {
      piName = `${entry.source}_${piName}`.replace(/[^a-zA-Z0-9_]/g, '_');
    }
    if (existing) this.piNames.delete(existing.piName);
    const stored: ToolEntry = { ...entry, piName };
    this.byAddress.set(stored.address, stored);
    this.piNames.add(piName);
  }

  resolve(sel: ToolSelection): ResolveResult {
    const allow = sel.allow && sel.allow.length ? sel.allow : BUILTIN_TOOLS.map((t) => t.address);
    const deny = new Set(sel.deny ?? []);
    const piTools: string[] = [];
    const nonBuiltin: ToolEntry[] = [];
    const seenNonBuiltin = new Set<string>();
    for (const address of allow) {
      if (deny.has(address)) continue;
      const e = this.byAddress.get(address);
      if (!e) throw new Error(`unknown tool address: "${address}" (register it before resolving)`);
      if (!piTools.includes(e.piName)) piTools.push(e.piName);
      if (e.source !== 'builtin' && !seenNonBuiltin.has(e.address)) {
        seenNonBuiltin.add(e.address);
        nonBuiltin.push(e);
      }
    }
    const result: ResolveResult = { piTools };
    // sdk/mcp tools have no native pi support — compile a generated `-e` extension that binds them, then
    // BUNDLE it host-side (esbuild buildSync — `resolve` stays SYNC) into ONE self-contained ESM file so
    // the bridge/SDK/plugin/shim are INLINED and the staged `_pi/tools.ts` resolves on every provider
    // (outside-repo temp dir / empty cloud VM included), not just where an up-tree node_modules exists.
    if (nonBuiltin.length) result.extension = bundleExtension(compileToolExtension(nonBuiltin).source);
    return result;
  }

  search(query: string, opts: { source?: ToolSource; limit?: number } = {}): ToolEntry[] {
    const q = query.toLowerCase();
    const hits = [...this.byAddress.values()].filter((e) => {
      if (opts.source && e.source !== opts.source) return false;
      return (
        e.address.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    });
    return opts.limit ? hits.slice(0, opts.limit) : hits;
  }

  /** All registered entries (discovery / debugging). */
  list(): ToolEntry[] {
    return [...this.byAddress.values()];
  }
}
