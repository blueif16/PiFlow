/**
 * ============================================================================
 * sound/index.ts — the shared sound unit's public API (convenience re-export)
 * ============================================================================
 * The renderer-agnostic in-game SFX layer, shared by BOTH engines (imported as
 * `@contract/sound/*`) — the sibling of `@contract/guidance/*`. Consumers MAY import
 * a specific path (e.g. `@contract/sound/mountSound`); this barrel is a convenience.
 *
 * Surface:
 *   - mountSound  — the single SFX mount seam (sound.sfx[] → event-triggered one-shots).
 *   - SoundPlayer — the renderer-agnostic poll-based player (the seam mountSound drives).
 */

export { mountSound } from './mountSound';
export { SoundPlayer } from './SoundPlayer';
