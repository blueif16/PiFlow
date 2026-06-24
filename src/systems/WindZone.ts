/**
 * WindZone — a composable kind=system that turns a declared rectangular region into
 * a WIND FIELD that bends the jump arc while the player is inside it.
 *
 * THE MECHANIC (Celeste wind; celeste.ink/wiki/Wind — "down-wind limits jump height +
 * faster fall; up-wind floatier + higher; 4C crazy wind blocks the return without
 * dashing"): a region declared in level DATA carries a constant directional force
 * (dirX/dirY x force). Each frame the player's body center is INSIDE the region, this
 * system ADDS that force to the player's velocity — so an UPDRAFT (dirY < 0) cancels
 * part of gravity (the player rises higher / falls floatier, the apex of a jump from
 * the SAME jumpPower sits measurably higher), and a SIDE-WIND (dirX != 0) pushes the
 * whole trajectory sideways. The instant the player LEAVES the region the force stops
 * being added and the arc snaps back to the normal gravityY/jumpPower curve. This is
 * the only thing in the kit that BENDS the globally-fixed gravityY/jumpPower locally —
 * a region reshaping the SAME tuned curve PlatformerMovement produces, not a new one.
 *
 * COMPOSES WITH PlatformerMovement, never replaces it: movement still owns walk + jump
 * + the maxFallSpeed clamp; this system only adds a per-frame velocity delta on top,
 * so the felt jump tuning is preserved and merely reshaped inside the field.
 *
 * HOW IT READS "INSIDE" WITHOUT TOUCHING THE SCENE/PLAYER CODE: each frame it reads the
 * live `scene.player` center (player.x / player.y) against each region's AABB
 * (a pure rect-contains test) — the same display-position read CollectScore uses, so a
 * placement GIVEN that relocates the player registers on the immediate next frame with
 * no physics-step wait. It applies the force by mutating the live arcade body velocity
 * (body.velocity.x/y += force x dir, the same body KnockbackImpulse pushes), so the
 * consequence falls OUT as the player's own __GAME__.player.vx/vy — the core hook
 * already exposes those; this system publishes no PULL value of its own.
 *
 * ENTER / LEAVE are EDGES, force is CONTINUOUS: a per-region `inside` latch fires
 * `player.enteredWind` on the false->true transition (the entry moment) and
 * `player.leftWind` on the true->false transition (the exit moment) — exactly once per
 * crossing, never per frame — while the force itself is added every frame the player is
 * inside. So the events mark the boundary crossings and the velocity delta is the
 * sustained reshaping in between.
 *
 * IDEMPOTENT + RESPAWN-SAFE: the only run state is the per-region `inside` boolean; it
 * holds no level geometry of its own beyond the declared regions. reset() clears every
 * `inside` latch on a true level restart (the SDK calls reset() before attach() per
 * DataLevelScene.ts:374), so a replayed level starts with the player treated as OUTSIDE
 * every region — the next frame inside re-fires enteredWind cleanly.
 *
 * REGION SOURCE (level DATA): a single region is the common case (x/y/width/height
 * params); `regions[]` declares several wind fields in one binding. Each region's `id`
 * is auto-derived from its declared `id` field, falling back to the config base `id`
 * (then an index-keyed id) — the ID-SOURCE convention: a config param default as the
 * base/fallback, the region's own declared id preferred.
 *
 * Params (all OPTIONAL — the design/HARDEN binds the field; sensible defaults below):
 *   x,y,width,height  the single wind region's rect (TOP-LEFT x,y + size). Absent =>
 *                     no single region (use `regions[]`). The blueprint/layout
 *                     TOP-LEFT convention (matches PlatformData x/y).
 *   dirX,dirY         the wind direction unit (default 0,-1 = a pure updraft). Combined
 *                     with `force` into the per-frame velocity delta. dirY<0 = updraft
 *                     (floatier/higher), dirY>0 = down-wind (limits jump, faster fall),
 *                     dirX!=0 = side-wind (pushes the trajectory).
 *   force             the wind strength in px/s added per frame along (dirX,dirY)
 *                     (default 520 — strong enough that an updraft's apex clears a
 *                     normal jump's by a readable margin, gentle enough not to fling).
 *   regions           OPTIONAL list of {id?,x,y,width,height,dirX?,dirY?,force?} wind
 *                     fields; each may override dir/force, else inherits the top-level
 *                     default. Absent + a single x/y/w/h => the one region above.
 *   id                base/fallback id for the emit payload when a region carries no
 *                     declared `id` (the region's own `id` is preferred).
 */
