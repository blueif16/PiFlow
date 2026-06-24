/**
 * level-data.ts — the runtime LEVEL DATA contract (KEEP — engine seam).
 *
 * This is the shape of the per-level data file `src/levels/<level>.json` that W2
 * MATERIALIZES from `blueprint.layout` + the blueprint's capability BINDINGS
 * (genre/behaviors/effects/controlScheme/custom). DataLevelScene reads it and
 * INSTANTIATES the whole level from it — platforms, spawn, goal, rewards, threats,
 * each entity's bound behaviors, the event->effect bindings, and the timer — with
 * ZERO per-game placement code. W4 authors ONLY the `custom[]` entries.
 *
 * It is a faithful, build-bundled projection of the blueprint's DATA: the runtime
 * bundles `gameConfig.json` + this level file, never `spec/blueprint.json`, so the
 * geometry/bindings ride into the build through here.
 *
 * GENERIC: no game/theme is encoded in this file — it is a TYPE. The gold's
 * strings (pipe/steam/mech) live ONLY in the materialized `levels/<level>.json`.
 */

/**
 * A solid platform (traversable geometry). x/y is the TOP-LEFT corner (the
 * blueprint/layout convention — its feasibility math uses platform_end = x +
 * width); the SDK converts to a centered sprite. (rewards/spawn/goal are point
 * coordinates — those x/y are the entity center.)
 */
export interface PlatformData {
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Real ground/tile texture KEY (an index.json slot). When it resolves the
   * platform surface is a seamless tileSprite of that tile; absent → the level's
   * groundSlot, else the placeholder rect. Collision (the static body) is
   * unchanged either way.
   */
  assetSlot?: string;
}

/** A behavior binding: a registry id, or {ref,params}, or a "$custom:<id>" ref. */
export type BehaviorBinding = string | { ref: string; params?: Record<string, any> };

/**
 * A SYSTEM binding (the scene-level kind=system tier): {ref,params} where `ref` is
 * a registered system id (systems/registry.ts SYSTEM_CLASSES — CollectScore /
 * ScoreGateGoal / GoalReach) and `params` is the per-game tuning the SDK constructs
 * it with. The data-driven projection of the blueprint's `systems[]` bucket. The
 * loader resolves each ref -> a constructed ISceneSystem and runs its lifecycle,
 * exactly like a custom[] system. GENERIC: no game/theme is encoded — a TYPE.
 */
export type SystemBinding = { ref: string; params?: Record<string, any> };

/** A reward/collectible placed at a coordinate (rewards[] in layout). */
export interface RewardData {
  id: string;
  x: number;
  y: number;
  /** functional kind for __GAME__.entities ('collectible' by default). */
  kind?: string;
  /** asset/texture key (falls back to a placeholder). */
  assetSlot?: string;
  /** per-frame display dims (falls back to a default). */
  width?: number;
  height?: number;
  /** bound behaviors (registry {ref,params} or "$custom:<id>"). */
  behaviors?: BehaviorBinding[];
  /** the entity-level role tag (for __GAME__.entities type). */
  role?: string;
  /**
   * The blueprint ENTITY this reward instances (e.g. 'pipe' vs 'energy_core').
   * Tagged on the sprite as `.__kind` so a custom[] system can distinguish reward
   * classes (the scored vs the resource grant) without per-game placement code.
   */
  entityKind?: string;
}

/** A cyclic/static hazard OR moving-enemy threat (threats[] in layout). */
export interface ThreatData {
  id: string;
  x: number;
  y: number;
  /**
   * layout threat kind. 'static_hazard' (or any threat carrying a CyclicHazard
   * binding/cycle fields) instantiates a telegraphed CyclicHazard on the hazard
   * path. A MOVING enemy kind ('patrol' | 'chaser') instead spawns a plain enemy
   * into scene.enemies and attaches its bound `behaviors[]` (PatrolAI/ChaseAI +
   * ContactRespawn) — see DataLevelScene.createEnemies / spawnMovingEnemy.
   */
  kind?: string;
  cycleMs?: number;
  activeMs?: number;
  telegraphMs?: number;
  shape?: 'column' | 'bar';
  columnHeight?: number;
  barWidth?: number;
  phaseOffsetMs?: number;
  /** explicit behavior bindings (override the kind heuristic when present). */
  behaviors?: BehaviorBinding[];
  /**
   * Real hazard/enemy texture KEY (an index.json slot). When it resolves the
   * threat renders as that sprite; absent → the placeholder rect (body unchanged).
   */
  assetSlot?: string;
  /** per-frame display dims for a moving enemy (falls back to a default). */
  width?: number;
  height?: number;
  /**
   * Contact damage for a moving enemy under failModel:'health' ONLY (the SDK's
   * setupContactDamage path). Under failModel respawn/lives a moving enemy carries
   * NO damage — ContactRespawn owns the consequence and the SDK overlap is benign
   * (takeDamage(0)) — so the consequence is never double-applied.
   */
  damage?: number;
  /** whether the moving enemy falls under gravity (default true; false = flyer). */
  hasGravity?: boolean;
}

