/**
 * ============================================================================
 * DataLevelScene — the DATA-DRIVEN level loader (KEEP — engine; the Track-B core)
 * ============================================================================
 *
 * Builds an ENTIRE platformer level from a `LevelData` object as DATA — platforms,
 * player spawn, goal, rewards, threats, each entity's bound behaviors, the
 * event->effect bindings, and the failModel:'time' countdown — with ZERO per-game
 * placement or behavior-reimplementation code. The blueprint's `layout` + capability
 * BINDINGS become this data (W2 materializes `src/levels/<level>.json` from them);
 * the SDK instantiates it.
 *
 * The executor (W4) writes ONLY the `custom[]` delta (an IBehavior / ISceneSystem
 * per genuinely-novel entry) and registers it via custom-registry; this loader
 * resolves "$custom:<id>" bindings + custom[] systems against that registry.
 *
 * GENERIC: no game/theme is encoded here. It reads ids and DATA; the gold's
 * pipe/steam/mech strings live ONLY in the materialized levels/<level>.json.
 *
 * A game's level scene becomes a ~10-line shell: `extends DataLevelScene`, pass
 * the imported level JSON + the registered custom factories, done. (See
 * _DataLevelScene_usage in this file's header comment.)
 *
 * USAGE (the entire W4-side level file for a data-driven level):
 *   import levelData from '../levels/level1.json';
 *   export class Level1Scene extends DataLevelScene {
 *     constructor() { super('Level1Scene', levelData as LevelData); }
 *   }
 *   // + W4 registers custom[] factories once (custom-registry) before boot.
 */
import Phaser from 'phaser';
import { BaseLevelScene } from './BaseLevelScene';
import { DataPlayer } from '../characters/DataPlayer';
import { resolveBehavior, resolveEffect } from '../behaviors/registry';
import { resolveSystem } from '../systems/registry';
import { BehaviorManager, type IBehavior } from '../behaviors';
import * as utils from '../utils';
import gameConfig from '../gameConfig.json';
import type {
  LevelData,
  BehaviorBinding,
  RewardData,
  ThreatData,
  ISceneSystem,
} from './level-data';
import {
  resolveCustomBehavior,
  resolveCustomSystem,
} from './custom-registry';
import { WorldCueDriver, type CueTarget } from '@contract/guidance/WorldCueDriver';
import { makePhaserMarkerFactory } from '../guidance/phaserCueMarker';

/** Default per-platform color (greybox). */
const PLATFORM_COLOR = 0x4b5d78;

export abstract class DataLevelScene extends BaseLevelScene {
  /** The level data this scene instantiates (set by the subclass constructor). */
  protected readonly levelData: LevelData;

  /** The custom[] systems active this level (resolved from custom-registry). */
  protected systems: ISceneSystem[] = [];

  /** Bound event->effect bindings (blueprint.effects[]) the loader fires. */
  private effectBindings: LevelData['effects'] = [];

  /** Per-reward sprite map, by id (for systems + diagnostics). */
  protected rewardsById: Record<string, Phaser.GameObjects.Sprite> = {};
  /** The goal/exit sprite (if any). */
  public goalSprite?: Phaser.GameObjects.Sprite & { __id?: string; __type?: string; locked?: boolean };

  /**
   * Owners carrying bound behaviors that the scene must tick every frame (a bare
   * reward sprite is not on any update list, so a "$custom:<id>" reward behavior
   * would never run on its own). We collect them at build time and drive them
   * from THIS scene's update() loop — NOT via a per-owner events.on(UPDATE)
   * listener, which leaks across a scene RESTART (commands.reset() re-runs
   * create() and would stack a new listener every time). Reset per create().
   */
  private boundBehaviorOwners: any[] = [];

  /**
   * The diegetic WORLD-CUE driver (gameConfig.guidance.worldCues[] → in-world
   * markers pinned to a target entity). Renderer-agnostic; the Phaser chevron
   * marker is injected via makePhaserMarkerFactory. Inert when no worldCues[] are
   * declared (the additive guarantee). Constructed in create() after the world is
   * built, baselined once `ready` latches, polled each frame from update().
   */
  private worldCues?: WorldCueDriver;
  /** One-shot guard: baseline the worldCue triggers on the first ready frame. */
  private _worldCueStarted = false;

