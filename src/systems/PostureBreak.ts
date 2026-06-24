/**
 * PostureBreak — a composable kind=system: the DEFENSIVE analog of ComboChain.
 *
 * THE MECHANIC (Sekiro posture → deathblow; fromsoftware.jp/manual mechanics +
 * gamedeveloper.com "How I Broke Sekiro": accumulated posture at max → a finish
 * regardless of remaining health). Where ComboChain accrues an OFFENSIVE, player-side
 * decaying combo, PostureBreak accrues a per-ENEMY guard meter: every LANDED player
 * hit (`enemy.damaged`) feeds it a little, every PARRY (`attack.parried`, the
 * Round-2-specced ParryWindow — the Sekiro DEFLECT) feeds it a LOT. While an enemy is
 * untouched the meter DECAYS. When it tops out the enemy GUARD-BREAKS: its AI freezes
 * and a brief, OBSERVABLE execute window opens — and the NEXT landed hit during that
 * window removes the enemy from __GAME__.entities in ONE blow, regardless of its
 * remaining health.
 *
 * OBSERVABLES (the PULL channel, mirrored onto the scene the same archetype-extras way
 * ComboChain mirrors `scene.comboCount` / HitstunState `scene.hitstunRemaining`):
 *   - __GAME__.postureBroken    — true while ANY enemy sits in its open execute window.
 *   - __GAME__.postureRemaining — ms left on the longest open execute window (→ 0 when
 *                                 none open). The "brief window" the contract names.
 *
 * HIT/PARRY SEAM (generic — re-derives nothing): a landed hit is already announced on
 * the scene's shared EventBus by the engine — `enemy.damaged {id,x,y,health,damage}`
 * (BaseEnemy.takeDamage, BaseEnemy.ts:269); a parry is announced by ParryWindow as
 * `attack.parried {id,x,y}`. This system POLL-subscribes to BOTH via the leak-free bus
 * log seam (eventBus.recent(sinceSeq), the same poll-don't-subscribe path HitstunState
 * uses — a .on() listener leaks across a scene RESTART), so it composes over ANY
 * platformer-combat weapon with no melee/collision code of its own.
 *
 * HOW IT FREEZES THE AI WITHOUT TOUCHING THE ENEMY/AI CODE (mirrors HitstunState): the
 * data-driven loader runs the enemy AI FIRST, then the scene systems (DataLevelScene
 * baseUpdate → updateEnemies sets PatrolAI/ChaseAI velocity, THEN sys.update()). So
 * each frame, for every guard-broken enemy, this system (a) zeroes its body velocity
 * AFTER the AI set it and (b) holds `isHurting = true`, which BaseEnemy.update() reads
 * to suppress executeAI()/tryRangedAttack() — the enemy can neither advance nor attack
 * for the window. The enemy class is never edited.
 *
 * HOW IT EXECUTES IN ONE BLOW (the immutable removal seam — re-implements nothing): on
 * the first `enemy.damaged` that lands on a guard-broken enemy inside its open window,
 * this system calls the enemy's own `die()` (BaseEnemy.ts:287 — sets isDead, stops it,
 * destroys it so collectEntities drops it from __GAME__.entities) AND the scene's
 * `onEnemyKilled(enemy)` seam (BaseLevelScene.ts:686 — the standardized kill-count +
 * `enemy.died` path), so the deathblow fires regardless of the enemy's leftover health,
 * exactly as a real lethal hit would. No bespoke removal code.
 *
 * IDEMPOTENT + RESPAWN-SAFE: a per-enemy-id map holds posture; a re-hit ADDS (it never
 * stacks windows — the execute window is a single per-enemy latch). It re-reads live
 * enemy sprites each frame by `__id`. reset() clears the meters + the bus cursor on a
 * true level restart (the SDK calls reset() before attach()), so a replayed level
 * starts at zero posture and re-reads the bus from the start.
 *
 * Params (all OPTIONAL — the design/HARDEN binds the feel; sensible defaults below):
 *   maxPosture     posture value at which the enemy guard-breaks (default 100).
 *   hitGain        posture added per landed hit (default 20 — five clean hits break).
 *   parryGain      posture added per parry (default 50 — the Sekiro deflect feeds the
 *                  most; two perfect parries break). Defaults to 2.5× hitGain in spirit.
 *   decayPerSec    posture lost per second while an enemy is untouched (default 25 —
 *                  pressure must be sustained; a lull bleeds the meter back down).
 *   windowMs       ms the execute window stays open after a guard break (default 1500).
 *   id             base/fallback entity id for an emit payload when a struck enemy
 *                  carries no `__id` (the auto-derived `__id` is preferred).
 */
