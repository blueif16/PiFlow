/**
 * OneWayPlatform — a composable kind=system that turns a declared set of platform
 * bodies into JUMP-THROUGH footing: SOLID only when the player approaches from
 * ABOVE (landing/standing on top), PASS-THROUGH when the player rises into it from
 * below.
 *
 * THE MECHANIC (the canonical jump-through rule — celeste.ink/wiki/Entities
 * "Jumpthrough" = passable from below, and higherorderfun.com's platformer guide =
 * "solid only when the player was above the platform top last frame"): each frame
 * this system compares the player's PRIOR-frame foot edge (body.prev.y projected to
 * the body bottom) against each governed platform's top edge. If the player's feet
 * were AT-OR-ABOVE the platform top last frame, the platform collides (the player
 * lands/stands on it). If the player's feet were BELOW the platform top last frame,
 * the platform's downward collision face is disabled so the player rises straight up
 * THROUGH it — no collision, no bonk. The toggle is per-platform, recomputed every
 * frame, so a player who jumps up through a ledge and arcs back down onto it lands
 * cleanly.
 *
 * DISTINCT FROM every current platform (unconditionally-solid createTileMap geometry,
 * collidable from all four sides) and from CrumblingPlatform (Round 2's footing that
 * DESTROYS itself once stood on). This one never destroys footing — it CONDITIONS the
 * collision on approach direction. They compose (a one-way ledge that also crumbles),
 * but are different capabilities.
 *
 * HOW IT TOGGLES COLLISION WITHOUT TOUCHING THE SCENE/PLAYER CODE: each frame it reads
 * the live platform bodies in `scene.groundLayer.getChildren()` and the live
 * `scene.player`, and sets each governed platform body's `checkCollision` directional
 * flags. Phaser Arcade resolves the static-vs-dynamic overlap with those flags:
 *   - solid-from-above  => checkCollision.up = true  (player.body bottom hits plat top)
 *   - pass-through      => checkCollision.down = false, .up = false (no resolution as
 *                          the player rises into it from below)
 * Disabling `down` (and `up`) for the pass-through frames lets the rising player travel
 * straight through; the collider and the scene are never edited. The horizontal faces
 * (.left/.right) are always off for a one-way platform so the player never bonks its sides.
 *
 * THE TWO MOMENTS (the PUSH channel):
 *   - platform.passedThrough  ← the player rises UP into a governed platform from below
 *     (feet were below the platform top last frame AND the body is moving up): collision
 *     is suppressed and the player crosses the top with isGrounded staying false.
 *   - platform.landedOn       ← the player descends ONTO a governed platform from above
 *     (feet were at-or-above the top last frame AND the player comes to rest on it):
 *     isGrounded flips true and the player rests at the platform top.
 * Each fires ONCE per crossing/landing (a per-platform latch), re-armed when the player
 * leaves, so a held key doesn't spam the bus.
 *
 * IDEMPOTENT + RESTART-SAFE: a per-platform record (keyed by the platform's auto-derived
 * `__id`, falling back to its `x,y`) holds the last-known relationship + the fired latches.
 * reset() clears every record AND restores full collision on every platform this system
 * touched (the SDK calls reset() before attach() on a true level restart per
 * DataLevelScene.ts:374), so a replayed level starts with every governed platform solid.
 *
 * Params (all OPTIONAL — the design/HARDEN binds the feel; sensible defaults below):
 *   platformIds  OPTIONAL allow-list of platform `__id`s this system governs (only these
 *                become one-way). Absent => EVERY platform is one-way (jump-through).
 *   tolerance    px tolerance for the "feet were above the top" comparison (default 4).
 *   id           base/fallback id for the emit payload when a platform carries no `__id`
 *                (the auto-derived `__id` is preferred; the fallback appends `x,y`).
 */
import type { ISceneSystem } from '../scenes/level-data';
import { type ComponentSurface, type EventBus } from '@contract/component-surface';

