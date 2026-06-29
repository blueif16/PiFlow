// (expert-representations · refactor) graph-rewrite — the shared, BEHAVIOR-PRESERVING graph-rewrite service
// the four LOAD-TIME DAG-expansion modules each re-implemented by hand.
//
// THE PATTERN: piflow extends the DAG at LOAD time via pure `WorkflowSpec → WorkflowSpec` transforms
// (`expandReroute`, `materializeJudgeNodes`, `expandFusion`, `expandSubworkflow`), each of which had to
// insert a generated node, push the producer's downstream consumers AFTER it, attach a `rerouteTo` retry
// loop, or rewrite a `dependsOn` list — all with NO shared helper, so the insert/rewire/loop logic was
// duplicated. This module factors out the GENUINELY-common primitives so a future materializer extends the
// DAG in a few composable lines instead of a bespoke module.
//
// PURE: every function returns a new spec/node (or the same reference when nothing changed — the additivity
// contract the callers rely on for their "spec unchanged ⇒ same object" early-returns). No I/O, no model
// calls. Edges are NEVER drawn here — a generated node's OWN `io.reads ⋈ produces` / `dependsOn` is what
// places it (the existing `inferEdges` join); these primitives only validate, append, and rewire deps.
//
// INTENDED USE — L2's future `materializeFixNodes` (insert a "fix" node after a failing producer + wire a
// retry loop) composes these primitives instead of forking a new expansion module. Sketch (DOC ONLY — not
// built here):
//
//   function materializeFixNodes(spec) {
//     for (const producer of spec.nodes.filter(n => n.fixGate)) {
//       const fix = buildFixNode(producer);                       // a NodeIntent reading the producer's output
//       spec = insertNodeAfter(spec, producer.label, fix);        // splice the fix node in after the producer
//       spec = rewireDownstream(spec, producer.label, fix.label); // consumers now gate on the fix node
//       spec = mapNode(spec, producer.label, n =>                 // attach the producer-side retry loop
//                attachRerouteLoop(n, producer.label, producer.fixGate.max));
//     }
//     return spec;
//   }
//
// CURRENT CALLERS: `materializeJudgeNodes` (insertNodeAfter + rewireDownstream + attachRerouteLoop) and
// `expandReroute` (remapDeps). `expandFusion`/`expandSubworkflow` stay bespoke — their rewrites are
// genuinely different graph operations (fusion RETARGETS the activated node keeping its id; subworkflow
// REPLACES a node with a sub-DAG and rewires deps to MULTIPLE terminals), so forcing them through these
// single-node primitives would contort them.

import type { WorkflowSpec, NodeIntent, OpSpec } from '../types.js';
import { slugify } from '../dag.js';

/** Thrown when a rewrite targets a node id that is not in the spec (a loud miswire, never a silent no-op). */
export class GraphRewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphRewriteError';
  }
}

/**
 * Append a GENERATED node to the spec, positioned AFTER `producerId`. The inserted node's OWN
 * `io.reads`/`dependsOn` is what orders it after the producer (the existing `inferEdges` data-flow /
 * dependsOn join) — this primitive does NOT mutate the node's edges; it only verifies the producer exists
 * and appends `node` to the (immutable) node list. The new node lands LAST (the generated tail every
 * expansion uses), keeping the original authored nodes' order stable.
 *
 * @param spec       the spec to extend (returned UNMUTATED).
 * @param producerId the label of the node the inserted node comes after — MUST exist, else `GraphRewriteError`.
 * @param node       the fully-formed generated NodeIntent (its io already wires it after the producer).
 * @returns a NEW spec with `node` appended.
 */
export function insertNodeAfter(spec: WorkflowSpec, producerId: string, node: NodeIntent): WorkflowSpec {
  if (!spec.nodes.some((n) => n.label === producerId)) {
    throw new GraphRewriteError(`insertNodeAfter: no producer node "${producerId}" in the spec`);
  }
  return { ...spec, nodes: [...spec.nodes, node] };
}

/** Options for `rewireDownstream`. */
export interface RewireDownstreamOpts {
  /** Consumer labels to LEAVE untouched (e.g. an already-rewired node, or a sibling that must not gate). */
  skip?: string[];
}

