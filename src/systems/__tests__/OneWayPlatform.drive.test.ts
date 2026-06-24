/**
 * OneWayPlatform — runtime DRIVE test (event-protocol conformance).
 *
 * Proves the component actually FIRES at runtime by driving its real verb against
 * REAL objects and asserting EACH declared surface() event with its `expect`
 * transition on OBSERVABLE state — PLUS the jump-through collision MECHANIC (pass UP
 * from below, land/block from ABOVE) that is OneWayPlatform's real payload.
 *
 * surface() contract under test (templates/modules/platformer/src/systems/OneWayPlatform.ts):
 *   - platform.passedThrough  drivenBy "jump (the player rises up into the platform from below)"
 *                             expect   "__GAME__.player.y crosses the platform top with
 *                                        __GAME__.player.isGrounded staying false (no collision);
 *                                        platform.passedThrough logged"
 *   - platform.landedOn       drivenBy "jump (the player descends onto the platform from above)"
 *                             expect   "__GAME__.player.isGrounded flips true and __GAME__.player.y
 *                                        rests at the platform top; platform.landedOn logged"
 *
 * REAL objects + REAL drive (NOT a stub that returns the expected value):
 *   - The real OneWayPlatform class + the real EventBus (its ring buffer IS the recording
 *     bus — every emit is captured in `bus.recent()`).
 *   - A minimal arcade-physics WORLD with a REAL per-frame collider that HONORS the
 *     body.checkCollision DIRECTIONAL FLAGS — which is exactly what OneWayPlatform
 *     toggles. Each frame: stamp body.prev (the prior position the engine exposes and the
 *     component reads), gravity adds to velocity.y, position integrates, then the collider
 *     resolves the player against the platform top ONLY IF that platform's
 *     checkCollision.up is true. So whether the rising player passes through (component set
 *     up=false) or the descending player lands (component set up=true) is NOT decided by
 *     the test — it EMERGES from the flags OneWayPlatform set and the collider's honoring
 *     of them (PlatformerMovement.isGrounded = body.onFloor() = body.blocked.down).
 *   - The component is driven ONLY through its real per-frame seam update() (the exact
 *     `for (const sys of this.systems) sys.update?.()` call in DataLevelScene.ts:136),
 *     never by calling solidFromAbove()/passThrough()/landFrom()/passUp() directly.
 *
 * THE VERB ('jump'): rising UP into a ledge from below fires platform.passedThrough (the
 * player crosses with isGrounded staying false); arcing back DOWN onto it fires
 * platform.landedOn (isGrounded flips true at the top). Both are driven below.
 */
import { makeScene, makePlatform, makeSprite, step, check, assertionsPassed } from '@contract/testkit';
import { OneWayPlatform } from '../OneWayPlatform.ts';

const DT = 16; // ms/frame

// The kit's `makeArcadeWorld` (the world `step()` drives) IS this test's original face-aware
// collider, extracted verbatim: it honors `body.checkCollision.up/down` + `body.prev`, so a
// rising player passes through a one-way ledge (down face off) and a descending player lands
// (up face on). Whether the player passes or lands EMERGES from the faces OneWayPlatform sets,
// not the test. The kit `step(scene, 1, sys)` runs the exact engine order:
//   stampPrev → integrate → sys.update() (toggle faces + fire edges) → collider resolve.
// `makeSprite` gives the player a real arcade body; `makePlatform` a real-bodied ledge.