/** CAPABILITY — self-describing registry sidecar (capability-registry-harness). */
export const CAPABILITY = {
  kind: 'system',
  id: 'OneWayPlatform',
  intent:
    'Govern a declared set of platform bodies as JUMP-THROUGH footing: SOLID only when the player approached from above last frame (land/stand on top), PASS-THROUGH when the player rises into it from below. Each frame it toggles the body checkCollision faces per the player prior-vs-current top edge. Emits platform.landedOn and platform.passedThrough.',
  attachesTo: 'scene',
  params: ['platformIds', 'tolerance', 'id'],
  roles: ['platform'],
  tuning: ['tolerance'],
} as const;

export interface OneWayPlatformConfig {
  /** OPTIONAL allow-list of platform `__id`s that become one-way (absent => all). */
  platformIds?: string[];
  /** px tolerance for the "feet were above the platform top last frame" read (default 4). */
  tolerance?: number;
  /** Base/fallback id for the payload when a platform carries no `__id`. */
  id?: string;
}

/** The player's relationship to one governed platform, frame over frame. */
type Relation = 'above' | 'below' | 'unknown';

/** Per-platform record: the live body + the last relationship + the fired latches. */
interface PlatformRecord {
  /** The live platform sprite this record governs. */
  platform: any;
  /** The resolved payload/key id (auto-derived from __id; falls back to x,y). */
  id: string;
  /** The player's relationship to this platform top last frame. */
  lastRelation: Relation;
  /** True once platform.landedOn fired for the current landing (re-armed on leave). */
  landedLatched: boolean;
  /** True once platform.passedThrough fired for the current upward crossing. */
  passedLatched: boolean;
}

export class OneWayPlatform implements ISceneSystem {
  private scene: any;
  private readonly platformIds?: Set<string>;
  private readonly tolerance: number;
  private readonly fallbackId: string;

  private get bus(): EventBus | undefined {
    return (this.scene as any)?.eventBus;
  }

  /** id -> per-platform record for every governed platform. */
  private readonly records = new Map<string, PlatformRecord>();

  constructor(params: OneWayPlatformConfig = {}) {
    this.platformIds = params.platformIds && params.platformIds.length
      ? new Set(params.platformIds)
      : undefined;
    this.tolerance = Math.max(0, params.tolerance ?? 4);
    this.fallbackId = params.id ?? 'platform';
  }

  reset(): void {
    // True level restart: restore full collision on every platform we touched, then
    // drop all records so a replayed level starts with every footing solid-from-above.
    for (const rec of this.records.values()) this.restoreCollision(rec.platform);
    this.records.clear();
  }

  attach(scene: any): void {
    this.scene = scene;
  }

  /** A stable id for a platform: its auto-derived `__id`, else a fallback keyed on x,y. */
  private platformId(plat: any): string {
    const tag = plat?.__id;
    if (typeof tag === 'string' && tag.length) return tag;
    return `${this.fallbackId}@${Math.round(plat?.x ?? 0)},${Math.round(plat?.y ?? 0)}`;
  }

  /** True iff this platform is one this system governs (allow-list, or all when none). */
  private governs(plat: any): boolean {
    if (!this.platformIds) return true;
    const tag = plat?.__id;
    return typeof tag === 'string' && this.platformIds.has(tag);
  }

  /** The live platform bodies (groundLayer children); empty when no static group. */
  private platforms(): any[] {
    const children = this.scene?.groundLayer?.getChildren?.();
    return Array.isArray(children) ? children : [];
  }

  /** Get-or-create the per-platform record. */
  private recordFor(plat: any): PlatformRecord {
    const id = this.platformId(plat);
    let rec = this.records.get(id);
    if (!rec) {
      rec = { platform: plat, id, lastRelation: 'unknown', landedLatched: false, passedLatched: false };
      this.records.set(id, rec);
    }
    return rec;
  }

