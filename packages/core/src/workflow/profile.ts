// ─────────────────────────────────────────────────────────────────────────────
// Run PROFILES — the GENERIC node-elision primitive (profiles-and-resume-robustness.md Phase 2).
//
// A run compiles against a named PROFILE that ELIDES a subset of nodes. This module owns ONE pure
// transform over a `WorkflowSpec` and carries NO product vocabulary: it knows only "elide the nodes
// this predicate matches, then rewire deps so the surviving graph is gateless." The product TEMPLATE
// declares the named profiles (the names are the product's vocabulary) as DATA in meta.json; the SDK
// applies the predicate verbatim and never branches on a profile name.
//
// THE LOAD-BEARING REWIRE (transitive bypass): when node N is elided, every dependent D that listed N
// in its `deps` (the spec's `io.dependsOn`) must instead depend on N's OWN deps — and if those are also
// elided, on THEIR deps, transitively, until a SURVIVING node is reached. So a chain
//   a → v1 → b → v2 → c   (eliding v1,v2)
// collapses to a → b → c. Without the rewire, `b.deps` would still name the now-absent `v1` and the DAG
// would dangle (compile error) or, worse, silently drop the a→b ordering.
// ─────────────────────────────────────────────────────────────────────────────

import type { NodeIntent, ProfileSpec, WorkflowSpec } from '../types.js';

/** Thrown when a run names a profile the template does not declare. Lists the declared names (loud, not silent). */
export class UnknownProfileError extends Error {
  /** The unknown profile name the run requested. */
  public readonly profileName: string;
  constructor(
    profileName: string,
    public readonly declared: string[],
  ) {
    const list = declared.length ? declared.join(', ') : '(none declared)';
    super(`unknown profile "${profileName}" — declared profiles: ${list}`);
    this.name = 'UnknownProfileError';
    this.profileName = profileName;
  }
}

/**
 * Resolve the ACTIVE `ProfileSpec` for a run from the spec's declared `profiles`.
 *
 * Precedence: an explicit `name` (the `--profile` flag) → that declared profile, ERRORING loudly if the
 * name is unknown (never a silent full-DAG fallback). No explicit name → `defaultProfile` (if declared)
 * → else `undefined` (no elision = the full DAG). A declared `defaultProfile` that names a missing
 * profile is also a loud error (a malformed template, caught at run start).
 */
export function resolveProfile(spec: WorkflowSpec, name?: string): ProfileSpec | undefined {
  const profiles = spec.profiles ?? {};
  const declared = Object.keys(profiles);
  const pick = name ?? spec.defaultProfile;
  if (pick === undefined) return undefined; // no name, no default ⇒ the full DAG
  const p = profiles[pick];
  if (!p) throw new UnknownProfileError(pick, declared);
  return p;
}

/** True iff this profile predicate elides nothing (no keys set) — the `{}` (empty-predicate) no-op. */
function isNoOpProfile(p: ProfileSpec): boolean {
  return !(p.elidePhases && p.elidePhases.length > 0);
}

/** The set of node LABELS (= spec-level ids; the DAG compiler slugs labels→ids 1:1 for slug-safe ids) the profile elides. */
function elidedLabels(spec: WorkflowSpec, p: ProfileSpec): Set<string> {
  const elide = new Set<string>();
  if (p.elidePhases && p.elidePhases.length) {
    const phases = new Set(p.elidePhases);
    for (const n of spec.nodes) if (n.phase !== undefined && phases.has(n.phase)) elide.add(n.label);
  }
  return elide;
}

/**
 * Resolve one dep id to the surviving id(s) it bypasses to: if `dep` is NOT elided, it survives as-is;
 * if it IS elided, recurse into ITS deps (transitive bypass), guarding against cycles via `seen`. A
 * Set return de-duplicates the (rare) diamond where two elided paths converge on the same survivor.
 */
function bypass(
  dep: string,
  elided: Set<string>,
  depsOf: Map<string, string[]>,
  seen: Set<string>,
): string[] {
  if (!elided.has(dep)) return [dep]; // a surviving node — keep the edge
  if (seen.has(dep)) return []; // cycle guard: don't re-expand a node already on this path
  seen.add(dep);
  const out: string[] = [];
  for (const up of depsOf.get(dep) ?? []) {
    for (const r of bypass(up, elided, depsOf, seen)) out.push(r);
  }
  return out;
}

/**
 * Apply a resolved PROFILE to a `WorkflowSpec`: remove the elided nodes and REWIRE every survivor's
 * `io.dependsOn` so an elided dep is replaced by its own (transitively resolved) surviving deps. Pure —
 * returns a NEW spec; the input is untouched. A no-op profile (or `undefined`) returns the spec verbatim
 * (referential identity), so the full-DAG path is byte-for-byte unchanged.
 */
export function applyProfile(spec: WorkflowSpec, profile?: ProfileSpec): WorkflowSpec {
  if (!profile || isNoOpProfile(profile)) return spec;
  const elided = elidedLabels(spec, profile);
  if (elided.size === 0) return spec; // predicate matched nothing → unchanged

  // The dep adjacency (by label) used for transitive bypass — read from each node's declared dependsOn.
  const depsOf = new Map<string, string[]>(spec.nodes.map((n) => [n.label, n.io.dependsOn ?? []]));

  const nodes: NodeIntent[] = [];
  for (const n of spec.nodes) {
    if (elided.has(n.label)) continue; // drop the elided node itself
    const oldDeps = n.io.dependsOn;
    if (!oldDeps || oldDeps.length === 0) {
      nodes.push(n); // no deps to rewire — carry through unchanged
      continue;
    }
    // Rewire: each dep → its surviving bypass target(s); de-dup while preserving first-seen order.
    const rewired: string[] = [];
    const seenDeps = new Set<string>();
    for (const dep of oldDeps) {
      for (const r of bypass(dep, elided, depsOf, new Set<string>())) {
        if (r !== n.label && !seenDeps.has(r)) {
          seenDeps.add(r);
          rewired.push(r);
        }
      }
    }
    nodes.push({ ...n, io: { ...n.io, dependsOn: rewired } });
  }

  // Carry the rest of the spec verbatim (incl. the profiles map itself — harmless, informational).
  return { ...spec, nodes };
}

/**
 * Resolve + apply in one step: pick the active profile for `name` off the spec, then elide. This is the
 * one call the run path makes before `compile(spec)`. An unknown `name` throws `UnknownProfileError`.
 */
export function applyProfileByName(spec: WorkflowSpec, name?: string): WorkflowSpec {
  return applyProfile(spec, resolveProfile(spec, name));
}
