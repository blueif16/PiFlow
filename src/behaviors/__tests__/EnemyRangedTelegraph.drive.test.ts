/**
 * EnemyRangedTelegraph — runtime DRIVE test (event-protocol conformance).
 *
 * Proves the component actually FIRES at runtime by driving its real verb against
 * REAL objects and asserting EACH declared surface() event with its `expect`
 * transition on OBSERVABLE state.
 *
 * surface() contract under test (templates/modules/platformer/src/behaviors/EnemyRangedTelegraph.ts):
 *   - enemy.aimed  drivenBy "move"
 *                  expect   "the enemy stops and faces the player with NO projectile yet for
 *                            aimMs; enemy.aimed logged"
 *   - enemy.fired  drivenBy "move"
 *                  expect   "a projectile enters __GAME__.entities only on/after this frame
 *                            (never during the aim window); enemy.fired logged"
 *
 * REAL objects + REAL drive (NOT a stub that returns the expected value):
 *   - The real EnemyRangedTelegraph class + the real EventBus (its ring buffer IS the
 *     recording bus — every emit is captured in `bus.recent()`).
 *   - A REAL RangedAttack bound via setFire() — the SAME canonical enemy-fire path the
 *     component delegates to. enemy.fired's projectile is produced by RangedAttack.shootAt →
 *     utils.createProjectile, which spawns a REAL sprite into scene.enemyBullets. The
 *     "a projectile enters the bullet group" consequence EMERGES from that real path; the
 *     test never adds a bullet itself.
 *   - A scene shell carrying ONLY the real fields these reads need — eventBus, an advanceable
 *     time.now clock, the enemyBullets group, and the minimal Phaser-surface
 *     (textures/add.graphics/physics.add.sprite) that the UNMODIFIED utils.createProjectile
 *     touches — each faithfully reproduced (a real texture registry, a real arcade-sprite
 *     factory), never short-circuited to the expected output.
 *   - The enemy owner carries a real arcade body + the scene back-pointer; the component is
 *     ticked ONLY through its real per-frame seam move()/update() (update() delegates to the
 *     named verb seam — EnemyRangedTelegraph.ts:121-123), never via openAim()/releaseShot().
 *
 * The VERB ('move'): the enemy AI ticks move() each frame as it approaches. It opens the aim
 * tell (enemy.aimed: stops + faces, NO projectile), holds through aimMs, then releases the
 * wrapped shot (enemy.fired: a real bullet enters the group). The COUNTERFACTUAL ticks move()
 * with NO target and asserts the enemy stays idle — no aim, no shot, no event — the negative
 * that proves the test is not vacuous.
 */
import { EventBus, check, assertionsPassed } from '@contract/testkit';
import { EnemyRangedTelegraph } from '../EnemyRangedTelegraph.ts';
import { RangedAttack } from '../RangedAttack.ts';

// EnemyRangedTelegraph spawns a REAL projectile through utils.createProjectile, which touches a
// Phaser surface (textures / add.graphics / physics.add.sprite) + the enemyBullets group — a
// component-specific fire path the generic kit scene does not model — so the test keeps its
// faithful makeScene()/sprite/texture factories below. Only the bus + check + assertion tally
// come from the kit (EventBus is the same class the kit re-exports).

// ── A minimal REAL arcade Body (the shape utils.createProjectile configures) ──────────────
function makeArcadeBody(width: number, height: number) {
  return {
    width,
    height,
    velocity: { x: 0, y: 0 },
    allowGravity: false,
    setSize(w: number, h: number) {
      this.width = w;
      this.height = h;
      return this;
    },
    setOffset() {
      return this;
    },
    setAllowGravity(v: boolean) {
      this.allowGravity = v;
      return this;
    },
  } as any;
}

/** A REAL arcade-sprite factory — exactly the surface utils.createProjectile drives on a sprite. */
function makeArcadeSprite(x: number, y: number, _textureKey: string) {
  const sprite: any = {
    x,
    y,
    width: 8, // the generated bullet texture is 8x8 (createBulletTextures)
    height: 8,
    scaleX: 1,
    scaleY: 1,
    body: makeArcadeBody(8, 8),
    active: true,
    setScale(s: number) {
      this.scaleX = s;
      this.scaleY = s;
      return this;
    },
    setVelocityX(v: number) {
      this.body.velocity.x = v;
      return this;
    },
    setVelocityY(v: number) {
      this.body.velocity.y = v;
      return this;
    },
    setVelocity(vx: number, vy = 0) {
      this.body.velocity.x = vx;
      this.body.velocity.y = vy;
      return this;
    },
  };
  return sprite;
}

/** A REAL bullet group: the projectile really lands here → this IS __GAME__.entities. */
function makeGroup() {
  const children: any[] = [];
  return {
    add(sprite: any) {
      children.push(sprite);
      return sprite;
    },
    getChildren() {
      return children;
    },
  };
}

