/**
 * ============================================================================
 * TEMPLATE: Player Character  (_Template* — W4 COPIES this, then renames)
 * ============================================================================
 *
 * W4 INSTRUCTIONS:
 *   1. Copy this file → Player.ts (rename the class to Player).
 *   2. Set `textureKey` to the player's asset slot key from index.json
 *      (the Preloader placeholder-fills it, so any valid key renders).
 *   3. Stats already read from gameConfig.json playerConfig — adjust if needed.
 *   4. Map animKeys to your animation keys (optional; missing keys no-op).
 *   5. Optionally override hooks (initUltimate, onUpdate, onDamageTaken, …).
 *
 * Do NOT edit BasePlayer / behaviors — they are the engine (KEEP).
 * ============================================================================
 */
import Phaser from 'phaser';
import { BasePlayer, type PlayerConfig } from './BasePlayer';
import gameConfig from '../gameConfig.json';

const pc = (gameConfig as any).playerConfig;

export class _TemplatePlayer extends BasePlayer {
  constructor(scene: Phaser.Scene, x: number, y: number) {
    const config: PlayerConfig = {
      // TODO-W4: replace with the player's index.json slot key.
      textureKey: 'player',
      displayHeight: 128,
      bodyWidthFactor: 0.6,
      bodyHeightFactor: 0.85,
      verticalVisualOffset: 0,
      stats: {
        maxHealth: pc.maxHealth.value,
        walkSpeed: pc.walkSpeed.value,
        jumpPower: pc.jumpPower.value,
        attackDamage: pc.attackDamage.value,
        hurtingDuration: pc.hurtingDuration.value,
        invulnerableTime: pc.invulnerableTime.value,
        gravityY: pc.gravityY.value,
      },
      movement: {
        airControl: 0.8,
        coyoteTime: 0,
        jumpBufferTime: 0,
      },
      combat: {
        meleeRange: 100,
        meleeWidth: 80,
        // Uncomment for ranged attacks:
        // rangedKey: 'player_bullet',
      },
      // TODO-W4: map to your animation keys (optional).
      animKeys: {
        idle: 'player_idle_anim',
        walk: 'player_walk_anim',
        jumpUp: 'player_jump_up_anim',
        jumpDown: 'player_jump_down_anim',
        punch: 'player_attack_1_anim',
        kick: 'player_attack_2_anim',
        die: 'player_die_anim',
      },
    };
    super(scene, x, y, config);
  }

  // OPTIONAL HOOKS — override for custom behavior.
  protected override initUltimate(): void {
    // e.g. this.ultimate = this.behaviors.add('ultimate', new DashAttackSkill({...}));
  }
  protected override onUpdate(): void {}
  protected override onDamageTaken(_damage: number): void {}
  protected override onDeath(): void {}
}
