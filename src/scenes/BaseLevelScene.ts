import Phaser from 'phaser';
import { LevelManager } from '../LevelManager';
import * as utils from '../utils';
import { ScreenEffectHelper, CyclicHazard } from '../behaviors';
import type { CyclicHazardConfig } from '../behaviors';
import gameConfig from '../gameConfig.json';
import { EventBus, type ComponentSurface } from '@contract/component-surface';

/**
 * Player class registry for dynamic player creation (character select).
 */
export type PlayerClassMap = Record<
  string,
  new (scene: Phaser.Scene, x: number, y: number) => any
>;

/**
 * BaseLevelScene — Level Scene Base Class (Platformer)  (KEEP — engine)
 *
 * Foundation for all platformer level scenes. Template Method + Hooks.
 *
 * BOOTS EMPTY: unlike a tilemap-only base, this scene builds PROGRAMMATIC
 * platforms (a static physics group) so a level renders & is playable with
 * ZERO generated art (placeholder textures from the Preloader). A subclass may
 * still load a Tiled tilemap by overriding createTileMap() and setting
 * `this.groundLayer` to a TilemapLayer — collisions work with either.
 *
 * NET-NEW (game-omni): on the first interactive frame it latches the registry
 * `ready` flag and `status` = 'playing' (so window.__GAME__.ready flips true),
 * and sets `status` = 'won'/'lost' at the real win/lose points
 * (template-contract.md §3.3).
 *
 * ABSTRACT METHODS (subclass MUST implement):
 *   setupMapSize, createBackground, createTileMap, createDecorations,
 *   createPlayer, createEnemies
 *
 * HOOKS (subclass MAY override): onPreCreate, onPostCreate, onPreUpdate,
 *   onPostUpdate, onPlayerDeath, onLevelComplete, onEnemyKilled,
 *   setupCustomCollisions
 */
export abstract class BaseLevelScene extends Phaser.Scene {
  // ── scene state ─────────────────────────────────────────────────────────
  /** Flag to prevent multiple completion triggers. */
  public gameCompleted = false;
  /** Latched true after the first interactive frame (drives __GAME__.ready). */
  private _readyLatched = false;

  // ── event protocol (shared bus + log) ────────────────────────────────────
  /**
   * The shared, engine-agnostic event bus (the PUSH channel). Every standardized
   * gameplay event is emitted here at its real moment; the bus mirrors each emit
   * into a bounded, frame-tagged log that the 2D adapter (core/src/hook.ts) folds
   * onto window.__GAME__.events for guidance / verify to poll. Public so the score
   * seam (utils.setScore) + the reward-collect seam reach it via the scene.
   */
  public readonly eventBus = new EventBus();
  /** Cache of `status` last published as level.statusChanged (de-dupes per-frame). */
  private _lastStatus: string | undefined = undefined;
  /** Previous grounded read — drives player.jumped / player.landed transitions. */
  private _wasGrounded = true;

  // ── time-resource model (failModel:'time') — KEEP, engine seam ───────────
  // Owned here so EVERY platformer reuses it (no per-game timer code). Inert
  // unless gameConfig.failModel === 'time'. Read live by __GAME__.timeRemaining.
  /** Seconds left on the countdown; undefined when no timer runs this level. */
  public timeRemaining?: number;
  /** Whether the countdown is active (gameConfig.failModel === 'time'). */
  protected _timeModel = false;
  /** The respawn point a non-terminal respawn returns the player to. Defaults
   *  to the player's create-time position; a level may override it. */
  protected _spawnPoint: { x: number; y: number } | null = null;

  // ── map dimensions ──────────────────────────────────────────────────────
  public mapWidth = 0;
  public mapHeight = 0;
  public tileSize = 64;

  // ── core game objects ───────────────────────────────────────────────────
  /** Player — set in createPlayer(); read live by __GAME__.player. */
  public player: any;
  public enemies!: Phaser.GameObjects.Group;
  public enemyMeleeTriggers!: Phaser.GameObjects.Group;
  /** Collectibles / props — read by __GAME__.entities. */
  public decorations!: Phaser.GameObjects.Group;
  public playerBullets!: Phaser.GameObjects.Group;
  public enemyBullets!: Phaser.GameObjects.Group;
  /** Cyclic (telegraphed timed) hazards spawned via spawnCyclicHazard. */
  public hazards!: Phaser.GameObjects.Group;

  /**
   * Ground collision target. Either a static physics group of programmatic
   * platform sprites (default) OR a Tiled TilemapLayer (if a subclass loads
   * one). Both work with utils.addCollider.
   */
  public groundLayer!: Phaser.Physics.Arcade.StaticGroup | Phaser.Tilemaps.TilemapLayer;

