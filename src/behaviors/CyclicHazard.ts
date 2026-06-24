import Phaser from 'phaser';
import { BaseBehavior } from './IBehavior';

/**
 * CAPABILITY — self-describing registry sidecar (capability-registry-harness).
 * Globbed by registry/build-registry.mjs; bound by the blueprint via `id`.
 * EDIT THIS, not capabilities.json.
 */
export const CAPABILITY = {
  kind: 'behavior',
  id: 'CyclicHazard',
  intent:
    'Telegraphed timed hazard: cycles dormant -> telegraph -> active -> dormant; only the ACTIVE window is deadly and it is announced first. On player overlap during ACTIVE, fire the scene player-hit path.',
  roles: ['enemy'],
  params: ['cycleMs', 'activeMs', 'telegraphMs', 'shape', 'columnHeight', 'barWidth'],
  tuning: [],
} as const;

/** The four phases of one cycle. Exposed so a test can read/force the phase. */
export type HazardPhase = 'dormant' | 'telegraph' | 'active';

/**
 * CyclicHazard configuration.
 *
 * One cycle has length `cycleMs`. The ACTIVE (deadly) window is the LAST
 * `activeMs` of the cycle; the TELEGRAPH (announced, not yet deadly) window is
 * the `telegraphMs` immediately before ACTIVE; the rest is DORMANT (safe). So:
 *   dormant: [0,                       cycleMs-activeMs-telegraphMs)
 *   telegraph: [cycleMs-activeMs-telegraphMs, cycleMs-activeMs)
 *   active:    [cycleMs-activeMs,       cycleMs)
 * The deadly window is therefore derivable from the params (perturbation gate).
 */
export interface CyclicHazardConfig {
  /** Full cycle length in ms. */
  cycleMs: number;
  /** Length of the deadly ACTIVE window in ms (must be < cycleMs). */
  activeMs: number;
  /** Length of the TELEGRAPH window before ACTIVE in ms (>= 0). */
  telegraphMs: number;
  /** Visual shape of the hazard region. */
  shape: 'column' | 'bar';
  /** For shape 'column': the vertical reach in px (default 120). */
  columnHeight?: number;
  /** For shape 'bar': the horizontal reach in px (default 90). */
  barWidth?: number;
  /** Optional phase offset in ms so sibling hazards desync (default 0). */
  phaseOffsetMs?: number;
}

/**
 * CyclicHazard — a telegraphed, timed on/off hazard (a vent, an arc, a crusher,
 * a flame jet, a sweeping beam, …). Attach to an obstacle sprite; it drives the sprite's
 * phase on a timer. The ACTIVE window is the only deadly one and is ANNOUNCED
 * first by the TELEGRAPH window, so the timing read is always fair.
 *
 * GENERIC: no game/theme is baked in — the cycle numbers + shape are all params,
 * the phase visuals are minimal tints (a level overrides anim per phase). The
 * scene fires the player-hit path on overlap-during-ACTIVE (see
 * BaseLevelScene.spawnCyclicHazard).
 *
 * Test seam: `phase` is readable and `forcePhase('active')` pins the phase
 * (frozen until `releasePhase()`), so a harness can force/read the deadly
 * window deterministically.
 */
export class CyclicHazard extends BaseBehavior {
  public cycleMs: number;
  public activeMs: number;
  public telegraphMs: number;
  public shape: 'column' | 'bar';
  public columnHeight: number;
  public barWidth: number;
  public phaseOffsetMs: number;

  /** Current phase. Read by the scene's active-overlap check + tests. */
  public phase: HazardPhase = 'dormant';

  /** When set, the phase is PINNED to this value (test override). */
  private _forced: HazardPhase | null = null;

  constructor(config: CyclicHazardConfig) {
    super();
    this.cycleMs = config.cycleMs;
    this.activeMs = config.activeMs;
    this.telegraphMs = config.telegraphMs;
    this.shape = config.shape;
    this.columnHeight = config.columnHeight ?? 120;
    this.barWidth = config.barWidth ?? 90;
    this.phaseOffsetMs = config.phaseOffsetMs ?? 0;
  }

  /** The phase the timer dictates at `nowMs`, ignoring any forced override. */
  private phaseAt(nowMs: number): HazardPhase {
    const cycle = Math.max(1, this.cycleMs);
    const t = (((nowMs + this.phaseOffsetMs) % cycle) + cycle) % cycle;
    const activeStart = cycle - this.activeMs;
    const telegraphStart = activeStart - this.telegraphMs;
    if (t >= activeStart) return 'active';
    if (t >= telegraphStart) return 'telegraph';
    return 'dormant';
  }

  /** True once the phase visual has been applied at least once (initial latch). */
  private _visualApplied = false;

  update(): void {
    const owner = this.getOwner<Phaser.GameObjects.Sprite & { scene: Phaser.Scene }>();
    const scene = owner.scene as Phaser.Scene;
    const next = this._forced ?? this.phaseAt(scene.time.now);
    // Apply the visual on EVERY phase change AND once on the first tick (the
    // sprite is created before any phase transition, so without the initial
    // application a hazard that boots in its current phase would never get its
    // phase visual — it would render at the sprite's raw default, decoupled from
    // its lethality). After the latch, only changes re-apply (cheap, no churn).
    if (next !== this.phase || !this._visualApplied) {
      this.phase = next;
      this.applyPhaseVisual(owner);
      this._visualApplied = true;
    }
  }

  /**
   * STRUCTURAL INVARIANT — lethal ⟺ visibly telegraphed.
   *
   * Visibility is a pure function of the SAME phase that gates the kill
   * (isActive() drives the collision in BaseLevelScene.spawnCyclicHazard), so the
   * two can never desync:
   *   - ACTIVE (deadly)    → fully OPAQUE + hot tint. If it can kill, you see it.
   *   - TELEGRAPH (warning)→ clearly visible (warning tint) so the deadly window
   *                          is ANNOUNCED before it arrives — the timing read is fair.
   *   - DORMANT (harmless) → HIDDEN (alpha 0). Harmless ⟺ invisible; nothing
   *                          unseen is ever lethal, and a dim ghost can't be
   *                          mistaken for a live threat.
   * A level may override per-phase anims on top; this minimal generic visual
   * holds the invariant with NO real art (placeholder rect) and NO game/theme.
   */
  private applyPhaseVisual(owner: any): void {
    switch (this.phase) {
      case 'dormant':
        // harmless ⟺ invisible (NOT a dim 0.35 ghost — that read as a live threat).
        owner.setVisible?.(false);
        owner.setAlpha?.(1);
        owner.clearTint?.();
        break;
      case 'telegraph':
        // announced: clearly visible warning before the deadly window.
        owner.setVisible?.(true);
        owner.setAlpha?.(0.85);
        owner.setTint?.(0xffd34a);
        break;
      case 'active':
        // deadly ⟹ unmissable: fully opaque + hot tint. Lethal is always seen.
        owner.setVisible?.(true);
        owner.setAlpha?.(1);
        owner.setTint?.(0xff5a3c);
        break;
    }
  }

  /** True iff the hazard is in its deadly window right now. */
  isActive(): boolean {
    return this.phase === 'active';
  }

  /** Force (pin) the phase — for the test harness / a scripted moment. */
  forcePhase(phase: HazardPhase): void {
    this._forced = phase;
    this.phase = phase;
    if (this.isAttached()) this.applyPhaseVisual(this.getOwner());
  }

  /** Release a forced phase; the timer drives the phase again. */
  releasePhase(): void {
    this._forced = null;
  }
}
