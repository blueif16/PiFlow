// `assembleRunTools` — the ONE pure builder that seeds the tool catalog into the canonical run path (G11).
//
// The disease (design §4, investigation §3a): the ingest→schema→bind→execute tool pipeline is fully built
// (`seededRegistry()` = pi builtins + the `oc.calc:add` sdk seed + the community catalog) but has ZERO
// non-test callers, so every canonical run falls through to `registry: opts.registry ?? new
// DefaultToolRegistry()` (runner.ts:1347) — a builtins+submit_result-only registry that does NOT carry
// `oc.*`/`mcp.*`, so a node selecting one is `blocked` before pi binds (BLOCKER #1).
//
// This module assembles, from a WorkflowSpec, BOTH halves the runner needs to bind + stage external tools:
//   • `registry`  — `seededRegistry([...ingested mcp rows, ...extraEntries])` PLUS the first-party
//                   `submit_result` contract tool. (`seededRegistry()` alone DROPS submit_result —
//                   catalog.ts:58 = builtins+catalog, not DEFAULT_TOOLS — so adding it back is what makes
//                   the assembled registry a true SUPERSET of `DefaultToolRegistry` for every node, the
//                   additivity bar M1 owes: an oc.* node binds AND a submit_result node still binds.)
//   • `mcpConfig` — the UNION of every node's authored `mcp.servers` (NodeIntent.mcp, the per-node gateway
//                   config), with a byte-identical-or-throw conflict guard: a server key declared twice
//                   with DIFFERENT config throws loudly — NEVER a silent last-wins. A byte-identical
//                   duplicate (the common "two nodes hit the same server" case) merges to one entry.
//
// Pure + deterministic: no I/O, no network — the caller (`mcpListings`) owns any actual MCP `tools/list`
// fetch; this turns the listings into registry rows via `mcpToolsToEntries` and reads the authored config
// off the spec. Absent any `mcp` ⇒ `{ registry }` with NO `mcpConfig`, so an all-native template stages no
// `_pi/mcp.json` (the runner's `selectedBridgedTool && mcpConfig` gate fires on nothing new).

import type { WorkflowSpec, ToolEntry, ToolRegistry } from '../types.js';
import { seededRegistry } from '../tools/catalog.js';
import { SUBMIT_RESULT_TOOL } from '../tools/contract-tool.js';
import { mcpToolsToEntries, type McpToolListing } from '../tools/ingest.js';

/** Inputs to the pure tool-assembly. The spec is the authoring source; the rest are host-supplied. */
export interface AssembleRunToolsInput {
  /** The (profile-elided, fusion-expanded) WorkflowSpec — each node's `tools`/`mcp` is read off it. */
  spec: WorkflowSpec;
  /** Extra catalog rows a host wants in the run registry (beyond the seeded catalog). */
  extraEntries?: ToolEntry[];
  /**
   * Pre-fetched MCP `tools/list` results, keyed by server name — turned into registry rows via
   * `mcpToolsToEntries` so an `mcp.<server>:<tool>` selection BINDS. The fetch itself is the host's job
   * (the MCP-bridge seam); this module is pure.
   */
  mcpListings?: Record<string, McpToolListing[]>;
}

/** What `assembleRunTools` produces — the two halves the runner consumes (`registry` + optional `mcpConfig`). */
export interface AssembledRunTools {
  /** The run's tool registry: seeded catalog + submit_result + ingested mcp rows + extraEntries. */
  registry: ToolRegistry;
  /**
   * The merged MCP server map staged into a bridge-tool node's `_pi/mcp.json`. Undefined when no node
   * declared `mcp.servers` (so the runner stages nothing — the all-native template stays byte-identical).
   */
  mcpConfig?: { servers: Record<string, unknown> };
}

/**
 * Assemble the run's `registry` (seeded catalog + submit_result + ingested mcp rows + extraEntries) and the
 * merged `mcpConfig` (union of every node's `mcp.servers`, byte-identical-or-throw). Pure: reads only the
 * spec + host inputs, performs no I/O. Throws on a conflicting duplicate MCP server key.
 */
export function assembleRunTools({ spec, extraEntries = [], mcpListings = {} }: AssembleRunToolsInput): AssembledRunTools {
  // (1) ingest every supplied MCP listing into catalog rows so `mcp.<server>:<tool>` selections bind.
  const mcpRows: ToolEntry[] = Object.entries(mcpListings).flatMap(([server, tools]) => mcpToolsToEntries(server, tools));

  // (2) the run registry = the seeded catalog (builtins + oc.calc:add + community) + the ingested MCP rows
  // + host extras, PLUS the first-party `submit_result` (seededRegistry drops it; re-add so the assembled
  // registry is a SUPERSET of DefaultToolRegistry — an oc.* node AND a submit_result node both bind).
  const registry = seededRegistry([SUBMIT_RESULT_TOOL, ...mcpRows, ...extraEntries]);

  // (3) merge every node's authored `mcp.servers` into ONE map with a byte-identical-or-throw guard.
  const mcpConfig = mergeMcpServers(spec);

  return mcpConfig ? { registry, mcpConfig } : { registry };
}

/**
 * Union every node's `mcp.servers` into one `{ servers }` map. A server key declared on two nodes with
 * BYTE-IDENTICAL config merges to one entry; a key declared with DIFFERENT config throws loudly (never a
 * silent last-wins). Returns undefined when no node declared any `mcp.servers`.
 */
function mergeMcpServers(spec: WorkflowSpec): { servers: Record<string, unknown> } | undefined {
  const merged: Record<string, unknown> = {};
  let any = false;
  for (const node of spec.nodes) {
    const servers = node.mcp?.servers;
    if (!servers) continue;
    for (const [key, cfg] of Object.entries(servers)) {
      any = true;
      if (Object.prototype.hasOwnProperty.call(merged, key)) {
        // Byte-identical-or-throw: a stable-stringify compare (server config is a plain JSON value). The
        // conflict is a real authoring error (two nodes pointing the same server name at different
        // endpoints/creds), so it fails the run at assembly time — not a silent last-wins.
        if (stableStringify(merged[key]) !== stableStringify(cfg)) {
          throw new Error(
            `assembleRunTools: conflicting MCP server config for "${key}" — two nodes declare it with different config. ` +
              `Resolve to one definition (or use distinct server keys); the run never silently picks one.`,
          );
        }
        continue; // byte-identical duplicate ⇒ keep the existing entry.
      }
      merged[key] = cfg;
    }
  }
  return any ? { servers: merged } : undefined;
}

/** Deterministic JSON stringify (keys sorted at every object level) for an order-insensitive equality compare. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