  constructor(
    sceneKeyOrConfig: string | Phaser.Types.Scenes.SettingsConfig,
    levelData: LevelData,
  ) {
    super(sceneKeyOrConfig);
    this.levelData = levelData;
  }

  // ── boot ──────────────────────────────────────────────────────────────────

  preload(): void {
    utils.ensurePlaceholderTexture(this, '__px', 8, 8, 'sprite');
    utils.createBulletTextures(this);
  }

  create(): void {
    // Fresh-level state (restart safety): a scene RESTART (commands.reset(), the
    // verify per-GIVEN/completability probes) re-runs create(), so clear the
    // per-build collections so nothing leaks from the prior generation.
    this.boundBehaviorOwners = [];
    this._worldCueStarted = false;
    // Resolve & construct the custom[] systems BEFORE building, so they can wire
    // collisions in setupCustomCollisions (player exists by then).
    this.constructSystems();
    this.effectBindings = this.levelData.effects ?? [];
    this.createBaseElements();
    // Diegetic world cues: build AFTER the world (player/goal/rewards exist so the
    // entity resolver can find them). Inert when no worldCues[] are declared.
    this.worldCues = new WorldCueDriver(
      (id) => this.findEntityById(id),
      makePhaserMarkerFactory(this),
    );
    this.worldCues.mount(gameConfig as Record<string, unknown>);
    this.cameras.main.fadeIn(300);
  }

  update(): void {
    this.baseUpdate();
    // Tick every bound reward behavior from the ONE scene update loop (no leaked
    // per-owner listeners): a "$custom:<id>" reward behavior mutates its declared
    // observable here, every frame, deterministically across resets.
    for (const owner of this.boundBehaviorOwners) {
      if (owner && owner.active !== false && owner.behaviors) owner.behaviors.update();
    }
    for (const sys of this.systems) sys.update?.();
    // Drive the diegetic world cues: baseline once `ready` latches, then poll +
    // re-pin each live marker to its entity every frame. Inert with no worldCues[].
    const hook = (window as any).__GAME__;
    if (this.worldCues && hook) {
      if (!this._worldCueStarted && hook.ready) {
        this._worldCueStarted = true;
        this.worldCues.start(hook);
      }
      if (this._worldCueStarted) this.worldCues.update(hook);
    }
    // RE-ESTABLISHED-PLAY CLOCK GUARD (failModel:'time', generic). A sanctioned
    // setState precondition that re-establishes a PLAY scenario (places the
    // player / sets the score) clears a stale terminal status back to 'playing'
    // (hook.ts), but it does NOT re-seed timeRemaining — so a clock left at 0 by
    // a PRIOR lose-probe would make this fresh play GIVEN instantly re-lose. A
    // genuine timeout sets status:'lost' in the same frame (BaseLevelScene), so a
    // 'playing' level whose clock is already <= 0 can only be that bled-in dead
    // value: restore a live clock from the configured limit. This re-establishes
    // a legitimate playable GIVEN; it never fakes an outcome (a real low-time
    // lose setup uses a POSITIVE timeRemaining, which ticks down to the loss).
    this.guardReestablishedClock();
  }

  // ── the data-driven build (the abstract methods, all from DATA) ─────────────

  setupMapSize(): void {
    const b = this.levelData.bounds;
    this.mapWidth = b?.width ?? this.scale.width;
    this.mapHeight = b?.height ?? this.scale.height;
  }

  createBackground(): void {
    const slot = this.levelData.backgroundSlot;
    if (slot && this.textures.exists(slot)) {
      this.background = this.add
        .tileSprite(0, 0, this.mapWidth, this.mapHeight, slot)
        .setOrigin(0)
        .setScrollFactor(0)
        .setDepth(-100);
    }
    this.cameras.main.setBackgroundColor(this.levelData.backgroundColor ?? '#1a1a2e');
  }