/** A minimal REAL texture registry (createBulletTextures registers keys here). */
function makeTextures() {
  const keys = new Set<string>();
  return {
    exists(k: string) {
      return keys.has(k);
    },
    __add(k: string) {
      keys.add(k);
    },
  };
}

/** A REAL graphics object enough for createBulletTextures to register a texture key. */
function makeGraphics(textures: ReturnType<typeof makeTextures>) {
  return {
    fillStyle() {
      return this;
    },
    fillCircle() {
      return this;
    },
    generateTexture(key: string) {
      textures.__add(key);
      return this;
    },
    destroy() {},
  };
}

/** A scene shell carrying exactly the live fields the component + RangedAttack path read. */
function makeScene() {
  const bus = new EventBus();
  const textures = makeTextures();
  const enemyBullets = makeGroup();
  const playerBullets = makeGroup();
  const scene: any = {
    eventBus: bus,
    time: { now: 0 },
    game: { loop: { delta: 16 } },
    textures,
    enemyBullets,
    playerBullets,
    add: { graphics: () => makeGraphics(textures) },
    physics: { add: { sprite: (x: number, y: number, key: string) => makeArcadeSprite(x, y, key) } },
  };
  return { bus, scene, enemyBullets, playerBullets };
}

/** A REAL enemy sprite owner: arcade body + scene back-pointer + the velocity/facing seams. */
function makeEnemy(opts: { id: string; x: number; y: number }, scene: any) {
  const enemy: any = {
    __id: opts.id,
    x: opts.x,
    y: opts.y,
    facingDirection: 'right',
    flipX: false,
    active: true,
    body: { velocity: { x: 7, y: 0 } }, // a non-zero approach velocity to prove the HOLD zeroes it
    scene,
    setVelocityX(v: number) {
      this.body.velocity.x = v;
    },
    setFlipX(v: boolean) {
      this.flipX = v;
    },
  };
  return enemy;
}

/** A REAL player target the aimed shot tracks. */
function makePlayer(opts: { x: number; y: number }, scene: any) {
  return { x: opts.x, y: opts.y, active: true, scene } as any;
}

// ══════════════════════════════════════════════════════════════════════════════
// DRIVE: aim tell opens (enemy.aimed) → holds through aimMs → shot leaves (enemy.fired)
// ══════════════════════════════════════════════════════════════════════════════
{
  const { bus, scene, enemyBullets } = makeScene();
  // Player to the LEFT of the enemy so the aim faces left.
  const enemy = makeEnemy({ id: 'archer-1', x: 500, y: 300 }, scene);
  const player = makePlayer({ x: 200, y: 300 }, scene);

  // The wrapped fire path: a REAL RangedAttack attached to the enemy (the canonical path).
  const ranged = new RangedAttack({ damage: 10, projectileKey: 'enemy_bullet', projectileSpeed: 400, cooldown: 0 });
  ranged.attach(enemy);

  const aimMs = 600;
  const sys = new EnemyRangedTelegraph({ aimMs, cooldownMs: 900, detectionRange: Infinity, bulletGroup: 'enemyBullets' });
  sys.attach(enemy);          // owner = the enemy sprite (sets onAttach → defaults target to scene.player; none here)
  sys.setTarget(player);      // bind the real target
  sys.setFire(ranged);        // bind the real wrapped fire path

  check('precondition: idle, no projectile in the group yet', sys.phase === 'idle' && enemyBullets.getChildren().length === 0, `phase=${sys.phase} bullets=${enemyBullets.getChildren().length}`);
  check('precondition: enemy approaching (non-zero velocity)', enemy.body.velocity.x === 7, `vx=${enemy.body.velocity.x}`);

  // ── DRIVE the move VERB at t=0: the cycle opens the aim tell. ──
  const cur0 = bus.cursor;
  scene.time.now = 0;
  sys.update(); // update() → move(): idle, in range, off cooldown → openAim → enemy.aimed

  // OBSERVABLE expect (enemy.aimed): the enemy STOPPED, FACES the player (on the left), and
  // NO projectile exists yet.
  check('enemy.aimed → phase is aiming (mid-tell)', sys.isAiming() === true && sys.phase === 'aiming', `phase=${sys.phase}`);
  check('enemy.aimed → enemy STOPPED (velocity held at 0)', enemy.body.velocity.x === 0, `vx=${enemy.body.velocity.x}`);
  check('enemy.aimed → enemy FACES the player (left)', enemy.facingDirection === 'left' && enemy.flipX === true, `facing=${enemy.facingDirection} flipX=${enemy.flipX}`);
  check('enemy.aimed → NO projectile spawned during the tell', enemyBullets.getChildren().length === 0, `bullets=${enemyBullets.getChildren().length}`);
  const aimed = bus.recent(cur0).filter((e) => e.type === 'enemy.aimed');
  check('enemy.aimed logged on the bus', aimed.length === 1, `count=${aimed.length}`);
  check('enemy.aimed payload {id,x,y}', (aimed[0]?.payload as any)?.id === 'archer-1' && (aimed[0]?.payload as any)?.x === 500 && (aimed[0]?.payload as any)?.y === 300, JSON.stringify(aimed[0]?.payload));

  // ── DRIVE move() across MID-tell frames: still aiming, STILL no projectile, NO new event. ──
  const cur1 = bus.cursor;
  scene.time.now = 300; // < aimMs → tell not elapsed
  sys.update();
  check('mid-tell → still aiming, velocity still 0', sys.isAiming() === true && enemy.body.velocity.x === 0, `phase=${sys.phase} vx=${enemy.body.velocity.x}`);
  check('mid-tell → STILL no projectile (none during the aim window)', enemyBullets.getChildren().length === 0, `bullets=${enemyBullets.getChildren().length}`);
  check('mid-tell → no new aimed/fired event (lean)', bus.recent(cur1).every((e) => e.type !== 'enemy.aimed' && e.type !== 'enemy.fired'), JSON.stringify(bus.recent(cur1).map((e) => e.type)));

  // ── DRIVE move() AFTER aimMs: the tell elapses → the wrapped shot leaves (enemy.fired). ──
  const cur2 = bus.cursor;
  scene.time.now = aimMs + 1; // now - aimStartedAt >= aimMs → release
  sys.update();

  // OBSERVABLE expect (enemy.fired): a REAL projectile entered scene.enemyBullets ONLY now,
  // produced by the real RangedAttack path — never during the tell.
  check('enemy.fired → a projectile ENTERED enemyBullets (1) only after the tell', enemyBullets.getChildren().length === 1, `bullets=${enemyBullets.getChildren().length}`);
  const bullet = enemyBullets.getChildren()[0];
  check('enemy.fired → the spawned projectile carries real fire velocity (toward the player, left)', bullet.body.velocity.x === -400, `bulletVx=${bullet.body.velocity.x}`);
  check('enemy.fired → phase moved to cooldown (post-shot)', sys.phase === 'cooldown', `phase=${sys.phase}`);
  const fired = bus.recent(cur2).filter((e) => e.type === 'enemy.fired');
  check('enemy.fired logged on the bus', fired.length === 1, `count=${fired.length}`);
  check('enemy.fired payload {id,x,y}', (fired[0]?.payload as any)?.id === 'archer-1', JSON.stringify(fired[0]?.payload));
  // The tell→shot ORDER on the bus: aimed strictly before fired.
  const all = bus.recent().map((e) => e.type).filter((t) => t === 'enemy.aimed' || t === 'enemy.fired');
  check('order: enemy.aimed fired BEFORE enemy.fired (the readable tell precedes the shot)', all[0] === 'enemy.aimed' && all[all.length - 1] === 'enemy.fired', JSON.stringify(all));
}

