/**
 * ============================================================================
 * guidance/GuidanceDriver.ts — the ONE DOM guidance driver (KEEP — engine)
 * ============================================================================
 * The single DOM driver for the in-game guidance layer. It REPLACES the former
 * pair of near-identical drivers (a `Coaching` reading coaching[] + an `Overlay`
 * reading overlays[]): both rendered the SAME `Coachmark` DOM card through the SAME
 * `TriggerEngine`, so they collapse into one driver that reads BOTH lists and
 * renders every entry identically.
 *
 * For each declared entry it registers the entry's reveal trigger (`boundTrigger ??
 * trigger` — the surface-resolved trigger when the author bound one, else the
 * authored trigger) and an optional `dismissOn` with the generic `TriggerEngine`,
 * and on fire reveals/dismisses a `Coachmark` over the canvas host. The trigger
 * engine and the card stay generic — this is the only place that knows a coachmark
 * is the payload.
 *
 * Lifecycle (mirrors the HUD): `mount(host, cfg)` reads the spec + builds the
 * triggers; `start(hook)` baselines on-first/on-event cursors when the world
 * begins; `update(hook)` polls each frame. Absent coaching[]/overlays[] ⇒ the
 * driver is inert (no card, no error) — the additive guarantee, so an existing game
 * with no guidance lists sees zero behavior change.
 *
 * ── EXTENSION POINT (add a future DOM cue type here) ─────────────────────────
 * The DOM cue SOURCES are a small internal list (`CUE_SOURCES`), each `{ read(cfg)
 * => Entry[] }`, looped at mount. To add a NEW DOM guidance component later:
 *   1. add a `read…()` to @contract/teach-spec that returns its entries, and
 *   2. add ONE `{ read }` line to CUE_SOURCES below.
 * Each entry needs only `trigger` (+ optional `boundTrigger`/`dismissOn`) and the
 * `Coachmark` content/style shape. A new component that needs a DIFFERENT card
 * renderer would carry its own render path; the common case (another text card)
 * reuses Coachmark and is purely a new source line. Keep this an obvious,
 * self-contained edit — one new component + one registration line.
 */

import {
  readCoaching,
  readOverlays,
  type CoachingEntry,
  type CoachingTrigger,
} from '@contract/teach-spec';
import type { GameHook } from '@contract/hook-contract';
import { TriggerEngine } from './TriggerEngine';
import { Coachmark } from './Coachmark';

/**
 * One DOM cue entry the driver can render. The shared shape is a `Coachmark`
 * content/style + a reveal `trigger`; overlays additionally carry an author
 * `boundTrigger` (the surface-resolved trigger, preferred when present). Both
 * coaching[] and overlays[] satisfy this — coaching entries simply omit
 * `boundTrigger` and fall back to `trigger`.
 */
type GuidanceEntry = CoachingEntry & { boundTrigger?: CoachingTrigger | null };

/**
 * The DOM cue SOURCES — each reads one declared list off the merged gameConfig and
 * returns its entries (or [] when absent). Looped at mount. ADD a new DOM cue type
 * here (see the EXTENSION POINT note in the header).
 */
const CUE_SOURCES: Array<{ read(cfg: Record<string, unknown>): GuidanceEntry[] }> = [
  { read: (cfg) => readCoaching(cfg) },
  { read: (cfg) => readOverlays(cfg) },
];

type FireKind = { entry: GuidanceEntry; action: 'show' | 'dismiss' };

export class GuidanceDriver {
  private host: HTMLElement | null = null;
  private marks = new Map<GuidanceEntry, Coachmark>();
  private engine: TriggerEngine<FireKind>;
  private started = false;

  constructor() {
    this.engine = new TriggerEngine<FireKind>((payload) => {
      if (payload.action === 'show') this.reveal(payload.entry);
      else this.hide(payload.entry);
    });
  }

  /** Read EVERY cue source off the merged gameConfig + register each entry's triggers. */
  mount(host: HTMLElement, cfg: Record<string, unknown>): void {
    this.host = host;
    for (const source of CUE_SOURCES) {
      for (const entry of source.read(cfg)) {
        // Prefer the surface-resolved trigger the author bound at merge; fall back to
        // the authored trigger (a coaching entry has none; an unresolved boundTrigger
        // is null → use `trigger`).
        const trig = entry.boundTrigger ?? entry.trigger;
        if (!trig) continue;
        this.engine.add(trig, { entry, action: 'show' });
        if (entry.dismissOn) this.engine.add(entry.dismissOn, { entry, action: 'dismiss' });
      }
    }
  }

  /** Baseline on-first/on-event cursors when the world begins (call once, on start). */
  start(hook: GameHook): void {
    if (this.started) return;
    this.started = true;
    this.engine.start(hook);
  }

  /** Poll the triggers each frame (call from the game loop). */
  update(hook: GameHook): void {
    if (!this.started || this.engine.allFired()) return;
    this.engine.update(hook);
  }

  private reveal(entry: GuidanceEntry): void {
    if (!this.host || this.marks.has(entry)) return;
    const mark = new Coachmark(entry.content, entry.style);
    this.marks.set(entry, mark);
    mark.show(this.host);
  }

  private hide(entry: GuidanceEntry): void {
    const mark = this.marks.get(entry);
    if (mark) mark.dismiss();
  }
}
