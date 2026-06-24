# @contract/testkit — shared component DRIVE-test kit

The reusable test environment for archetype-registry components. **Extracted** (not rewritten)
from the proven, green drive tests under `templates/modules/platformer/src/{systems,behaviors}/__tests__/`,
so a new drive test is **~20–30 lines** (mount → drive → assert) instead of ~300 — and no test
re-derives a physics world or re-hits the `window is not defined` phaser wall.

Resolvable as `@contract/testkit` via the same `@contract/*` → `core-contract/src` alias the
components already use (so `tsc --noEmit` and the run hook both find it; no extra wiring).

## Run a test (durable canonical form)

Run cwd = `templates/core` (its `node_modules` carries phaser/etc.); the `--import` path and the
test path are relative to it:

```sh
cd templates/core
node --import ../core-contract/src/testkit/register.mjs \
  ../modules/<archetype>/src/<systems|behaviors>/__tests__/<Name>.drive.test.ts
```

The one `register.mjs` entry makes `@contract/*` AND `phaser`→stub resolve and retries
extensionless `.ts` relative imports, so it runs **system and behavior** tests alike — replacing
the old per-module `contract-alias-hook*` / `behavior-test-*` shims. (No `node_modules/@contract`
symlink is needed; the relative `--import` is self-contained.)

## API (import from `@contract/testkit`)

- **World** — `makeArcadeWorld({gravityPerFrame?})`, `makeBody({x,y,width,height})`: real arcade
  body + gravity integrator + face-aware collider (honors `checkCollision.up/down` + `body.prev`;
  one-way folded in; a disabled body = collision removed).
- **Scene** — `makeScene(opts?)`: a fresh recording `EventBus`, an advanceable `time` clock, the
  standard groups (platforms/enemies/decorations/entities), a get/set `registry`, a `player`, and
  `snapshot()` (a `__GAME__`-equivalent plain object). `makePlatform(opts)`, `makeSprite(opts)`.
- **Drivers** — `mount(component, scene)` (reset+attach), `step(scene, frames, components?, world?)`
  (stampPrev→integrate→update→resolve, advances clock+bus frame), `hold/release(scene, key)`,
  `emit(scene, type, payload)`, `hit(scene, enemy, dmg)`.
- **Asserts** — `check(label, cond, detail?)` (throw-on-fail), `assertEmitted(bus, type, payloadShape?)`,
  `assertNotEmitted(...)`, `assertObservable(scene, path, transition)`, `assertionsPassed()`.

## The bar (test-discipline — unchanged from the exemplars)

A drive test must FAIL when the component is wrong. Drive the REAL verb through the REAL seam
(`update()`/`attach()`, never a private method), assert each declared `surface()` event + its
`expect` transition on OBSERVABLE state, and include a **counterfactual** (don't trigger the verb →
no event, no state change) that goes red on a no-op. Canonical exemplars:
`platformer/src/systems/__tests__/CrumblingPlatform.drive.test.ts` (kit-migrated) and `ComboChain.drive.test.ts`.

---

# `bootHeadlessGame()` — the REAL-ENGINE oracle world (sibling of the light kit)

The light kit above drives a component against a hand-rolled scene SHELL — fast, but a shell
can only host what we model on it (a component wanting `owner.setVelocityX` or
`scene.consumeReward` is "needs-host" there). `bootHeadlessGame()` is the other oracle: it boots
the **real** `templates/core` + archetype overlay under `Phaser.HEADLESS` + jsdom and mounts the
component into the **real** scene. The world IS the real engine — a component that fails in it is
the **component's** fault. Use it to PROVE a `needs-host` component, or to verify a component
against the genuine scene/physics/bus rather than a model of them.

## Run

```sh
cd templates/core
npm run testkit:smoke   # the CANARY: boot → ready → deterministic step → a real component fires
node ../core-contract/src/testkit/bootHeadless.oracle.mjs   # the needs-host proof (ChaseAI + CollectScore)
```

`jsdom` + `esbuild` live in `templates/core` devDeps (the run cwd) — the ONE place the harness
deps land. **No native `node-canvas`**: a dimension-only Image stub + a no-op 2D context reach
`__GAME__.ready`, step deterministically, and fire a real component — ~9× faster boot than
node-canvas and CI-portable (verified).

## API

```js
import { bootHeadlessGame } from '../core-contract/src/testkit/bootHeadlessGame.mjs';
const world = await bootHeadlessGame(gameBasisConfig?);   // { archetype?, width?, height?, physics? }
//   world.game / world.scene / world.bus / world.hook
//   world.step(frames)                       advance N deterministic frames (loop.stop + manual loop.step)
//   world.snapshot()                         the real window.__GAME__ surface (JSON)
//   world.mountSystem(id, params?)           resolve+attach a kind=system via the engine's OWN resolver
//   world.mountBehavior(id, params?, owner?) resolve+attach a kind=behavior onto a real owner (defaults
//                                            to a spawned enemy sprite — a real body with setVelocityX)
//   world.spawnEnemy(opts?)                  a real arcade enemy sprite (a behavior host)
//   world.destroy()
```