  /** The platform body's TOP edge (px). */
  private platformTop(plat: any): number {
    const tb = plat?.body;
    return tb?.top ?? ((tb?.y ?? plat?.y ?? 0) - (tb?.height ?? 0) / 2);
  }

  /** The player's foot edge (body bottom) for a given body-y. */
  private feetFor(pb: any, bodyY: number): number {
    return bodyY + (pb?.height ?? 0);
  }

  /** True iff the player's center is horizontally over the platform footprint. */
  private overFootprint(player: any, plat: any, pb: any, tb: any): boolean {
    const halfW = (tb?.width ?? 0) / 2 + (pb?.width ?? 0) / 2;
    return Math.abs((player?.x ?? 0) - (plat?.x ?? 0)) <= halfW;
  }

  /**
   * SOLIDIFY a platform's top face only (the one-way collision profile): collide when
   * the player comes from above, pass through from every other direction. Public so a
   * test can drive the "approached from above" outcome without a physics step.
   */
  solidFromAbove(plat: any): void {
    const tb = plat?.body;
    if (!tb?.checkCollision) return;
    tb.checkCollision.up = true;    // player.body bottom can rest on the platform top
    tb.checkCollision.down = false; // never block from below
    tb.checkCollision.left = false; // a one-way ledge never bonks the player's sides
    tb.checkCollision.right = false;
  }

  /**
   * MAKE a platform fully pass-through (the rising-from-below profile): no face collides,
   * so a player travelling up crosses straight through it. Public so a test can drive the
   * "rises into it from below" outcome without a physics step.
   */
  passThrough(plat: any): void {
    const tb = plat?.body;
    if (!tb?.checkCollision) return;
    tb.checkCollision.up = false;
    tb.checkCollision.down = false;
    tb.checkCollision.left = false;
    tb.checkCollision.right = false;
  }

  /** Restore full four-face collision (reset / un-governed). */
  private restoreCollision(plat: any): void {
    const tb = plat?.body;
    if (!tb?.checkCollision) return;
    tb.checkCollision.up = true;
    tb.checkCollision.down = true;
    tb.checkCollision.left = true;
    tb.checkCollision.right = true;
  }

  /**
   * Fire platform.landedOn for a platform the player has come to rest on from above.
   * The landing seam — driven by the player descending onto the top (the jump arc's
   * downswing). Latched so a held stand doesn't re-fire; public so a test can drive the
   * landing without a full physics step.
   */
  landFrom(plat: any): void {
    if (!plat || !this.governs(plat)) return;
    const rec = this.recordFor(plat);
    if (rec.landedLatched) return; // already announced this landing.
    rec.landedLatched = true;
    rec.passedLatched = false; // a fresh landing re-arms the pass-through latch.
    // platform.landedOn — the player rests on the platform top from above. Id auto-derived
    // from the platform's __id (falls back to a coord-keyed id). Lean + JSON-serializable.
    this.bus?.emit('platform.landedOn', {
      id: rec.id,
      x: Math.round(plat.x ?? 0),
      y: Math.round(this.platformTop(plat)),
    });
  }

  /**
   * Fire platform.passedThrough for a platform the player has just risen up into from
   * below. The jump-through seam — driven by the player jumping up so their feet cross
   * the platform top while moving up (no collision). Latched so one crossing fires once;
   * public so a test can drive the crossing without a full physics step.
   */
  passUp(plat: any): void {
    if (!plat || !this.governs(plat)) return;
    const rec = this.recordFor(plat);
    if (rec.passedLatched) return; // already announced this crossing.
    rec.passedLatched = true;
    rec.landedLatched = false; // having passed up, re-arm the landing latch for the descent.
    // platform.passedThrough — the player crossed the platform top from below without
    // colliding. Id auto-derived from the platform's __id. Lean + JSON-serializable.
    this.bus?.emit('platform.passedThrough', {
      id: rec.id,
      x: Math.round(plat.x ?? 0),
      y: Math.round(this.platformTop(plat)),
    });
  }

