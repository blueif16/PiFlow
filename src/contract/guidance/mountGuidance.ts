/**
 * ============================================================================
 * guidance/mountGuidance.ts — the SINGLE DOM-guidance mount seam (KEEP — engine)
 * ============================================================================
 * Mounts the unified DOM `GuidanceDriver` (coaching[] + overlays[]) over the canvas
 * host and drives it from ONE lightweight rAF poll. This is the canonical home so a
 * main.ts (core OR an archetype module, 2D OR 3D) wires the whole DOM guidance layer
 * in ONE call.
 *
 * WHY a shared seam: an archetype module ships its OWN main.ts that OVERLAYS the
 * core one (module wins), so the core's inline guidance mount is clobbered in a
 * scaffolded game. Every main.ts calling `mountGuidance(hook, gameConfig)`
 * guarantees the guidance layer survives the overlay in EVERY build (the bug this
 * fixes: fresh games rendered no coaching/overlay at all).
 *
 * Driving from a rAF poll (not the engine's own loop) keeps it engine-agnostic:
 * `start(hook)` baselines on the first `ready` frame (the SAME latch the verify
 * harness waits on), `update(hook)` polls each frame. INERT when no coaching[]/
 * overlays[] are declared (the driver registers no triggers) — the additive guarantee.
 *
 * NOTE: diegetic `worldCues[]` are NOT mounted here — they need the live scene/entity
 * position, so the scene mounts the WorldCueDriver scene-side with an injected marker.
 */

import type { GameHook } from '@contract/hook-contract';
import { GuidanceDriver } from './GuidanceDriver';

/**
 * Mount + drive the DOM guidance driver. Call ONCE from main.ts with the installed
 * hook + the merged gameConfig. The host is the `#game-container` the engine fills
 * with its <canvas> (the card mounts pointer-events:none, never trapping input).
 */
export function mountGuidance(hook: GameHook, gameConfig: Record<string, unknown>): void {
  const host =
    (document.getElementById('game-container') as HTMLElement | null) ?? document.body;
  const driver = new GuidanceDriver();
  driver.mount(host, gameConfig);

  let started = false;
  const poll = (): void => {
    if (!started) {
      // Baseline once the world is live (the SAME ready-latch the harness waits on).
      if (hook.ready === true) {
        started = true;
        driver.start(hook);
      }
    } else {
      driver.update(hook);
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}
