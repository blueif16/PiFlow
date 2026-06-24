/**
 * Scenes — Level scene classes (platformer).
 *
 * - BaseLevelScene: foundation for level scenes (Template Method + Hooks).
 *
 * Template files (_Template*) are NOT exported — they are meant to be COPIED
 * and renamed by W4.
 */
export { BaseLevelScene } from './BaseLevelScene';
export type { PlayerClassMap } from './BaseLevelScene';

// Data-driven level loader (the Track-B core) + its data/system contracts.
export { DataLevelScene } from './DataLevelScene';
export type {
  LevelData,
  PlatformData,
  RewardData,
  ThreatData,
  GoalData,
  EffectBinding,
  BehaviorBinding,
  ISceneSystem,
} from './level-data';
export {
  registerCustomBehavior,
  registerCustomSystem,
  resolveCustomBehavior,
  resolveCustomSystem,
  type CustomBehaviorFactory,
  type CustomSystemFactory,
} from './custom-registry';
