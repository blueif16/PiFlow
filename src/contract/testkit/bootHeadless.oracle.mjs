/**
 * bootHeadless.oracle.mjs — the ORACLE PROOF: the real world hosts what the
 * hand-rolled "light kit" shell could NOT.
 * ============================================================================
 *
 * The light kit drives a component against a plain-object scene shell. Two
 * common components were "needs-host" there — they require a host surface a bare
 * object cannot provide:
 *
 *   ChaseAI       — its update() calls `owner.setVelocityX(...)` (a real arcade
 *                   sprite method). A plain object has no body and no setVelocityX.
 *   CollectScore  — its collect() reads/writes `scene.registry` + utils.setScore
 *                   (the real score seam, which emits score.changed on the scene's
 *                   real bus) and sweeps `scene.decorations`. A plain shell has
 *                   none of these. (It ALSO optional-chains scene.fireEffect?.() /
 *                   scene.consumeReward?.() — DataLevelScene-only extras absent on
 *                   the default BaseLevelScene boot scene; see the note below.)
 *
 * In the REAL booted scene both MOUNT + STEP + ACT with NO shim, because the
 * world provides the host surface: a real enemy sprite for ChaseAI, and the real
 * scene host (registry, decorations, utils.setScore, the bus) for CollectScore.
 * This file mounts each through the engine's OWN resolver and asserts the real
 * observable consequence. Exit 0 on both.
 *
 * NOTE on the default boot scene: bootHeadlessGame() boots the archetype's
 * default Level1Scene, which extends BaseLevelScene (NOT DataLevelScene). So
 * CollectScore scores + logs on the real bus, but consumeReward/fireEffect
 * (DataLevelScene seams) are absent — a true property of the chosen default
 * scene, not a harness gap. A future config booting a DataLevelScene would add
 * those seams; the score+bus proof already shows the host the shell lacked.
 *
 *   node templates/core-contract/src/testkit/bootHeadless.oracle.mjs
 */
import assert from 'node:assert/strict';
import { bootHeadlessGame } from './bootHeadlessGame.mjs';

const t0 = Date.now();
const world = await bootHeadlessGame();
const { scene } = world;

// ════════════════════════════════════════════════════════════════════════════
// ORACLE 1 — ChaseAI (needs owner.setVelocityX): mount onto a REAL enemy sprite.
// ════════════════════════════════════════════════════════════════════════════
// spawnEnemy() makes a real arcade sprite (has setVelocityX + a body). mountBehavior
// attaches ChaseAI via the engine's BehaviorManager and points it at the player.
const enemy = world.spawnEnemy({ x: scene.mapWidth * 0.8, y: scene.mapHeight - 80 });
const playerX = scene.player.x;
// Put the player well to the LEFT of the enemy so ChaseAI must drive velocity left.
scene.player.body.reset(scene.mapWidth * 0.2, scene.mapHeight - 80);

const chase = world.mountBehavior('ChaseAI', { speed: 120, detectionRange: 9999 }, enemy);
assert.equal(chase.constructor.name, 'ChaseAI', 'resolveBehavior did not return a real ChaseAI');

const vxBefore = enemy.body.velocity.x;
const exBefore = Math.round(enemy.x);
world.step(20); // ChaseAI.update() runs each step (mounted-behavior tick)
const vxAfter = enemy.body.velocity.x;
const exAfter = Math.round(enemy.x);

// ACTED, no shim: ChaseAI set a leftward velocity on the REAL body (player is left),
// and the real physics integrated it → the enemy MOVED toward the player.
assert.ok(chase.isChasing(), 'ChaseAI is not chasing the player');
assert.ok(vxAfter < 0, `ChaseAI did not drive a leftward velocity (vx=${vxAfter})`);
assert.ok(exAfter < exBefore, `enemy did not move toward the player (${exBefore}→${exAfter})`);
console.log(
  `[oracle] ChaseAI ok (real owner.setVelocityX, no shim) | isChasing=${chase.isChasing()} | body.vx ${vxBefore}→${Math.round(vxAfter)} | enemy.x ${exBefore}→${exAfter} (player.x≈${Math.round(scene.player.x)})`,
);

// ════════════════════════════════════════════════════════════════════════════
// ORACLE 2 — CollectScore (needs scene.fireEffect/consumeReward/registry/bus):
// mount into the REAL scene and collect a REAL reward sprite.
// ════════════════════════════════════════════════════════════════════════════
// Spawn a real reward into the scene's decorations group (the host surface
// CollectScore reads: scene.decorations + scene.rewardsById + consumeReward).
const reward = scene.physics.add.sprite(scene.player.x, scene.player.y, '__px');
reward.setDisplaySize(32, 32);
reward.body.setAllowGravity(false);
reward.__type = 'collectible';
reward.__id = 'oracle_coin';
scene.decorations.add(reward);
if (scene.rewardsById) scene.rewardsById['oracle_coin'] = reward;

const scoreBefore = scene.registry.get('score') ?? 0;
const cursorBefore = scene.eventBus.cursor;
const collect = world.mountSystem('CollectScore', { valuePerReward: 5 });
assert.equal(collect.constructor.name, 'CollectScore', 'resolveSystem did not return a real CollectScore');

// Place the player ON the reward; the per-frame overlap sweep collects it.
scene.player.body.reset(reward.x, reward.y);
world.step(5);

const scoreAfter = scene.registry.get('score') ?? 0;
const scoreEvents = scene.eventBus
  .recent(cursorBefore)
  .filter((e) => e.type === 'score.changed');

// ACTED, no shim: score went up via the real registry + utils.setScore seam, the
// reward latched __collected through the real per-frame overlap sweep, and the
// real bus logged score.changed. (consumeReward/fireEffect are DataLevelScene
// extras absent on the default BaseLevelScene — see the file header note.)
assert.ok(scoreAfter > scoreBefore, `score did not increase (${scoreBefore}→${scoreAfter})`);
assert.equal(scoreAfter, scoreBefore + 5, 'score did not increase by valuePerReward');
assert.equal(reward.__collected, true, 'reward was not collected by the real overlap sweep');
assert.ok(scoreEvents.length >= 1, 'score.changed never fired on the real bus');
console.log(
  `[oracle] CollectScore ok (real scene host, no shim) | score ${scoreBefore}→${scoreAfter} | reward.__collected=${reward.__collected} | bus events=[${scoreEvents.map((e) => e.type).join(', ')}]`,
);

world.destroy();
console.log(`[oracle] BOTH needs-host components MOUNTED+ACTED in the real scene — ${Date.now() - t0}ms`);
process.exit(0);