/**
 * Push every downstream CONSUMER of `producerId` to run AFTER `gateLabel` by adding a `dependsOn` on the
 * gate's SLUG id. A consumer connects to the producer EITHER by reading one of its produced artifacts OR by
 * an explicit `io.dependsOn` on the producer's slug id — BOTH are rewired. The producer itself, the gate
 * node, and any `skip` id are NEVER rewired (a producer/gate must never depend on its own gate). A node that
 * is not a consumer is returned by REFERENCE (untouched), so an unchanged node stays `===` to its original —
 * the additivity contract the callers' equality checks rely on.
 *
 * `dependsOn` resolves against SLUG ids (`dag.ts:slugify`), so the added dep is `slugify(gateLabel, 0)` (a
 * `w0__judge` label collapses to the `w0-judge` id).
 *
 * @param spec       the spec to rewire (returned UNMUTATED).
 * @param producerId the producer whose consumers gate on the inserted node.
 * @param gateLabel  the inserted node's label; consumers gain a dep on its slug id.
 * @returns a NEW spec with the consumers re-pointed.
 */
export function rewireDownstream(
  spec: WorkflowSpec,
  producerId: string,
  gateLabel: string,
  opts: RewireDownstreamOpts = {},
): WorkflowSpec {
  const producer = spec.nodes.find((n) => n.label === producerId);
  if (!producer) {
    throw new GraphRewriteError(`rewireDownstream: no producer node "${producerId}" in the spec`);
  }
  const produced = new Set(producer.io.produces ?? []);
  const producerDep = slugify(producerId, 0);
  const gateDep = slugify(gateLabel, 0);
  const skip = new Set([producerId, gateLabel, ...(opts.skip ?? [])]);

  const nodes = spec.nodes.map((n) => {
    if (skip.has(n.label)) return n; // never the producer, the gate, or a skipped consumer
    const readsProduced = (n.io.reads ?? []).some((r) => produced.has(r));
    const dependsOnProducer = (n.io.dependsOn ?? []).includes(producerDep);
    if (!readsProduced && !dependsOnProducer) return n; // not a consumer ⇒ same reference
    const existing = n.io.dependsOn ?? [];
    if (existing.includes(gateDep)) return n; // already gated ⇒ same reference (idempotent)
    return { ...n, io: { ...n.io, dependsOn: [...existing, gateDep] } };
  });
  return { ...spec, nodes };
}

/**
 * Attach the producer-side `rerouteTo` retry loop op onto a node's `op[]`: on a downstream gate FAILURE,
 * re-route back to `targetId` for up to `max` total attempts. APPENDS — any existing ops are preserved
 * (first), so a node that already carries gates keeps them. Pure: returns a NEW node. The op shape is the
 * canonical one `lowerGates` emits for a judge gate (`{when:'on-failure', action:{kind:'rerouteTo', …}}`),
 * the existing dispatched M3 action — so the runner needs ZERO new code.
 *
 * @param node      the producer node to attach the loop onto.
 * @param targetId  the node label to re-route to on failure (typically the producer itself).
 * @param max       total attempts (the retry budget).
 * @param evidence  optional prior-attempt artifacts the re-entry reads as failure evidence.
 * @returns a NEW node with the reroute op appended.
 */
export function attachRerouteLoop(node: NodeIntent, targetId: string, max: number, evidence?: string[]): NodeIntent {
  const op: OpSpec = {
    when: 'on-failure',
    action: {
      kind: 'rerouteTo',
      node: targetId,
      max,
      ...(evidence && evidence.length ? { evidence: [...evidence] } : {}),
    },
  };
  return { ...node, op: [...(node.op ?? []), op] };
}

/**
 * Rewrite a `dependsOn` list through a (label → label) `rename` fn, slug-aware AT THE CALL SITE (the caller's
 * `rename` returns the resolvable slug id `compile`/`inferEdges` look up). A POSITIONAL map (the `.map`
 * semantics the callers had — NO de-dup, so a caller's existing edge multiplicity is preserved byte-for-byte).
 * Returns the SAME array reference when NOTHING changed (the additivity contract — a caller can cheaply
 * detect "no rewrite" by identity). An empty/undefined list ⇒ `[]`.
 *
 * Shared by `expandReroute` (in-slice label deps → the same-attempt clone's slug; downstream V → V__r{max})
 * and available to `expandSubworkflow` (child dep → its namespaced id). The rename CLOSURE — not a Map — is
 * the common denominator: each caller closes over its own slice-set / id-map / computed fallback.
 *
 * @param deps   the `io.dependsOn` list (may be undefined).
 * @param rename label → (possibly new) label/slug; return the input unchanged to leave a dep be.
 * @returns the rewritten list, or `deps` itself when no element changed.
 */
export function remapDeps(deps: string[] | undefined, rename: (label: string) => string): string[] {
  if (!deps || !deps.length) return deps ?? [];
  let changed = false;
  const out: string[] = [];
  for (const d of deps) {
    const r = rename(d);
    if (r !== d) changed = true;
    out.push(r);
  }
  return changed ? out : deps; // SAME reference when nothing rewritten; else the positional map (no de-dup)
}
