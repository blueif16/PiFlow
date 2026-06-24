/**
 * ============================================================================
 * guidance/TriggerEngine.ts  —  the generic data-driven TRIGGER engine (KEEP — engine seam)
 * ============================================================================
 * A GENERIC `condition → action` evaluator fired at a TIMING, polled each frame
 * against the live `window.__GAME__` oracle. It is engine-owned and reusable for
 * ANY data-driven cue — a teaching coachmark (its first consumer), a delayed
 * spawn, an objective change — so it knows NOTHING about coachmarks (the action is
 * an opaque callback) and NOTHING about any one game (every threshold/observable
 * is DATA read from the trigger spec). There is no game noun in this file.
 *
 * RENDERER-AGNOSTIC: it polls window.__GAME__ by dot-path, so the SAME engine
 * drives the 2D Phaser oracle and the 3D Three.js oracle. This is the ONE shared
 * copy (it lives in the cross-engine contract, imported by both engines as
 * `@contract/guidance/TriggerEngine`).
 *
 * Each registered trigger fires AT MOST ONCE (a teaching prompt or a one-shot cue
 * never re-fires), then is retired. Observables are read by dot-path off the
 * snapshot so a new oracle field is watchable with zero engine change.
 *
 * `on-first` captures the observable's value at REGISTER time and fires on the
 * first change/rise/fall from it — the generic "first move / first hit / first
 * pickup" detector. `on-state` fires when a numeric/boolean field crosses a
 * declared threshold. `after-delay` fires on a wall-clock elapsed since start.
 * `on-ready` fires once the oracle latches ready. `on-milestone` fires when the
 * oracle reports the named milestone (a hook a game may expose; absent ⇒ never).
 * `on-event` POLLS the PUSH-channel event log (`hook.events`): it advances a
 * per-instance cursor each poll and fires once on the first NEW log entry whose
 * `type` matches the trigger's `eventName` — never re-firing an old entry, and
 * never subscribing (preserves the frame-poll / one-snapshot-per-frame model).
 */

import type { CoachingTrigger } from '@contract/teach-spec';
import type { GameHook, LoggedEvent } from '@contract/hook-contract';

/** Read a dot-path (e.g. 'player.vy', 'score') off an object, else undefined. */
function readPath(obj: unknown, path: string): unknown {
  if (obj == null || typeof obj !== 'object') return undefined;
  let cur: any = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Read an observable off the LIVE oracle, with the snapshot as a fallback. WHY
 * both: the engine-agnostic contract serializes the CORE fields via `snapshot()`,
 * but an archetype's EXTRA observables are commonly live getters installed straight
 * on the hook — those may not all appear in `snapshot()`. Reading the live hook by
 * dot-path FIRST sees both the core getters and the archetype extras; the snapshot
 * fallback covers anything the live object exposes only through it. This is what
 * makes `on-first`/`on-state` GENERIC across any oracle shape.
 */
function readObservable(hook: unknown, snap: Record<string, unknown>, path: string): unknown {
  const live = readPath(hook, path);
  if (live !== undefined) return live;
  return readPath(snap, path);
}

/** Stable, cheap equality for the snapshot values we watch (numbers, strings, bools, small objects). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

interface Registered<T> {
  trigger: CoachingTrigger;
  payload: T;
  /** The observable's value captured at register time (on-first 'changes' compares to this). */
  baseline?: unknown;
  /** The observable's value at the PREVIOUS poll (on-first 'increases'/'decreases' compare to this). */
  last?: unknown;
  fired: boolean;
}

/**
 * The trigger engine. Register `(trigger, payload)` pairs; call `start()` when the
 * world begins, `update(hook)` each frame. When a trigger condition holds, the
 * engine invokes the action callback with the payload, once.
 */
export class TriggerEngine<T = unknown> {
  private registered: Registered<T>[] = [];
  private startedAt = 0;
  private running = false;
  /**
   * The highest event-log seq this engine has already consumed. `on-event`
   * triggers only ever see entries with `seq > lastSeenSeq`, and the cursor is
   * advanced past every entry inspected each poll — so an old entry never
   * re-fires (the poll-don't-subscribe, fire-once-per-new-entry contract).
   */
  private lastSeenSeq = 0;

  constructor(private readonly onFire: (payload: T, trigger: CoachingTrigger) => void) {}

  /** Register a trigger + the opaque payload handed back on fire. */
  add(trigger: CoachingTrigger, payload: T): void {
    this.registered.push({ trigger, payload, fired: false });
  }

  /** Mark the world started — `after-delay` is measured from here; `on-first` baselines now. */
  start(hook: GameHook): void {
    this.running = true;
    this.startedAt = performance.now();
    // Baseline the event cursor at the log's current head: events emitted BEFORE
    // the world started never satisfy an `on-event` trigger (absent log ⇒ 0).
    this.lastSeenSeq = hook.events?.cursor ?? 0;
    const snap = this.safeSnapshot(hook);
    for (const r of this.registered) {
      if (r.trigger.at === 'on-first' && r.trigger.observable) {
        const v = readObservable(hook, snap, r.trigger.observable);
        r.baseline = v;
        r.last = v;
      }
    }
  }

