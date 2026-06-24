/**
 * ============================================================================
 * sound/mountSound.ts — the SINGLE SFX mount seam (KEEP — engine)
 * ============================================================================
 * The sibling of `mountGuidance`: mounts the renderer-agnostic `SoundPlayer`
 * (gameConfig.sound.sfx[] → event-triggered one-shots) and drives it from ONE
 * lightweight rAF poll. This is the canonical home so a main.ts (core OR an
 * archetype module, 2D OR 3D) wires the whole SFX layer in ONE call.
 *
 * WHY a shared seam: an archetype module ships its OWN main.ts that OVERLAYS the
 * core one (module wins), so an inline `new SoundPlayer()` + hand-rolled poll loop
 * had to be copied into EVERY main.ts (core + each archetype, 2D and 3D) — and the
 * copies drifted (the 2D ones polled via their own rAF, the 3D ones rode the render
 * loop). One `mountSound(hook, gameConfig)` call guarantees the SFX layer is wired
 * identically in EVERY build, and adding an archetype touches ZERO sound code.
 *
 * SIBLING OF guidance, JOINED ONLY BY THE EVENT NAME: one gameplay event ⇒ guidance
 * reveals a coachmark AND sound plays an sfx, as two INDEPENDENT consumers that both
 * POLL the same `window.__GAME__` event seam. Driving from a rAF poll (the SAME
 * discipline `mountGuidance` uses, NOT the engine's own loop) keeps it engine-
 * agnostic: `start(hook)` baselines the event cursor on the first `ready` frame (the
 * SAME latch guidance + the verify harness wait on), `update(hook)` polls each frame.
 * INERT when no sound.sfx[] is declared (the driver registers nothing) — the additive
 * guarantee.
 */

import type { GameHook } from '@contract/hook-contract';
import { SoundPlayer } from './SoundPlayer';

/**
 * Mount + drive the SFX player. Call ONCE from main.ts with the installed hook + the
 * merged gameConfig. `audioBase` is the public-relative prefix a sound key resolves
 * under (`<base><key>.wav`); it defaults to the conventional vendored SFX root.
 */
export function mountSound(
  hook: GameHook,
  gameConfig: Record<string, unknown>,
  audioBase = 'audio/sfx/',
): void {
  const player = new SoundPlayer();
  player.mount(gameConfig, audioBase);

  let started = false;
  const poll = (): void => {
    if (!started) {
      // Baseline the cursor once the world is live (the SAME ready-latch guidance waits on).
      if (hook.ready === true) {
        started = true;
        player.start(hook);
      }
    } else {
      player.update(hook);
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}
