/**
 * behaviors/registry.ts — runtime-importable aggregate of every behavior &
 * effect CAPABILITY sidecar (capability-registry-harness).
 *
 * This is the ONE place that imports each behavior file's self-describing
 * `CAPABILITY` const (and SkillBehavior's `SKILL_CAPABILITIES` / the
 * ScreenEffectHelper `EFFECT_CAPABILITIES`). The SDK runtime can import
 * `PLATFORMER_CAPABILITIES` to introspect what's bindable; the generated
 * `capabilities.json` is the design-time mirror of the SAME data.
 *
 * Adding a behavior = create its file with a `CAPABILITY` const and add ONE
 * import line here. The drift gate (registry:check) then forces the generated
 * catalog back in sync, so a built-but-unregistered behavior cannot ship.
 */
import { CAPABILITY as PlatformerMovementCapability, PlatformerMovement } from './PlatformerMovement';
import { CAPABILITY as MeleeAttackCapability } from './MeleeAttack';
import { CAPABILITY as RangedAttackCapability } from './RangedAttack';
import { CAPABILITY as PatrolAICapability, PatrolAI } from './PatrolAI';
import { CAPABILITY as ChaseAICapability, ChaseAI } from './ChaseAI';
import { CAPABILITY as ContactRespawnCapability, ContactRespawn } from './ContactRespawn';
import {
  CAPABILITY as SkillBehaviorCapability,
  SKILL_CAPABILITIES,
  DashAttackSkill,
  AreaDamageSkill,
  TargetedExecutionSkill,
  TargetedAOESkill,
  BeamAttackSkill,
  GroundQuakeSkill,
  BoomerangSkill,
  MultishotSkill,
  ArcProjectileSkill,
} from './SkillBehavior';
import { EFFECT_CAPABILITIES, ScreenEffectHelper } from './ScreenEffectHelper';
import { CyclicHazard } from './CyclicHazard';
import { EnemyRangedTelegraph } from './EnemyRangedTelegraph';
import { DirectionalBlock } from './DirectionalBlock';
import { ConveyorBelt } from './ConveyorBelt';
import type { IBehavior } from './IBehavior';
import type Phaser from 'phaser';

/** Every `kind:'behavior'` capability the platformer module ships. */
export const BEHAVIOR_CAPABILITIES = [
  PlatformerMovementCapability,
  MeleeAttackCapability,
  RangedAttackCapability,
  PatrolAICapability,
  ChaseAICapability,
  ContactRespawnCapability,
  SkillBehaviorCapability,
  ...SKILL_CAPABILITIES,
] as const;

/** Every `kind:'effect'` capability (ScreenEffectHelper methods). */
export { EFFECT_CAPABILITIES };

/** The full self-describing capability set (behaviors + effects). */
export const PLATFORMER_CAPABILITIES = [
  ...BEHAVIOR_CAPABILITIES,
  ...EFFECT_CAPABILITIES,
] as const;

// ════════════════════════════════════════════════════════════════════════════
// RUNTIME RESOLUTION MAPS (KEEP — engine seam for the data-driven level loader)
//
// The blueprint BINDS to capability ids as DATA ({ref,params}); the SDK RESOLVES
// each id → its implementation here, so a level is INSTANTIATED from data with no
// per-game placement/behavior code. GENERIC: a behavior/effect is added in ONE
// place (its file + the CAPABILITY const + one line below); every future blueprint
// can then bind it by id. Nothing game-specific lives here.
// ════════════════════════════════════════════════════════════════════════════

/** A behavior class constructed from a single `params` object (the {ref,params} shape). */
export type BehaviorClass = new (params: any) => IBehavior;

/**
 * id → behavior class, for `entities[].behaviors[] = {ref, params}`. The loader
 * does `new BEHAVIOR_CLASSES[ref](params)` and attaches it via BehaviorManager.
 * Only behaviors whose constructor takes a single config object appear here
 * (PlatformerMovement, PatrolAI, ChaseAI, CyclicHazard, + the SKILL_CAPABILITIES
 * ultimates — each a single-config IBehavior that receives its scene via attach()).
 * Combat behaviors that need a richer scene context at construction (MeleeAttack,
 * RangedAttack) stay composed by the Base* classes, not bound from layout.
 */
