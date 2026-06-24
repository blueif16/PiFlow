/**
 * bootHeadless.smoke.mjs — the CANARY for the real-engine oracle harness.
 * ============================================================================
 *
 * Boots the real engine via bootHeadlessGame(), then asserts the four things
 * that must hold for the harness to be a trustworthy component oracle:
 *   1. READY      — the real engine reaches window.__GAME__.ready (TextureManager
 *                   readied, the default level mounted, markReady latched).
 *   2. DETERMINISM — the same step count over the same setup yields identical
 *                   state (the manual loop.step contract — no real-time drift).
 *   3. STEP/PHYSICS — gravity actually integrates (the player FALLS when lifted
 *                   into the air), proving the real physics world is stepping.
 *   4. COMPONENT FIRES — a known registry component (CrumblingPlatform) mounted
 *                   via the engine's own resolver fires platform.crumbled on the
 *                   real bus + removes the platform body — with NO shim.
 *
 * Exit 0 on all four; non-zero (with a printed reason) on any failure. Run it as
 * the guard after a Phaser bump / a touch to the testkit:
 *   cd templates/core && npm run testkit:smoke
 *   (or: node templates/core-contract/src/testkit/bootHeadless.smoke.mjs)
 */
import assert from 'node:assert/strict';
import { bootHeadlessGame } from './bootHeadlessGame.mjs';
import { assertPhaserPin, PINNED_PHASER } from './phaser-pin.mjs';

const t0 = Date.now();

// Guard 0: the pin (fails loud on a Phaser drift before any boot).
assertPhaserPin();
console.log(`[smoke] Phaser pin OK: ${PINNED_PHASER}`);

const bootT0 = Date.now();
const world = await bootHeadlessGame();
const bootMs = Date.now() - bootT0;

// ── 1. READY ────────────────────────────────────────────────────────────────
assert.equal(world.hook.ready, true, 'engine did not reach __GAME__.ready');
assert.equal(world.snapshot().status, 'playing', 'status is not playing');
assert.equal(world.scene.scene.key, 'Level1Scene', 'active scene is not the level');
console.log(
  `[smoke] READY ok | scene=${world.scene.scene.key} status=${world.snapshot().status} | boot+ready=${bootMs}ms`,
);

// ── 2 + 3. DETERMINISM + GRAVITY (the manual-step physics integration) ────────
const { scene, hook } = world;
const player = scene.player;
function gravityRun(n) {
  player.body.reset(216, 200);
  player.setVelocity?.(0, 0);
  player.isDead = false;
  const y0 = Math.round(hook.player.y);
  world.step(n);
  return { y0, y1: Math.round(hook.player.y) };
}
const stepT0 = Date.now();
const runA = gravityRun(30);
const runB = gravityRun(30);
const stepMs = (Date.now() - stepT0) / 60; // 60 frames driven above
assert.ok(runA.y1 > runA.y0, `player did not fall under gravity: ${JSON.stringify(runA)}`);
assert.deepEqual(runA, runB, `non-deterministic: A=${JSON.stringify(runA)} B=${JSON.stringify(runB)}`);
console.log(
  `[smoke] STEP+DETERMINISM ok | A=${JSON.stringify(runA)} B=${JSON.stringify(runB)} | ${stepMs.toFixed(4)}ms/frame`,
);

// ── 4. COMPONENT FIRES (CrumblingPlatform via the engine's own resolver) ──────
// Drive the REAL verb: drop the player onto a floating platform and let the
// engine's OWN ground collider seat it (no seat-fighting). The player standing
// past crumbleMs arms solid→shaking→gone; the component removes the body and
// fires platform.crumbled — all on the real scene/bus, NO shim.
const crumble = world.mountSystem('CrumblingPlatform', { crumbleMs: 200, telegraphMs: 50 });
assert.equal(
  crumble.constructor.name,
  'CrumblingPlatform',
  'resolveSystem did not return a real CrumblingPlatform',
);
const platforms = scene.groundLayer.getChildren();
const target =
  platforms.find((p) => p.body && p.body.width >= 200 && p.body.width < 300) ?? platforms[1];
const tb = target.body;
const enabledBefore = target.body.enable;
const cursorBefore = scene.eventBus.cursor;
// Place the player just above the platform center; gravity drops it onto the top.
player.body.reset(target.x, tb.top - player.body.height - 30);
player.setVelocity?.(0, 0);
for (let f = 0; f < 60 && target.body.enable !== false; f++) world.step(1);
const fired = scene.eventBus
  .recent(cursorBefore)
  .filter((e) => e.type === 'platform.crumbled');
assert.ok(fired.length >= 1, 'platform.crumbled never fired on the real bus');
assert.equal(target.body.enable, false, 'platform body collision was not removed');
// The component's OWN record id (from the fired payload) — its phase is 'gone'.
const firedId = fired[0].payload.id;
assert.equal(crumble.phaseOf(firedId), 'gone', 'crumble phase did not reach gone');
console.log(
  `[smoke] COMPONENT FIRED ok | platform.crumbled x${fired.length} | body.enable ${enabledBefore}→${target.body.enable} | phase=${crumble.phaseOf(firedId)} | payload=${JSON.stringify(fired[0].payload)}`,
);

world.destroy();
console.log(`[smoke] ALL PASS in ${Date.now() - t0}ms`);
process.exit(0);
