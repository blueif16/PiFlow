/**
 * CollectScore — a composable kind=system logic (KEEP — engine; the W3/design
 * binds it by id from blueprint.systems[]). Decomposed from the gold's monolithic
 * PipeRepairGate: this is JUST the collect->score sub-logic, generalized for ANY
 * collectathon (coins, gems, pipes, batteries — the theme is a PARAM, never a
 * literal here).
 *
 * Drives ONE observable: __GAME__.score. On a genuine player<->reward overlap it
 * increments the score via utils (the immutable score seam), CONSUMES the reward
 * via scene.consumeReward (the immutable collect seam — idempotent removal that
 * the driven-traversal/verify win-path reads as "target gone"), and fires the
 * bound cosmetic effect via scene.fireEffect. It re-implements NOTHING the engine
 * already owns.
 *
 * IDEMPOTENT (one-shot per reward: a per-sprite `__collected` flag + the engine's
 * `__consumed` guard) and RESPAWN-SAFE (the consumed set is the sprite state the
 * engine persists across a non-terminal respawn — a respawn relocates the player,
 * it does NOT rebuild the level — and the running score is the registry value, so
 * a respawn never re-credits an already-collected reward). reset() clears the
 * running score to 0 ONLY on a true level restart (the SDK calls reset() at the
 * top of every create()), never mid-life.
 *
 * Overlap is the same FORGIVING display-center AABB as PipeRepairGate: it reads
 * the synchronously-updated sprite centers (a.x/a.y), not the arcade body bounds,
 * so a placement-based GIVEN (a setState that relocates the player via body.reset,
 * whose body bounds only refresh on the NEXT physics step) registers the collect on
 * the immediate next frame. Generic — no per-game coordinate is encoded.
 *
 * Params (all OPTIONAL — the design binds the theme):
 *   rewardKind?     filter to sprites whose `__kind` / `__type` equals this (a
 *                   collectathon with two reward classes scores only one). Absent
 *                   => every reward in scene.rewardsById is scoreable.
 *   valuePerReward  score added per collect (default 1).
 *   effectEvent     the event name passed to scene.fireEffect on a collect
 *                   (default 'reward.collected'); bind a juice effect to it.
 *   maxScore?       OPTIONAL cap (the score never exceeds it). Absent => uncapped.
 */
import type { ISceneSystem } from '../scenes/level-data';
import * as utils from '../utils';

/** CAPABILITY — self-describing registry sidecar (capability-registry-harness). */
export const CAPABILITY = {
  kind: 'system',
  id: 'CollectScore',
  intent:
    'On a genuine player<->reward overlap: increment score (idempotent, respawn-safe), consume the reward, fire a juice effect. Drives __GAME__.score for ANY collectathon.',
  attachesTo: 'scene',
  params: ['rewardKind', 'valuePerReward', 'effectEvent', 'maxScore'],
  roles: ['player', 'collectible'],
} as const;

export interface CollectScoreConfig {
  /** Only score rewards whose `__kind`/`__type` equals this (absent => all). */
  rewardKind?: string;
  /** Score added per collected reward (default 1). */
  valuePerReward?: number;
  /** Event fired via scene.fireEffect on a collect (default 'reward.collected'). */
  effectEvent?: string;
  /** OPTIONAL score ceiling (absent => uncapped). */
  maxScore?: number;
}

/** Forgiving display-center half-extent (matches the SDK pickup body feel). */
const PICKUP = 70;

export class CollectScore implements ISceneSystem {
  private scene: any;
  private readonly rewardKind?: string;
  private readonly valuePerReward: number;
  private readonly effectEvent: string;
  private readonly maxScore?: number;

  constructor(params: CollectScoreConfig = {}) {
    this.rewardKind = params.rewardKind;
    this.valuePerReward = params.valuePerReward ?? 1;
    this.effectEvent = params.effectEvent ?? 'reward.collected';
    this.maxScore = params.maxScore;
  }

  reset(): void {
    // True level restart: zero the running score so a replayed level starts fresh.
    // (Per-reward `__collected`/`__consumed` flags live on the sprites, which the
    // restart's create() rebuilds — so there is no per-sprite latch to clear here.)
    // Also zero the engine-accumulated maxScore ceiling so setupCollisions can
    // re-total the re-placed rewards without double-counting on a replay.
    if (this.scene) {
      utils.setScore(this.scene, 0);
      utils.resetMaxScore(this.scene);
    }
  }

  attach(scene: any): void {
    this.scene = scene;
    utils.setScore(scene, 0);
  }

  /** A reward this system scores (kind filter; absent => every reward). */
  private matches(obj: any): boolean {
    if (!obj) return false;
    if (!this.rewardKind) return true;
    return obj.__kind === this.rewardKind || obj.__type === this.rewardKind;
  }

  setupCollisions(): void {
    const scene = this.scene;
    if (!scene?.decorations) return;
    // Wire a physics overlap per matching reward (collected on the real touch),
    // and REGISTER each placed reward's value into the engine-accumulated maxScore
    // (Σ of the real placed reward values). This is the ONLY place the ceiling
    // grows — the code that PLACES the rewards totals them, so no LLM computes the
    // integer. (reset() zeroed maxScore first, so a replay re-totals cleanly.)
    scene.decorations.getChildren().forEach((obj: any) => {
      if (!this.matches(obj)) return;
      utils.registerScorable(scene, this.valuePerReward);
      utils.addOverlap(scene, scene.player, obj, () => this.collect(obj));
    });
  }

  update(): void {
    const scene = this.scene;
    const player = scene?.player;
    if (!player?.body || !scene?.decorations) return;
    // Forgiving per-frame proximity sweep (agrees with the physics overlap; the
    // setState/driven-GIVEN path needs the synchronous display-center read).
    scene.decorations.getChildren().forEach((obj: any) => {
      if (!this.matches(obj)) return;
      if (obj.__collected || obj.__consumed) return;
      if (this.overlap(player, obj)) this.collect(obj);
    });
  }

  /** One-shot collect: score++, consume, fire the bound effect. Idempotent. */
  private collect(reward: any): void {
    if (!reward || reward.__collected || reward.__consumed) return;
    reward.__collected = true;
    const current = this.scene.registry.get('score') ?? 0;
    let next = current + this.valuePerReward;
    if (this.maxScore !== undefined) next = Math.min(this.maxScore, next);
    utils.setScore(this.scene, next);
    this.scene.fireEffect?.(this.effectEvent, reward.x, reward.y);
    this.scene.consumeReward?.(reward);
  }

  /**
   * Display-position AABB overlap (frame-deterministic, no physics-step wait).
   * Reads sprite CENTERS + a forgiving half-extent — survives body.reset (the
   * body bounds refresh only on the next physics step). Generic; no coordinate.
   */
  private overlap(a: any, b: any): boolean {
    if (!a || !b) return false;
    const bb = b.body;
    if (bb && bb.enable === false) return false;
    const aw = Math.max((a.displayWidth ?? 32) / 2, PICKUP);
    const ah = Math.max((a.displayHeight ?? 32) / 2, PICKUP);
    const bw = Math.max((b.displayWidth ?? 32) / 2, PICKUP);
    const bh = Math.max((b.displayHeight ?? 32) / 2, PICKUP);
    return Math.abs(a.x - b.x) < aw + bw && Math.abs(a.y - b.y) < ah + bh;
  }
}
