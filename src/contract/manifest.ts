/**
 * ============================================================================
 * manifest.ts  —  the index.json SLOT-MANIFEST types + the preload RULE
 * ============================================================================
 * The engine-agnostic CONTRACT of the `index.json` asset manifest W2 derives and
 * a preloader reads. It holds the manifest TYPES (`AssetSlot`/`IndexManifest`)
 * and the placeholder-floor preload RULE (the decision, not the engine loader):
 * for each slot, load its real on-disk file ONLY when one exists — final art
 * (`status: 'generated'`) or a legible greybox PNG (`status: 'placeholder'` WITH
 * a `path`); every other slot (pending / no path) falls through to the engine's
 * programmatic placeholder fill, so the game boots & renders with ZERO generated
 * art. The per-engine preloader (Phaser's `core/src/scenes/Preloader.ts` today)
 * imports these types + this rule and brings only its own loader calls.
 */

/** One asset slot in the manifest (W2 derives it; W3 fills `status`/`path`). */
export interface AssetSlot {
  slot: string;
  type: string;
  path: string;
  width: number;
  height: number;
  frames?: string[];
  status: string;
}

/** The `index.json` manifest shape (archetype + assetsDir + slots[]). */
export interface IndexManifest {
  archetype?: string;
  assetsDir?: string;
  slots?: AssetSlot[];
}

/**
 * THE PRELOAD RULE (placeholder-floor): true iff this slot has a real on-disk
 * file to load — a non-empty `path` AND a `status` of 'generated' (final art) or
 * 'placeholder' (a legible greybox PNG W3 wrote to disk). Both are real files;
 * load them. Any other slot (pending / no path) returns false and falls through
 * to the engine's programmatic colored-rect fill in create(). This is the
 * W3↔template contract: a non-empty path means "a real file exists — load it".
 */
export function shouldLoadSlotFile(slot: AssetSlot): boolean {
  if (!slot.path) return false;
  return slot.status === 'generated' || slot.status === 'placeholder';
}
