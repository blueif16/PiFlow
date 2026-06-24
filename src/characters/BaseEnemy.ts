import Phaser from 'phaser';
import * as utils from '../utils';
import {
  BehaviorManager,
  PatrolAI,
  ChaseAI,
  MeleeAttack,
  RangedAttack,
} from '../behaviors';
import type { ComponentSurface, EventBus } from '@contract/component-surface';

export type EnemyAIType = 'patrol' | 'chase' | 'stationary' | 'custom';

export interface EnemyConfig {
  textureKey: string;
  displayName?: string;
  displayHeight?: number;
  bodyWidthFactor?: number;
  bodyHeightFactor?: number;
  hasGravity?: boolean;
  stats: { maxHealth: number; speed: number; damage: number };
  ai?: {
    type: EnemyAIType;
    patrolMinX?: number;
    patrolMaxX?: number;
    detectionRange?: number;
    giveUpDistance?: number;
    stopDistance?: number;
    chaseVertical?: boolean;
  };
  verticalVisualOffset?: number;
  combat?: {
    hasMelee?: boolean;
    meleeRange?: number;
    meleeWidth?: number;
    meleeCooldown?: number;
    hasRanged?: boolean;
    rangedKey?: string;
    rangedRange?: number;
    rangedCooldown?: number;
  };
}

/**
 * BaseEnemy — Foundation class for platformer enemies  (KEEP — engine)
 *
 * Composes AI (patrol/chase) + combat via BehaviorManager. Health/damage,
 * facing, hooks. Renders without art (playAnimation no-ops if anim missing).
 * Add instances to scene.enemies and bump scene._spawnedEnemyCount so the
 * kill-all win condition (and window.__GAME__.entities) sees them.
 *
 * HOOKS: initBehaviors, onUpdate, onDamageTaken, onDeath, executeAI.
 */
export abstract class BaseEnemy extends Phaser.Physics.Arcade.Sprite {
  declare body: Phaser.Physics.Arcade.Body;

  public behaviors: BehaviorManager;
  public patrol?: PatrolAI;
  public chase?: ChaseAI;
  public melee?: MeleeAttack;
  public ranged?: RangedAttack;

  public facingDirection: 'left' | 'right' = 'right';
  public speed: number;
  public damage: number;
  public verticalVisualOffset: number;

  public isDead = false;
  public isHurting = false;
  public isAttacking = false;

  public maxHealth: number;
  public health: number;

  public aiType: EnemyAIType;
  public target?: Phaser.Physics.Arcade.Sprite;
  public displayName?: string;

  /** Functional entity type tag read by window.__GAME__.entities. */
  public __type = 'enemy';

  public get meleeTrigger(): Phaser.GameObjects.Zone | undefined {
    return this.melee?.meleeTrigger;
  }
  public get currentMeleeTargets(): Set<any> {
    return this.melee?.currentTargets ?? new Set();
  }

  public deathSound?: Phaser.Sound.BaseSound;
  public attackSound?: Phaser.Sound.BaseSound;

  /** The shared event bus, resolved from the scene. Publish moments via
   *  `this.bus?.emit('<name>', payload)` — the ONE canonical vocabulary. */
  protected get bus(): EventBus | undefined {
    return (this.scene as any)?.eventBus;
  }

  constructor(scene: Phaser.Scene, x: number, y: number, config: EnemyConfig) {
    super(scene, x, y, config.textureKey);
    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.maxHealth = config.stats.maxHealth;
    this.health = this.maxHealth;
    this.speed = config.stats.speed;
    this.damage = config.stats.damage;
    this.verticalVisualOffset = config.verticalVisualOffset ?? 0;
    this.displayName = config.displayName;

    if (config.hasGravity !== false) {
      this.body.setGravityY(1200);
      this.body.setMaxVelocityY(800);
    } else {
      this.body.setAllowGravity(false);
    }

    utils.initScale(
      this,
      { x: 0.5, y: 1.0 },
      undefined,
      config.displayHeight ?? 80,
      config.bodyWidthFactor ?? 0.7,
      config.bodyHeightFactor ?? 0.8,
    );

    this.behaviors = new BehaviorManager(this);
    this.aiType = config.ai?.type ?? 'stationary';
    this.setupAI(config);
    this.setupCombat(config);
    this.initBehaviors(config);
    this.initializeSounds();
    this.facingDirection = Math.random() > 0.5 ? 'right' : 'left';
  }

  private setupAI(config: EnemyConfig): void {
    switch (this.aiType) {
      case 'patrol':
        this.patrol = this.behaviors.add(
          'patrol',
          new PatrolAI({
            speed: this.speed,
            minX: config.ai?.patrolMinX,
            maxX: config.ai?.patrolMaxX,
            detectCliffs: true,
          }),
        );
        break;
      case 'chase':
        this.chase = this.behaviors.add(
          'chase',
          new ChaseAI({
            speed: this.speed,
            detectionRange: config.ai?.detectionRange,
            giveUpDistance: config.ai?.giveUpDistance,
            stopDistance: config.ai?.stopDistance ?? 50,
            chaseVertical: config.ai?.chaseVertical ?? false,
          }),
        );
        break;
      default:
        break;
    }
  }

