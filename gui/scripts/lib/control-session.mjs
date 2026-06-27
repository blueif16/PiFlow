// The CONTROL-SESSION host — the dev-server-scoped runtime that holds one interactive `pi` per run and
// frames its stdio. Shared by the Vite plugin (gui/vite.config.ts control endpoints) and its test, so the
// load-bearing FRAMING contract is unit-testable without spawning. The plugin owns HTTP (route match, run
// resolution, SSE/POST courier); THIS owns the two load-bearing decisions: how we spawn the control pi, and
// how stdin/stdout bytes become / leave discrete JSON frames.
//
// TRANSPORT (evidence-verified, docs/design/control-session-streaming-evidence.md): pi's NATIVE `--mode rpc`
// over child stdio — NOT a custom `-e` extension. pi --mode rpc streams the FULL agent event firehose to
// stdout AND accepts JSON commands on stdin. This is SEPARATE from piflow's DAG nodes (which use `--mode
// json`); do NOT reuse the node command builder here.
//
// FRAMING: strict newline-delimited JSONL — split on `\n` ONLY and carry the trailing partial line across
// chunks. NEVER Node `readline` (it also splits on U+2028/U+2029, which is not protocol-compliant — the
// evidence calls this out). Each complete line is one JSON frame. Commands go out one JSON object per
// `\n`-terminated line.

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// The per-run conversation store. A run's control conversations are CO-LOCATED with the run in a DEDICATED
// dir (NOT piflow's own `<runDir>/.pi/` telemetry tree — avoid collision). pi writes/lists/resumes here via
// `--session-dir`; the history list reads exactly this dir. Runtime-verified (pi 0.79.10): a `.jsonl` per
// conversation appears here after a turn, and `--session <id>` / `switch_session` resume from it.
export const CONTROL_SESSION_SUBDIR = ".pi-control";
export const controlSessionDir = (runDir) => join(runDir, CONTROL_SESSION_SUBDIR);

// ----------------------------------------------------------------------------------------------------
// PURE helpers (no child, no I/O) — the framing/serialization contract the test pins.
// ----------------------------------------------------------------------------------------------------

/**
 * Strict `\n`-JSONL parse of one stdout chunk against the carried-over partial line.
 * Returns `{ frames, rest }`:
 *  - `frames`: every COMPLETE line (terminated by `\n`) parsed as JSON, in order. A blank line is skipped;
 *    a line that fails to parse is dropped (the bridge is a relay, not a validator — a single malformed
 *    line must not poison the stream).
 *  - `rest`: the trailing partial line (no terminating `\n` yet) to prepend to the NEXT chunk. A JSON
 *    object split across two `data` events therefore reassembles intact — the whole point of carry-partial.
 * `buffer` is the prior call's `rest` (start with ""); `chunk` is the new bytes as a string.
 */
export function parseJsonlChunk(buffer, chunk) {
  let buf = buffer + chunk;
  const frames = [];
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, ""); // tolerate CRLF; pi emits LF
    buf = buf.slice(i + 1);
    if (!line.trim()) continue; // skip blank/keepalive lines
    try {
      frames.push(JSON.parse(line));
    } catch {
      /* drop a single unparseable line — never throw on the relay path */
    }
  }
  return { frames, rest: buf };
}

/** Serialize one command object to the EXACT bytes written to the child's stdin: one JSON object,
 *  newline-terminated, no embedded newline (JSON.stringify escapes any newline inside string values). */
export function serializeCommand(obj) {
  return JSON.stringify(obj) + "\n";
}

