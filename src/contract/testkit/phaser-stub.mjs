/**
 * phaser-stub.mjs — a MINIMAL real `Phaser` default export for the kit's drive tests.
 *
 * LIFTED VERBATIM from templates/modules/platformer/src/behaviors/__tests__/phaser-stub.mjs.
 * Behavior components do `import Phaser from 'phaser'`, but the real Phaser package cannot
 * load under bare Node (its device-detect touches `window` at import time → ReferenceError).
 * Type-stripping erases every TYPE use of `Phaser`, so the ONLY runtime members these
 * components read are provided here, implemented FAITHFULLY — not stubbed to a convenient
 * value:
 *   - Phaser.Math.Distance.Between(x1,y1,x2,y2) → the REAL Euclidean distance.
 *   - Phaser.Physics.Arcade.Body / .StaticBody  → empty classes so the `instanceof` guards
 *     in utils.ts are well-defined (not on any driven path; provided for completeness).
 *
 * Nothing returns a precomputed "expected" value — Distance.Between computes the real
 * hypotenuse from the real coordinates, exactly as Phaser does.
 */
const Phaser = {
  Math: {
    Distance: {
      Between(x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        return Math.sqrt(dx * dx + dy * dy);
      },
    },
  },
  Physics: {
    Arcade: {
      Body: class Body {},
      StaticBody: class StaticBody {},
    },
  },
  GameObjects: {
    Zone: class Zone {},
  },
};

export default Phaser;
