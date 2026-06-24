/**
 * ============================================================================
 * hook-contract.ts  —  THE ENGINE-AGNOSTIC ORACLE CONTRACT (no engine import)
 * ============================================================================
 *
 * The PUBLIC SHAPE of `window.__GAME__` — the immutable, anti-reward-hack
 * oracle every archetype (2D Phaser today, 3D Three.js later) populates and the
 * `packages/verify/` harness reads. This file holds ONLY the contract:
 *   - the normalized `GameStatus` enum,
 *   - the `GameHook` / `HookPlayer` / `HookEntity` interfaces,
 *   - the status-normalization rule (flag + ready → status),
 *   - the legal-status-transition predicate.
 *
 * It has NO engine dependency (no Phaser, no Three.js): a per-engine adapter
 * (`core/src/hook.ts` for Phaser) IMPORTS these types and the rule, then reads
 * its engine's live state INTO this shape. Relocating the shape here (out of the
 * Phaser adapter) is what makes the oracle renderer-agnostic — the shape is the
 * SAME across engines, so a 3D adapter populates the identical contract and the
 * verify harness needs no change.
 *
 * IMMUTABLE: this shape + the status semantics are the oracle's anti-gaming
 * surface. Relocate it, never change it.
 */

// ── normalized status enum ──────────────────────────────────────────────────
export type GameStatus = 'booting' | 'playing' | 'won' | 'lost';

// ── the public shapes W5 observes (template-contract §3.2) ──────────────────
export interface HookPlayer {
  x: number;
  y: number;
  vx: number;
  vy: number;
  health: number;
  maxHealth: number;
  // grid_logic:
  gridX?: number;
  gridY?: number;
  // platformer / top_down extras:
  facingDirection?: 'left' | 'right';
  isDead?: boolean;
  isGrounded?: boolean;
}

export interface HookEntity {
  id: string;
  type: string;
  x: number;
  y: number;
  gridX?: number;
  gridY?: number;
}

/**
 * One entry in the event log — the external observation surface for the PUSH
 * channel (guidance / the verify harness / replay poll it). Append-only,
 * frame-tagged, monotonic-`seq` (the stable total order for replay), with a lean
 * JSON-serializable payload (IDs + primitives only — never a live class instance).
 */
export interface LoggedEvent {
  /** The frame the scene had stamped on the bus when this event was emitted. */
  frame: number;
  /** Monotonic publish counter — the stable total order across the whole run. */
  seq: number;
  /** The hierarchical event name, e.g. 'weapon.fired' | 'score.changed'. */
  type: string;
  /** The lean, JSON-serializable payload (IDs/primitives), or undefined. */
  payload?: unknown;
}

export interface GameHook {
  ready: boolean;
  status: GameStatus;
  scene: string | null;
  score: number;
  player: HookPlayer | null;
  entities: HookEntity[];

  // archetype extras (present only when meaningful; undefined otherwise)
  /**
   * The ENGINE-ACCUMULATED score ceiling: the exact Σ of the placed reward
   * values, totalled by the code that PLACES the rewards (via
   * `@contract/score` `registerScorable`), NEVER an authored constant. The HUD
   * ("X / maxScore") and the bounded score assertion ("score atMost maxScore")
   * read THIS. 0 before any scorable is placed (a non-scoring game leaves the
   * `maxScore` registry key 0).
   */
  maxScore?: number;
  moveCount?: number;
  maxMoves?: number;
  gold?: number;
  lives?: number;
  waveIndex?: number;
  playerHP?: number;
  enemyHP?: number;
  phase?: string;
  timeRemaining?: number; // failModel:'time': seconds left on the level countdown

  // ── guidance-trigger surface (additive; Contract 4 runtime-exposure) ────────
  // These exist so an authored guidance cue binds to a REAL handle instead of a
  // phantom. They are OPTIONAL extras (same status as moveCount/phase): a game
  // that drives none of them simply leaves them undefined, and the trigger that
  // would read them never fires — never an error.
  /**
   * Monotone list of milestone ids the build has reached, in order. The
   * `on-milestone` trigger fires when this includes the named milestone. The
   * build appends an id at the real milestone-reached point (no design latitude:
   * the ids are the blueprint's `milestones[].id`). Absent ⇒ on-milestone never
   * fires (the documented absent-signal contract).
   */
  milestonesReached?: string[];
  /**
   * A monotone counter for each RECOVERABLE reset (e.g. a non-terminal respawn).
   * Gives a "first bite / nth death" cue something to bind to via `on-first`
   * (increases) when `status` stays 'playing'. Absent ⇒ no recoverable-reset
   * signal (the cue falls back to a coordinate-change approximation).
   */
  respawnCount?: number;

