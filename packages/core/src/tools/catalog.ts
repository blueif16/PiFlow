// The tiny PERSISTED, SEARCHABLE tool catalog (registry-as-code) — Pi Flow's M4 seed.
//
// A few seeded tools, kept in code (git-tracked, typed, diffable, PR-curated — the HF/MCP-registry
// "metadata as reviewable source" model) and loaded into a DefaultToolRegistry ALONGSIDE the pi builtins,
// so the design agent / a node can DISCOVER (search) and SELECT them by `namespace:name`.
//
// Today the catalog holds the OpenClaw `sdk` reference seed (`oc.calc:add`) — a real, PURE, end-to-end-
// proven plugin tool whose NATIVE execute is bound into the generated `-e` (no gateway). We deliberately
// persist only a FEW: community breadth ("however much") is added later by `openClawPluginToEntries`
// (tools/ingest.ts) over a crawl of the OpenClaw plugin ecosystem, which yields SKELETON entries (the
// shipped `openclaw.plugin.json` is names-only) whose execute path is the same sdk lane.

import type { ToolEntry } from '../types.js';
import { DefaultToolRegistry, BUILTIN_TOOLS } from './registry.js';

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

/** The persisted catalog entries (a fresh copy so callers can mutate without corrupting the seed). */
export function loadCatalog(): ToolEntry[] {
  return OPENCLAW_SEED_CATALOG.map((e) => ({ ...e }));
}

/**
 * A `DefaultToolRegistry` seeded with the pi builtins + the persisted catalog (+ any `extra` entries) —
 * the registry a run uses to RESOLVE/SEARCH catalog tools, vs the bare builtin-only default. Conflict
 * guarding (sdk/mcp piName prefixing) is the registry's own concern, applied as entries register.
 */
export function seededRegistry(extra: ToolEntry[] = []): DefaultToolRegistry {
  return new DefaultToolRegistry([...BUILTIN_TOOLS, ...loadCatalog(), ...extra]);
}
