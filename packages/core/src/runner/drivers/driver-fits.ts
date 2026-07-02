// driver-fits.ts — author-time driver fit-preflight (docs/design/agent-driver-registry.md §2.4, P4).
//
// The ONE new fit axis a driver genuinely adds, scoped to EXACTLY 2 dimensions the shipped
// `skill-manifest.ts` (`preflightSkills`) does NOT cover — the executor's own capability envelope:
//   (1) SANDBOX — can this executor actually run on the node's declared sandbox provider?
//   (2) TIER-VS-PIN — a driver that pins a model (tierAware:false) cannot honor a node's `tier` class.
// Loadout/tool/skill fit continues to flow through the shipped `resolveSkillLoadout` + `preflightSkills`;
// `driverFits` deliberately does NOT re-answer it (the §2.4 reviewer note). PURE — no I/O, no catalog access.
//
// P4 STUB: currently returns {ok:true, problems:[]} UNCONDITIONALLY (no axis is checked yet). The failing
// tests in test/driver-fits.test.ts pin the real 2-axis behavior; the real bodies replace this stub.

import type { AgentDriver } from './types.js';
import type { SandboxSpec } from '../../types.js';
import type { NodeRouting } from '../model-routing.js';

/** The result of an author-time driver fit check: `ok` when no capability problem was found. */
export interface FitResult {
  ok: boolean;
  problems: string[];
}

/**
 * Does `driver` fit the node's declared sandbox provider + tier? Checks EXACTLY the 2 axes a driver adds
 * (sandbox provider · tier-vs-model-pin); loadout/skill/tool fit stays on the shipped `preflightSkills`.
 * PURE — reads only `driver.describe()` (static) and the node's `sandbox.provider` / `tier`.
 */
export function driverFits(
  node: NodeRouting & { sandbox?: Partial<SandboxSpec>; tier?: string },
  driver: AgentDriver,
): FitResult {
  // STUB — no axis checked yet (always "fits"). The real 2-axis logic replaces this.
  void node;
  void driver;
  const problems: string[] = [];
  return { ok: problems.length === 0, problems };
}
