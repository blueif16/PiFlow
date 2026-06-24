/**
 * DirectionalBlock — runtime DRIVE test (event-protocol conformance).
 *
 * Proves the component actually FIRES at runtime by driving its real verb against
 * REAL objects and asserting EACH declared surface() event with its `expect`
 * transition on OBSERVABLE state.
 *
 * surface() contract under test (templates/modules/platformer/src/behaviors/DirectionalBlock.ts):
 *   - player.blocked      drivenBy "block (a front hit lands while the block is held)"
 *                         expect   "__GAME__.player.health drops by only the chip fraction
 *                                    (not the full hit) and __GAME__.guardRemaining decreases;
 *                                    player.blocked logged"
 *   - player.guardBroken  drivenBy "block (the guard meter drains to 0 from over-blocking)"
 *                         expect   "the player enters a brief input-suppressed stun
 *                                    (__GAME__.guardRemaining at 0); player.guardBroken logged"
 *
 * REAL objects + REAL drive (NOT a stub that returns the expected value):
 *   - The real DirectionalBlock class + the real EventBus (its ring buffer IS the recording
 *     bus — every emit is captured in `bus.recent()`).
 *   - A REAL player sprite carrying a REAL takeDamage(d) that subtracts from player.health —
 *     the genuine engine hit seam. DirectionalBlock.onAttach WRAPS that takeDamage; so when
 *     the test drives a hit by calling player.takeDamage(d) (exactly what an enemy-collision
 *     does), the chip/drain/emit are produced by the component's own wrapper, never poked in.
 *     The chipped health drop EMERGES from the REAL original takeDamage being called with the
 *     chip fraction — the test never sets player.health.
 *   - A REAL enemy in scene.enemies so the component's nearestEnemy()/isFrontHit() resolve a
 *     true threat (Phaser.Math.Distance.Between is the real distance) and faceThreat() turns
 *     the player toward it — so the hit really IS a front hit.
 *   - The block VERB is driven the engine way: hold the DOWN/S key on the scene
 *     (scene.cursors.down.isDown) and tick update() (the exact BehaviorManager seam), which
 *     polls blockKeyHeld() → block(true). The test never calls block() directly to raise it.
 *   - The component is mounted EXACTLY as the engine does (BehaviorManager.add →
 *     behavior.attach(playerSprite)) and ticked ONLY through update().
 *
 * The VERB ('block'): hold guard, take a front hit → chip + drain + player.blocked; over-block
 * to 0 → player.guardBroken + a stun that suppresses input. The COUNTERFACTUAL takes the same
 * hit with the guard DOWN (key released) and asserts the FULL hit lands, the meter does NOT
 * drain, and NO event is logged — the negative that proves the test is not vacuous.
 */
import { EventBus, check, assertionsPassed } from '@contract/testkit';
import { DirectionalBlock } from '../DirectionalBlock.ts';
import { BehaviorManager } from '../BehaviorManager.ts';

// DirectionalBlock is a combat behavior driven by HELD keys (scene.cursors.down.isDown /
// scene.wasdKeys.S.isDown) + a takeDamage-wrapper player — input/scene shapes the generic
// kit scene does not model — so the test keeps its bespoke makeWorld() below. Only the bus +
// check + assertion tally come from the kit (EventBus is the same class the kit re-exports).

// ── A REAL key the scene exposes; flipping isDown is the held-input the verb polls. ──
function makeKey() {
  return { isDown: false } as { isDown: boolean };
}

/** A REAL enemy sprite-like the component scans as a threat (live, not dead). */
function makeEnemy(opts: { x: number; y: number }) {
  return { x: opts.x, y: opts.y, isDead: false } as any;
}

/**
 * A REAL player sprite carrying the genuine engine fields DirectionalBlock reads/writes:
 *   - health + a REAL takeDamage(d) that subtracts from it (the seam the wrapper guards);
 *   - x/y + facingDirection (faceThreat sets it; isFrontHit reads it);
 *   - body with setVelocityX (the stun freezes locomotion through it);
 *   - scene back-pointer carrying eventBus, the held keys, enemies group, and the frame clock.
 */