/** The goal/exit entity (layout.goal). */
export interface GoalData {
  id: string;
  x: number;
  y: number;
  assetSlot?: string;
  width?: number;
  height?: number;
  /**
   * Bound behaviors (registry {ref,params} or "$custom:<id>"). The goal is a bare
   * sprite the SDK scene-ticks, so an `attachedTo:<goal>` custom (a power-up gate,
   * a reach-to-win) attached here runs every frame. Projected by W2 from the goal
   * entity's behaviors, exactly like the player/reward projection.
   */
  behaviors?: BehaviorBinding[];
}

/** An event->effect binding (blueprint.effects[]). */
export interface EffectBinding {
  on: string;
  play: string;
  params?: Record<string, any>;
}

/** The whole runtime level data. */
export interface LevelData {
  /** the scene key (defaults to 'Level1Scene'). */
  scene?: string;
  /** world bounds (the camera-followed world; >= viewport). */
  bounds?: { width: number; height: number };
  /** background color (hex string) when no parallax bg slot is given. */
  backgroundColor?: string;
  /** parallax background asset slot key (optional). */
  backgroundSlot?: string;
  /**
   * Level-default ground tile texture KEY (an index.json slot). Every platform
   * without its own assetSlot tiles this; absent → the placeholder rect. The
   * common case: one shared ground tileset for all platforms.
   */
  groundSlot?: string;
  playerSpawn: { x: number; y: number };
  /** the player's asset slot + bound behaviors (PlatformerMovement {ref,params}). */
  player?: {
    id?: string;
    assetSlot?: string;
    displayHeight?: number;
    displayWidth?: number;
    behaviors?: BehaviorBinding[];
    anim?: Record<string, string>;
  };
  goal?: GoalData;
  platforms?: PlatformData[];
  rewards?: RewardData[];
  threats?: ThreatData[];
  effects?: EffectBinding[];
  /**
   * Registered SCENE SYSTEM bindings (the kind=system tier). Each {ref,params}
   * names a system id in systems/registry.ts (CollectScore/ScoreGateGoal/GoalReach);
   * the loader constructs + lifecycles each exactly like a custom[] system. The
   * data-driven projection of blueprint.systems[]. OPTIONAL — a level with no
   * scene-level orchestration omits it.
   */
  systems?: SystemBinding[];
  /** time-penalty seconds for a hazard hit / fall (failModel:'time'). */
  hitTimePenalty?: number;
}

/**
 * ISceneSystem — the SDK interface a `custom[]` SYSTEM implements (KEEP — engine
 * seam). The genuinely-novel scene-level logic W4 authors (e.g. a collect-all
 * gate). The DataLevelScene constructs it (via the registered factory), runs its
 * lifecycle, and routes update/collision through it. attach() gets the live scene;
 * setupCollisions() wires overlaps (player exists by then); update() ticks.
 */
export interface ISceneSystem {
  /** Stable registry id, stamped by resolveSystem() — the minification-safe runtime identity. */
  id?: string;
  /** Called once after the level is built (player + entities exist). */
  attach(scene: any): void;
  /** Wire any player<->entity overlaps this system owns. */
  setupCollisions?(): void;
  /** Per-frame tick (optional). */
  update?(): void;
  /**
   * Re-initialize ALL of this system's internal latches/flags to a fresh-level
   * state (KEEP — engine seam). The SDK calls reset() at the start of every
   * create() — including a scene RESTART (commands.reset(), the verify
   * completability/per-GIVEN probes) — BEFORE attach()/setupCollisions(). A
   * system that holds run state (a one-shot win latch, a per-entity "done" set)
   * MUST clear it here so a restarted level is genuinely replayable; a system
   * that re-derives all state from attach() may omit it. Optional, generic — no
   * game/theme is encoded.
   */
  reset?(): void;
}
