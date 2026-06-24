import Phaser from 'phaser';
import { BaseLevelScene } from './BaseLevelScene';
import { _TemplatePlayer } from '../characters/_TemplatePlayer';
import * as utils from '../utils';

/**
 * Level1Scene — the DEFAULT empty-but-playable level (ships with the template).
 *
 * This is the level the EMPTY template boots into: a single programmatic ground
 * platform + a placeholder player, NO enemies, NO goal. It exists so the empty
 * scaffold RUNS standalone and flips window.__GAME__.ready = true on the first
 * interactive frame (via BaseLevelScene.markReady()), with ZERO generated art.
 *
 * W4 REPLACES this with the GDD's real level (COPY _TemplateLevel.ts), or
 * extends it. It is a normal level scene (not a KEEP engine file).
 */
export class Level1Scene extends BaseLevelScene {
  constructor() {
    super({ key: 'Level1Scene' });
  }

  preload(): void {
    // Ensure the generic pixel + bullet placeholder textures exist.
    utils.ensurePlaceholderTexture(this, '__px', 8, 8, 'sprite');
    utils.createBulletTextures(this);
  }

  create(): void {
    this.createBaseElements();
    this.cameras.main.fadeIn(300);
  }

  update(): void {
    this.baseUpdate();
  }

  // ── abstract method implementations ──────────────────────────────────────

  setupMapSize(): void {
    this.mapWidth = this.scale.width;
    this.mapHeight = this.scale.height;
  }

  createBackground(): void {
    this.cameras.main.setBackgroundColor('#1a1a2e');
  }

  createTileMap(): void {
    // Programmatic ground (no tilemap art needed).
    this.groundLayer = this.physics.add.staticGroup();
    const groundY = this.mapHeight - 24;
    this.createPlatform(this.mapWidth / 2, groundY, this.mapWidth, 48);
    // A couple of floating platforms so jumping is meaningful.
    this.createPlatform(this.mapWidth * 0.3, this.mapHeight * 0.6, 220, 24);
    this.createPlatform(this.mapWidth * 0.7, this.mapHeight * 0.45, 220, 24);
  }

  createDecorations(): void {
    // none in the empty template
  }

  createPlayer(): void {
    const spawnX = this.mapWidth * 0.5;
    const spawnY = this.mapHeight - 120;
    this.player = new _TemplatePlayer(this, spawnX, spawnY);
  }

  createEnemies(): void {
    // none in the empty template — _spawnedEnemyCount stays 0 so the default
    // kill-all win condition does NOT fire (W4 adds enemies + a real goal).
  }
}
