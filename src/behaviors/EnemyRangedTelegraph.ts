import Phaser from 'phaser';
import { BaseBehavior } from './IBehavior';
import { type ComponentSurface } from '@contract/component-surface';
import type { RangedAttack } from './RangedAttack';

/**
 * CAPABILITY — self-describing registry sidecar (capability-registry-harness).
 * Globbed by registry/build-registry.mjs; bound by the blueprint via `id`.
 * EDIT THIS, not capabilities.json.
 */
export const CAPABILITY = {
  kind: 'behavior',
  id: 'EnemyRangedTelegraph',
  intent:
    'Wrap an enemy ranged shot in an OBSERVABLE aim window: the enemy holds velocity ~0 and locks facing toward the player for aimMs (no projectile yet), THEN fires via the existing RangedAttack path — so the aimed line is readable and dodgeable.',
  roles: ['enemy'],
  params: ['aimMs', 'cooldownMs', 'detectionRange', 'bulletGroup', 'id'],
  tuning: [],
} as const;

/** The aim cycle, smallest possible: nothing happening, telling, just-fired. */
export type TelegraphPhase = 'idle' | 'aiming' | 'cooldown';

/**
 * EnemyRangedTelegraph configuration. Every field is OPTIONAL with a declared
 * default — no number is fabricated; HARDEN may override each via the blueprint.
 */
export interface EnemyRangedTelegraphConfig {
  /** Length of the readable aim tell in ms before the shot leaves (default 600). */
  aimMs?: number;
  /** Minimum ms between the END of one shot and the start of the next aim (default 900). */
  cooldownMs?: number;
  /** Only open the aim tell when the player is within this many px (default Infinity — always). */
  detectionRange?: number;
  /** Scene bullet group the wrapped fire spawns into (default 'enemyBullets'). */
  bulletGroup?: 'playerBullets' | 'enemyBullets';
  /**
   * Base/fallback id for the event payload. The LIVE id auto-derives from the
   * bound enemy's `__id`; this is only the fallback when the sprite carries none.
   */
  id?: string;
}

/**
 * EnemyRangedTelegraph — a ranged-enemy aim-tell behavior (role:'enemy'). It wraps
 * the existing RangedAttack fire seam so that EVERY shot is preceded by a fair,
 * readable aim window the player can evade (the Sekiro EARLY BRUTE unblockable
 * projectile read — jasondeheras.com Sekiro enemies).
 *
 * THE CONTRACT (observable on __GAME__):
 *   - On 'aiming' (driven by the enemy AI advancing its ranged cycle — the `move`
 *     approach verb): the enemy STOPS (velocity held ~0) and LOCKS its facing
 *     toward the player for `aimMs`, and NO projectile is spawned. enemy.aimed fires.
 *   - On the aim window elapsing: the wrapped RangedAttack fires ONE shot toward the
 *     player, so a projectile enters scene.enemyBullets (→ __GAME__.entities) only
 *     ON/AFTER this frame, never during the tell. enemy.fired fires.
 *
 * It re-implements NO projectile logic — the shot is delegated VERBATIM to the bound
 * RangedAttack.shootAt (the canonical enemy-fire path; collision resolved by
 * BaseLevelScene). This component only owns the TIMING + the facing/velocity hold +
 * the two telegraph moments. Distinct from RangedAttack (fires with ZERO startup),
 * CyclicHazard (telegraphs a hazard REGION, not an aimed shot), and the melee
 * EnemyTelegraphAttack (a different, contact-range channel).
 *
 * DRIVE SEAM (no full game needed): `move()` is the public verb the enemy AI ticks
 * each frame (update() delegates to it). Bind the fire path with `setFire(ranged)`
 * (or it auto-resolves a RangedAttack off the owner's `behaviors` manager) and the
 * target with `setTarget(player)`. A test can construct the behavior over a real
 * RangedAttack + a scene shell carrying `eventBus` + `time.now`, then drive `move()`
 * across the aimMs boundary and read the two events off the bus.
 */
export class EnemyRangedTelegraph extends BaseBehavior {
  public readonly aimMs: number;
  public readonly cooldownMs: number;
  public readonly detectionRange: number;
  public readonly bulletGroup: 'playerBullets' | 'enemyBullets';
  private readonly fallbackId: string;

  /** The current cycle phase. Read by tests; drives the velocity/facing hold. */
  public phase: TelegraphPhase = 'idle';

  /** The target the shot is aimed at (usually the player). */
  public target: Phaser.Physics.Arcade.Sprite | null = null;

  /** The wrapped fire path (the existing RangedAttack). Resolved lazily. */
  private ranged: RangedAttack | null = null;

  /** Scene-clock (ms) when the active aim window opened; -1 when not aiming. */
  private aimStartedAt = -1;
  /** Scene-clock (ms) when the last shot left; -Infinity until the first shot. */
  private lastFiredAt = Number.NEGATIVE_INFINITY;

  constructor(config: EnemyRangedTelegraphConfig = {}) {
    super();
    this.aimMs = config.aimMs ?? 600;
    this.cooldownMs = config.cooldownMs ?? 900;
    this.detectionRange = config.detectionRange ?? Number.POSITIVE_INFINITY;
    this.bulletGroup = config.bulletGroup ?? 'enemyBullets';
    this.fallbackId = config.id ?? 'enemy';
  }

  /** Set the target the aimed shot tracks (usually the player). */
  setTarget(target: Phaser.Physics.Arcade.Sprite | null): void {
    this.target = target;
  }

  /** Bind the existing fire path explicitly (else it auto-resolves off the owner). */
  setFire(ranged: RangedAttack): void {
    this.ranged = ranged;
  }