/**
 * PURE header parse of one session `.jsonl`'s LEADING LINES into the summary the history list renders.
 * pi's session-format (runtime-verified, pi 0.79.10): line 1 is the header `{type:"session", id, timestamp,
 * cwd, version}`; an OPTIONAL `{type:"session_info", name}` and the first user `{type:"message", ...}` follow
 * (with intervening model_change/thinking_level_change entries). We scan a small prefix of lines — NOT the
 * whole file — for those three. `text` is the JSONL contents (or its first lines); returns the summary, or
 * `null` if there's no valid `type:"session"` header (malformed/empty → skip, NEVER throw).
 *
 * Returns `{ id, name, firstMessage }`:
 *   - `id`         — the session UUID (the stable selector pi accepts as `--session <id>`).
 *   - `name`       — the display name from a `session_info` entry, or null (then the list shows firstMessage).
 *   - `firstMessage` — the first USER message's text (trimmed/condensed), or null.
 * `mtime` is added by `listSessions` from the file stat (not in the file body).
 */
export function parseSessionHeader(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let header = null;
  let name = null;
  let firstMessage = null;
  let scanned = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (++scanned > 12) break; // the header/name/first-message live in the first handful of entries
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // a bad line never poisons the parse
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "session") {
      if (typeof entry.id === "string") header = entry; // the FIRST valid header wins
    } else if (entry.type === "session_info" && name === null && typeof entry.name === "string" && entry.name.trim()) {
      name = entry.name.trim();
    } else if (entry.type === "message" && firstMessage === null) {
      const msg = entry.message;
      if (msg && msg.role === "user") {
        const c = msg.content;
        const t = typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("")
            : "";
        const condensed = t.replace(/\s+/g, " ").trim();
        if (condensed) firstMessage = condensed.length > 140 ? condensed.slice(0, 139) + "…" : condensed;
      }
    }
    if (header && name !== null && firstMessage !== null) break; // got everything we render
  }
  if (!header) return null; // no valid session header ⇒ not a session file
  return { id: header.id, name, firstMessage };
}

// ----------------------------------------------------------------------------------------------------
// The session registry — one control pi per run, for the dev server's lifetime.
// ----------------------------------------------------------------------------------------------------

/** @typedef {{ v: number; type: string; [k: string]: unknown }} Frame */
/** @typedef {{
 *   run: string; runDir: string; child: import("node:child_process").ChildProcess;
 *   subscribers: Set<(frame: object) => void>; alive: boolean;
 *   pending: Map<string, { resolve: (f: object) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
 * }} Session */

// Module-scoped: the Vite dev server is one process, so this Map is the live session table. Keyed by run id.
/** @type {Map<string, Session>} */
const sessions = new Map();

/** The snapshot-on-(re)connect commands — replayed to the child whenever a new client subscribes so a late
 *  joiner re-bases from current state, then rides the live deltas. Matches the evidence's snapshot recipe. */
const SNAPSHOT_COMMANDS = [
  { type: "get_state" },
  { type: "get_messages" },
  { type: "get_session_stats" },
];

/** True iff a control session for `run` exists and its child is still alive. */
export function hasSession(run) {
  const s = sessions.get(run);
  return !!s && s.alive;
}

/**
 * Spawn (or reuse) the control pi for a run. cwd = the run folder; provider/model are INHERITED from the
 * user's pi config (~/.pi/agent/settings.json) — we deliberately omit --provider/--model so we never pin the
 * evidence's test gateway. Returns a small handle the start endpoint echoes. Idempotent: a second call for a
 * live run returns the existing handle (the registry holds ONE pi per run).
 *
 * `opts.resumeSessionId` (optional) spawns a DEAD-pi resume of a SPECIFIC conversation via pi's native
 * `--session <id>` (partial-UUID ok — runtime-verified). `opts.fresh` forces a brand-new conversation (no
 * resume flag) even if one was the latest. The run's conversations all live under `--session-dir
 * <runDir>/.pi-control` so the history list reads exactly that dir.
 */
