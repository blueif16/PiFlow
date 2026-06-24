/**
 * ConveyorBelt — runtime DRIVE test (event-protocol conformance).
 *
 * Proves the component actually FIRES at runtime by driving its real verb against
 * REAL objects and asserting the declared surface() event with its `expect`
 * transition on OBSERVABLE state.
 *
 * surface() contract under test (templates/modules/platformer/src/behaviors/ConveyorBelt.ts):
 *   - player.conveyed  drivenBy "jump (the player lands on / stands on / rides the belt
 *                                — the terminus of the jump arc)"
 *                      expect   "while standing on the belt, __GAME__.player.x drifts by
 *                                beltSpeed each frame in 'direction' even with no move input;
 *                                player.conveyed logged"
 *
 * REAL objects + REAL drive (NOT a stub that returns the expected value):
 *   - The real ConveyorBelt class + the real EventBus (its ring buffer IS the recording
 *     bus — every emit is captured in `bus.recent()`).
 *   - A minimal arcade-physics WORLD with a REAL per-frame ground collider that resolves
 *     the player against the belt body exactly as Phaser arcade does (gravity integrates
 *     velocity.y, then the collider SNAPS the feet onto the belt top — the same body state
 *     `ConveyorBelt.isStandingOn` reads). The belt's carry effect on the player's x then
 *     EMERGES from `playerBody.velocity.x += beltSpeed*direction`, integrated by the SAME
 *     step into a real position drift — the test never sets player.x to the expected value.
 *   - The belt is mounted EXACTLY as the engine does (DataLevelScene.attachBehaviors →
 *     BehaviorManager.add → behavior.attach(beltSprite)); the owner is the belt sprite and
 *     `beltSprite.scene` carries the live scene fields the behavior reads (eventBus, player).
 *   - The component is driven ONLY through its real per-frame seam update() (the exact
 *     `owner.behaviors.update()` call DataLevelScene makes), never by calling convey()
 *     directly, never by setting player.x / the mount flag.
 *
 * The VERB ('jump'): the player ARRIVES on the belt (the terminus of a jump arc) and rides
 * it — that mount fires player.conveyed and starts the per-frame carry. The COUNTERFACTUAL
 * drives a player that is NOT on the belt (parked off the footprint) and asserts NO carry,
 * NO drift, NO event — the negative that proves the test is not vacuous.
 */
import { makeScene, makePlatform, makeSprite, check, assertionsPassed } from '@contract/testkit';
import { ConveyorBelt } from '../ConveyorBelt.ts';
import { BehaviorManager } from '../BehaviorManager.ts';

// The kit `makePlatform`/`makeSprite` give the belt + player real arcade bodies with exactly
// the reads ConveyorBelt.isStandingOn uses (body.bottom/top/width/velocity/enable, onFloor()).
// The belt also needs a `scene` back-pointer (the engine wiring), assigned per-block below.
// ConveyorBelt's carry is a belt-specific integration (reset → carry → integrate+collide, in
// the engine's true order), so the test keeps its own `frame`/`settleFrame` drive model — it
// runs on the kit sprites; the per-frame drift EMERGES from the integrator, never set by the test.

/** A belt sprite: a kit platform body + a `scene` back-pointer (the engine wiring). */
function makeBelt(opts: { id: string; x: number; y: number; width: number; height: number }, scene: any) {
  const belt: any = makePlatform(opts);
  belt.scene = scene;
  return belt;
}

const GRAVITY_PER_FRAME = 4; // px/frame added to velocity.y (a real, modest downward pull)

/**
 * ONE faithful engine frame, in the engine's true order so the belt's carry is integrated
 * (the bug a naive single-step harness hides: reset → carry → integrate, never reset AFTER):
 *   1) the player's OWN move() this frame — no move input → vx is reset to 0 (so any
 *      horizontal drift that survives is the belt's carry, not residual input);
 *   2) the belt behavior ticks (`belt.behaviors.update()` — the exact engine seam) and ADDS
 *      beltSpeed*direction to vx while the player rests on it;
 *   3) gravity + integrate: vy += gravity, then position integrates from the NOW-FINAL
 *      velocity (x += vx, y += vy), and the ground collider snaps the feet to the belt top.
 * So player.x advances by exactly the belt's carry each frame it rides — it EMERGES from the
 * integrator, the test never sets player.x.
 */
