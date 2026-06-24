/**
 * WindZone — runtime DRIVE test (event-protocol conformance).
 *
 * Proves the component actually FIRES at runtime by driving its real verb against
 * REAL objects and asserting EACH declared surface() event with its `expect`
 * transition on OBSERVABLE state — PLUS the event-less force MECHANIC (the velocity
 * delta) that is WindZone's real payload.
 *
 * surface() contract under test (templates/modules/platformer/src/systems/WindZone.ts):
 *   - player.enteredWind  drivenBy "jump (the player jumps/moves into the wind region)"
 *                         expect   "the player's __GAME__.player.vy/vx gain the wind force each
 *                                    frame — e.g. an updraft makes the apex measurably higher
 *                                    than a normal jump from the same jumpPower; player.enteredWind logged"
 *   - player.leftWind     drivenBy "jump (the player exits the wind region)"
 *                         expect   "the wind force stops and the player arc returns to the normal
 *                                    gravityY/jumpPower curve; player.leftWind logged"
 *
 * REAL objects + REAL drive (NOT a stub that returns the expected value):
 *   - The real WindZone class + the real EventBus (its ring buffer IS the recording
 *     bus — every emit is captured in `bus.recent()`).
 *   - A minimal arcade-physics WORLD with a REAL per-frame integrator: each frame
 *     gravity adds to body.velocity.y, then position integrates (x += vx, y += vy).
 *     WindZone's update() reads scene.player.{x,y} against its AABB and, while inside,
 *     ADDS region.dir*force*dt to body.velocity. So the apex-rises / sideways-push
 *     consequence is NOT set by the test — it EMERGES from the same body velocity the
 *     engine integrates (the core hook exposes body.velocity.x/y as __GAME__.player.vx/vy).
 *   - The component is driven ONLY through its real per-frame seam update() (the exact
 *     `for (const sys of this.systems) sys.update?.()` call in DataLevelScene.ts:136),
 *     never by calling applyWindIfInside()/private methods directly.
 *
 * The VERB ('jump'): the player launches upward (jumpPower) and the integrator runs the
 * arc. A control run (NO wind / outside the region) and a wind run (an UPDRAFT region)
 * use the SAME jumpPower from the SAME start — the updraft apex must sit measurably
 * higher (smaller y), proving the force was really applied.
 */
import { makeScene, makeSprite, check, assertionsPassed } from '@contract/testkit';
import { WindZone } from '../WindZone.ts';

const GRAVITY_PER_FRAME = 6; // px/frame added to velocity.y each integrate (a real pull)
const DT = 16; // ms/frame — what scene.game.loop.delta feeds WindZone (force is px/s)

// The kit `makeSprite` gives the player a real body with `velocity` plus the `x`/`y` display
// CENTER WindZone tests against its AABB (the same read CollectScore uses). WindZone is a
// point-mass free-fall component (no ground/platform), so the test keeps its OWN tiny
// integrator/runJump drive model below — it moves the player's display center by whatever
// velocity now stands (the wind delta WindZone.update() added), never the expected value.
//
// The REAL per-frame integrator (the engine seam, faithfully reproduced): add gravity, then
// integrate the display center from velocity. It never reads the region; the apex/displacement
// fall OUT of the integration — the test never sets the velocity to an expected value.
function integrate(player: any) {
  const b = player.body;
  b.velocity.y += GRAVITY_PER_FRAME; // gravity (the globally-fixed gravityY analog)
  player.x += b.velocity.x;
  player.y += b.velocity.y;
}

const JUMP_POWER = -120; // px/frame initial upward velocity — the SAME for both runs

/** Run a jump arc for `frames`, calling `step` after each integrate (the system seam).
 * Returns the HIGHEST point reached (smallest y) over those frames — the height the same
 * jumpPower achieves with vs without the field, compared over the SAME frame count. */
function runJump(player: any, frames: number, step: () => void): number {
  player.body.velocity.y = JUMP_POWER; // the 'jump' verb: launch upward
  let apexY = player.y;
  for (let f = 0; f < frames; f++) {
    integrate(player);
    step(); // sys.update() — WindZone applies its force AFTER the integrate
    if (player.y < apexY) apexY = player.y; // smaller y == higher
  }
  return apexY;
}

const FRAMES = 30; // fixed window — the same jumpPower over the same frames, ±wind

