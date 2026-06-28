// SA-C · AgentBase compiler expansion (expert-representations).
//
// This module is the AUTHOR-TIME compiler that takes a node's declared `AgentBase` fields and
// expands them into a concrete `NodeIntent`-compatible patch:
//
//   1. **Skill auto-wire** (SA-A): run `resolveSkillLoadout` over the node's skill manifests →
//      union the `requires` ids into `tools.allow`, union `allowed` into the effective ceiling.
//   2. **Gate lowering** (SA-B): run `lowerGates` over authored gate specs → emit `op[]` entries
//      + a materialized judge node (if a judge gate is present) + a checkpoint patch (human gate).
//   3. **Tier resolution** via the existing precedence (model-routing.ts §2):
//        node.model > node.tier > recipe.tier > run.model > pi default
//      A tier is NEVER a model id; the tier key is carried through; the runner resolves it.
//   4. **Sandbox passthrough** — the node's declared `sandbox?` is carried verbatim; a preset
//      NEVER contributes sandbox fields (workflow-level concern).
//   5. **Preflight** — if a `ToolRegistry` is provided, call `preflightSkills` to fail fast before
//      spawning a pi when any required tool is absent from the catalog.
//
// PURE: all I/O is via arguments. No fs access — that belongs in the loader. Author-time only;
// the runner stays preset-agnostic (it reads only the materialized `op[]`/`sandbox`/`tools`).
//
// FILE FENCE (SA-C only): consumes gate-authoring.ts + skill-manifest.ts (NEVER modifies them);
// does NOT touch runner.ts, lower.ts, checks.ts, or the GUI.

import type { AgentBase, OpSpec, ToolSelection, SandboxSpec, ToolRegistry } from '../types.js';
import type { SkillManifest } from './ops/skill.js';
import { resolveSkillLoadout, preflightSkills } from './ops/skill.js';
import type { GateAuthorSpec } from './gate-authoring.js';
import { lowerGates } from './gate-authoring.js';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The authored gate specs for a node + optional skill manifests.
 * Callers supply what they have; every field is optional.
 */
export interface NodeBaseSpec {
  /** The AgentBase fields — either from a preset merge or authored directly. */
  base: AgentBase;
  /**
   * Authored gate specs (SA-B shapes) for this node's post-lane.
   * These are LOWERED into `op[]` by the compiler (author-time only).
   * A preset NEVER carries gates — they are workflow-level.
   */
  gates?: GateAuthorSpec[];
  /**
   * Parsed skill manifests for the node's skills (SA-A output).
   * Used for auto-wire (`resolveSkillLoadout`) and preflight (`preflightSkills`).
   * If absent, no auto-wiring or preflight occurs.
   */
  skillManifests?: SkillManifest[];
  /**
   * A live tool registry — used for preflight only. If absent, preflight is skipped.
   * Callers that have a registry (loader, init) should always pass it; test callers may omit it.
   */
  registry?: ToolRegistry;
}

/**
 * The output of `compileNodeBase` — everything the loader needs to construct a `NodeIntent` patch.
 * The caller merges these fields onto the node being compiled.
 */
export interface CompiledNodeBase {
  /**
   * The merged tool selection: base tools UNION auto-wired required tools from skills.
   * `deny` carries the node's explicit deny list (node deny wins over preset allow).
   * Undefined when nothing was contributed (callers should leave the node's tools untouched).
   */
  tools?: ToolSelection;
  /**
   * The effective skill ceiling (union of all skills' `allowed` ids).
   * Callers may pass this as the Anthropic `allowed-tools` list for the node's pi session.
   */
  effectiveCeiling?: string[];
  /**
   * The lowered `op[]` entries from the authored gate specs, appended to any `base.op`.
   * Already in cost-ladder order (deterministic first, judge next, human last).
   */
  op?: OpSpec[];
  /**
   * (Judge gates only) A materialized judge pi node. The caller wires this into the DAG immediately
   * after the producer. Id suggestion: `<producerId>__judge`. The caller assigns `deps`/`io`.
   */
  judgeNode?: import('./gate-authoring.js').JudgeMaterializedNode;
  /**
   * (Human gates only) Patch to merge onto the producer node's `checkpoint` field.
   */
  checkpointPatch?: {
    kind: 'confirm' | 'input' | 'select';
    prompt: string;
    choices?: string[];
  };
  /**
   * The effective sandbox spec: the node's authored `base.sandbox` (presets never contribute this).
   * Undefined when no sandbox was declared (the loader applies its own defaults).
   */
  sandbox?: Partial<SandboxSpec>;
  /**
   * The resolved tier key. Precedence: `base.tier` (node tier) first; falls through to caller's
   * recipe/run tier via `resolveAgentTier`. NEVER a model id — a tier key only.
   */
  tier?: string;
  /**
   * The effective prompt from the base. Undefined if no prompt was declared.
   */
  prompt?: string;
}