function ownMoveReset(player: any) {
  player.body.velocity.x = 0; // no move input this frame
}
function integrateAndCollide(player: any, belt: any) {
  const pb = player.body;
  pb.velocity.y += GRAVITY_PER_FRAME;
  player.x += pb.velocity.x; // integrate the FINAL vx (player move 0 + belt carry)
  pb.y += pb.velocity.y;
  pb.x = player.x - pb.width / 2;
  // resolve against the belt top.
  pb.blocked.down = false;
  const tb = belt.body;
  if (tb.enable !== false) {
    const halfW = tb.width / 2 + pb.width / 2;
    const overX = Math.abs(player.x - belt.x) <= halfW;
    const feet = pb.bottom;
    const top = tb.top;
    const reached = feet >= top && feet <= top + GRAVITY_PER_FRAME + 2;
    if (overX && pb.velocity.y >= 0 && reached) {
      pb.y = top - pb.height;
      pb.velocity.y = 0;
      pb.blocked.down = true;
    }
  }
}
/** A full engine frame WITH the belt in the loop (reset → belt tick → integrate+collide). */
function frame(player: any, belt: any) {
  ownMoveReset(player);
  belt.behaviors.update();
  integrateAndCollide(player, belt);
}
/** A full engine frame WITHOUT ticking the belt — used only to settle the player onto it. */
function settleFrame(player: any, belt: any) {
  ownMoveReset(player);
  integrateAndCollide(player, belt);
}

