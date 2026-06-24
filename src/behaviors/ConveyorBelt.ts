import Phaser from 'phaser';
import { BaseBehavior } from './IBehavior';
import { type ComponentSurface } from '@contract/component-surface';

/**
 * ConveyorBelt — a composable kind=behavior bound on a `role:'platform'` entity that
 * turns a FIXED platform into a moving WALKWAY.
 *
 * THE MECHANIC (UCSC platformer-vocabulary "momentum the geometry never offered" /
 * SMW Reverse Design launch & traffic blocks): the belt never moves its own body — it
 * IMPARTS a constant horizontal carry velocity to the player WHILE the player is
 * standing on its top. Each frame the player rests on the belt, `beltSpeed * direction`
 * is ADDED to the player body's x-velocity, so the player drifts in `direction` even
 * with no move input. To hold position the player must walk AGAINST the belt; to cross
 * they ride it. This is the lever a static layout cannot express: ground that pushes.
 *
 * DISTINCT FROM MovingPlatform (Round-2's spec) — that TRANSLATES its own body and
 * carries the rider along via the CarrierRideSystem carry seam. THIS belt stays put and
 * IMPARTS velocity to the player. Different momentum decision, different capability;
 * they compose (a moving belt) but are not the same component.
 *
 * HOW IT DETECTS "STANDING ON IT" WITHOUT TOUCHING THE SCENE/PLAYER CODE: each frame the
 * behavior reads its OWN owner (the belt sprite) and the live `scene.player`, and checks
 * that the player's body is RESTING on the belt's top — the player is falling-or-still
 * (vy ≳ 0), horizontally over the belt's footprint, and the player's feet sit at the
 * belt's top edge within a small tolerance. This is a pure read of the SAME physics state
 * the ground collider resolves (the read mirrors CrumblingPlatform.isStandingOn), so it
 * never desyncs and needs no scene edit. While that read is true, the belt conveys.
 *
 * HOW IT IMPARTS WITHOUT TRANSLATING THE BODY (the momentum, not a teleport): it adds
 * `beltSpeed * direction` to the player body's velocity via the canonical Phaser seam
 * `playerBody.velocity.x += carry`. The belt's own body is never moved. The carry is
 * applied AFTER the player's own move() has set its velocity for the frame (this runs in
 * the behavior update step), so the two compose: walking against the belt at exactly
 * `beltSpeed` cancels it; standing still drifts at `beltSpeed`.
 *
 * THE EVENT: `player.conveyed` fires on the frame the player FIRST mounts the belt
 * (lands on / steps onto / rides it — the terminus of a jump arc), then re-fires only
 * after the player leaves and re-mounts (a re-arm flag clears on leave). It is NOT
 * re-emitted every frame the player rides, so the log stays lean while the carry keeps
 * applying. The payload id is auto-derived from the belt owner's `__id` (the entity id
 * the level data stamped, DataLevelScene.ts:341), falling back to `config.id`.
 *
 * Params (all OPTIONAL — the design/HARDEN binds the feel; sensible defaults below):
 *   beltSpeed   magnitude of the carry velocity in px/s (default 120 — readable drift
 *               that a normal walk can fight against; the sign of `direction` decides which way).
 *   direction   carry direction: -1 (left) or +1 (right) (default +1 — right).
 *   id          base/fallback id for the emit payload when the belt owner carries no
 *               `__id` (the auto-derived `__id` is preferred; this is the fallback).
 */

/**
 * CAPABILITY — self-describing registry sidecar (capability-registry-harness).
 * Globbed by registry/build-registry.mjs; bound by the blueprint via `id`.
 * EDIT THIS, not capabilities.json.
 */
export const CAPABILITY = {
  kind: 'behavior',
  id: 'ConveyorBelt',
  intent:
    'A fixed platform that imparts a constant horizontal carry velocity (beltSpeed, signed direction) to the player each frame while the player stands on its top — momentum without translating the body; walk against it to hold position, ride it to cross. Emits player.conveyed.',
  roles: ['platform'],
  params: ['beltSpeed', 'direction', 'id'],
  tuning: ['beltSpeed'],
} as const;

export interface ConveyorBeltConfig {
  /** Magnitude of the carry velocity in px/s (default 120). */
  beltSpeed?: number;
  /** Carry direction: -1 (left) or +1 (right) (default +1). */
  direction?: -1 | 1;
  /** Base/fallback id for the payload when the belt owner carries no `__id`. */
  id?: string;
}

/** Vertical tolerance (px) for "player feet at the belt top" — the standing read. */
const STAND_TOL = 8;

export class ConveyorBelt extends BaseBehavior {
  /** Carry velocity magnitude (px/s). */
  public readonly beltSpeed: number;
  /** Carry direction (-1 left, +1 right). */
  public readonly direction: -1 | 1;
  /** Fallback id when the belt owner has no `__id`. */
  private readonly fallbackId: string;

  /** True once the player has mounted; cleared when they leave (one event per mount). */
  private mounted = false;

