/**
 * DataPlayer — a BasePlayer configured ENTIRELY from level/blueprint DATA
 * (KEEP — engine seam for the data-driven loader).
 *
 * The data-driven loader builds the player from `LevelData.player` (its asset
 * slot + the {ref:'PlatformerMovement', params} binding) merged over
 * gameConfig.playerConfig — so NO per-game player file is needed for a standard
 * platformer player. W4 only writes a player class when the design needs a custom
 * override beyond the bound movement params.
 *
 * GENERIC: reads stats from gameConfig.playerConfig (the W2-merged blueprint
 * config) and the movement tuning from the passed-in {ref,params} binding; no
 * theme is baked in.
 */
import Phaser from 'phaser';
import { BasePlayer, type PlayerConfig } from './BasePlayer';
import type { PlayerAnimKeys } from './PlayerFSM';
import gameConfig from '../gameConfig.json';

const pc = (gameConfig as any).playerConfig ?? {};
const numOr = (v: any, d: number): number => (typeof v === 'number' ? v : d);

export interface DataPlayerSpec {
  /** texture key (an index.json slot); falls back to a placeholder key. */
  textureKey?: string;
  /**
   * Logical display WIDTH in px (the frozen assetList width). When present the
   * player is fit to its logical BOX on both axes (so display width is pinned to
   * the spec, not the texture's aspect ratio); absent → height-only fit.
   */
  displayWidth?: number;
  displayHeight?: number;
  /** the PlatformerMovement {params} bound in the blueprint (verbatim). */
  movement?: {
    airControl?: number;
    coyoteTime?: number;
    jumpBufferTime?: number;
    doubleJumpEnabled?: boolean;
    doubleJumpPower?: number;
    walkSpeed?: number;
    jumpPower?: number;
    maxFallSpeed?: number;
  };
  animKeys?: PlayerAnimKeys;
}

export class DataPlayer extends BasePlayer {
  constructor(scene: Phaser.Scene, x: number, y: number, spec: DataPlayerSpec = {}) {
    const m = spec.movement ?? {};
    const config: PlayerConfig = {
      textureKey: spec.textureKey || '__px',
      // displayWidth pins the logical box's width when the spec declares it
      // (undefined → BasePlayer fits by height alone, the prior behavior).
      displayWidth: spec.displayWidth,
      displayHeight: spec.displayHeight ?? 80,
      bodyWidthFactor: 0.6,
      bodyHeightFactor: 0.85,
      verticalVisualOffset: 0,
      stats: {
        // bound movement params win over the config defaults (the blueprint binds
        // walkSpeed/jumpPower in the PlatformerMovement params); config is the floor.
        maxHealth: numOr(pc.maxHealth?.value, 1),
        walkSpeed: numOr(m.walkSpeed, numOr(pc.walkSpeed?.value, 200)),
        jumpPower: numOr(m.jumpPower, numOr(pc.jumpPower?.value, 620)),
        attackDamage: numOr(pc.attackDamage?.value, 0),
        hurtingDuration: numOr(pc.hurtingDuration?.value, 100),
        invulnerableTime: numOr(pc.invulnerableTime?.value, 1000),
        gravityY: numOr(pc.gravityY?.value, 1200),
      },
      movement: {
        airControl: numOr(m.airControl, 0.85),
        coyoteTime: numOr(m.coyoteTime, 0),
        jumpBufferTime: numOr(m.jumpBufferTime, 0),
        doubleJumpEnabled: !!m.doubleJumpEnabled,
        doubleJumpPower: m.doubleJumpPower,
      },
      animKeys: spec.animKeys,
    };
    super(scene, x, y, config);
  }
}
