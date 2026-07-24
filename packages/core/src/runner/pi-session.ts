// pi-session.ts — the ONE home for locating + reading a PI node's NATIVE session (`.pi/sessions/*.jsonl`).
//
// SCOPE: this module is PI-SPECIFIC by design — the `.pi/sessions` dir, the `_<sessionId>.jsonl` filename
// convention and the `{type:'message'}` record schema below are pi's, and no other executor writes them. It
// is consumed by the `pi` adapter of the transcript port (observe/transcript-pi.ts); a claude-code (or any
// future) node reaches its own record through ITS adapter, never through here. Do NOT add an executor branch
// to this file — register a `transcript` on that executor's driver instead (observe/transcript.ts).
//
// pi persists each per-node session as `<sessionDir>/<ISO-timestamp>_<sessionId>.jsonl` (openclaw
// session-manager). The timestamp prefix is minted by pi, so PIFLOW never knows the exact filename a-priori —
// it must LOCATE the file by the `_<sessionId>.jsonl` suffix (the sessionId is the node id). This module is
// that locator PLUS the transcoder that turns a native session into the pi STREAM events the observe reducers
// fold — shared by BOTH sides of the fix so there is no duplicated transcoding logic:
//   • WRITE path (node-lifecycle warm-resume): locate the file so the resume passes a RESOLVABLE `--session
//     <abs-path>` reference instead of the bare id pi cannot resolve under a custom `--session-dir` (it
//     classifies a bare-id session in a foreign dir as a "different project" and prompts to fork — a prompt
//     that hangs a headless `pi -p`, starving the node's events.jsonl).
//   • READ path (observe/runView + runner/logs): recover a node's real model/tool/token signal from the
//     native session when events.jsonl carried no model turns (a starved session-only node).

import fssync from 'node:fs';
import path from 'node:path';
import type { PiEvent } from './events.js';
import { piSessionsDir, nodeEventsFile } from './layout.js';

/** Locate a node's pi session file. pi mints it as `<sessionDir>/<ISO-timestamp>_<sessionId>.jsonl`
 *  (session-manager.js) — the ISO-8601 timestamp prefix is opaque, so we match the `_<sessionId>.jsonl`
 *  SUFFIX (the sessionId is the node id) and, if several runs left one, take the latest (lexical order of
 *  the ISO prefix == chronological). Returns an ABSOLUTE path, or null when the dir/file is absent. */
export function locatePiSessionFile(sessionDir: string, sessionId: string): string | null {
  let entries: string[];
  try { entries = fssync.readdirSync(sessionDir); } catch { return null; }
  const suffix = `_${sessionId}.jsonl`;
  const hits = entries.filter((f) => f.endsWith(suffix)).sort();
  const pick = hits[hits.length - 1];
  return pick ? path.join(sessionDir, pick) : null;
}

/**
 * Archive aside a node's EXISTING pi session file (if any) so a subsequent COLD attempt's `--session-id
 * <id>` truly mints a fresh file. pi's own CLI resolves `--session-id` as GET-OR-CREATE, not create-only:
 * `createSessionManager` (dist/main.js, @earendil-works/pi-coding-agent) calls `findLocalSessionByExactId`
 * FIRST and `SessionManager.open`s a match rather than creating (documented in `dist/cli/args.js` as "Use
 * exact project session ID, creating it if missing") — so a stale file left by an EARLIER attempt (a
 * `--rerun` of an already-executed node, a cold same-model retry, an escalation) makes pi silently RE-OPEN
 * that prior conversation instead of starting fresh, even though the caller believes `--session-id` always
 * creates. Renaming the file so it no longer ends in the `_<sessionId>.jsonl` suffix (both pi's own lookup
 * and `locatePiSessionFile` scan for) is what makes the NEXT `--session-id <id>` genuinely mint a new file.
 * SUPERSEDES, never deletes — the read-path recovery below + a human can still find the archived content.
 * No-op (returns null) when there is nothing to archive (a node's first-ever attempt, the common case).
 */
export function supersedeStaleSession(sessionDir: string, sessionId: string): string | null {
  const existing = locatePiSessionFile(sessionDir, sessionId);
  if (!existing) return null;
  const archived = `${existing}.superseded-${Date.now()}.bak`;
  try {
    fssync.renameSync(existing, archived);
  } catch {
    return null;
  }
  return archived;
}

