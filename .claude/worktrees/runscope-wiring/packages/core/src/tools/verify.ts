// Bind verification — the per-node PRE-CHECK that a node actually GETS every function it declared.
// "Verified, not trusted" (spine philosophy #8) applied to tools: a node declares `tools.allow` in
// `namespace:name` addresses; before pi is spawned the runner confirms each declared address binds to
// exactly one bare pi name, with nothing missing and nothing colliding. This is the tool analogue of
// the artifact contract check — declared ⊆ bindable, or the node is `blocked` before it runs.
//
// Two failures are real and independently justifiable (the rest is tautology — don't assert it):
//   • MISSING   — a declared address has no catalog entry, so the function simply won't exist for the
//                 node (it declared a capability the registry can't provide).
//   • COLLISION — two declared addresses resolve to the SAME bare piName. pi's tool space is FLAT and
//                 silently skips conflicts (r/mcp Bifrost: "the LLM picks the wrong one"), so two tools
//                 sharing one name means the node binds the wrong function. The registry prefixes
//                 sdk/mcp names to prevent this; the check is the loud backstop if it ever slips.

import type { ToolEntry, ToolSelection } from '../types.js';

/** The result of checking a node's declared toolset against the catalog. */
export interface BindReport {
  /** True iff every declared tool binds to a unique bare name (nothing missing, nothing colliding). */
  ok: boolean;
  /** The addresses the node requested (allow minus deny; the builtin set when allow is empty). */
  declared: string[];
  /** The bare piNames the node will actually have (deduped). */
  bound: string[];
  /** Declared addresses with no catalog entry — they will not bind. */
  missing: string[];
  /** Bare names that ≥2 distinct declared addresses map to (a silent-skip hazard). */
  collisions: { piName: string; addresses: string[] }[];
  /** Human-readable summary lines (surfaced in the node's status on failure). */
  issues: string[];
}

/**
 * Check a node's `ToolSelection` against the catalog. Resolves the declared addresses (allow minus
 * deny; the builtin set when allow is empty) to their bare piNames and flags anything that won't bind
 * cleanly: an address with no catalog entry (MISSING) or two addresses sharing one bare name (COLLISION).
 */
export function verifyToolBinding(sel: ToolSelection, entries: ToolEntry[]): BindReport {
  const byAddress = new Map(entries.map((e) => [e.address, e]));
  const builtinAddresses = entries.filter((e) => e.source === 'builtin').map((e) => e.address);
  const deny = new Set(sel.deny ?? []);
  const requested = sel.allow && sel.allow.length ? sel.allow : builtinAddresses;

  // Declared = the requested addresses, deduped, with the denylist removed.
  const declared: string[] = [];
  for (const a of requested) if (!deny.has(a) && !declared.includes(a)) declared.push(a);

  const missing: string[] = [];
  const addressesByPiName = new Map<string, string[]>();
  const bound: string[] = [];
  for (const addr of declared) {
    const e = byAddress.get(addr);
    if (!e) {
      missing.push(addr);
      continue;
    }
    const seen = addressesByPiName.get(e.piName);
    if (seen) seen.push(addr);
    else addressesByPiName.set(e.piName, [addr]);
    if (!bound.includes(e.piName)) bound.push(e.piName);
  }

  const collisions = [...addressesByPiName.entries()]
    .filter(([, addrs]) => addrs.length > 1)
    .map(([piName, addresses]) => ({ piName, addresses }));

  const issues: string[] = [];
  if (missing.length) issues.push(`declared tool(s) not in catalog (will not bind): ${missing.join(', ')}`);
  for (const c of collisions) {
    issues.push(`bare-name collision on "${c.piName}" — ${c.addresses.join(' + ')} collide; pi would silently drop one`);
  }

  return { ok: missing.length === 0 && collisions.length === 0, declared, bound, missing, collisions, issues };
}