  createTileMap(): void {
    // Build EVERY platform from layout.platforms[] (geometry as DATA). The blueprint
    // platform x/y is the CENTER; createPlatform takes a center too.
    this.groundLayer = this.physics.add.staticGroup();
    const platforms = this.levelData.platforms ?? [];
    // The shared default ground tile (a per-platform assetSlot overrides it).
    const ground = this.levelData.groundSlot;
    if (platforms.length === 0) {
      // graceful floor so the level still has ground if no platforms were declared
      this.createPlatform(this.mapWidth / 2, this.mapHeight - 24, this.mapWidth, 48, PLATFORM_COLOR, ground);
      return;
    }
    for (const p of platforms) {
      // Platform x/y is the TOP-LEFT corner (the blueprint/layout convention — its
      // feasibility math uses platform_end = x + width). createPlatform centers the
      // sprite, so convert top-left -> center here.
      const cx = p.x + p.width / 2;
      const cy = p.y + p.height / 2;
      // A real tile (per-platform slot, else the level ground tile) renders as a
      // seamless tileSprite; absent → the tinted placeholder rect (+ a floor warn).
      this.createPlatform(cx, cy, p.width, p.height, PLATFORM_COLOR, p.assetSlot ?? ground);
    }
  }

  createDecorations(): void {
    // Spawn every reward at its coordinate, tagged for __GAME__.entities + bound
    // behaviors instantiated from data (incl. "$custom:<id>"). NOTE: the player
    // does NOT exist yet — only placement here; overlap wiring is the custom[]
    // system's job (setupCustomCollisions, after the player exists).
    const rewards = this.levelData.rewards ?? [];
    for (const r of rewards) {
      this.spawnReward(r);
    }
    // The goal/exit (layout.goal). Spawned inert (no gravity); a custom[] system
    // owns its lock/unlock + the win overlap (it reads scene.goalSprite).
    this.spawnGoal();
  }

  /** Spawn the goal/exit sprite from layout.goal, tagged for __GAME__.entities. */
  private spawnGoal(): void {
    const g = this.levelData.goal;
    if (!g) return;
    const key = g.assetSlot && this.textures.exists(g.assetSlot) ? g.assetSlot : '__px';
    const sprite = this.physics.add.sprite(g.x, g.y, key) as Phaser.Physics.Arcade.Sprite & {
      __type?: string;
      __id?: string;
      locked?: boolean;
    };
    utils.fitDisplayContain(sprite, g.width ?? 60, g.height ?? 90);
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    body.setAllowGravity(false);
    body.setImmovable(true);
    sprite.__type = 'goal';
    sprite.__id = g.id;
    sprite.locked = true;
    this.decorations.add(sprite);
    this.goalSprite = sprite;
    // Attach the goal's bound behaviors (incl. a "$custom:<id>" attachedTo:<goal>
    // binding — e.g. a power-up / reach-to-win gate). The goal is a BARE sprite (no
    // update path), so it IS scene-ticked (default tick:true).
    this.attachBehaviors(sprite, g.behaviors);
  }

  createPlayer(): void {
    const spawn = this.levelData.playerSpawn;
    const pdata = this.levelData.player ?? {};
    const movement = this.extractMovementParams(pdata.behaviors);
    this.player = new DataPlayer(this, spawn.x, spawn.y, {
      textureKey: pdata.assetSlot,
      displayHeight: pdata.displayHeight,
      displayWidth: pdata.displayWidth,
      movement,
      animKeys: pdata.anim as any,
    });
    (this.player as any).__type = 'player';
    (this.player as any).__id = pdata.id ?? 'player';
    // Freeze the respawn point at the spawn coordinate (the time-model uses it).
    this._spawnPoint = { x: spawn.x, y: spawn.y };
    // Attach any NON-movement bound behaviors declared on the player (e.g. a
    // "$custom:<id>" attachedTo:player scorer) to the player's OWN manager. The
    // movement binding is consumed by the DataPlayer constructor above
    // (extractMovementParams) — exclude it to avoid a double-instantiation. tick:false
    // because the player self-ticks its behaviors (no scene re-registration).
    this.attachBehaviors(
      this.player,
      this.nonMovementBindings(pdata.behaviors, 'PlatformerMovement'),
      { tick: false },
    );
  }

