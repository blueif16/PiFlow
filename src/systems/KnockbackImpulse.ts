/**
 * KnockbackImpulse — a composable kind=system that gives combat hits IMPACT WEIGHT.
 *
 * THE MECHANIC (Dead Cells–style knockback; design-rules.md:215-220 "impact
 * weight"): on a hit landing on a combatant, push the struck entity AWAY from its
 * attacker — a horizontal shove + a small upward POP — for a short window, after
 * which physics settles it. In __GAME__.entities the struck entity's x is displaced
 * (and briefly y is lifted) on the hit frame, then it settles back under gravity.
 * The air-pop is what lets a downstream juggle (ComboChain) keep an enemy aloft.
 *
 * Today that push is BAKED into BaseLevelScene's collision callbacks as untunable
 * literals (the 150/200/300 velocity constants at BaseLevelScene.ts:415-416,436,
 * 454-455,465,487) and emits NO event, so HARDEN cannot bind a knockback FEEL. This
 * system replaces that with one DECLARED, tunable `force` and a real
 * `entity.knockedBack` emit at the hit seam.
 *
 * HOW IT DETECTS A HIT WITHOUT TOUCHING THE SCENE CALLBACKS (scene-agnostic): every
 * combatant (BaseEnemy + the player) sets `isHurting = true` on the exact frame
 * takeDamage() lands (BaseEnemy.ts:264; the scene's contact/melee/bullet callbacks
 * call player.takeDamage which sets the same flag). This system watches that
 * RISING EDGE per combatant in update() — the one frame isHurting flips false→true
 * is the hit frame — and applies the knockback there, once per hit. It re-arms when
 * the flag clears (the i-frame/hurt window ends), so each distinct hit knocks back
 * exactly once. No per-game coordinate or theme is encoded.
 *
 * ATTACKER DIRECTION is inferred the way the baked callbacks already do it: the
 * struck entity is pushed along x AWAY from its attacker. The player's attacker is
 * the nearest live enemy; an enemy's attacker is the player (mirrors
 * BaseLevelScene.ts:435 `direction = enemy.x > player.x ? 1 : -1`). Absent a
 * resolvable attacker, the struck entity is pushed along its current facing's
 * opposite (never zero — a hit always reads as a shove).
 *
 * IDEMPOTENT per hit (the per-sprite `__kbArmed` latch) and RESPAWN-SAFE (it holds
 * no level state — it re-reads live sprites each frame). reset() is a no-op: there
 * is nothing to clear across a level restart (the latch lives on the sprites the
 * restart's create() rebuilds).
 *
 * Params (all OPTIONAL — the design/HARDEN binds the feel; sensible defaults below):
 *   force       horizontal knockback speed in px/s applied away from the attacker
 *               (default 220 — the median of the 150/200/300 it replaces).
 *   pop         upward pop speed in px/s on the hit frame (default 160 — the small
 *               lift the baked player callbacks used as -150). 0 => pure horizontal.
 *   id          base/fallback entity id for the emit payload when a struck sprite
 *               carries no `__id` (auto-derived `__id`/`__type` is preferred).
 */
import type { ISceneSystem } from '../scenes/level-data';
import { type ComponentSurface, type EventBus } from '@contract/component-surface';

/** CAPABILITY — self-describing registry sidecar (capability-registry-harness). */
export const CAPABILITY = {
  kind: 'system',
  id: 'KnockbackImpulse',
  intent:
    'On a hit, push the struck combatant away from its attacker (horizontal shove + small upward pop) for a short window, then settle — a tunable `force` replacing the baked 150/200/300 collision-callback constants. Emits entity.knockedBack.',
  attachesTo: 'scene',
  params: ['force', 'pop', 'id'],
  roles: ['player', 'enemy'],
  tuning: ['force'],
} as const;

export interface KnockbackImpulseConfig {
  /** Horizontal knockback speed (px/s) applied away from the attacker (default 220). */
  force?: number;
  /** Upward pop speed (px/s) on the hit frame (default 160; 0 => pure horizontal). */
  pop?: number;
  /** Base/fallback entity id for the payload when a sprite carries no `__id`. */
  id?: string;
}

export class KnockbackImpulse implements ISceneSystem {
  private scene: any;
  private readonly force: number;
  private readonly pop: number;
  private readonly fallbackId: string;

