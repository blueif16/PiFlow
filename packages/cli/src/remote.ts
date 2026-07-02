// The REMOTE-serve client — the seam that lets `piflowctl status`/`watch`/`run` talk to a control plane
// over HTTP/SSE when the active context is not `local` (context-store.ts's ladder resolves WHICH). It
// consumes the EXACT stream the server already exposes (`GET /__piflow/stream/<run>` — SSE of the shared
// `RunUpdate` sequence, handlers.ts) and the launch endpoint (`POST /api/runs/start` → 202 `{run,streamUrl}`,
// start-run.ts), so the CLI's local vs remote paths RENDER identically: `remoteRunModel` feeds the same
// `renderStatus`, `remoteUpdates` feeds `watch`'s injectable `updates` seam, and `startRemoteRun` mirrors
// the local run's `{run}` surface. No @piflow/core / @piflow/server change — this is a pure client.
//
// The bearer token from the context entry (a cloud `serve`) rides `Authorization: Bearer <token>` on EVERY
// call; a tokenless entry (the local default) sends no header. `fetchImpl` is injectable so the unit tests
// drive a fake stream body with NO real network.

import type { RunModel, RunUpdate } from '@piflow/core';
import { readContexts, resolveActive, LOCAL_CONTEXT, isCloudEntry, type ContextEntry } from './context-store.js';

/**
 * Resolve the active context (the `--context` flag > `PIFLOW_CONTEXT` > persisted `current` > `local` ladder)
 * to a REMOTE serve entry, or `null` when the active context is local (name `local` OR the local serve
 * baseUrl) — in which case the caller keeps TODAY's local-filesystem path unchanged. An unknown `--context`
 * name throws loudly (so a typo never silently falls back to the local path). This is the ONE gate every
 * observe/start subcommand asks: "is the active context remote, and if so where?".
 */
export function resolveRemote(flagContext?: string): { name: string; entry: ContextEntry } | null {
  const name = resolveActive({ flagContext });
  if (name === LOCAL_CONTEXT) return null;
  const entry = readContexts().contexts[name];
  if (!entry) {
    throw new Error(
      `piflowctl: unknown context "${name}" (set it with: piflowctl context add ${name} --url <baseUrl>). Known: ${Object.keys(readContexts().contexts).sort().join(', ')}`,
    );
  }
  // A named context that still points at the local serve is treated as local (no HTTP hop needed). Uses the
  // SHARED `isCloudEntry` predicate so run-routing and the worker cascade can never disagree (see context-store).
  if (!isCloudEntry(entry)) return null;
  return { name, entry };
}

/** The RunUpdate kinds the server streams — used to filter the meta/keepalive/stream-error frames it interleaves.
 *  MUST list EVERY `RunUpdate` kind (observe/types.ts) or a new kind is silently dropped here (DR7 additive
 *  invariant): `node-enriched` (the enriched-fold delta) is registered so the remote CLI passes it through. */
const RUN_UPDATE_KINDS = new Set(['snapshot', 'node-status', 'node-event', 'node-enriched', 'done']);

