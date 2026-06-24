/**
 * CrumblingPlatform — a composable kind=system that turns a platform into FOOTING
 * THAT DISAPPEARS once you stand on it.
 *
 * THE MECHANIC (design-rules.md temporary-platform / Celeste crumbling-bridge /
 * UCSC "force the player to make a quick decision"): a platform reads SOLID until
 * the player lands on it; landing ARMS a one-shot timer that cycles
 *   solid -> shaking (the telegraph, the last `telegraphMs` of the window)
 *         -> gone (collision removed at `crumbleMs`).
 * A player still standing on it when it vanishes is no longer supported — its
 * physics body is disabled, so the SDK's ground collider no longer holds the player
 * up, `player.isGrounded()` (a pure `body.onFloor()` read, PlatformerMovement.ts:207)
 * flips to false, and gravity drives `player.body.velocity.y` (→ __GAME__.player.vy)
 * positive: the player FALLS. Optionally the platform RESPAWNS (`respawnMs` after it
 * crumbled) so the route is repeatable. This is the urgency lever the static layout
 * cannot express: the footing has a shelf-life the moment you trust it.
 *
 * DISTINCT FROM CyclicHazard — that is a deadly REGION on a timer (overlap-while-ACTIVE
 * hurts you); this is FOOTING that ceases to exist (the consequence is the fall, not a
 * hit). They compose (a crumbling ledge over a hazard) but are different capabilities.
 *
 * HOW IT DETECTS "LANDED ON IT" WITHOUT TOUCHING THE SCENE/PLAYER CODE: each frame this
 * system reads the live platform bodies in `scene.groundLayer.getChildren()` and the live
 * `scene.player`. A platform is "stood on" when the player's body is RESTING on its top —
 * the player is falling-or-still (vy ≳ 0), horizontally over the platform's footprint, and
 * the player's feet sit at the platform's top edge (within a small tolerance). This is a
 * pure read of the SAME physics state the ground collider resolves, so it never desyncs and
 * needs no scene edit. The platform the player is currently resting on is ARMED.
 *
 * HOW IT REMOVES COLLISION (the disappear): on `crumbleMs` the platform's body is disabled
 * AND the sprite hidden via the canonical Phaser 3.90 seam `sprite.disableBody(true, true)`
 * — the body leaves collision AND the visual goes (a real, gone platform; its `__tileVisual`
 * decoration, if any, is hidden too). On `respawnMs` it is restored with
 * `enableBody(true, x, y, true, true)` at its original coordinate. The collider and the
 * scene are never edited.
 *
 * IDEMPOTENT + RESPAWN-SAFE: a per-platform record (keyed by the platform's auto-derived
 * `__id`, falling back to its `x,y`) holds the armed timer + phase, so landing again on an
 * already-armed platform does NOT re-arm or double-fire. reset() clears every record AND
 * re-enables any platform this system crumbled (the SDK calls reset() before attach() on a
 * true level restart per DataLevelScene.ts:374), so a replayed level starts with all footing
 * solid.
 *
 * Params (all OPTIONAL — the design/HARDEN binds the feel; sensible defaults below):
 *   crumbleMs    ms from landing to the platform vanishing (default 900 — long enough to
 *                read the shake and decide, short enough to feel urgent).
 *   telegraphMs  ms of the SHAKING warning window at the END of crumbleMs (default 350;
 *                clamped to <= crumbleMs). The platform shakes/tints for this final stretch.
 *   respawnMs    ms after crumbling to restore the platform (default 0 = never respawns;
 *                > 0 makes the route repeatable).
 *   platformIds  OPTIONAL allow-list of platform `__id`s this system governs (only these
 *                crumble). Absent => EVERY platform the player lands on is crumbling.
 *   id           base/fallback id for the emit payload when a crumbling platform carries no
 *                `__id` (the auto-derived `__id` is preferred; the fallback appends `x,y`).
 */
import type { ISceneSystem } from '../scenes/level-data';
import { type ComponentSurface, type EventBus } from '@contract/component-surface';

/** CAPABILITY — self-describing registry sidecar (capability-registry-harness). */
export const CAPABILITY = {
  kind: 'system',
  id: 'CrumblingPlatform',
  intent:
    'Once the player lands on a platform, cycle it solid -> shaking (telegraph) -> gone over crumbleMs, removing its collision so a player still on it falls (isGrounded -> false, vy -> positive); optionally respawn. Emits platform.crumbled.',
  attachesTo: 'scene',
  params: ['crumbleMs', 'telegraphMs', 'respawnMs', 'platformIds', 'id'],
  roles: ['platform'],
  tuning: ['crumbleMs', 'telegraphMs', 'respawnMs'],
} as const;