  private get bus(): EventBus | undefined {
    return (this.scene as any)?.eventBus;
  }

  constructor(params: KnockbackImpulseConfig = {}) {
    this.force = params.force ?? 220;
    this.pop = params.pop ?? 160;
    this.fallbackId = params.id ?? 'entity';
  }

  reset(): void {
    // No level-restart state: the per-hit latch lives on the sprites the restart's
    // create() rebuilds, and this system re-reads live sprites each frame.
  }

  attach(scene: any): void {
    this.scene = scene;
  }

  /** Per-frame: detect each combatant's hit frame (isHurting false→true) and knock back. */
  update(): void {
    const scene = this.scene;
    if (!scene) return;

    // The player is a combatant the scene's collision callbacks hurt directly.
    const player = scene.player;
    if (player) this.checkHit(player, this.nearestEnemy(player));

    // Every live enemy: its attacker is the player (the melee/bullet callbacks).
    scene.enemies?.getChildren?.().forEach((enemy: any) => {
      if (!enemy || enemy.isDead) return;
      this.checkHit(enemy, player);
    });
  }

  /**
   * One-shot knockback on the rising edge of `isHurting`. `attacker` is the entity
   * the struck one is pushed away from (may be undefined → fall back to facing).
   */
  private checkHit(target: any, attacker: any): void {
    if (!target?.body) {
      return;
    }
    const hurting = !!target.isHurting;
    // Rising edge: the one frame the hit landed (takeDamage set isHurting true).
    if (hurting && !target.__kbArmed) {
      target.__kbArmed = true;
      this.applyKnockback(target, attacker);
    } else if (!hurting && target.__kbArmed) {
      // Hurt window ended — re-arm so the NEXT distinct hit knocks back again.
      target.__kbArmed = false;
    }
  }

  /** Push `target` away from `attacker`: horizontal `force` + upward `pop`. */
  private applyKnockback(target: any, attacker: any): void {
    const dirX = this.knockbackDir(target, attacker);
    target.setVelocityX?.(this.force * dirX);
    if (this.pop > 0) target.setVelocityY?.(-this.pop);

    // entity.knockedBack — the standardized hit-impulse moment on the shared bus, at
    // the real hit frame. Id is auto-derived from the struck sprite's __id/__type
    // tag (set on every combatant), falling back to the config base id. Lean +
    // JSON-serializable (no class instance).
    this.bus?.emit('entity.knockedBack', {
      id: target.__id ?? target.__type ?? this.fallbackId,
      x: target.x ?? 0,
      y: target.y ?? 0,
      dirX,
      force: this.force,
    });
  }

  /**
   * Direction (±1) the struck entity is pushed: AWAY from its attacker (mirrors the
   * baked callbacks' `attacker.x < target.x ? +1 : -1`). With no resolvable
   * attacker, push opposite the struck entity's facing — never zero, so a hit always
   * reads as a shove.
   */
  private knockbackDir(target: any, attacker: any): number {
    if (attacker && typeof attacker.x === 'number') {
      return target.x >= attacker.x ? 1 : -1;
    }
    return target.facingDirection === 'left' ? 1 : -1;
  }

  /** The nearest live enemy to `from` (the player's attacker), or undefined. */
  private nearestEnemy(from: any): any {
    const list = this.scene?.enemies?.getChildren?.();
    if (!list || !list.length) return undefined;
    let best: any;
    let bestD = Infinity;
    for (const e of list) {
      if (!e || e.isDead || typeof e.x !== 'number') continue;
      const dx = e.x - (from?.x ?? 0);
      const dy = (e.y ?? 0) - (from?.y ?? 0);
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /**
   * The uniform component surface — the one event this system publishes. Declared
   * here and fired by a real .emit() in applyKnockback (the hit seam above).
   *   - entity.knockedBack ← applyKnockback (the isHurting rising edge) [archetype]
   */
  surface(): ComponentSurface {
    return {
      observables: {},
      anchors: [],
      events: [
        {
          name: 'entity.knockedBack',
          payload: '{id,x,y,dirX,force}',
          scope: 'archetype',
          drivenBy: 'a melee/ranged hit lands on a combatant (isHurting rising edge)',
          expect:
            "the struck entity's entities[] x shifts away from the attacker (y briefly lifts) on the hit frame then settles; entity.knockedBack logged",
        },
      ],
    };
  }
}
