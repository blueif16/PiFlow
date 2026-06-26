// (M3 · G12) expandReroute — the spec-level transform that realizes a `node.reroute` activation (the bounded
// conditional REROUTE / self-fix QA loop, design §3-control) as forward-only acyclic CLONES at compile time.
// It MIRRORS `expandFusion` (and the shipped `expandSubworkflow`): a PURE pre-compile spec→spec transform
// that GENERATES nodes (the existing compiler infers the edges from produces ⋈ reads), namespaces cloned ids
// so downstream edges survive, collects each attempt into its OWN disjoint top-level dir (the parallel-collect
// write-disjoint discipline, runner.ts:936), throws a LOUD `RerouteConfigError`, and returns the spec
// REFERENTIALLY UNCHANGED when no node activates (the additivity early-return). NO new DAG code, and
// `checkCycles`/`stagesOf` are NEVER modified — a reroute is a compile-time UNROLL, never a runtime back-edge.
//
// For a verify node `V` with `reroute:{ onFail:T, max:k, evidence:E }`:
//   • slice `S = [T … V]` (the nodes between T and V, inclusive) is the per-attempt body.
//   • attempt 1 is the ORIGINAL S (unchanged); attempts i=2..k clone S into `reroute-{V}-r{i}/…`:
//       - the re-entry root `T__r{i}` READS the prior attempt's evidence `E` + gets a consultPreamble fix-prefix;
//       - every internal-slice read is REMAPPED to the namespaced clone outputs; external reads stay canonical.
//   • a zero-pi EXISTENCE-GATE preflight `V__r{i}__gate` sits before each attempt: it stat()s the prior
//     attempt's canonical verify artifact and, when present (the prior attempt PASSED), SHORT-CIRCUITS —
//     it finishes ok WITHOUT spawning pi, copies the passing artifact forward to this attempt's output,
//     and marks the cloned body ids `reused` so they NEVER spawn (#17; runner-side `runRerouteGate`).
//   • downstream(V) is re-pointed onto the LAST attempt's namespaced output (the gate copies a passing
//     attempt forward), so the QA loop converges whether attempt 1 or a later fix succeeded.
//
// The chaining is forward-only — V → V__r2__gate → T__r2 → V__r2 → V__r3__gate → … → downstream(V) — every
// edge drawn by `inferEdges` from the namespaced produces ⋈ reads. No back-edge, no cycle, bounded by `k`.

import type { WorkflowSpec, NodeIntent, RerouteSpec, RerouteGate, NodeIO } from '../../types.js';
import { slugify } from '../../dag.js';

/** Thrown when a reroute activation is unbuildable (non-ancestor target / max<1). Loud, never a silent skip. */
export class RerouteConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RerouteConfigError';
  }
}

/** Map an authored onFail ref (label OR slug-id) to the matching node's label. */
function resolveTargetLabel(nodes: NodeIntent[], onFail: string): NodeIntent | undefined {
  return nodes.find((n) => n.label === onFail) ?? nodes.find((n, i) => slugify(n.label, i) === onFail);
}

/** Producer map (produced file → node label) over the intent layer — the same join `inferEdges` does post-compile. */
function producerMap(nodes: NodeIntent[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of nodes) for (const f of n.io.produces ?? []) m.set(f, n.label);
  return m;
}

/** Forward adjacency (producer label → consumer labels) over the intent layer (reads ⋈ produces + dependsOn). */
function adjacency(nodes: NodeIntent[]): Map<string, Set<string>> {
  const prod = producerMap(nodes);
  const byLabel = new Map(nodes.map((n) => [n.label, n]));
  const adj = new Map<string, Set<string>>(nodes.map((n) => [n.label, new Set<string>()]));
  for (const n of nodes) {
    for (const f of n.io.reads ?? []) {
      const p = prod.get(f);
      if (p && p !== n.label) adj.get(p)!.add(n.label);
    }
    for (const dep of n.io.dependsOn ?? []) {
      const depNode = byLabel.get(dep) ?? resolveTargetLabel(nodes, dep);
      if (depNode && depNode.label !== n.label) adj.get(depNode.label)!.add(n.label);
    }
  }
  return adj;
}