/** Transcode a pi native-session file into the pi STREAM-event vocabulary the reducer folds. Each
 *  assistant `message` record becomes a `message_end` (its nested `message` carries role/model/usage/
 *  stopReason verbatim, exactly what the reducer reads), and its `thinking`/`toolCall` content blocks become
 *  `thinking_delta`/`tool_execution_start` events (thinking volume + tool calls, incl. `args.path`/`offset`/
 *  `limit` for the context-composition reducer). Best-effort per line. */
export function transcodePiSession(file: string): PiEvent[] {
  let raw: string;
  try { raw = fssync.readFileSync(file, 'utf8'); } catch { return []; }
  const out: PiEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let r: { type?: string; message?: { role?: string; content?: unknown[] } };
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type !== 'message' || !r.message || r.message.role !== 'assistant') continue;
    const content = Array.isArray(r.message.content) ? r.message.content : [];
    for (const b of content) {
      const blk = b as { type?: string; thinking?: unknown; name?: unknown; arguments?: unknown; id?: unknown };
      if (blk.type === 'thinking' && typeof blk.thinking === 'string') {
        out.push({ type: 'thinking_delta', delta: blk.thinking } as unknown as PiEvent);
      } else if (blk.type === 'toolCall' && typeof blk.name === 'string') {
        out.push({ type: 'tool_execution_start', toolName: blk.name, args: blk.arguments, toolCallId: blk.id } as unknown as PiEvent);
      }
    }
    out.push({ type: 'message_end', message: r.message } as unknown as PiEvent);
  }
  return out;
}

/** Does an events.jsonl replay carry any REAL model/tool activity? A starved session-only node's archive
 *  holds only a `stderr`/`raw` line (e.g. pi's "No session found matching '<id>'") — no model turn, no tool
 *  call — so the observe reducers see a false zero. `false` ⇒ recover from the native session. Mirrors the
 *  runView backfill gate (`coverage.usageEvents === 0`) at the raw-event level the CLI readers work over. */
export function eventsHaveModelActivity(events: PiEvent[]): boolean {
  return events.some((e) => {
    const t = (e as { type?: string }).type;
    return t === 'message_end' || t === 'message_start' || t === 'message_update' || t === 'tool_execution_start';
  });
}

/** The subset of a run.json node record this module needs to locate + gate a session recovery. */
export interface SessionRef {
  sessionId?: string;
  sessionDir?: string;
  /** An authoritative executor usage rollup (e.g. Claude's `result` event). When present, NEVER recover —
   *  the archive's zero is not a false zero, it is just a driver that doesn't tee model turns. */
  usage?: unknown;
}

/** Locate + transcode a node's native pi session into stream events, or null when there is no session (or it
 *  holds no model turn). Reused by every recovery caller so the suffix-match + transcode live in ONE place. */
export function recoverNodeEvents(runDir: string, ref: SessionRef, nodeId: string): PiEvent[] | null {
  if (ref.usage) return null;
  const sessionId = ref.sessionId ?? nodeId;
  const dir = ref.sessionDir && ref.sessionDir.trim() ? ref.sessionDir : piSessionsDir(runDir);
  const file = locatePiSessionFile(dir, sessionId);
  if (!file) return null;
  const events = transcodePiSession(file);
  return events.length ? events : null;
}

/** Parse one node's events.jsonl into PiEvent[] (order-preserving, torn lines skipped). Exported because the
 *  transcript adapters need the RAW archive separately from the recovery decision, so they can report which
 *  source their answers came from (`TranscriptSource.origin()`). */
export function parseNodeEventsFile(file: string): PiEvent[] {
  let raw: string;
  try { raw = fssync.readFileSync(file, 'utf8'); } catch { return []; }
  const out: PiEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as PiEvent); } catch { /* skip a torn line */ }
  }
  return out;
}

/**
 * Read one node's ordered pi events for the OBSERVE reducers, RECOVERING from the pi native session when the
 * events.jsonl archive is STARVED (a session-only node whose stdout tee carried no model turns). The archive
 * is authoritative whenever it has activity; only a truly starved archive falls back to the session. `ref`
 * supplies the session id/dir (from run.json); omit fields to default to `<runDir>/.pi/sessions` + `nodeId`.
 * Returns the archive events untouched on the happy path, so a normal captured run is byte-identical.
 */
export function readNodeObserveEvents(runDir: string, nodeId: string, ref: SessionRef = {}): PiEvent[] {
  const events = parseNodeEventsFile(nodeEventsFile(runDir, nodeId));
  if (eventsHaveModelActivity(events)) return events;
  const recovered = recoverNodeEvents(runDir, ref, nodeId);
  return recovered ?? events;
}