import type { ISceneSystem } from '../scenes/level-data';
import { type ComponentSurface, type EventBus } from '@contract/component-surface';

/** CAPABILITY — self-describing registry sidecar (capability-registry-harness). */
export const CAPABILITY = {
  kind: 'system',
  id: 'WindZone',
  intent:
    'A declared rectangular region that adds a constant directional force (dirX/dirY x force) to the player velocity each frame the player is inside it, reshaping the jump arc (updraft = higher/floatier, side-wind = pushed trajectory); on leaving, the force stops and the arc returns to normal. Emits player.enteredWind / player.leftWind.',
  attachesTo: 'scene',
  params: ['x', 'y', 'width', 'height', 'dirX', 'dirY', 'force', 'regions', 'id'],
  roles: ['player'],
  tuning: ['force', 'dirX', 'dirY'],
} as const;

/** One declared wind region (a rect + an optional per-region direction/strength override). */
export interface WindRegionData {
  /** This region's id (preferred payload id; falls back to the config base id). */
  id?: string;
  /** Region rect TOP-LEFT x and size (the blueprint/layout convention). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Per-region wind direction unit override (else inherits the top-level default). */
  dirX?: number;
  dirY?: number;
  /** Per-region wind strength (px/s) override (else inherits the top-level default). */
  force?: number;
}

export interface WindZoneConfig {
  /** The single wind region's rect (TOP-LEFT x,y + size). Absent => use `regions[]`. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Default wind direction unit (default 0,-1 = updraft). */
  dirX?: number;
  dirY?: number;
  /** Default wind strength in px/s added per frame along (dirX,dirY) (default 520). */
  force?: number;
  /** OPTIONAL list of wind regions; each may override dir/force. */
  regions?: WindRegionData[];
  /** Base/fallback id for the payload when a region carries no declared `id`. */
  id?: string;
}

/** A resolved, ready-to-tick wind region (rect + direction + strength + the inside latch). */
interface ResolvedRegion {
  /** The payload/key id (declared region id; falls back to config base id, then index). */
  id: string;
  /** Region rect TOP-LEFT x,y + size. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** This region's wind direction unit. */
  dirX: number;
  dirY: number;
  /** This region's wind strength (px/s). */
  force: number;
  /** Whether the player was inside this region last frame (the enter/leave edge latch). */
  inside: boolean;
}

export class WindZone implements ISceneSystem {
  private scene: any;
  private readonly defaultDirX: number;
  private readonly defaultDirY: number;
  private readonly defaultForce: number;
  private readonly fallbackId: string;
  private readonly regions: ResolvedRegion[] = [];

  private get bus(): EventBus | undefined {
    return (this.scene as any)?.eventBus;
  }

  constructor(params: WindZoneConfig = {}) {
    this.defaultDirX = params.dirX ?? 0;
    this.defaultDirY = params.dirY ?? -1;
    this.defaultForce = params.force ?? 520;
    this.fallbackId = params.id ?? 'wind';

    // Collect the declared regions: the single x/y/w/h rect (when given) + any regions[].
    const declared: WindRegionData[] = [];
    if (
      typeof params.x === 'number' &&
      typeof params.y === 'number' &&
      typeof params.width === 'number' &&
      typeof params.height === 'number'
    ) {
      declared.push({ id: params.id, x: params.x, y: params.y, width: params.width, height: params.height });
    }
    if (Array.isArray(params.regions)) declared.push(...params.regions);

    declared.forEach((r, i) => {
      this.regions.push({
        id: r.id ?? (declared.length > 1 ? `${this.fallbackId}#${i}` : this.fallbackId),
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        dirX: r.dirX ?? this.defaultDirX,
        dirY: r.dirY ?? this.defaultDirY,
        force: r.force ?? this.defaultForce,
        inside: false,
      });
    });
  }

  reset(): void {
    // True level restart: treat the player as OUTSIDE every region so the next frame
    // inside re-fires enteredWind cleanly (no stale latch from the prior life).
    for (const region of this.regions) region.inside = false;
  }