import type { ISceneSystem } from '../scenes/level-data';
import { type ComponentSurface, type EventBus } from '@contract/component-surface';

/** CAPABILITY — self-describing registry sidecar (capability-registry-harness). */
export const CAPABILITY = {
  kind: 'system',
  id: 'PostureBreak',
  intent:
    'Accrue a per-enemy POSTURE meter from landed hits (enemy.damaged) and parries (attack.parried, fed the most) that decays while the enemy is untouched; at max the enemy guard-breaks (AI freezes) and a brief execute window opens, during which the next hit removes the enemy from __GAME__.entities in one blow. Drives __GAME__.postureBroken/postureRemaining. The defensive analog of ComboChain.',
  attachesTo: 'scene',
  params: ['maxPosture', 'hitGain', 'parryGain', 'decayPerSec', 'windowMs', 'id'],
  roles: ['player', 'enemy'],
  tuning: ['maxPosture', 'parryGain', 'windowMs'],
} as const;

export interface PostureBreakConfig {
  /** Posture at which the enemy guard-breaks (default 100). */
  maxPosture?: number;
  /** Posture added per landed hit (default 20). */
  hitGain?: number;
  /** Posture added per parry — the Sekiro deflect, fed the most (default 50). */
  parryGain?: number;
  /** Posture lost per second while an enemy is untouched (default 25). */
  decayPerSec?: number;
  /** Ms the execute window stays open after a guard break (default 1500). */
  windowMs?: number;
  /** Base/fallback entity id for the payload when a struck enemy carries no `__id`. */
  id?: string;
}

/** Per-enemy posture bookkeeping (the accrual + the open execute window). */
interface PostureRecord {
  /** Current accumulated posture (0..maxPosture). */
  posture: number;
  /** Ms left on the open execute window; <= 0 when the enemy is NOT guard-broken. */
  windowMs: number;
  /** True once this enemy has guard-broken (latched while the window is open). */
  broken: boolean;
}

export class PostureBreak implements ISceneSystem {
  private scene: any;
  private readonly maxPosture: number;
  private readonly hitGain: number;
  private readonly parryGain: number;
  private readonly decayPerSec: number;
  private readonly windowMs: number;
  private readonly fallbackId: string;

  private get bus(): EventBus | undefined {
    return (this.scene as any)?.eventBus;
  }

  /** Struck-enemy id → its posture record. */
  private readonly records = new Map<string, PostureRecord>();
  /** Last EventBus seq this system consumed (poll-don't-subscribe cursor). */
  private cursor = 0;
  /** The longest open execute window's ms — the live `postureRemaining` value. */
  private remaining = 0;
  /** True while any enemy sits in an open execute window — the live `postureBroken`. */
  private anyBroken = false;

  constructor(params: PostureBreakConfig = {}) {
    this.maxPosture = params.maxPosture ?? 100;
    this.hitGain = params.hitGain ?? 20;
    this.parryGain = params.parryGain ?? 50;
    this.decayPerSec = params.decayPerSec ?? 25;
    this.windowMs = params.windowMs ?? 1500;
    this.fallbackId = params.id ?? 'enemy';
  }

