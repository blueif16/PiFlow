// (G9) expandSubworkflow — the spec-level transform that inlines a `node.subworkflow` reference as a
// sub-DAG, mirroring the fusion expansion precedent (`workflow/fusion/expand.ts`). It runs BEFORE
// `compile` (the WorkflowSpec is still the `NodeIntent` bag) and BEFORE `expandFusion`, so it only
// REPLACES the activated node X with the child template's nodes — the existing compiler then draws the
// edges from each node's `dependsOn`. NO new DAG code.
//
// For an activated node X referencing a child template C:
//   • Every child node is id-NAMESPACED under X (`X__<childLabel>`) so two sub-templates never collide
//     and X's siblings are untouched.
//   • Child ENTRY nodes (no in-child deps) INHERIT X's upstream deps → the sub-DAG runs after whatever X
//     depended on.
//   • Child TERMINAL nodes (nothing in-child depends on them) become the sub-DAG's exit: every PARENT
//     node that depended on X is rewired to depend on the terminal(s) → X's downstream edges survive.
//   • X itself is REMOVED (its work IS the child).
//
// Template nodes wire by `dependsOn` (their `io.reads` is `[]`), so the splice is a DEPENDENCY rewrite;
// data handoff uses the existing `{{RUN}}`-relative path convention (the child terminal writes the path
// the parent expects). The `subworkflow.inputs`/`outputs` path-mapping is RESERVED for a follow-up; a v1
// subworkflow node is a pure reference holder (its own contract/artifacts are not transferred to the exit).
//
// Nesting is supported to a hard depth cap; a sub-template that (transitively) references itself throws
// `SubworkflowConfigError` (loud, never a silent skip), as does an unresolvable `ref`.

import type { WorkflowSpec, NodeIntent } from '../../types.js';
import { slugify } from '../../dag.js';

/** Thrown when a subworkflow activation is unbuildable (cycle, depth-cap, unresolvable ref). Loud. */
export class SubworkflowConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubworkflowConfigError';
  }
}

/** Inputs to the transform: the injected child-template loader + the (optional) depth cap. */
export interface SubworkflowExpandOpts {
  /**
   * Resolve a `subworkflow.ref` to its child `WorkflowSpec`. INJECTED (the real wiring is
   * `loadTemplate∘resolve`, the test passes an in-memory fake) so the transform stays pure of I/O.
   */
  loadChild: (ref: string) => Promise<WorkflowSpec>;
  /** Max nesting depth (a pathological-author backstop). Default `DEFAULT_MAX_DEPTH`. */
  maxDepth?: number;
}

/** The default nesting depth cap — a backstop against a runaway/cyclic author error, far above real use. */
export const DEFAULT_MAX_DEPTH = 8;

