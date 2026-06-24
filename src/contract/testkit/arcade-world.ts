/**
 * arcade-world.ts — the lifted arcade-2D physics world for component DRIVE tests.
 *
 * EXTRACTED VERBATIM (generalized only as much as needed) from the proven, green
 * exemplar tests:
 *   - platformer/src/systems/__tests__/CrumblingPlatform.drive.test.ts  (makeBody +
 *     gravity integrator + the snap-only ground collider that reads `body.enable`)
 *   - platformer/src/systems/__tests__/OneWayPlatform.drive.test.ts     (the SAME world
 *     with a face-aware collider that honors `body.checkCollision.up/down` + `body.prev`)
 *
 * Both colliders are folded into ONE `makeArcadeWorld()`: the resolve step honors the
 * directional `checkCollision` faces (default all-true → behaves exactly like the
 * Crumbling snap collider) AND, when a platform's `checkCollision.down` is true and the
 * body is rising, bonks the head on the underside (the OneWay underside profile). `prev`
 * is stamped every step (the OneWay continuous-separation read; harmless to Crumbling,
 * which the world catches via the resting tolerance). Nothing returns a precomputed
 * "expected" value — support EMERGES from geometry + `body.enable` + the faces, exactly
 * as Phaser arcade's separateY does.
 *
 * Engine-agnostic — no Phaser/Three import (the whole point: no `window is not defined`).
 */

/** A minimal REAL arcade-physics body — the exact shape the engine + components read. */
export interface ArcadeBody {
  enable: boolean;
  width: number;
  height: number;
  /** Left edge (arcade `body.x`). */
  x: number;
  /** Top edge (arcade `body.y`). */
  y: number;
  prev: { x: number; y: number };
  velocity: { x: number; y: number };
  blocked: { down: boolean; up: boolean; left: boolean; right: boolean };
  touching: { down: boolean };
  checkCollision: { up: boolean; down: boolean; left: boolean; right: boolean };
  readonly bottom: number;
  readonly top: number;
  onFloor(): boolean;
}

export interface MakeBodyOpts {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The lifted arcade body. `x` is the CENTER; the body's `x` is the LEFT edge and `y` is the
 * TOP edge — bottom/top are live getters, `onFloor()` reads `blocked.down`, `prev` seeds at
 * the start position, and `checkCollision` defaults to all-true (a fully solid face profile;
 * OneWayPlatform toggles `up`/`down` each frame). Identical to the body in BOTH exemplars
 * (the union of their fields — Crumbling never reads `prev`/`checkCollision`, so the extra
 * fields are inert for it).
 */
export function makeBody(opts: MakeBodyOpts): ArcadeBody {
  const left = opts.x - opts.width / 2;
  const body: ArcadeBody = {
    enable: true,
    width: opts.width,
    height: opts.height,
    x: left,
    y: opts.y,
    prev: { x: left, y: opts.y },
    velocity: { x: 0, y: 0 },
    blocked: { down: false, up: false, left: false, right: false },
    touching: { down: false },
    checkCollision: { up: true, down: true, left: true, right: true },
    get bottom() {
      return this.y + this.height;
    },
    get top() {
      return this.y;
    },
    onFloor() {
      return this.blocked.down === true;
    },
  };
  return body;
}

/** Tuning for the integrator/collider — the exemplars' constants, exposed as overrides. */
export interface ArcadeWorldOpts {
  /** px/frame added to velocity.y each step (the exemplars' modest downward pull). */
  gravityPerFrame?: number;
}

export interface ArcadeWorld {
  readonly gravityPerFrame: number;
  /** Stamp `body.prev` to the current position (the OneWay prior-frame read). */
  stampPrev(actor: { body: ArcadeBody }): void;
  /** Gravity + Euler integrate one frame: `vy += g`, `y += vy`, x tracks `center.x`. */
  integrate(actor: { x: number; body: ArcadeBody }): void;
  /**
   * Resolve `actor` against every ENABLED platform body, honoring the directional
   * `checkCollision` faces. Descending onto a `checkCollision.up` top SNAPS the feet +
   * grounds; rising into a `checkCollision.down` underside bonks the head. A disabled body
   * (crumble flipped `enable=false`) is skipped — collision removed.
   */
  resolve(actor: { x: number; body: ArcadeBody }, platforms: Array<{ x: number; body: ArcadeBody }>): void;
}

/**
 * Build the arcade world (integrator + face-aware collider). `step()` in drivers.ts runs
 * stampPrev → integrate → (component update) → resolve, the exact engine order from both
 * exemplars (faces the component toggled this frame are honored on THIS frame's resolve).
 */
export function makeArcadeWorld(opts: ArcadeWorldOpts = {}): ArcadeWorld {
  const gravityPerFrame = opts.gravityPerFrame ?? 4;

  function stampPrev(actor: { body: ArcadeBody }): void {
    actor.body.prev.y = actor.body.y;
    actor.body.prev.x = actor.body.x;
  }

  function integrate(actor: { x: number; body: ArcadeBody }): void {
    const pb = actor.body;
    pb.velocity.y += gravityPerFrame;
    pb.y += pb.velocity.y;
    actor.x += pb.velocity.x;
    pb.x = actor.x - pb.width / 2;
  }

  function resolve(
    actor: { x: number; body: ArcadeBody },
    platforms: Array<{ x: number; body: ArcadeBody }>,
  ): void {
    const pb = actor.body;
    pb.blocked.down = false;
    pb.touching.down = false;
    pb.blocked.up = false;
    for (const plat of platforms) {
      const tb = plat.body;
      if (tb.enable === false) continue; // a crumbled platform no longer collides.
      const cc = tb.checkCollision ?? { up: true, down: true, left: true, right: true };
      const halfW = tb.width / 2 + pb.width / 2;
      const overX = Math.abs(actor.x - plat.x) <= halfW;
      if (!overX) continue;
      const top = tb.top;
      const bottom = tb.y + tb.height; // platform underside
      const feet = pb.bottom;
      const head = pb.top;
      const prevFeet = pb.prev.y + pb.height; // foot edge at the prior frame
      const prevHead = pb.prev.y; // head edge at the prior frame

      // DESCENDING onto the TOP face — only when checkCollision.up (the solid-from-above
      // profile). Continuous separation (speed-independent, as arcade separateY does):
      // feet crossed the top this frame, OR rest on it within a small tolerance. This form
      // is a strict superset of the Crumbling snap collider's one-frame window — it catches
      // the resting/landing body identically.
      if (cc.up === true && pb.velocity.y >= 0) {
        const crossedDown = prevFeet <= top + 0.5 && feet >= top;
        const restingOn = Math.abs(feet - top) <= Math.max(2, gravityPerFrame + 2);
        if (crossedDown || restingOn) {
          pb.y = top - pb.height; // SNAP feet to the top — supported from above.
          pb.velocity.y = 0;
          pb.blocked.down = true;
          pb.touching.down = true;
        }
      }

      // RISING into the UNDERSIDE (bottom) face — only when checkCollision.down (a fully
      // solid platform bonks a rising head). A one-way platform keeps down=false, so a
      // rising body passes straight through (no bonk).
      if (cc.down === true && pb.velocity.y < 0) {
        const crossedUp = prevHead >= bottom - 0.5 && head <= bottom;
        if (crossedUp) {
          pb.y = bottom; // SNAP head to the underside — blocked from rising further.
          pb.velocity.y = 0;
          pb.blocked.up = true;
        }
      }
    }
  }

  return { gravityPerFrame, stampPrev, integrate, resolve };
}