  createEnemies(): void {
    // Threats split into TWO generic paths by shape (placement/tuning stays DATA):
    //   • CYCLIC HAZARD — a 'static_hazard' (or any threat carrying a CyclicHazard
    //     binding / cycle params) -> spawnThreat -> the engine spawnCyclicHazard
    //     seam (telegraphed timed hazard; overlap-during-ACTIVE -> non-terminal
    //     respawn + time penalty). _spawnedEnemyCount stays 0.
    //   • MOVING ENEMY — kind 'patrol'/'chaser' (or a threat whose behaviors[] bind
    //     a moving AI but NO CyclicHazard) -> spawnMovingEnemy -> a plain sprite in
    //     scene.enemies with its bound behaviors (PatrolAI/ChaseAI/ContactRespawn),
    //     so the SDK's ground collider + contact path apply. _spawnedEnemyCount
    //     stays 0 (a contact-fail enemy is not a kill-all goal — a separate
    //     ScoreGateGoal/GoalReach system owns the win), so the kill-all default
    //     never fires on an empty enemies group.
    const threats = this.levelData.threats ?? [];
    const penalty = this.levelData.hitTimePenalty ?? 0;
    for (const t of threats) {
      if (this.isMovingEnemy(t)) this.spawnMovingEnemy(t);
      else this.spawnThreat(t, penalty);
    }
  }

  /**
   * True iff a threat is a MOVING enemy (vs a cyclic/static hazard). A threat is
   * moving when its kind is 'patrol'/'chaser' OR it binds a moving-AI behavior
   * (PatrolAI/ChaseAI) WITHOUT a CyclicHazard binding. A 'static_hazard' (or any
   * CyclicHazard binding / cycle fields) stays on the hazard path. Generic — keys
   * off the shape, not a game.
   */
  private isMovingEnemy(t: ThreatData): boolean {
    if (this.firstBoundParams(t.behaviors, 'CyclicHazard')) return false;
    if (t.kind === 'patrol' || t.kind === 'chaser') return true;
    for (const b of t.behaviors ?? []) {
      const ref = typeof b === 'string' ? b : b?.ref;
      if (ref === 'PatrolAI' || ref === 'ChaseAI') return true;
    }
    return false;
  }

  /**
   * Spawn one MOVING enemy from data (KEEP — engine seam, generic). A plain arcade
   * sprite added to scene.enemies so the SDK's ground collider + setupContactDamage
   * overlap apply, with its bound behaviors[] (PatrolAI/ChaseAI/ContactRespawn)
   * attached + ticked via the same attachBehaviors path as a reward behavior. A
   * ChaseAI is given the player as its target. Contact consequence:
   *   • failModel respawn/lives: the threat carries NO `damage` (the SDK contact
   *     overlap is benign), and a bound ContactRespawn owns the respawn — never
   *     double-applied with the health-damage path.
   *   • failModel health: the threat carries `damage`, the SDK setupContactDamage
   *     applies it, and ContactRespawn is inert (it self-gates on the fail model).
   * Placement/tuning stays DATA — this method invents no coordinate.
   */
  private spawnMovingEnemy(t: ThreatData): void {
    const key = t.assetSlot && this.textures.exists(t.assetSlot) ? t.assetSlot : '__px';
    const sprite = this.physics.add.sprite(t.x, t.y, key) as Phaser.Physics.Arcade.Sprite & {
      __type?: string;
      __id?: string;
      __kind?: string;
      damage?: number;
      isDead?: boolean;
      behaviors?: BehaviorManager;
    };
    utils.fitDisplayContain(sprite, t.width ?? 40, t.height ?? 48);
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    if (t.hasGravity === false) {
      body.setAllowGravity(false);
    } else {
      body.setGravityY(1200);
      body.setMaxVelocityY(800);
    }
    sprite.setCollideWorldBounds(true);
    sprite.__type = 'enemy';
    sprite.__id = t.id;
    if (t.kind) sprite.__kind = t.kind;
    // Contact damage ONLY under the health model (avoids double-applying with
    // ContactRespawn, which self-gates to respawn/lives). Under respawn/lives the
    // damage is 0, so the SDK's setupContactDamage overlap is BENIGN — takeDamage(0)
    // subtracts no health (never NaN from an undefined) — and a bound ContactRespawn
    // owns the consequence. The knockback flash is harmless cosmetic.
    sprite.damage =
      (gameConfig as any)?.failModel === 'health' && typeof t.damage === 'number'
        ? t.damage
        : 0;
    this.enemies.add(sprite);

    // Attach the bound behaviors (PatrolAI/ChaseAI/ContactRespawn) + tick via the
    // single scene update() loop (attachBehaviors registers the owner).
    this.attachBehaviors(sprite, t.behaviors);
    // Point every target-taking bound behavior (ChaseAI) at the player.
    if (sprite.behaviors && this.player) {
      for (const b of sprite.behaviors.getAll() as any[]) {
        if (b && typeof b.setTarget === 'function') b.setTarget(this.player);
      }
    }
  }

