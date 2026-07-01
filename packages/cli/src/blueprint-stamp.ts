// `piflowctl blueprint stamp <id> --plan <plan.json> --into <new-dir>` — the mechanical LOGIC GATE that
// composes a blueprint's topology into a template so the init agent never hand-wires it.
//
// stamp ⊆ insert (docs/design/blueprint-compose-verb.md, "The design relationship"): stamp is the DEGENERATE
// case of insert — empty target · empty namespace · no downstream rebind, plus it CREATES the dir. So the
// per-lane (wiring rule ⋈ lane fields → buildNode opts → scaffoldAddNode) mapping is FACTORED into the shared
// `spliceBlueprint` core; `stamp` = `scaffoldNew(dir)` then `splice(dir, plan, rule, { ns:'' })`, and
// `insert` (blueprint-insert.ts) = `splice(existingDir, plan, rule, { ns, seamBind })` + its 3 deltas.
// COMPOSITION, not subclassing (both call splice; stamp never calls insert).
//
// It is PURE composition over `buildNode`/`scaffoldNew`/`scaffoldAddNode` (scaffold.ts) — NO new emit logic,
// NO @piflow/core change. It resolves the blueprint's CODE-SIDE wiring rule (blueprint-wiring.ts), then for
// each lane maps (wiring role skeleton ⋈ lane fields) → the exact `buildNode` opts, batching the same
// `add-node` calls the agent would have typed by hand. It adds ZERO DAG logic — it never draws an edge; the
// authored `deps`/`reads` let `extract`/`inferEdges` derive the topology from `reads ⋈ produces`. It ENDS by
// running the `extract` oracle and fails non-zero if the derived DAG is not green (necessary, not sufficient
// — the deep-equal round-trip test is the real gate).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { scaffoldNew, scaffoldAddNode, type NodeOpts, type CheckOpt } from './scaffold.js';
import { extractTemplate } from './extract.js';
import { parseLanePlan, LanePlanError, type Lane, type LanePlan } from './blueprint-plan.js';
import { wiringRuleFor, facetOf, WIRING_RULES, type WiringRule, type RoleSkeleton } from './blueprint-wiring.js';
import { nsRewriteNodeOpts } from './blueprint-namespace.js';

/** Sinks so the verb is testable in-process (no stdout capture / no subprocess). Mirrors BlueprintDeps. */
export interface StampDeps {
  out?: (s: string) => void;
  err?: (s: string) => void;
}

/**
 * Fill a path template's holes: `{facet}` ⇒ the lane's `-`-tail facet (spec-fanout's `frag/impl/**`) and
 * `{id}` ⇒ the lane's FULL id (map-reduce's `verify/review-a.json`). PURE.
 */
function fillTpl(tpl: string, id: string, facet: string): string {
  return tpl.replaceAll('{facet}', facet).replaceAll('{id}', id);
}

/**
 * Map ONE lane (⋈ its role skeleton) → the exact `buildNode` opts. The skeleton fixes the mechanical fields
 * (owns/artifacts/reads/deps/returnMode/reroute/on-fail); the lane fills the intelligent holes (id, preset,
 * extra/deny tools, tier, skill). `roleIds` resolves a dep role-ref → the concrete lane id(s). PURE.
 */