// ── Stable de-dupe ───────────────────────────────────────────────────────────

function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

// ── Tier precedence ──────────────────────────────────────────────────────────

/**
 * Resolve the effective tier key from a node's AgentBase and an optional recipe/run fallback.
 * Precedence (all tier keys, never model ids):
 *   node.tier  >  recipeTier  >  undefined
 *
 * The node's explicit `model` overrides the tier at the runner (model-routing.ts §2); this
 * function only resolves the TIER TRACK — the runner applies `node.model > tiers[tier] > run.model`.
 *
 * PURE — no I/O.
 */
export function resolveAgentTier(
  base: AgentBase,
  recipeTier?: string,
): string | undefined {
  return base.tier ?? recipeTier;
}

// ── Tool merge ───────────────────────────────────────────────────────────────

/**
 * Merge two ToolSelections additively: allow = unique(a.allow ∪ b.allow); deny = unique(a.deny ∪ b.deny).
 * The caller applies deny-wins-over-allow AFTER merging both; this is the raw union.
 * PURE — no I/O.
 */
function mergeTools(a?: ToolSelection, b?: ToolSelection): ToolSelection | undefined {
  const allowA = a?.allow ?? [];
  const allowB = b?.allow ?? [];
  const denyA = a?.deny ?? [];
  const denyB = b?.deny ?? [];
  const allow = uniq([...allowA, ...allowB]);
  const deny = uniq([...denyA, ...denyB]);
  const denySet = new Set(deny);
  const allowFiltered = allow.filter((x) => !denySet.has(x));
  if (!allowFiltered.length && !deny.length) return undefined;
  const result: ToolSelection = {};
  if (allowFiltered.length) result.allow = allowFiltered;
  if (deny.length) result.deny = deny;
  return result;
}

// ── Main compiler ────────────────────────────────────────────────────────────

/**
 * **Author-time compiler** for a node's `AgentBase` + gate pipeline + skill manifests.
 *
 * Expands (PURE, no I/O except optional preflight via the registry):
 *   1. Auto-wire skills → `tools.allow` (SA-A `resolveSkillLoadout`)
 *   2. Lower gate specs → `op[]` + optional judge node + checkpoint patch (SA-B `lowerGates`)
 *   3. Resolve tier precedence (`node.tier > recipeTier`)
 *   4. Run preflight (`preflightSkills`) when a registry is provided — throws on missing `requires`
 *   5. Carry `sandbox` from the node (never from a preset)
 *
 * Returns a `CompiledNodeBase` the loader merges onto the `NodeIntent` it is building.
 *
 * The runner is NEVER called from here — runner stays preset-agnostic.
 */
export function compileNodeBase(
  spec: NodeBaseSpec,
  opts: {
    /** The node id of the producer — used to name the judge node and the rerouteTo action target. */
    producerId: string;
    /** Optional recipe tier — the fallback when neither `base.tier` nor `node.model` is set. */
    recipeTier?: string;
  },
): CompiledNodeBase {
  const { base, gates = [], skillManifests = [], registry } = spec;
  const { producerId, recipeTier } = opts;

  // 1 · Preflight — fail fast before the rest of the compilation.
  //     `preflightSkills` throws a clear, actionable error when any `requires` id is absent.
  if (registry && skillManifests.length > 0) {
    preflightSkills(skillManifests, registry);
  }

  // 2 · Auto-wire skills → tools.
  const loadout = resolveSkillLoadout(skillManifests);
  const autoWiredTools: ToolSelection | undefined =
    loadout.toolsToWire.length > 0 ? { allow: loadout.toolsToWire } : undefined;

  // 3 · Merge: base tools UNION auto-wired tools (deny wins over allow in mergeTools).
  const tools = mergeTools(base.tools, autoWiredTools);

  // 4 · Lower gate specs → op[] + judge node + checkpoint patch (SA-B).
  //     Ordered in cost-ladder order by lowerGates internally.
  const gateResult = gates.length > 0 ? lowerGates(gates, producerId) : undefined;

  // 5 · Combine base op[] (if any) with the gate-lowered ops.
  const baseOps: OpSpec[] = base.op ?? [];
  const gateOps: OpSpec[] = gateResult?.ops ?? [];
  const op = baseOps.length > 0 || gateOps.length > 0
    ? [...baseOps, ...gateOps]
    : undefined;

  // 6 · Tier resolution (node.tier > recipeTier).
  const tier = resolveAgentTier(base, recipeTier);

  // 7 · Effective ceiling (for Anthropic allowed-tools, if the caller wants it).
  const effectiveCeiling =
    loadout.effectiveCeiling.length > 0 ? loadout.effectiveCeiling : undefined;

  const result: CompiledNodeBase = {};
  if (tools) result.tools = tools;
  if (effectiveCeiling) result.effectiveCeiling = effectiveCeiling;
  if (op) result.op = op;
  if (gateResult?.judgeNode) result.judgeNode = gateResult.judgeNode;
  if (gateResult?.checkpointPatch) result.checkpointPatch = gateResult.checkpointPatch;
  if (base.sandbox) result.sandbox = base.sandbox;
  if (tier) result.tier = tier;
  if (base.prompt) result.prompt = base.prompt;

  return result;
}