/** Reachable-set (forward closure) from `start` over the adjacency. */
function reachable(adj: Map<string, Set<string>>, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) ?? []) if (!seen.has(nxt)) stack.push(nxt);
  }
  return seen;
}

/** The slice `[T … V]`: nodes reachable-from-T that ALSO reach V (descendants-of-T ∩ ancestors-of-V, inclusive). */
function sliceBetween(nodes: NodeIntent[], fromLabel: string, toLabel: string): NodeIntent[] {
  const fwd = adjacency(nodes);
  const rev = new Map<string, Set<string>>(nodes.map((n) => [n.label, new Set<string>()]));
  for (const [from, tos] of fwd) for (const to of tos) rev.get(to)!.add(from);
  const downFromT = reachable(fwd, fromLabel); // T and everything after it
  const upToV = reachable(rev, toLabel); // V and everything before it
  const inSlice = new Set([...downFromT].filter((l) => upToV.has(l)));
  // Preserve the spec's node ORDER within the slice.
  return nodes.filter((n) => inSlice.has(n.label));
}

/**
 * Deep-clone a NodeIO with reads/produces/artifacts/sandbox-write rewritten through `remap` (the file
 * namespacing) AND `dependsOn` rewritten through `depRemap` (in-slice node labels → their same-attempt
 * clones). A deps-coordinated slice (game-omni: dependsOn set, empty reads) chains ONLY if its label deps
 * are remapped too — copying them verbatim would leave a clone pointing at attempt 1.
 */
function remapIo(io: NodeIO, remap: (f: string) => string, extraReads: string[], depRemap: (l: string) => string): NodeIO {
  const reads = [...new Set([...(io.reads ?? []).map(remap), ...extraReads])];
  return {
    reads,
    produces: (io.produces ?? []).map(remap),
    ...(io.externalInputs ? { externalInputs: [...io.externalInputs] } : {}),
    ...(io.dependsOn ? { dependsOn: io.dependsOn.map(depRemap) } : {}),
    artifacts: (io.artifacts ?? []).map((a) => ({ ...a, path: remap(a.path) })),
    ...(io.checks ? { checks: io.checks } : {}),
    ...(io.policy ? { policy: io.policy } : {}),
    ...(io.returnMode ? { returnMode: io.returnMode } : {}),
    ...(io.returnSchema ? { returnSchema: io.returnSchema } : {}),
    ...(io.fillSentinel ? { fillSentinel: io.fillSentinel } : {}),
  };
}

/** The consultPreamble fix-prefix prepended to the re-entry root clone (mirrors run.mjs consultPreamble). */
function consultPreamble(evidence: string[]): string {
  const ev = evidence.length ? ` Review the prior attempt's failure evidence at: ${evidence.join(', ')}.` : '';
  return `[REROUTE — SELF-FIX] The prior attempt FAILED its verify checks.${ev} Fix the issues, then redo the task below.\n\n`;
}