/** Injectable transport + cancellation for every remote call (a test passes a fake fetch + no real socket). */
export interface RemoteOpts {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** The stream URL for a run on a remote serve: `<baseUrl>/__piflow/stream/<run>` (trailing slash stripped, run encoded). */
export function streamUrlFor(entry: ContextEntry, run: string): string {
  return `${entry.baseUrl.replace(/\/$/, '')}/__piflow/stream/${encodeURIComponent(run)}`;
}

/** The Authorization header for an entry — `Bearer <token>` when the entry carries one, else nothing. */
function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * PURE SSE frame splitter — the unit-tested core. Splits `buffer` on the `\n\n` frame delimiter, extracts
 * each frame's `data:` payload (ignoring `:comment` keepalives, `event:`/`id:` fields), `JSON.parse`s it,
 * and returns the parsed events + the leftover PARTIAL trailing frame (no terminating `\n\n` yet) as `rest`
 * for the next chunk. A frame whose data does not parse is skipped (never throws mid-stream). NOTE: the
 * server interleaves non-RunUpdate frames (a `meta` preamble, a `stream-error`); this parser returns them
 * verbatim (typed as the stream's event union) and the caller (`sseEvents`) filters to real `RunUpdate`s.
 */
export function parseSseFrames(buffer: string): { events: RunUpdate[]; rest: string } {
  const events: RunUpdate[] = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? ''; // the last piece has no terminating \n\n → it is the partial carry-over.
  for (const frame of parts) {
    // A frame may carry multiple lines; concatenate the `data:` line payloads (per the SSE spec).
    const data = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(l.startsWith('data: ') ? 6 : 5))
      .join('\n');
    if (!data) continue; // a comment/keepalive-only frame carries no data.
    try {
      events.push(JSON.parse(data) as RunUpdate);
    } catch {
      /* a malformed frame is skipped rather than killing the stream. */
    }
  }
  return { events, rest };
}

/**
 * Open the SSE stream at `url` and yield each `RunUpdate` as it arrives. A thin wrapper: `fetch` with the
 * optional Bearer header + abort signal, iterate the response body, accumulate the decoded text, run
 * `parseSseFrames` over it, and yield each event — dropping the non-RunUpdate frames the server interleaves
 * (`meta`, `stream-error`, keepalives). `fetchImpl` is injectable for tests.
 */
export async function* sseEvents(
  url: string,
  token: string | undefined,
  opts: RemoteOpts = {},
): AsyncIterable<RunUpdate> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { headers: authHeaders(token), signal: opts.signal });
  const body = (res as Response).body;
  if (!body) throw new Error(`remote stream ${url} returned no response body (status ${(res as Response).status})`);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseFrames(buf);
      buf = rest;
      for (const ev of events) {
        if (RUN_UPDATE_KINDS.has((ev as { kind?: string }).kind ?? '')) yield ev;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * Resolve the CURRENT `RunModel` for a run on a remote serve by opening its SSE stream and taking the FIRST
 * `snapshot` frame (the server always yields the full model first, handlers.ts), then aborting the stream.
 * Throws a clear error if the stream ends before any snapshot arrives (an unknown run / a server error).
 */
export async function remoteRunModel(entry: ContextEntry, run: string, opts: RemoteOpts = {}): Promise<RunModel> {
  const ac = new AbortController();
  // Chain an outer signal (if any) so the caller can still cancel; abort ourselves once we have the snapshot.
  if (opts.signal) opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  try {
    for await (const u of sseEvents(streamUrlFor(entry, run), entry.token, { fetchImpl: opts.fetchImpl, signal: ac.signal })) {
      if (u.kind === 'snapshot') return u.model;
    }
  } finally {
    ac.abort(); // stop the stream (the snapshot is all we need for a one-shot status).
  }
  throw new Error(`remote run "${run}" produced no snapshot (${streamUrlFor(entry, run)}) — unknown run or server error`);
}

/** The remote SSE `RunUpdate` iterable to feed into `watch`'s injectable `updates` seam (identical stream). */
export function remoteUpdates(entry: ContextEntry, run: string, opts: RemoteOpts = {}): AsyncIterable<RunUpdate> {
  return sseEvents(streamUrlFor(entry, run), entry.token, opts);
}

/** The 202 body `POST /api/runs/start` returns (start-run.ts) — the run id + the stream URL to follow it. */
export interface StartRemoteResult {
  run: string;
  streamUrl?: string;
  runViewUrl?: string;
  runDir?: string | null;
}

/**
 * Launch a run on a remote serve: `POST <baseUrl>/api/runs/start` with the JSON `body` (the StartBody shape
 * the server accepts — `{templateDir|product+workflow, args, sandbox, executor, …}`) and the Bearer header.
 * Returns the parsed 202 body; throws with the server's `error` message on any non-2xx.
 */
export async function startRemoteRun(entry: ContextEntry, body: object, opts: RemoteOpts = {}): Promise<StartRemoteResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${entry.baseUrl.replace(/\/$/, '')}/api/runs/start`;
  const res = (await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(entry.token) },
    body: JSON.stringify(body),
    signal: opts.signal,
  })) as Response;
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch { /* non-JSON error body — surface it raw. */ }
    throw new Error(`remote start-run failed (${res.status}): ${msg}`);
  }
  return JSON.parse(text) as StartRemoteResult;
}