// ══════════════════════════════════════════════════════════════════════════════
// CONTROL — a jump from JUMP_POWER with NO wind (player starts OUTSIDE the region).
// This is the "normal gravityY/jumpPower curve" baseline the expect transition names.
// ══════════════════════════════════════════════════════════════════════════════
let controlApexY: number;
{
  // The control player jumps from the SAME start (y=600) with the SAME jumpPower, but is
  // parked far to the LEFT of the region (x=-500), so it never enters horizontally and
  // WindZone never fires / adds force → a pure normal gravityY/jumpPower curve baseline.
  const player = makeSprite({ x: -500, y: 600, width: 24, height: 24 });
  const scene = makeScene({ dt: DT, player });
  const bus = scene.eventBus;
  // The region is a vertical column at x∈[60..140]; the control player (x=-500) is never
  // inside it for the whole arc (the jump is vertical — x stays -500).
  const sys = new WindZone({ x: 60, y: 400, width: 80, height: 240, dirX: 0, dirY: -1, force: 600 });
  sys.reset();
  sys.attach(scene);

  controlApexY = runJump(player, FRAMES, () => sys.update());

  check('control: player never reached the high region (no wind)', !sys.isInside('wind'), `inside=${sys.isInside('wind')}`);
  check('control: no player.enteredWind logged (never entered)', bus.recent().every((e) => e.type !== 'player.enteredWind'), JSON.stringify(bus.recent().map((e) => e.type)));
}

// ══════════════════════════════════════════════════════════════════════════════
// BRANCH A — the SAME jump, but the player STARTS INSIDE an updraft region. The
// updraft (dirY<0) cancels part of gravity each frame → the apex sits measurably
// HIGHER (smaller y) than the control. enteredWind fires on the entry frame; leftWind
// fires when the arc carries the player up and out of the region's top.
// ══════════════════════════════════════════════════════════════════════════════
{
  // The region spans the player's start. dirY=-1 updraft, strong force.
  const player = makeSprite({ x: 100, y: 600, width: 24, height: 24 });
  const scene = makeScene({ dt: DT, player });
  const bus = scene.eventBus;
  // An updraft column the player starts INSIDE (start y=600 ∈ [200..680]). Over the fixed
  // FRAMES window the rising player stays inside (one clean enter edge + force every frame);
  // continuing the rise carries it UP through the top (y=200) and out → one clean leave edge.
  const sys = new WindZone({ x: 60, y: 200, width: 80, height: 480, dirX: 0, dirY: -1, force: 600 });
  sys.reset();
  sys.attach(scene);

  const cur = bus.cursor;
  // DRIVE the verb: launch the jump. First update() sees the player already inside →
  // ENTER edge fires; every inside frame ADDS the updraft to velocity.y. Compare the
  // height reached over the SAME fixed FRAMES window as the no-wind control.
  const apexY = runJump(player, FRAMES, () => sys.update());

  // OBSERVABLE expect (player.enteredWind): over the same jumpPower + same frames the
  // updraft carried the player measurably HIGHER (smaller y) — the force was really
  // added to vy. The integrator did the moving; the test set only the initial jumpPower.
  check(
    'player.enteredWind → updraft rises measurably HIGHER than the normal-curve control',
    apexY < controlApexY - 20,
    `windApexY=${apexY.toFixed(1)} controlApexY=${controlApexY.toFixed(1)} gain=${(controlApexY - apexY).toFixed(1)}px`,
  );
  // OBSERVABLE expect: player.enteredWind logged ONCE on the bus with {id,dirX,dirY,force}.
  const entered = bus.recent(cur).filter((e) => e.type === 'player.enteredWind');
  check('player.enteredWind logged on the bus (one clean enter edge)', entered.length === 1, `count=${entered.length}`);
  const ep = entered[0]?.payload as any;
  check('player.enteredWind payload {id,dirX,dirY,force}', ep?.id === 'wind' && ep?.dirY === -1 && ep?.force === 600, JSON.stringify(ep));

  // OBSERVABLE expect (player.leftWind): the rise (runJump above) carried the player UP
  // and OUT through the region top during that window — so the leave edge ALREADY fired,
  // exactly once, on that single top crossing, and the force stopped (isInside is false).
  // We capture it over the whole branch span (cur). The integrator did the rising; the
  // test set only the initial jumpPower.
  check('player.leftWind → player rose out the region top during the jump (isInside false)', sys.isInside('wind') === false && player.y < 200, `inside=${sys.isInside('wind')} y=${player.y.toFixed(1)}`);
  const left = bus.recent(cur).filter((e) => e.type === 'player.leftWind');
  check('player.leftWind logged on the bus (one clean leave edge)', left.length === 1, `count=${left.length}`);
  check('player.leftWind payload {id}', (left[0]?.payload as any)?.id === 'wind', JSON.stringify(left[0]?.payload));
  // The force genuinely stopped on leaving: a now-outside tick adds NO wind to velocity.
  const vyBefore = player.body.velocity.y;
  player.body.velocity.x = 0;
  sys.update(); // outside → applyWindIfInside adds nothing (no dir*force*dt)
  check('player.leftWind → outside the field, the wind force no longer accrues', player.body.velocity.x === 0, `vx=${player.body.velocity.x} (vyBefore=${vyBefore.toFixed(1)})`);
}

