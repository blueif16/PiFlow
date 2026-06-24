/**
 * ComboChain — a composable kind=system logic (the genre's DEFINING combat
 * mechanic). The Castle Crashers combo/juggle chain: each LANDED player hit within
 * `windowMs` of the previous one increments a combo counter; the window RESETS on
 * every connect and EXPIRES on a miss/timeout (or when the player is hit), dropping
 * the counter back to 0. This is the skill-expression payoff that turns 'attack'
 * from one verb into a read.
 *
 * Drives ONE observable: __GAME__.comboCount — a SCENE-OWNED scalar (`scene.comboCount`)
 * the core hook reads defensively off the active level scene (the same archetype-extras
 * pattern as moveCount/gold/lives). It is 0 until the first hit lands and RETURNS to 0
 * the frame the open window lapses.
 *
 * HIT SEAM (generic — re-derives nothing): a "landed player hit" is already announced
 * on the scene's shared EventBus by the engine — `enemy.damaged` (a non-lethal hit,
 * BaseEnemy.takeDamage) and `enemy.died` (a lethal kill, scene.onEnemyKilled). This
 * system POLL-subscribes to BOTH (the canonical hit signals), so it composes over ANY
 * platformer-combat weapon (melee, projectile, skill) with no melee/collision code of
 * its own. The combat-DROP signals — a player hit (`player.damaged`/`player.died`) and
 * the timeout — collapse the chain.
 *
 * Distinct from `meleeComboCount` (BasePlayer): that is a per-SWING animation
 * alternator (PlayerFSM reads % 2) with no decay window, no __GAME__ readout, no event,
 * and no reset-on-miss. This is the timed, decaying, observable juggle chain.
 *
 * Params (all OPTIONAL — sensible declared defaults):
 *   windowMs        ms the chain stays open after a connect before it lapses
 *                   (default 800 — a Castle-Crashers-style juggle window).
 *   dropOnPlayerHit collapse the chain when the player takes a hit (default true —
 *                   the contested-engagement read: getting hit costs your combo).
 *
 * No payload carries an entity id: the payload is the live `comboCount` scalar plus the
 * anchor coords (the last struck enemy, auto-derived from the hit event's {x,y}).
 */
import type { ISceneSystem } from '../scenes/level-data';
import { type ComponentSurface, type EventBus } from '@contract/component-surface';

/** CAPABILITY — self-describing registry sidecar (capability-registry-harness). */
export const CAPABILITY = {
  kind: 'system',
  id: 'ComboChain',
  intent:
    'Each landed player hit within a timing window extends a decaying combo chain (Castle Crashers juggle); the window resets on every connect and expires on a miss/timeout (or a player hit), dropping the count to 0. Drives the scene-owned __GAME__.comboCount.',
  attachesTo: 'scene',
  params: ['windowMs', 'dropOnPlayerHit'],
  roles: ['player', 'enemy'],
  tuning: ['windowMs'],
} as const;

export interface ComboChainConfig {
  /** Ms the chain stays open after a connect before it lapses (default 800). */
  windowMs?: number;
  /** Collapse the chain when the player is hit (default true). */
  dropOnPlayerHit?: boolean;
}

/** Default juggle window (ms) — a forgiving Castle-Crashers-style combo timing. */
const DEFAULT_WINDOW_MS = 800;

export class ComboChain implements ISceneSystem {
  private scene: any;
  private readonly windowMs: number;
  private readonly dropOnPlayerHit: boolean;

  private get bus(): EventBus | undefined {
    return (this.scene as any)?.eventBus;
  }

  /** The scene-owned chain length (mirrored onto `scene.comboCount` for the hook). */
  private count = 0;
  /** Scene-clock time (ms) of the most recent connect; -1 when no chain is open. */
  private lastHitAt = -1;
  /** The auto-derived anchor (last struck enemy position) for the drop payload. */
  private lastHitX = 0;
  private lastHitY = 0;
  /** Bus unsubscribe handles (cleared on reset/re-attach so listeners never stack). */
  private unsubscribers: Array<() => void> = [];

