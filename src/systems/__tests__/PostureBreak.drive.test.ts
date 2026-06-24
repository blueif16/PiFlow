/**
 * PostureBreak — runtime DRIVE test (event-protocol conformance).
 *
 * Proves the component actually FIRES at runtime by driving its real verb against
 * REAL objects and asserting EACH declared surface() event with its `expect`
 * transition on OBSERVABLE state.
 *
 * surface() contract under test (templates/modules/platformer/src/systems/PostureBreak.ts):
 *   - enemy.guardBroken  drivenBy "the enemy's posture meter reaches max from accumulated
 *                                   landed hits/parries (driven by the player's attack/parry)"
 *                        expect   "the broken enemy's entities[] x stops advancing (AI frozen)
 *                                   and __GAME__.postureBroken is true / __GAME__.postureRemaining
 *                                   reads the open window; enemy.guardBroken logged"
 *   - enemy.executed     drivenBy "a player hit lands DURING the open guard-broken window (attack)"
 *                        expect   "the enemy is removed from __GAME__.entities in one blow
 *                                   regardless of remaining health; enemy.executed logged"
 *
 * REAL objects + REAL drive (NOT a stub that returns the expected value):
 *   - The real PostureBreak class + the real EventBus (its ring buffer IS the recording
 *     bus — every emit is captured in `bus.recent()`).
 *   - A minimal but FAITHFUL enemy sprite carrying the exact seams PostureBreak reads/calls:
 *     __id, isDead, isHurting, setVelocity(x,y), die() (BaseEnemy.die(): sets isDead,
 *     setVelocity(0,0), and removes itself from the live group — the destroy that drops it
 *     from __GAME__.entities), plus x/y. A patrolling AI MOVES the enemy each frame (sets
 *     velocity, integrates x) — PostureBreak runs AFTER the AI (the DataLevelScene order:
 *     updateEnemies THEN sys.update()) and FREEZES a guard-broken enemy by zeroing the
 *     velocity the AI just set + holding isHurting. So "AI frozen" / "x stops advancing"
 *     is NOT set by the test — it EMERGES from PostureBreak overriding the AI's velocity.
 *   - The scene shell carries exactly the live fields PostureBreak reads: eventBus,
 *     enemies.getChildren(), game.loop.delta, onEnemyKilled(enemy), and the
 *     scene-owned postureBroken/postureRemaining observables the __GAME__ hook folds.
 *     entitiesIds() mirrors the engine's collectEntities filter (active && !isDead) — the
 *     real __GAME__.entities membership the contract names.
 *   - The component is driven ONLY through its real per-frame seam update() (the exact
 *     `for (const sys of this.systems) sys.update?.()` call in DataLevelScene.ts:136) and
 *     the real bus events the engine emits (enemy.damaged / attack.parried), never by a
 *     private method and never by setting posture/postureBroken directly.
 *
 * THE VERB ('attack' / 'parry'): five landed hits (or two parries) top out the posture →
 * enemy.guardBroken (AI frozen, window open). The NEXT hit inside the window → enemy.executed
 * (removed from entities in one blow). Both are driven below.
 */
import { makeScene as makeKitScene, check, assertionsPassed } from '@contract/testkit';
import { PostureBreak } from '../PostureBreak.ts';

// PostureBreak is an enemy-AI component (no platform physics), so the test keeps its own
// faithful enemy sprite + patrolling-AI drive model below; only the bus + check + scene
// shell come from the kit. The kit `makeScene()` supplies the recording `eventBus` + the
// `game.loop.delta` clock; the PostureBreak-specific observables (onEnemyKilled, the
// scene-owned postureBroken/postureRemaining the __GAME__ hook folds) + the live EnemyGroup
// are layered on top of it in makeScene() below.