  /**
   * Per-frame: for every governed platform, compare the player's PRIOR-frame foot edge
   * to the platform top, toggle the body's collision profile accordingly, and fire the
   * crossing/landing moment at the true seam.
   */
  update(): void {
    const scene = this.scene;
    const player = scene?.player;
    const pb = player?.body;
    if (!player || !pb) return;

    for (const plat of this.platforms()) {
      const tb = plat?.body;
      if (!tb) continue;
      if (!this.governs(plat)) continue;

      const rec = this.recordFor(plat);
      const top = this.platformTop(plat);

      // The player's foot edge LAST frame: Phaser exposes the prior body position as
      // body.prev (set each step). Project it to the foot (body bottom). Fall back to the
      // current body-y when prev is unavailable (first frame).
      const prevBodyY = pb.prev?.y ?? pb.y ?? 0;
      const prevFeet = this.feetFor(pb, prevBodyY);
      const curFeet = this.feetFor(pb, pb.y ?? 0);
      const movingUp = (pb.velocity?.y ?? 0) < 0;
      const over = this.overFootprint(player, plat, pb, tb);

      // The canonical rule: solid ONLY when the player's feet were AT-OR-ABOVE the top
      // last frame. Otherwise (feet were below the top), let them pass through.
      const wasAbove = prevFeet <= top + this.tolerance;
      if (wasAbove) this.solidFromAbove(plat);
      else this.passThrough(plat);

      const relation: Relation = wasAbove ? 'above' : 'below';

      if (over) {
        // PASSED THROUGH: was below the top last frame, is at-or-above it now, moving up
        // — the player has risen up through the ledge.
        if (rec.lastRelation === 'below' && curFeet <= top + this.tolerance && movingUp) {
          this.passUp(plat);
        }
        // LANDED ON: was above last frame and has come to rest on the top (feet at the
        // top edge, not rising) — the player descended onto the ledge.
        else if (wasAbove && Math.abs(curFeet - top) <= this.tolerance && (pb.velocity?.y ?? 0) >= -1) {
          this.landFrom(plat);
        }
      } else {
        // Off the footprint: re-arm both latches so the next approach fires fresh.
        rec.landedLatched = false;
        rec.passedLatched = false;
      }

      rec.lastRelation = relation;
    }
  }

  /** The player's last-known relationship to a platform (test/inspection read). */
  relationOf(id: string): Relation | undefined {
    return this.records.get(id)?.lastRelation;
  }

  /**
   * The uniform component surface. No PULL observable (the consequence is the player's
   * own isGrounded/y, which the core hook already exposes — this system publishes no
   * value of its own to poll). The PUSH channel declares the two jump-through moments,
   * each fired by a real .emit() at its true seam (driven by the 'jump' verb: rising up
   * INTO a ledge fires platform.passedThrough; arcing back down ONTO it fires
   * platform.landedOn).
   *   - platform.passedThrough ← passUp()   (the player rises through from below) [archetype]
   *   - platform.landedOn      ← landFrom()  (the player rests on it from above)   [archetype]
   */
  surface(): ComponentSurface {
    return {
      observables: {},
      anchors: [],
      events: [
        {
          name: 'platform.passedThrough',
          payload: '{id,x,y}',
          scope: 'archetype',
          drivenBy: 'jump (the player rises up into the platform from below)',
          expect:
            "__GAME__.player.y crosses the platform top with __GAME__.player.isGrounded staying false (no collision); platform.passedThrough logged",
        },
        {
          name: 'platform.landedOn',
          payload: '{id,x,y}',
          scope: 'archetype',
          drivenBy: 'jump (the player descends onto the platform from above)',
          expect:
            "__GAME__.player.isGrounded flips true and __GAME__.player.y rests at the platform top; platform.landedOn logged",
        },
      ],
    };
  }
}