// ══════════════════════════════════════════════════════════════════════════════
// BRANCH A (platform.passedThrough) — the player JUMPS up from BELOW the ledge. The
// component sees its feet were below the top last frame and is moving up → pass-through.
// The player crosses the top with isGrounded staying FALSE (no collision) and
// platform.passedThrough fires once.
// ══════════════════════════════════════════════════════════════════════════════
{
  // Ledge top at y=300. Player starts BELOW it (feet at y=420) and jumps hard upward.
  const plat = makePlatform({ id: 'ledge-A', x: 100, y: 300, width: 120, height: 16 });
  const player = makeSprite({ x: 100, y: 396, width: 24, height: 24 }); // feet at 420
  const platforms = [plat];
  const scene = makeScene({ dt: DT, player, platforms });
  const bus = scene.eventBus;

  const sys = new OneWayPlatform({ tolerance: 4 });
  sys.reset();
  sys.attach(scene);

  // Settle one frame so lastRelation is recorded as 'below' (feet below the top).
  step(scene, 1, sys);
  check('precondition: player starts BELOW the ledge (feet under the top)', player.body.bottom > 300, `feet=${player.body.bottom}`);
  check('precondition: relation to the ledge is "below"', sys.relationOf('ledge-A') === 'below', `relation=${sys.relationOf('ledge-A')}`);

  const cur = bus.cursor;
  // DRIVE the verb: JUMP — a strong upward velocity that clears the ledge top (feet 424 →
  // apex well above 300). The component (feet were below last frame, moving up) sets
  // pass-through so the collider never catches it. Crossing the top while moving up fires
  // platform.passedThrough.
  player.body.velocity.y = -44;
  let groundedDuringCross = false;
  let crossedTop = false;
  let headBlocked = false;
  for (let f = 0; f < 30; f++) {
    step(scene, 1, sys);
    if (player.body.bottom <= 300) crossedTop = true; // feet are now above the top
    if (crossedTop && player.body.velocity.y < 0 && player.body.onFloor()) groundedDuringCross = true;
    if (player.body.blocked.up) headBlocked = true; // the underside bonked the head (would happen if SOLID)
    if (player.body.velocity.y >= 0) break; // reached the apex
  }

  // OBSERVABLE expect: the player crossed the top while RISING and isGrounded NEVER flipped
  // true during the crossing (no collision) — it passed straight through.
  check('platform.passedThrough → player crossed the ledge top while rising', crossedTop, `feet=${player.body.bottom.toFixed(1)} top=300`);
  check('platform.passedThrough → isGrounded stayed FALSE through the crossing (no collision)', groundedDuringCross === false && player.body.onFloor() === false, `onFloor=${player.body.onFloor()}`);
  // OBSERVABLE expect: the rising player's head was NEVER bonked on the ledge underside —
  // the component left the platform's down face DISABLED, so it passed through (a FULLY
  // SOLID platform with down=true would stop the head here). This is the load-bearing
  // proof the one-way profile (not the collider) let the rise through.
  check('platform.passedThrough → head never blocked by the underside (one-way down face off)', headBlocked === false && player.body.blocked.up === false, `headBlocked=${headBlocked}`);
  // OBSERVABLE expect: platform.passedThrough logged on the bus with {id,x,y}.
  const passed1 = bus.recent(cur).filter((e) => e.type === 'platform.passedThrough');
  check('platform.passedThrough logged on the bus', passed1.length === 1, `count=${passed1.length}`);
  const pp = passed1[0]?.payload as any;
  check('platform.passedThrough payload {id,x,y}', pp?.id === 'ledge-A' && pp?.x === 100 && pp?.y === 300, JSON.stringify(pp));
  // No landing happened on the way up.
  check('no platform.landedOn while rising through', bus.recent(cur).every((e) => e.type !== 'platform.landedOn'), JSON.stringify(bus.recent(cur).map((e) => e.type)));
}

// ══════════════════════════════════════════════════════════════════════════════
// BRANCH B (platform.landedOn) — the player descends onto the SAME ledge FROM ABOVE.
// The component sees its feet were at-or-above the top last frame → solid-from-above, the
// collider catches the feet, isGrounded flips TRUE at the top, and platform.landedOn fires.
// ══════════════════════════════════════════════════════════════════════════════
{
  const plat = makePlatform({ id: 'ledge-B', x: 100, y: 300, width: 120, height: 16 });
  // Player starts ABOVE the ledge (feet at y=200, well above the top=300), falling.
  const player = makeSprite({ x: 100, y: 176, width: 24, height: 24 }); // feet at 200
  const platforms = [plat];
  const scene = makeScene({ dt: DT, player, platforms });
  const bus = scene.eventBus;

  const sys = new OneWayPlatform({ tolerance: 4 });
  sys.reset();
  sys.attach(scene);

  // Settle one frame so lastRelation is recorded as 'above'.
  step(scene, 1, sys);
  check('precondition: player starts ABOVE the ledge (feet over the top)', player.body.bottom < 300, `feet=${player.body.bottom}`);
  check('precondition: relation to the ledge is "above"', sys.relationOf('ledge-B') === 'above', `relation=${sys.relationOf('ledge-B')}`);

  const cur = bus.cursor;
  // DRIVE the verb: just let gravity pull the descending player down onto the ledge. The
  // component keeps it solid-from-above; the collider catches the feet at the top.
  let landedFrame = -1;
  for (let f = 0; f < 60; f++) {
    step(scene, 1, sys);
    if (player.body.onFloor() && landedFrame < 0) landedFrame = f;
  }

  // OBSERVABLE expect: isGrounded flips TRUE and the player rests AT the platform top
  // (feet == top). These come from the collider catching the feet, NOT the test.
  check('platform.landedOn → isGrounded flips TRUE (player landed)', player.body.onFloor() === true, `onFloor=${player.body.onFloor()} atFrame=${landedFrame}`);
  check('platform.landedOn → player rests AT the platform top (feet == top)', Math.abs(player.body.bottom - 300) <= 4, `feet=${player.body.bottom} top=300`);
  // OBSERVABLE expect: platform.landedOn logged on the bus with {id,x,y}.
  const landed = bus.recent(cur).filter((e) => e.type === 'platform.landedOn');
  check('platform.landedOn logged on the bus', landed.length === 1, `count=${landed.length}`);
  const lp = landed[0]?.payload as any;
  check('platform.landedOn payload {id,x,y}', lp?.id === 'ledge-B' && lp?.x === 100 && lp?.y === 300, JSON.stringify(lp));
}

