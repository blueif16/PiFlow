/**
 * ============================================================================
 * score.ts  —  SCORE-REGISTRY SEMANTICS + placeholder-floor diagnostic
 * ============================================================================
 * The engine-agnostic CONTRACT half of `core/src/utils.ts`: the score/registry
 * semantics that `window.__GAME__.score` reads, plus the placeholder-floor dev
 * diagnostic. Both are defined over a STRUCTURAL host type (no Phaser import), so
 * every engine's `utils.ts` can re-export them and bring only its own
 * engine-specific texture/audio helpers.
 *
 * The score is held on a key/value registry (the SINGLE source `__GAME__.score`
 * reads) and a 'scoreChanged' event is emitted for the HUD. The host below
 * captures exactly that surface — a Phaser.Scene satisfies it structurally, and
 * so does any 3D scene that exposes the same `registry` + `game.events`.
 *
 * The score CEILING (`maxScore`) is OWNED HERE too, and is ENGINE-ACCUMULATED —
 * NEVER an authored constant. The code that PLACES a scorable is the only thing
 * that totals it: a scorable-placing system calls `registerScorable(host, value)`
 * once per reward it places, which adds that reward's point value to a running
 * `maxScore` registry key. So `maxScore` is the exact Σ of the real placed reward
 * values — no LLM (W1 or HARDEN) ever computes the integer. `__GAME__.maxScore`
 * reads this registry key, so the HUD ("X / maxScore") and the bounded score
 * assertion ("score atMost maxScore") both resolve the engine-derived total.
 */

// ── the structural host the score helpers need (no engine import) ───────────
export interface ScoreRegistry {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface ScoreEventEmitter {
  emit(event: string, ...args: unknown[]): void;
}

/** The minimal host surface `setScore`/`addScore` read — Phaser.Scene satisfies it. */
export interface ScoreHost {
  registry: ScoreRegistry;
  game: { events: ScoreEventEmitter };
}

// ── score / registry helpers (the single source __GAME__.score reads) ───────

/**
 * Set the score on the registry (the single source `__GAME__.score` reads)
 * and emit a 'scoreChanged' event the HUD can listen to.
 */
export function setScore(host: ScoreHost, value: number): void {
  host.registry.set('score', value);
  host.game.events.emit('scoreChanged', value);
}

/**
 * Add to the registry score and return the new total.
 */
export function addScore(host: ScoreHost, delta: number): number {
  const next = ((host.registry.get('score') as number) ?? 0) + delta;
  setScore(host, next);
  return next;
}

// ── maxScore: ENGINE-ACCUMULATED ceiling (Σ of placed reward values) ─────────

/**
 * Register one placed scorable's point value — the ONLY way `maxScore` grows.
 * The system that PLACES rewards calls this once per reward it places (with that
 * reward's per-collect value), so the running `maxScore` registry key is the exact
 * Σ of the real reward values in the live layout. NO LLM totals the score — the
 * code that places the rewards does. Returns the new running `maxScore`.
 *
 * Idempotent-by-construction at the call site: a placing system registers each
 * reward exactly once (at placement / attach), so a re-attach that re-places the
 * same rewards must `resetMaxScore` first (mirrors the score `reset()` seam).
 */
export function registerScorable(host: ScoreHost, value: number): number {
  if (!Number.isFinite(value)) return getMaxScore(host);
  const next = getMaxScore(host) + value;
  host.registry.set('maxScore', next);
  return next;
}

/** Read the engine-accumulated score ceiling (0 before any scorable is placed). */
export function getMaxScore(host: ScoreHost): number {
  const v = host.registry.get('maxScore');
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Zero the running ceiling — called by a scorable-placing system's `reset()` (the
 * true level-restart seam) BEFORE it re-registers its rewards, so a replayed level
 * does not double-count the placed values.
 */
export function resetMaxScore(host: ScoreHost): void {
  host.registry.set('maxScore', 0);
}

// ── placeholder-floor diagnostics (dev log ONLY — never an observed field) ───
/** Keys already warned about, so the floor is flagged ONCE per kind/key, not per frame. */
const _warnedFloors = new Set<string>();

/**
 * Flag (console.warn, ONCE) that a primary visible object fell back to the
 * programmatic placeholder rect instead of a real generated asset. The
 * colored-rect placeholder is the LAST-RESORT floor — a hit on it should be
 * VISIBLE in the console, never the silent default. This is a DEV DIAGNOSTIC
 * only: it writes nothing to window.__GAME__ / the verify oracle and changes no
 * game behavior. GENERIC: takes a kind + a key, no theme.
 */
export function warnPlaceholderFloor(kind: string, key: string): void {
  const tag = `${kind}:${key}`;
  if (_warnedFloors.has(tag)) return;
  _warnedFloors.add(tag);
  // eslint-disable-next-line no-console
  console.warn(
    `[asset-floor] ${kind} "${key}" rendered as a placeholder rect — no real asset resolved. ` +
      `Within budget every primary visible object should have a real generated asset.`,
  );
}