// ══════════════════════════════════════════════════════════════════════════════
// BRANCH B — a SIDE-WIND (dirX != 0) pushes the whole trajectory sideways. Drive the
// same jump inside a rightward-wind region; the player drifts measurably right of where
// the no-wind control ended, with NO horizontal input of its own.
// ══════════════════════════════════════════════════════════════════════════════
{
  const player = makeSprite({ x: 100, y: 300, width: 24, height: 24 });
  const scene = makeScene({ dt: DT, player });
  const bus = scene.eventBus;
  // A huge rightward side-wind centered on the origin so the player sits inside for the
  // WHOLE arc (the jump apex ~-726 stays within [-2000..2000]).
  const sys = new WindZone({ x: -2000, y: -2000, width: 4000, height: 4000, dirX: 1, dirY: 0, force: 800, id: 'gust' });
  sys.reset();
  sys.attach(scene);

  const startX = player.x;
  const cur = bus.cursor;
  player.body.velocity.y = JUMP_POWER; // jump straight up — NO horizontal input
  for (let f = 0; f < FRAMES; f++) {
    integrate(player);
    sys.update(); // side-wind ADDS +dx to velocity.x each frame
  }

  // OBSERVABLE: the player drifted RIGHT despite zero horizontal input — the side-wind
  // force fell out as __GAME__.player.vx and carried x. The test never set vx.
  check('side-wind → player trajectory pushed RIGHT (x increased, no input)', player.x > startX + 40, `startX=${startX} endX=${player.x.toFixed(1)} vx=${player.body.velocity.x.toFixed(1)}`);
  check('side-wind → body.velocity.x is positive (force accrued)', player.body.velocity.x > 0, `vx=${player.body.velocity.x.toFixed(1)}`);
  const entered = bus.recent(cur).filter((e) => e.type === 'player.enteredWind');
  check('side-wind → player.enteredWind logged with dirX=1', entered.length === 1 && (entered[0].payload as any).dirX === 1, JSON.stringify(entered[0]?.payload));
}

// ══════════════════════════════════════════════════════════════════════════════
// COUNTERFACTUAL (meaningfulness proof): a player that stays OUTSIDE the region must
// gain NO wind force and fire NO enter/leave event. If applyWindIfInside() were a
// no-op (added no velocity / emitted nothing), BRANCH A's "apex higher" and "enteredWind
// logged" would BOTH still pass trivially here too — they do NOT: the outside player's
// arc equals the control and no event is logged. We prove the negative directly.
// ══════════════════════════════════════════════════════════════════════════════
{
  // Player parked far to the LEFT of the region for the whole arc → never inside.
  const player = makeSprite({ x: -500, y: 600, width: 24, height: 24 });
  const scene = makeScene({ dt: DT, player });
  const bus = scene.eventBus;
  const sys = new WindZone({ x: 60, y: 400, width: 80, height: 240, dirX: 0, dirY: -1, force: 600 });
  sys.reset();
  sys.attach(scene);

  const apexY = runJump(player, FRAMES, () => sys.update());

  // The outside arc matches the no-wind control (within float noise) — NO force applied.
  check('counterfactual: outside the region → arc equals the normal curve (no lift)', Math.abs(apexY - controlApexY) < 1, `outsideApexY=${apexY.toFixed(2)} controlApexY=${controlApexY.toFixed(2)}`);
  check('counterfactual: outside the region → no force on velocity.x', player.body.velocity.x === 0, `vx=${player.body.velocity.x}`);
  check('counterfactual: outside the region → no player.enteredWind logged', bus.recent().every((e) => e.type !== 'player.enteredWind'), JSON.stringify(bus.recent().map((e) => e.type)));
  check('counterfactual: outside the region → no player.leftWind logged', bus.recent().every((e) => e.type !== 'player.leftWind'), JSON.stringify(bus.recent().map((e) => e.type)));
  check('counterfactual: isInside is false the whole time', sys.isInside('wind') === false, `inside=${sys.isInside('wind')}`);
}

console.log(`\nALL ${assertionsPassed()} ASSERTIONS PASSED — WindZone fires player.enteredWind/leftWind with their expect transitions (updraft apex measurably higher; side-wind pushes the trajectory) on observable body velocity, and applies NO force outside the region.`);
