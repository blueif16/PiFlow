// ─────────────────────────────────────────────────────────────────────────────
// The U7 RUNTIME token resolver — the SINGLE place a logical path/value is made physical (D6).
//
// ONE vocabulary, ONE resolver, applied UNIFORMLY to EVERY marker (artifacts · owns · readScope · seed ·
// schema · merge · prompt). The path/value tokens are:
//
//   {{RUN}}            → the per-thread mutable OUTPUT root (= U6 `projectBase`, `out/<run>`)
//   {{WORKSPACE}}      → the canonical, read-only, OUT-OF-THREAD tree (skills · templates · registry)
//   {{state.<channel>}}→ the channel value from `${RUN}/.pi/state.json`, resolved at NODE LAUNCH
//
// This RETIRES the local workarounds it supersedes: the `BASE_ROOT→wtRoot` string-regex re-rooting and
// the `RUN_CWD`-relative `{file:field}` token (game-omni `run.mjs:331`/`:398`). A `{{RUN}}`/`{{WORKSPACE}}`-
// rooted reference is relocation-invariant BY CONSTRUCTION — re-rooting a worktree/remote thread is just
// "resolve the two roots per provider", with no per-marker or per-provider special-casing. The delimiter
// (`{{`/`}}`) lives in ONE place (`template/tokens.ts`); this consumes its `reToken` builder.
//
// A MISSING `{{state.<channel>}}` channel is a hard ERROR (`MissingChannelError`) — NEVER a silent ''.
// State drives VALUES only; it never drives routing (the DAG stays static).
// ─────────────────────────────────────────────────────────────────────────────

import type { RunState } from '../types.js';
import { reToken } from './template/tokens.js';

/** The two engine-resolved logical roots + the per-thread RunState channels + the run-level args. */
export interface ResolveCtx {
  /** `{{RUN}}` — the per-thread mutable output root (`projectBase`, e.g. `out/<run>`). */
  run: string;
  /** `{{WORKSPACE}}` — the canonical, read-only, out-of-thread tree (skills · templates · registry). */
  workspace: string;
  /** The RunState channels (`{{state.<channel>}}` reads these). Absent ⇒ no `{{state}}` token may resolve. */
  state?: RunState;
  /** The run-level args (`{{arg.<key>}}` reads these — the `--arg k=v` delivery). Absent ⇒ no `{{arg}}` may resolve. */
  args?: Record<string, string>;
}

/** Thrown when a `{{state.<channel>}}` token names a channel that is ABSENT from RunState. NOT a silent ''. */
export class MissingChannelError extends Error {
  constructor(public readonly channel: string) {
    super(
      `unresolved state channel "${channel}": no such key in RunState. ` +
        `An upstream node must promote it before a consumer reads {{state.${channel}}}.`,
    );
    this.name = 'MissingChannelError';
  }
}

/** Thrown when a `{{arg.<key>}}` token names a run arg that was not supplied. NOT a silent ''. */
export class MissingArgError extends Error {
  constructor(public readonly key: string) {
    super(
      `unresolved run arg "${key}": no such key in the run args. ` +
        `Supply it via --arg ${key}=<value> (the consumer reads {{arg.${key}}}).`,
    );
    this.name = 'MissingArgError';
  }
}

// One regex covers each token kind; the captured `inner` selects the resolver branch.
const STATE_RE = /^state\.([A-Za-z0-9_]+)$/;
const ARG_RE = /^arg\.([A-Za-z0-9_]+)$/;

/**
 * Resolve EVERY `{{…}}` token in `s` against the logical roots + RunState. Pure. A string with no token
 * is returned unchanged. A missing `{{state.<channel>}}` throws `MissingChannelError` (never silently '').
 * A non-string channel value is coerced via `String(...)` (so `{{state.n}}` with `n:3` ⇒ `"3"`).
 */
export function resolveTokens(s: string, ctx: ResolveCtx): string {
  return s.replace(reToken('([A-Za-z0-9_.]+)'), (_whole, inner: string) => {
    if (inner === 'RUN') return ctx.run;
    if (inner === 'WORKSPACE') return ctx.workspace;
    const sm = STATE_RE.exec(inner);
    if (sm) {
      const channel = sm[1];
      const state = ctx.state ?? {};
      // `in` (not truthiness) so an explicitly-null/0/'' channel is PRESENT — only an ABSENT key throws.
      if (!(channel in state)) throw new MissingChannelError(channel);
      return String(state[channel]);
    }
    const am = ARG_RE.exec(inner);
    if (am) {
      const key = am[1];
      const args = ctx.args ?? {};
      // Mirror the state discipline: an ABSENT arg throws (never a silent '') — but an explicitly-set
      // empty/0 value is PRESENT.
      if (!(key in args)) throw new MissingArgError(key);
      return String(args[key]);
    }
    // An unknown `{{token}}` (not RUN/WORKSPACE/state.*/arg.*) is left verbatim — it is not ours to resolve.
    return _whole;
  });
}

/** Apply `resolveTokens` to EVERY entry of a marker list (artifacts · owns · readScope · seed · schema). */
export function resolveAll(list: string[], ctx: ResolveCtx): string[] {
  return list.map((s) => resolveTokens(s, ctx));
}

/**
 * DEEP-resolve every `{{…}}` token in EVERY string of an arbitrary op-spec tree (strings · arrays · plain
 * objects), returning a NEW tree (pure; the input is untouched). The POST ops (`project`/`merge`) carry
 * their source/dest paths INSIDE nested op objects (`{ fold:{ from, to }}`, `{ run:{ cmd, args[] }}`), so a
 * flat `resolveAll` is not enough — this makes `{{RUN}}`/`{{WORKSPACE}}`/`{{state.*}}`/`{{arg.*}}` physical
 * throughout before the executor runs. A missing channel/arg throws (same loud discipline as `resolveTokens`).
 * Non-string leaves (numbers/booleans/null) pass through verbatim. (The executor still substitutes its own
 * `{project}` token for `run` ops — that is a SEPARATE, executor-owned token, not a `{{…}}` logical root.)
 */
export function resolveDeep<T>(value: T, ctx: ResolveCtx): T {
  if (typeof value === 'string') return resolveTokens(value, ctx) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, ctx)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveDeep(v, ctx);
    return out as unknown as T;
  }
  return value;
}
