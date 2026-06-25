// ─────────────────────────────────────────────────────────────────────────────
// generateRunName — Docker-style memorable run names: `<bake-adjective>-<pie>` (e.g. "flaky-pecan",
// "golden-banoffee"). When `piflow run` is invoked WITHOUT `--run/--id`, the CLI calls this to mint a
// stable, collision-free identity for the run, decoupling a run's identity from any prompt id.
//
// The two word lists are DATA: adjectives.json (hand-authored, ~45 baking flavors) and pies.json (DERIVED
// from named_pie_versions.csv via generate-pies.mjs — regenerable, never hand-edited). ~45 × ~150 ≈ 6500+
// combinations, so collisions are rare; when one happens we re-pick.
//
// PURE + DETERMINISTIC under an injected RNG: `generateRunName(existing, rng)` takes the set of names
// already in use and a `() => number` in [0,1). With the default Math.random it is the production path;
// with a seeded/stub rng a test asserts EXACT outputs and the collision-retry behavior.
// ─────────────────────────────────────────────────────────────────────────────

import adjectivesData from './adjectives.json' with { type: 'json' };
import piesData from './pies.json' with { type: 'json' };

/** The baking-flavored adjective half of a run name (the disambiguator). */
export const ADJECTIVES: readonly string[] = adjectivesData as string[];
/** The pie half (the anchor) — derived from the CSV by generate-pies.mjs. */
export const PIES: readonly string[] = piesData as string[];

/** A `[0,1)` random source. Default `Math.random`; a test injects a deterministic stub. */
export type Rng = () => number;

/** Pick one element of `list` using `rng` (uniform over the list length). */
function pick<T>(list: readonly T[], rng: Rng): T {
  return list[Math.floor(rng() * list.length)];
}

/**
 * Mint a `<adjective>-<pie>` run name NOT present in `existing`. Picks an adjective + pie via `rng`; if the
 * combination is already taken, RE-PICKS (up to `maxTries`, default the whole combination space) until a
 * free name is found. If every combination is somehow exhausted, it appends a numeric suffix to a fresh
 * pick so the function NEVER returns a colliding name (the contract the collision test pins).
 *
 * @param existing run names already in use (e.g. the run-dir basenames under the canonical runs home).
 * @param rng     a `[0,1)` source — default `Math.random`; inject a stub for deterministic tests.
 */
export function generateRunName(existing: Iterable<string> = [], rng: Rng = Math.random): string {
  const taken = new Set(existing);
  const space = ADJECTIVES.length * PIES.length;
  const maxTries = Math.max(space, 1);

  for (let i = 0; i < maxTries; i++) {
    const name = `${pick(ADJECTIVES, rng)}-${pick(PIES, rng)}`;
    if (!taken.has(name)) return name;
  }

  // Combination space exhausted (or RNG keeps landing on taken names) — guarantee uniqueness with a suffix.
  const base = `${pick(ADJECTIVES, rng)}-${pick(PIES, rng)}`;
  let n = 2;
  let name = `${base}-${n}`;
  while (taken.has(name)) name = `${base}-${++n}`;
  return name;
}
