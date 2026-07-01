// The LANE-PLAN — the agent-authored intelligent holes a blueprint's wiring rule fills. A blueprint's `.md`
// fixes the topology + wiring rule (blueprint-wiring.ts); the lane-plan fills the holes: which preset each
// lane binds, how many producer lanes, the ids, the params (K reroute budget, etc.).
//
// This loader validates the plan on load (docs/design/blueprint-compose-verb.md, "The lane-plan"): a
// malformed plan ⇒ HALT with the error, never a half-stamped template. The full per-lane field set from the
// design is accepted (role · id · agentType|null · extraTools · denyTools · tier · skill · fusion · inject ·
// checks · facet). ALL of these are now WIRED end-to-end through buildNode by `laneToNodeOpts`: the fusion
// goldens (candidate-fusion-refine, fan-out-map-reduce) exercise fusion · inject · checks · deny · no-preset.

/** One lane — the intelligent hole for a blueprint slot. All optional except `role` + `id`. */
export interface Lane {
  /** The blueprint slot this lane fills — drives the wiring rule (the role's mechanical skeleton). */
  role: string;
  /** Authored node id (the verb namespaces it on insert). */
  id: string;
  /** Preset id, or null/omitted for a no-preset (hand-wired) lane. */
  agentType?: string | null;
  /** Tools ADDED on top of the preset/defaults (e.g. plan/reviewer + write). */
  extraTools?: string[];
  /** Tools removed (deny wins). */
  denyTools?: string[];
  /** Model tier when the lane pins one. */
  tier?: string;
  /** Skill ref when NOT inherited from the preset. */
  skill?: string;
  /** Inject entries the lane forces into the prompt. */
  inject?: string[];
  /** { post: [...] } post-gates — accepted; wired in a later task. */
  checks?: { pre?: unknown[]; post?: unknown[] } | null;
  /** { mode, panel?, n?, judge? } for a fusion lane — accepted; wired in a later task. */
  fusion?: unknown;
}

/** The full agent-authored lane-plan (the JSON `--plan` points at). */
export interface LanePlan {
  /** The blueprint id — must match the `stamp <id>` arg (a guard against a mis-pointed plan). */
  blueprint: string;
  /** Topology params — `K` = the reroute budget the fix-loop role uses. */
  params?: { K?: number; [k: string]: unknown };
  /** The lanes filling the blueprint's slots. */
  lanes: Lane[];
  /** meta.json fields (id/name/description/phases) — the stamped template's identity. `phases` is the
   *  decorative phase DISPLAY order the two fusion goldens carry (`["plan","draft",…]`). */
  meta?: { id?: string; name?: string; description?: string; phases?: string[] };
  /** Boundary seam bindings (used by `insert` — accepted here, unused by `stamp`). */
  seams?: Record<string, string>;
}

/** Thrown on a malformed lane-plan — the caller HALTS non-zero with the message (never a half-stamp). */
export class LanePlanError extends Error {}

/**
 * Parse + VALIDATE a lane-plan (string in — pure). Enforces the load-time contract: an object with a string
 * `blueprint`, a non-empty `lanes` array, and every lane carrying a string `role` + `id` (with unique ids and
 * well-typed optional fields). A malformed plan THROWS `LanePlanError` — the caller reports + exits non-zero.
 */
export function parseLanePlan(raw: string): LanePlan {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new LanePlanError(`lane-plan is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new LanePlanError('lane-plan must be a JSON object');
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.blueprint !== 'string' || !o.blueprint) {
    throw new LanePlanError('lane-plan.blueprint must be a non-empty string');
  }
  if (!Array.isArray(o.lanes) || o.lanes.length === 0) {
    throw new LanePlanError('lane-plan.lanes must be a non-empty array');
  }
  const seenIds = new Set<string>();
  const lanes: Lane[] = o.lanes.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new LanePlanError(`lane-plan.lanes[${i}] must be an object`);
    }
    const l = raw as Record<string, unknown>;
    if (typeof l.role !== 'string' || !l.role) {
      throw new LanePlanError(`lane-plan.lanes[${i}].role must be a non-empty string`);
    }
    if (typeof l.id !== 'string' || !l.id) {
      throw new LanePlanError(`lane-plan.lanes[${i}] (role "${l.role}") .id must be a non-empty string`);
    }
    if (seenIds.has(l.id)) throw new LanePlanError(`lane-plan: duplicate lane id "${l.id}"`);
    seenIds.add(l.id);
    if (l.agentType !== undefined && l.agentType !== null && typeof l.agentType !== 'string') {
      throw new LanePlanError(`lane-plan.lanes[${i}] (${l.id}).agentType must be a string or null`);
    }
    if (l.extraTools !== undefined && !isStringArray(l.extraTools)) {
      throw new LanePlanError(`lane-plan.lanes[${i}] (${l.id}).extraTools must be a string array`);
    }
    if (l.denyTools !== undefined && !isStringArray(l.denyTools)) {
      throw new LanePlanError(`lane-plan.lanes[${i}] (${l.id}).denyTools must be a string array`);
    }
    if (l.inject !== undefined && !isStringArray(l.inject)) {
      throw new LanePlanError(`lane-plan.lanes[${i}] (${l.id}).inject must be a string array`);
    }
    if (l.tier !== undefined && typeof l.tier !== 'string') {
      throw new LanePlanError(`lane-plan.lanes[${i}] (${l.id}).tier must be a string`);
    }
    if (l.skill !== undefined && l.skill !== null && typeof l.skill !== 'string') {
      throw new LanePlanError(`lane-plan.lanes[${i}] (${l.id}).skill must be a string or null`);
    }
    const lane: Lane = { role: l.role, id: l.id };
    if (typeof l.agentType === 'string') lane.agentType = l.agentType;
    else if (l.agentType === null) lane.agentType = null;
    if (isStringArray(l.extraTools)) lane.extraTools = l.extraTools;
    if (isStringArray(l.denyTools)) lane.denyTools = l.denyTools;
    if (typeof l.tier === 'string') lane.tier = l.tier;
    if (typeof l.skill === 'string') lane.skill = l.skill;
    if (isStringArray(l.inject)) lane.inject = l.inject;
    if (l.checks !== undefined) lane.checks = l.checks as Lane['checks'];
    if (l.fusion !== undefined) lane.fusion = l.fusion;
    return lane;
  });

  const plan: LanePlan = { blueprint: o.blueprint, lanes };
  if (o.params !== undefined) {
    if (typeof o.params !== 'object' || o.params === null || Array.isArray(o.params)) {
      throw new LanePlanError('lane-plan.params must be an object');
    }
    plan.params = o.params as LanePlan['params'];
  }
  if (o.meta !== undefined) {
    if (typeof o.meta !== 'object' || o.meta === null || Array.isArray(o.meta)) {
      throw new LanePlanError('lane-plan.meta must be an object');
    }
    plan.meta = o.meta as LanePlan['meta'];
  }
  if (o.seams !== undefined) plan.seams = o.seams as LanePlan['seams'];
  return plan;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