export const BEHAVIOR_CLASSES: Record<string, BehaviorClass> = {
  PlatformerMovement: PlatformerMovement as unknown as BehaviorClass,
  PatrolAI: PatrolAI as unknown as BehaviorClass,
  ChaseAI: ChaseAI as unknown as BehaviorClass,
  ContactRespawn: ContactRespawn as unknown as BehaviorClass,
  CyclicHazard: CyclicHazard as unknown as BehaviorClass,
  EnemyRangedTelegraph: EnemyRangedTelegraph as unknown as BehaviorClass,
  DirectionalBlock: DirectionalBlock as unknown as BehaviorClass,
  ConveyorBelt: ConveyorBelt as unknown as BehaviorClass,
  // The bindable ultimate-skill library (SKILL_CAPABILITIES). Each is a
  // single-config IBehavior the loader can mount onto the player from layout.
  DashAttackSkill: DashAttackSkill as unknown as BehaviorClass,
  AreaDamageSkill: AreaDamageSkill as unknown as BehaviorClass,
  TargetedExecutionSkill: TargetedExecutionSkill as unknown as BehaviorClass,
  TargetedAOESkill: TargetedAOESkill as unknown as BehaviorClass,
  BeamAttackSkill: BeamAttackSkill as unknown as BehaviorClass,
  GroundQuakeSkill: GroundQuakeSkill as unknown as BehaviorClass,
  BoomerangSkill: BoomerangSkill as unknown as BehaviorClass,
  MultishotSkill: MultishotSkill as unknown as BehaviorClass,
  ArcProjectileSkill: ArcProjectileSkill as unknown as BehaviorClass,
};

/** Resolve a behavior id → class; undefined when unknown (loader reports it). */
export function resolveBehavior(id: string): BehaviorClass | undefined {
  return BEHAVIOR_CLASSES[id];
}

/**
 * id → effect invocation, for `effects[] = {on, play, params?}`. Each entry calls
 * the matching ScreenEffectHelper / scene method at (x,y) with the bound params.
 * The loader fires `EFFECT_DISPATCH[play]?.(scene, x, y, params)` when the bound
 * event emits. GENERIC: keyed off EFFECT_CAPABILITIES ids — a new effect id is one
 * line here. A param the effect needs but the blueprint omits falls back to a
 * sane default (an effect is cosmetic — it never reads/writes an observed field).
 */
export type EffectInvoker = (
  scene: Phaser.Scene,
  x: number,
  y: number,
  params?: Record<string, any>,
) => void;

export const EFFECT_DISPATCH: Record<string, EffectInvoker> = {
  shake: (s, _x, _y, p) =>
    ScreenEffectHelper.shake(s, {
      duration: Number(p?.duration ?? 300),
      intensity: Number(p?.intensity ?? 0.008),
    }),
  shakeLight: (s) => ScreenEffectHelper.shakeLight(s),
  shakeMedium: (s) => ScreenEffectHelper.shakeMedium(s),
  shakeStrong: (s) => ScreenEffectHelper.shakeStrong(s),
  createExplosion: (s, x, y, p) =>
    ScreenEffectHelper.createExplosion(s, x, y, {
      imageKey: String(p?.imageKey ?? '__px'),
      scale: Number(p?.scale ?? 0.6),
      endScale: Number(p?.endScale ?? (Number(p?.scale ?? 0.6) * 2)),
      alpha: Number(p?.alpha ?? 0.9),
      duration: Number(p?.duration ?? 500),
    }),
  createDefaultExplosion: (s, x, y, p) =>
    ScreenEffectHelper.createDefaultExplosion(s, x, y, String(p?.imageKey ?? '__px')),
  createChargeEffect: (s, x, y, p) =>
    ScreenEffectHelper.createChargeEffect(s, x, y, String(p?.imageKey ?? '__px')),
  showDamageNumber: (s, x, y, p) =>
    ScreenEffectHelper.showDamageNumber(s, x, y, Number(p?.amount ?? 1), String(p?.color ?? '#ffd34a')),
  createDashTrail: (s, x, y, p) =>
    ScreenEffectHelper.createDashTrail(s, { x, y }, String(p?.imageKey ?? '__px')),
};

/** Resolve an effect id → invoker; undefined when unknown (loader reports it). */
export function resolveEffect(id: string): EffectInvoker | undefined {
  return EFFECT_DISPATCH[id];
}
