/**
 * HitstunState — a composable kind=system that gives combat hits a STUN WINDOW.
 *
 * THE MECHANIC (Dead Cells–style stun; design-rules.md:110-129 "incapacitates a
 * target briefly … cancels most enemy attacks and attack combos"): when a hit lands
 * on an enemy, FREEZE that enemy's AI for a brief window — its PatrolAI/ChaseAI
 * movement and its melee/ranged/custom attacks all halt — then RELEASE it so the AI
 * resumes. The window is what opens the genre's engagement decision: the struck
 * enemy cannot advance or retaliate, enabling a follow-up. __GAME__ exposes
 * `hitstunRemaining` (ms), the time left on the longest active stun, counting down
 * to 0; during the window the struck enemy's entities[] x stays ~0 (it cannot move).
 *
 * Absent today (the gap this fills): isHurting/isInvulnerable on the player is a
 * damage-grace flash, NOT an AI disable; an enemy's setVelocity(0,0) on takeDamage
 * (BaseEnemy.ts:290 — that path is the death stop) is a one-frame event, not a stun
 * window. This system is the missing brief-incapacitation window.
 *
 * HOW IT DETECTS A HIT (scene-agnostic, leak-free POLLING — never a .on() listener,
 * which leaks across a scene RESTART per DataLevelScene.ts:75-77): every time an
 * enemy is hit, BaseEnemy.takeDamage() emits `enemy.damaged {id,x,y,health,damage}`
 * on the scene's shared EventBus (BaseEnemy.ts:269). Each frame this system reads the
 * bus log seam (eventBus.recent(sinceSeq)) for new `enemy.damaged` entries since its
 * last cursor and opens (or refreshes) a stun window for the struck enemy id. The
 * EventBus is the external observation surface that consumers POLL (component-surface
 * .ts:78-81) — this is the sanctioned poll-don't-subscribe path.
 *
 * HOW IT FREEZES THE AI WITHOUT TOUCHING THE ENEMY/AI CODE: the data-driven loader
 * runs the enemy AI FIRST, then the scene systems (DataLevelScene.ts:129 baseUpdate →
 * updateEnemies → behaviors.update sets PatrolAI/ChaseAI velocity, THEN line 136 runs
 * sys.update()). So each frame, for every still-stunned enemy, this system (a) zeroes
 * its body velocity AFTER the AI set it — overriding the AI's advance — and (b) holds
 * `isHurting = true`, which BaseEnemy.update() already reads to suppress executeAI()
 * and tryRangedAttack() (BaseEnemy.ts:207) and which gates takeDamage's own attack
 * paths, so the enemy can neither advance nor attack for the window. On window expiry
 * it clears `isHurting` (releasing the AI). The enemy class is never edited.
 *
 * IDEMPOTENT + RESPAWN-SAFE: a per-enemy-id map of remaining-ms holds the window; a
 * re-hit while stunned REFRESHES the window (does not stack). It re-reads live enemy
 * sprites each frame by `__id`. reset() clears the windows + the bus cursor on a true
 * level restart (the SDK calls reset() before attach() per DataLevelScene.ts:374), so
 * a replayed level starts with no stale stuns and re-reads the bus from the start.
 *
 * Params (all OPTIONAL — the design/HARDEN binds the feel; sensible defaults below):
 *   durationMs  the stun window length in ms (default 350 — a brief incapacitation,
 *               longer than the engine's 100ms hurt flash so the freeze is the felt
 *               effect, short enough to keep combat flowing).
 *   id          base/fallback entity id for the emit payload when a struck enemy
 *               carries no `__id` (the auto-derived `__id` is preferred).
 */
import type { ISceneSystem } from '../scenes/level-data';
import { type ComponentSurface, type EventBus } from '@contract/component-surface';

/** CAPABILITY — self-describing registry sidecar (capability-registry-harness). */
export const CAPABILITY = {
  kind: 'system',
  id: 'HitstunState',
  intent:
    'On a hit landing on an enemy, freeze its AI (PatrolAI/ChaseAI movement + its attacks) for a brief stun window then release — enabling follow-ups. Drives __GAME__.hitstunRemaining (ms, counting to 0) and emits entity.staggered.',
  attachesTo: 'scene',
  params: ['durationMs', 'id'],
  roles: ['enemy'],
  tuning: ['durationMs'],
} as const;

export interface HitstunStateConfig {
  /** Stun window length in ms (default 350). */
  durationMs?: number;
  /** Base/fallback entity id for the payload when a struck enemy carries no `__id`. */
  id?: string;
}

export class HitstunState implements ISceneSystem {
  private scene: any;
  private readonly durationMs: number;
  private readonly fallbackId: string;

  private get bus(): EventBus | undefined {
    return (this.scene as any)?.eventBus;
  }