export interface CrumblingPlatformConfig {
  /** ms from landing to the platform vanishing (default 900). */
  crumbleMs?: number;
  /** ms of the SHAKING warning window at the end of crumbleMs (default 350, clamped <= crumbleMs). */
  telegraphMs?: number;
  /** ms after crumbling to restore the platform (default 0 = never respawns). */
  respawnMs?: number;
  /** OPTIONAL allow-list of platform `__id`s that crumble (absent => every platform). */
  platformIds?: string[];
  /** Base/fallback id for the payload when a platform carries no `__id`. */
  id?: string;
}

/** One crumbling platform's lifecycle phase. Exposed so a test can read it. */
export type CrumblePhase = 'solid' | 'shaking' | 'gone';

/** Per-platform armed-timer record. */
interface CrumbleRecord {
  /** The live platform sprite this record governs. */
  platform: any;
  /** The resolved payload/key id (auto-derived from __id; falls back to x,y). */
  id: string;
  /** ms elapsed since the player armed this platform by landing on it. */
  elapsedMs: number;
  /** Current phase. */
  phase: CrumblePhase;
  /** ms since the platform went 'gone' (for the optional respawn), or -1 while solid/shaking. */
  goneMs: number;
  /** The platform's original spawn coordinate, captured at arm time (for respawn). */
  origin: { x: number; y: number };
}

/** Vertical tolerance (px) for "player feet at the platform top" — the standing read. */
const STAND_TOL = 8;

export class CrumblingPlatform implements ISceneSystem {
  private scene: any;
  private readonly crumbleMs: number;
  private readonly telegraphMs: number;
  private readonly respawnMs: number;
  private readonly platformIds?: Set<string>;
  private readonly fallbackId: string;

  private get bus(): EventBus | undefined {
    return (this.scene as any)?.eventBus;
  }

  /** id -> armed-timer record for every platform the player has landed on. */
  private readonly armed = new Map<string, CrumbleRecord>();

  constructor(params: CrumblingPlatformConfig = {}) {
    this.crumbleMs = Math.max(1, params.crumbleMs ?? 900);
    // The telegraph is the FINAL stretch of the window — never longer than the window.
    this.telegraphMs = Math.min(this.crumbleMs, Math.max(0, params.telegraphMs ?? 350));
    this.respawnMs = Math.max(0, params.respawnMs ?? 0);
    this.platformIds = params.platformIds && params.platformIds.length
      ? new Set(params.platformIds)
      : undefined;
    this.fallbackId = params.id ?? 'platform';
  }

