// driver-fits.ts — author-time driver fit-preflight (docs/design/agent-driver-registry.md §2.4, P4).
//
// The ONE new fit axis a driver genuinely adds, scoped to EXACTLY 2 dimensions the shipped
// `skill-manifest.ts` (`preflightSkills`) does NOT cover — the executor's own capability envelope:
//   (1) SANDBOX — can this executor actually run on the node's declared sandbox provider?
//   (2) TIER-VS-PIN — a driver that pins a model (tierAware:false) cannot honor a node's `tier` class.
// Loadout/tool/skill fit continues to flow through the shipped `resolveSkillLoadout` + `preflightSkills`;
// `driverFits` deliberately does NOT re-answer it (the §2.4 reviewer note). PURE — no I/O, no catalog access.
//
// It reads ONLY `driver.describe()` (the static card) + the node's `sandbox.provider` / `tier`, and returns
// a list of human-readable problems (each names the offending value AND the driver's allowed envelope so an
// author can self-correct). The advisory-warn wiring (node-lifecycle.ts) surfaces these; `--strict` blocks.

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
  const card = driver.describe();
  const problems: string[] = [];

  // AXIS 1 — SANDBOX. A node's declared sandbox provider MUST be one the executor can actually run on
  // (`describe().sandbox.providers`). Name both the offending provider and the allowed set so the author
  // can self-correct. Undefined provider ⇒ no assertion (the loader picks a backend the driver supports).
  const nodeProvider = node.sandbox?.provider;
  if (nodeProvider && !card.sandbox.providers.includes(nodeProvider)) {
    problems.push(
      `driver "${card.id}" cannot run on sandbox provider "${nodeProvider}" ` +
        `(it supports: ${card.sandbox.providers.join(', ')})`,
    );
  }

  // AXIS 2 — TIER-VS-PIN. A model-PINNING driver (`describe().model.tierAware === false`) cannot honor a
  // node's `tier` class — the tier would be silently ignored. Flag it (naming the ignored tier).
  if (node.tier && card.model.tierAware === false) {
    problems.push(
      `driver "${card.id}" pins its own model (tierAware:false) and cannot honor node tier "${node.tier}"`,
    );
  }

  return { ok: problems.length === 0, problems };
}
