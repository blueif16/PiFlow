import Phaser from 'phaser';
import { BaseBehavior } from './IBehavior';
import { type ComponentSurface } from '@contract/component-surface';

/**
 * DirectionalBlock — a composable kind=behavior on the PLAYER: a hold-to-guard with a
 * draining guard meter and a guard-break stun. The player-side mirror of an enemy
 * PostureBreak, and the safe-but-costly FLOOR under the higher-risk ParryWindow (the
 * tight-window negate specced in Round 2). Design grounding: a block must not be the
 * only defensive tool (gamedeveloper.com parry-system), and holding Guard takes more
 * posture damage than a deflect (fromsoftware.jp manual) — so a held block bleeds the
 * meter and eventually BREAKS, which is the cost that makes the tighter parry worth its
 * risk.
 *
 * THE MECHANIC:
 *   - block(true) raises the guard: the player FACES the nearest threat and enters the
 *     'blocking' state. While the guard is up, an incoming FRONT hit (the attacker on
 *     the side the player faces) is reduced to CHIP damage — a fraction `chipFraction`
 *     of the full hit instead of the whole hit — and DRAINS the guard meter by the
 *     hit's full magnitude. Each blocked hit fires `player.blocked`.
 *   - block(false) lowers the guard: while it is down the meter RECOVERS at
 *     `recoverPerSec` units/second back toward `maxGuard`.
 *   - If the meter DRAINS to 0 from over-blocking, the guard BREAKS: the player enters a
 *     brief vulnerable stun for `breakStunMs` — input is suppressed (locomotion frozen +
 *     the block verb ignored) and the guard cannot be re-raised for the window. This
 *     fires `player.guardBroken`. When the stun ends the meter refills to full.
 *
 * THE OBSERVABLE (__GAME__.guardRemaining): the live meter, a SCENE-OWNED scalar
 * (`scene.guardRemaining`, the same archetype-extras pattern as comboCount/hitstunRemaining)
 * AND a `surface().observables.guardRemaining` thunk over this behavior's OWN value. It
 * sits at `maxGuard` until the first blocked hit, decreases as the player blocks, recovers
 * when the guard is down, and snaps to 0 the frame the guard breaks.
 *
 * THE CHIP SEAM WITHOUT EDITING THE PLAYER CLASS: on attach this behavior WRAPS the owner
 * player's `takeDamage(damage)` with a guard that, when a front hit lands while blocking,
 * applies only the chip fraction to the real takeDamage and drains the meter; otherwise it
 * passes the hit straight through. onDetach restores the original method. This mirrors the
 * "freeze/override without touching the entity code" approach HitstunState uses for enemies.
 * Because BehaviorManager updates behaviors in insertion order and movement is added first,
 * this behavior's update() runs AFTER PlatformerMovement set the body velocity, so zeroing
 * the velocity during the break window cleanly suppresses locomotion control.
 *
 * Params (all OPTIONAL — the design/HARDEN binds the feel; sensible defaults below):
 *   maxGuard       guard-meter capacity (default 100 — the full bar before a break).
 *   chipFraction   fraction of a full front hit that lands while blocking (default 0.2 —
 *                  a hard guard bleeds ~20% through, the safe-but-not-free floor).
 *   recoverPerSec  meter recovered per second while the guard is DOWN (default 40).
 *   breakStunMs    the guard-break stun window in ms (default 600 — brief but punishing).
 */

/** CAPABILITY — self-describing registry sidecar (capability-registry-harness). */
export const CAPABILITY = {
  kind: 'behavior',
  id: 'DirectionalBlock',
  intent:
    "Hold-to-block on the player: front hits deal only chip damage and drain a guard meter (__GAME__.guardRemaining); releasing recovers it, and over-blocking to 0 BREAKS the guard into a brief input-suppressed stun. The player-side mirror of PostureBreak; emits player.blocked + player.guardBroken.",
  attachesTo: 'entity:player',
  roles: ['player'],
  params: ['maxGuard', 'chipFraction', 'recoverPerSec', 'breakStunMs'],
  tuning: ['chipFraction'],
} as const;

export interface DirectionalBlockConfig {
  /** Guard-meter capacity (default 100). */
  maxGuard?: number;
  /** Fraction of a full front hit that lands while blocking (default 0.2). */
  chipFraction?: number;
  /** Meter recovered per second while the guard is down (default 40). */
  recoverPerSec?: number;
  /** Guard-break stun window in ms (default 600). */
  breakStunMs?: number;
}

const DEFAULT_MAX_GUARD = 100;
const DEFAULT_CHIP_FRACTION = 0.2;
const DEFAULT_RECOVER_PER_SEC = 40;
const DEFAULT_BREAK_STUN_MS = 600;

