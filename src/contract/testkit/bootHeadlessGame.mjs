/**
 * bootHeadlessGame.mjs — the real-engine test-world ORACLE.
 * ============================================================================
 *
 * Boots the REAL templates/core + archetype overlay under Phaser.HEADLESS and
 * returns a small, deterministic control surface. The world IS the real engine:
 * a component mounted here runs against the real scene, real arcade physics, the
 * real event bus, and the real window.__GAME__ — so a component that fails in it
 * is the COMPONENT's fault, not the harness's. This is the host the hand-rolled
 * "light kit" shell could not be: ChaseAI gets a real sprite with setVelocityX,
 * CollectScore gets a real scene with fireEffect/consumeReward/registry.
 *
 * ONE API:
 *   const world = await bootHeadlessGame(gameBasisConfig?);
 *   world.game            the live Phaser.Game (HEADLESS)
 *   world.scene           the active default level scene (real BaseLevelScene)
 *   world.bus             the scene's real EventBus (record + replay)
 *   world.step(frames)    advance N deterministic frames (loop.stop + loop.step)
 *   world.snapshot()      the window.__GAME__ observed surface (JSON)
 *   world.mountSystem(id, params?)            resolve+attach a kind=system via the
 *                                             engine's OWN resolver (DataLevelScene path)
 *   world.mountBehavior(id, params?, owner?)  resolve+attach a kind=behavior onto a
 *                                             real owner (defaults to a spawned enemy sprite)
 *   world.spawnEnemy(opts?)   a real arcade enemy sprite in scene.enemies (a behavior host)
 *   world.destroy()       tear the game down
 *
 * gameBasisConfig is GAME-BASIS data only (viewport, physics) — COMPONENT-BLIND.
 * The default boots the real default Level1Scene.
 *
 * DETERMINISM (patch 5): after the engine reaches `ready` we STOP the real-time
 * rAF loop and advance EXCLUSIVELY via manual loop.step(now += 1000/60). Two runs
 * of the same step count over the same setup produce identical state.
 */
import { pathToFileURL } from 'node:url';
import { setupHeadlessDom } from './dom-env.mjs';
import { buildHeadlessBundle } from './bundle.mjs';
import { assertPhaserPin } from './phaser-pin.mjs';

/** Fixed deterministic frame delta (ms) — 60fps, matches the engine's loop. */
const FRAME_MS = 1000 / 60;

/**
 * Boot the real engine world for an archetype.
 * @param {object} [gameBasisConfig] viewport/physics overrides (component-blind).
 * @param {string} [gameBasisConfig.archetype='platformer'] which module to overlay.
 * @returns the world control surface (see file header).
 */