  reset(): void {
    // True level restart: re-solidify every platform this system crumbled, then drop
    // all records so a replayed level starts with every footing solid.
    for (const rec of this.armed.values()) {
      if (rec.phase === 'gone') this.restore(rec);
    }
    this.armed.clear();
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

  /**
   * True iff the player is currently RESTING on the top of `plat`: standing/falling
   * (vy ≳ 0), horizontally over the platform footprint, and feet at its top edge. A pure
   * read of the same physics state the ground collider resolves — no scene edit needed.
   */
  private isStandingOn(player: any, plat: any): boolean {
    const pb = player?.body;
    const tb = plat?.body;
    if (!pb || !tb || tb.enable === false) return false;
    // Not rising (a jump arc is leaving, not landing on, the platform).
    if ((pb.velocity?.y ?? 0) < -1) return false;
    // Horizontal footprint overlap (player center within the platform span + a margin).
    const halfW = (tb.width ?? 0) / 2 + (pb.width ?? 0) / 2;
    if (Math.abs((player.x ?? 0) - (plat.x ?? 0)) > halfW) return false;
    // Player feet (body bottom) sit at the platform top within tolerance.
    const feet = pb.bottom ?? ((pb.y ?? 0) + (pb.height ?? 0));
    const top = tb.top ?? ((tb.y ?? 0) - (tb.height ?? 0) / 2);
    return Math.abs(feet - top) <= STAND_TOL;
  }

  /**
   * ARM a platform on landing (the driving moment): start its solid->shaking->gone
   * timer. Idempotent — a re-land on an already-armed platform is a no-op. Public so a
   * unit test can drive the landing without a full physics step.
   */
  landOn(plat: any): void {
    if (!plat || !this.governs(plat)) return;
    const id = this.platformId(plat);
    if (this.armed.has(id)) return; // already counting down (or gone) — don't re-arm.
    this.armed.set(id, {
      platform: plat,
      id,
      elapsedMs: 0,
      phase: 'solid',
      goneMs: -1,
      origin: { x: plat.x ?? 0, y: plat.y ?? 0 },
    });
  }

  /**
   * CRUMBLE a platform NOW: remove its collision, hide it, and fire platform.crumbled.
   * The single seam that makes the footing vanish — driven by the timer in update(), and
   * callable directly by a test to drive the verb's outcome. Idempotent (a gone platform
   * stays gone).
   */
  crumble(plat: any): void {
    if (!plat) return;
    const id = this.platformId(plat);
    let rec = this.armed.get(id);
    if (!rec) {
      // A direct crumble (e.g. a test) on an un-armed platform: arm-then-crumble.
      this.landOn(plat);
      rec = this.armed.get(id);
      if (!rec) return;
    }
    if (rec.phase === 'gone') return; // already crumbled — no double-fire.
    rec.phase = 'gone';
    rec.goneMs = 0;
    // Remove collision AND hide the platform (the canonical Phaser 3.90 disappear seam).
    plat.disableBody?.(true, true);
    // Hide any seamless tile decoration pinned over the body (createPlatform __tileVisual).
    plat.__tileVisual?.setVisible?.(false);
    // platform.crumbled — the footing-gone moment on the shared bus. Id auto-derived from
    // the platform's __id (falls back to a coord-keyed id). Lean + JSON-serializable.
    this.bus?.emit('platform.crumbled', {
      id: rec.id,
      x: rec.origin.x,
      y: rec.origin.y,
    });
  }

  /** Restore a crumbled platform (the optional respawn): re-enable body + show. */
  private restore(rec: CrumbleRecord): void {
    const plat = rec.platform;
    plat?.enableBody?.(true, rec.origin.x, rec.origin.y, true, true);
    plat?.__tileVisual?.setVisible?.(true);
    plat?.clearTint?.();
    rec.phase = 'solid';
    rec.elapsedMs = 0;
    rec.goneMs = -1;
  }

  /** Apply the per-phase visual (shake jitter + warning tint) — minimal, generic, no theme. */
  private applyPhaseVisual(plat: any, phase: CrumblePhase, elapsedMs: number): void {
    if (phase !== 'shaking') {
      plat?.clearTint?.();
      return;
    }
    // SHAKING: a warning tint + a small horizontal jitter around the original x, so the
    // doomed footing is unmistakably announced before it goes.
    plat?.setTint?.(0xffb454);
    const jitter = Math.sin(elapsedMs / 24) * 2;
    plat?.setX?.((plat.__crumbleBaseX ?? plat.x ?? 0) + jitter);
  }

  /**
   * Per-frame: (1) ARM the platform the player is resting on; (2) advance every armed
   * timer through solid -> shaking -> gone, crumbling on `crumbleMs`; (3) respawn a gone
   * platform after `respawnMs` (when enabled).
   */
  update(): void {
    const scene = this.scene;
    const player = scene?.player;
    if (!player) return;
    const dt = scene.game?.loop?.delta ?? 16;

    // (1) Arm the platform the player is currently standing on (the landing moment).
    for (const plat of this.platforms()) {
      if (plat?.body?.enable === false) continue; // a gone platform can't be landed on.
      if (this.isStandingOn(player, plat)) this.landOn(plat);
    }

    // (2)/(3) Advance every armed timer.
    const shakeStart = this.crumbleMs - this.telegraphMs;
    for (const rec of [...this.armed.values()]) {
      if (rec.phase === 'gone') {
        // Optional respawn: restore after respawnMs, then forget the record so the
        // platform can be re-armed by a fresh landing.
        if (this.respawnMs > 0) {
          rec.goneMs += dt;
          if (rec.goneMs >= this.respawnMs) {
            this.restore(rec);
            this.armed.delete(rec.id);
          }
        }
        continue;
      }
      rec.elapsedMs += dt;
      const plat = rec.platform;
      // Capture the base x once so the shake jitters around the real resting position.
      if (plat && plat.__crumbleBaseX === undefined) plat.__crumbleBaseX = plat.x ?? 0;
      if (rec.elapsedMs >= this.crumbleMs) {
        // Window over: the footing vanishes (collision removed, event fired).
        this.crumble(plat);
        continue;
      }
      // Phase transition: solid -> shaking once we enter the telegraph window.
      const nextPhase: CrumblePhase = rec.elapsedMs >= shakeStart ? 'shaking' : 'solid';
      if (nextPhase !== rec.phase) rec.phase = nextPhase;
      this.applyPhaseVisual(plat, rec.phase, rec.elapsedMs);
    }
  }

  /** The phase of the platform with id (test/inspection read), or undefined if not armed. */
  phaseOf(id: string): CrumblePhase | undefined {
    return this.armed.get(id)?.phase;
  }

  /**
   * The uniform component surface. No PULL observable (the consequence is the player's own
   * isGrounded/vy, which the core hook already exposes — this system publishes no value of
   * its own to poll). The PUSH channel declares `platform.crumbled`, fired by a real
   * .emit() in crumble() at the footing-gone seam (driven by the player standing past
   * crumbleMs without jumping off — the 'jump' verb is the escape that AVOIDS it).
   *   - platform.crumbled  ← crumble() (the platform's collision is removed) [archetype]
   */
  surface(): ComponentSurface {
    return {
      observables: {},
      anchors: [],
      events: [
        {
          name: 'platform.crumbled',
          payload: '{id,x,y}',
          scope: 'archetype',
          drivenBy:
            'the player stands on the platform until its crumbleMs timer elapses (and does not jump off in time)',
          expect:
            "the platform's collision is removed; a player still on it sees __GAME__.player.isGrounded flip to false and player.vy go positive (falls); platform.crumbled logged",
        },
      ],
    };
  }
}