export class DirectionalBlock extends BaseBehavior {
  private readonly maxGuard: number;
  private readonly chipFraction: number;
  private readonly recoverPerSec: number;
  private readonly breakStunMs: number;

  /** The live guard meter (mirrored onto `scene.guardRemaining` for the hook). */
  private guard: number;
  /** True while the player is holding block (the guard is up). */
  private blocking = false;
  /** ms remaining on the guard-break stun; > 0 means input is suppressed. */
  private breakRemaining = 0;

  /** The player's original takeDamage, saved so onDetach can restore it. */
  private originalTakeDamage?: (damage: number) => void;

  constructor(config: DirectionalBlockConfig = {}) {
    super();
    this.maxGuard = config.maxGuard ?? DEFAULT_MAX_GUARD;
    this.chipFraction = config.chipFraction ?? DEFAULT_CHIP_FRACTION;
    this.recoverPerSec = config.recoverPerSec ?? DEFAULT_RECOVER_PER_SEC;
    this.breakStunMs = config.breakStunMs ?? DEFAULT_BREAK_STUN_MS;
    this.guard = this.maxGuard;
  }

  /**
   * Install the chip-damage guard over the player's takeDamage and publish the meter.
   * The wrapper intercepts a front hit while blocking, reducing it to chip damage and
   * draining the meter; every other hit passes straight through to the original.
   */
  protected onAttach(): void {
    const owner = this.getOwner<any>();
    const scene = owner?.scene as any;
    if (scene) scene.guardRemaining = this.guard;

    if (owner && typeof owner.takeDamage === 'function' && !this.originalTakeDamage) {
      this.originalTakeDamage = owner.takeDamage.bind(owner);
      owner.takeDamage = (damage: number) => this.onIncomingHit(damage);
    }
  }

  /** Restore the player's original takeDamage (idempotent) on a true detach. */
  protected onDetach(): void {
    const owner = this.owner;
    if (owner && this.originalTakeDamage) {
      owner.takeDamage = this.originalTakeDamage;
      this.originalTakeDamage = undefined;
    }
  }

  /**
   * The drive seam. held=true raises the guard and faces the threat; held=false lowers
   * it. Ignored while the guard is broken (input is suppressed for the stun window).
   * Driven LIVE each frame by update() polling the player's held DOWN/S key off the
   * scene (the 'block' verb — a real held player input); a test can also call it directly.
   */
  block(held: boolean): void {
    if (this.breakRemaining > 0) return; // stunned — the block verb is suppressed
    if (held && !this.blocking) this.faceThreat();
    this.blocking = held;
  }

  /**
   * Read the held BLOCK input off the scene (the player verb that drives block()). The
   * scene wires DOWN-arrow + S as the only un-bound directional key (BaseLevelScene
   * setupInputs: cursors.down / wasdKeys.S — not claimed by move/jump/attack/ultimate),
   * so holding it raises the guard. Defensive: a scene without those keys reads false.
   */
  private blockKeyHeld(): boolean {
    const scene = this.getOwner<any>()?.scene as any;
    return Boolean(scene?.cursors?.down?.isDown || scene?.wasdKeys?.S?.isDown);
  }

  /** True while the player is actively guarding (read by the FSM/animation if wired). */
  isBlocking(): boolean {
    return this.blocking && this.breakRemaining <= 0;
  }

  /** True during the guard-break stun (input suppressed). */
  isGuardBroken(): boolean {
    return this.breakRemaining > 0;
  }

  /**
   * The takeDamage wrapper. A FRONT hit (attacker on the player's facing side) while
   * blocking is reduced to chip damage + drains the meter; everything else is unchanged.
   */
  private onIncomingHit(damage: number): void {
    const owner = this.getOwner<any>();
    if (
      this.blocking &&
      this.breakRemaining <= 0 &&
      damage > 0 &&
      this.isFrontHit()
    ) {
      // Front hit blocked: only the chip fraction reaches the player.
      const chip = damage * this.chipFraction;
      this.originalTakeDamage?.(chip);

      // Drain the guard by the FULL incoming magnitude (a hard block bleeds posture).
      this.guard = Math.max(0, this.guard - damage);
      const scene = owner?.scene as any;
      if (scene) scene.guardRemaining = this.guard;

      // player.blocked — a front hit was guarded; health took only chip, meter dropped.
      this.bus?.emit('player.blocked', {
        guardRemaining: this.guard,
        x: owner?.x ?? 0,
        y: owner?.y ?? 0,
      });

      // Over-block: the meter is empty → the guard BREAKS into the stun.
      if (this.guard <= 0) this.breakGuard();
      return;
    }
    // Not a blocked front hit: the full hit passes through unchanged.
    this.originalTakeDamage?.(damage);
  }