export function laneToNodeOpts(
  lane: Lane,
  skeleton: RoleSkeleton,
  roleIds: (ref: { role: string; all?: boolean }) => string[],
  K: number,
): NodeOpts {
  const facet = facetOf(lane.id);
  const fill = (s: string): string => fillTpl(s, lane.id, facet);
  const deps = skeleton.deps.flatMap(roleIds);
  const artifacts = skeleton.artifacts.map(fill);
  const opts: NodeOpts = {
    id: lane.id,
    ...(skeleton.phase ? { phase: skeleton.phase } : {}),
    deps,
    owns: skeleton.owns.map(fill),
    artifacts,
    readScope: skeleton.reads.map(fill),
    // Every producing/gating node in these blueprints is required to complete → policy.fail: block (default,
    // but stated so a skeleton with a different on-fail flows through unchanged).
    onFail: skeleton.onFail ?? 'block',
  };
  if (skeleton.onWarn) opts.onWarn = skeleton.onWarn;
  if (skeleton.returnMode) opts.returnMode = skeleton.returnMode;
  if (skeleton.reroute) {
    const [target] = roleIds({ role: skeleton.reroute.toRole });
    opts.reroute = { node: target, max: K };
  }
  // The intelligent holes. `agentType` folds the preset's tools+skill+label via buildNode's mergePreset;
  // extraTools/denyTools union/deny on top; an explicit skill/tier wins.
  if (typeof lane.agentType === 'string') opts.agentType = lane.agentType;
  if (lane.extraTools?.length) opts.tools = lane.extraTools;
  // DENY = the shape-inherent deny (skeleton, e.g. `bash` on every fusion/map-reduce lane) ∪ the lane's own.
  // For a preset lane buildNode routes it into mergePreset's deny; for a no-preset lane it becomes tools.deny.
  const deny = [...(skeleton.deny ?? []), ...(lane.denyTools ?? [])].filter((d, i, a) => a.indexOf(d) === i);
  if (deny.length) opts.deny = deny;
  if (lane.tier) opts.tier = lane.tier;
  if (lane.skill) opts.skill = lane.skill;
  if (lane.inject?.length) opts.inject = lane.inject;
  // FUSION (moa panel / best-of-n) — a per-lane hole; buildNode carries it verbatim + validates the mode enum.
  if (lane.fusion) opts.fusion = lane.fusion as NodeOpts['fusion'];
  // POST-CHECKS = the shape-fixed checks (skeleton, `{artifact}` → this lane's first artifact) UNION any the
  // lane adds. A skeleton check with no lane checks reproduces the fusion `non-empty` / map-reduce json-gates.
  const skeletonChecks: CheckOpt[] = (skeleton.checks ?? []).map((c) => ({
    kind: c.kind,
    ...(c.path !== undefined ? { path: c.path === '{artifact}' ? artifacts[0] : fill(c.path) } : {}),
    ...(c.severity !== undefined ? { severity: c.severity } : {}),
    ...(c.param !== undefined ? { param: c.param } : {}),
  }));
  const laneChecks = (lane.checks?.post ?? []) as CheckOpt[];
  const checks = [...skeletonChecks, ...laneChecks];
  if (checks.length) opts.checks = checks;
  return opts;
}

/**
 * Validate the lane-plan AGAINST the wiring rule: every lane's role must be a known role; every non-parallel
 * role must be filled by EXACTLY one lane; the parallel role (if any) by one or more; a reroute target role
 * must resolve to a lane. Throws `LanePlanError` on any mismatch (the caller HALTS non-zero). PURE.
 */
export function validatePlanAgainstRule(plan: LanePlan, rule: WiringRule): void {
  const byRole = new Map<string, Lane[]>();
  for (const lane of plan.lanes) {
    if (!(lane.role in rule.roles)) {
      throw new LanePlanError(
        `lane "${lane.id}" has role "${lane.role}" — not a role of blueprint "${plan.blueprint}" ` +
          `(roles: ${Object.keys(rule.roles).join(', ')})`,
      );
    }
    (byRole.get(lane.role) ?? byRole.set(lane.role, []).get(lane.role)!).push(lane);
  }
  for (const roleName of Object.keys(rule.roles)) {
    const filled = byRole.get(roleName) ?? [];
    if (roleName === rule.parallelRole) {
      if (filled.length === 0) throw new LanePlanError(`blueprint "${plan.blueprint}": no lane fills the parallel role "${roleName}"`);
    } else if (filled.length !== 1) {
      throw new LanePlanError(
        `blueprint "${plan.blueprint}": role "${roleName}" must be filled by exactly one lane (got ${filled.length})`,
      );
    }
  }
}

/**
 * A per-lane seam BIND the caller (insert) resolves BEFORE splicing: extra deps + extra injects to append to
 * a fragment-ROOT lane (the input-seam producer, an EXISTING surrounding node) so the fragment reads/orders
 * after it. `externalDeps`/`externalReads` are the exact ids/paths so the namespacer leaves them verbatim.
 */
