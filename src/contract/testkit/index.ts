/**
 * @contract/testkit — the shared, reusable component-test KIT.
 *
 * Resolvable as `@contract/testkit` via the SAME `@contract/*` → core-contract/src alias the
 * components already use. A new drive test imports from here and becomes ~20–30 lines
 * (mount → drive → assert) instead of ~300; no test re-derives a physics world or re-hits
 * the `window is not defined` wall.
 *
 * EXTRACTED (not rewritten) from the proven, green exemplar drive tests under
 * templates/modules/platformer/src/{systems,behaviors}/__tests__/. See each module's
 * header for the exact source it was lifted from.
 *
 * Run a test under the single entry (durable form — run cwd = templates/core, relative path,
 * no node_modules symlink needed):
 *   node --import ../core-contract/src/testkit/register.mjs <path/to/X.drive.test.ts>
 * which makes BOTH `@contract/*` AND `phaser`→stub resolve + retries extensionless `.ts`.
 */

// The arcade-2D world: body + integrator + face-aware collider (incl. one-way).
export {
  makeArcadeWorld,
  makeBody,
  type ArcadeWorld,
  type ArcadeWorldOpts,
  type ArcadeBody,
  type MakeBodyOpts,
} from './arcade-world';

// The scene shell + sprite factories (replaces the ~20 hand-rolled makeScene copies).
export {
  makeScene,
  makePlatform,
  makeSprite,
  type TestScene,
  type MakeSceneOpts,
  type PlatformSprite,
  type ActorSprite,
  type MakePlatformOpts,
  type SceneGroup,
  type SceneClock,
  type SceneRegistry,
} from './scene';

// Drivers: mount / step / hold / release / emit / hit.
export {
  mount,
  step,
  hold,
  release,
  emit,
  hit,
  type DriveComponent,
} from './drivers';

// Asserts: check / assertEmitted / assertNotEmitted / assertObservable + the tally.
export {
  check,
  assertEmitted,
  assertNotEmitted,
  assertObservable,
  assertionsPassed,
  resetAssertions,
} from './asserts';

// The recording bus is re-exported from the kit for convenience (its ring buffer is the
// recorder; `bus.recent()` reads it). Same class the components emit on.
export { EventBus } from '../component-surface';