// ══════════════════════════════════════════════════════════════════════════════
// COUNTERFACTUAL (meaningfulness proof): a player approaching the ledge FROM ABOVE is
// BLOCKED (lands), it does NOT pass through — the inverse of BRANCH A. If the component's
// pass-through verb were always-on (a no-op that left up=false for the descent too), the
// descending player would FALL STRAIGHT THROUGH and never land: isGrounded would stay
// false and NO platform.landedOn would log. We prove the real one-way rule blocks from
// above. (Symmetrically, BRANCH A proves it does NOT block from below.) We also prove a
// player that never approaches the ledge fires NEITHER event.
// ══════════════════════════════════════════════════════════════════════════════
{
  const plat = makePlatform({ id: 'ledge-C', x: 100, y: 300, width: 120, height: 16 });
  const player = makeSprite({ x: 100, y: 176, width: 24, height: 24 }); // above, falling
  const platforms = [plat];
  const scene = makeScene({ dt: DT, player, platforms });
  const bus = scene.eventBus;
  const sys = new OneWayPlatform({ tolerance: 4 });
  sys.reset();
  sys.attach(scene);
  step(scene, 1, sys);
  for (let f = 0; f < 60; f++) step(scene, 1, sys);

  // The descending player was BLOCKED from above (landed) — it did NOT pass through.
  check('counterfactual: from ABOVE the ledge BLOCKS the player (it lands, not passes)', player.body.onFloor() === true && Math.abs(player.body.bottom - 300) <= 4, `onFloor=${player.body.onFloor()} feet=${player.body.bottom}`);
  // And NO platform.passedThrough was logged — the from-above approach is never a crossing.
  check('counterfactual: from ABOVE → NO platform.passedThrough logged', bus.recent().every((e) => e.type !== 'platform.passedThrough'), JSON.stringify(bus.recent().map((e) => e.type)));
}

// A player parked far away (never over the ledge footprint) fires NEITHER event.
{
  const plat = makePlatform({ id: 'ledge-D', x: 100, y: 300, width: 120, height: 16 });
  const player = makeSprite({ x: 999, y: 396, width: 24, height: 24 }); // off the footprint
  const platforms = [plat];
  const scene = makeScene({ dt: DT, player, platforms });
  const bus = scene.eventBus;
  const sys = new OneWayPlatform({ tolerance: 4 });
  sys.reset();
  sys.attach(scene);
  player.body.velocity.y = -28; // jumps, but nowhere near the ledge
  for (let f = 0; f < 30; f++) step(scene, 1, sys);
  check('counterfactual: never over the footprint → NO platform.passedThrough', bus.recent().every((e) => e.type !== 'platform.passedThrough'), JSON.stringify(bus.recent().map((e) => e.type)));
  check('counterfactual: never over the footprint → NO platform.landedOn', bus.recent().every((e) => e.type !== 'platform.landedOn'), JSON.stringify(bus.recent().map((e) => e.type)));
}

console.log(`\nALL ${assertionsPassed()} ASSERTIONS PASSED — OneWayPlatform fires platform.passedThrough/landedOn with their expect transitions (rising player crosses with isGrounded false; descending player lands at the top, isGrounded true) on observable body state, and the one-way rule blocks from above while passing from below.`);