/** Expand ONE reroute-activated verify node V into [gate, ...clone-slice] × (max-1) attempts. */
function expandNode(spec: WorkflowSpec, v: NodeIntent): { generated: NodeIntent[]; downstreamRemap: Map<string, string>; downstreamDepRemap: Map<string, string> } {
  const r = v.reroute as RerouteSpec;
  if (r.max < 1) throw new RerouteConfigError(`reroute on "${v.label}" requires max >= 1 (got ${r.max})`);

  const target = resolveTargetLabel(spec.nodes, r.onFail);
  if (!target) {
    throw new RerouteConfigError(`reroute on "${v.label}" names an unknown onFail node "${r.onFail}"`);
  }
  // onFail MUST be a STRICT ancestor of V (V is reachable from T, and T !== V).
  const reachFromT = reachable(adjacency(spec.nodes), target.label);
  if (target.label === v.label || !reachFromT.has(v.label)) {
    throw new RerouteConfigError(
      `reroute on "${v.label}" → onFail "${r.onFail}" must be an ANCESTOR of "${v.label}" (it is not on a path into it)`,
    );
  }

  const slice = sliceBetween(spec.nodes, target.label, v.label);
  const sliceLabels = new Set(slice.map((n) => n.label)); // in-slice labels whose deps remap to the clone
  const ns = slugify(v.label, 0); // the attempt namespace key (V's slug)
  const dir = (i: number): string => `reroute-${ns}-r${i}`;
  const evidence = r.evidence ?? [];
  const generated: NodeIntent[] = [];

  // `prevProduces` maps each slice label → the produces of its PRIOR attempt (attempt 1 = the canonical paths).
  let prevProduces = new Map<string, string[]>(slice.map((n) => [n.label, [...(n.io.produces ?? [])]]));
  // The canonical V output (attempt 1) is what each gate stat()s for the short-circuit.
  const vCanonical = [...(v.io.produces ?? [])];

  for (let i = 2; i <= r.max; i++) {
    const attemptDir = dir(i);
    // remap a slice-internal file into THIS attempt's namespaced dir; an external file stays canonical.
    const sliceProducers = new Set(slice.flatMap((n) => n.io.produces ?? []));
    const remap = (f: string): string => (sliceProducers.has(f) ? `${attemptDir}/${f}` : f);

    // The cloned body, in slice order.
    const cloneIds: string[] = [];
    const cloneNodes: NodeIntent[] = [];
    for (const n of slice) {
      const isRoot = n.label === target.label;
      const extraReads = isRoot ? [...evidence, `${attemptDir}/gate.ok`] : [];
      const cloned: NodeIntent = {
        label: `${n.label}__r${i}`,
        prompt: isRoot ? consultPreamble(evidence) + n.prompt : n.prompt,
        ...(n.skill ? { skill: n.skill } : {}),
        tools: n.tools,
        ...(n.phase ? { phase: n.phase } : {}),
        ...(n.agentType ? { agentType: n.agentType } : {}),
        ...(n.model ? { model: n.model } : {}),
        ...(n.provider ? { provider: n.provider } : {}),
        ...(n.tier ? { tier: n.tier } : {}),
        // in-slice label deps → the same-attempt clone's SLUG id (what `compile`/`inferEdges` resolve on).
        io: remapIo(n.io, remap, extraReads, (l) => (sliceLabels.has(l) ? slugify(`${l}__r${i}`, 0) : l)),
        sandbox: { ...(n.sandbox ?? {}), write: (n.io.produces ?? []).map(remap) },
      };
      cloneIds.push(slugify(cloned.label, 0));
      cloneNodes.push(cloned);
    }

    // The zero-pi EXISTENCE-GATE preflight for THIS attempt: it reads the prior attempt's canonical V
    // output; when present (the prior attempt PASSED) the runner short-circuits — copies it forward to
    // this attempt's V output AND marks the cloned body `reused` (never spawns). It produces `gate.ok`
    // (the forward edge the re-entry root reads, so the gate orders BEFORE the clones).
    const priorV = prevProduces.get(v.label) ?? vCanonical;
    const thisV = (v.io.produces ?? []).map(remap);
    const gate: NodeIntent & { rerouteGate: RerouteGate } = {
      label: `${v.label}__r${i}__gate`,
      prompt: '', // never spawns pi
      tools: {},
      io: {
        reads: [...priorV],
        produces: [`${attemptDir}/gate.ok`],
        externalInputs: [...priorV], // a missing prior output is the gate's own concern, not a missing-producer error
        artifacts: [{ path: `${attemptDir}/gate.ok` }],
      },
      rerouteGate: { artifact: priorV[0] ?? '', copyTo: thisV, skip: cloneIds },
    };
    generated.push(gate, ...cloneNodes);

    // Advance the "prior attempt" pointer for the next iteration.
    prevProduces = new Map(slice.map((n) => [n.label, (n.io.produces ?? []).map(remap)]));
  }

  // Re-point downstream(V) reads from V's CANONICAL produces onto the LAST attempt's namespaced V output,
  // so the QA loop converges on whichever attempt last produced (the gate copies a passing one forward).
  const lastV = prevProduces.get(v.label) ?? vCanonical;
  const downstreamRemap = new Map<string, string>();
  vCanonical.forEach((canon, idx) => {
    const last = lastV[idx];
    if (last && last !== canon) downstreamRemap.set(canon, last);
  });
  // Deps-coordinated convergence: a downstream that depends on V BY LABEL is re-pointed onto the LAST
  // attempt's V clone (`V__r{max}`). Only when clones exist (max >= 2); else the file remap above suffices.
  const downstreamDepRemap = new Map<string, string>();
  if (r.max >= 2) downstreamDepRemap.set(slugify(v.label, 0), slugify(`${v.label}__r${r.max}`, 0));
  return { generated, downstreamRemap, downstreamDepRemap };
}