/** De-dup a string list preserving first-seen order. */
function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * Expand ONE subworkflow-activated node X into the (recursively-flattened, namespaced) child nodes.
 * Returns the spliced-in children + the child TERMINAL ids (the rewire targets for X's dependents).
 */
async function expandNode(
  x: NodeIntent,
  opts: SubworkflowExpandOpts,
  maxDepth: number,
  stack: string[],
): Promise<{ children: NodeIntent[]; terminalIds: string[] }> {
  const ref = x.subworkflow!.ref;
  // Loud failures FIRST (cycle before depth, so a self-reference reads as a cycle, not a depth error).
  if (stack.includes(ref)) {
    throw new SubworkflowConfigError(`subworkflow cycle detected: ${[...stack, ref].join(' → ')}`);
  }
  if (stack.length + 1 > maxDepth) {
    throw new SubworkflowConfigError(
      `subworkflow nesting exceeds maxDepth=${maxDepth} at "${x.label}" → "${ref}" (${[...stack, ref].join(' → ')})`,
    );
  }
  let child: WorkflowSpec;
  try {
    child = await opts.loadChild(ref);
  } catch (e) {
    throw new SubworkflowConfigError(
      `subworkflow "${x.label}" → ref "${ref}" failed to load: ${(e as Error).message}`,
    );
  }

  // Recursively flatten the child FIRST (depth-first), so nested subworkflows resolve before we namespace.
  const flat = child.nodes.some((n) => n.subworkflow)
    ? (await expandSpecInner(child, opts, maxDepth, [...stack, ref])).nodes
    : child.nodes;

  // Map each flat child's COMPILED id → its namespaced compiled id (the form `dependsOn` must reference).
  const idMap = new Map<string, string>();
  for (const n of flat) idMap.set(slugify(n.label, 0), slugify(`${x.label}__${n.label}`, 0));

  // A child node is TERMINAL when no other flat child depends on it (by child id).
  const dependedOn = new Set<string>();
  for (const n of flat) for (const d of n.io.dependsOn ?? []) dependedOn.add(d);

  const xDeps = x.io.dependsOn ?? [];
  const children: NodeIntent[] = [];
  const terminalIds: string[] = [];
  for (const n of flat) {
    const childId = slugify(n.label, 0);
    const isEntry = !(n.io.dependsOn && n.io.dependsOn.length);
    const isTerminal = !dependedOn.has(childId);
    // Entry nodes inherit X's upstream deps; others keep their in-child deps, remapped to namespaced ids.
    const deps = isEntry
      ? [...xDeps]
      : (n.io.dependsOn ?? []).map((d) => idMap.get(d) ?? slugify(`${x.label}__${d}`, 0));
    const { subworkflow: _consumed, ...rest } = n;
    children.push({ ...rest, label: `${x.label}__${n.label}`, io: { ...n.io, dependsOn: deps } });
    if (isTerminal) terminalIds.push(idMap.get(childId)!);
  }
  return { children, terminalIds };
}

/** Rewrite a node's `dependsOn`: a dep on an expanded X → deps on X's child terminal(s). */
function rewireDeps(n: NodeIntent, remap: Map<string, string[]>): NodeIntent {
  const deps = n.io.dependsOn;
  if (!deps || !deps.length) return n;
  let changed = false;
  const out: string[] = [];
  for (const d of deps) {
    const terminals = remap.get(d);
    if (terminals) {
      out.push(...terminals);
      changed = true;
    } else out.push(d);
  }
  return changed ? { ...n, io: { ...n.io, dependsOn: dedupe(out) } } : n;
}

/** Inner recursion: expand every subworkflow node in `spec`, then rewire dependents to the terminals. */
async function expandSpecInner(
  spec: WorkflowSpec,
  opts: SubworkflowExpandOpts,
  maxDepth: number,
  stack: string[],
): Promise<WorkflowSpec> {
  const nodes: NodeIntent[] = [];
  const remap = new Map<string, string[]>(); // expanded X compiled id → child terminal compiled ids
  for (const node of spec.nodes) {
    if (!node.subworkflow) {
      nodes.push(node);
      continue;
    }
    const { children, terminalIds } = await expandNode(node, opts, maxDepth, stack);
    remap.set(slugify(node.label, 0), terminalIds);
    nodes.push(...children);
  }
  // One global rewire pass: every dep on an expanded X (parent dependents AND inherited entry deps) →
  // the child terminal(s). Cascades correctly because all expansions are done before this runs.
  return { ...spec, nodes: nodes.map((n) => rewireDeps(n, remap)) };
}

/**
 * Inline every `subworkflow`-activated node in a WorkflowSpec as a sub-DAG (G9). A spec with no
 * `subworkflow` node is returned UNCHANGED (same object). Async (loads child templates via the injected
 * `loadChild`); pure of model calls. Run BEFORE `expandFusion` and `compile`.
 */
export async function expandSubworkflow(spec: WorkflowSpec, opts: SubworkflowExpandOpts): Promise<WorkflowSpec> {
  if (!spec.nodes.some((n) => n.subworkflow)) return spec;
  return expandSpecInner(spec, opts, opts.maxDepth ?? DEFAULT_MAX_DEPTH, []);
}
