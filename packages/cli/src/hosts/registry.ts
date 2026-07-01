// The host registry — the ONE place a `--host` string resolves to its adapter (design:
// docs/design/control-plane-hosting-uniform.md §3.6). `resolveAdapter` is the parser's validation gate: an
// unknown host errors with the known set, so a typo never reaches `--execute`.
//
// EXTENSION POINT: the railway / selfhost / docker adapters are separate follow-up work. Each lands as one
// import + one row below — nothing else in the pipeline changes. Keep the rows sorted for a stable error list.

import type { HostAdapter } from './adapter.js';
import { flyAdapter } from './fly.js';

/**
 * Every known hosting pathway, keyed by its `--host` value. Only `fly` is wired today; add
 * `railway`/`selfhost`/`docker` here (one row each) when their adapters land.
 */
export const ADAPTERS: Record<string, HostAdapter> = {
  fly: flyAdapter,
};

/** Resolve a `--host` value to its adapter. Throws (with the known set) on an unknown host. */
export function resolveAdapter(host: string): HostAdapter {
  const a = ADAPTERS[host];
  if (!a) throw new Error(`unknown --host "${host}" (known: ${Object.keys(ADAPTERS).sort().join(', ')})`);
  return a;
}