// ══════════════════════════════════════════════════════════════════════════════
// BRANCH A — the player rides the belt → it carries them in `direction` + fires once
// ══════════════════════════════════════════════════════════════════════════════
{
  const scene: any = makeScene();
  const bus = scene.eventBus;
  // belt top at y=400; player 24x24, feet rest at 400. direction +1 (right), speed 120.
  // A WIDE belt (the player rides it for many frames before reaching the right end), so the
  // sustained per-frame carry drift is observable while the player stays over the footprint.
  const belt = makeBelt({ id: 'belt-A', x: 200, y: 400, width: 1600, height: 16 }, scene);
  const player = makeSprite({ x: 200, y: 400 - 24, width: 24, height: 24 });
  scene.player = player;

  // Mount EXACTLY as the engine does: BehaviorManager.add → behavior.attach(beltSprite).
  belt.behaviors = new BehaviorManager(belt);
  const sys = new ConveyorBelt({ beltSpeed: 120, direction: 1, id: 'belt-A' });
  belt.behaviors.add('bound_0', sys);

  // Settle the player onto the belt (resting, vy 0). The behavior does NOT tick yet.
  settleFrame(player, belt);
  settleFrame(player, belt);
  check('precondition: player resting on belt (feet at top, vy 0)', player.body.onFloor() === true && player.body.velocity.y === 0, `onFloor=${player.body.onFloor()} vy=${player.body.velocity.y}`);
  check('precondition: no carry yet, not conveying', sys.isConveying() === false, `conveying=${sys.isConveying()}`);

  const cur = bus.cursor;
  const xStart = player.x;

  // DRIVE one full engine frame: reset vx→0 (no move input) → belt.behaviors.update()
  // (ConveyorBelt detects standing-on, adds +120 to vx, fires on first mount) → integrate
  // (player.x advances by the FINAL vx). The carry + the event + the drift all EMERGE.
  frame(player, belt);
  check('player.conveyed → component is now conveying (mounted)', sys.isConveying() === true, `conveying=${sys.isConveying()}`);
  check('player.conveyed → carry imparted to player vx (no move input)', player.body.velocity.x === 120, `vx=${player.body.velocity.x}`);
  check('player.conveyed → first frame drifted player.x by ~beltSpeed (right)', player.x === xStart + 120, `x=${player.x} start=${xStart}`);

  // OBSERVABLE expect: player.conveyed logged once with {id,direction,beltSpeed}.
  let logged = bus.recent(cur).filter((e) => e.type === 'player.conveyed');
  check('player.conveyed logged on the bus (once on mount)', logged.length === 1, `count=${logged.length}`);
  const pl = logged[0]?.payload as any;
  check('player.conveyed payload {id,direction,beltSpeed}', pl?.id === 'belt-A' && pl?.direction === 1 && pl?.beltSpeed === 120, JSON.stringify(pl));

  // OBSERVABLE expect (the core of `expect`): __GAME__.player.x DRIFTS by beltSpeed/frame in
  // `direction` even with NO move input. Run several more full frames; each frame the carry of
  // +120 is integrated into +120px of position. It emerges from real state — never set by the test.
  const cur2 = bus.cursor;
  const xBefore5 = player.x;
  for (let f = 0; f < 5; f++) frame(player, belt);
  const drift = player.x - xBefore5;
  check('expect: player.x drifts RIGHT by ~beltSpeed/frame while riding (no input)', drift === 120 * 5 && player.x > xBefore5, `drift=${drift} (5 frames @120)`);
  check('expect: drift is in +direction (right), not arbitrary', player.body.velocity.x === 120 && player.x > xBefore5, `x=${player.x} vx=${player.body.velocity.x}`);

  // LEAN log: the event fires ONCE per continuous ride, not every frame.
  logged = bus.recent(cur2).filter((e) => e.type === 'player.conveyed');
  check('lean: no re-emit every frame during a continuous ride', logged.length === 0, `extra=${logged.length}`);

  // RE-ARM: leave the belt and re-mount → the event fires AGAIN (mount flag cleared on leave).
  player.x = belt.x + 999;       // far off the belt footprint
  player.body.x = player.x - player.body.width / 2;
  belt.behaviors.update();       // off the belt → mounted flag cleared (re-armed)
  check('re-arm: stepping off the belt clears the mount (not conveying)', sys.isConveying() === false, `conveying=${sys.isConveying()}`);
  player.x = belt.x;             // back over the belt center, feet at the belt top
  player.body.x = player.x - player.body.width / 2;
  player.body.y = belt.body.top - player.body.height;
  player.body.velocity.y = 0;
  const cur3 = bus.cursor;
  belt.behaviors.update();       // re-mount → player.conveyed fires again
  const reLogged = bus.recent(cur3).filter((e) => e.type === 'player.conveyed');
  check('re-arm: re-mounting the belt re-fires player.conveyed', reLogged.length === 1 && sys.isConveying() === true, `count=${reLogged.length} conveying=${sys.isConveying()}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// COUNTERFACTUAL (meaningfulness proof): a player that is NOT on the belt is never
// conveyed — no carry is imparted, player.x does NOT drift, and player.conveyed is
// NOT logged. If convey()/isStandingOn were a no-op-in-reverse (always conveying), the
// BRANCH-A assertions would still pass but THIS would fail; if the carry were a no-op,
// BRANCH A's "vx === 120" + "drift" + "logged" would all fail. Both directions covered.
// ══════════════════════════════════════════════════════════════════════════════
{
  const scene: any = makeScene();
  const bus = scene.eventBus;
  const belt = makeBelt({ id: 'belt-B', x: 200, y: 400, width: 96, height: 16 }, scene);
  // Player parked FAR to the right of the belt footprint (and in the air) → never standing on it.
  const player = makeSprite({ x: 900, y: 400 - 24, width: 24, height: 24 });
  scene.player = player;
  belt.behaviors = new BehaviorManager(belt);
  const sys = new ConveyorBelt({ beltSpeed: 120, direction: 1, id: 'belt-B' });
  belt.behaviors.add('bound_0', sys);

  const xStart = player.x;
  for (let f = 0; f < 10; f++) {
    // Full engine frame WITH the belt ticking: reset vx→0, belt.update() (isStandingOn is
    // false out here → no convey/carry/emit), integrate (it just falls under gravity).
    frame(player, belt);
  }

  // The player did fall (gravity), but received NO horizontal carry from the belt.
  check('counterfactual: off the belt → not conveying', sys.isConveying() === false, `conveying=${sys.isConveying()}`);
  check('counterfactual: off the belt → no horizontal carry (vx stays 0)', player.body.velocity.x === 0, `vx=${player.body.velocity.x}`);
  check('counterfactual: off the belt → player.x does NOT drift sideways', player.x === xStart, `x=${player.x} start=${xStart}`);
  check('counterfactual: off the belt → no player.conveyed logged', bus.recent().every((e) => e.type !== 'player.conveyed'), JSON.stringify(bus.recent().map((e) => e.type)));
}

console.log(`\nALL ${assertionsPassed()} ASSERTIONS PASSED — ConveyorBelt fires player.conveyed with its expect transition (player.x drifts by beltSpeed/frame in direction while riding, no move input; lean once-per-mount log) on observable state; an off-belt player is never conveyed.`);
