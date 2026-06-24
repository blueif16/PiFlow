/**
 * ============================================================================
 * component-surface.ts — THE UNIFORM COMPONENT-SURFACE PROTOCOL (shared baseplate)
 * ============================================================================
 *
 * The shared protocol every component PUBLISHES through and every node READS over
 * uniformly: a component hands back a typed `ComponentSurface` (the studs), and the
 * nodes on top (the __GAME__ hook fold, the registry, guidance/shell binding) read
 * those studs without per-component special-casing.
 *
 * Two channels + spatial anchors:
 *   - observables — the PULL channel: pollable __GAME__ state, exposed as LIVE thunks
 *     reading the component's OWN real value (a renderer that merely READS a value
 *     publishes NONE — it cannot hand back a real thunk for a value it doesn't compute);
 *   - events — the PUSH channel: the closed, typed set of moments the component emits
 *     on the shared bus;
 *   - anchors — the spatial-anchor patterns the component produces.
 *
 * Engine-agnostic (no engine import), like the rest of core-contract.
 */

import type { LoggedEvent } from './hook-contract';

/** One published event: a discrete moment + its payload shape (the typed format). */
export interface EventDecl {
  /** The closed event name emitted on the shared bus, e.g. 'weapon.fired'. */
  readonly name: string;
  /** A short payload-shape hint (the format), e.g. '{weapon,hit}' | 'objectId' | 'void'. */
  readonly payload?: string;
  /**
   * A typed payload ref for the generated event map (the catalog/type system) —
   * additive over the human `payload` hint, e.g. 'WeaponFiredPayload'. Optional.
   */
  readonly payloadType?: string;
  /**
   * The tier tag this event belongs to ('core' | 'base:2d' | 'base:3d' |
   * 'archetype' | …). An OPEN string, never a closed enum: a new tier is a new
   * string a module declares, with ZERO core edits. Optional.
   */
  readonly scope?: string;
  /**
   * The verb/input that triggers this emit (the responsiveness gate's stimulus),
   * e.g. 'fire' | 'interact' | 'mine'. Read by the runtime `check-exposes` gate.
   * Optional.
   */
  readonly drivenBy?: string;
  /**
   * The observable transition (or log entry) this emit MUST cause — the
   * stub-killer the responsiveness gate asserts after firing `drivenBy`, e.g.
   * 'ammo decreases' | 'currency.gained logged'. Optional.
   */
  readonly expect?: string;
}
/** The uniform published surface of one component — the studs every node reads over.
 *  Two channels: observables (PULL — pollable __GAME__ state) + events (PUSH — moments on
 *  the shared bus); plus spatial anchors. */
export interface ComponentSurface {
  /** __GAME__ dot-path → a LIVE thunk reading this component's OWN real state. */
  readonly observables: Readonly<Record<string, () => unknown>>;
  /** Events this component emits on the shared bus, as a closed typed set. */
  readonly events: readonly EventDecl[];
  /** Spatial anchor patterns this component produces ('spawn'|'near:<id>'|'region:<id>'). */
  readonly anchors: readonly string[];
}
/** A component that publishes onto the uniform surface protocol. */
export interface SurfaceProvider {
  surface(): ComponentSurface;
}

// ============================================================================
// EventBus — the engine-agnostic transport facade (the live bus + the log tap)
// ============================================================================
//
// The PUSH-channel mechanism every archetype shares, decoupled from any engine:
// a synchronous pub/sub bus for IN-GAME wiring (gameplay, HUD, audio) whose EVERY
// emit is also mirrored — by an internal `tap` — into a bounded, frame-tagged,
// monotonic-`seq` ring buffer. That ring buffer is the EXTERNAL observation
// surface (guidance / the verify harness / replay) that `GameHook.events`
// exposes and the TriggerEngine POLLS — never `.on()`-subscribes, so a
// late-joining poller (which attaches outside the game's load order) still sees
// the whole buffer (the lost-event problem is structural for external consumers).
//
// PURE TS — NO Phaser/Three import. A per-engine adapter wires this facade over
// its raw emitter under the hood (Phaser `game.events`, the in-scene
// `EventEmitter`); the facade hides the raw emitter so every archetype shares one
// observation contract. NOT wired to any archetype here (that is a later phase).