  /**
   * Resolve a named entity's live world position by its blueprint id (the same
   * id `entities[].id` carries). The GENERIC accessor a worldCue / proximity cue
   * uses to point at "treehouse" without a renderer or a raw-coordinate literal.
   * Returns null when no live entity carries that id. A pure read over the same
   * `entities[]` surface — no new state, no anti-gaming exposure. OPTIONAL (an
   * additive extra like the others): an adapter that has not implemented it leaves
   * it undefined and a caller reads it defensively.
   */
  entityPos?(id: string): { x: number; y: number } | null;

  /**
   * The PUSH-channel read seam: a bounded, frame-tagged event log the bus
   * mirrors every emit into (the EventBus tap). External consumers — guidance's
   * `on-event` triggers, the verify harness, replay — POLL it each frame; they
   * never `.on()`-subscribe (a late-joining poller still sees the buffered
   * history). OPTIONAL (same status as moveCount/phase): an archetype that does
   * not fold a bus onto __GAME__ leaves it undefined and an `on-event` trigger
   * simply never fires — never an error. Read defensively (`hook.events?.…`).
   */
  events?: {
    /** Every logged entry with `seq > sinceSeq` (or all when omitted), oldest→newest. */
    recent(sinceSeq?: number): ReadonlyArray<LoggedEvent>;
    /** The latest stamped seq (0 before any emit). */
    readonly cursor: number;
  };

  /**
   * READ-ONLY runtime DEBUG surface — the STRUCTURAL truth a behavioral
   * snapshot can't show. Archetype-agnostic (the seams are generic) and
   * JSON-serializable: every field reads the live scene defensively and an
   * absent seam yields an empty/zero value, NEVER an exception, NEVER a raw
   * Phaser object. It is for DIAGNOSIS only — it is NOT an assertion target a
   * milestone can game (kept OUT of the anti-gaming surface). A
   * `systemIdCounts` value > 1 IS a duplicate-system bug (the
   * minification-mangled duplicate-BrickGrid signature); a non-empty
   * `duplicateEntityIds` is the duplicated-sprite (e.g. 90-brick wall)
   * signature. OPTIONAL (additive, same status as the other extras): an
   * adapter that does not implement it leaves it undefined and a caller reads
   * it defensively.
   */
  debug?: GameDebug;

  snapshot(): Record<string, unknown>;
  commands: {
    reset(): void;
    seed(n: number): void;
    setState(patch: Record<string, unknown>): void;
  };
}

/**
 * The READ-ONLY runtime debug surface (window.__GAME__.debug). A NAMED type (not an
 * inline literal on GameHook) so the registry's GameHook field-discovery does not flatten
 * its members into spurious "observables" — debug is a diagnostic seam, not a bindable
 * capability (like snapshot/commands/events, it is skipped by observable discovery).
 */
export interface GameDebug {
  /** The active level scene key, or null when no level scene is running. */
  scene: string | null;
  /** The active scene's system roster — `(scene.systems ?? []).map(s => ({ id }))`. [] if none. */
  systems: { id: string }[];
  /** id -> count across the roster; a value > 1 IS a duplicate-system bug. */
  systemIdCounts: Record<string, number>;
  /** `entities.length` — the live gameplay entity count. */
  entityCount: number;
  /** entity `type` -> count across `entities`. */
  entityTypeCounts: Record<string, number>;
  /** entity ids appearing more than once across the groups (the dup-sprite signature). */
  duplicateEntityIds: string[];
}

// ── status-normalization rule (engine-agnostic) ─────────────────────────────

/**
 * The single rule that normalizes a raw status flag + the ready latch into the
 * public `GameStatus`. The per-engine adapter reads its own flag/latch and calls
 * this so EVERY engine reports status identically:
 *   - an explicit terminal/active flag ('won'|'lost'|'playing') wins;
 *   - otherwise 'playing' once ready has latched, else 'booting'.
 */
export function normalizeStatus(
  flag: GameStatus | string | undefined,
  ready: boolean,
): GameStatus {
  if (flag === 'won' || flag === 'lost' || flag === 'playing') return flag;
  return ready ? 'playing' : 'booting';
}

// ── legal-status-transition predicate (engine-agnostic) ─────────────────────

/**
 * The legal `GameStatus` transitions. A status moves forward through the boot →
 * play → terminal lifecycle; a terminal state (won/lost) may only be left by a
 * RESET back to 'playing' (the `commands.reset` seam). A self-transition (no
 * change) is always legal.
 */
const LEGAL_STATUS_TRANSITIONS: Record<GameStatus, readonly GameStatus[]> = {
  booting: ['booting', 'playing'],
  playing: ['playing', 'won', 'lost'],
  won: ['won', 'playing'],
  lost: ['lost', 'playing'],
};

/** True iff `from → to` is a legal status transition (a no-op is legal). */
export function isLegalStatusTransition(
  from: GameStatus,
  to: GameStatus,
): boolean {
  if (from === to) return true;
  return LEGAL_STATUS_TRANSITIONS[from].includes(to);
}
