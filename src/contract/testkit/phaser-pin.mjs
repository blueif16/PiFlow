/**
 * phaser-pin.mjs — pin the harness to the engine's Phaser, and guard it.
 * ============================================================================
 *
 * The headless harness is a faithful oracle ONLY against the SAME Phaser the
 * built game ships (templates/core/node_modules/phaser). The five boot patches
 * (dom-env.mjs + boot-entry.ts) are written against a specific Phaser version;
 * a major bump can move the TextureManager boot path, the NullRenderer surface,
 * or the Graphics.generateTexture seam out from under them. Pin the expected
 * version here so a bump fails LOUDLY (the smoke canary asserts assertPhaserPin),
 * rather than the harness silently drifting from the real engine.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

/** The Phaser version the five boot patches were written + verified against. */
export const PINNED_PHASER = '3.90.0';

/** The engine's Phaser version, read from its installed package.json. */
export function enginePhaserVersion() {
  const pkg = resolve(
    repoRoot,
    'templates/core/node_modules/phaser/package.json',
  );
  return JSON.parse(readFileSync(pkg, 'utf8')).version;
}

/**
 * Assert the engine Phaser matches the pin. Throws with a precise message
 * naming the five patches to re-verify on a bump (the loud failure the prompt
 * requires). Returns the version on success.
 */
export function assertPhaserPin() {
  const actual = enginePhaserVersion();
  if (actual !== PINNED_PHASER) {
    throw new Error(
      `[testkit] Phaser version drift: engine has ${actual}, harness pinned to ${PINNED_PHASER}.\n` +
        `  The headless boot relies on 5 version-specific patches (see dom-env.mjs + boot-entry.ts):\n` +
        `    (1) window globals onto globalThis  (2) dimension-only Image stub  (3) null 2D context\n` +
        `    (4) Graphics.generateTexture shim    (5) deterministic loop.stop/step\n` +
        `  Re-verify each against Phaser ${actual}, then bump PINNED_PHASER in phaser-pin.mjs.`,
    );
  }
  return actual;
}
