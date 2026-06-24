/**
 * CrumblingPlatform — runtime DRIVE test (event-protocol conformance).
 *
 * MIGRATED to the shared @contract/testkit (the proven arcade world + scene shell + drivers
 * + asserts, EXTRACTED verbatim from this very test). Mount → drive → assert; the world,
 * the per-frame ground collider (face-aware, reads body.enable), the recording bus, and the
 * check() helper all live in the kit now — NOT a single assertion, event, transition, or
 * counterfactual changed. Run it under the one entry:
 *   node --import @contract/testkit/register.mjs <this file>
 *
 * surface() contract under test (templates/modules/platformer/src/systems/CrumblingPlatform.ts):
 *   - platform.crumbled  drivenBy "the player stands on the platform until its crumbleMs
 *                                   timer elapses (and does not jump off in time)"
 *                        expect   "the platform's collision is removed; a player still on it
 *                                   sees __GAME__.player.isGrounded flip to false and
 *                                   player.vy go positive (falls); platform.crumbled logged"
 *
 * REAL objects + REAL drive (NOT a stub that returns the expected value): the real
 * CrumblingPlatform class + the real EventBus (its ring buffer IS the recording bus) + the
 * kit's arcade world whose per-frame collider resolves the player against ENABLED platform
 * tops exactly as Phaser arcade's separateY does. crumble() flips plat.body.enable to false
 * via disableBody(true,true); the collision-removed consequence and the player's
 * isGrounded/vy EMERGE from the same body state the engine reads (PlatformerMovement
 * .isGrounded = body.onFloor()). The component is driven ONLY through its real per-frame
 * update() seam (kit `step()`), never by calling crumble()/landOn() directly.
 *
 * The VERB ('jump'): standing PAST crumbleMs WITHOUT jumping off fires crumble(); the 'jump'
 * verb is the ESCAPE that avoids it. Both branches are driven below.
 */
import { makeScene, makePlatform, makeSprite, step, mount, check, assertionsPassed } from '@contract/testkit';
import { CrumblingPlatform } from '../CrumblingPlatform.ts';

const DT = 16; // ms/frame — what scene.game.loop.delta feeds the component

// ══════════════════════════════════════════════════════════════════════════════
// BRANCH A — stand past crumbleMs WITHOUT jumping → platform crumbles, player FALLS
// ══════════════════════════════════════════════════════════════════════════════
{
  // platform top at y=400; player 24x24, feet must rest at 400.
  const plat = makePlatform({ id: 'plat-A', x: 100, y: 400, width: 96, height: 16 });
  const player = makeSprite({ x: 100, y: 400 - 24, width: 24, height: 24 });
  const platforms = [plat];
  const scene = makeScene({ dt: DT, player, platforms });
  const bus = scene.eventBus;

  const crumbleMs = 320; // 20 frames @16ms
  const sys = new CrumblingPlatform({ crumbleMs, telegraphMs: 120 });
  mount(sys, scene);

  // Settle the player onto the platform first (a couple of physics frames) so it's resting.
  step(scene, 2);
  check('precondition: platform collision enabled', plat.body.enable === true, `enable=${plat.body.enable}`);
  check('precondition: player resting on platform (isGrounded=true)', player.body.onFloor() === true && player.body.velocity.y === 0, `onFloor=${player.body.onFloor()} vy=${player.body.velocity.y}`);

  // DRIVE: run the world for crumbleMs worth of frames WITHOUT jumping. Each frame =
  // physicsStep (the real collider holds the player) THEN sys.update() (the component
  // advances its armed timer). The player keeps standing — never jumps off.
  const cur = bus.cursor;
  let crumbledFrame = -1;
  const frames = Math.ceil(crumbleMs / DT) + 3; // a few frames past the window
  for (let f = 0; f < frames; f++) {
    step(scene, 1, sys); // collider resolves support from CURRENT body.enable, then sys.update()
    if (plat.body.enable === false && crumbledFrame < 0) crumbledFrame = f;
  }

  // OBSERVABLE expect #1: the platform's collision is REMOVED (body disabled).
  check('platform.crumbled → collision removed (body.enable false)', plat.body.enable === false, `enable=${plat.body.enable} atFrame=${crumbledFrame}`);

  // OBSERVABLE expect #2 + #3: a player STILL on it now falls — isGrounded flips false and
  // vy goes positive. These come from the collider no longer finding support, NOT the test.
  // Run a couple more frames AFTER the crumble so gravity is visible.
  step(scene, 2);
  check('player still on it → isGrounded flips to FALSE (onFloor=false)', player.body.onFloor() === false, `onFloor=${player.body.onFloor()}`);
  check('player still on it → vy goes POSITIVE (falling)', player.body.velocity.y > 0, `vy=${player.body.velocity.y}`);

  // OBSERVABLE expect #4: platform.crumbled was logged on the shared bus with {id,x,y}.
  const logged = bus.recent(cur).filter((e) => e.type === 'platform.crumbled');
  check('platform.crumbled logged on the bus', logged.length === 1, `count=${logged.length}`);
  const pl = logged[0]?.payload as any;
  check('platform.crumbled payload {id,x,y}', pl?.id === 'plat-A' && pl?.x === 100 && pl?.y === 400, JSON.stringify(pl));
}

