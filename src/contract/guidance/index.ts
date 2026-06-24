/**
 * ============================================================================
 * guidance/index.ts — the shared guidance unit's public API (convenience re-export)
 * ============================================================================
 * The renderer-agnostic in-game guidance layer, shared by BOTH engines (imported as
 * `@contract/guidance/*`). Consumers MAY import a specific path (e.g.
 * `@contract/guidance/mountGuidance`); this barrel is a convenience for pulling the
 * public surface in one import.
 *
 * Surface:
 *   - mountGuidance — the single DOM mount seam (coaching[] + overlays[]).
 *   - GuidanceDriver — the unified DOM driver (the seam mountGuidance drives).
 *   - WorldCueDriver — the renderer-agnostic in-world cue driver (marker injected).
 *   - TriggerEngine — the generic data-driven trigger engine.
 *   - Coachmark — the player-facing teaching DOM card.
 *   - the worldCue marker types (CueTarget / EntityResolver / CueMarker / MarkerFactory).
 */

export { mountGuidance } from './mountGuidance';
export { GuidanceDriver } from './GuidanceDriver';
export { WorldCueDriver } from './WorldCueDriver';
export type { CueTarget, EntityResolver, CueMarker, MarkerFactory } from './WorldCueDriver';
export { TriggerEngine } from './TriggerEngine';
export { Coachmark } from './Coachmark';
