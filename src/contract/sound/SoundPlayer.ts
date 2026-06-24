/**
 * ============================================================================
 * sound/SoundPlayer.ts  —  the SFX DRIVER (the ONE consumer of sound.sfx[], KEEP)
 * ============================================================================
 * Wires the DATA (`gameConfig.sound.sfx[]`) to audio: for each declared binding it
 * remembers `play this sound when this event fires`, then POLLS the SAME
 * PUSH-channel event seam guidance's TriggerEngine polls (`__GAME__.events`:
 * `recent(sinceSeq)` + `cursor`) and, on the first NEW log entry whose `type`
 * matches a binding's `on`, plays that sound once. This is the single place that
 * knows a sound is the action — the event seam stays generic.
 *
 * PROTOCOL-IDENTICAL to TriggerEngine's `on-event` discipline (DO NOT re-derive):
 * `start()` baselines the cursor at the log head (events before the world started
 * never play); each `update()` reads `events.recent(lastSeenSeq)` ONCE, fires the
 * matching bindings, then advances `lastSeenSeq` past `events.cursor` — so an old
 * entry never re-plays, and we never `.on()`-subscribe (a late-joining poller still
 * sees the buffered history).
 *
 * SINGLE-SOURCED + RENDERER-AGNOSTIC: this lives ONCE in core-contract (imported as
 * `@contract/sound/SoundPlayer`) and is shared verbatim by BOTH engines — exactly
 * like the unified guidance driver. It has NO engine import (no Phaser/Three), only
 * the committed @contract seams (the hook events read-seam + sound-spec), so there
 * is no per-engine copy to keep in sync. The `mountSound` seam (sibling file) is the
 * single mount point every main.ts calls.
 *
 * ADDITIVE + GRACEFUL: absent `sound.sfx[]` ⇒ readSfx returns [] ⇒ the driver
 * registers nothing, `start`/`update` early-exit (the additive guarantee — a game
 * with no sound[] is unchanged). An unavailable/undecodable sound ⇒ a silent
 * no-op (the play promise rejection is swallowed), never a throw — a sound cue
 * must never crash the frame loop (mirrors guidance + safeAddSound).
 *
 * DEPENDENCY-FREE: plays via the standard HTML5 Audio element off a resolved URL —
 * no engine import (no Phaser/Three), only the committed @contract seams (the hook
 * events read-seam + sound-spec). The asset base path is configurable
 * (`mount(cfg, audioBase?)`); it defaults to the conventional public audio root so
 * the driver is correct before any Preloader/vendoring wiring lands (deferred).
 */

import { readSfx, type SfxBinding } from '@contract/sound-spec';
import type { GameHook, LoggedEvent } from '@contract/hook-contract';

/** semitone offset → playbackRate (2^(semitones/12)); +12 = one octave = rate 2. */
function semitonesToRate(semitones: number | undefined): number {
  return semitones ? Math.pow(2, semitones / 12) : 1;
}

export class SoundPlayer {
  /** event name (`on`) → the bindings that play on it (a moment may play >1). */
  private byEvent = new Map<string, SfxBinding[]>();
  /** Resolved public-relative base for sound files (e.g. 'assets/' or 'audio/_sfx/'). */
  private audioBase = '';
  /**
   * The highest event-log seq already consumed — bindings only ever see entries
   * with `seq > lastSeenSeq`, and the cursor advances past every entry inspected
   * each poll (poll-don't-subscribe, play-once-per-new-entry).
   */
  private lastSeenSeq = 0;
  private started = false;

  /**
   * Read the sfx spec off the merged gameConfig + index it by event name. `audioBase`
   * is the public-relative prefix prepended to a binding's resolved file (default ''
   * ⇒ files resolve relative to the document); a project wires its real assets root
   * here when the vendoring/Preloader pass lands (deferred).
   */
  mount(cfg: Record<string, unknown>, audioBase = ''): void {
    this.audioBase = audioBase;
    for (const b of readSfx(cfg)) {
      if (!b || typeof b.on !== 'string' || typeof b.play !== 'string') continue;
      const list = this.byEvent.get(b.on);
      if (list) list.push(b);
      else this.byEvent.set(b.on, [b]);
    }
  }

  /** Baseline the event cursor when the world begins (call once, on start). */
  start(hook: GameHook): void {
    if (this.started) return;
    this.started = true;
    // Events emitted BEFORE the world started never play an sfx (absent log ⇒ 0).
    this.lastSeenSeq = hook.events?.cursor ?? 0;
  }

  /** Poll the event log each frame; play the sounds whose event just fired (call from the loop). */
  update(hook: GameHook): void {
    if (!this.started || this.byEvent.size === 0) return;
    // Read the NEW entries once per poll (those past our cursor), then advance the
    // cursor to the head AFTER playing — every new entry is inspected exactly once.
    const fresh: ReadonlyArray<LoggedEvent> = hook.events?.recent(this.lastSeenSeq) ?? [];
    for (const e of fresh) {
      const bindings = this.byEvent.get(e.type);
      if (bindings) for (const b of bindings) this.play(b);
    }
    const head = hook.events?.cursor;
    if (typeof head === 'number' && head > this.lastSeenSeq) this.lastSeenSeq = head;
  }

  /** Play one binding's sound once — a GRACEFUL no-op if the asset is unavailable. */
  private play(b: SfxBinding): void {
    try {
      const audio = new Audio(this.resolve(b.play));
      audio.volume = clampVolume(b.volume);
      audio.playbackRate = semitonesToRate(b.semitones);
      // play() returns a promise that REJECTS on a missing/undecodable file or a
      // not-yet-gesture-unlocked context — swallow it so a cue never crashes the loop.
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* a sound cue must never crash the frame loop */
    }
  }

  /** Resolve a registry sound key to a URL under the configured audio base. */
  private resolve(key: string): string {
    // The key is the registry key (e.g. 'pop'); the project's wiring maps keys → files.
    // Until that mapping is wired (deferred), resolve `<base><key>.wav` — the kit's
    // file naming. A project may override by wiring audioBase to its assets root.
    return `${this.audioBase}${key}.wav`;
  }
}

/** Clamp a volume override to [0,1]; absent ⇒ 1 (the element default; registry default applies upstream). */
function clampVolume(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