`gameBasisConfig` is GAME-BASIS data only (archetype, viewport, physics) — **component-blind**;
the default boots the archetype's real default `Level1Scene`.

## Pin + the five patches (guard on a Phaser bump)

The boot relies on 5 version-specific patches (`dom-env.mjs` patches 1-3, `boot-entry.ts` patch 4,
`bootHeadlessGame.mjs` patch 5): (1) window globals onto globalThis · (2) dimension-only Image stub ·
(3) null 2D context · (4) `Graphics.generateTexture` shim · (5) deterministic `loop.stop`/`loop.step`.
`phaser-pin.mjs` pins the engine Phaser (3.90.0); the smoke asserts it, so a bump **fails loud**
with the list of patches to re-verify. The `.cache/` (assembled merged-src + esbuild bundle,
content-hashed per archetype) is build output — gitignored, regenerated on demand.

## Note: the default boot scene is `BaseLevelScene`, not `DataLevelScene`

The default `Level1Scene` extends `BaseLevelScene`, which provides `registry` / `decorations` /
`eventBus` / `utils.setScore` but NOT the `DataLevelScene`-only `consumeReward` / `fireEffect` /
`rewardsById`. So `CollectScore` scores + logs `score.changed` on the real bus (the host the shell
lacked), but its `consumeReward?.()` optional-chains to a no-op — a true property of the chosen
default scene, not a harness gap. A future `gameBasisConfig` that boots a `DataLevelScene` from
level data would add those seams.

---

# Oracle drive tests (per-cap) — the convention for the oracle-only 2D archetypes

The platformer light-kit `*.drive.test.ts` (top of this file) drives a component against the
hand-rolled arcade shell. That shell is platformer-shaped — it has no faithful board / auto-scroll
/ shmup / brick-physics world — so the **four newer 2D archetypes** (`grid_logic`,
`endless_runner`, `gallery_shooter`, `paddle_ball`) get their per-cap drive tests against the
**real engine** instead, via `bootHeadlessGame({archetype})`. These are the **`*.oracle.test.mjs`**
tests. (`platformer` + `top_down` stay on the light kit.)

## File + run convention
- **One file per capability**, beside the component:
  `templates/modules/<archetype>/src/<systems|behaviors>/__tests__/<Name>.oracle.test.mjs`
- A standalone `.mjs` (like `bootHeadless.oracle.mjs`), **run directly** — there is **no aggregate
  runner**; cwd-independent (run from the repo root):
  ```sh
  node templates/modules/<archetype>/src/<systems|behaviors>/__tests__/<Name>.oracle.test.mjs
  # run a whole archetype's batch:
  for f in $(find templates/modules/<archetype>/src -name '*.oracle.test.mjs'); do node "$f" || break; done
  ```
- Import depth is **identical** for `systems/__tests__` and `behaviors/__tests__`:
  `import { bootHeadlessGame } from '../../../../../core-contract/src/testkit/bootHeadlessGame.mjs';`
- The test **mounts through the engine's OWN resolver** (`world.mountSystem`/`world.mountBehavior`)
  and so **never imports the component** — a failure is the component's fault, not the test's.

## The bar (test-discipline — the same as the light kit, on the real engine)
1. **Drive the REAL verb**, never the private emitter: emit the real upstream bus seam, spawn the
   real fixtures (as `bootHeadless.oracle.mjs` spawns a reward sprite), inject the real input/owner
   state, call the **public** verb method a collision/pickup/input would call, or step the engine.
   NEVER call the component's own private `emit`, and NEVER assert by only calling `surface()`.
2. **Assert the declared `surface()` event** on `bus.recent(cursor)` (type + payload) **AND** the
   observable transition its `expect` names (a `registry` value / body or tile state / `snapshot()`
   field). For a cap whose `surface()` declares **no events**, assert the observable
   movement/state transition instead — do not invent an event.
3. **A counterfactual that goes RED on a no-op**: with the verb NOT driven, the event count is 0
   (or the observable state is unchanged). This is what proves the test is non-vacuous — it is the
   line `registry:conformance` (mount + 30 passive frames) cannot give you.
4. **Test-the-test** before trusting it: mutate the component source to no-op the verb, re-run, watch
   it go red for the right reason, revert. (The content-hash bundle cache rebuilds on the edit.)
5. **Drop-don't-fake**: if a cap genuinely cannot be driven in the default boot, drop it and report
   the concrete blocker — never write an always-green test.

## Canonical exemplars
- `paddle_ball/src/systems/__tests__/ScoreCombo.oracle.test.mjs` — the minimal pattern (bus-driven).
- The full `paddle_ball/src/{systems,behaviors}/__tests__/` batch — the variety: real input
  (`PaddleController`), real ball↔brick collisions (`BrickGrid`), spawned fixtures + overlap catch
  (`PowerUpDrop`), and public pickup seams (`PaddleGrow`).
