/**
 * boot-entry.ts — the in-tree HEADLESS boot, dropped into the MERGED game src
 * (core overlaid by the archetype module) and bundled by bundle.mjs.
 * ============================================================================
 *
 * This is the REAL engine boot: it constructs `new Phaser.Game` under
 * `Phaser.HEADLESS` with the SAME scene set the module's main.ts registers
 * (Preloader → TitleScreen → the default Level1Scene → the UI scenes) and the
 * SAME `window.__GAME__` hook, then exports the engine's OWN id→constructor
 * resolvers so the harness mounts a component through the exact path
 * DataLevelScene uses. Nothing here is component-specific.
 *
 * Resolves against the merged src by RELATIVE path (./scenes/…, ./systems/…,
 * ./hook), so the same entry works for any archetype that follows the core
 * scene contract; `@contract` + `phaser` are esbuild-aliased in bundle.mjs.
 */
import Phaser from 'phaser';
import gameConfig from './gameConfig.json';
import { installGameHook } from './hook';

// Core engine scenes (the module overlay keeps core's copies of these).
import { Preloader } from './scenes/Preloader';
import { TitleScreen } from './scenes/TitleScreen';
import UIScene from './scenes/UIScene';
import { PauseUIScene } from './scenes/PauseUIScene';
import { VictoryUIScene } from './scenes/VictoryUIScene';
import { GameCompleteUIScene } from './scenes/GameCompleteUIScene';
import { GameOverUIScene } from './scenes/GameOverUIScene';
// The archetype's default empty-but-playable level (overlaid by the module).
import { Level1Scene } from './scenes/Level1Scene';

const { screenSize } = gameConfig as any;

/**
 * PATCH (4) — generateTexture under the NullRenderer.
 * The NullRenderer has no blendModes, so Phaser's Graphics.generateTexture (the
 * engine calls it on every boot via ensurePlaceholderTexture / createBulletTextures)
 * crashes. Headless we only need the texture KEY to exist (physics + __GAME__
 * never read pixels). Replace it with a key-registering no-op backed by the real
 * TextureManager.createCanvas. Idempotent (guarded by __headlessPatched).
 */
function patchGenerateTexture(): void {
  const GraphicsProto = (Phaser.GameObjects.Graphics as any).prototype;
  if (GraphicsProto.__headlessPatched) return;
  GraphicsProto.__headlessPatched = true;
  GraphicsProto.generateTexture = function (
    key: string,
    width?: number,
    height?: number,
  ) {
    const tm = this.scene.sys.textures;
    if (!tm.exists(key)) {
      tm.createCanvas(
        key,
        Math.max(1, width || this.width || 1),
        Math.max(1, height || this.height || 1),
      );
    }
    return this;
  };
}

/** The game-basis overrides bootHeadlessGame accepts (COMPONENT-BLIND). */
export interface GameBasisConfig {
  /** Viewport width override (px). Default: gameConfig.screenSize.width. */
  width?: number;
  /** Viewport height override (px). Default: gameConfig.screenSize.height. */
  height?: number;
  /** Arcade-physics defaults override (merged over the headless defaults). */
  physics?: Record<string, unknown>;
}

/**
 * Boot the REAL engine under Phaser.HEADLESS and return the live game + hook.
 * Mirrors the module main.ts scene registration exactly; the only differences
 * are HEADLESS (NullRenderer), no audio, and Scale.NONE (no DOM scale work).
 */
export function bootHeadless(basis: GameBasisConfig = {}): {
  game: Phaser.Game;
  hook: any;
} {
  patchGenerateTexture();

  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.HEADLESS, // NullRenderer: zero rendering; generateTexture shimmed
    width: basis.width ?? screenSize.width.value,
    height: basis.height ?? screenSize.height.value,
    parent: 'game-container',
    banner: false,
    audio: { noAudio: true },
    scale: { mode: Phaser.Scale.NONE }, // HEADLESS: no scale-manager DOM work
    physics: {
      default: 'arcade',
      arcade: { debug: false, ...(basis.physics ?? {}) },
    },
  };

  const game = new Phaser.Game(config);
  game.registry.set('score', 0);
  game.registry.set('ready', false);
  game.registry.set('status', 'booting');
  const hook = installGameHook(game);

  game.scene.add('Preloader', Preloader, true);
  game.scene.add('TitleScreen', TitleScreen);
  game.scene.add('Level1Scene', Level1Scene);
  game.scene.add('UIScene', UIScene);
  game.scene.add('PauseUIScene', PauseUIScene);
  game.scene.add('VictoryUIScene', VictoryUIScene);
  game.scene.add('GameCompleteUIScene', GameCompleteUIScene);
  game.scene.add('GameOverUIScene', GameOverUIScene);

  return { game, hook };
}

// Re-export the engine's OWN id→constructor resolvers (the path DataLevelScene
// uses to instantiate kind=system / kind=behavior logics from {ref,params}).
// Mounting via these IS the real wiring — no shim, no hand-rolled scene. The
// real BehaviorManager is re-exported so the harness attaches a behavior onto an
// owner through the engine's own component manager (the DataLevelScene path).
export { resolveSystem } from './systems/registry';
export { resolveBehavior } from './behaviors/registry';
export { BehaviorManager } from './behaviors/BehaviorManager';
