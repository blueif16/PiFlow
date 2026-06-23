// ─────────────────────────────────────────────────────────────────────────────
// `promote` — the POST-hook op that lifts a node OUTPUT into a RunState channel (D6). LangGraph-grounded:
// a node EMITS a partial update and the DRIVER applies the channel's reducer — the node NEVER writes
// state.json itself (the "mechanical → driver hook" law). The sibling of DRIVER-PROJECT / DRIVER-MERGE.
//
//   promote: [{ from: '<artifact>:<dotted.field>' | '@return:<field>', to: '<channel>', merge?: Reducer }]
//
// After the node exits the engine LIFTS the value (a produced-file field OR the structured @return) and
// MERGES it into the channel via the reducer (set | append | deepMerge).
//
// THE STAGE-BARRIER MERGE (= LangGraph super-step semantics). In a PARALLEL stage each node emits its
// update independently; the driver merges them into ${RUN}/.pi/state.json at the STAGE BARRIER — SERIALLY
// and DETERMINISTICALLY (in the given node order) — so there is NEVER a concurrent write to the shared
// state file. A channel written by >1 parallel node MUST declare append/deepMerge; a `set` channel with
// two concurrent writers is a CONFLICT the driver flags (LangGraph raises InvalidUpdateError).
// ─────────────────────────────────────────────────────────────────────────────

import type { RunState, Reducer } from '../../types.js';
import { applyReducer } from '../state.js';
import { readJsonSafe, drillPath, absUnder } from './util.js';

/** A single promote: lift `from` into channel `to`, merged via `merge` (default 'set'). */
export interface PromoteSpec {
  /** `<artifact-relpath>:<dotted.field>` (a produced file) or `@return:<dotted.field>` (the structured return). */
  from: string;
  /** The RunState channel to merge into. */
  to: string;
  /** The channel reducer. Default 'set'. */
  merge: Reducer;
}

/** The lifted, resolved promote ready for the reducer (the value already extracted). */
export interface ResolvedPromote {
  to: string;
  value: unknown;
  merge: Reducer;
}

/** Context for extracting a promote value: the run root (for an artifact source) + the node's @return. */
export interface PromoteCtx {
  /** `{{RUN}}` — the per-thread output root the artifact relpath resolves under. */
  run: string;
  /** The node's parsed structured `@return` value (for an `@return:<field>` source). */
  returnValue?: Record<string, unknown>;
}

/** Thrown when a `set` channel is written by >1 node in the SAME stage barrier (LangGraph InvalidUpdateError). */
export class ConflictError extends Error {
  constructor(
    public readonly channel: string,
    public readonly writers: string[],
  ) {
    super(
      `state channel "${channel}" is written by ${writers.length} concurrent nodes ` +
        `(${writers.join(', ')}) under the 'set' reducer — a conflict. ` +
        `A channel promoted by parallel nodes MUST declare 'append' or 'deepMerge'.`,
    );
    this.name = 'ConflictError';
  }
}

/** A node's emitted update at the barrier: its id + the resolved promotes it produced. */
export interface NodeUpdate {
  nodeId: string;
  promotes: ResolvedPromote[];
}

/** Normalize a raw promote spec — fill the default `set` reducer. */
export function parsePromote(raw: { from: string; to: string; merge?: Reducer }): PromoteSpec {
  return { from: raw.from, to: raw.to, merge: raw.merge ?? 'set' };
}

/**
 * Lift a promote's value. `@return:<field>` drills the node's structured return; otherwise `from` is
 * `<artifact-relpath>:<field>` — read the produced file under `{{RUN}}` and drill `<field>`. A source that
 * resolves to `undefined` THROWS (a promote of nothing is a wiring error, surfaced loudly — not a silent ''
 * the way the retired `{file:field}` seed token degraded).
 */
export async function extractPromoteValue(spec: PromoteSpec, ctx: PromoteCtx): Promise<unknown> {
  const colon = spec.from.indexOf(':');
  if (colon < 0) throw new Error(`promote.from "${spec.from}" must be "<artifact>:<field>" or "@return:<field>"`);
  const source = spec.from.slice(0, colon);
  const field = spec.from.slice(colon + 1);
  let value: unknown;
  if (source === '@return') {
    value = field ? drillPath(ctx.returnValue ?? {}, field) : ctx.returnValue;
  } else {
    const obj = await readJsonSafe(absUnder(ctx.run, source));
    if (obj === undefined) throw new Error(`promote source artifact "${source}" unreadable (under {{RUN}})`);
    value = field ? drillPath(obj, field) : obj;
  }
  if (value === undefined) throw new Error(`promote.from "${spec.from}" resolved to undefined (field absent)`);
  return value;
}

/**
 * Apply ONE node's resolved promotes into `state` via each channel's reducer (immutable — returns a NEW
 * state). Returns the new state + the ledger records (`{to,merge,value}`) for `io.json.promotes`.
 */
export function applyPromotes(
  state: RunState,
  promotes: ResolvedPromote[],
): { state: RunState; promotes: { to: string; merge: string; value: unknown }[] } {
  let out = state;
  const ledger: { to: string; merge: string; value: unknown }[] = [];
  for (const p of promotes) {
    out = { ...out, [p.to]: applyReducer(out[p.to], p.value, p.merge) };
    ledger.push({ to: p.to, merge: p.merge, value: p.value });
  }
  return { state: out, promotes: ledger };
}

/**
 * The STAGE-BARRIER MERGE. Apply every parallel node's promotes into `prior` SERIALLY, in the GIVEN node
 * order (deterministic — never racily). CONFLICT GUARD: a channel written by >1 node in this barrier under
 * the `set` reducer is a `ConflictError`; `append`/`deepMerge` are the declared concurrent reducers and are
 * allowed. (A single writer to a `set` channel is never a conflict.)
 */
export function barrierMerge(prior: RunState, updates: NodeUpdate[]): RunState {
  // Pre-flight the conflict guard: group writers per channel, flag any `set` channel with ≥2 writers.
  const writersByChannel = new Map<string, { nodeId: string; merge: Reducer }[]>();
  for (const u of updates)
    for (const p of u.promotes) {
      const arr = writersByChannel.get(p.to) ?? [];
      arr.push({ nodeId: u.nodeId, merge: p.merge });
      writersByChannel.set(p.to, arr);
    }
  for (const [channel, writers] of writersByChannel) {
    if (writers.length > 1 && writers.some((w) => w.merge === 'set'))
      throw new ConflictError(channel, writers.map((w) => w.nodeId));
  }
  // No conflict → fold serially in the given order.
  let state = prior;
  for (const u of updates) state = applyPromotes(state, u.promotes).state;
  return state;
}
