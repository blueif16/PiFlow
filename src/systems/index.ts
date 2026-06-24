/**
 * Systems — composable scene-level kind=system logics (KEEP — engine).
 *
 * A SYSTEM is scene-level cross-entity orchestration: it reads overlaps across
 * entities (player <-> rewards/goal) AND writes an observable (score/status). It
 * implements ISceneSystem (scenes/level-data.ts); the DataLevelScene constructs it
 * from a blueprint `systems[]` binding ({ref,params}), then runs its lifecycle
 * (reset -> attach -> setupCollisions -> per-frame update). This is the registered,
 * composable replacement for a monolithic per-game custom[] director — the design
 * binds small logics BY ID and tunes them with PARAMS.
 *
 * Each shipped logic drives ONE observable:
 *   CollectScore    player<->reward overlap -> __GAME__.score (any collectathon)
 *   ScoreGateGoal   score>=threshold unlocks the goal; goal touch -> status:'won'
 *   GoalReach       ScoreGateGoal with threshold 0 (pure-completion win, no score)
 *
 * Usage (the data-driven loader does this generically by id — see SYSTEM_CLASSES
 * in ./registry):
 *   levelData.systems = [{ ref: 'CollectScore', params: { rewardKind: 'coin' } },
 *                        { ref: 'ScoreGateGoal', params: { gateOn: 'allRewards' } }]
 *
 * BARREL DISCIPLINE (mirrors behaviors/index.ts): export the system CLASSES here
 * (the registry-drift stranded-export gate requires every barrel-exported system
 * value to carry a CAPABILITY id). The runtime resolution map (SYSTEM_CLASSES /
 * resolveSystem) lives in ./registry and is imported DIRECTLY by DataLevelScene —
 * NOT re-exported here — so the stranded gate stays clean.
 */

export { CollectScore, type CollectScoreConfig } from './CollectScore';
export { ScoreGateGoal, type ScoreGateGoalConfig } from './ScoreGateGoal';
export { KnockbackImpulse, type KnockbackImpulseConfig } from './KnockbackImpulse';
export { HitstunState, type HitstunStateConfig } from './HitstunState';
export { ComboChain, type ComboChainConfig } from './ComboChain';
export { CrumblingPlatform, type CrumblingPlatformConfig } from './CrumblingPlatform';
export { PostureBreak, type PostureBreakConfig } from './PostureBreak';
export { OneWayPlatform, type OneWayPlatformConfig } from './OneWayPlatform';
export { WindZone, type WindZoneConfig, type WindRegionData } from './WindZone';