export async function bootHeadlessGame(gameBasisConfig = {}) {
  const archetype = gameBasisConfig.archetype ?? 'platformer';

  // Guard the pin BEFORE anything else: a Phaser drift should fail here, loud.
  assertPhaserPin();

  // Patches 1-3: the headless DOM (jsdom + Image/context shims). Must run before
  // the bundle (which constructs Phaser at import-time indirectly) is imported.
  setupHeadlessDom();

  // Build (or reuse) the assembled real-engine bundle, then import it.
  const { bundlePath } = await buildHeadlessBundle(archetype);
  const mod = await import(pathToFileURL(bundlePath).href);
  const { bootHeadless, resolveSystem, resolveBehavior, BehaviorManager } = mod;

  const { game, hook } = bootHeadless(gameBasisConfig);

  // ── reach READY: let the rAF loop start, then STOP it and drive manually ──
  await settleRunning(game);
  game.loop.stop(); // patch 5: kill the real-time loop → deterministic from here
  await delay(20); // drain any in-flight rAF callback

  let now = game.loop.now || 0;
  const driveN = (n) => {
    for (let i = 0; i < n; i++) {
      now += FRAME_MS;
      game.loop.step(now);
    }
  };

  // Preloader.create → TitleScreen; the title gates the level on input. Headless,
  // we start the default level directly (the engine seam the title-gate triggers).
  driveN(5);
  if (!game.scene.isActive('Level1Scene')) game.scene.start('Level1Scene');
  // Step until ready latches (BaseLevelScene.markReady on the first interactive frame).
  for (let f = 0; f < 180 && !hook.ready; f++) driveN(1);
  if (!hook.ready) {
    throw new Error(
      '[testkit] engine did not reach __GAME__.ready within 180 frames',
    );
  }

  const scene = game.scene.getScene('Level1Scene');

  // Components mounted via the harness, ticked each step() exactly as the engine
  // ticks scene.systems / a bound owner's behaviors in DataLevelScene.update().
  const mountedSystems = [];
  const mountedBehaviorOwners = [];

  /** Advance N frames, then tick every harness-mounted component (engine order). */
  function step(frames = 1) {
    for (let f = 0; f < frames; f++) {
      driveN(1); // real engine frame: input/physics/scene.update integrate
      for (const sys of mountedSystems) sys.update?.();
      for (const owner of mountedBehaviorOwners) {
        if (owner && owner.active !== false && owner.behaviors) {
          owner.behaviors.update();
        }
      }
    }
  }

  /**
   * Mount a kind=system through the engine's OWN resolver, attaching it via the
   * exact DataLevelScene path (reset → attach → setupCollisions). Returns the
   * constructed system (so a test can read its public inspection methods).
   */
  function mountSystem(id, params) {
    const sys = resolveSystem(id, params);
    if (!sys) {
      throw new Error(
        `[testkit] resolveSystem("${id}") returned undefined — not in the engine's SYSTEM_CLASSES`,
      );
    }
    sys.reset?.();
    sys.attach(scene);
    sys.setupCollisions?.();
    mountedSystems.push(sys);
    return sys;
  }

  /**
   * Mount a kind=behavior through the engine's OWN resolver, attaching it onto a
   * real owner. The owner defaults to a freshly spawned enemy sprite (a real
   * arcade body with setVelocityX/Y — the host the light-kit shell lacked); pass
   * an explicit owner to attach onto the player or another live object. Returns
   * the constructed behavior.
   */
  function mountBehavior(id, params, owner) {
    const Cls = resolveBehavior(id);
    if (!Cls) {
      throw new Error(
        `[testkit] resolveBehavior("${id}") returned undefined — not in the engine's BEHAVIOR_CLASSES`,
      );
    }
    const host = owner ?? spawnEnemy();
    const beh = new Cls(params ?? {});
    // Attach through the engine's REAL BehaviorManager (BehaviorManager.add calls
    // beh.attach(owner) — the exact DataLevelScene.attachBehaviors path).
    if (!host.behaviors) host.behaviors = new BehaviorManager(host);
    host.behaviors.add(`testkit_${id}`, beh);
    if (!mountedBehaviorOwners.includes(host)) mountedBehaviorOwners.push(host);
    // Point a target-taking behavior (ChaseAI) at the player by default.
    if (typeof beh.setTarget === 'function' && scene.player) {
      beh.setTarget(scene.player);
    }
    return beh;
  }

  /** A real arcade enemy sprite in scene.enemies — a behavior host with a body. */
  function spawnEnemy(opts = {}) {
    const x = opts.x ?? scene.mapWidth / 2;
    const y = opts.y ?? scene.mapHeight / 2;
    const sprite = scene.physics.add.sprite(x, y, '__px');
    sprite.setDisplaySize(opts.width ?? 40, opts.height ?? 48);
    const body = sprite.body;
    body.setAllowGravity(opts.gravity ?? false);
    sprite.__type = 'enemy';
    sprite.__id = opts.id ?? `testkit_enemy_${scene.enemies?.getLength?.() ?? 0}`;
    scene.enemies?.add(sprite);
    return sprite;
  }

  return {
    game,
    scene,
    bus: scene.eventBus,
    hook,
    step,
    snapshot: () => hook.snapshot(),
    mountSystem,
    mountBehavior,
    spawnEnemy,
    destroy: () => game.destroy(true),
  };
}

// ── small internals ─────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve once the game's rAF loop has started (game.isRunning). */
function settleRunning(game) {
  return new Promise((res) => {
    if (game.isRunning) return res();
    const i = setInterval(() => {
      if (game.isRunning) {
        clearInterval(i);
        res();
      }
    }, 2);
  });
}