  /** Trip the guard-break stun: drop the guard, open the input-suppressed window, emit. */
  private breakGuard(): void {
    this.blocking = false;
    this.breakRemaining = this.breakStunMs;
    const owner = this.getOwner<any>();
    const scene = owner?.scene as any;
    if (scene) scene.guardRemaining = 0;
    // player.guardBroken — the meter emptied; the player is in a brief vulnerable stun.
    this.bus?.emit('player.guardBroken', {
      x: owner?.x ?? 0,
      y: owner?.y ?? 0,
    });
  }

  /**
   * Per-frame: run the stun window (suppress locomotion while it lasts), then recover
   * the meter while the guard is down. Runs AFTER PlatformerMovement set the velocity,
   * so zeroing the body velocity here is what suppresses control during the stun.
   */
  update(): void {
    const owner = this.getOwner<any>();
    const dtMs = owner?.scene?.game?.loop?.delta ?? 16;

    // LIVE drive: poll the held block key each frame so a real player input raises /
    // lowers the guard (no-op while stunned — block() ignores it for the window).
    this.block(this.blockKeyHeld());

    if (this.breakRemaining > 0) {
      // Input suppressed: freeze locomotion for the window (override the movement step).
      owner?.body?.setVelocityX?.(0);
      this.breakRemaining -= dtMs;
      if (this.breakRemaining <= 0) {
        // Window over: refill the meter and return control.
        this.breakRemaining = 0;
        this.guard = this.maxGuard;
        const scene = owner?.scene as any;
        if (scene) scene.guardRemaining = this.guard;
      }
      return;
    }

    // Guard down → recover the meter toward full at recoverPerSec.
    if (!this.blocking && this.guard < this.maxGuard) {
      this.guard = Math.min(this.maxGuard, this.guard + this.recoverPerSec * (dtMs / 1000));
      const scene = owner?.scene as any;
      if (scene) scene.guardRemaining = this.guard;
    }
  }

  /** Turn the player to face the nearest live enemy (the threat) when the guard goes up. */
  private faceThreat(): void {
    const owner = this.getOwner<any>();
    const nearest = this.nearestEnemy();
    if (nearest) owner.facingDirection = nearest.x < owner.x ? 'left' : 'right';
  }

  /** A front hit = the nearest live enemy is on the side the player faces. */
  private isFrontHit(): boolean {
    const owner = this.getOwner<any>();
    const nearest = this.nearestEnemy();
    if (!nearest) return true; // no positional source available → treat as a front hit
    const enemyOnLeft = nearest.x < owner.x;
    return enemyOnLeft === (owner.facingDirection === 'left');
  }

  /** The nearest non-dead enemy sprite, or undefined (re-read live each call). */
  private nearestEnemy(): any {
    const owner = this.getOwner<any>();
    const list = (owner?.scene as any)?.enemies?.getChildren?.();
    if (!list || !list.length) return undefined;
    let best: any;
    let bestD = Infinity;
    for (const e of list) {
      if (!e || e.isDead) continue;
      const d = Phaser.Math.Distance.Between(owner.x, owner.y, e.x, e.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /**
   * The uniform component surface. The PULL channel publishes `guardRemaining` (this
   * behavior's OWN live meter); the PUSH channel declares the two guard moments, each
   * fired by a real .emit() in this file on the scene's shared bus:
   *   - guardRemaining   ← this.guard (the live meter; maxGuard → 0 on break)
   *   - player.blocked    ← onIncomingHit (a front hit guarded to chip)       [archetype]
   *   - player.guardBroken ← breakGuard   (the meter emptied → vulnerable stun) [archetype]
   */
  surface(): ComponentSurface {
    return {
      observables: {
        guardRemaining: () => this.guard,
      },
      anchors: [],
      events: [
        {
          name: 'player.blocked',
          payload: '{guardRemaining,x,y}',
          scope: 'archetype',
          drivenBy: 'block (a front hit lands while the block is held)',
          expect:
            '__GAME__.player.health drops by only the chip fraction (not the full hit) and __GAME__.guardRemaining decreases; player.blocked logged',
        },
        {
          name: 'player.guardBroken',
          payload: '{x,y}',
          scope: 'archetype',
          drivenBy: 'block (the guard meter drains to 0 from over-blocking)',
          expect:
            'the player enters a brief input-suppressed stun (__GAME__.guardRemaining at 0); player.guardBroken logged',
        },
      ],
    };
  }
}