  // ── input (scene-owned; entities consume this state) ────────────────────
  public wasdKeys!: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
  };
  public cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  public spaceKey!: Phaser.Input.Keyboard.Key;
  public shiftKey!: Phaser.Input.Keyboard.Key;
  public eKey!: Phaser.Input.Keyboard.Key;
  public qKey!: Phaser.Input.Keyboard.Key;

  // ── tilemap (optional; only if a subclass loads one) ────────────────────
  public map?: Phaser.Tilemaps.Tilemap;
  public groundTileset?: Phaser.Tilemaps.Tileset;

  // ── background ──────────────────────────────────────────────────────────
  public background?: Phaser.GameObjects.TileSprite;

  // ── audio ───────────────────────────────────────────────────────────────
  public backgroundMusic?: Phaser.Sound.BaseSound;

  constructor(config: string | Phaser.Types.Scenes.SettingsConfig) {
    super(config);
  }

  // ══════════════════════════════════════════════════════════════════════
  // TEMPLATE METHOD: CREATE
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Build all level elements (call from your create()).
   */
  createBaseElements(): void {
    this.gameCompleted = false;
    this._readyLatched = false;
    // status becomes 'playing' once ready latches; 'booting' until then.
    this.registry.set('status', 'playing');

    this.onPreCreate();

    // PHASE 1: environment
    this.setupMapSize();
    this.createBackground();
    this.createTileMap();

    // PHASE 2: groups
    this.initializeGroups();

    // PHASE 3: entities
    this.createDecorations();
    this.createPlayer();
    this.createEnemies();

    // PHASE 4: systems
    this.setupCamera();
    this.setupWorldBounds();
    this.setupInputs();

    // PHASE 5: collisions
    this.setupBaseCollisions();
    this.setupCustomCollisions();

    // PHASE 6: HUD
    this.scene.launch('UIScene', { gameSceneKey: this.scene.key });

    // PHASE 7: time-resource model (inert unless failModel:'time')
    this.setupTimeModel();

    this.onPostCreate();
  }

  /**
   * Initialize the failModel:'time' countdown (KEEP — engine seam). Inert
   * unless gameConfig.failModel === 'time'. Records the spawn point (for a
   * non-terminal respawn) and seeds timeRemaining from playerConfig.timeLimit.
   * A level may override _spawnPoint or timeLimit before/after as needed.
   */
  protected setupTimeModel(): void {
    const cfg = gameConfig as any;
    this._timeModel = cfg?.failModel === 'time';
    // Record the default respawn point at the player's create-time position.
    if (this.player && this._spawnPoint === null) {
      this._spawnPoint = { x: this.player.x, y: this.player.y };
    }
    if (!this._timeModel) return;
    const limit = cfg?.playerConfig?.timeLimit?.value;
    this.timeRemaining = typeof limit === 'number' ? limit : 60;
  }

  private initializeGroups(): void {
    this.decorations = this.add.group();
    this.enemies = this.add.group();
    this.enemyMeleeTriggers = this.add.group();
    this.playerBullets = this.add.group();
    this.enemyBullets = this.add.group();
    this.hazards = this.add.group();
  }

  /**
   * Build a static platform and add it to groundLayer. Returns the platform sprite.
   *
   * VISUAL: when `textureKey` resolves to a real loaded texture, the platform
   * surface is a SEAMLESS tileSprite of that texture repeated across width×height
   * (a real, purpose-made ground tile — never a flat colored box). Otherwise it
   * falls back to the '__px' placeholder stretched + tinted (the LAST-RESORT
   * floor), and warns ONCE so a hit on the rect floor is visible, never silent.
   *
   * PHYSICS BODY IS UNCHANGED by the visual path: the static collision body is
   * always a staticSprite at (x,y) sized width×height (refreshBody). The optional
   * tileSprite is a non-physics decoration pinned over that body, so collision is
   * identical whether or not a texture resolves. GENERIC: a texture KEY, no theme.
   *
   * If groundLayer is a TilemapLayer (subclass loaded a tilemap), this is a
   * no-op (use the tilemap instead).
   */
  createPlatform(
    x: number,
    y: number,
    width: number,
    height = 32,
    color = 0x6b8e23,
    textureKey?: string,
  ): Phaser.Physics.Arcade.Sprite | null {
    if (!(this.groundLayer instanceof Phaser.Physics.Arcade.StaticGroup)) {
      return null;
    }
    utils.ensurePlaceholderTexture(this, '__px', 8, 8, 'sprite');
    // The collision body: ALWAYS a static '__px' sprite sized to the box. This is
    // what physics resolves against — identical regardless of the visual below.
    const plat = this.physics.add.staticSprite(x, y, '__px');
    plat.setDisplaySize(width, height);
    plat.refreshBody();
    this.groundLayer.add(plat);

    if (textureKey && this.textures.exists(textureKey)) {
      // Real ground tile: a seamless tileSprite repeats the tile across the whole
      // platform footprint (no stretch, no seams), pinned over the invisible body.
      plat.setVisible(false);
      const tiled = this.add
        .tileSprite(x, y, width, height, textureKey)
        .setOrigin(0.5, 0.5)
        .setDepth(-1);
      // Hang the decoration off the body sprite so a TilemapLayer/restart cleans it.
      (plat as any).__tileVisual = tiled;
    } else {
      // LAST-RESORT floor: stretched + tinted placeholder rect. Make the floor hit
      // VISIBLE (dev log only — never an observed field).
      plat.setTint(color);
      utils.warnPlaceholderFloor('platform', '__px');
    }
    return plat;
  }

  /**
   * Spawn a telegraphed cyclic hazard (KEEP — engine seam for the CyclicHazard
   * capability). Creates an obstacle sprite at (x,y), attaches a CyclicHazard
   * behavior (dormant -> telegraph -> active -> dormant on a timer), registers
   * it for ticking + collection by __GAME__.entities, and wires the
   * overlap-during-ACTIVE -> player-hit path (a NON-TERMINAL respawn-at-spawn +
   * an optional time penalty for the failModel:'time' family). GENERIC: a level
   * passes the cycle/shape data (e.g. from a layout `static_hazard` threat) and
   * an optional onHit; no theme is baked in.
   *
   * @param x world x (px)
   * @param y world y (px)
   * @param config the CyclicHazard cycle params (cycleMs/activeMs/telegraphMs/shape/…)
   * @param opts.id stable entity id (for __GAME__.entities / a test `force`)
   * @param opts.timePenaltySeconds time subtracted on a hit (time fail-model)
   * @param opts.onHit override the hit reaction (defaults to respawnAtSpawn)
   * @param opts.assetSlot real hazard texture KEY; when it resolves the hazard
   *        renders as that sprite (a real, purpose-made hazard), else the '__px'
   *        placeholder rect + a one-time floor warning. The BODY size/region is
   *        unchanged either way (column = tall, bar = wide).
   * @returns the hazard sprite (its `.cyclic` is the behavior; `.__type='obstacle'`)
   */
  spawnCyclicHazard(
    x: number,
    y: number,
    config: CyclicHazardConfig,
    opts: {
      id?: string;
      timePenaltySeconds?: number;
      onHit?: () => void;
      assetSlot?: string;
    } = {},
  ): Phaser.Physics.Arcade.Sprite {
    utils.ensurePlaceholderTexture(this, '__px', 8, 8, 'sprite');
    // Real hazard texture when the slot resolves; else the placeholder rect (+warn).
    const useReal = !!opts.assetSlot && this.textures.exists(opts.assetSlot);
    const key = useReal ? (opts.assetSlot as string) : '__px';
    if (!useReal) utils.warnPlaceholderFloor('hazard', opts.id ?? '__px');
    const sprite = this.physics.add.sprite(x, y, key) as Phaser.Physics.Arcade.Sprite & {
      cyclic?: CyclicHazard;
      __type?: string;
      __id?: string;
    };
    // Size the body to the hazard region (column = tall, bar = wide).
    const w = config.shape === 'bar' ? (config.barWidth ?? 90) : 24;
    const h = config.shape === 'column' ? (config.columnHeight ?? 120) : 24;
    sprite.setDisplaySize(w, h);
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    body.setAllowGravity(false);
    body.setImmovable(true);
    body.setSize(w, h);
    sprite.__type = 'obstacle';
    if (opts.id) sprite.__id = opts.id;

    const behavior = new CyclicHazard(config);
    behavior.attach(sprite);
    sprite.cyclic = behavior;
    this.hazards.add(sprite);

    // Overlap-during-ACTIVE -> the player-hit path. Guarded so one ACTIVE window
    // costs at most one hit (re-arms when the hazard leaves ACTIVE).
    let armed = true;
    utils.addOverlap(this, this.player, sprite, () => {
      if (!behavior.isActive()) return;
      if (!armed) return;
      armed = false;
      if (opts.onHit) opts.onHit();
      else this.respawnAtSpawn(opts.timePenaltySeconds ?? 0);
    });
    // Re-arm when the hazard is no longer deadly (checked in updateHazards).
    (sprite as any).__rearm = () => {
      if (!behavior.isActive()) armed = true;
    };

    return sprite;
  }

  private updateHazards(): void {
    this.hazards.children.iterate((h: any) => {
      h?.cyclic?.update?.();
      // hazard.activated — emit once on the dormant→ACTIVE (deadly) edge. `__wasActive`
      // is the prior-frame active read tracked on the sprite (no new scene state).
      const active = !!h?.cyclic?.isActive?.();
      if (active && !h.__wasActive) {
        this.eventBus.emit('hazard.activated', { id: h?.__id, x: h?.x ?? 0, y: h?.y ?? 0 });
      }
      h.__wasActive = active;
      h?.__rearm?.();
      return true;
    });
  }

  private setupCamera(): void {
    this.cameras.main.setBounds(0, 0, this.mapWidth, this.mapHeight);
    if (this.player) {
      this.cameras.main.startFollow(this.player);
      this.cameras.main.setFollowOffset(0, -128);
      this.cameras.main.setLerp(0.1, 0.1);
    }
  }

  private setupWorldBounds(): void {
    // No bottom bound — falling off the map is a death (checkPlayerFall).
    this.physics.world.setBounds(
      0,
      0,
      this.mapWidth,
      this.mapHeight,
      true,
      true,
      true,
      false,
    );
    if (this.player?.setCollideWorldBounds) {
      this.player.setCollideWorldBounds(true);
    }
    this.enemies.children.iterate((enemy: any) => {
      enemy?.setCollideWorldBounds?.(true);
      return true;
    });
  }

  /**
   * Setup input. Scene-OWNS input; entities read this state, never attach
   * their own listeners. Arrow keys AND WASD both drive movement so W5's
   * 'ArrowUp'/'ArrowLeft' inputs and a player's WASD both work.
   */
  setupInputs(): void {
    const kb = this.input.keyboard!;
    this.cursors = kb.createCursorKeys();
    this.wasdKeys = {
      W: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    this.spaceKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.shiftKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
    this.eKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    this.qKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.Q);
  }

  // ── collisions ───────────────────────────────────────────────────────────

  setupBaseCollisions(): void {
    this.setupGroundCollisions();
    this.setupContactDamage();
    this.setupMeleeCollisions();
    this.setupBulletCollisions();
  }

  private setupGroundCollisions(): void {
    if (!this.groundLayer) return;
    if (this.player) utils.addCollider(this, this.player, this.groundLayer);
    utils.addCollider(this, this.enemies, this.groundLayer);
  }

  private setupContactDamage(): void {
    if (!this.player) return;
    utils.addOverlap(this, this.player, this.enemies, (player: any, enemy: any) => {
      if (player.isInvulnerable || player.isHurting || player.isDead) return;
      if (enemy.isDead) return;
      const direction = player.x < enemy.x ? -1 : 1;
      player.setVelocityX?.(200 * direction);
      player.setVelocityY?.(-150);
      player.takeDamage?.(enemy.damage);
      this.showDamageNumber(player.x, player.y, enemy.damage, '#ff4444');
      this.cameras.main.flash(120, 255, 80, 80);
    });
  }

  private setupMeleeCollisions(): void {
    if (!this.player) return;
    const playerMeleeTrigger =
      this.player.meleeTrigger || this.player.melee?.meleeTrigger;
    if (playerMeleeTrigger) {
      utils.addOverlap(this, playerMeleeTrigger, this.enemies, (_t: any, enemy: any) => {
        if (!this.player.isAttacking) return;
        const targets =
          this.player.currentMeleeTargets || this.player.melee?.currentTargets;
        if (targets?.has(enemy)) return;
        if (enemy.isHurting || enemy.isDead) return;
        targets?.add(enemy);
        const direction = enemy.x > this.player.x ? 1 : -1;
        enemy.setVelocityX?.(150 * direction);
        const damage = this.player.attackDamage || this.player.melee?.damage;
        enemy.takeDamage?.(damage);
        this.showDamageNumber(enemy.x, enemy.y, damage, '#ffdd44');
        this.hitStop(60);
        ScreenEffectHelper.shakeLight(this);
        if (enemy.isDead) this.onEnemyKilled(enemy);
      });
    }

    utils.addOverlap(this, this.enemyMeleeTriggers, this.player, (trigger: any, player: any) => {
      const enemy = trigger.owner;
      if (!enemy?.isAttacking) return;
      const targets = enemy.currentMeleeTargets || enemy.melee?.currentTargets;
      if (targets?.has(player)) return;
      if (player.isInvulnerable || player.isHurting || player.isDead) return;
      targets?.add(player);
      const direction = player.x > enemy.x ? 1 : -1;
      player.setVelocityX?.(300 * direction);
      player.setVelocityY?.(-200);
      player.takeDamage?.(enemy.damage);
      this.showDamageNumber(player.x, player.y, enemy.damage, '#ff4444');
    });
  }

  private setupBulletCollisions(): void {
    utils.addOverlap(this, this.playerBullets, this.enemies, (bullet: any, enemy: any) => {
      if (enemy.isDead || enemy.isHurting) return;
      const direction = bullet.body?.velocity?.x > 0 ? 1 : -1;
      enemy.setVelocityX?.(200 * direction);
      const damage = bullet.damage ?? this.player?.attackDamage ?? 10;
      enemy.takeDamage?.(damage);
      this.showDamageNumber(enemy.x, enemy.y, damage, '#ffdd44');
      this.destroyBullet(bullet);
      if (enemy.isDead) this.onEnemyKilled(enemy);
    });

    if (this.groundLayer) {
      utils.addCollider(this, this.playerBullets, this.groundLayer, (bullet: any) =>
        this.destroyBullet(bullet),
      );
      utils.addCollider(this, this.enemyBullets, this.groundLayer, (bullet: any) =>
        this.destroyBullet(bullet),
      );
    }

    if (this.player) {
      utils.addOverlap(this, this.player, this.enemyBullets, (player: any, bullet: any) => {
        if (player.isInvulnerable || player.isHurting || player.isDead) return;
        const direction =
          (bullet as any).direction ?? (bullet.body?.velocity?.x > 0 ? 1 : -1);
        player.setVelocityX?.(150 * direction);
        player.takeDamage?.(bullet.damage ?? 15);
        this.showDamageNumber(player.x, player.y, bullet.damage ?? 15, '#ff4444');
        this.destroyBullet(bullet);
      });
    }
  }

  private destroyBullet(bullet: any): void {
    if (typeof bullet.hit === 'function') bullet.hit();
    else bullet.destroy();
  }

  // ══════════════════════════════════════════════════════════════════════
  // TEMPLATE METHOD: UPDATE
  // ══════════════════════════════════════════════════════════════════════

  baseUpdate(): void {
    // Stamp the current frame on the bus so every event logged this tick carries
    // a real frame number (the log's external consumers read it for ordering).
    this.eventBus.setFrame(this.game.loop.frame);

    // Latch ready on the first interactive frame (drives __GAME__.ready).
    this.markReady();
    // Publish a level.statusChanged if the normalized status moved (won/lost/
    // playing) outside the per-handler seams (e.g. the time-out lose path).
    this.publishStatus();

    if (!this.player || !this.player.active) {
      this.onPreUpdate();
      this.onPostUpdate();
      return;
    }

    this.onPreUpdate();

    // player.jumped / player.landed — a pure read over isGrounded() (no new
    // player state). The leave-ground transition with an upward velocity is a
    // jump; the return-to-ground transition is a land.
    this.publishLocomotion();

    try {
      this.player.update?.(
        this.wasdKeys,
        this.spaceKey,
        this.shiftKey,
        this.eKey,
        this.qKey,
        this.cursors,
      );
    } catch (error) {
      console.error('Error updating player:', error);
    }

    this.updateEnemies();
    this.updateBullets();
    this.updateHazards();
    this.checkWinCondition();
    this.updateParallax();
    this.checkPlayerFall();
    this.updateTimeModel();

    this.onPostUpdate();
  }

  /**
   * Tick the failModel:'time' countdown (KEEP — engine seam). Subtracts the
   * real elapsed frame time from timeRemaining; at <= 0 it sets the normalized
   * status to 'lost' (the time-resource lose seam), once. No-op unless the
   * countdown is active and the level hasn't already ended.
   */
  protected updateTimeModel(): void {
    if (!this._timeModel || this.timeRemaining === undefined) return;
    if (this.gameCompleted) return;
    if (this.registry.get('status') === 'lost') return;
    // game.loop.delta is ms since the last frame; convert to seconds.
    this.timeRemaining = Math.max(0, this.timeRemaining - this.game.loop.delta / 1000);
    if (this.timeRemaining <= 0) {
      this.timeRemaining = 0;
      this.registry.set('status', 'lost');
    }
  }

  /**
   * Latch the registry `ready` flag once (first interactive frame).
   * window.__GAME__.ready reads registry.get('ready').
   */
  protected markReady(): void {
    if (this._readyLatched) return;
    this._readyLatched = true;
    this.registry.set('ready', true);
    // keep status 'playing' unless a win/lose flag already fired
    const s = this.registry.get('status');
    if (s !== 'won' && s !== 'lost') this.registry.set('status', 'playing');
  }

  private updateEnemies(): void {
    this.enemies.children.iterate((enemy: any) => {
      if (enemy?.active && enemy.update) {
        try {
          enemy.update();
        } catch (error) {
          console.error('Error updating enemy:', error);
        }
      }
      return true;
    });
  }

  private updateBullets(): void {
    this.enemyBullets.children.iterate((b: any) => {
      if (b?.active && b.update) b.update();
      return true;
    });
    this.playerBullets.children.iterate((b: any) => {
      if (b?.active && b.update) b.update();
      return true;
    });
  }

  private updateParallax(): void {
    if (this.background) {
      this.background.tilePositionX = this.cameras.main.scrollX * 0.2;
    }
  }

  private checkPlayerFall(): void {
    if (this.player.y > this.mapHeight + 100 && !this.player.isDead) {
      this.player.health = 0;
      this.player.isDead = true;
      this.onPlayerDeath();
    }
  }

  /**
   * Default win condition: all enemies defeated. A subclass with a goal/exit
   * sets gameCompleted=true and calls onLevelComplete() directly instead.
   * NOTE: if a level has zero enemies, this would fire immediately — so the
   * default only triggers when the level HAD at least one enemy.
   */
  checkWinCondition(): void {
    if (this.gameCompleted) return;
    if (this._spawnedEnemyCount === 0) return; // no kill-all goal in this level
    const alive = this.enemies.children.entries.filter(
      (e: any) => e.active && !e.isDead,
    ).length;
    if (alive === 0) {
      this.gameCompleted = true;
      this.onLevelComplete();
    }
  }

  /** Count of enemies spawned this level (gates the kill-all win condition). */
  protected _spawnedEnemyCount = 0;

  // ── hooks ────────────────────────────────────────────────────────────────

  protected onPreCreate(): void {}
  protected onPostCreate(): void {}
  protected onPreUpdate(): void {}
  protected onPostUpdate(): void {}

  /**
   * Called when the player dies. Sets registry `status` = 'lost' (the
   * normalized win/lose seam) then shows the game-over screen.
   */
  protected onPlayerDeath(): void {
    this.registry.set('status', 'lost');
    // The standardized death + status events at the real death moment.
    this.eventBus.emit('player.died', {
      x: this.player?.x ?? 0,
      y: this.player?.y ?? 0,
    });
    this.publishStatus();
    this.scene.launch('GameOverUIScene', { currentLevelKey: this.scene.key });
  }

  /**
   * Called when the level is completed. Sets registry `status` = 'won' (the
   * normalized win/lose seam) then shows the victory / game-complete screen
   * after a short delay.
   */
  protected onLevelComplete(): void {
    this.registry.set('status', 'won');
    // The standardized win-status event at the real completion moment.
    this.publishStatus();
    ScreenEffectHelper.shakeMedium(this);
    this.time.delayedCall(500, () => {
      if (LevelManager.isLastLevel(this.scene.key)) {
        this.scene.launch('GameCompleteUIScene', {
          currentLevelKey: this.scene.key,
        });
      } else {
        this.scene.launch('VictoryUIScene', { currentLevelKey: this.scene.key });
      }
    });
  }

  /** Called when an enemy is killed. Override for scoring / drops. */
  protected onEnemyKilled(enemy: any): void {
    // The standardized enemy-death event at the real kill moment. Emitted from
    // the base seam (the SDK calls onEnemyKilled at the point an enemy dies), so
    // a subclass override still fires it by calling super.onEnemyKilled(enemy).
    this.eventBus.emit('enemy.died', {
      id: enemy?.__id,
      x: enemy?.x ?? 0,
      y: enemy?.y ?? 0,
    });
  }

  /** Override to add player-decoration / trigger collisions (player exists). */
  protected setupCustomCollisions(): void {}

  // ── event-protocol publish seams (generic; emit on the shared bus) ─────────

  /**
   * Publish `level.statusChanged` whenever the NORMALIZED registry status moves
   * (booting→playing→won/lost). De-duped against the last published value so it
   * fires exactly once per real transition (called from markReady, the win/lose
   * hooks, the time-out path, and once per tick to catch any status set
   * elsewhere — e.g. a system flipping 'won' directly).
   */
  protected publishStatus(): void {
    const s = this.registry.get('status');
    const status = s === 'won' || s === 'lost' || s === 'playing' ? s : undefined;
    if (status === undefined || status === this._lastStatus) return;
    this._lastStatus = status;
    this.eventBus.emit('level.statusChanged', { status });
  }

  /**
   * Publish `player.jumped` / `player.landed` from the grounded transition. A
   * pure read over the player's isGrounded() — leaving the ground with an upward
   * velocity is a jump; returning to the ground is a land. No new player state.
   */
  private publishLocomotion(): void {
    const grounded =
      typeof this.player?.isGrounded === 'function'
        ? !!this.player.isGrounded()
        : true;
    if (grounded !== this._wasGrounded) {
      const x = this.player?.x ?? 0;
      const y = this.player?.y ?? 0;
      if (!grounded) {
        const vy = this.player?.body?.velocity?.y ?? 0;
        if (vy < 0) this.eventBus.emit('player.jumped', { x, y });
      } else {
        this.eventBus.emit('player.landed', { x, y });
      }
      this._wasGrounded = grounded;
    }
  }

  /**
   * NON-TERMINAL respawn-at-spawn that KEEPS CONTROL (KEEP — engine seam for
   * the failModel:'time' family + any respawn-not-death design).
   *
   * Returns the player to _spawnPoint and — crucially — RETURNS CONTROL: it
   * resets every stateful layer a death funnel may have latched (hurt/dead
   * flags, body velocity, and the player FSM if one exists), so the documented
   * controls drive the player again immediately. status stays 'playing' (this
   * is NOT a game-over). Optionally subtracts a time penalty from the countdown
   * (the time-resource cost of a hit / fall). Reuses the respawn-returns-control
   * rule (implement-milestone/SKILL.md §3.5) so it can never leave a frozen
   * player. Idempotent-safe to call from any hazard-hit / fall-out path.
   *
   * @param timePenaltySeconds seconds to subtract from timeRemaining (default 0).
   */
  public respawnAtSpawn(timePenaltySeconds = 0): void {
    const player = this.player as any;
    if (!player) return;
    const sp = this._spawnPoint ?? { x: player.x, y: player.y };

    // 1) relocate the BODY with body.reset (setPosition desyncs the body).
    const body = player.body as Phaser.Physics.Arcade.Body | undefined;
    if (body && typeof body.reset === 'function') body.reset(sp.x, sp.y);
    else player.setPosition?.(sp.x, sp.y);
    player.setVelocity?.(0, 0);

    // 2) clear every death/hurt latch the funnel may have set.
    player.isDead = false;
    player.isHurting = false;
    player.isInvulnerable = false;
    if (typeof player.health === 'number' && typeof player.maxHealth === 'number') {
      player.health = player.maxHealth;
    }

    // 3) return the player FSM to its live base state (never park in 'dying').
    const fsm = player.fsm ?? player.stateMachine;
    if (fsm && typeof fsm.returnToBaseState === 'function') {
      fsm.returnToBaseState();
    } else if (fsm && typeof fsm.transition === 'function') {
      try { fsm.transition('idle'); } catch { /* ignore */ }
    }

    // 4) the fail resource is TIME — subtract the penalty, never flip to 'lost'
    //    here (only the countdown reaching 0 loses).
    if (this._timeModel && this.timeRemaining !== undefined && timePenaltySeconds > 0) {
      this.timeRemaining = Math.max(0, this.timeRemaining - timePenaltySeconds);
    }

    // 5) it stays a live game: keep status 'playing' (NOT a game-over).
    if (this.registry.get('status') !== 'won') {
      this.registry.set('status', 'playing');
    }

    // 6) bump the monotone recoverable-reset counter (registry key 'respawnCount',
    //    read by __GAME__.respawnCount). This is the observable a "first bite /
    //    nth respawn" guidance cue binds to via on-first while status stays
    //    'playing' (Contract 4 soft-state counter; closes septest gap G-S1). A
    //    GENERIC engine seam — every recoverable reset funnels through here.
    const prior = this.registry.get('respawnCount');
    this.registry.set('respawnCount', (typeof prior === 'number' ? prior : 0) + 1);

    // player.respawned — the standardized recoverable-reset event (every
    // non-terminal respawn funnels through here). status stays 'playing'.
    this.eventBus.emit('player.respawned', { x: sp.x, y: sp.y });
  }

  // ══════════════════════════════════════════════════════════════════════
  // JUICE  (ships wired-but-inert; W4 fires it on the right events)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Hit-stop: briefly pause physics for impact weight (W4's requested helper).
   * Scoped & self-resuming; clamped to a safe range (≤200ms).
   * @param ms pause duration in milliseconds (default 60).
   */
  hitStop(ms = 60): void {
    const clamped = Phaser.Math.Clamp(ms, 0, 200);
    if (clamped <= 0) return;
    this.physics.world.pause();
    this.time.delayedCall(clamped, () => this.physics.world.resume());
  }

  /**
   * Floating damage number that drifts up and fades (ships from the base).
   */
  showDamageNumber(
    x: number,
    y: number,
    damage: number,
    color = '#ffffff',
    fontSize = 18,
    duration = 600,
  ): void {
    const text = this.add
      .text(x, y - 20, `${Math.round(damage)}`, {
        fontFamily: 'monospace',
        fontSize: `${fontSize}px`,
        color,
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(1000);
    this.tweens.add({
      targets: text,
      y: y - 20 - fontSize * 2.5,
      alpha: 0,
      duration,
      ease: 'Power1',
      onComplete: () => text.destroy(),
    });
  }

  // ── dynamic player creation (character select integration) ──────────────

  protected getPlayerClasses(): PlayerClassMap {
    return {};
  }

  protected createPlayerByType(
    x: number,
    y: number,
    defaultClass: new (scene: Phaser.Scene, x: number, y: number) => any,
  ): any {
    const selected = this.registry.get('selectedCharacter') as
      | string
      | undefined;
    const classes = this.getPlayerClasses();
    const PlayerClass =
      selected && classes[selected] ? classes[selected] : defaultClass;
    return new PlayerClass(this, x, y);
  }

  // ── component surface (the declared event set this scene publishes) ───────

  /**
   * The uniform component surface for the platformer scene base. Declares every
   * event this engine emits on the shared bus (the CLAIM the catalog/gates read).
   * Observables stay on the existing __GAME__ adapter (core/src/hook.ts), so this
   * surface declares only the PUSH channel + no anchors. Each EventDecl is a TRUE
   * statement about a real emit site above:
   *   - score.changed       ← utils.setScore (the score seam)            [core]
   *   - player.died          ← onPlayerDeath                              [core]
   *   - level.statusChanged  ← publishStatus (markReady/win/lose/timeout) [core]
   *   - enemy.died           ← onEnemyKilled                              [base:2d]
   *   - reward.collected     ← consumeReward (the collect seam)           [base:2d]
   *   - player.jumped/landed ← publishLocomotion (grounded transition)    [archetype]
   *   - player.respawned     ← respawnAtSpawn                             [archetype]
   *   - hazard.activated     ← updateHazards (dormant→ACTIVE edge)        [archetype]
   */
  surface(): ComponentSurface {
    return {
      observables: {},
      anchors: [],
      events: [
        {
          name: 'score.changed',
          payload: '{score}',
          scope: 'core',
          drivenBy: 'collect/score',
          expect: '__GAME__.score changes; score.changed logged',
        },
        {
          name: 'player.died',
          payload: '{x,y}',
          scope: 'core',
          drivenBy: 'death (fall/hazard/health)',
          expect: "status becomes 'lost'; player.died logged",
        },
        {
          name: 'level.statusChanged',
          payload: "{status:'playing'|'won'|'lost'}",
          scope: 'core',
          drivenBy: 'ready/win/lose/timeout',
          expect: '__GAME__.status matches; level.statusChanged logged',
        },
        {
          name: 'enemy.died',
          payload: '{id,x,y}',
          scope: 'base:2d',
          drivenBy: 'enemy hp reaches 0 (melee/bullet)',
          expect: 'enemy leaves __GAME__.entities; enemy.died logged',
        },
        {
          name: 'reward.collected',
          payload: '{id,x,y}',
          scope: 'base:2d',
          drivenBy: 'player↔reward overlap (consumeReward)',
          expect: 'reward leaves __GAME__.entities; reward.collected logged',
        },
        {
          name: 'player.jumped',
          payload: '{x,y}',
          scope: 'archetype',
          drivenBy: 'leave ground with upward velocity',
          expect: 'player.jumped logged',
        },
        {
          name: 'player.landed',
          payload: '{x,y}',
          scope: 'archetype',
          drivenBy: 'return to ground',
          expect: 'player.landed logged',
        },
        {
          name: 'player.respawned',
          payload: '{x,y}',
          scope: 'archetype',
          drivenBy: 'non-terminal respawn (hazard/fall, failModel:time)',
          expect: '__GAME__.respawnCount increases; player.respawned logged',
        },
        {
          name: 'hazard.activated',
          payload: '{id,x,y}',
          scope: 'archetype',
          drivenBy: 'cyclic hazard enters its ACTIVE (deadly) window',
          expect: 'hazard.activated logged',
        },
      ],
    };
  }

  // ── abstract methods (subclass MUST implement) ──────────────────────────

  /** Set this.mapWidth / this.mapHeight. */
  abstract setupMapSize(): void;
  /** Create the background (TileSprite for parallax, or nothing). */
  abstract createBackground(): void;
  /** Build ground collision. Default: programmatic platforms in a StaticGroup. */
  abstract createTileMap(): void;
  /** Create decorations/collectibles. WARNING: player does not exist yet. */
  abstract createDecorations(): void;
  /** Create the player. Must set this.player. */
  abstract createPlayer(): void;
  /** Create enemies. Add them to this.enemies; bump _spawnedEnemyCount. */
  abstract createEnemies(): void;
}