// ── A faithful enemy sprite + a patrolling AI ────────────────────────────────────
// Mirrors the exact BaseEnemy seams PostureBreak touches: setVelocity/isHurting (the
// freeze), die() (isDead + remove-from-group = the destroy that drops it from
// __GAME__.entities). `health` stays HIGH so the "one blow regardless of health" claim
// is real — a normal hit would never kill this enemy.
function makeEnemy(opts: { id: string; x: number; y: number; group: EnemyGroup }) {
  const enemy: any = {
    __id: opts.id,
    x: opts.x,
    y: opts.y,
    health: 999, // huge — only the deathblow can remove it, never normal damage
    isDead: false,
    isHurting: false,
    active: true,
    velocity: { x: 0, y: 0 },
    setVelocity(vx: number, vy: number) {
      this.velocity.x = vx;
      this.velocity.y = vy;
    },
    die() {
      // BaseEnemy.die(): latch dead, stop, and (via the delayed destroy) leave the group.
      if (this.isDead) return;
      this.isDead = true;
      this.setVelocity(0, 0);
      this.active = false;
      opts.group.remove(this); // the destroy effect — drops out of __GAME__.entities
    },
  };
  return enemy;
}

/** A live enemies group (the scene.enemies facade PostureBreak reads via getChildren()). */
class EnemyGroup {
  private members: any[] = [];
  add(e: any) { this.members.push(e); }
  remove(e: any) { this.members = this.members.filter((m) => m !== e); }
  getChildren() { return this.members; }
}

const DT = 16; // ms/frame — what scene.game.loop.delta feeds the decay/window countdown
const PATROL_VX = 30; // px/frame the AI pushes a free enemy rightward

/**
 * The AI step (the engine's updateEnemies, run BEFORE the systems): a free enemy is
 * COMMANDED a patrol velocity every frame. It sets velocity ONLY — position is integrated
 * in a SEPARATE step (integrateBodies) AFTER the systems run, exactly as Phaser's arcade
 * physics does (the AI/systems set velocity during update; the physics step moves the body
 * afterward). So a guard-broken enemy whose velocity PostureBreak RE-ZEROES (after this AI
 * step, before integration) does NOT advance. We do NOT special-case the broken enemy here.
 */
function aiStep(group: EnemyGroup) {
  for (const e of group.getChildren()) {
    if (e.isDead) continue;
    e.setVelocity(PATROL_VX, 0); // the AI commands a patrol velocity every frame
  }
}

/** The physics integration step — runs AFTER the systems (the real arcade order): move
 *  each body by its FINAL velocity (a frozen enemy's was re-zeroed by PostureBreak). */
function integrateBodies(group: EnemyGroup) {
  for (const e of group.getChildren()) {
    if (e.isDead) continue;
    e.x += e.velocity.x;
  }
}

/** The scene: the kit shell (recording eventBus + delta clock) layered with exactly the
 *  live fields PostureBreak reads/writes — the live EnemyGroup + the kill path + the
 *  scene-owned postureBroken/postureRemaining observables. */
function makeScene(group: EnemyGroup) {
  const scene: any = makeKitScene({ dt: DT });
  scene.enemies = group;
  scene.killCount = 0;
  scene.postureBroken = false;
  scene.postureRemaining = 0;
  scene.onEnemyKilled = function (enemy: any) {
    // The standardized kill-count + enemy.died path (BaseLevelScene.onEnemyKilled).
    this.killCount += 1;
    this.eventBus.emit('enemy.died', { id: enemy.__id, x: enemy.x, y: enemy.y });
  };
  return scene;
}

/** The engine's __GAME__.entities membership: live, active, not-dead enemies (collectEntities). */
function entityIds(group: EnemyGroup): string[] {
  return group.getChildren().filter((e: any) => e.active && !e.isDead).map((e: any) => e.__id);
}

/** One full engine frame in the real arcade order: the AI sets velocities FIRST, then the
 *  systems run (PostureBreak may re-zero a frozen enemy's velocity), then physics
 *  integrates position by the FINAL velocity. */