export function startSession(run, runDir, opts = {}) {
  const existing = sessions.get(run);
  if (existing && existing.alive) return { run, pid: existing.child.pid, reused: true };

  const sessDir = controlSessionDir(runDir);
  try { mkdirSync(sessDir, { recursive: true }); } catch { /* pi also creates it; best-effort */ }

  // `pi --mode rpc` ONLY — no -p, no --mode json, no --provider/--model (inherit settings). Owning the
  // child's stdio is the whole transport. `--session-dir` co-locates every conversation with the run (pi's
  // OFFICIAL session storage — we never hand-roll persistence). `--session <id>` resumes a specific one.
  const args = ["--mode", "rpc", "--session-dir", sessDir];
  if (opts.resumeSessionId && !opts.fresh) args.push("--session", String(opts.resumeSessionId));
  const child = spawn("pi", args, {
    cwd: runDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  /** @type {Session} */
  const session = { run, runDir, child, subscribers: new Set(), alive: true, pending: new Map() };
  sessions.set(run, session);

  // DOWN-channel: stdout → strict `\n`-JSONL → fan each frame out to every subscriber. The partial-line
  // carry lives in `rest` across chunks (carry-partial — NOT readline).
  let rest = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const out = parseJsonlChunk(rest, chunk);
    rest = out.rest;
    for (const frame of out.frames) {
      // Resolve any host-side request awaiting THIS id (used by select/new to confirm pi's `response`,
      // and to read get_state.sessionFile for the active flag). Then fan out to subscribers as usual.
      if (frame && frame.type === "response" && typeof frame.id === "string") {
        const w = session.pending.get(frame.id);
        if (w) { session.pending.delete(frame.id); clearTimeout(w.timer); w.resolve(frame); }
      }
      emit(session, frame);
    }
  });

  // stderr is pi's diagnostics, not protocol — relay it as a generic frame so the GUI log can surface a
  // spawn/auth error instead of silently showing nothing.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) emit(session, { v: 1, type: "stderr", text });
  });

  const teardown = (reason) => {
    if (!session.alive) return;
    session.alive = false;
    for (const w of session.pending.values()) { clearTimeout(w.timer); w.reject(new Error(`session closed: ${reason}`)); }
    session.pending.clear();
    emit(session, { v: 1, type: "session_closed", reason });
    sessions.delete(run);
  };
  child.on("exit", (code, signal) => teardown(`exit code=${code} signal=${signal}`));
  child.on("error", (err) => teardown(`spawn error: ${String(err)}`));

  return { run, pid: child.pid, reused: false };
}

/** Forward a frame to every subscriber (best-effort; a throwing/closed subscriber must not break the fan-out
 *  to the others, nor block the agent). */
function emit(session, frame) {
  for (const cb of session.subscribers) {
    try {
      cb(frame);
    } catch {
      /* a slow/closed SSE peer must not poison the stream */
    }
  }
}

/**
 * Subscribe a callback to a session's frames. On subscribe we (re)trigger the snapshot so THIS client
 * re-bases — the child re-answers get_state/get_messages/get_session_stats and those `response` frames flow
 * back through `cb`. Returns an unsubscribe fn (also exported standalone as `unsubscribe`). Throws if no live
 * session — the caller (the stream endpoint) must `startSession` first.
 */
export function subscribe(run, cb) {
  const session = sessions.get(run);
  if (!session || !session.alive) throw new Error(`no live control session for run "${run}"`);
  session.subscribers.add(cb);
  // snapshot-on-connect: ask the child to re-emit current state for the new peer.
  for (const cmd of SNAPSHOT_COMMANDS) writeCommand(session, cmd);
  return () => unsubscribe(run, cb);
}

/** Remove a subscriber. Safe to call after teardown (no-op). */
export function unsubscribe(run, cb) {
  const session = sessions.get(run);
  if (session) session.subscribers.delete(cb);
}

/** After an in-process conversation switch (switch_session/new_session), tell every connected client to
 *  CLEAR its folded chat view (`session_rebase`), then re-run the snapshot so it re-bases onto the now-active
 *  conversation's history. Without the clear, switching would APPEND instead of REPLACE (the_bar #5). */