export interface SeamBind {
  /** original (un-namespaced) lane id → the surrounding-node dep ids to APPEND to that lane's deps. */
  depsByLane: Map<string, string[]>;
  /** original (un-namespaced) lane id → the surrounding produce paths to APPEND to that lane's inject. */
  injectByLane: Map<string, string[]>;
  /** every dep id above (the surrounding nodes) — NEVER namespaced. */
  externalDeps: Set<string>;
  /** every inject path above (the surrounding produces) — NEVER namespaced. */
  externalReads: Set<string>;
}

/** Options controlling a splice: the namespace + the resolved seam bind. Both default to the STAMP case. */
export interface SpliceOpts {
  /** id/owns/path namespace prefix; `''` = stamp (every rewrite is the identity). */
  ns?: string;
  /** the resolved input-seam bind (insert); omitted = stamp (no surrounding DAG to bind to). */
  seam?: SeamBind;
}

/**
 * The SHARED core both stamp and insert call. Maps every lane (wiring role ⋈ lane → buildNode opts), applies
 * the seam bind (insert) + the `--ns` namespacing, `scaffoldAddNode`s each, then runs the `extract` oracle.
 * It does NOT create the dir (stamp `scaffoldNew`s first) and does NOT do collision/consumer mutation (insert
 * does those around it). Returns the exit code + the extract preview. `extract` red ⇒ non-zero.
 */
export async function spliceBlueprint(
  into: string,
  plan: LanePlan,
  rule: WiringRule,
  opts: SpliceOpts,
  deps: StampDeps = {},
): Promise<{ code: number; preview?: string }> {
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));
  const ns = opts.ns ?? '';
  const seam = opts.seam;

  // Resolve role → lane id(s) (in plan order) so a dep/reroute role-ref becomes a concrete id.
  const lanesByRole = new Map<string, Lane[]>();
  for (const lane of plan.lanes) (lanesByRole.get(lane.role) ?? lanesByRole.set(lane.role, []).get(lane.role)!).push(lane);
  const roleIds = (ref: { role: string; all?: boolean }): string[] => {
    const filled = lanesByRole.get(ref.role) ?? [];
    return ref.all ? filled.map((l) => l.id) : filled.length ? [filled[0].id] : [];
  };
  const K = typeof plan.params?.K === 'number' ? plan.params.K : 1;
  const insertedIds = new Set(plan.lanes.map((l) => l.id));
  const externalDeps = seam?.externalDeps ?? new Set<string>();
  const externalReads = seam?.externalReads ?? new Set<string>();

  // Map + (seam-bind) + namespace, then scaffold each node. The agent still Writes each prompt.md.
  const stampedIds: string[] = [];
  for (const lane of plan.lanes) {
    let nodeOpts = laneToNodeOpts(lane, rule.roles[lane.role], roleIds, K);
    // SEAM BIND (insert delta 2): append the surrounding-node deps/injects to a fragment-root lane so the
    // fragment reads the pre-existing produce + is ordered after it. Applied BEFORE namespacing so the
    // surrounding ids/paths flow through as `externalDeps`/`externalReads` (left verbatim by the namespacer).
    if (seam) {
      const extraDeps = seam.depsByLane.get(lane.id);
      const extraInject = seam.injectByLane.get(lane.id);
      if (extraDeps?.length) nodeOpts = { ...nodeOpts, deps: [...(nodeOpts.deps ?? []), ...extraDeps] };
      if (extraInject?.length) nodeOpts = { ...nodeOpts, inject: [...(nodeOpts.inject ?? []), ...extraInject] };
    }
    // NAMESPACE (insert delta 1): prefix ids/owns/artifacts/internal-reads/inserted-deps/reroute-target by
    // `--ns`. `ns===''` (stamp) ⇒ the identity — the round-trip goldens are byte-for-byte unaffected.
    nodeOpts = nsRewriteNodeOpts(nodeOpts, ns, insertedIds, externalDeps, externalReads);
    await scaffoldAddNode(into, nodeOpts);
    stampedIds.push(nodeOpts.id);
  }

  // The `extract` oracle — the model-free compile gate (dangling reads, non-disjoint owns, cycles). Green is
  // NECESSARY (a mis-wired DAG fails here) but not sufficient (the deep-equal round-trip is the real gate).
  // checkRefs demands each node's prompt.md exist; the agent Writes it AFTER the stamp, so seed a placeholder
  // per NEW node so the oracle can run in the same pass without clobbering a real prose body (create-if-absent).
  try {
    for (const id of stampedIds) {
      const p = path.join(into, 'nodes', id, 'prompt.md');
      try {
        await fs.access(p);
      } catch {
        await fs.writeFile(p, `<!-- task prompt for ${id} — author this -->\n`);
      }
    }
    const preview = await extractTemplate(into);
    return { code: 0, preview };
  } catch (e) {
    err(`  the spliced template did not compile (extract failed):\n  ${(e as Error).message}\n`);
    return { code: 1 };
  }
}

