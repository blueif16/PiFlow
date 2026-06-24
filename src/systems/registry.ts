/**
 * systems/registry.ts — the runtime id->factory resolution map for kind=system
 * logics (KEEP — engine seam; mirrors behaviors/registry.ts BEHAVIOR_CLASSES).
 *
 * The blueprint BINDS to system ids as DATA (blueprint.systems[] = {ref,params});
 * the SDK RESOLVES each id -> a constructed ISceneSystem here, so the data-driven
 * loader (DataLevelScene) instantiates a level's scene logics with NO per-game
 * system code. GENERIC: a logic is added in ONE place (its file + its CAPABILITY
 * const + one line below); every future blueprint can then bind it by id. Nothing
 * game-specific lives here.
 *
 * Two ids can map to the SAME class with different fixed construction — this is
 * how GoalReach is the threshold-0 expression of ScoreGateGoal (the design binds
 * either id; the factory supplies the difference).
 */
import type { ISceneSystem } from '../scenes/level-data';
import { CollectScore } from './CollectScore';
import { ScoreGateGoal } from './ScoreGateGoal';
import { KnockbackImpulse } from './KnockbackImpulse';
import { HitstunState } from './HitstunState';
import { ComboChain } from './ComboChain';
import { CrumblingPlatform } from './CrumblingPlatform';
import { PostureBreak } from './PostureBreak';
import { OneWayPlatform } from './OneWayPlatform';
import { WindZone } from './WindZone';

/** A system factory constructed from a single `params` object (the {ref,params} shape). */
export type SystemFactory = (params?: Record<string, any>) => ISceneSystem;

/**
 * id -> system factory, for `levelData.systems[] = {ref, params}`. The loader does
 * `SYSTEM_CLASSES[ref](params)` and runs the ISceneSystem lifecycle. GoalReach is
 * ScoreGateGoal pinned to threshold 0 (a pure-completion win with no scoring); a
 * design-supplied `threshold` param cannot override it (the factory forces 0).
 */
export const SYSTEM_CLASSES: Record<string, SystemFactory> = {
  CollectScore: (params) => new CollectScore(params ?? {}),
  ScoreGateGoal: (params) => new ScoreGateGoal(params ?? {}),
  GoalReach: (params) => new ScoreGateGoal({ ...(params ?? {}), threshold: 0 }),
  KnockbackImpulse: (params) => new KnockbackImpulse(params ?? {}),
  HitstunState: (params) => new HitstunState(params ?? {}),
  ComboChain: (params) => new ComboChain(params ?? {}),
  CrumblingPlatform: (params) => new CrumblingPlatform(params ?? {}),
  PostureBreak: (params) => new PostureBreak(params ?? {}),
  OneWayPlatform: (params) => new OneWayPlatform(params ?? {}),
  WindZone: (params) => new WindZone(params ?? {}),
};

/** Resolve a system id -> a constructed ISceneSystem; undefined when unknown. */
export function resolveSystem(id: string, params?: Record<string, any>): ISceneSystem | undefined {
  const factory = SYSTEM_CLASSES[id];
  if (!factory) return undefined;
  const sys = factory(params);
  // Stamp the stable registry id on the instance — the minification-safe runtime identity.
  // `vite build` mangles class names, so constructor.name is NOT a reliable id; every
  // identity check (auto-add guards, the __GAME__.debug roster, the verify ownership gate)
  // reads sys.id instead. Single source: the registry key that constructed it.
  sys.id = id;
  return sys;
}