/**
 * Expand every reroute-activated node in a WorkflowSpec into a bounded chain of forward-only acyclic clones
 * (design §3-control). A spec with no `reroute` node is returned UNCHANGED (same object). Pure: no I/O, no
 * model calls. Runs BEFORE `compile`, immediately AFTER `expandFusion`.
 */
export function expandReroute(spec: WorkflowSpec): WorkflowSpec {
  if (!spec.nodes.some((n) => n.reroute)) return spec;

  const generated: NodeIntent[] = [];
  const downstreamRemap = new Map<string, string>(); // canonical V output → last-attempt namespaced output (files)
  const downstreamDepRemap = new Map<string, string>(); // rerouted V label → last-attempt clone label (deps)
  const skipLabels = new Set<string>(); // the canonical V nodes whose `reroute` is consumed (drop the field)

  for (const node of spec.nodes) {
    if (!node.reroute) continue;
    const out = expandNode(spec, node);
    generated.push(...out.generated);
    for (const [k, v] of out.downstreamRemap) downstreamRemap.set(k, v);
    for (const [k, v] of out.downstreamDepRemap) downstreamDepRemap.set(k, v);
    skipLabels.add(node.label);
  }

  // Build the new node list: every original node (with `reroute` stripped from the activated ones and
  // downstream reads re-pointed onto the last attempt's output), then the generated gate+clone chain.
  const remapRead = (f: string): string => downstreamRemap.get(f) ?? f;
  const remapDep = (l: string): string => downstreamDepRemap.get(l) ?? l;
  const nodes: NodeIntent[] = spec.nodes.map((n) => {
    // Re-point a downstream node's reads (NOT a node that itself produces the canonical file).
    const producesCanonical = (n.io.produces ?? []).some((p) => downstreamRemap.has(p));
    let next = n;
    if (!producesCanonical && (n.io.reads ?? []).some((f) => downstreamRemap.has(f))) {
      next = { ...n, io: { ...n.io, reads: (n.io.reads ?? []).map(remapRead) } };
    }
    // Deps-coordinated convergence: re-point a downstream `dependsOn` on a rerouted V onto its last clone.
    if ((next.io.dependsOn ?? []).some((d) => downstreamDepRemap.has(d))) {
      next = { ...next, io: { ...next.io, dependsOn: (next.io.dependsOn ?? []).map(remapDep) } };
    }
    if (skipLabels.has(n.label)) {
      const { reroute: _drop, ...rest } = next;
      next = rest as NodeIntent;
    }
    return next;
  });

  return { ...spec, nodes: [...nodes, ...generated] };
}