  // ── post-create: wire custom[] systems' collisions + the effect bindings ────

  protected override setupCustomCollisions(): void {
    for (const sys of this.systems) {
      // reset() runs FIRST (before attach) so a restarted level (commands.reset(),
      // the verify per-GIVEN/completability probes) clears every run latch the
      // system held — a one-shot win latch, a per-entity "done" set — so the
      // level is genuinely replayable. Optional: a system that re-derives all
      // state from attach() may omit reset().
      sys.reset?.();
      sys.attach(this);
      sys.setupCollisions?.();
    }
  }

  /**
   * Resolve a surface entity id to its live {x,y} (the WorldCueDriver's entity
   * resolver). GENERIC — searches the standing entities: the player, the goal, a
   * reward by id, then any enemy by its __id. Returns undefined when no entity
   * matches (the cue marker hides until/unless it resolves). No game/theme.
   */
  private findEntityById(id: string): CueTarget | undefined {
    const p = this.player as any;
    if (p && (p.__id === id || id === 'player')) {
      return { x: p.x, y: p.y, active: p.active !== false };
    }
    const g = this.goalSprite as any;
    if (g && (g.__id === id || id === 'goal')) {
      return { x: g.x, y: g.y, active: g.active !== false };
    }
    const reward = this.rewardsById[id] as any;
    if (reward) return { x: reward.x, y: reward.y, active: reward.active !== false };
    let found: CueTarget | undefined;
    this.enemies?.children?.iterate((e: any) => {
      if (e && e.__id === id) {
        found = { x: e.x, y: e.y, active: e.active !== false };
        return false; // stop iterating
      }
      return true;
    });
    return found;
  }

  /**
   * Mark a reward CONSUMED (generic collection seam for ANY custom[] system /
   * behavior). Disables its overlap body, removes it from the interactable set
   * (the rewards map + the decorations group), and destroys the sprite — so a
   * driven/real traversal sees the pickup as a consumed interaction (the verify
   * win-path driver terminates on "target gone"), and the per-frame proximity
   * sweep and the physics overlap callback agree. Idempotent. No game/theme is
   * encoded — the caller decides WHICH reward is consumed and WHEN (on its real
   * collect event), per its contract.
   */
  public consumeReward(sprite: any): void {
    if (!sprite || sprite.__consumed) return;
    sprite.__consumed = true;
    const id = sprite.__id as string | undefined;
    // reward.collected — the standardized event at the real collect moment (every
    // collectathon funnels through this seam). Emitted BEFORE destroy so the
    // payload carries the reward's live id/position.
    this.eventBus.emit('reward.collected', {
      id,
      x: sprite.x ?? 0,
      y: sprite.y ?? 0,
    });
    if (id && this.rewardsById[id]) delete this.rewardsById[id];
    const body = sprite.body as Phaser.Physics.Arcade.Body | undefined;
    if (body) body.enable = false;
    this.boundBehaviorOwners = this.boundBehaviorOwners.filter((o) => o !== sprite);
    if (this.decorations) this.decorations.remove(sprite, false, false);
    sprite.destroy();
  }

  /** Re-seed a bled-in dead clock when a play scenario was re-established (see update()). */
  private guardReestablishedClock(): void {
    if (!this._timeModel) return;
    if (this.gameCompleted) return;
    if (this.registry.get('status') !== 'playing') return;
    if (this.timeRemaining === undefined || this.timeRemaining > 0) return;
    const limit = (gameConfig as any)?.playerConfig?.timeLimit?.value;
    this.timeRemaining = typeof limit === 'number' ? limit : 60;
  }

  // ── effects: fire a bound event->effect (blueprint.effects[]) ───────────────

