/**
 * ScoreGateGoal — a composable kind=system logic (KEEP — engine; the design binds
 * it by id from blueprint.systems[]). Decomposed from the gold's monolithic
 * PipeRepairGate: this is JUST the threshold-gate -> lock/unlock-goal -> win sub-
 * logic, generalized for ANY score-gated OR pure-completion win (the threshold and
 * the event names are PARAMS, never literals).
 *
 * Drives ONE observable: __GAME__.status (-> 'won'). Each frame it RE-DERIVES the
 * goal lock from the LIVE score (goal.locked = score < threshold) — re-derived, not
 * latched, so a level RESTART or a score that drops back below threshold re-locks
 * the goal correctly (reset-safety, verbatim from PipeRepairGate). On a player<->
 * UNLOCKED-goal overlap it calls scene.onLevelComplete() ONCE (a 'won' one-shot
 * latch + the engine's gameCompleted guard). It re-implements NOTHING the engine
 * owns: the win seam is BaseLevelScene.onLevelComplete (status:'won'); the goal
 * sprite + its `.locked` flag are exposed by the SDK (scene.goalSprite).
 *
 * TWO REGISTERED IDS, ONE CLASS (the cleanest expression — see SYSTEM_CAPABILITIES
 * below + systems/registry.ts):
 *   ScoreGateGoal  threshold from params (a number) OR gateOn:'allRewards' (resolve
 *                  the threshold to the live reward count). The combat/collect
 *                  threshold win: reach N before the goal opens.
 *   GoalReach      the SAME class with threshold defaulting to 0 — a pure-completion
 *                  win with NO scoring (the goal is open from the start; touching it
 *                  wins). A thin registered factory `() => new ScoreGateGoal({threshold:0})`.
 * The design binds EITHER id; the loader resolves each to the right construction.
 *
 * Overlap uses the same forgiving display-center AABB as CollectScore/PipeRepairGate
 * so a placement-based GIVEN (player relocated via body.reset) registers the win on
 * the next frame. Generic — no per-game coordinate is encoded.
 *
 * Params (all OPTIONAL):
 *   threshold        the score required to unlock the goal (default 0 => open from
 *                    the start, the GoalReach case). A pure-completion win is just
 *                    threshold 0.
 *   gateOn           'allRewards' => resolve `threshold` to the live count of
 *                    rewards (scene.rewardsById) at attach time (a collect-EVERY-
 *                    reward win without hard-coding the count). Overrides `threshold`.
 *   winEffectEvent   event fired via scene.fireEffect when the win fires
 *                    (default 'level.won').
 *   unlockEffectEvent event fired when the goal transitions locked->unlocked
 *                    (default 'goal.unlocked').
 */
import type { ISceneSystem } from '../scenes/level-data';
import * as utils from '../utils';

/**
 * CAPABILITY — the primary id (ScoreGateGoal). The SECOND id (GoalReach) is
 * declared in SYSTEM_CAPABILITIES below so the registry globber catalogs both
 * from this one file (a system file MAY register more than one id).
 */
export const CAPABILITY = {
  kind: 'system',
  id: 'ScoreGateGoal',
  intent:
    'Re-derive the goal lock from the live score (locked while score < threshold) and win once on a player<->unlocked-goal overlap. The score-gated win (combat OR collect-threshold).',
  attachesTo: 'scene',
  params: ['threshold', 'gateOn', 'winEffectEvent', 'unlockEffectEvent'],
  roles: ['player', 'goal'],
} as const;

/**
 * SYSTEM_CAPABILITIES — every kind=system id this file registers (the globber
 * reads this array exactly like behaviors/SkillBehavior's SKILL_CAPABILITIES).
 * GoalReach is the threshold-0 expression of the SAME class: a pure-completion
 * win with no scoring (the goal is open from the start; touching it wins).
 */
export const SYSTEM_CAPABILITIES = [
  CAPABILITY,
  {
    kind: 'system',
    id: 'GoalReach',
    intent:
      'Pure-completion win (no scoring): the goal is open from the start; a player<->goal overlap wins once. ScoreGateGoal with threshold 0.',
    attachesTo: 'scene',
    params: ['winEffectEvent'],
    roles: ['player', 'goal'],
  },
] as const;