// ── Preset → AgentBase coercion ──────────────────────────────────────────────

/**
 * Convert an `AgentPreset` (the 6 preset seeds; G6 `mergePreset` shape) to an `AgentBase`.
 * A preset is a PARTIAL AgentBase: it never carries `sandbox` or `op` (workflow-level concerns).
 * This is a shape adapter — the compiler accepts either; the caller may use this for uniformity.
 *
 * PURE — no I/O.
 */
export function presetToBase(preset: {
  id: string;
  display?: { label?: string; icon?: string; color?: string };
  skills?: string[];
  tools?: ToolSelection;
  tier?: string;
  prompt: string;
}): AgentBase {
  const base: AgentBase = { id: preset.id };
  if (preset.display) base.display = preset.display;
  if (preset.skills?.length) base.skills = preset.skills;
  if (preset.tools) base.tools = preset.tools;
  if (preset.tier) base.tier = preset.tier;
  if (preset.prompt) base.prompt = preset.prompt;
  // sandbox and op are deliberately NOT copied — they are workflow-level (decision 8).
  return base;
}

/**
 * Verify that the 6 preset seed files load as valid (partial) `AgentBase` objects.
 * A preset MUST NOT carry `sandbox` or `op` — those are workflow-level concerns.
 * Throws `AgentBaseError` if a preset violates the invariant.
 *
 * Called by the loader at template-load time when presets are referenced; also useful in tests.
 */
export class AgentBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentBaseError';
  }
}

/**
 * Validate that a loaded preset conforms to the `AgentBase` invariant:
 *   - `sandbox` MUST be absent (workflow-level; never on a preset).
 *   - `op` MUST be absent (gates are workflow-level; never baked into a preset).
 *   - `tier` (if set) MUST NOT be a model id — it should be a short CLASS key.
 *
 * Throws `AgentBaseError` on a violation. PURE (no I/O).
 */
export function validatePresetAsBase(preset: { id: string; sandbox?: unknown; op?: unknown; tier?: string }): void {
  if (preset.sandbox !== undefined) {
    throw new AgentBaseError(
      `preset "${preset.id}": sandbox is a workflow-level concern and MUST NOT be set on a preset. ` +
        `Remove sandbox from the preset file; set it on the node instead.`,
    );
  }
  if (preset.op !== undefined) {
    throw new AgentBaseError(
      `preset "${preset.id}": op[] (gate pipeline) is workflow-level and MUST NOT be set on a preset. ` +
        `Author gates on the node, not the preset.`,
    );
  }
  // A tier value that looks like a model id (contains '/' or '-' followed by digits, typical model ids)
  // is a likely mistake — warn via a throw so the error surfaces early.
  if (typeof preset.tier === 'string' && preset.tier.length > 0) {
    // Heuristic: canonical tier keys are short single words; model ids typically contain '-' or '/'
    // and are longer. We do NOT enforce this as a hard schema rule (free data), but we flag obvious
    // mistakes like `tier: "claude-opus-4-8"`.
    const likelyModelId = /\//.test(preset.tier) || (/\d/.test(preset.tier) && preset.tier.length > 20);
    if (likelyModelId) {
      throw new AgentBaseError(
        `preset "${preset.id}": tier "${preset.tier}" looks like a model id, not a tier key. ` +
          `Set a short tier class key (e.g. 'fast', 'balanced', 'deep') — the user's model-tiers.json ` +
          `maps it to a concrete model. Use 'model' on the node if you need a concrete model id.`,
      );
    }
  }
}
