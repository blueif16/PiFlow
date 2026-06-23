// ─────────────────────────────────────────────────────────────────────────────
// RunState (D6) — the per-thread channel object + its reducers + load/merge/persist.
//
// RunState is a LangGraph-style state-channel object: a flat bag where each key is a channel. A node
// EMITS a partial update (via a POST-hook `promote`); the DRIVER merges it into the channel through the
// channel's reducer — the node never writes `state.json` itself (the "mechanical → driver hook" law).
//
// This module is the PURE foundation (U6a): the three reducers, a single-channel merge, and the ONLY
// state I/O (`${projectBase}/.pi/state.json`). The `${state.*}` token RESOLVER, the `promote` executor,
// and the parallel stage-barrier merge are U7 — NOT here.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from 'node:fs';
import { stateFile, piDir } from '../runner/layout.js';
import type { RunState, Reducer } from '../types.js';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/**
 * Recursively merge `next` into `prev` for plain objects, keeping siblings the merge doesn't touch.
 * ARRAYS are LEAVES: a `next` array REPLACES the `prev` value (documented policy — use `append` to
 * concatenate). Non-object `next` (or non-object `prev`) replaces wholesale.
 */
function deepMerge(prev: unknown, next: unknown): unknown {
  if (!isPlainObject(prev) || !isPlainObject(next)) return next;
  const out: Record<string, unknown> = { ...prev };
  for (const k of Object.keys(next)) {
    out[k] = k in out ? deepMerge(out[k], next[k]) : next[k];
  }
  return out;
}

/**
 * Apply one reducer to combine a channel's prior value with an incoming update. PURE.
 * `set` overwrites (default); `append` concatenates (both coerced to arrays); `deepMerge` recurses.
 */
export function applyReducer(prev: unknown, next: unknown, reducer: Reducer = 'set'): unknown {
  switch (reducer) {
    case 'append':
      return [...asArray(prev), ...asArray(next)];
    case 'deepMerge':
      return deepMerge(prev, next);
    case 'set':
    default:
      return next;
  }
}

/**
 * Merge `value` into one `channel` of `state` via `reducer`, returning a NEW state (input not mutated).
 * Untouched channels are preserved.
 */
export function mergeUpdate(
  state: RunState,
  channel: string,
  value: unknown,
  reducer: Reducer = 'set',
): RunState {
  return { ...state, [channel]: applyReducer(state[channel], value, reducer) };
}

/** Read `${projectBase}/.pi/state.json`. Returns `{}` if the file is absent (a fresh run). */
export async function loadState(projectBase: string): Promise<RunState> {
  try {
    const raw = await fs.readFile(stateFile(projectBase), 'utf8');
    return JSON.parse(raw) as RunState;
  } catch {
    return {};
  }
}

/** Write `state` to `${projectBase}/.pi/state.json` (pretty-printed; mkdir -p the `.pi/` dir first). */
export async function persistState(projectBase: string, state: RunState): Promise<void> {
  await fs.mkdir(piDir(projectBase), { recursive: true });
  await fs.writeFile(stateFile(projectBase), JSON.stringify(state, null, 2));
}
