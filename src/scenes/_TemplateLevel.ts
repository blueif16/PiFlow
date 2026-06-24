/**
 * ============================================================================
 * TEMPLATE: Level Scene  (_Template* — W4 COPIES this, then renames)
 * ============================================================================
 *
 * W4 INSTRUCTIONS:
 *   1. Copy this file → e.g. Level1Scene.ts (rename the class + constructor key).
 *   2. Implement the abstract methods for THIS level.
 *   3. Register it in main.ts (game.scene.add('Level1Scene', Level1Scene)) and
 *      in LevelManager.LEVEL_ORDER.
 *   4. Override hooks for scoring / collectibles / goal as needed.
 *
 * BUILT-IN (from BaseLevelScene, KEEP): programmatic platforms, scene-owned
 * input (arrows + WASD), contact/melee/bullet collisions, floating damage
 * numbers, hitStop(), shake, camera follow, fadeIn, the registry ready/status
 * flags (window.__GAME__), and the win/lose seam (onLevelComplete →
 * status:'won'; onPlayerDeath → status:'lost').
 *
 * SCORE:  utils.setScore(this, n) / utils.addScore(this, delta)  — the single
 *         source window.__GAME__.score reads (game.registry 'score').
 * ============================================================================
 */
import Phaser from 'phaser';
import { BaseLevelScene } from './BaseLevelScene';
import * as utils from '../utils';
// TODO-W4: import your character classes
// import { Player } from '../characters/Player';
// import { Slime } from '../characters/Slime';

export class _TemplateLevel extends BaseLevelScene {
  // TODO-W4: level-specific fields (e.g. exitDoor, collectibles).

  constructor() {
    super({ key: 'Level1Scene' }); // TODO-W4: change to your scene key
  }

  preload(): void {
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

  // ── abstract methods ──────────────────────────────────────────────────────

  setupMapSize(): void {
    // TODO-W4: set the map size (use a wider map for scrolling levels).
    this.mapWidth = this.scale.width;
    this.mapHeight = this.scale.height;
  }

  createBackground(): void {
    // TODO-W4: a parallax TileSprite if you have a bg slot, else a solid color.
    // this.background = this.add.tileSprite(0, 0, this.mapWidth, this.mapHeight, 'bg').setOrigin(0).setScrollFactor(0).setDepth(-100);
    this.cameras.main.setBackgroundColor('#1a1a2e');
  }

  createTileMap(): void {
    // DEFAULT: programmatic platforms (no tilemap art).
    this.groundLayer = this.physics.add.staticGroup();
    this.createPlatform(this.mapWidth / 2, this.mapHeight - 24, this.mapWidth, 48);
    // TODO-W4: add your platforms here, e.g.
    // this.createPlatform(400, 500, 200, 24);

    // ALTERNATIVE: load a Tiled tilemap instead (then set this.groundLayer to
    // the TilemapLayer) — collisions work with either.
    // this.map = this.make.tilemap({ key: 'level1_map' });
    // const ts = this.map.addTilesetImage('tiles', 'tileset')!;
    // const layer = this.map.createLayer('Ground', ts, 0, 0)!;
    // layer.setCollisionByExclusion([-1, 0]);
    // this.groundLayer = layer;
  }

  createDecorations(): void {
    // WARNING: the player does NOT exist yet — do not add player collisions here.
    // TODO-W4: spawn collectibles into this.decorations, e.g.
    // const coin = this.physics.add.sprite(x, y, 'coin');
    // coin.__type = 'collectible';
    // (coin.body as Phaser.Physics.Arcade.Body).setAllowGravity(false);
    // this.decorations.add(coin);
  }

  createPlayer(): void {
    // TODO-W4: create your player (use createPlayerByType for character select).
    // this.player = this.createPlayerByType(spawnX, spawnY, Player);
    throw new Error('_TemplateLevel.createPlayer: implement in your level (set this.player).');
  }

  createEnemies(): void {
    // TODO-W4: spawn enemies into this.enemies and bump _spawnedEnemyCount so
    // the kill-all win condition (and __GAME__.entities) sees them, e.g.
    // const slime = new Slime(this, x, y);
    // this.enemies.add(slime);
    // this._spawnedEnemyCount += 1;
  }

  // ── hooks (override as needed) ────────────────────────────────────────────

  protected override setupCustomCollisions(): void {
    // Player EXISTS here — safe to add player collisions, e.g. coin collection:
    // this.decorations.children.iterate((obj: any) => {
    //   if (obj?.__type === 'collectible' && !obj.collected) {
    //     utils.addOverlap(this, this.player, obj, () => {
    //       if (obj.collected) return;
    //       obj.collected = true;
    //       obj.destroy();
    //       utils.addScore(this, 10);   // → __GAME__.score
    //     });
    //   }
    //   return true;
    // });
    //
    // Reach-the-goal win:
    // utils.addOverlap(this, this.player, this.exitDoor, () => {
    //   if (this.gameCompleted) return;
    //   this.gameCompleted = true;
    //   this.onLevelComplete();   // → status:'won'
    // });
  }

  protected override onEnemyKilled(_enemy: any): void {
    // utils.addScore(this, 100);
  }
}
