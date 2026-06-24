/**
 * ============================================================================
 * sound-spec.ts  —  the SfxBinding shape (DATA, engine-agnostic, no import)
 * ============================================================================
 * The contract half of the in-game SOUND/SFX layer — the player-facing AUDIO
 * FEEDBACK capability that plays a short one-shot when a gameplay MOMENT fires.
 * It is the sibling of `teach-spec.ts`: teach-spec declares the TIMED teaching
 * prompts, this declares the EVENT-TRIGGERED sound effects. Pure DATA — the
 * single-sourced, renderer-agnostic `@contract/sound/SoundPlayer` (shared verbatim
 * by both engines, like the unified guidance driver) PLAYS it off the SAME event
 * seam, so the WHAT-to-play + ON-WHICH-event decision lives here while the
 * HOW-to-play stays in the one SoundPlayer.
 *
 * GENERIC across any game (anti-reward-hack / one-canonical-home): the binding
 * shape holds for ANY archetype — the only game-specific thing is the `sfx[]`
 * DATA a blueprint declares. There is NO game noun in this file.
 *
 * THE EVENT SEAM (mirror guidance — DO NOT re-derive). The SoundPlayer POLLS the
 * SAME PUSH-channel read seam guidance's TriggerEngine polls: `__GAME__.events`
 * (`recent(sinceSeq): LoggedEvent[]` + `cursor`). A binding's `on` is matched
 * against the `type` of each new logged event — exactly the `on-event` discipline
 * in teach-spec/TriggerEngine. One event name therefore joins TWO independent
 * consumers: guidance (a coachmark) and sound (an sfx). They never touch each
 * other; the shared event name is the only coupling.
 *
 * THE PRODUCE SEAM (the creation contract — RESOLVE against the catalog). The Sound
 * producer keys each `on` off the game's GENERATED EVENT CATALOG — the surface()-derived
 * `events.catalog.json` (sibling of capabilities.json), the OPEN/DERIVED vocabulary of
 * every event the bound components ACTUALLY emit on the bus (base ∪ archetype ∪ each
 * bound capability ∪ `custom[].emits[]`). It is NOT `effects[].on`: that is the COSMETIC
 * channel (the fireEffect direct-call), which is never mirrored to the bus, so a binding
 * keyed off it would be DEAD. An `on` that does not RESOLVE in the catalog is a contract
 * GAP the producer self-reports (surfaceExposed:false), never an invented event name.
 *
 * The blueprint binds an additive optional `sound.sfx[]` block (each entry =
 * `{ id, on, play, volume?, semitones? }`); W2 projects the whole `sound` section
 * verbatim into `gameConfig.sound` (exactly like `guidance`); each engine reads
 * `gameConfig.sound.sfx` and plays each binding on its event.
 */

/**
 * One declared SFX binding (the blueprint→sound contract, projected into gameConfig).
 * When the runtime event named `on` fires on the bus, the SoundPlayer plays the
 * registry sound `play` once. Additive + graceful: an unavailable sound is a
 * no-op, never a throw (the shared SoundPlayer guards playback).
 */
export interface SfxBinding {
  /** Stable id (diagnostics; also the de-dupe key so a binding registers at most once). */
  id?: string;
  /**
   * The runtime EVENT name to play on — matched against the `type` of each new
   * `__GAME__.events` log entry (the `on-event` poll seam). It MUST RESOLVE in the
   * game's GENERATED EVENT CATALOG (events.catalog.json — the surface()-derived
   * vocabulary of events the bound components really emit on the bus, ∪
   * `custom[].emits[]`); NOT `effects[].on`, which is the cosmetic fireEffect channel
   * the bus never carries. The producer records whether it resolved
   * (couplingToGameplay.surfaceExposed). Absent log / no matching event ⇒ this binding
   * simply never plays — never an error.
   */
  on: string;
  /**
   * The SOUND KEY to play — a key the sound registry resolves
   * (packages/skills/sound-author/sound-registry.json, the @studio/sound-kit
   * vocabulary). An unresolved/unloaded key ⇒ a graceful no-op (the engine's
   * SoundPlayer checks availability before playing).
   */
  play: string;
  /** OPTIONAL linear-peak volume override (0..1). Absent ⇒ the engine/registry default. */
  volume?: number;
  /**
   * OPTIONAL pitch shift in semitones (e.g. a rising +2 per count step). 0/absent
   * ⇒ no shift. The engine maps it to a playbackRate (2^(semitones/12)).
   */
  semitones?: number;
  /**
   * OPTIONAL coupling self-report the producer fills (mirrors guidance): whether
   * `on` resolved in the event vocabulary. DATA the design gate reads; the runtime
   * SoundPlayer ignores it.
   */
  couplingToGameplay?: { needs?: string; surfaceExposed?: boolean; kind?: string };
}

/** The game's overall SONIC DIRECTION (the audio analog of meta.artStyle). Producer-only metadata. */
export interface SoundPath {
  /** A short name for the sound direction (e.g. 'crisp arcade'). */
  name?: string;
  /** The emotional register (e.g. 'playful'). */
  mood?: string;
  /** The sonic character (e.g. 'bright digital pops'). */
  character?: string;
}

/**
 * Read the declared sfx list off the merged gameConfig. Generic: returns the
 * `sound.sfx[]` array verbatim (the blueprint→gameConfig projection), or [] when
 * none is declared — absent ⇒ no sfx, no error (the additive guarantee, exactly
 * like readCoaching).
 */
export function readSfx(cfg: Record<string, unknown>): SfxBinding[] {
  const s = cfg.sound as Record<string, unknown> | undefined;
  return Array.isArray(s?.sfx) ? (s!.sfx as SfxBinding[]) : [];
}
