import Phaser from 'phaser';
import * as utils from '../utils';
import {
  BehaviorManager,
  PlatformerMovement,
  MeleeAttack,
  RangedAttack,
  SkillBehavior,
} from '../behaviors';
import { PlayerFSM, type PlayerAnimKeys } from './PlayerFSM';
import type { ComponentSurface, EventBus } from '@contract/component-surface';

/**
 * Player configuration interface.
 */
export interface PlayerConfig {
  /** Texture key for the initial frame (a placeholder key works pre-art). */
  textureKey: string;
  /**
   * Logical display WIDTH in px (optional). When present the sprite is fit to
   * its logical BOX on both axes (width pinned to the spec, independent of the
   * texture's intrinsic aspect ratio); absent → height-only fit (prior behavior).
   */
  displayWidth?: number;
  /** Display height in pixels (default 128). */
  displayHeight?: number;
  bodyWidthFactor?: number;
  bodyHeightFactor?: number;
  stats: {
    maxHealth: number;
    walkSpeed: number;
    jumpPower: number;
    attackDamage: number;
    hurtingDuration?: number;
    invulnerableTime?: number;
    gravityY?: number;
  };
  movement?: {
    airControl?: number;
    coyoteTime?: number;
    jumpBufferTime?: number;
    doubleJumpEnabled?: boolean;
    doubleJumpPower?: number;
  };
  combat?: {
    meleeRange?: number;
    meleeWidth?: number;
    rangedKey?: string;
    rangedSpeed?: number;
    rangedCooldown?: number;
  };
  /** Animation keys; missing/undefined keys degrade gracefully (no art). */
  animKeys?: PlayerAnimKeys;
  /** Visual offset Y to sink the sprite into the ground (default 0). */
  verticalVisualOffset?: number;
}

/**
 * BasePlayer — Foundation class for platformer player characters  (KEEP — engine)
 *
 * Composes movement + melee (+ optional ranged/ultimate) via BehaviorManager
 * and a PlayerFSM. Exposes the live primitive fields window.__GAME__.player
 * reads (x/y via the sprite, vx/vy via body.velocity, health, maxHealth,
 * facingDirection, isDead, isGrounded()).
 *
 * RENDERS WITHOUT ART: playAnimation() no-ops if the animation key is absent,
 * so movement physics work with placeholder textures (the empty template).
 *
 * HOOKS (override in subclass): initBehaviors, initUltimate, onUpdate,
 *   onDamageTaken, onDeath, onHealthChanged, onUltimateUsed.
 */
export abstract class BasePlayer extends Phaser.Physics.Arcade.Sprite {
  declare body: Phaser.Physics.Arcade.Body;

  // ── behaviors ─────────────────────────────────────────────────────────────
  public behaviors: BehaviorManager;
  public movement!: PlatformerMovement;
  public melee!: MeleeAttack;
  public ranged?: RangedAttack;
  public ultimate?: SkillBehavior;

  // ── state machine ─────────────────────────────────────────────────────────
  public fsm: PlayerFSM;

  // ── attributes (observed by the hook) ──────────────────────────────────────
  public facingDirection: 'left' | 'right' = 'right';
  public attackDamage: number;
  public walkSpeed: number;
  public jumpPower: number;
  public verticalVisualOffset: number;

  // ── state flags ─────────────────────────────────────────────────────────────
  public isDead = false;
  public isHurting = false;
  public isAttacking = false;
  public isInvulnerable = false;
  public isUsingUltimate = false;
  public hurtingDuration: number;
  public invulnerableTime: number;
  public hurtingTimer?: Phaser.Time.TimerEvent;

  // ── health ─────────────────────────────────────────────────────────────────
  public maxHealth: number;
  public health: number;

  // ── attack ──────────────────────────────────────────────────────────────────
  public get meleeTrigger(): Phaser.GameObjects.Zone {
    return this.melee.meleeTrigger;
  }
  public get currentMeleeTargets(): Set<any> {
    return this.melee.currentTargets;
  }
  public meleeComboCount = 0;