function resnapshot(session) {
  emit(session, { v: 1, type: "session_rebase" });
  for (const cmd of SNAPSHOT_COMMANDS) writeCommand(session, cmd);
}

/**
 * Send one command to the control pi's stdin. `obj` is a raw RPC command object (e.g. `{type:"prompt",
 * message}`); it's serialized to exactly one `\n`-terminated line. Returns `{ ok, status, body }` mirroring
 * the HTTP response the message endpoint sends, so the courier stays a dumb relay. We do NO semantic
 * validation of the verb — pi is the authority and answers each `id`-carrying command with a `response`
 * frame on the down-channel.
 */
export function sendCommand(run, obj) {
  const session = sessions.get(run);
  if (!session || !session.alive) return { ok: false, status: 404, body: { error: `no live control session for run "${run}"` } };
  if (!obj || typeof obj !== "object" || typeof obj.type !== "string")
    return { ok: false, status: 400, body: { error: "command must be an object with a string `type`" } };
  const wrote = writeCommand(session, obj);
  if (!wrote) return { ok: false, status: 502, body: { error: "control pi stdin is not writable" } };
  return { ok: true, status: 202, body: { ok: true } };
}

/** Low-level stdin write (one `\n`-terminated line). Returns false if stdin is gone. */
function writeCommand(session, obj) {
  const stdin = session.child.stdin;
  if (!stdin || !stdin.writable) return false;
  try {
    stdin.write(serializeCommand(obj));
    return true;
  } catch {
    return false;
  }
}

/** Send a command WITH an auto-assigned `id` and await pi's id-correlated `{type:"response", …}` frame.
 *  Used by select/new to confirm the switch and to read get_state.sessionFile. Rejects on timeout / dead stdin. */
let reqSeq = 0;
function request(session, cmd, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const id = `host-${++reqSeq}`;
    const timer = setTimeout(() => { session.pending.delete(id); reject(new Error(`RPC ${cmd.type} timed out`)); }, timeoutMs);
    session.pending.set(id, { resolve, reject, timer });
    if (!writeCommand(session, { ...cmd, id })) {
      session.pending.delete(id); clearTimeout(timer); reject(new Error("control pi stdin is not writable"));
    }
  });
}

/** The active conversation's session FILE for a live run (get_state.data.sessionFile), or null if not live /
 *  unavailable. The history list marks the entry whose id is in this path as active. */
async function activeSessionFile(run) {
  const session = sessions.get(run);
  if (!session || !session.alive) return null;
  try {
    const resp = await request(session, { type: "get_state" });
    const f = resp?.data?.sessionFile;
    return typeof f === "string" ? f : null;
  } catch { return null; }
}

/**
 * The CONVERSATION HISTORY list for a run — read `<runDir>/.pi-control/*.jsonl`, header-parse each (PURE
 * `parseSessionHeader`, leading lines only), and return `[{ id, name, firstMessage, mtime, active }]` sorted
 * by mtime desc. There is NO "list sessions" RPC — this direct disk read of pi's OWN session files is the
 * only sanctioned filesystem touch (official-practices). Malformed/empty files are skipped, never thrown.
 * `active` flags the entry whose id appears in the live pi's get_state.sessionFile (or none if not live).
 */