  /** Poll every registered trigger against the live oracle; fire the ready ones once. */
  update(hook: GameHook): void {
    if (!this.running) return;
    const snap = this.safeSnapshot(hook);
    const elapsed = performance.now() - this.startedAt;
    // Read the NEW event-log entries once per poll (those past our cursor). The
    // cursor is advanced to the log head AFTER the trigger sweep so every new
    // entry is inspected exactly once and never re-fires next poll.
    const newEvents: ReadonlyArray<LoggedEvent> = hook.events?.recent(this.lastSeenSeq) ?? [];
    for (const r of this.registered) {
      if (r.fired) continue;
      const fire = this.holds(r, hook, snap, elapsed, newEvents);
      // Track the previous sample for the next poll's rise/fall delta (on-first
      // increases/decreases detect a change from the LAST frame, not the start —
      // so a fall-then-rise still registers the rise as a first increase).
      if (r.trigger.at === 'on-first' && r.trigger.observable) {
        r.last = readObservable(hook, snap, r.trigger.observable);
      }
      if (fire) {
        r.fired = true;
        try {
          this.onFire(r.payload, r.trigger);
        } catch {
          /* a teaching cue must never crash the game loop */
        }
      }
    }
    // Advance the cursor past everything in the log now — an on-event trigger
    // registered later, or fired this poll, never re-sees these entries.
    const head = hook.events?.cursor;
    if (typeof head === 'number' && head > this.lastSeenSeq) this.lastSeenSeq = head;
  }

  /** Evaluate ONE trigger against the current oracle state. */
  private holds(
    r: Registered<T>,
    hook: GameHook,
    snap: Record<string, unknown>,
    elapsed: number,
    newEvents: ReadonlyArray<LoggedEvent>,
  ): boolean {
    const t = r.trigger;
    switch (t.at) {
      case 'on-ready':
        return hook.ready === true;
      case 'after-delay':
        return elapsed >= (t.delayMs ?? 0);
      case 'on-first': {
        if (!t.observable) return false;
        const now = readObservable(hook, snap, t.observable);
        const change = t.change ?? 'changes';
        // 'changes' = ANY change from the START baseline (first move / first cycle).
        if (change === 'changes') return !sameValue(now, r.baseline);
        // 'increases'/'decreases' = the first rise/fall from the PREVIOUS sample, so
        // a prior opposite movement never masks it.
        const a = asNumber(now);
        const prev = asNumber(r.last);
        if (a === undefined || prev === undefined) return false;
        return change === 'increases' ? a > prev : a < prev;
      }
      case 'on-state': {
        if (!t.observable) return false;
        const now = readObservable(hook, snap, t.observable);
        const cmp = t.comparator ?? 'atLeast';
        const a = asNumber(now);
        const target = t.value;
        if (cmp === 'equals') return now === target;
        if (cmp === 'changes') return false; // a one-shot state cmp; use on-first for change
        if (a === undefined) return false;
        const n = asNumber(target);
        if (n === undefined) return false;
        if (cmp === 'atLeast') return a >= n;
        if (cmp === 'atMost') return a <= n;
        if (cmp === 'increases') return a > n;
        if (cmp === 'decreases') return a < n;
        return false;
      }
      case 'on-milestone': {
        // A game may expose a reached-milestone signal on the oracle (key
        // 'milestone' or an array 'milestonesReached'); absent ⇒ never fires.
        const reached = readObservable(hook, snap, 'milestonesReached');
        if (Array.isArray(reached)) return reached.includes(t.milestone);
        return readObservable(hook, snap, 'milestone') === t.milestone;
      }
      case 'on-event': {
        // Poll the PUSH-channel log: fire on the first NEW entry whose type matches
        // the trigger's event name. The name arrives as `eventName` (the runtime
        // contract) OR `event` (the blueprint/author schema, projected verbatim by
        // W2) — accept either, else an authored `event:` cue is silently inert.
        // `newEvents` already excludes everything at/under our cursor, so an old entry
        // can never match (the never-re-fire contract). Absent name / log ⇒ no match.
        const name = t.eventName ?? t.event;
        if (!name) return false;
        return newEvents.some((e) => e.type === name);
      }
      default:
        return false;
    }
  }

  /** A defensive snapshot read (the oracle is a live getter object). */
  private safeSnapshot(hook: GameHook): Record<string, unknown> {
    try {
      return (hook.snapshot?.() as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }

  /** True once every registered trigger has fired (lets a driver tear down its loop). */
  allFired(): boolean {
    return this.registered.every((r) => r.fired);
  }
}