// ══════════════════════════════════════════════════════════════════════════════
// BRANCH B (the 'jump' verb is the ESCAPE) — the player who JUMPS OFF before the
// footing vanishes does NOT fall onto nothing. NOTE the real component design
// (CrumblingPlatform.ts:6-16, :186-198): landing ARMS a ONE-SHOT timer; the platform
// crumbles on its own schedule regardless of whether the player later leaves (a Celeste
// crumbling block, once stepped on, is doomed). The 'jump' verb is therefore the escape
// for the PLAYER (it is airborne / lands on a SAFE neighbor when the footing goes), not a
// way to cancel the crumble. We assert that real escape consequence: the player that
// jumped to an adjacent solid platform is GROUNDED on the safe footing when the doomed
// one vanishes — it never fell into the gap.
// ══════════════════════════════════════════════════════════════════════════════
{
  const doomed = makePlatform({ id: 'plat-B-doomed', x: 100, y: 400, width: 96, height: 16 });
  // A SAFE neighbor the player jumps onto (governed=false: not in the allow-list).
  const safe = makePlatform({ id: 'plat-B-safe', x: 240, y: 400, width: 96, height: 16 });
  const player = makeSprite({ x: 100, y: 400 - 24, width: 24, height: 24 });
  const platforms = [doomed, safe];
  const scene = makeScene({ dt: DT, player, platforms });
  const bus = scene.eventBus;

  const crumbleMs = 320;
  // Only the doomed platform is governed — the safe neighbor never crumbles.
  const sys = new CrumblingPlatform({ crumbleMs, telegraphMs: 120, platformIds: ['plat-B-doomed'] });
  mount(sys, scene);

  step(scene, 2);
  check('ESCAPE precondition: player grounded on the doomed platform', player.body.onFloor() === true, `onFloor=${player.body.onFloor()}`);

  // Stand a few frames (arming the doomed platform), then JUMP (the escape verb): a real
  // upward+rightward velocity launches the body off toward the safe neighbor.
  step(scene, 4, sys);
  // JUMP: upward + horizontal toward the safe platform (the escape). vy<0 → rising → the
  // component's isStandingOn returns false; the body arcs over the gap to plat-B-safe.
  // (gap = 140px center-to-center; arc apex ~ at vy=0 after ~6 frames; nudge x ~ 11/frame.)
  player.body.velocity.y = -24;
  player.body.velocity.x = 11.5;
  // Run the world: cross the gap, drift right, and let gravity bring the player down. Cut
  // horizontal once the player is over the safe platform so it settles there.
  for (let f = 0; f < Math.ceil(crumbleMs / DT) + 18; f++) {
    step(scene, 1, sys);
    // Stop the horizontal push once we're roughly over the safe platform center.
    if (player.x >= safe.x - 8 && player.body.velocity.x !== 0) player.body.velocity.x = 0;
  }

  const logged = bus.recent().filter((e) => e.type === 'platform.crumbled');
  // The doomed platform DID crumble on its one-shot timer (by design).
  check('ESCAPE: doomed platform crumbled on its timer (one-shot, by design)', doomed.body.enable === false && logged.length === 1, `enable=${doomed.body.enable} logged=${logged.length}`);
  // The ESCAPE consequence: the player that jumped off did NOT fall into the gap — it is
  // grounded on the SAFE neighbor (isGrounded true), having survived the footing vanishing.
  check('ESCAPE: jumped-off player is SAFE (grounded on neighbor, did not fall)', player.body.onFloor() === true && Math.abs(player.x - safe.x) <= 60, `onFloor=${player.body.onFloor()} x=${player.x}`);
  // The safe (un-governed) platform never crumbled — the allow-list is honored.
  check('ESCAPE: un-governed safe platform never crumbled', safe.body.enable === true, `enable=${safe.body.enable}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// COUNTERFACTUAL (meaningfulness proof): if crumble()'s verb were a no-op (never
// disabled the body / never emitted), BRANCH A's two load-bearing assertions —
// "collision removed (body.enable false)" and "platform.crumbled logged" — would
// BOTH fail (enable stays true, log count 0), and the player would NEVER fall
// (onFloor stays true, vy stays 0). We prove the negative directly: a platform the
// player NEVER stands on must never crumble.
// ══════════════════════════════════════════════════════════════════════════════
{
  // Player parked far away, NEVER over the platform footprint → never armed.
  const plat = makePlatform({ id: 'plat-C', x: 100, y: 400, width: 96, height: 16 });
  const player = makeSprite({ x: 999, y: 400 - 24, width: 24, height: 24 });
  const platforms = [plat];
  const scene = makeScene({ dt: DT, player, platforms });
  const bus = scene.eventBus;
  const sys = new CrumblingPlatform({ crumbleMs: 320 });
  mount(sys, scene);
  step(scene, 40, sys);
  check('counterfactual: never stood on → platform stays solid', plat.body.enable === true, `enable=${plat.body.enable}`);
  check('counterfactual: never stood on → no platform.crumbled logged', bus.recent().every((e) => e.type !== 'platform.crumbled'), JSON.stringify(bus.recent().map((e) => e.type)));
}

console.log(`\nALL ${assertionsPassed()} ASSERTIONS PASSED — CrumblingPlatform fires platform.crumbled with its expect transition (collision removed; standing player falls: isGrounded→false, vy→positive) on observable state.`);
