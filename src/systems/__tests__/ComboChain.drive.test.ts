/**
 * ComboChain — runtime DRIVE test (event-protocol conformance).
 *
 * Proves the component actually FIRES at runtime by driving its real verb against
 * REAL objects and asserting EACH declared surface() event with its `expect`
 * transition on OBSERVABLE state.
 *
 * surface() contract under test (templates/modules/platformer/src/systems/ComboChain.ts):
 *   - combo.extended  drivenBy "a player hit lands while the combo window is open"
 *                     expect   "__GAME__.comboCount increases by 1; combo.extended logged"
 *   - combo.dropped   drivenBy "the combo window elapses with no new landed hit (or the player is hit)"
 *                     expect   "__GAME__.comboCount returns to 0; combo.dropped logged"
 *
 * REAL objects: the real ComboChain class + the real EventBus (its ring buffer IS
 * the recording bus — every emit is captured in `bus.recent()`). The only stand-in
 * is the SCENE shell, which carries exactly the two real fields ComboChain reads off
 * a live scene — `eventBus` and the `time.now` clock (the same fields the engine's
 * BaseLevelScene exposes); `scene.comboCount` IS the observable the core hook folds
 * into __GAME__.comboCount. The VERB is driven through the real engine seam: the
 * engine announces a landed hit by emitting `enemy.damaged`/`enemy.died` on this same
 * shared bus, which ComboChain POLL-subscribes to. We never call a private method and
 * never set `count` directly — we drive the bus exactly as the engine does.
 */
import { makeScene, check, assertionsPassed } from '@contract/testkit';
import { ComboChain } from '../ComboChain.ts';

// ── Setup: real bus, real component, real scene shell ─────────────────────────
// The kit scene carries exactly the two real fields ComboChain reads off a live scene —
// `eventBus` and the `time.now` clock — plus `comboCount`, the observable the __GAME__ hook folds.
const scene = makeScene();
const bus = scene.eventBus;
const combo = new ComboChain({ windowMs: 800, dropOnPlayerHit: true });
combo.attach(scene);

// Precondition: no chain open, observable at 0.
check('precondition: __GAME__.comboCount starts at 0', scene.comboCount === 0, `comboCount=${scene.comboCount}`);

// ── Event 1: combo.extended ───────────────────────────────────────────────────
// DRIVE the verb: the engine announces a LANDED player hit on the shared bus.
// ComboChain is subscribed; this is the exact real seam (BaseEnemy.takeDamage →
// eventBus.emit('enemy.damaged', {...})), not a private-method call.
let cur = bus.cursor;
scene.time.now = 100;
bus.emit('enemy.damaged', { id: 'e1', x: 200, y: 64, health: 2, damage: 1 });

// OBSERVABLE expect #1a: __GAME__.comboCount increased by 1 (0 → 1).
check('combo.extended → observable comboCount increases by 1', scene.comboCount === 1, `comboCount=${scene.comboCount}`);
// OBSERVABLE expect #1b: combo.extended was logged on the bus with the live count.
let logged = bus.recent(cur).filter((e) => e.type === 'combo.extended');
check('combo.extended logged on the bus', logged.length === 1, `count=${logged.length}`);
check('combo.extended payload carries the live count', (logged[0]?.payload as any)?.count === 1, JSON.stringify(logged[0]?.payload));

// Drive a SECOND landed hit inside the open window → chain extends again (0+1+1=2).
cur = bus.cursor;
scene.time.now = 400; // < 100 + 800, still open
bus.emit('enemy.died', { id: 'e1', x: 210, y: 64 }); // a lethal kill is also a landed hit
check('combo.extended again inside window → comboCount = 2', scene.comboCount === 2, `comboCount=${scene.comboCount}`);
logged = bus.recent(cur).filter((e) => e.type === 'combo.extended');
check('second combo.extended logged with count 2', logged.length === 1 && (logged[0].payload as any).count === 2, JSON.stringify(logged[0]?.payload));

// ── Event 2: combo.dropped (timeout edge) ─────────────────────────────────────
// DRIVE the verb: the window elapses with no fresh landed hit, then update() ticks.
cur = bus.cursor;
scene.time.now = 400 + 800 + 1; // now - lastHitAt > windowMs → lapsed
combo.update();

// OBSERVABLE expect #2a: __GAME__.comboCount returns to 0.
check('combo.dropped (timeout) → observable comboCount returns to 0', scene.comboCount === 0, `comboCount=${scene.comboCount}`);
// OBSERVABLE expect #2b: combo.dropped logged, carrying the count that was LOST (2).
let dropped = bus.recent(cur).filter((e) => e.type === 'combo.dropped');
check('combo.dropped logged on the bus', dropped.length === 1, `count=${dropped.length}`);
check('combo.dropped payload carries the lost count (2)', (dropped[0]?.payload as any)?.count === 2, JSON.stringify(dropped[0]?.payload));

// ── Event 2 (second driver): combo.dropped via a player hit ──────────────────
// The other declared driver for combo.dropped: the player takes a hit while a
// chain is open. Re-open a chain, then drive player.damaged.
scene.time.now = 2000;
bus.emit('enemy.damaged', { id: 'e2', x: 300, y: 64, health: 1, damage: 1 });
check('re-open chain → comboCount = 1', scene.comboCount === 1, `comboCount=${scene.comboCount}`);
cur = bus.cursor;
bus.emit('player.damaged', { x: 250, y: 64, health: 2, damage: 1 });
check('combo.dropped (player hit) → comboCount returns to 0', scene.comboCount === 0, `comboCount=${scene.comboCount}`);
dropped = bus.recent(cur).filter((e) => e.type === 'combo.dropped');
check('combo.dropped logged after player hit', dropped.length === 1, `count=${dropped.length}`);

// ── COUNTERFACTUAL (meaningfulness proof) ─────────────────────────────────────
// If onHitLanded were a no-op (the verb did nothing), `scene.comboCount` would
// stay 0 and NO combo.extended would be logged — assertion "combo.extended →
// observable comboCount increases by 1" would FAIL. We verify the bus DID drive a
// real observable transition (0 → non-zero was observed above), so a stubbed/no-op
// component is detected. Prove the negative directly with a fresh component that
// receives NO hit: comboCount must remain 0 and no event is logged.
{
  const scene2 = makeScene();
  const bus2 = scene2.eventBus;
  const idle = new ComboChain();
  idle.attach(scene2);
  scene2.time.now = 5000;
  idle.update(); // ticks with no chain open
  check('counterfactual: no verb driven → comboCount stays 0', scene2.comboCount === 0, `comboCount=${scene2.comboCount}`);
  check('counterfactual: no combo.* events logged', bus2.recent().every((e) => !e.type.startsWith('combo.')), JSON.stringify(bus2.recent().map((e) => e.type)));
}

console.log(`\nALL ${assertionsPassed()} ASSERTIONS PASSED — ComboChain fires both declared events with their expect transitions on observable state.`);
