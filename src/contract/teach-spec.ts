/**
 * ============================================================================
 * teach-spec.ts  —  the CoachingEntry shape (DATA, engine-agnostic, no import)
 * ============================================================================
 * The contract half of the in-game TEACHING layer — the player-facing prompting
 * capability that tells a player HOW TO PLAY and WHAT THE GOAL IS. It is the
 * sibling of `hud-spec.ts`: hud-spec declares the STANDING readout (the chips +
 * the objective panel that persist), this declares the TIMED, transient teaching
 * prompts (a control-teach hint shown on the first relevant moment, an intro
 * objective banner that fades, a contextual tip). Pure DATA — both engines RENDER
 * + TIME it their own way (the 3D DOM `Coachmark` + `Coaching` driver today; a 2D
 * impl later), so the WHAT-to-teach + WHEN decision lives here while the
 * HOW-to-draw stays in each engine's impl.
 *
 * GENERIC across any game (anti-reward-hack / one-canonical-home): the trigger
 * comparators and the content shape hold for ANY archetype — the only
 * game-specific thing is the `coaching[]` DATA a blueprint declares. There is NO
 * game noun in this file.
 *
 * The blueprint binds an additive optional `guidance.coaching[]` block (each entry =
 * `{ trigger, content, style? }`); W2 projects the whole `guidance` section verbatim
 * into `gameConfig.guidance` (exactly like `shell`); the engine reads
 * `gameConfig.guidance.coaching` and drives each coachmark through the trigger engine.
 */

/**
 * A data-driven TRIGGER: a `condition` evaluated at a TIMING against the live
 * `window.__GAME__` oracle. GENERIC + reusable beyond teaching (a spawn cue, an
 * objective change), which is why it carries no coachmark-specific field. The
 * `at` discriminant selects which fields are read:
 *
 *   on-ready                — fires once, on the first frame __GAME__.ready latches.
 *   after-delay  + delayMs  — fires once, `delayMs` ms after the world started.
 *   on-first     + event    — fires once, the first time an observable signals the
 *                             event (e.g. the first mine: `selectedBlock`/`inventory`
 *                             changes; first move: `player.position` changes; first
 *                             place: `worldBlockCount` rises). Declared GENERICALLY
 *                             as an observable + the kind of change to watch for.
 *   on-state + observable
 *            + comparator
 *            + value         — fires once when a numeric/boolean __GAME__ field
 *                             crosses a threshold (e.g. worldBlockCount >= 30).
 *   on-milestone + milestone — fires once when __GAME__ reports the named milestone
 *                             reached (a hook a game may expose; absent ⇒ never fires).
 *   on-event + eventName    — fires once on the first NEW log entry whose `type`
 *                             matches `eventName`, read off the PUSH-channel event
 *                             log (`__GAME__.events`). POLLED, not subscribed: the
 *                             engine advances a per-instance cursor so an old entry
 *                             never re-fires. Absent log (a game that folds no bus)
 *                             ⇒ never fires (the documented absent-signal contract).
 */
export interface CoachingTrigger {
  at: 'on-ready' | 'after-delay' | 'on-first' | 'on-state' | 'on-milestone' | 'on-event';
  /** ms after start (at === 'after-delay'). */
  delayMs?: number;
  /**
   * The __GAME__ observable this trigger watches (at === 'on-first' | 'on-state').
   * A dot-path the oracle exposes (e.g. 'player.position', 'worldBlockCount',
   * 'inventory', 'selectedBlock'). No game noun — the observable comes from the data.
   */
  observable?: string;
  /**
   * What change on `observable` counts as the event (at === 'on-first'). 'changes'
   * = ANY change from the value at start (the default — first move / first cycle);
   * 'increases' / 'decreases' = a first rise/fall (first place ⇒ worldBlockCount
   * increases; first mine ⇒ worldBlockCount decreases). Defaults to 'changes'.
   */
  change?: 'changes' | 'increases' | 'decreases';
  /** Comparator + value for at === 'on-state' (e.g. comparator:'atLeast', value:30). */
  comparator?: 'atLeast' | 'atMost' | 'equals' | 'increases' | 'decreases' | 'changes';
  /** The threshold for at === 'on-state' comparator. */
  value?: number | string | boolean;
  /** The milestone id for at === 'on-milestone'. */
  milestone?: string;
  /**
   * The event name to match for at === 'on-event' — a `type` on the PUSH-channel
   * event log (e.g. 'weapon.fired', 'score.changed'). Fires once on the first NEW
   * log entry of this type. Absent ⇒ the on-event trigger never matches.
   */
  eventName?: string;
  /**
   * ALIAS for `eventName`. The blueprint/author schema names this field `event`
   * (guidanceTrigger.event), and W2 projects the whole `guidance` section into
   * gameConfig VERBATIM — so an authored on-event cue arrives with `event`, not
   * `eventName`. The engine reads `eventName ?? event`, so EITHER key fires (without
   * this alias an authored `event:` cue is silently inert). Accepts both; authors may
   * use either.
   */
  event?: string;
}