function makeWorld(opts: { playerX: number; enemyX: number; maxHealth: number }) {
  const bus = new EventBus();
  const downKey = makeKey();
  const sKey = makeKey();
  const enemy = makeEnemy({ x: opts.enemyX, y: 300 });
  const scene: any = {
    eventBus: bus,
    cursors: { down: downKey },
    wasdKeys: { S: sKey },
    enemies: { getChildren: () => [enemy] },
    game: { loop: { delta: 16 } },
  };
  const vx = { value: 0 };
  const player: any = {
    x: opts.playerX,
    y: 300,
    health: opts.maxHealth,
    facingDirection: 'right',
    scene,
    body: {
      // REAL setVelocityX the stun uses to suppress locomotion; recorded so we can observe it.
      setVelocityX(v: number) {
        vx.value = v;
      },
    },
    // The genuine engine hit seam: subtract real damage from real health.
    takeDamage(d: number) {
      this.health -= d;
    },
  };
  return { bus, scene, player, enemy, downKey, sKey, vx };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVENT 1 — player.blocked: hold guard, take a FRONT hit → only chip lands + meter drains
// ══════════════════════════════════════════════════════════════════════════════
{
  // Enemy to the LEFT of the player; faceThreat will turn the player to face it, so a hit
  // from it is a FRONT hit (the blocked case).
  const { bus, scene, player, downKey, vx } = makeWorld({ playerX: 400, enemyX: 200, maxHealth: 100 });
  const sys = new DirectionalBlock({ maxGuard: 100, chipFraction: 0.2, recoverPerSec: 40, breakStunMs: 600 });

  // Mount EXACTLY as the engine does: BehaviorManager.add → behavior.attach(playerSprite),
  // which wraps player.takeDamage and publishes scene.guardRemaining.
  player.behaviors = new BehaviorManager(player);
  player.behaviors.add('bound_0', sys);

  check('precondition: __GAME__.guardRemaining published at maxGuard', scene.guardRemaining === 100, `guardRemaining=${scene.guardRemaining}`);
  check('precondition: surface observable mirrors the live meter', (sys.surface().observables.guardRemaining() as number) === 100, `obs=${sys.surface().observables.guardRemaining()}`);
  check('precondition: not blocking yet', sys.isBlocking() === false, `blocking=${sys.isBlocking()}`);

  // DRIVE the block VERB the engine way: hold DOWN, then tick update() (it polls the key →
  // block(true) → faceThreat turns the player toward the enemy on the LEFT).
  downKey.isDown = true;
  player.behaviors.update();
  check('block verb (held DOWN key) → player is now blocking', sys.isBlocking() === true, `blocking=${sys.isBlocking()}`);
  check('block → faced the threat (enemy on left → facing left)', player.facingDirection === 'left', `facing=${player.facingDirection}`);

  const cur = bus.cursor;
  const healthBefore = player.health; // 100
  // DRIVE the hit: the real engine hit seam — player.takeDamage(20). It routes through the
  // wrapper because the player IS blocking and the hit is from the FRONT (faced enemy).
  const FULL_HIT = 20;
  player.takeDamage(FULL_HIT);

  // OBSERVABLE expect #1a: health dropped by ONLY the chip fraction (0.2*20 = 4), NOT 20.
  const healthDrop = healthBefore - player.health;
  check('player.blocked → health drops by ONLY the chip fraction (4, not 20)', healthDrop === FULL_HIT * 0.2, `drop=${healthDrop} (chip=${FULL_HIT * 0.2}, full=${FULL_HIT})`);
  // OBSERVABLE expect #1b: the guard meter DRAINED by the FULL hit magnitude (100 → 80).
  check('player.blocked → __GAME__.guardRemaining decreased by the full hit (100→80)', scene.guardRemaining === 80, `guardRemaining=${scene.guardRemaining}`);
  check('player.blocked → surface observable reflects the drained meter', (sys.surface().observables.guardRemaining() as number) === 80, `obs=${sys.surface().observables.guardRemaining()}`);
  // OBSERVABLE expect #1c: player.blocked logged with {guardRemaining,x,y}.
  const logged = bus.recent(cur).filter((e) => e.type === 'player.blocked');
  check('player.blocked logged on the bus', logged.length === 1, `count=${logged.length}`);
  const pl = logged[0]?.payload as any;
  check('player.blocked payload {guardRemaining,x,y}', pl?.guardRemaining === 80 && pl?.x === 400 && pl?.y === 300, JSON.stringify(pl));

  // Sanity: the stun is NOT yet open (the meter is 80, not 0).
  check('not over-blocked yet → no guard break', sys.isGuardBroken() === false, `broken=${sys.isGuardBroken()}`);
  void vx; // (vx is observed in the guard-break case below)
}

// ══════════════════════════════════════════════════════════════════════════════
// EVENT 2 — player.guardBroken: over-block the meter to 0 → break into an input-suppressed stun
// ══════════════════════════════════════════════════════════════════════════════
{
  const { bus, scene, player, downKey, vx } = makeWorld({ playerX: 400, enemyX: 200, maxHealth: 100 });
  // A small meter so a couple of big front hits drain it to 0.
  const sys = new DirectionalBlock({ maxGuard: 50, chipFraction: 0.2, recoverPerSec: 40, breakStunMs: 600 });
  player.behaviors = new BehaviorManager(player);
  player.behaviors.add('bound_0', sys);

  // Raise the guard (held DOWN + tick).
  downKey.isDown = true;
  player.behaviors.update();
  check('guard up (blocking)', sys.isBlocking() === true, `blocking=${sys.isBlocking()}`);

  // First front hit of 30 → meter 50→20 (no break yet).
  player.takeDamage(30);
  check('first over-block hit → meter 50→20, not broken', scene.guardRemaining === 20 && sys.isGuardBroken() === false, `guardRemaining=${scene.guardRemaining} broken=${sys.isGuardBroken()}`);

  const cur = bus.cursor;
  // Second front hit of 30 → meter would go below 0 → clamps to 0 → guard BREAKS.
  player.takeDamage(30);

  // OBSERVABLE expect #2a: __GAME__.guardRemaining is now 0 and the guard is BROKEN.
  check('player.guardBroken → __GAME__.guardRemaining at 0', scene.guardRemaining === 0, `guardRemaining=${scene.guardRemaining}`);
  check('player.guardBroken → guard is broken (input suppressed)', sys.isGuardBroken() === true, `broken=${sys.isGuardBroken()}`);
  check('player.guardBroken → no longer counts as actively blocking', sys.isBlocking() === false, `blocking=${sys.isBlocking()}`);
  // OBSERVABLE expect #2b: player.guardBroken logged with {x,y}.
  const broke = bus.recent(cur).filter((e) => e.type === 'player.guardBroken');
  check('player.guardBroken logged on the bus', broke.length === 1, `count=${broke.length}`);
  check('player.guardBroken payload {x,y}', (broke[0]?.payload as any)?.x === 400 && (broke[0]?.payload as any)?.y === 300, JSON.stringify(broke[0]?.payload));

  // OBSERVABLE expect #2 (the input-suppressed stun): a tick during the stun FREEZES locomotion
  // (setVelocityX(0)) and the block verb is IGNORED even while DOWN is held. Drive a tick.
  vx.value = 999; // pretend movement set a velocity this frame
  player.behaviors.update(); // stun window active → it must zero the velocity and ignore block
  check('stun: locomotion frozen during the break window (setVelocityX(0))', vx.value === 0, `vx=${vx.value}`);
  check('stun: the block verb is suppressed (still broken, not blocking) while DOWN held', sys.isGuardBroken() === true && sys.isBlocking() === false, `broken=${sys.isGuardBroken()} blocking=${sys.isBlocking()}`);

  // After the stun window elapses, the meter REFILLS to full and control returns.
  // 600ms window; each tick decrements by scene.game.loop.delta (16ms). Release the key first.
  downKey.isDown = false;
  for (let f = 0; f < Math.ceil(600 / 16) + 1; f++) player.behaviors.update();
  check('stun ended → guard no longer broken (control returned)', sys.isGuardBroken() === false, `broken=${sys.isGuardBroken()}`);
  check('stun ended → meter refilled to full (50)', scene.guardRemaining === 50, `guardRemaining=${scene.guardRemaining}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// COUNTERFACTUAL (meaningfulness proof): take the SAME front hit with the guard DOWN
// (DOWN key released → block verb never raises the guard). The wrapper passes the hit
// straight through: the FULL hit lands on health, the meter does NOT drain, and NEITHER
// player.blocked NOR player.guardBroken is logged. If the wrapper were a no-op-in-reverse
// (always chipping), EVENT 1's "health drops by ONLY the chip fraction" would still pass but
// THIS "full hit lands" would FAIL; if blocking did nothing, EVENT 1's chip + drain + log
// assertions would all fail. Both directions covered — the test is not vacuous.
// ══════════════════════════════════════════════════════════════════════════════
{
  const { bus, scene, player, downKey } = makeWorld({ playerX: 400, enemyX: 200, maxHealth: 100 });
  const sys = new DirectionalBlock({ maxGuard: 100, chipFraction: 0.2 });
  player.behaviors = new BehaviorManager(player);
  player.behaviors.add('bound_0', sys);

  // Guard DOWN: key released, tick to confirm not blocking.
  downKey.isDown = false;
  player.behaviors.update();
  check('counterfactual: guard DOWN → not blocking', sys.isBlocking() === false, `blocking=${sys.isBlocking()}`);

  const cur = bus.cursor;
  const healthBefore = player.health; // 100
  const FULL_HIT = 20;
  player.takeDamage(FULL_HIT); // routes through the wrapper but the player is NOT blocking

  check('counterfactual: guard down → the FULL hit lands on health (20, not chip)', healthBefore - player.health === FULL_HIT, `drop=${healthBefore - player.health} (full=${FULL_HIT})`);
  check('counterfactual: guard down → the meter does NOT drain (stays at max)', scene.guardRemaining === 100, `guardRemaining=${scene.guardRemaining}`);
  check('counterfactual: guard down → no player.blocked / player.guardBroken logged', bus.recent(cur).every((e) => e.type !== 'player.blocked' && e.type !== 'player.guardBroken'), JSON.stringify(bus.recent(cur).map((e) => e.type)));
}

console.log(`\nALL ${assertionsPassed()} ASSERTIONS PASSED — DirectionalBlock fires player.blocked (front hit → only chip on health + meter drains) and player.guardBroken (over-block to 0 → input-suppressed stun, guardRemaining 0) with their expect transitions on observable state; an unguarded hit lands in full and emits nothing.`);
