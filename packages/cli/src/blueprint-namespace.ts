// The scaffolder-layer string-namespacing helper for `blueprint insert` — the verb's OWN small transform,
// NOT the load-time `graph-rewrite.ts`/`expandSubworkflow` NodeIntent namespacing (that operates on the
// lowered intent layer; this operates on the AUTHORED node.json opts, before scaffoldAddNode writes them).
//
// On an insert, EVERYTHING the verb adds is namespaced by `--ns` so the fragment is collision-free and
// write-disjoint (docs/design/blueprint-compose-verb.md, "Boundaries / invariants"):
//   • node IDS         → `<ns>__<id>` (the subworkflow-inlining prefix pattern)
//   • owns / artifacts → `<ns>/…` (a run-relative path prefix so owns stays WRITE-DISJOINT across lanes)
//   • readScope / inject that are INTERNAL to the fragment → `<ns>/…`; an EXTERNAL seam read (the produce
//     path the fragment binds to) is left VERBATIM (it points at a pre-existing node's output)
//   • `--dep` values that reference another INSERTED lane → its namespaced id; a dep on an EXISTING node
//     (the bound seam producer) is left verbatim
//   • the reroute target (`op.action.node`, here carried on `NodeOpts.reroute.node`) → namespaced iff it
//     targets an inserted lane (it must still resolve to a strict ancestor after namespacing)
//   • post-check `path`s → namespaced in lockstep with the artifact they gate
//
// PURE: every function takes strings/opts in and returns new strings/opts out — no I/O, no mutation of the
// input opts. `ns === ''` is the STAMP degenerate case: every rewrite is the identity (so `stamp` is
// `splice(ns:'')`).

import { slugify } from '@piflow/core';
import type { NodeOpts, CheckOpt } from './scaffold.js';

/** The `{{RUN}}` token (kept local — mirrors tokens.ts OPEN/CLOSE, whitespace-tolerant on read). */
const RUN_RE = /^\{\{\s*RUN\s*\}\}(\/(.*))?$/;

/**
 * Namespace an inserted node id under `<ns>` — SLUGIFIED so the authored id round-trips through the loader
 * (loader.ts:112 uses the authored id AS the compile label and re-`slugify`s it; a raw `<ns>__<id>` would
 * collapse `__`→`-` at compile while its `dependsOn` references stayed literal, breaking edge resolution).
 * Composing `<ns>__<id>` THEN slugifying — exactly the subworkflow-inlining precedent
 * (`subworkflow/expand.ts:106` `slugify(`${x.label}__${n.label}`)`) — yields a stable slug-safe id (`review`
 * ⋈ `review-a` ⇒ `review-review-a`) that both the node id and every `dependsOn` to it resolve to identically.
 * `ns===''` ⇒ the id unchanged (the stamp degenerate case).
 */
export function nsRewriteId(id: string, ns: string): string {
  return ns ? slugify(`${ns}__${id}`, 0) : id;
}

/**
 * Namespace a run-relative WRITE/READ path under `<ns>/` so owns/artifacts stay write-disjoint across lanes.
 * A bare template-relative path (`verify/x.json`, `verify/**`) ⇒ `<ns>/verify/x.json`. A `{{RUN}}`-rooted
 * path keeps its root and inserts `<ns>/` after it (`{{RUN}}/draft/d.md` ⇒ `{{RUN}}/<ns>/draft/d.md`). A
 * BARE whole-run read (`{{RUN}}` with no tail) is left as-is — namespacing a whole-run allow-list would be
 * wrong. `ns===''` ⇒ unchanged (stamp).
 */
export function nsRewritePath(p: string, ns: string): string {
  if (!ns) return p;
  const m = RUN_RE.exec(p);
  if (m) {
    // `{{RUN}}` with no tail (m[2] undefined/empty) is the whole-run read — leave it untouched.
    const tail = m[2];
    if (!tail) return p;
    return `{{RUN}}/${ns}/${tail}`;
  }
  // a bare template-relative path (owns/artifacts) — prefix `<ns>/`.
  return `${ns}/${p}`;
}

/** Namespace ONE check's `path` in lockstep with the artifact it gates (a `{artifact}`-derived literal). */
function nsRewriteCheck(c: CheckOpt, ns: string): CheckOpt {
  return c.path !== undefined ? { ...c, path: nsRewritePath(c.path, ns) } : c;
}

/**
 * Namespace an entire `NodeOpts` (the output of `laneToNodeOpts`) for insert. `inserted` = the ORIGINAL
 * (un-namespaced) ids of every lane in this fragment — a dep/reroute-target IN this set is namespaced, one
 * outside it (an existing node the seam bound to) is left verbatim. `externalDeps`/`externalReads` are the
 * exact dep ids / read paths the seam-bind added that point at the SURROUNDING DAG — those are NEVER
 * namespaced even though they are not fragment lanes. Returns a NEW opts (input unmutated). `ns===''` ⇒
 * the identity (stamp).
 */
export function nsRewriteNodeOpts(
  opts: NodeOpts,
  ns: string,
  inserted: Set<string>,
  externalDeps: Set<string> = new Set(),
  externalReads: Set<string> = new Set(),
): NodeOpts {
  if (!ns) return opts;
  const out: NodeOpts = { ...opts, id: nsRewriteId(opts.id, ns) };
  // a dep on an inserted lane → its namespaced id; a dep on an existing/seam node → verbatim.
  if (opts.deps) {
    out.deps = opts.deps.map((d) => (inserted.has(d) && !externalDeps.has(d) ? nsRewriteId(d, ns) : d));
  }
  if (opts.owns) out.owns = opts.owns.map((p) => nsRewritePath(p, ns));
  if (opts.artifacts) out.artifacts = opts.artifacts.map((p) => nsRewritePath(p, ns));
  // readScope: a whole-run `{{RUN}}` read is untouched by nsRewritePath; an internal fragment read is
  // namespaced; an EXTERNAL seam read is kept verbatim.
  if (opts.readScope) {
    out.readScope = opts.readScope.map((p) => (externalReads.has(p) ? p : nsRewritePath(p, ns)));
  }
  if (opts.inject) {
    out.inject = opts.inject.map((p) => (externalReads.has(p) ? p : nsRewritePath(p, ns)));
  }
  if (opts.reroute) {
    const node = inserted.has(opts.reroute.node) ? nsRewriteId(opts.reroute.node, ns) : opts.reroute.node;
    out.reroute = { ...opts.reroute, node };
  }
  if (opts.checks) out.checks = opts.checks.map((c) => nsRewriteCheck(c, ns));
  if (opts.checksPre) out.checksPre = opts.checksPre.map((c) => nsRewriteCheck(c, ns));
  return out;
}