/**
 * Stamp a whole blueprint into a FRESH template dir. `scaffoldNew(into)` then `spliceBlueprint(…, {ns:''})`
 * — the DEGENERATE insert (fresh dir · empty ns · no seam). Returns the process exit code (0 = ok).
 * Unknown id / no code-side rule ⇒ non-zero, "not stampable — compose by hand via blueprint show <id>".
 */
export async function runBlueprintStamp(
  id: string | undefined,
  planPath: string | undefined,
  into: string | undefined,
  deps: StampDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));

  if (!id) {
    err('piflowctl blueprint stamp: a blueprint id is required.\n  usage: piflowctl blueprint stamp <id> --plan <plan.json> --into <dir>\n');
    return 1;
  }
  if (!planPath) {
    err('piflowctl blueprint stamp: --plan <lane-plan.json> is required.\n');
    return 1;
  }
  if (!into) {
    err('piflowctl blueprint stamp: --into <new-dir> is required.\n');
    return 1;
  }

  // Resolve the CODE-SIDE wiring rule. A discoverable-but-un-ruled blueprint is NOT stampable — compose by
  // hand from the recipe (never invent a wiring).
  const rule = wiringRuleFor(id);
  if (!rule) {
    err(
      `piflowctl blueprint stamp: "${id}" is not stampable — compose by hand via  piflowctl blueprint show ${id}\n` +
        `  (stampable: ${Object.keys(WIRING_RULES).join(', ')})\n`,
    );
    return 1;
  }

  // Load + validate the lane-plan. A malformed plan or a plan that does not match the rule HALTS non-zero —
  // never a half-stamped template.
  let plan: LanePlan;
  try {
    plan = parseLanePlan(await fs.readFile(planPath, 'utf8'));
  } catch (e) {
    err(`piflowctl blueprint stamp: ${(e as Error).message}\n`);
    return 1;
  }
  if (plan.blueprint !== id) {
    err(`piflowctl blueprint stamp: --plan is for blueprint "${plan.blueprint}" but you asked to stamp "${id}".\n`);
    return 1;
  }
  try {
    validatePlanAgainstRule(plan, rule);
  } catch (e) {
    err(`piflowctl blueprint stamp: ${(e as Error).message}\n`);
    return 1;
  }

  // Emit meta.json + the nodes/ dir, then splice the fragment (ns='' — the stamp case). The agent still
  // Writes each prompt.md.
  await scaffoldNew(into, {
    id: plan.meta?.id,
    name: plan.meta?.name,
    description: plan.meta?.description,
    phases: plan.meta?.phases,
  });
  const { code, preview } = await spliceBlueprint(into, plan, rule, { ns: '' }, { err });
  if (code !== 0) {
    err(`piflowctl blueprint stamp: ${plan.blueprint} did not compile — see above.\n`);
    return code;
  }
  out(`stamped ${plan.lanes.length} nodes into ${into}\n${preview}\n`);
  out(`next: Write each nodes/<id>/prompt.md (the task prose — the verb seeds only a placeholder).\n`);
  return 0;
}