  constructor(config: ConveyorBeltConfig = {}) {
    super();
    this.beltSpeed = Math.max(0, config.beltSpeed ?? 120);
    this.direction = config.direction === -1 ? -1 : 1;
    this.fallbackId = config.id ?? 'conveyor';
  }

  /** The belt's stable id: its auto-derived `__id`, else the config fallback. */
  private beltId(): string {
    const owner = this.getOwner<any>();
    const tag = owner?.__id;
    return typeof tag === 'string' && tag.length ? tag : this.fallbackId;
  }

  /**
   * True iff `player` is currently RESTING on the top of the belt (this behavior's
   * owner): standing/falling (vy ≳ 0), horizontally over the belt footprint, and feet at
   * its top edge within tolerance. A pure read of the same physics state the ground
   * collider resolves — no scene edit needed (mirrors CrumblingPlatform.isStandingOn).
   */
  private isStandingOn(player: any): boolean {
    const belt = this.getOwner<Phaser.Physics.Arcade.Sprite>();
    const pb = player?.body as Phaser.Physics.Arcade.Body | undefined;
    const tb = belt?.body as Phaser.Physics.Arcade.Body | undefined;
    if (!pb || !tb || tb.enable === false) return false;
    // Rising hard (a jump leaving the belt) is not standing on it.
    if ((pb.velocity?.y ?? 0) < -1) return false;
    // Horizontal footprint overlap (player center within the belt span + a margin).
    const halfW = (tb.width ?? 0) / 2 + (pb.width ?? 0) / 2;
    if (Math.abs((player.x ?? 0) - (belt.x ?? 0)) > halfW) return false;
    // Player feet (body bottom) sit at the belt top within tolerance.
    const feet = pb.bottom ?? ((pb.y ?? 0) + (pb.height ?? 0));
    const top = tb.top ?? ((tb.y ?? 0) - (tb.height ?? 0) / 2);
    return Math.abs(feet - top) <= STAND_TOL;
  }

  /**
   * CONVEY the player THIS frame (the driving seam): add `beltSpeed * direction` to the
   * player's x-velocity — momentum, never a body translation — and, on the FIRST frame
   * of a mount, fire player.conveyed. Public so a unit test can drive the carry + event
   * without a full physics step (call convey(player) on a player whose body sits on the
   * belt). Idempotent on the event within one continuous ride; the carry applies every
   * call. Returns true iff this call newly mounted the player (the event fired).
   */
  convey(player: any): boolean {
    const pb = player?.body as Phaser.Physics.Arcade.Body | undefined;
    if (!pb) return false;

    // Impart the carry velocity (momentum — the belt's own body never moves).
    const carry = this.beltSpeed * this.direction;
    pb.velocity.x += carry;

    // One event per mount: fire only on the frame the player FIRST steps onto the belt.
    if (this.mounted) return false;
    this.mounted = true;
    // player.conveyed — the mount/ride moment on the shared bus. Id auto-derived from the
    // belt owner's __id (falls back to config.id). Lean + JSON-serializable.
    this.bus?.emit('player.conveyed', {
      id: this.beltId(),
      direction: this.direction,
      beltSpeed: this.beltSpeed,
    });
    return true;
  }

  /**
   * Per-frame: while the player rests on the belt, convey them (impart carry + emit on
   * first mount); clear the mount flag the moment the player leaves so a later re-mount
   * re-fires the event.
   */
  update(): void {
    const belt = this.getOwner<Phaser.Physics.Arcade.Sprite>();
    const scene = (belt as any)?.scene;
    const player = scene?.player;
    if (!player?.body) {
      this.mounted = false;
      return;
    }

    if (this.isStandingOn(player)) {
      this.convey(player);
    } else {
      // Off the belt: re-arm so the next mount fires player.conveyed again.
      this.mounted = false;
    }
  }

  /** True iff the player is currently mounted on (being conveyed by) this belt. */
  isConveying(): boolean {
    return this.mounted;
  }

  /** Clear mount state (e.g. on a level restart). */
  protected onDetach(): void {
    this.mounted = false;
  }

  /**
   * The uniform component surface. No PULL observable — the consequence is the player's
   * own velocity/position drift, which the core hook already exposes (__GAME__.player.x /
   * .vx); this behavior publishes no value of its own to poll. The PUSH channel declares
   * `player.conveyed`, fired by a real .emit() in convey() at the mount seam (driven by
   * the player landing on / riding the belt — the terminus of the 'jump' arc).
   *   - player.conveyed  ← convey() (the player first mounts the belt) [archetype]
   */
  surface(): ComponentSurface {
    return {
      observables: {},
      anchors: [],
      events: [
        {
          name: 'player.conveyed',
          payload: '{id,direction,beltSpeed}',
          scope: 'archetype',
          drivenBy:
            'jump (the player lands on / stands on / rides the belt — the terminus of the jump arc)',
          expect:
            "while standing on the belt, __GAME__.player.x drifts by beltSpeed each frame in 'direction' even with no move input; player.conveyed logged",
        },
      ],
    };
  }
}