  /** Struck-enemy id → ms remaining on its active stun window. */
  private readonly remaining = new Map<string, number>();
  /** Last EventBus seq this system consumed (poll-don't-subscribe cursor). */
  private cursor = 0;
  /** The longest active stun's remaining ms — the live `hitstunRemaining` value. */
  private maxRemaining = 0;

  constructor(params: HitstunStateConfig = {}) {
    this.durationMs = params.durationMs ?? 350;
    this.fallbackId = params.id ?? 'enemy';
  }

  reset(): void {
    // True level restart: drop every active stun + rewind the bus cursor so a
    // replayed level starts unstunned and re-reads `enemy.damaged` from the start.
    this.remaining.clear();
    this.cursor = 0;
    this.maxRemaining = 0;
    if (this.scene) this.scene.hitstunRemaining = 0;
  }

  attach(scene: any): void {
    this.scene = scene;
    // Start reading the bus from its current cursor (any pre-attach emits are not
    // ours to stun on). Expose the observable on the scene from frame zero.
    this.cursor = scene?.eventBus?.cursor ?? 0;
    this.maxRemaining = 0;
    scene.hitstunRemaining = 0;
  }

  /** A live enemy sprite by its `__id`, or undefined (re-read each frame). */
  private enemyById(id: string): any {
    const list = this.scene?.enemies?.getChildren?.();
    if (!list) return undefined;
    for (const e of list) {
      if (e && (e as any).__id === id) return e;
    }
    return undefined;
  }

  /**
   * Per-frame: (1) drain new `enemy.damaged` events → open/refresh a stun window;
   * (2) decay every active window, holding the struck enemy frozen until it hits 0.
   */
  update(): void {
    const scene = this.scene;
    if (!scene?.eventBus) return;

    // (1) Drain the bus log seam for hits since our cursor (poll, never subscribe).
    const fresh = scene.eventBus.recent(this.cursor);
    if (fresh.length) {
      this.cursor = scene.eventBus.cursor;
      for (const entry of fresh) {
        if (entry?.type !== 'enemy.damaged') continue;
        const id = (entry.payload as any)?.id ?? this.fallbackId;
        // Open OR refresh (a re-hit re-arms the window; it does not stack).
        const isNew = !this.remaining.has(id);
        this.remaining.set(id, this.durationMs);
        if (isNew) this.openStun(id, entry.payload);
      }
    }

    // (2) Decay each window by the real elapsed frame time; freeze + release.
    const dt = scene.game?.loop?.delta ?? 16;
    let longest = 0;
    for (const [id, ms] of [...this.remaining]) {
      const enemy = this.enemyById(id);
      const left = ms - dt;
      if (left <= 0 || !enemy || enemy.isDead) {
        // Window over (or the enemy is gone): RELEASE the AI.
        if (enemy && !enemy.isDead) enemy.isHurting = false;
        this.remaining.delete(id);
        continue;
      }
      this.remaining.set(id, left);
      // FREEZE: zero the velocity the AI set THIS frame and hold the attack-suppress
      // flag, so the enemy can neither advance nor attack during the window.
      enemy.setVelocity?.(0, 0);
      enemy.isHurting = true;
      if (left > longest) longest = left;
    }

    // (3) Publish the observable: ms left on the longest active stun, → 0 when none.
    this.maxRemaining = longest;
    scene.hitstunRemaining = longest;
  }

  /** Emit the staggered moment on the first frame an enemy's window opens. */
  private openStun(id: string, payload: any): void {
    // entity.staggered — the standardized stun-onset moment on the shared bus, at the
    // hit frame. Id is auto-derived from the struck enemy's __id (the `enemy.damaged`
    // payload carries it), falling back to the config base id. Lean + JSON-serializable.
    this.bus?.emit('entity.staggered', {
      id,
      x: (payload as any)?.x ?? 0,
      y: (payload as any)?.y ?? 0,
      durationMs: this.durationMs,
    });
  }

  /**
   * The uniform component surface. The PULL channel publishes `hitstunRemaining`
   * (this system's OWN computed value); the PUSH channel declares `entity.staggered`,
   * fired by a real .emit() in openStun (the window-open seam above).
   *   - hitstunRemaining  ← maxRemaining (longest active stun's ms; → 0 when none)
   *   - entity.staggered  ← openStun (a hit opens an enemy's stun window) [archetype]
   */
  surface(): ComponentSurface {
    return {
      observables: {
        hitstunRemaining: () => this.maxRemaining,
      },
      anchors: [],
      events: [
        {
          name: 'entity.staggered',
          payload: '{id,x,y,durationMs}',
          scope: 'archetype',
          drivenBy: 'a hit lands on an enemy (the scene hit-resolver emits enemy.damaged)',
          expect:
            "the struck enemy's AI halts (its entities[] x stops advancing) until __GAME__.hitstunRemaining decays to 0, then resumes; entity.staggered logged",
        },
      ],
    };
  }
}