export interface ScoreGateGoalConfig {
  /** Score required to unlock the goal (default 0 => open from the start). */
  threshold?: number;
  /** 'allRewards' => resolve threshold to the live reward count at attach. */
  gateOn?: string;
  /** Event fired via scene.fireEffect on the win (default 'level.won'). */
  winEffectEvent?: string;
  /** Event fired on the locked->unlocked transition (default 'goal.unlocked'). */
  unlockEffectEvent?: string;
}

/** Forgiving display-center half-extent (matches the SDK pickup body feel). */
const PICKUP = 70;

export class ScoreGateGoal implements ISceneSystem {
  private scene: any;
  private won = false;
  private threshold: number;
  private readonly gateOnAllRewards: boolean;
  private readonly winEffectEvent: string;
  private readonly unlockEffectEvent: string;

  constructor(params: ScoreGateGoalConfig = {}) {
    this.threshold = params.threshold ?? 0;
    this.gateOnAllRewards = params.gateOn === 'allRewards';
    this.winEffectEvent = params.winEffectEvent ?? 'level.won';
    this.unlockEffectEvent = params.unlockEffectEvent ?? 'goal.unlocked';
  }

  reset(): void {
    // Clear the one-shot win latch so a restarted level is genuinely replayable.
    // The lock state itself is RE-DERIVED from the live score every frame, so it
    // needs no reset.
    this.won = false;
  }

  attach(scene: any): void {
    this.scene = scene;
    // gateOn:'allRewards' resolves the threshold to the live reward count (every
    // reward must be collected before the goal opens) without a hard-coded number.
    if (this.gateOnAllRewards) {
      const rewards = scene.rewardsById ?? {};
      this.threshold = Object.keys(rewards).length;
    }
    // Open the goal from the start when the threshold is 0 (the GoalReach case).
    const goal = scene.goalSprite;
    if (goal) goal.locked = (scene.registry.get('score') ?? 0) < this.threshold;
  }

  setupCollisions(): void {
    const scene = this.scene;
    // The physics overlap fires the win on the real touch (the per-frame sweep in
    // update() is the placement-GIVEN companion). reachGoal() re-guards locked/won.
    if (scene?.goalSprite) {
      utils.addOverlap(scene, scene.player, scene.goalSprite, () => this.reachGoal());
    }
  }

  update(): void {
    const scene = this.scene;
    const goal = scene?.goalSprite;
    if (!goal) return;
    const score = scene.registry.get('score') ?? 0;
    const shouldUnlock = score >= this.threshold;
    // RE-DERIVE the lock from the live score every frame (reset-safe).
    if (shouldUnlock && goal.locked) {
      goal.locked = false;
      scene.fireEffect?.(this.unlockEffectEvent, goal.x, goal.y);
    } else if (!shouldUnlock && !goal.locked) {
      goal.locked = true;
    }
    const player = scene.player;
    if (player?.body && !goal.locked && !scene.gameCompleted && this.overlap(player, goal)) {
      this.reachGoal();
    }
  }

  /** One-shot win on a player<->UNLOCKED-goal touch. Idempotent. */
  private reachGoal(): void {
    const scene = this.scene;
    const goal = scene?.goalSprite;
    if (!goal || goal.locked) return;
    if (this.won || scene.gameCompleted) return;
    this.won = true;
    scene.gameCompleted = true;
    scene.fireEffect?.(this.winEffectEvent, goal.x, goal.y);
    scene.onLevelComplete();
  }

  /** Forgiving display-center AABB overlap (survives body.reset). */
  private overlap(a: any, b: any): boolean {
    if (!a || !b) return false;
    const aw = Math.max((a.displayWidth ?? 32) / 2, PICKUP);
    const ah = Math.max((a.displayHeight ?? 32) / 2, PICKUP);
    const bw = Math.max((b.displayWidth ?? 32) / 2, PICKUP);
    const bh = Math.max((b.displayHeight ?? 32) / 2, PICKUP);
    return Math.abs(a.x - b.x) < aw + bw && Math.abs(a.y - b.y) < ah + bh;
  }
}