export async function listSessions(run, runDir) {
  const dir = controlSessionDir(runDir);
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  const activeFile = await activeSessionFile(run); // null if not live
  const out = [];
  for (const f of files) {
    const path = join(dir, f);
    let text, mtime;
    try { text = readFileSync(path, "utf8"); mtime = statSync(path).mtimeMs; } catch { continue; }
    const head = parseSessionHeader(text);
    if (!head) continue; // not a valid session file
    out.push({ ...head, mtime, active: !!activeFile && activeFile.endsWith(`${f}`) });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * CONTINUE an existing conversation. If a live pi exists for the run → switch IN-PROCESS via the native
 * `switch_session` RPC (param `sessionPath` — runtime-verified: get_messages then returns THAT conversation).
 * We resolve the partial/full `sessionId` to its file under `.pi-control` first (switch_session wants a path).
 * If no live pi → spawn a fresh one resuming that conversation via `--session <id>` (dead-pi path). Returns
 * `{ ok, mode, sessionId }`.
 */
export async function selectSession(run, runDir, sessionId) {
  if (typeof sessionId !== "string" || !sessionId.trim())
    return { ok: false, status: 400, body: { error: "sessionId required" } };
  const session = sessions.get(run);
  if (session && session.alive) {
    const path = resolveSessionPath(runDir, sessionId);
    if (!path) return { ok: false, status: 404, body: { error: `no session "${sessionId}" under ${CONTROL_SESSION_SUBDIR}` } };
    try {
      const resp = await request(session, { type: "switch_session", sessionPath: path });
      if (!resp.success) return { ok: false, status: 502, body: { error: resp.error || "switch_session failed" } };
      resnapshot(session); // re-base every connected SSE client onto the switched-to conversation
      return { ok: true, status: 200, body: { ok: true, mode: "switch_session", sessionId, cancelled: !!resp.data?.cancelled } };
    } catch (e) {
      return { ok: false, status: 502, body: { error: String(e) } };
    }
  }
  // dead pi → respawn resuming the chosen conversation
  try {
    const handle = startSession(run, runDir, { resumeSessionId: sessionId });
    return { ok: true, status: 202, body: { ok: true, mode: "respawn", sessionId, ...handle } };
  } catch (e) {
    return { ok: false, status: 500, body: { error: String(e) } };
  }
}

/**
 * START A FRESH conversation. Live pi → `new_session` RPC (the new `.jsonl` appears in `.pi-control` after the
 * first turn). No live pi → spawn fresh (no `--session`). The new conversation then shows up in listSessions.
 * Returns `{ ok, mode }`.
 */
export async function newChat(run, runDir) {
  const session = sessions.get(run);
  if (session && session.alive) {
    try {
      const resp = await request(session, { type: "new_session" });
      if (!resp.success) return { ok: false, status: 502, body: { error: resp.error || "new_session failed" } };
      resnapshot(session); // re-base every connected SSE client onto the fresh (empty) conversation
      return { ok: true, status: 200, body: { ok: true, mode: "new_session", cancelled: !!resp.data?.cancelled } };
    } catch (e) {
      return { ok: false, status: 502, body: { error: String(e) } };
    }
  }
  try {
    const handle = startSession(run, runDir, { fresh: true });
    return { ok: true, status: 202, body: { ok: true, mode: "spawn-fresh", ...handle } };
  } catch (e) {
    return { ok: false, status: 500, body: { error: String(e) } };
  }
}

/** Resolve a (partial) session id to its `.jsonl` file path under `.pi-control`, or null. switch_session
 *  needs a path; pi names files `<timestamp>_<uuid>.jsonl`, so we match the uuid as a substring of the name. */
function resolveSessionPath(runDir, sessionId) {
  const dir = controlSessionDir(runDir);
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return null; }
  // exact-id-in-header match is most precise; fall back to filename substring (pi embeds the uuid in the name).
  for (const f of files) {
    try {
      const head = parseSessionHeader(readFileSync(join(dir, f), "utf8"));
      if (head && head.id === sessionId) return join(dir, f);
    } catch { /* skip */ }
  }
  const byName = files.find((f) => f.includes(sessionId));
  return byName ? join(dir, byName) : null;
}

/** Stop a session: end stdin, kill the child's process group, drop it from the registry. Idempotent. */
export function stopSession(run) {
  const session = sessions.get(run);
  if (!session) return { ok: true, status: 200, body: { ok: true, already: true } };
  session.alive = false;
  try { session.child.stdin?.end(); } catch { /* already closed */ }
  try { session.child.kill(); } catch { /* already dead */ }
  sessions.delete(run);
  return { ok: true, status: 200, body: { ok: true } };
}