  private setupCombat(config: EnemyConfig): void {
    if (config.combat?.hasMelee) {
      this.melee = this.behaviors.add(
        'melee',
        new MeleeAttack({
          damage: this.damage,
          range: config.combat.meleeRange ?? 80,
          width: config.combat.meleeWidth ?? 60,
          cooldown: config.combat.meleeCooldown ?? 1000,
        }),
      );
    }
    if (config.combat?.hasRanged && config.combat.rangedKey) {
      this.ranged = this.behaviors.add(
        'ranged',
        new RangedAttack({
          damage: this.damage,
          projectileKey: config.combat.rangedKey,
          cooldown: config.combat.rangedCooldown ?? 2000,
        }),
      );
    }
  }

  // ── hooks ──────────────────────────────────────────────────────────────────
  protected initBehaviors(_config: EnemyConfig): void {}
  protected onUpdate(): void {}
  protected onDamageTaken(_damage: number): void {}
  protected onDeath(): void {}
  protected executeAI(): void {}

  /** Play an animation if it exists; otherwise no-op (renders without art). */
  playAnimation(animKey?: string): void {
    if (animKey && this.scene?.anims?.exists(animKey)) this.play(animKey, true);
    utils.resetOriginAndOffset(this, this.facingDirection);
  }

  update(): void {
    if (!this.body || !this.active || this.isDead) return;
    this.setFlipX(this.facingDirection === 'left');
    utils.resetOriginAndOffset(this, this.facingDirection);
    if (this.verticalVisualOffset !== 0) {
      const o = this.body.offset;
      this.body.setOffset(o.x, o.y - this.verticalVisualOffset);
    }
    this.behaviors.update();
    if (this.patrol) this.facingDirection = this.patrol.facingDirection;
    else if (this.chase) this.facingDirection = this.chase.facingDirection;
    if (!this.isHurting && !this.isAttacking) {
      if (this.aiType === 'custom') this.executeAI();
      this.tryRangedAttack();
    }
    this.onUpdate();
  }

  private tryRangedAttack(): void {
    if (!this.ranged || !this.target || !this.target.active) return;
    if (this.ranged.canShoot()) {
      const distance = Phaser.Math.Distance.Between(
        this.x,
        this.y,
        this.target.x,
        this.target.y,
      );
      if (distance < 400) {
        const bullet = this.ranged.shootAt(this.target, 'enemyBullets');
        if (bullet) this.attackSound?.play();
      }
    }
  }

  setTarget(target: Phaser.Physics.Arcade.Sprite): void {
    this.target = target;
    this.chase?.setTarget(target);
  }
  setPatrolBounds(minX: number, maxX: number): void {
    this.patrol?.setBounds(minX, maxX);
  }

  // ── component surface (the events THIS component — the enemy — owns + emits) ──
  /**
   * The uniform component surface for the enemy. Declares the ENEMY-OWNED event,
   * emitted from a real seam in THIS class on the scene's shared bus:
   *   - enemy.damaged ← takeDamage()  (non-lethal hit; lethal → scene enemy.died) [base:2d]
   * The scene base owns enemy.died (the kill-count seam onEnemyKilled).
   */
  surface(): ComponentSurface {
    return {
      observables: {},
      anchors: [],
      events: [
        {
          name: 'enemy.damaged',
          payload: '{id,x,y,health,damage}',
          scope: 'base:2d',
          drivenBy: 'a hit lands on the enemy (non-lethal)',
          expect: 'the enemy health decreases; enemy.damaged logged',
        },
      ],
    };
  }

  takeDamage(damage: number): void {
    if (this.isDead || this.isHurting) return;
    this.health -= damage;
    this.isHurting = true;
    // enemy.damaged — the standardized non-lethal enemy-hit event on the shared bus,
    // at the real hit moment (lethal damage flows to enemy.died via the scene's
    // onEnemyKilled seam). Defensive: a scene without a bus is a no-op. Declared in
    // this component's surface() (the enemy OWNS its damage-intake moment).
    this.bus?.emit('enemy.damaged', {
      id: (this as any).__id,
      x: this.x,
      y: this.y,
      health: this.health,
      damage,
    });
    this.onDamageTaken(damage);
    this.setTint(0xff0000);
    this.scene.time.delayedCall(100, () => {
      if (this.active) {
        this.clearTint();
        this.isHurting = false;
      }
    });
    if (this.health <= 0) this.die();
  }

  die(): void {
    if (this.isDead) return;
    this.isDead = true;
    this.setVelocity(0, 0);
    this.deathSound?.play();
    this.onDeath();
    this.scene.time.delayedCall(500, () => {
      if (this.active) this.destroy();
    });
  }

  getHealthPercentage(): number {
    return (this.health / this.maxHealth) * 100;
  }

  protected initializeSounds(): void {
    this.deathSound = utils.safeAddSound(this.scene, 'enemy_death', { volume: 0.3 });
    this.attackSound = utils.safeAddSound(this.scene, 'enemy_attack', { volume: 0.3 });
  }
}
