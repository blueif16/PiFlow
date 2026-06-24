/**
 * scene.ts — the scene shell + sprite factories for component DRIVE tests.
 *
 * EXTRACTED from the ~20 hand-rolled `makeScene` copies across the drive tests. The
 * exemplars each carried only the live fields THEIR component read off a real scene
 * (Crumbling: `eventBus`/`player`/`groundLayer`/`game.loop.delta`; ComboChain:
 * `eventBus`/`time.now`/`comboCount`). This shell is the UNION — a superset scene that
 * carries every field a 2D component reads off `BaseLevelScene`, all backed by real,
 * advanceable state. A component only ever reads the fields it needs; the rest are inert.
 *
 * The recording bus IS the real `EventBus` (its ring buffer is the recorder; `bus.recent()`
 * reads it) — never a mock. `snapshot()` returns a `__GAME__`-equivalent plain object.
 */

import { EventBus } from '../component-surface';
import { makeBody, type ArcadeBody, type MakeBodyOpts } from './arcade-world';

/** A platform sprite: a real arcade body + the canonical disableBody/enableBody seams
 *  (CrumblingPlatform.crumble() flips `body.enable` via `disableBody`). */
export interface PlatformSprite {
  __id: string;
  x: number;
  y: number;
  body: ArcadeBody;
  visible: boolean;
  disableBody(disableGameObject?: boolean, hideGameObject?: boolean): void;
  enableBody(reset: boolean, x: number, y: number, enableGameObject?: boolean, showGameObject?: boolean): void;
  setTint(): void;
  clearTint(): void;
  setX(nx: number): void;
}

export interface MakePlatformOpts {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A platform sprite carrying a real arcade body + the canonical disable/enable seams. */
export function makePlatform(opts: MakePlatformOpts): PlatformSprite {
  const plat: PlatformSprite = {
    __id: opts.id,
    x: opts.x,
    y: opts.y,
    body: makeBody({ x: opts.x, y: opts.y, width: opts.width, height: opts.height }),
    visible: true,
    disableBody(_disableGameObject?: boolean, hideGameObject?: boolean) {
      this.body.enable = false; // collision removed — the real consequence
      if (hideGameObject) this.visible = false;
    },
    enableBody(_reset: boolean, x: number, y: number, _enableGameObject?: boolean, showGameObject?: boolean) {
      this.body.enable = true;
      this.x = x;
      this.y = y;
      this.body.x = x - this.body.width / 2;
      this.body.y = y;
      if (showGameObject) this.visible = true;
    },
    setTint() {},
    clearTint() {},
    setX(nx: number) {
      this.x = nx;
    },
  };
  return plat;
}

/** A generic actor sprite (player/enemy): `x` is center; the body tracks it. */
export interface ActorSprite {
  x: number;
  y: number;
  body: ArcadeBody;
  [k: string]: unknown;
}

/** A sprite carrying a real arcade body. `x` is the CENTER; the body tracks it. */
export function makeSprite(opts: MakeBodyOpts): ActorSprite {
  return { x: opts.x, y: opts.y, body: makeBody(opts) };
}

/** A minimal Phaser-Group-shaped container the engine seams read via getChildren(). */
export interface SceneGroup<T = unknown> {
  getChildren(): T[];
  add(child: T): void;
  readonly children: T[];
}

function makeGroup<T>(initial: T[] = []): SceneGroup<T> {
  const children = [...initial];
  return {
    children,
    getChildren: () => children,
    add: (child: T) => {
      children.push(child);
    },
  };
}

/** A real, advanceable scene clock (ms) — what components read via `scene.time.now`. */
export interface SceneClock {
  now: number;
}

/** A get/set registry the engine exposes (some components stash flags on it). */
export interface SceneRegistry {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** The shell scene — the superset of live fields a 2D component reads off BaseLevelScene. */
export interface TestScene {
  /** The real recording bus (its ring buffer is the recorder). */
  eventBus: EventBus;
  /** The advanceable ms clock (ComboChain et al. read `time.now`). */
  time: SceneClock;
  /** The per-frame delta the engine feeds components (`game.loop.delta`). */
  game: { loop: { delta: number } };
  player: ActorSprite;
  platforms: PlatformSprite[];
  /** The ground layer the collider scans (Crumbling/OneWay read `groundLayer.getChildren()`). */
  groundLayer: SceneGroup<PlatformSprite>;
  enemies: SceneGroup<ActorSprite>;
  decorations: SceneGroup<unknown>;
  entities: SceneGroup<unknown>;
  registry: SceneRegistry;
  /** ComboChain folds `scene.comboCount` into __GAME__.comboCount. */
  comboCount: number;
  /** A `__GAME__`-equivalent plain snapshot of observable scene state. */
  snapshot(): Record<string, unknown>;
  [k: string]: unknown;
}

export interface MakeSceneOpts {
  /** Per-frame delta fed to components (default 16ms). */
  dt?: number;
  /** Seed platforms (also populate `groundLayer`). */
  platforms?: PlatformSprite[];
  /** Seed the player sprite (default a 24×24 sprite at 0,0). */
  player?: ActorSprite;
  /** Seed enemies. */
  enemies?: ActorSprite[];
}

/**
 * The scene shell: a fresh recording EventBus, an advanceable `time` clock, the standard
 * groups (platforms/enemies/decorations/entities → groundLayer), a get/set registry, a
 * player, and `snapshot()` (the `__GAME__`-equivalent). Replaces the ~20 hand-rolled
 * `makeScene` copies. Pass seeds for the fields your component reads; everything else is a
 * real, inert default.
 */
export function makeScene(opts: MakeSceneOpts = {}): TestScene {
  const dt = opts.dt ?? 16;
  const platforms = opts.platforms ?? [];
  const player = opts.player ?? makeSprite({ x: 0, y: 0, width: 24, height: 24 });
  const reg = new Map<string, unknown>();
  const scene: TestScene = {
    eventBus: new EventBus(),
    time: { now: 0 },
    game: { loop: { delta: dt } },
    player,
    platforms,
    groundLayer: makeGroup(platforms),
    enemies: makeGroup(opts.enemies ?? []),
    decorations: makeGroup<unknown>(),
    entities: makeGroup<unknown>(),
    registry: {
      get: (key: string) => reg.get(key),
      set: (key: string, value: unknown) => {
        reg.set(key, value);
      },
    },
    comboCount: 0,
    snapshot() {
      return {
        player: {
          x: this.player.x,
          y: this.player.body.y,
          vx: this.player.body.velocity.x,
          vy: this.player.body.velocity.y,
          isGrounded: this.player.body.onFloor(),
        },
        comboCount: this.comboCount,
        platforms: this.platforms.map((p) => ({ id: p.__id, x: p.x, y: p.y, enabled: p.body.enable })),
      };
    },
  };
  return scene;
}
