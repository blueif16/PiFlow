/**
 * drivers.ts — the verbs that DRIVE a component through its real seams.
 *
 * EXTRACTED from the per-frame loops the exemplars hand-rolled (Crumbling's
 * `physicsStep + sys.update()`, OneWay's `stampPrev → integrate → sys.update → resolve`,
 * ComboChain's `bus.emit(...)`). A driver NEVER calls a private method or sets observable
 * state directly — it drives the EXACT engine seam (the per-frame `update()`, the shared
 * bus emit, the input state schemes read), so the observable transition EMERGES.
 */

import { makeArcadeWorld, type ArcadeWorld } from './arcade-world';
import type { TestScene } from './scene';

/** The minimal seam a system/behavior component exposes to the engine per frame. */
export interface DriveComponent {
  /** The build-time attach seam (DataLevelScene calls this once with the live scene). */
  attach?(scene: unknown): void;
  /** Some components reset internal state before attach (the exemplars call it). */
  reset?(): void;
  /** The exact per-frame engine call (`for (const sys of systems) sys.update?.()`). */
  update?(): void;
}

/** Mount a component onto the scene via its REAL attach/reset seam (never a fake wiring). */
export function mount(component: DriveComponent, scene: TestScene): void {
  component.reset?.();
  component.attach?.(scene);
}

/**
 * Advance the world `frames` times. Each frame runs the EXACT engine order:
 * stampPrev → integrate → each component's real `update()` → collider resolve, advancing
 * the scene clock by `game.loop.delta` and stamping the bus frame. The component is driven
 * ONLY through `update()` (the real seam), never by calling its private verbs.
 *
 * Pass a single component or an array (the systems list). The world is created once and
 * reused across calls when you pass `scene`-level state; for a fresh tuning, pass `world`.
 */
export function step(
  scene: TestScene,
  frames: number,
  components: DriveComponent | DriveComponent[] = [],
  world: ArcadeWorld = sharedWorld(scene),
): void {
  const comps = Array.isArray(components) ? components : [components];
  for (let f = 0; f < frames; f++) {
    world.stampPrev(scene.player);
    world.integrate(scene.player);
    for (const c of comps) c.update?.();
    world.resolve(scene.player, scene.platforms);
    scene.time.now += scene.game.loop.delta;
    const frame = ((scene.__frame as number) ?? 0) + 1;
    scene.__frame = frame;
    scene.eventBus.setFrame(frame);
  }
}

/** One world per scene (cached on the scene), so repeated `step()` calls share tuning. */
function sharedWorld(scene: TestScene): ArcadeWorld {
  const cached = scene.__world as ArcadeWorld | undefined;
  if (cached) return cached;
  const world = makeArcadeWorld({ gravityPerFrame: 4 });
  scene.__world = world;
  return world;
}

/** Set an input key DOWN in the state the control schemes read (`scene.input.<key>`). */
export function hold(scene: TestScene, key: string): void {
  const input = (scene.input as Record<string, boolean>) ?? ((scene.input = {}) as Record<string, boolean>);
  input[key] = true;
}

/** Release an input key (clear the state the control schemes read). */
export function release(scene: TestScene, key: string): void {
  const input = (scene.input as Record<string, boolean>) ?? ((scene.input = {}) as Record<string, boolean>);
  input[key] = false;
}

/** Drive the engine bus seam: emit `type` with `payload` on the shared recording bus
 *  exactly as the engine does (the real announce, not a private call). */
export function emit(scene: TestScene, type: string, payload?: unknown): void {
  scene.eventBus.emit(type, payload);
}

/** Drive a landed hit on an enemy through the engine bus seam: announce `enemy.damaged`
 *  (or `enemy.died` when the hit is lethal), the exact `BaseEnemy.takeDamage` emit. */
export function hit(scene: TestScene, enemy: { __id?: string; x?: number; y?: number; health?: number }, dmg: number): void {
  const health = (enemy.health ?? 1) - dmg;
  enemy.health = health;
  const base = { id: enemy.__id ?? 'enemy', x: enemy.x ?? 0, y: enemy.y ?? 0 };
  if (health <= 0) scene.eventBus.emit('enemy.died', base);
  else scene.eventBus.emit('enemy.damaged', { ...base, health, damage: dmg });
}

export { makeArcadeWorld };
