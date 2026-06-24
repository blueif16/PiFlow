/**
 * Characters — Player & Enemy base classes (platformer).
 *
 * - BasePlayer: foundation for player characters (EXTEND in W4).
 * - BaseEnemy:  foundation for enemy characters (EXTEND in W4).
 * - PlayerFSM:  the player state machine.
 *
 * Template files (_Template*) are NOT exported — they are meant to be COPIED
 * and renamed by W4.
 */
export { BasePlayer, type PlayerConfig } from './BasePlayer';
export { BaseEnemy, type EnemyConfig, type EnemyAIType } from './BaseEnemy';
export {
  PlayerFSM,
  type PlayerAnimKeys,
  DEFAULT_PLAYER_ANIM_KEYS,
} from './PlayerFSM';
