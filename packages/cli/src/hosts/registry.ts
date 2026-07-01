// The host registry — the ONE place a `--host` string resolves to its adapter (design:
// docs/design/control-plane-hosting-uniform.md §3.6). `resolveAdapter` is the parser's validation gate: an
// unknown host errors with the known set, so a typo never reaches `--execute`.
//
// EXTENSION POINT: adding a 5th host = one import + one row below — nothing else in the pipeline changes.
// Keep the rows sorted for a stable error list.

import type { HostAdapter } from './adapter.js';
import { flyAdapter } from './fly.js';
import { railwayAdapter } from './railway.js';
import { selfhostAdapter } from './selfhost.js';
import { dockerAdapter } from './docker.js';

/**
 * Every known hosting pathway, keyed by its `--host` value. All four come from the ONE SSOT control-vm image
 * + the SAME mintCloudSecrets + the SAME smoke — an adapter owns only its provider-CLI argvs + URL shape.
 */
export const ADAPTERS: Record<string, HostAdapter> = {
  fly: flyAdapter,
  railway: railwayAdapter,
  selfhost: selfhostAdapter,
  docker: dockerAdapter,
};

/** Resolve a `--host` value to its adapter. Throws (with the known set) on an unknown host. */
export function resolveAdapter(host: string): HostAdapter {
  const a = ADAPTERS[host];
  if (!a) throw new Error(`unknown --host "${host}" (known: ${Object.keys(ADAPTERS).sort().join(', ')})`);
  return a;
}