  /**
   * Fire every effect bound to `event` (blueprint.effects[].on === event) at
   * (x,y). Cosmetic only — the loader never lets an effect read/write an observed
   * field. A custom[] system / behavior calls this on its real game event
   * (e.g. 'pipe.repaired'), so the juice stays bound to the design, not hard-wired.
   */
  public fireEffect(event: string, x?: number, y?: number): void {
    const px = typeof x === 'number' ? x : this.player?.x ?? 0;
    const py = typeof y === 'number' ? y : this.player?.y ?? 0;
    for (const e of this.effectBindings ?? []) {
      if (e.on !== event) continue;
      const invoke = resolveEffect(e.play);
      if (invoke) {
        try {
          invoke(this, px, py, e.params);
        } catch {
          /* an effect is cosmetic — never fail the level on it */
        }
      }
    }
  }

  // ── internals (generic instantiation from data) ─────────────────────────────

  /**
   * Construct this level's scene systems (KEEP — engine seam). TWO sources, the
   * SAME ISceneSystem lifecycle (reset -> attach -> setupCollisions -> update):
   *   1. REGISTERED systems — levelData.systems[] = {ref,params}, resolved by id
   *      against systems/registry.ts (the composable kind=system tier: CollectScore,
   *      ScoreGateGoal, GoalReach). Constructed WITH their per-game params.
   *   2. CUSTOM systems — the genuinely-novel delta W4 authored + registered under
   *      an id (custom-registry), resolved by customSystemIds().
   * Both end up in this.systems, so setupCustomCollisions()/update() run them
   * identically. GENERIC: the loader names no game — it resolves ids + DATA.
   */
  private constructSystems(): void {
    this.systems = [];
    if (!this.levelData) return;
    // (1) registered systems[] bindings — id -> a constructed ISceneSystem + params.
    for (const b of this.levelData.systems ?? []) {
      if (!b?.ref) continue;
      const sys = resolveSystem(b.ref, b.params);
      if (sys) this.systems.push(sys);
    }
    // (2) custom[] systems — the W4-authored novel delta, by id.
    for (const id of this.customSystemIds()) {
      const factory = resolveCustomSystem(id);
      if (factory) this.systems.push(factory());
    }
  }

  /**
   * Which custom system ids to construct. A subclass MAY override to pin a fixed
   * set; by default it constructs every custom system registered (the game
   * registered exactly the level's custom[] systems at boot).
   */
  protected customSystemIds(): string[] {
    return (this.levelData.player as any)?.__systems ?? this.defaultSystemIds;
  }
  /** Set by the subclass: the custom[] system ids for this level. */
  protected defaultSystemIds: string[] = [];

  /** Spawn one reward sprite + attach its bound behaviors. */
  private spawnReward(r: RewardData): void {
    const key = r.assetSlot && this.textures.exists(r.assetSlot) ? r.assetSlot : '__px';
    const sprite = this.physics.add.sprite(r.x, r.y, key) as Phaser.Physics.Arcade.Sprite & {
      __type?: string;
      __id?: string;
      __kind?: string;
      behaviors?: BehaviorManager;
    };
    utils.fitDisplayContain(sprite, r.width ?? 32, r.height ?? 32);
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    body.setAllowGravity(false);
    body.setImmovable(true);
    // Forgiving pickup radius (generic game-feel for ALL collectibles): a reward's
    // overlap body is at least PICKUP_BODY px so a player placed "at" the reward
    // (within a small margin — e.g. a milestone setup that drops the player a
    // forgiving distance above it) registers the touch on the FIRST physics step,
    // matching how collectibles read forgivingly. The visual sprite stays at its
    // display size; only the (centered) overlap body grows.
    const PICKUP_BODY = 110;
    const bw = Math.max(r.width ?? 32, PICKUP_BODY) / sprite.scaleX;
    const bh = Math.max(r.height ?? 32, PICKUP_BODY) / sprite.scaleY;
    body.setSize(bw, bh, true);
    sprite.__type = r.kind ?? r.role ?? 'collectible';
    sprite.__id = r.id;
    if (r.entityKind) sprite.__kind = r.entityKind;
    this.decorations.add(sprite);
    this.rewardsById[r.id] = sprite;

    // Attach bound behaviors (registry {ref,params} OR "$custom:<id>").
    this.attachBehaviors(sprite, r.behaviors);
  }

