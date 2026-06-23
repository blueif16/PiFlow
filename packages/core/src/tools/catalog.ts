// The tiny PERSISTED, SEARCHABLE tool catalog (registry-as-code) — Pi Flow's M4 seed.
//
// A few seeded tools, kept in code (git-tracked, typed, diffable, PR-curated — the HF/MCP-registry
// "metadata as reviewable source" model) and loaded into a DefaultToolRegistry ALONGSIDE the pi builtins,
// so the design agent / a node can DISCOVER (search) and SELECT them by `namespace:name`.
//
// The catalog holds TWO tiers:
//   1. the OpenClaw `sdk` reference seed (`oc.calc:add`) — a real, PURE, end-to-end-proven plugin tool
//      whose NATIVE execute is bound into the generated `-e` (no gateway); and
//   2. the COMMUNITY catalog (openclaw-community.ts) — a curated handful of REAL tool-bearing OpenClaw
//      plugins from a pinned crawl of the ecosystem, persisted as SKELETON, gateway-coupled entries (the
//      shipped `openclaw.plugin.json` is names-only) that are DISCOVERABLE but not standalone-executable.
// Both tiers are produced via `openClawPluginToEntries` (tools/ingest.ts) — the seed inline, the community
// breadth ("however much") from the crawl.

import type { ToolEntry } from '../types.js';
import { DefaultToolRegistry, BUILTIN_TOOLS } from './registry.js';
import { OPENCLAW_COMMUNITY_CATALOG } from './openclaw-community.js';

/**
 * The persisted catalog. The OpenClaw sdk reference seed: `oc.calc:add`, pinned via `origin.ref` to the
 * shipped pure plugin (src/seeds/calc.ts) — the importable module the generated `-e` binds the NATIVE
 * execute from. `description`/`parameters` are authored here (for discovery + the advertised schema);
 * the plugin's real execute is captured at extension load by the shim.
 */
export const OPENCLAW_SEED_CATALOG: ToolEntry[] = [
  {
    address: 'oc.calc:add',
    source: 'sdk',
    piName: 'calc_add',
    description: 'Add two numbers and return their sum (OpenClaw sdk reference seed).',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    tags: ['math', 'arithmetic', 'openclaw', 'example', 'sdk'],
    origin: { kind: 'openclaw-plugin', ref: '@piflow/core/seeds/calc' },
  },
];

/**
 * The persisted catalog: the executable seed (`oc.calc:add`) + the curated community tier. Returns a fresh
 * copy of every entry (with its own `tags` array) so callers can mutate without corrupting the source.
 */
export function loadCatalog(): ToolEntry[] {
  return [...OPENCLAW_SEED_CATALOG, ...OPENCLAW_COMMUNITY_CATALOG].map((e) => ({
    ...e,
    tags: e.tags ? [...e.tags] : undefined,
  }));
}

/**
 * A `DefaultToolRegistry` seeded with the pi builtins + the persisted catalog (+ any `extra` entries) —
 * the registry a run uses to RESOLVE/SEARCH catalog tools, vs the bare builtin-only default. Conflict
 * guarding (sdk/mcp piName prefixing) is the registry's own concern, applied as entries register.
 */
export function seededRegistry(extra: ToolEntry[] = []): DefaultToolRegistry {
  return new DefaultToolRegistry([...BUILTIN_TOOLS, ...loadCatalog(), ...extra]);
}