  attach(scene: any): void {
    this.scene = scene;
  }

  /** True iff the point (px,py) is within this region's AABB (a pure rect-contains read). */
  private contains(region: ResolvedRegion, px: number, py: number): boolean {
    return (
      px >= region.x &&
      px <= region.x + region.width &&
      py >= region.y &&
      py <= region.y + region.height
    );
  }

  /**
   * The driving seam: for the given player, for every region, (a) fire the enter/leave
   * EDGE event on a boundary crossing, and (b) while inside, ADD the wind force to the
   * player's velocity this frame — the velocity delta that reshapes the jump arc. Public
   * so a test can drive it against a real arcade body WITHOUT a full scene/physics loop
   * (drive: move the player into a region and call this; observe body.velocity gain the
   * force + player.enteredWind on the bus). Returns the number of regions the player is
   * currently inside (a convenience read; 0 => the arc is on the normal curve).
   */
  applyWindIfInside(player: any): number {
    const body = player?.body;
    if (!body) return 0;
    const px = player.x ?? 0;
    const py = player.y ?? 0;
    let insideCount = 0;

    for (const region of this.regions) {
      const isInside = this.contains(region, px, py);

      if (isInside && !region.inside) {
        // ENTER edge: the player crossed into the field this frame.
        region.inside = true;
        this.bus?.emit('player.enteredWind', {
          id: region.id,
          dirX: region.dirX,
          dirY: region.dirY,
          force: region.force,
        });
      } else if (!isInside && region.inside) {
        // LEAVE edge: the player crossed out — the force stops, arc returns to normal.
        region.inside = false;
        this.bus?.emit('player.leftWind', { id: region.id });
      }

      if (isInside) {
        insideCount += 1;
        // CONTINUOUS: add this region's force to the live arcade body velocity. Mutating
        // body.velocity directly (the same body KnockbackImpulse pushes) ADDS to the
        // movement+gravity the engine already integrated this frame, so an updraft cancels
        // part of gravity (apex rises) and a side-wind shifts the trajectory. The
        // consequence falls out as the player's own __GAME__.player.vx/vy.
        const dt = (this.scene?.game?.loop?.delta ?? 16) / 1000; // s/frame (force is px/s)
        body.velocity.x += region.dirX * region.force * dt;
        body.velocity.y += region.dirY * region.force * dt;
      }
    }
    return insideCount;
  }

  /**
   * Per-frame: drive the wind field against the live player (the exact DataLevelScene
   * per-frame call). Fires the enter/leave edges and applies the in-field force.
   */
  update(): void {
    const player = this.scene?.player;
    if (!player) return;
    this.applyWindIfInside(player);
  }

  /** Whether the player is currently inside the region with `id` (test/inspection read). */
  isInside(id: string): boolean {
    const region = this.regions.find((r) => r.id === id);
    return region ? region.inside : false;
  }

  /**
   * The uniform component surface. No PULL observable — the consequence is the player's
   * OWN velocity (__GAME__.player.vx/vy), which the core hook already exposes; this system
   * publishes no value of its own to poll. The PUSH channel declares the two boundary
   * moments, each fired by a real .emit() in applyWindIfInside() at the true crossing seam
   * (driven by the player jumping/moving across the region boundary).
   *   - player.enteredWind ← applyWindIfInside (the player crosses INTO the field) [archetype]
   *   - player.leftWind    ← applyWindIfInside (the player crosses OUT of the field) [archetype]
   */
  surface(): ComponentSurface {
    return {
      observables: {},
      anchors: [],
      events: [
        {
          name: 'player.enteredWind',
          payload: '{id,dirX,dirY,force}',
          scope: 'archetype',
          drivenBy: 'jump (the player jumps/moves into the wind region)',
          expect:
            "the player's __GAME__.player.vy/vx gain the wind force each frame — e.g. an updraft makes the apex measurably higher than a normal jump from the same jumpPower; player.enteredWind logged",
        },
        {
          name: 'player.leftWind',
          payload: '{id}',
          scope: 'archetype',
          drivenBy: 'jump (the player exits the wind region)',
          expect:
            'the wind force stops and the player arc returns to the normal gravityY/jumpPower curve; player.leftWind logged',
        },
      ],
    };
  }
}