  constructor(params: ComboChainConfig = {}) {
    this.windowMs = params.windowMs ?? DEFAULT_WINDOW_MS;
    this.dropOnPlayerHit = params.dropOnPlayerHit ?? true;
  }

  reset(): void {
    // True level restart: detach listeners (attach() re-subscribes) and zero the
    // chain so a replayed level starts with no combo.
    this.detachListeners();
    this.count = 0;
    this.lastHitAt = -1;
    this.lastHitX = 0;
    this.lastHitY = 0;
    if (this.scene) this.scene.comboCount = 0;
  }

  attach(scene: any): void {
    this.scene = scene;
    this.detachListeners();
    // Publish the scene-owned scalar the core hook reads (__GAME__.comboCount).
    scene.comboCount = 0;
    const bus = scene?.eventBus;
    if (!bus?.on) return;
    // Every LANDED player hit is one of these two engine signals — subscribe to both.
    this.unsubscribers.push(bus.on('enemy.damaged', (p: any) => this.onHitLanded(p)));
    this.unsubscribers.push(bus.on('enemy.died', (p: any) => this.onHitLanded(p)));
    if (this.dropOnPlayerHit) {
      // Getting hit costs the chain (the contested-engagement read).
      this.unsubscribers.push(bus.on('player.damaged', () => this.dropChain()));
      this.unsubscribers.push(bus.on('player.died', () => this.dropChain()));
    }
  }

  update(): void {
    // The timeout edge: an open chain with no fresh connect inside the window lapses.
    if (this.count <= 0 || this.lastHitAt < 0) return;
    const now = this.scene?.time?.now ?? 0;
    if (now - this.lastHitAt > this.windowMs) this.dropChain();
  }

  /** A player hit landed: extend the chain, reset the window, fire combo.extended. */
  private onHitLanded(payload: any): void {
    const now = this.scene?.time?.now ?? 0;
    this.count += 1;
    this.lastHitAt = now;
    this.lastHitX = typeof payload?.x === 'number' ? payload.x : this.lastHitX;
    this.lastHitY = typeof payload?.y === 'number' ? payload.y : this.lastHitY;
    if (this.scene) this.scene.comboCount = this.count;
    // combo.extended — the chain grew by one (the observable __GAME__.comboCount++).
    // Anchor coords auto-derived from the struck enemy; the live count is the payload.
    this.bus?.emit('combo.extended', {
      count: this.count,
      x: this.lastHitX,
      y: this.lastHitY,
    });
  }

  /** The window lapsed / the player was hit: collapse the chain to 0, fire combo.dropped. */
  private dropChain(): void {
    if (this.count <= 0) return;
    const dropped = this.count;
    this.count = 0;
    this.lastHitAt = -1;
    if (this.scene) this.scene.comboCount = 0;
    // combo.dropped — the chain collapsed (the observable __GAME__.comboCount → 0).
    // The payload carries the count that was LOST (the read the player just forfeited).
    this.bus?.emit('combo.dropped', { count: dropped });
  }

  /** Remove every bus listener this system registered (idempotent). */
  private detachListeners(): void {
    for (const off of this.unsubscribers) {
      try {
        off();
      } catch {
        /* a stale unsubscribe must never crash reset/attach */
      }
    }
    this.unsubscribers = [];
  }

  /**
   * The uniform component surface — the two combo MOMENTS this system owns, each fired
   * from a real seam in THIS file on the scene's shared bus:
   *   - combo.extended ← onHitLanded (a hit landed inside the open window)  [archetype]
   *   - combo.dropped  ← dropChain   (the window lapsed / the player is hit) [archetype]
   */
  surface(): ComponentSurface {
    return {
      observables: {},
      anchors: [],
      events: [
        {
          name: 'combo.extended',
          payload: '{count,x,y}',
          scope: 'archetype',
          drivenBy: 'a player hit lands while the combo window is open',
          expect: '__GAME__.comboCount increases by 1; combo.extended logged',
        },
        {
          name: 'combo.dropped',
          payload: '{count}',
          scope: 'archetype',
          drivenBy: 'the combo window elapses with no new landed hit (or the player is hit)',
          expect: '__GAME__.comboCount returns to 0; combo.dropped logged',
        },
      ],
    };
  }
}