// ══════════════════════════════════════════════════════════════════════════════
// COUNTERFACTUAL (meaningfulness proof): tick move() with NO target. The cycle never
// opens — the enemy stays idle, NO aim tell, NO shot enters the group, and NEITHER
// enemy.aimed NOR enemy.fired is logged. If move() were a no-op that always emitted, the
// DRIVE assertions would still pass but THIS would fail; if openAim/releaseShot never
// emitted, the DRIVE "aimed/fired logged" + "projectile entered" assertions would fail.
// Both directions covered — the test is not vacuous.
// ══════════════════════════════════════════════════════════════════════════════
{
  const { bus, scene, enemyBullets } = makeScene();
  const enemy = makeEnemy({ id: 'archer-2', x: 500, y: 300 }, scene);
  const ranged = new RangedAttack({ damage: 10, projectileKey: 'enemy_bullet', projectileSpeed: 400, cooldown: 0 });
  ranged.attach(enemy);
  const sys = new EnemyRangedTelegraph({ aimMs: 600, bulletGroup: 'enemyBullets' });
  sys.attach(enemy);
  sys.setTarget(null);   // NO target → no cycle
  sys.setFire(ranged);

  for (let f = 0; f < 60; f++) {
    scene.time.now = f * 16;
    sys.update(); // move(): no target → settle to idle, stop, never aim/fire
  }

  check('counterfactual: no target → stays idle (never aims)', sys.phase === 'idle' && sys.isAiming() === false, `phase=${sys.phase}`);
  check('counterfactual: no target → NO projectile ever entered the group', enemyBullets.getChildren().length === 0, `bullets=${enemyBullets.getChildren().length}`);
  check('counterfactual: no target → no enemy.aimed / enemy.fired logged', bus.recent().every((e) => e.type !== 'enemy.aimed' && e.type !== 'enemy.fired'), JSON.stringify(bus.recent().map((e) => e.type)));
}

console.log(`\nALL ${assertionsPassed()} ASSERTIONS PASSED — EnemyRangedTelegraph fires enemy.aimed (stops + faces, NO projectile during the aimMs tell) then enemy.fired (a real projectile enters enemyBullets only after the tell) with their expect transitions on observable state; with no target it stays idle and emits nothing.`);