/** A registered listener callback for one event type. */
export type EventListener = (payload?: unknown) => void;

/**
 * The shared event-bus facade. Generic over an OPEN `string` type key (event
 * names grow freely — never a closed enum the core must edit to add one).
 *
 *  - `emit(type, payload?)` — fire synchronously to every live listener AND tap
 *    into the ring buffer (stamped with the current frame + a monotonic seq).
 *  - `on(type, cb)` — subscribe; returns an UNSUBSCRIBE fn (call it to remove).
 *  - `once(type, cb)` — subscribe for a single emit, then auto-remove.
 *  - `off(type, cb)` — remove a specific listener.
 *  - `recent(sinceSeq?)` — the log read seam: every buffered entry with
 *    `seq > sinceSeq` (or the whole buffer when omitted), oldest→newest.
 *  - `cursor` — the latest stamped seq (0 before any emit).
 *  - `setFrame(n)` — the scene stamps the current frame each tick so log entries
 *    carry a real frame number.
 */
export class EventBus {
  /** type → live listener set (in-game pub/sub). */
  private readonly listeners = new Map<string, Set<EventListener>>();
  /** The bounded, drop-oldest ring buffer (the external observation surface). */
  private readonly buffer: LoggedEvent[] = [];
  /** Max buffered entries; the oldest is dropped past this (drop-oldest). */
  private readonly capacity: number;
  /** Monotonic publish counter — the stable total order for replay. */
  private seq = 0;
  /** The current frame the scene has stamped (via setFrame). */
  private frame = 0;

  constructor(capacity = 64) {
    this.capacity = capacity > 0 ? capacity : 64;
  }

  /** Subscribe to `type`; returns an unsubscribe fn that removes this listener. */
  on(type: string, cb: EventListener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
    return () => this.off(type, cb);
  }

  /** Subscribe for exactly one emit of `type`, then auto-remove. */
  once(type: string, cb: EventListener): () => void {
    const wrapper: EventListener = (payload) => {
      this.off(type, wrapper);
      cb(payload);
    };
    return this.on(type, wrapper);
  }

  /** Remove a specific listener for `type` (a no-op if it was not registered). */
  off(type: string, cb: EventListener): void {
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) this.listeners.delete(type);
  }

  /** Fire `type` to every live listener AND mirror it into the ring buffer. */
  emit(type: string, payload?: unknown): void {
    this.tap(type, payload);
    const set = this.listeners.get(type);
    if (!set) return;
    // Iterate a copy so a listener that subscribes/unsubscribes mid-emit (e.g.
    // `once`) never mutates the set we are iterating.
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch {
        /* a listener must never crash the emit loop (cosmetic/guidance wiring) */
      }
    }
  }

  /** Mirror every emit into the bounded ring buffer (drop-oldest), stamped. */
  private tap(type: string, payload?: unknown): void {
    const entry: LoggedEvent = { frame: this.frame, seq: ++this.seq, type, payload };
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) this.buffer.shift(); // drop-oldest
  }

  /** Every buffered entry with `seq > sinceSeq` (or all when omitted), oldest→newest. */
  recent(sinceSeq?: number): LoggedEvent[] {
    if (sinceSeq === undefined) return this.buffer.slice();
    return this.buffer.filter((e) => e.seq > sinceSeq);
  }

  /** The latest stamped seq (0 before any emit) — the read cursor. */
  get cursor(): number {
    return this.seq;
  }

  /** The scene stamps the current frame each tick so log entries carry it. */
  setFrame(n: number): void {
    this.frame = n;
  }
}