  protected onAttach(): void {
    // Default the target to the scene player so a bare bind still aims at something.
    if (!this.target) {
      const scene = this.getOwner<any>()?.scene;
      if (scene?.player) this.target = scene.player;
    }
  }

  /** update() IS the per-frame move tick — delegate to the named verb seam. */
  update(): void {
    this.move();
  }

  /**
   * The `move` verb: advance the ranged cycle one step. The enemy AI calls this
   * each frame as it approaches; it opens the aim tell, holds the enemy still +
   * facing the player through the window, then releases the wrapped shot.
   */
  move(): void {
    const owner = this.getOwner<Phaser.Physics.Arcade.Sprite & { __id?: string }>();
    const scene: any = owner.scene;
    const now: number = scene?.time?.now ?? 0;
    const target = this.target;

    // No target / target gone → no cycle; settle to idle and stop.
    if (!target || (target as any).active === false) {
      this.phase = 'idle';
      this.aimStartedAt = -1;
      owner.setVelocityX?.(0);
      return;
    }

    const dist = Math.abs(target.x - owner.x) + Math.abs(target.y - owner.y);

    switch (this.phase) {
      case 'idle': {
        // Open the aim window once in range AND off cooldown.
        const ready = now - this.lastFiredAt >= this.cooldownMs;
        if (ready && dist <= this.detectionRange) {
          this.openAim(owner, scene, now, target);
        }
        break;
      }
      case 'aiming': {
        // HOLD: still + facing locked toward the player; NO projectile yet.
        this.holdAndFace(owner, target);
        // Release the shot only AFTER the full tell has elapsed.
        if (now - this.aimStartedAt >= this.aimMs) {
          this.releaseShot(owner, scene, now, target);
        }
        break;
      }
      case 'cooldown': {
        // Post-shot recovery; resume the cycle once cooldown clears.
        owner.setVelocityX?.(0);
        if (now - this.lastFiredAt >= this.cooldownMs) this.phase = 'idle';
        break;
      }
    }
  }

  /** Begin the aim tell: stop, face the player, and ANNOUNCE it (enemy.aimed). */
  private openAim(owner: any, scene: any, now: number, target: any): void {
    this.phase = 'aiming';
    this.aimStartedAt = now;
    this.holdAndFace(owner, target);
    // enemy.aimed — the readable tell opened: enemy is stopped + facing the
    // player and NO projectile exists yet (it spawns only on enemy.fired).
    this.bus?.emit('enemy.aimed', this.payload(owner));
  }

  /** The held state: velocity ~0 + facing locked toward the target. */
  private holdAndFace(owner: any, target: any): void {
    owner.setVelocityX?.(0);
    const facing: 'left' | 'right' = target.x < owner.x ? 'left' : 'right';
    if ('facingDirection' in owner) owner.facingDirection = facing;
    owner.setFlipX?.(facing === 'left');
  }

  /** The tell elapsed: fire the wrapped RangedAttack ONE shot, then ANNOUNCE it. */
  private releaseShot(owner: any, scene: any, now: number, target: any): void {
    const ranged = this.resolveFire(owner);
    // Delegate the actual projectile to the existing path (spawns into the
    // bullet group → enters __GAME__.entities). No re-implemented projectile.
    ranged?.shootAt?.(target, this.bulletGroup);
    this.lastFiredAt = now;
    this.aimStartedAt = -1;
    this.phase = 'cooldown';
    // enemy.fired — the shot left AFTER the tell; a projectile enters
    // __GAME__.entities only on/after this frame, never during the aim window.
    this.bus?.emit('enemy.fired', this.payload(owner));
  }

  /** Lazily resolve the wrapped RangedAttack (explicit bind, else off the owner). */
  private resolveFire(owner: any): RangedAttack | null {
    if (this.ranged) return this.ranged;
    // The owner exposes its components via a BehaviorManager (real API: get/getAll).
    const mgr = owner?.behaviors;
    const byName = mgr?.get?.('ranged') ?? mgr?.get?.('rangedAttack');
    const all: any[] = typeof mgr?.getAll === 'function' ? mgr.getAll() : [];
    const found =
      byName ?? all.find((b: any) => typeof b?.shootAt === 'function');
    this.ranged = (found as RangedAttack) ?? null;
    return this.ranged;
  }

  /** Lean, JSON-serializable payload; id auto-derived from the enemy's __id. */
  private payload(owner: any): { id: string; x: number; y: number } {
    return {
      id: (owner?.__id as string) ?? this.fallbackId,
      x: owner?.x ?? 0,
      y: owner?.y ?? 0,
    };
  }

  /** True iff the enemy is mid-tell (no projectile yet) — readable by a test. */
  isAiming(): boolean {
    return this.phase === 'aiming';
  }

  /**
   * The uniform component surface — the two telegraph MOMENTS this behavior owns,
   * each fired from a real seam in THIS file on the scene's shared bus:
   *   - enemy.aimed ← openAim    (the aim tell opens; enemy stops + faces, no shot) [archetype]
   *   - enemy.fired ← releaseShot (the tell elapses; the wrapped shot leaves)        [archetype]
   */
  surface(): ComponentSurface {
    return {
      observables: {},
      anchors: [],
      events: [
        {
          name: 'enemy.aimed',
          payload: '{id,x,y}',
          scope: 'archetype',
          drivenBy: 'move',
          expect:
            'the enemy stops and faces the player with NO projectile yet for aimMs; enemy.aimed logged',
        },
        {
          name: 'enemy.fired',
          payload: '{id,x,y}',
          scope: 'archetype',
          drivenBy: 'move',
          expect:
            'a projectile enters __GAME__.entities only on/after this frame (never during the aim window); enemy.fired logged',
        },
      ],
    };
  }
}
