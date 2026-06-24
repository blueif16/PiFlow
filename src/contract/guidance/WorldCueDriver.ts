/**
 * ============================================================================
 * guidance/WorldCueDriver.ts — the renderer-agnostic WORLD-CUE driver (KEEP — engine)
 * ============================================================================
 * The scene-side sibling of the DOM `GuidanceDriver`. A coaching tip / overlay is a
 * screen-anchored DOM card; a WORLD-CUE is an IN-WORLD marker pinned to a target
 * ENTITY's live position (a "go here" beacon over the goal, a marker on the next
 * objective). So it CANNOT be a DOM driver — it needs the live entity position,
 * which only the scene has.
 *
 * RENDERER-AGNOSTIC: this driver imports NO engine. The two engine-specific pieces
 * are INJECTED at construction — an `EntityResolver` (id → live {x,y}) and a
 * `MarkerFactory` (entry → a `CueMarker` the driver positions/shows/destroys). A
 * 2D scene injects a Phaser marker factory (`makePhaserMarkerFactory`); a 3D scene
 * would inject a Three marker factory when it needs world cues. The driver owns the
 * generic trigger + follow loop; the per-engine code is ONLY the marker.
 *
 * Reuses the generic `TriggerEngine` (the SAME trigger vocabulary as coaching).
 * INERT when no worldCues[] are declared — the additive guarantee.
 */

import { readWorldCues, type WorldCueEntry } from '@contract/teach-spec';
import type { GameHook } from '@contract/hook-contract';
import { TriggerEngine } from './TriggerEngine';

/** A resolved entity target — a live world position + an optional active flag. */
export interface CueTarget {
  x: number;
  y: number;
  active?: boolean;
}

/** Resolve a surface entity id to its live position (or undefined ⇒ not found). */
export type EntityResolver = (id: string) => CueTarget | undefined;

/**
 * An in-world marker the driver controls. The engine-specific factory builds it; the
 * driver only positions / shows / destroys it through this minimal interface (so the
 * driver itself stays free of any renderer type).
 */
export interface CueMarker {
  setPosition(x: number, y: number): void;
  setVisible(v: boolean): void;
  destroy(): void;
}

/** Build a `CueMarker` for one cue entry (the ONLY per-engine world-cue code). */
export type MarkerFactory = (entry: WorldCueEntry) => CueMarker;

type FireKind = { entry: WorldCueEntry; action: 'show' | 'dismiss' };

export class WorldCueDriver {
  private entries: WorldCueEntry[] = [];
  private active = new Map<WorldCueEntry, CueMarker>();
  private engine: TriggerEngine<FireKind>;
  private started = false;

  constructor(
    private readonly resolve: EntityResolver,
    private readonly makeMarker: MarkerFactory,
  ) {
    this.engine = new TriggerEngine<FireKind>((payload) => {
      if (payload.action === 'show') this.reveal(payload.entry);
      else this.hide(payload.entry);
    });
  }

  /** Read the worldCues spec off the merged gameConfig + register every trigger. */
  mount(cfg: Record<string, unknown>): void {
    this.entries = readWorldCues(cfg);
    for (const entry of this.entries) {
      // Prefer the surface-resolved trigger the author bound at merge; fall back to
      // the authored trigger (an unresolved boundTrigger is null → use `trigger`).
      const trig = entry.boundTrigger ?? entry.trigger;
      if (!trig) continue;
      this.engine.add(trig, { entry, action: 'show' });
      if (entry.dismissOn) this.engine.add(entry.dismissOn, { entry, action: 'dismiss' });
    }
  }

  /** Baseline triggers when the world begins (call once, on the first ready frame). */
  start(hook: GameHook): void {
    if (this.started) return;
    this.started = true;
    this.engine.start(hook);
  }

  /** Poll the triggers + re-pin each live marker to its entity (call from update()). */
  update(hook: GameHook): void {
    if (!this.started) return;
    this.engine.update(hook);
    for (const [entry, marker] of this.active) {
      const tgt = this.resolve(entry.targetEntity);
      if (!tgt || tgt.active === false) {
        marker.setVisible(false);
        continue;
      }
      marker.setVisible(true);
      marker.setPosition(tgt.x, tgt.y);
    }
  }

  private reveal(entry: WorldCueEntry): void {
    if (this.active.has(entry)) return;
    const marker = this.makeMarker(entry);
    const tgt = this.resolve(entry.targetEntity);
    // Position at the resolved entity; the factory may fall back to a screen-center
    // default when the target is unresolved at reveal time (the next update() re-pins
    // it once the entity resolves).
    if (tgt) marker.setPosition(tgt.x, tgt.y);
    this.active.set(entry, marker);
    const dur = entry.style?.durationMs ?? 0;
    if (dur > 0) setTimeout(() => this.hide(entry), dur);
  }

  private hide(entry: WorldCueEntry): void {
    const marker = this.active.get(entry);
    if (marker) {
      marker.destroy();
      this.active.delete(entry);
    }
  }
}