  reset(): void {
    // True level restart: drop every posture meter + rewind the bus cursor so a
    // replayed level starts at zero posture and re-reads the bus from the start.
    this.records.clear();
    this.cursor = 0;
    this.remaining = 0;
    this.anyBroken = false;
    if (this.scene) {
      this.scene.postureBroken = false;
      this.scene.postureRemaining = 0;
    }
  }

  attach(scene: any): void {
    this.scene = scene;
    // Start reading the bus from its current cursor (pre-attach emits are not ours).
    this.cursor = scene?.eventBus?.cursor ?? 0;
    this.remaining = 0;
    this.anyBroken = false;
    // Publish the scene-owned observables the hook fold reads from frame zero.
    scene.postureBroken = false;
    scene.postureRemaining = 0;
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

  /** Get-or-create the posture record for an enemy id. */
  private recordFor(id: string): PostureRecord {
    let rec = this.records.get(id);
    if (!rec) {
      rec = { posture: 0, windowMs: 0, broken: false };
      this.records.set(id, rec);
    }
    return rec;
  }

  /**
   * Per-frame: (1) drain new hit/parry events → accrue posture (and EXECUTE a hit that
   * lands in an open window); (2) decay untouched meters + count down open windows;
   * (3) republish the longest-window observables.
   */
  update(): void {
    const scene = this.scene;
    if (!scene?.eventBus) return;

    // (1) Drain the bus log seam for hits/parries since our cursor (poll, never subscribe).
    const fresh = scene.eventBus.recent(this.cursor);
    if (fresh.length) {
      this.cursor = scene.eventBus.cursor;
      for (const entry of fresh) {
        if (entry?.type === 'enemy.damaged') this.onLandedHit(entry.payload);
        else if (entry?.type === 'attack.parried') this.onParry(entry.payload);
      }
    }

    // (2) Decay untouched meters + count open windows down by the real frame time.
    const dt = scene.game?.loop?.delta ?? 16;
    const decay = (this.decayPerSec * dt) / 1000;
    let longest = 0;
    let broken = false;
    for (const [id, rec] of [...this.records]) {
      if (rec.broken) {
        // Hold the break: freeze the AI this frame (after the AI set its velocity)
        // and count the execute window down.
        const enemy = this.enemyById(id);
        if (enemy && !enemy.isDead) {
          enemy.setVelocity?.(0, 0);
          enemy.isHurting = true;
        }
        rec.windowMs -= dt;
        if (rec.windowMs <= 0 || !enemy || enemy.isDead) {
          // Window lapsed (or the enemy is gone): release the AI + reset its posture.
          if (enemy && !enemy.isDead) enemy.isHurting = false;
          this.records.delete(id);
          continue;
        }
        broken = true;
        if (rec.windowMs > longest) longest = rec.windowMs;
      } else if (rec.posture > 0) {
        // Untouched: bleed the meter back down (a lull undoes the pressure).
        rec.posture = Math.max(0, rec.posture - decay);
        if (rec.posture <= 0) this.records.delete(id);
      }
    }

    // (3) Republish the observables: the longest open window + whether any is open.
    this.remaining = longest;
    this.anyBroken = broken;
    scene.postureRemaining = longest;
    scene.postureBroken = broken;
  }

  /** A landed hit: EXECUTE if the enemy is guard-broken, else accrue posture. */
  private onLandedHit(payload: any): void {
    const id = payload?.id ?? this.fallbackId;
    const rec = this.records.get(id);
    if (rec?.broken) {
      this.execute(id, payload);
      return;
    }
    this.accrue(id, this.hitGain, payload);
  }

  /** A parry: accrue the MOST posture (the Sekiro deflect rule). */
  private onParry(payload: any): void {
    const id = payload?.id ?? this.fallbackId;
    const rec = this.records.get(id);
    // A parry on an already-broken enemy still opens nothing new — it would only be a
    // landed-hit that executes; a deflect itself is not the deathblow. Accrue otherwise.
    if (rec?.broken) return;
    this.accrue(id, this.parryGain, payload);
  }

  /** Add posture to an enemy; cross max → guard break. */
  private accrue(id: string, gain: number, payload: any): void {
    const rec = this.recordFor(id);
    if (rec.broken) return;
    rec.posture = Math.min(this.maxPosture, rec.posture + gain);
    if (rec.posture >= this.maxPosture) this.guardBreak(id, payload);
  }

  /** Open the execute window: freeze the AI, latch broken, fire enemy.guardBroken. */
  private guardBreak(id: string, payload: any): void {
    const rec = this.recordFor(id);
    rec.broken = true;
    rec.windowMs = this.windowMs;
    const enemy = this.enemyById(id);
    // Freeze on the break frame too (update() then holds it each subsequent frame).
    if (enemy && !enemy.isDead) {
      enemy.setVelocity?.(0, 0);
      enemy.isHurting = true;
    }
    this.remaining = Math.max(this.remaining, this.windowMs);
    this.anyBroken = true;
    if (this.scene) {
      this.scene.postureBroken = true;
      this.scene.postureRemaining = this.remaining;
    }
    // enemy.guardBroken — the posture meter topped out; the AI is frozen and the
    // OBSERVABLE execute window is open. Id auto-derived from the struck enemy's __id
    // (the hit/parry payload carries it), falling back to the config base id.
    this.bus?.emit('enemy.guardBroken', {
      id,
      x: enemy?.x ?? payload?.x ?? 0,
      y: enemy?.y ?? payload?.y ?? 0,
    });
  }

  /** A hit landed in the open window: deathblow in one blow, fire enemy.executed. */
  private execute(id: string, payload: any): void {
    const enemy = this.enemyById(id);
    const x = enemy?.x ?? payload?.x ?? 0;
    const y = enemy?.y ?? payload?.y ?? 0;
    // The immutable removal seam: the enemy's own die() (removes it from
    // __GAME__.entities) + the scene's onEnemyKilled (the standardized kill-count +
    // enemy.died path) — the deathblow fires regardless of leftover health.
    if (enemy && !enemy.isDead) {
      enemy.isHurting = false; // let die()'s velocity stop take effect cleanly
      this.scene?.onEnemyKilled?.(enemy);
      enemy.die?.();
    }
    this.records.delete(id);
    // enemy.executed — the guard-broken enemy was finished in one blow. Lean payload.
    this.bus?.emit('enemy.executed', { id, x, y });
  }

  /**
   * The uniform component surface. The PULL channel publishes the two execute-window
   * observables (this system's OWN computed values); the PUSH channel declares the two
   * posture MOMENTS, each fired from a real .emit() at its seam in THIS file:
   *   - postureBroken    ← anyBroken   (true while any execute window is open)
   *   - postureRemaining ← remaining   (ms left on the longest open window; → 0 when none)
   *   - enemy.guardBroken ← guardBreak (the meter topped out; the window opens) [archetype]
   *   - enemy.executed    ← execute    (a hit landed in the open window — deathblow) [archetype]
   */
  surface(): ComponentSurface {
    return {
      observables: {
        postureBroken: () => this.anyBroken,
        postureRemaining: () => this.remaining,
      },
      anchors: [],
      events: [
        {
          name: 'enemy.guardBroken',
          payload: '{id,x,y}',
          scope: 'archetype',
          drivenBy:
            "the enemy's posture meter reaches max from accumulated landed hits/parries (driven by the player's attack/parry)",
          expect:
            "the broken enemy's entities[] x stops advancing (AI frozen) and __GAME__.postureBroken is true / __GAME__.postureRemaining reads the open window; enemy.guardBroken logged",
        },
        {
          name: 'enemy.executed',
          payload: '{id,x,y}',
          scope: 'archetype',
          drivenBy: 'a player hit lands DURING the open guard-broken window (attack)',
          expect:
            'the enemy is removed from __GAME__.entities in one blow regardless of remaining health; enemy.executed logged',
        },
      ],
    };
  }
}
