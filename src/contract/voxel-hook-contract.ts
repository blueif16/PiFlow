/**
 * ============================================================================
 * voxel-hook-contract.ts — OPTIONAL additive 3D-voxel oracle extension
 * ============================================================================
 *
 * The voxel-sandbox archetype's ADDITIVE `window.__GAME__` observables, declared as
 * an OPTIONAL extension of the base `GameHook` — NEVER altering the immutable base
 * shape (`@contract/hook-contract`). A 2D consumer ignores these; a voxel build
 * augments the installed hook with them. They are all READ-ONLY over real world /
 * controller state, JSON-serializable, and headless-safe — exactly the anti-reward-
 * hack discipline the base oracle commits.
 *
 * Per docs/handoff-build-voxel-sandbox-category.md §6 + the M3 bar:
 *   - player.position{x,y,z} (REAL, from the controller) — rides on the existing
 *     HookPlayer3D extra in core-3d/hook-3d.ts (player.position / lookDirection);
 *   - blockAt(x,y,z) — a getter/command over the VoxelStore (0 = empty);
 *   - worldBlockCount — the count of non-air voxels in the store.
 *
 * Per the M4 bar (the interaction layer — mining/placement/inventory probes §6
 * #1,#2,#4 + the input-arbitration / placement-safety gates):
 *   - inventory — a per-block-type count map (the conservation oracle reads it);
 *   - targetBlock — the grid coord of the block under the reticle (null if none);
 *   - miningProgress — the current charge toward a break in [0,1] (0 = not mining);
 *   - selectedBlock — the block id the place verb would emit.
 *
 * NOTE: this is an OPTIONAL extension type. The base `GameHook` required fields are
 * unchanged; M4's mining/placement/inventory observables extend this same shape.
 */

import type { GameHook } from './hook-contract';

/** A world-units / grid coordinate triple (the additive 3D extra). */
export interface VoxelVec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The base oracle + the ADDITIVE voxel observables. A voxel build populates these
 * onto the installed `window.__GAME__`; the base shape is untouched, so the verify
 * harness reads the base fields unchanged and a voxel-aware probe reads the extras.
 */
export interface VoxelGameHook extends GameHook {
  /** The block id at grid cell (x,y,z); 0 = empty/air; 0 out-of-bounds. */
  blockAt(x: number, y: number, z: number): number;
  /** The count of non-air voxels currently in the world. */
  worldBlockCount: number;

  // ── M4 interaction observables (additive) ──────────────────────────────────
  /**
   * Per-block-type held counts, keyed by block id (as a string key) → count. The
   * conservation oracle reads it: mine increments the mined type, place decrements
   * the placed type. Read-only over the real Inventory state, JSON-serializable.
   */
  inventory: Record<string, number>;
  /**
   * The grid cell currently under the screen-center reticle (the DDA hit voxel), or
   * null when nothing solid is targeted within reach. The mine verb acts on it.
   */
  targetBlock: VoxelVec3 | null;
  /**
   * Mining charge toward the current break, in [0,1] (0 = not mining; 1 = the block
   * breaks this frame). Real progress off the MiningFSM, not an implementer flag.
   */
  miningProgress: number;
  /** The block id the place verb would emit (the selected hotbar block). */
  selectedBlock: number;
}
