/**
 * ============================================================================
 * TEMPLATE: Enemy Character  (_Template* — W4 COPIES this, then renames)
 * ============================================================================
 *
 * W4 INSTRUCTIONS:
 *   1. Copy this file → e.g. Slime.ts (rename the class).
 *   2. Set `textureKey` to the enemy's index.json slot key.
 *   3. Set stats (read from gameConfig.json enemyConfig) + AI type.
 *   4. Add instances to scene.enemies and bump scene._spawnedEnemyCount.
 *
 * Do NOT edit BaseEnemy / behaviors — they are the engine (KEEP).
 * ============================================================================
 */
import Phaser from 'phaser';
import { BaseEnemy, type EnemyConfig } from './BaseEnemy';
import gameConfig from '../gameConfig.json';

const ec = (gameConfig as any).enemyConfig ?? {
  maxHealth: { value: 50 },
  walkSpeed: { value: 80 },
  damage: { value: 20 },
};

export class _TemplateEnemy extends BaseEnemy {
  constructor(scene: Phaser.Scene, x: number, y: number) {
    const config: EnemyConfig = {
      // TODO-W4: replace with the enemy's index.json slot key.
      textureKey: 'enemy',
      displayHeight: 80,
      stats: {
        maxHealth: ec.maxHealth.value,
        speed: ec.walkSpeed.value,
        damage: ec.damage.value,
      },
      ai: { type: 'patrol' }, // 'patrol' | 'chase' | 'stationary' | 'custom'
      combat: { hasMelee: false },
    };
    super(scene, x, y, config);
  }

  // OPTIONAL HOOKS.
  protected override onDeath(): void {}
}