  /** Spawn one threat (a telegraphed cyclic hazard) via the engine seam. */
  private spawnThreat(t: ThreatData, penalty: number): void {
    // Pull the CyclicHazard params from explicit bindings or the threat's own
    // cycle fields (a layout 'static_hazard' carries cycleMs/activeMs/telegraphMs).
    const bound = this.firstBoundParams(t.behaviors, 'CyclicHazard');
    const cfg = {
      cycleMs: bound?.cycleMs ?? t.cycleMs ?? 2000,
      activeMs: bound?.activeMs ?? t.activeMs ?? 1000,
      telegraphMs: bound?.telegraphMs ?? t.telegraphMs ?? 400,
      shape: (bound?.shape ?? t.shape ?? 'column') as 'column' | 'bar',
      columnHeight: bound?.columnHeight ?? t.columnHeight,
      barWidth: bound?.barWidth ?? t.barWidth,
      phaseOffsetMs: bound?.phaseOffsetMs ?? t.phaseOffsetMs,
    };
    this.spawnCyclicHazard(t.x, t.y, cfg, {
      id: t.id,
      timePenaltySeconds: penalty,
      // Render the real hazard sprite when its slot resolves (else placeholder rect).
      assetSlot: t.assetSlot,
      onHit: () => {
        // non-terminal respawn + time penalty (engine), then fire the bound effect.
        this.respawnAtSpawn(penalty);
        this.fireEffect('player.respawn', this.player?.x, this.player?.y);
      },
    });
  }

  /** Attach a list of behavior bindings to an owner via a fresh BehaviorManager. */
  private attachBehaviors(
    owner: any,
    bindings?: BehaviorBinding[],
    opts?: { tick?: boolean },
  ): void {
    if (!bindings || bindings.length === 0) return;
    if (!owner.behaviors) owner.behaviors = new BehaviorManager(owner);
    bindings.forEach((b, i) => {
      const beh = this.instantiateBehavior(b);
      if (beh) owner.behaviors.add(`bound_${i}`, beh);
    });
    // Register the owner to be ticked from THIS scene's update() loop (a bare
    // reward sprite inherits a no-op `update()` the scene never calls, so a
    // "$custom:<id>" reward behavior would never run). Driving it from the single
    // update() loop — instead of a per-owner events.on(UPDATE) listener — avoids
    // leaking a listener on every scene RESTART; boundBehaviorOwners is cleared
    // at the top of create(). Pass `tick:false` for an owner that SELF-ticks its
    // behaviors (the player: BasePlayer.update → this.behaviors.update).
    if (opts?.tick !== false) this.boundBehaviorOwners.push(owner);
  }

  /** Instantiate one behavior binding: registry {ref,params} or "$custom:<id>". */
  private instantiateBehavior(b: BehaviorBinding): IBehavior | null {
    if (typeof b === 'string') {
      if (b.startsWith('$custom:')) {
        const id = b.slice('$custom:'.length);
        const f = resolveCustomBehavior(id);
        return f ? f({}) : null;
      }
      const Cls = resolveBehavior(b);
      return Cls ? new Cls({}) : null;
    }
    const ref = b.ref;
    if (ref?.startsWith('$custom:')) {
      const f = resolveCustomBehavior(ref.slice('$custom:'.length));
      return f ? f(b.params) : null;
    }
    const Cls = resolveBehavior(ref);
    return Cls ? new Cls(b.params ?? {}) : null;
  }

  /** Extract the PlatformerMovement {params} from a behavior-binding list. */
  private extractMovementParams(bindings?: BehaviorBinding[]): any {
    const p = this.firstBoundParams(bindings, 'PlatformerMovement');
    return p ?? {};
  }

  /**
   * The behavior bindings MINUS the movement ref. The player's movement is consumed
   * by the DataPlayer constructor (extractMovementParams), so re-attaching it would
   * double-instantiate it. Generic — keys off the ref, no game noun.
   */
  private nonMovementBindings(
    bindings: BehaviorBinding[] | undefined,
    movementRef: string,
  ): BehaviorBinding[] {
    return (bindings ?? []).filter((b) => {
      const ref = typeof b === 'string' ? b : b?.ref;
      return ref !== movementRef;
    });
  }

  /** Find the first binding for `ref` and return its params (or undefined). */
  private firstBoundParams(
    bindings: BehaviorBinding[] | undefined,
    ref: string,
  ): Record<string, any> | undefined {
    for (const b of bindings ?? []) {
      if (typeof b === 'object' && b.ref === ref) return b.params ?? {};
    }
    return undefined;
  }
}
