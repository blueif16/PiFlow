/**
 * ============================================================================
 * action-hook-contract.ts — OPTIONAL additive action_3d oracle extension
 * ============================================================================
 *
 * The action_3d (3D character-action) archetype's ADDITIVE `window.__GAME__`
 * observables, declared as an OPTIONAL extension of the base `GameHook` — NEVER
 * altering the immutable base shape (`@contract/hook-contract`). A 2D / voxel consumer
 * ignores these; an action_3d build augments the installed hook with them. They are
 * all READ-ONLY over real controller / weapon / interaction / mission state,
 * JSON-serializable, and headless-safe — the same anti-reward-hack discipline the base
 * oracle commits, and the same additive pattern as voxel-hook-contract.ts.
 *
 * The contracts-v1 Contract-4 runtime guarantee for this archetype: beyond the base
 * status/score/player/entities, an action mission scene must expose the SOFT-STATE
 * COUNTERS (objectivesCompleted, interactionsTriggered — monotone counters a "first
 * X" / "objective N done" trigger binds to while status stays 'playing') and the
 * verb/objective readouts (ammo, currentObjective, objectiveTarget) the shell HUD +
 * guidance triggers fire on. The NAMED SPATIAL ANCHORS (near:<id> / region:<id>) are
 * exposed by the CityWorld surface (keyLocations / walkableGraph), not as a __GAME__
 * scalar; objectiveTarget carries the active anchor REF so a worldCue resolves it.
 */

import type { GameHook } from './hook-contract';

/** A world-units coordinate triple (the additive 3D extra). */
export interface ActionVec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The base oracle + the ADDITIVE action_3d observables. An action build populates these
 * onto the installed `window.__GAME__`; the base shape is untouched, so the verify
 * harness reads the base fields unchanged and an action-aware probe reads the extras.
 */
export interface ActionGameHook extends GameHook {
  // ── controller extras (additive) ───────────────────────────────────────────
  /** The remaining ammo in the equipped weapon (the WeaponSystem.ammo readout). */
  ammo: number;
  /** The equipped weapon id (the WeaponSystem.selectedWeapon readout). */
  selectedWeapon: string;

  // ── interaction extras (additive) ──────────────────────────────────────────
  /**
   * Monotone count of interactions fired (a soft-state counter — a "first interact" /
   * "met N contacts" trigger binds to it while status stays 'playing'). Read-only over
   * the real InteractionManager state.
   */
  interactionsTriggered: number;
  /** The id of the interactable currently within range, or null (nearestInteractable). */
  nearestInteractable: string | null;

  // ── mission extras (additive) ──────────────────────────────────────────────
  /** The active objective's player-facing text, or null when the chain is done. */
  currentObjective: string | null;
  /**
   * The active objective's target ANCHOR ref (a `near:<id>` / `region:<id>` the
   * CityWorld surface exposes), or null. A worldCue arrow + the win check resolve it
   * against the walkableGraph / keyLocations.
   */
  objectiveTarget: string | null;
  /**
   * Monotone count of objectives completed (a soft-state counter — an "objective N
   * done" trigger binds to it; the win check reads it). Read-only over MissionManager.
   */
  objectivesCompleted: number;

  // ── resource extras (additive) ─────────────────────────────────────────────
  /** Currency the player holds (scoringModel:'currency' — the money HUD chip). */
  money: number;
  /** Bounded wanted/rating level in stars (the 4-star HUD chip). */
  rating: number;
}

/**
 * The additive 3D player extras (position + facing) the action controller writes onto
 * the player view, alongside the base HookPlayer fields. Rides on the same
 * HookPlayer3D pattern core-3d/hook-3d.ts already installs (player.position).
 */
export interface ActionHookPlayer {
  /** The player capsule CENTER {x,y,z} in world units (player.position). */
  position?: ActionVec3;
  /** The player body facing unit vector {x,y,z} on the world plane (player.facing). */
  facing?: ActionVec3;
}
