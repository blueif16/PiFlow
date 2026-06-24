/**
 * Level Manager — game level order and navigation (KEEP structure; W4 fills LEVEL_ORDER)
 *
 * Engine-agnostic, pure level-order logic (no engine import) — the CONTRACT home,
 * shared by every engine. Relocated verbatim from `core/src/LevelManager.ts`
 * (which now re-exports this). A sandbox typically has ONE "level" (the world);
 * the manager still applies.
 *
 * USAGE:
 *   1. W4 adds the real level scene keys to LEVEL_ORDER (in build order).
 *   2. getNextLevelScene() / isLastLevel() drive end-screen navigation.
 *
 * The LEVEL_ORDER array defines the sequence of levels. VictoryUIScene and
 * GameCompleteUIScene use it to decide "next level" vs "you beat the game".
 */
export class LevelManager {
  /**
   * TODO-W4: replace with the GDD's real scene keys (build order).
   * Order matters: index 0 = first scene after TitleScreen; last = final scene.
   * Every key here MUST also be registered in main.ts via game.scene.add().
   */
  static readonly LEVEL_ORDER: string[] = [
    'Level1Scene', // TODO-W4: the empty template ships one default level.
  ];

  /** Get the key of the next level, or null if at the last level. */
  static getNextLevelScene(currentSceneKey: string): string | null {
    const i = LevelManager.LEVEL_ORDER.indexOf(currentSceneKey);
    if (i === -1 || i >= LevelManager.LEVEL_ORDER.length - 1) return null;
    return LevelManager.LEVEL_ORDER[i + 1];
  }

  /** True if this is the last level. */
  static isLastLevel(currentSceneKey: string): boolean {
    const i = LevelManager.LEVEL_ORDER.indexOf(currentSceneKey);
    return i === LevelManager.LEVEL_ORDER.length - 1;
  }

  /** Key of the first level, or null if none defined. */
  static getFirstLevelScene(): string | null {
    return LevelManager.LEVEL_ORDER.length > 0
      ? LevelManager.LEVEL_ORDER[0]
      : null;
  }

  /** 1-based level number for display, or 0 if not found. */
  static getLevelNumber(currentSceneKey: string): number {
    const i = LevelManager.LEVEL_ORDER.indexOf(currentSceneKey);
    return i >= 0 ? i + 1 : 0;
  }

  /** Total number of levels. */
  static getTotalLevels(): number {
    return LevelManager.LEVEL_ORDER.length;
  }

  /** True if this scene key is a registered level scene. */
  static isLevelScene(sceneKey: string): boolean {
    return LevelManager.LEVEL_ORDER.includes(sceneKey);
  }
}