function frame(group: EnemyGroup, sys: PostureBreak) {
  aiStep(group); // AI commands patrol velocity
  sys.update(); // the real seam — drains the bus, accrues/decays, freezes (zeroes vel)
  integrateBodies(group); // physics moves bodies by the post-system velocity
}

// ══════════════════════════════════════════════════════════════════════════════
// BRANCH A (enemy.guardBroken) — five landed hits top out the posture (max 100, hitGain
// 20). The enemy guard-breaks: PostureBreak freezes the AI (zeroes the velocity the AI
// set, holds isHurting), __GAME__.postureBroken flips true, postureRemaining reads the
// open window, and enemy.guardBroken fires. The frozen enemy's x stops advancing.
// ══════════════════════════════════════════════════════════════════════════════
{
  const group = new EnemyGroup();
  const enemy = makeEnemy({ id: 'grunt-A', x: 300, y: 64, group });
  group.add(enemy);
  const scene = makeScene(group);
  const bus = scene.eventBus;

  const sys = new PostureBreak({ maxPosture: 100, hitGain: 20, parryGain: 50, decayPerSec: 0, windowMs: 1500 });
  sys.reset();
  sys.attach(scene);

  check('precondition: __GAME__.postureBroken starts false', scene.postureBroken === false, `postureBroken=${scene.postureBroken}`);
  check('precondition: enemy is in __GAME__.entities', entityIds(group).includes('grunt-A'), JSON.stringify(entityIds(group)));

  const cur = bus.cursor;
  // Let the enemy PATROL a few frames first (untouched, posture 0) so it visibly advances —
  // this is the baseline the freeze is measured against. Decay acts here on a 0 meter (no-op).
  for (let f = 0; f < 3; f++) frame(group, sys);
  check('enemy patrolled before any hit (AI moving it)', enemy.x > 300 && scene.postureBroken === false, `x=${enemy.x}`);

  // DRIVE four landed hits (4×20 = 80 < 100) in quick succession — accrues but does NOT
  // break. Each is announced on the bus exactly as BaseEnemy.takeDamage does. One frame
  // drains all four (the bus log seam returns every fresh event), so inter-hit decay does
  // not eat the accrual — faithful to several blows landing in one combat beat.
  for (let h = 0; h < 4; h++) {
    bus.emit('enemy.damaged', { id: 'grunt-A', x: enemy.x, y: 64, health: 999, damage: 1 });
  }
  frame(group, sys);
  check('after 4 hits (80 posture) → NOT yet broken (AI still patrolling)', scene.postureBroken === false && enemy.x > 300, `postureBroken=${scene.postureBroken} x=${enemy.x}`);

  // DRIVE the FIFTH hit (80 + 20 = exactly maxPosture 100) → guard break THIS frame. Land
  // exactly one so the break fires WITHOUT a leftover hit in the same frame (a hit past the
  // break would itself execute — that is the separate enemy.executed driver below).
  bus.emit('enemy.damaged', { id: 'grunt-A', x: enemy.x, y: 64, health: 999, damage: 1 });
  frame(group, sys);

  // OBSERVABLE expect: __GAME__.postureBroken is TRUE and postureRemaining reads the open
  // window (≈ windowMs, counted down by the frames since the break).
  check('enemy.guardBroken → __GAME__.postureBroken is TRUE', scene.postureBroken === true, `postureBroken=${scene.postureBroken}`);
  check('enemy.guardBroken → __GAME__.postureRemaining reads the open window (> 0)', scene.postureRemaining > 0 && scene.postureRemaining <= 1500, `postureRemaining=${scene.postureRemaining}`);
  // OBSERVABLE expect: the AI is FROZEN — the enemy's x stops advancing despite the AI
  // still commanding a patrol velocity each frame. Run a few more frames and confirm x is
  // pinned (PostureBreak re-zeroes the velocity the AI set).
  const xAtBreak = enemy.x;
  for (let f = 0; f < 5; f++) frame(group, sys);
  check('enemy.guardBroken → AI frozen: enemy x stops advancing', enemy.x === xAtBreak && enemy.isHurting === true, `xAtBreak=${xAtBreak} xNow=${enemy.x} isHurting=${enemy.isHurting}`);
  check('enemy.guardBroken → the enemy DID advance before the freeze (the patrol was real)', xAtBreak > 300, `spawnX=300 frozenAtX=${xAtBreak}`);
  // OBSERVABLE expect: enemy.guardBroken logged on the bus with {id,x,y}.
  const broken = bus.recent(cur).filter((e) => e.type === 'enemy.guardBroken');
  check('enemy.guardBroken logged on the bus', broken.length === 1, `count=${broken.length}`);
  check('enemy.guardBroken payload {id}', (broken[0]?.payload as any)?.id === 'grunt-A', JSON.stringify(broken[0]?.payload));
  // Still in entities — guard-broken is not yet dead.
  check('enemy.guardBroken → enemy still in __GAME__.entities (not yet executed)', entityIds(group).includes('grunt-A'), JSON.stringify(entityIds(group)));

  // ════════════════════════════════════════════════════════════════════════════
  // BRANCH B (enemy.executed) — a hit lands DURING the open window → deathblow in ONE
  // blow regardless of the enemy's 999 health. The enemy leaves __GAME__.entities and
  // enemy.executed fires.
  // ════════════════════════════════════════════════════════════════════════════
  const cur2 = bus.cursor;
  check('execute precondition: enemy health is HIGH (a normal hit cannot kill it)', enemy.health === 999, `health=${enemy.health}`);
  // DRIVE the executing hit inside the open window.
  bus.emit('enemy.damaged', { id: 'grunt-A', x: enemy.x, y: 64, health: 999, damage: 1 });
  frame(group, sys);

  // OBSERVABLE expect: the enemy is REMOVED from __GAME__.entities in one blow (die() set
  // isDead + dropped it from the group) — regardless of its 999 health. NOT set by the test.
  check('enemy.executed → enemy removed from __GAME__.entities in ONE blow', !entityIds(group).includes('grunt-A') && enemy.isDead === true, `entities=${JSON.stringify(entityIds(group))} isDead=${enemy.isDead}`);
  // OBSERVABLE expect: enemy.executed logged on the bus with {id,x,y}.
  const executed = bus.recent(cur2).filter((e) => e.type === 'enemy.executed');
  check('enemy.executed logged on the bus', executed.length === 1, `count=${executed.length}`);
  check('enemy.executed payload {id}', (executed[0]?.payload as any)?.id === 'grunt-A', JSON.stringify(executed[0]?.payload));
  // The standardized kill path also fired (onEnemyKilled → kill-count + enemy.died).
  check('enemy.executed → the kill-count seam fired (onEnemyKilled)', scene.killCount === 1, `killCount=${scene.killCount}`);
  // The window closed once the enemy is gone → observables fall back.
  frame(group, sys);
  check('enemy.executed → window closes: __GAME__.postureBroken back to false', scene.postureBroken === false && scene.postureRemaining === 0, `postureBroken=${scene.postureBroken} remaining=${scene.postureRemaining}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// BRANCH C (the PARRY driver feeds the most) — two parries (parryGain 50 ×2 = 100) break
// the guard, proving attack.parried is the high-value driver the contract names.
// ══════════════════════════════════════════════════════════════════════════════
{
  const group = new EnemyGroup();
  const enemy = makeEnemy({ id: 'grunt-C', x: 300, y: 64, group });
  group.add(enemy);
  const scene = makeScene(group);
  const bus = scene.eventBus;
  const sys = new PostureBreak({ maxPosture: 100, hitGain: 20, parryGain: 50, decayPerSec: 0, windowMs: 1500 });
  sys.reset();
  sys.attach(scene);

  const cur = bus.cursor;
  // ONE parry (50) — not enough to break.
  bus.emit('attack.parried', { id: 'grunt-C', x: enemy.x, y: 64 });
  frame(group, sys);
  check('one parry (50) → NOT broken yet', scene.postureBroken === false, `postureBroken=${scene.postureBroken}`);
  // SECOND parry (50+50=100) → break.
  bus.emit('attack.parried', { id: 'grunt-C', x: enemy.x, y: 64 });
  frame(group, sys);
  check('two parries (100) → enemy.guardBroken (parry is the high-value driver)', scene.postureBroken === true, `postureBroken=${scene.postureBroken}`);
  check('two parries → enemy.guardBroken logged', bus.recent(cur).some((e) => e.type === 'enemy.guardBroken'), JSON.stringify(bus.recent(cur).map((e) => e.type)));
}

// ══════════════════════════════════════════════════════════════════════════════
// COUNTERFACTUAL (meaningfulness proof): a hit that does NOT meet the break threshold
// (only one or two hits — below maxPosture) NEVER breaks the guard, NEVER freezes the AI,
// and fires NEITHER event. If accrue()/guardBreak() were a no-op (the verb did nothing),
// BRANCH A's "postureBroken TRUE" and "enemy.guardBroken logged" would fail — they pass
// only because the real accrual crossed max. Here, sub-threshold input proves the negative.
// ══════════════════════════════════════════════════════════════════════════════
{
  const group = new EnemyGroup();
  const enemy = makeEnemy({ id: 'grunt-D', x: 300, y: 64, group });
  group.add(enemy);
  const scene = makeScene(group);
  const bus = scene.eventBus;
  const sys = new PostureBreak({ maxPosture: 100, hitGain: 20, parryGain: 50, decayPerSec: 0, windowMs: 1500 });
  sys.reset();
  sys.attach(scene);

  // TWO landed hits only (40 < 100) — below the break threshold.
  for (let h = 0; h < 2; h++) {
    bus.emit('enemy.damaged', { id: 'grunt-D', x: enemy.x, y: 64, health: 999, damage: 1 });
    frame(group, sys);
  }
  check('counterfactual: sub-threshold hits (40) → NOT broken', scene.postureBroken === false && scene.postureRemaining === 0, `postureBroken=${scene.postureBroken} remaining=${scene.postureRemaining}`);
  check('counterfactual: sub-threshold → AI NOT frozen (enemy still patrolled)', enemy.x > 300 && enemy.isHurting === false, `x=${enemy.x} isHurting=${enemy.isHurting}`);
  check('counterfactual: sub-threshold → enemy still in __GAME__.entities', entityIds(group).includes('grunt-D'), JSON.stringify(entityIds(group)));
  check('counterfactual: sub-threshold → NO enemy.guardBroken logged', bus.recent().every((e) => e.type !== 'enemy.guardBroken'), JSON.stringify(bus.recent().map((e) => e.type)));
  check('counterfactual: sub-threshold → NO enemy.executed logged', bus.recent().every((e) => e.type !== 'enemy.executed'), JSON.stringify(bus.recent().map((e) => e.type)));

  // And a hit on a NON-broken enemy is a normal hit — it does NOT execute (health 999
  // survives): the one-blow removal is gated on the open window, not any hit.
  bus.emit('enemy.damaged', { id: 'grunt-D', x: enemy.x, y: 64, health: 999, damage: 1 });
  frame(group, sys);
  check('counterfactual: a hit on a NON-broken enemy does NOT execute (still alive)', !enemy.isDead && entityIds(group).includes('grunt-D'), `isDead=${enemy.isDead}`);
}

console.log(`\nALL ${assertionsPassed()} ASSERTIONS PASSED — PostureBreak fires enemy.guardBroken/executed with their expect transitions (AI frozen, postureBroken/postureRemaining set; one-blow removal from entities regardless of 999 health) on observable state, and sub-threshold input breaks nothing.`);