  // ── input refs (scene injects these via update()) ──────────────────────────
  public wasdKeys?: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
  };
  public cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  public spaceKey?: Phaser.Input.Keyboard.Key;
  public shiftKey?: Phaser.Input.Keyboard.Key;
  public eKey?: Phaser.Input.Keyboard.Key;
  public qKey?: Phaser.Input.Keyboard.Key;

  // ── audio ───────────────────────────────────────────────────────────────────
  public jumpSound?: Phaser.Sound.BaseSound;
  public attackSound?: Phaser.Sound.BaseSound;
  public hurtSound?: Phaser.Sound.BaseSound;
  public shootSound?: Phaser.Sound.BaseSound;
  public ultimateSound?: Phaser.Sound.BaseSound;

  /** The shared event bus, resolved from the scene. Publish moments via
   *  `this.bus?.emit('<name>', payload)` — the ONE canonical vocabulary. */
  protected get bus(): EventBus | undefined {
    return (this.scene as any)?.eventBus;
  }

  constructor(scene: Phaser.Scene, x: number, y: number, config: PlayerConfig) {
    super(scene, x, y, config.textureKey);

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.maxHealth = config.stats.maxHealth;
    this.health = this.maxHealth;
    this.attackDamage = config.stats.attackDamage;
    this.walkSpeed = config.stats.walkSpeed;
    this.jumpPower = config.stats.jumpPower;
    this.hurtingDuration = config.stats.hurtingDuration ?? 100;
    this.invulnerableTime = config.stats.invulnerableTime ?? 1000;
    this.verticalVisualOffset = config.verticalVisualOffset ?? 0;

    const gravityY = config.stats.gravityY ?? 1200;
    this.body.setGravityY(gravityY);
    this.body.setMaxVelocityY(800);

    utils.initScale(
      this,
      { x: 0.5, y: 1.0 },
      // maxDisplayWidth: the frozen logical width when the spec declares it, so
      // the player is fit to its logical BOX on both axes (resolution-independent);
      // undefined → initScale fits by height alone (the prior height-only behavior).
      config.displayWidth,
      config.displayHeight ?? 128,
      config.bodyWidthFactor ?? 0.6,
      config.bodyHeightFactor ?? 0.85,
    );

    this.behaviors = new BehaviorManager(this);

    this.movement = this.behaviors.add(
      'movement',
      new PlatformerMovement({
        walkSpeed: config.stats.walkSpeed,
        jumpPower: config.stats.jumpPower,
        airControl: config.movement?.airControl ?? 0.8,
        coyoteTime: config.movement?.coyoteTime ?? 0,
        jumpBufferTime: config.movement?.jumpBufferTime ?? 0,
        doubleJumpEnabled: config.movement?.doubleJumpEnabled ?? false,
        doubleJumpPower: config.movement?.doubleJumpPower,
      }),
    );

    this.melee = this.behaviors.add(
      'melee',
      new MeleeAttack({
        damage: config.stats.attackDamage,
        range: config.combat?.meleeRange ?? 100,
        width: config.combat?.meleeWidth ?? 80,
      }),
    );

    if (config.combat?.rangedKey) {
      this.ranged = this.behaviors.add(
        'ranged',
        new RangedAttack({
          damage: config.stats.attackDamage,
          projectileKey: config.combat.rangedKey,
          projectileSpeed: config.combat.rangedSpeed ?? 600,
          cooldown: config.combat.rangedCooldown ?? 300,
        }),
      );
    }

    this.initBehaviors(config);
    this.initUltimate();
    this.initializeSounds();

    this.fsm = new PlayerFSM(scene, this, config.animKeys);
  }

  // ── hooks ─────────────────────────────────────────────────────────────────
  protected initBehaviors(_config: PlayerConfig): void {}
  protected initUltimate(): void {}
  protected onUpdate(): void {}
  protected onDamageTaken(_damage: number): void {}
  protected onDeath(): void {}
  protected onHealthChanged(_oldHealth: number, _newHealth: number): void {}
  protected onUltimateUsed(): void {}
  protected onUltimateComplete(): void {}

  // ── animation (degrades gracefully when the anim is missing) ────────────────

  /**
   * Play an animation if it exists; otherwise no-op (so the player still moves
   * with a placeholder texture and zero generated art). Always re-normalizes
   * the origin for the current facing direction.
   */
  playAnimation(animKey?: string): void {
    if (animKey && this.scene?.anims?.exists(animKey)) {
      this.play(animKey, true);
    }
    utils.resetOriginAndOffset(this, this.facingDirection);
  }

  // ── update ──────────────────────────────────────────────────────────────────

  /**
   * Called every frame from the scene. Accepts WASD + space + shift + e + q
   * AND the cursor keys (arrows) — both drive movement so W5's arrow inputs
   * and a player's WASD both work.
   */
  update(
    wasdKeys?: BasePlayer['wasdKeys'],
    spaceKey?: Phaser.Input.Keyboard.Key,
    shiftKey?: Phaser.Input.Keyboard.Key,
    eKey?: Phaser.Input.Keyboard.Key,
    qKey?: Phaser.Input.Keyboard.Key,
    cursors?: Phaser.Types.Input.Keyboard.CursorKeys,
  ): void {
    this.wasdKeys = wasdKeys;
    this.spaceKey = spaceKey;
    this.shiftKey = shiftKey;
    this.eKey = eKey;
    this.qKey = qKey;
    this.cursors = cursors;

    if (!this.body || !this.active) return;
    if (this.isUsingUltimate) return;

    this.setFlipX(this.facingDirection === 'left');
    utils.resetOriginAndOffset(this, this.facingDirection);

    if (this.verticalVisualOffset !== 0) {
      const o = this.body.offset;
      this.body.setOffset(o.x, o.y - this.verticalVisualOffset);
    }

    this.behaviors.update();
    this.fsm.update(0, 0);
    this.onUpdate();
  }

  // ── ranged / ultimate ───────────────────────────────────────────────────────

  shoot(): void {
    if (this.isDead || !this.ranged) return;
    const bullet = this.ranged.shoot(this.facingDirection, 'playerBullets');
    if (bullet) {
      this.shootSound?.play();
      // player.shot — the standardized shoot event on the scene's shared bus, at the
      // real fire moment (a bullet was spawned). Defensive: a scene without a bus is a
      // no-op. Declared in this component's surface() (the player OWNS the shoot moment).
      this.bus?.emit('player.shot', { x: this.x, y: this.y });
    }
  }

  // ── component surface (the events THIS component — the player — owns + emits) ──
  /**
   * The uniform component surface for the player. Declares the PLAYER-OWNED events,
   * each emitted from a real seam in THIS class on the scene's shared bus:
   *   - player.shot    ← shoot()       (a bullet was spawned)              [base:2d]
   *   - player.damaged ← takeDamage()  (non-lethal hit; lethal → scene player.died) [base:2d]
   * The scene base owns the scene-level moments (player.died/jumped/landed/respawned/
   * level.statusChanged/score.changed/reward.collected/hazard.activated/enemy.died).
   */
  surface(): ComponentSurface {
    return {
      observables: {},
      anchors: [],
      events: [
        {
          name: 'player.shot',
          payload: '{x,y}',
          scope: 'base:2d',
          drivenBy: 'shoot input (ranged fire)',
          expect: 'a player bullet spawns; player.shot logged',
        },
        {
          name: 'player.damaged',
          payload: '{x,y,health,damage}',
          scope: 'base:2d',
          drivenBy: 'a hit lands (non-lethal)',
          expect: '__GAME__.player.health decreases; player.damaged logged',
        },
      ],
    };
  }

  canUseUltimate(): boolean {
    if (this.isDead || this.isHurting || this.isUsingUltimate) return false;
    return this.ultimate?.canUse() ?? false;
  }

  useUltimate(): void {
    if (!this.canUseUltimate() || !this.ultimate) return;
    this.isUsingUltimate = true;
    this.body.setVelocityX(0);
    this.onUltimateUsed();
    this.ultimateSound?.play();
    const scene = this.scene as any;
    this.ultimate.use({
      scene: this.scene,
      owner: this,
      facingDirection: this.facingDirection,
      enemies: scene.enemies,
      onComplete: () => {
        this.isUsingUltimate = false;
        this.onUltimateComplete();
      },
    });
  }

  getUltimateCooldownRemaining(): number {
    return this.ultimate?.getCooldownRemaining() ?? 0;
  }
  getUltimateCooldownProgress(): number {
    return this.ultimate?.getCooldownProgress() ?? 1;
  }

  // ── damage ──────────────────────────────────────────────────────────────────

  takeDamage(damage: number): void {
    if (this.isInvulnerable || this.isDead) return;
    const oldHealth = this.health;
    this.health -= damage;
    this.isHurting = true;
    this.isInvulnerable = true;
    // player.damaged — the standardized non-lethal damage event on the shared bus, at
    // the real hit moment (lethal damage flows to player.died via the scene). Defensive:
    // a scene without a bus is a no-op. Declared in this component's surface().
    this.bus?.emit('player.damaged', {
      x: this.x,
      y: this.y,
      health: this.health,
      damage,
    });
    this.onDamageTaken(damage);
    this.onHealthChanged(oldHealth, this.health);
    this.fsm.goto('hurting');
    this.scene.tweens.add({
      targets: this,
      alpha: 0.3,
      duration: 100,
      yoyo: true,
      repeat: Math.floor(this.invulnerableTime / 200),
      onComplete: () => {
        this.alpha = 1;
        this.isInvulnerable = false;
      },
    });
  }

  heal(amount: number): void {
    const oldHealth = this.health;
    this.health = Math.min(this.health + amount, this.maxHealth);
    if (this.health !== oldHealth) this.onHealthChanged(oldHealth, this.health);
  }

  kill(): void {
    if (this.isDead) return;
    this.health = 0;
    this.isDead = true;
    this.onDeath();
    this.fsm.goto('dying');
  }

  // ── utility ─────────────────────────────────────────────────────────────────

  getHealthPercentage(): number {
    return (this.health / this.maxHealth) * 100;
  }

  /** Read by window.__GAME__.player.isGrounded. */
  isGrounded(): boolean {
    return this.body?.onFloor() ?? false;
  }

  protected initializeSounds(): void {
    this.jumpSound = utils.safeAddSound(this.scene, 'player_jump', { volume: 0.3 });
    this.attackSound = utils.safeAddSound(this.scene, 'player_attack', { volume: 0.3 });
    this.hurtSound = utils.safeAddSound(this.scene, 'player_hurt', { volume: 0.3 });
    this.shootSound = utils.safeAddSound(this.scene, 'player_shoot', { volume: 0.3 });
    this.ultimateSound = utils.safeAddSound(this.scene, 'player_ultimate', { volume: 0.3 });
  }
}