/** The player-facing CONTENT of one coachmark (theme/copy — the only game data). */
export interface CoachingContent {
  /** Optional short heading (e.g. 'How to play', 'Goal'). */
  title?: string;
  /** The teaching body — one short instruction line (e.g. 'Hold left-click to mine'). */
  body?: string;
  /**
   * Optional key/control rows — each `{ keys, label }` renders a labeled key cap
   * (e.g. { keys: 'WASD', label: 'move' }). The GENERIC way to teach a control set
   * legibly; `keys` is a display string, never wired to input (the controls are the
   * game's own). Omitted ⇒ a plain body-only tip.
   */
  controls?: Array<{ keys: string; label: string }>;
}

/** Optional presentation hints for one coachmark (generic — never a game string). */
export interface CoachingStyle {
  /**
   * Where the card sits over the canvas. 'center' (a modal intro), 'top',
   * 'bottom' (a non-intrusive banner that never blocks the crosshair). Default
   * 'bottom'.
   */
  placement?: 'center' | 'top' | 'bottom';
  /**
   * Tone: 'panel' (the prominent intro card) or 'tip' (a slim contextual hint).
   * Default 'tip'.
   */
  tone?: 'panel' | 'tip';
  /**
   * Auto-dismiss after this many ms (a timed fade-out). 0 / absent ⇒ stays until
   * its own `dismissOn` trigger fires (or forever, for a persistent banner).
   */
  durationMs?: number;
}

/** One declared coachmark (the blueprint→teaching contract, projected into gameConfig). */
export interface CoachingEntry {
  /** Stable id (diagnostics; also the de-dupe key so an entry shows at most once). */
  id?: string;
  /** WHEN to reveal this coachmark. */
  trigger: CoachingTrigger;
  /** The player-facing content (the only game-specific data). */
  content: CoachingContent;
  /** Optional presentation hints. */
  style?: CoachingStyle;
  /** OPTIONAL: a second trigger that DISMISSES this coachmark early (e.g. on first move, hide the move hint). */
  dismissOn?: CoachingTrigger;
}

/**
 * Read the declared coaching list off the merged gameConfig. Generic: returns the
 * `guidance.coaching[]` array verbatim (the blueprint→gameConfig projection), or []
 * when none is declared — absent ⇒ no coachmarks, no error (the additive guarantee).
 */
export function readCoaching(cfg: Record<string, unknown>): CoachingEntry[] {
  const g = cfg.guidance as Record<string, unknown> | undefined;
  return Array.isArray(g?.coaching) ? (g!.coaching as CoachingEntry[]) : [];
}

/**
 * One declared text OVERLAY (the Guidance producer's `overlays[]`). RENDER-identical
 * to a coachmark (same content/style → the same DOM card), so it extends CoachingEntry;
 * it ADDS the author's merge-time binding fields. The driver fires `boundTrigger ?? trigger`
 * (the surface-resolved trigger when present, else the authored one).
 */
export interface OverlayEntry extends CoachingEntry {
  /** The human GDD phrase the author bound from (diagnostics only). */
  abstractTrigger?: string;
  /** The surface-resolved trigger; preferred over `trigger` when present (null ⇒ unresolved). */
  boundTrigger?: CoachingTrigger | null;
}

/**
 * Read the declared overlay list off the merged gameConfig. Generic: returns
 * `guidance.overlays[]` verbatim, or [] when none — absent ⇒ no overlays, no error
 * (the additive guarantee, exactly like readCoaching).
 */
export function readOverlays(cfg: Record<string, unknown>): OverlayEntry[] {
  const g = cfg.guidance as Record<string, unknown> | undefined;
  return Array.isArray(g?.overlays) ? (g!.overlays as OverlayEntry[]) : [];
}

/**
 * One declared diegetic WORLD-CUE (the Guidance producer's `worldCues[]`). UNLIKE a
 * coachmark/overlay (a screen-anchored DOM card), a world-cue is an IN-WORLD marker
 * placed at a target ENTITY's live position — so it carries `targetEntity` (a surface
 * entity id) + a `cueKind`, and the RENDERER is scene-side (it needs the live sprite
 * position), not a DOM driver. Inert when none is declared (the additive guarantee).
 */
export interface WorldCueEntry {
  /** Stable id (diagnostics; also the de-dupe key). */
  id?: string;
  /** The surface ENTITY id this cue points at — its live world position is the anchor. */
  targetEntity: string;
  /** The cue's visual kind (a hint; the scene renderer picks the marker). */
  cueKind?: 'arrow' | 'marker' | 'beacon' | 'path-hint';
  /** WHEN to reveal the cue (same trigger vocabulary as coaching). */
  trigger: CoachingTrigger;
  /** The surface-resolved trigger; preferred over `trigger` when present. */
  boundTrigger?: CoachingTrigger | null;
  /** Optional short label rendered with the marker. */
  content?: { body?: string };
  /** Optional presentation hints (durationMs ⇒ a timed auto-hide). */
  style?: CoachingStyle;
  /** Optional early-removal trigger. */
  dismissOn?: CoachingTrigger;
}

/**
 * Read the declared world-cue list off the merged gameConfig. Generic: returns
 * `guidance.worldCues[]` verbatim, or [] when none — absent ⇒ no cues, no error.
 */
export function readWorldCues(cfg: Record<string, unknown>): WorldCueEntry[] {
  const g = cfg.guidance as Record<string, unknown> | undefined;
  return Array.isArray(g?.worldCues) ? (g!.worldCues as WorldCueEntry[]) : [];
}
