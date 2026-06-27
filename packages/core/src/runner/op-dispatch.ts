// (U0 · op⊖ops unification) derivesFromOp — the SINGLE home for the `OpSpec → executor-input` adapters
// (plan docs/specs/op-ops-unification-plan.md §2.4). It walks a node's canonical `op[]` envelope and
// reconstructs EXACTLY the executor inputs the runner's legacy `node.ops?.{seed,project,registryProject,
// merge,promote}` derive sites pass today (runner.ts ~999/1048/1056/1069/1161 + ~1356/1537/1545/1564/1795).
//
// It is the PRINCIPLED REPLACEMENT for the legacy `opsToNodeOps` bridge (which reconstructed a `NodeOps`
// shape): same field mappings, but READING FROM `op[]` (the canonical source) and yielding the per-family
// executor-input lists directly (no intermediate `NodeOps` rep). It is now the SOLE derive path — the runner
// reads derives via this helper (runner.ts derive sites) and the legacy `node.ops` rep was retired in U6.
//
// The §2.4 adapter table, honored field-for-field:
//   seed             → Seed { to: o.writes[0], from: transform.from }                         (seed.ts:93)
//   project          → the loose op obj { to: o.writes[0], from: transform.from }             (project.ts:73)
//   projectRegistry  → { source, mapRef, key } from transform                                 (project.ts:261)
//   merge            → MergeSpec { ops: transform.ops }                                        (merge.ts:231)
//   promote          → { from, to, merge: transform.reducer }  ← the NAME FLIP reducer→merge   (promote.ts:69)
//                      (lower.ts:109 — the load-bearing flip the helper unit test pins RED if dropped)
//
// D6 verdict — opt-A (CORRECTED from opt-B at U1e). A RICH project op (`copy`/`assemble`/`union`/`merge`
// subtree-drill) IS authored on a literal NodeSpec via `ops.project` (runner.test.ts "runs project BEFORE
// merge BEFORE promote") — the opt-B grep checked only `node.json` TEMPLATES and missed this literal-spec
// path. Dropping the rich fields would silently lose a real `applyProjectionOp` capability (violating the
// additive invariant), so the project adapter carries the rich loose op objs VERBATIM via `transform.ops`
// (which `TransformBody.project.ops` reserves for exactly this, types.ts:145). The bare `hooks.project` form
// (no `ops`) still reconstructs `{to: writes[0], from}` (lower.ts:104-105). Both reach `applyProjectionOp`
// byte-identically to the legacy `node.ops.project[]` site.

import type { OpSpec, Reducer } from '../types.js';
import type { Seed } from '../workflow/ops/seed.js';
import type { MergeSpec } from '../workflow/ops/merge.js';

/** A loose project op obj — the shape `applyProjectionOp` consumes (project.ts:73). Bare = `{to,from}`
 *  (a `hooks.project`); RICH = `{to, source/copy/assemble/union/…}` (D6/opt-A, carried via `transform.ops`). */
export type ProjectOp = { to: string; from?: string | string[] } & Record<string, unknown>;

/** A resolved registry-projection marker — the shape `runProjection` consumes (project.ts:261). */
export type RegistryProject = { source: string; mapRef: string; key: string };

/** A raw promote — the shape `parsePromote` consumes (promote.ts:69); `merge` is the NAME-FLIPPED reducer. */
export type PromoteInput = { from: string; to: string; merge?: Reducer };

/** The per-family executor inputs reconstructed from a node's `op[]` (one list per derive executor). */
export interface DerivedExecInputs {
  seeds: Seed[];
  projects: ProjectOp[];
  registryProjects: RegistryProject[];
  merges: MergeSpec[];
  promotes: PromoteInput[];
}

/**
 * Reconstruct the five derive families' executor inputs from a node's canonical `op[]`. Mirrors
 * `opsToNodeOps`'s field mappings (lower.ts:99-115) inverted from the SAME `transform` bodies — incl. the
 * NAME FLIP `transform.reducer → {merge}` (lower.ts:109) and `seed`/`project` recovering `to` from
 * `o.writes[0]`. Ops with no `transform` (gate/run/action/inject) are skipped. An `undefined` op[] yields
 * five empty lists (an op-free node derives nothing — additive).
 */
export function derivesFromOp(op: OpSpec[] | undefined): DerivedExecInputs {
  const out: DerivedExecInputs = { seeds: [], projects: [], registryProjects: [], merges: [], promotes: [] };
  for (const o of op ?? []) {
    const t = o.transform;
    if (!t) continue;
    if (t.kind === 'seed') {
      out.seeds.push({ to: (o.writes ?? [])[0], from: t.from });
    } else if (t.kind === 'project') {
      // (D6/opt-A) A RICH project op (copy/assemble/union/merge subtree-drill) rides `transform.ops` as the
      // loose op objs `applyProjectionOp` consumes — carried VERBATIM (each already has its own `to`). The
      // bare `hooks.project` form (no `ops`) reconstructs `{to: writes[0], from}` (lower.ts:104). Either way
      // the runner's project site (`for rawOp of derived.projects → applyProjectionOp`) gets the exact op obj.
      if (t.ops?.length) {
        for (const p of t.ops) out.projects.push(p as ProjectOp);
      } else {
        out.projects.push({ to: (o.writes ?? [])[0], from: t.from as string | string[] });
      }
    } else if (t.kind === 'merge') {
      out.merges.push({ ops: t.ops });
    } else if (t.kind === 'promote') {
      const p: PromoteInput = { from: t.from, to: t.to };
      // THE NAME FLIP (lower.ts:109): the `op[]` transform field is `reducer`; the executor input is `merge`.
      if (t.reducer !== undefined) p.merge = t.reducer;
      out.promotes.push(p);
    } else if (t.kind === 'projectRegistry') {
      out.registryProjects.push({ source: t.source, mapRef: t.mapRef, key: t.key });
    }
  }
  return out;
}
