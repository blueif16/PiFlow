// `docker logs` for a workflow run. Reads the per-node event archives (the canonical
// `.pi/nodes/<id>/events.jsonl`, written by ./events.ts) + `.pi/run.json` (the run-status digest) and
// renders them as a concise, scannable stream — a one-shot replay, or a live `-f` follow that attaches
// to the run and streams every node as it advances. The DISTILLER turns the raw `pi --mode json`
// firehose into one line per meaningful action (a tool call + its target, a thinking/text summary,
// errors), so a run's behaviour is legible at a glance — and, crucially, a node that emits TEXT instead
// of CALLING a write tool (the cheap-model "never-write" failure) shows up immediately as a `␃ says`
// line with no `▸ write` beside it.
//
// All paths come from @piflow/core's `.pi/` layout helpers (the SAME ones observe/{read,watch}.ts and
// the NodeRecorder write side use) — one layout, one source of truth, never a hardcoded path.

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { nodeEventsFile, runJsonFile } from './layout.js';
import type { PiEvent } from './events.js';
import { readNodeObserveEvents, type SessionRef } from './pi-session.js';
import { builtinDrivers, type DriverTable } from './drivers/table.js';
import { WRITE_KINDS, type TranscriptSource } from '../observe/transcript.js';

/** A node's event archive — the canonical `.pi/nodes/<id>/events.jsonl` (re-export of the layout helper). */
export function eventsPath(outDir: string, nodeId: string): string {
  return nodeEventsFile(outDir, nodeId);
}
/** The run-status digest — the canonical `.pi/run.json` (re-export of the layout helper). */
export function statusFilePath(outDir: string): string {
  return runJsonFile(outDir);
}

/** pi nests the per-token event either under `assistantMessageEvent` or (older) `event`. */
function inner(ev: PiEvent): PiEvent | undefined {
  const a = ev.assistantMessageEvent ?? (ev.type === 'message_update' ? ev.event : undefined);
  return (a && typeof a === 'object') ? (a as PiEvent) : undefined;
}

function oneLine(s: unknown, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function argTail(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  if (typeof a.path === 'string') return ` ${a.path}`;
  if (typeof a.command === 'string') return ` ${oneLine(a.command, 80)}`;
  const keys = Object.keys(a);
  return keys.length ? ` {${keys.join(',')}}` : '';
}

/**
 * A stateful event→lines distiller. Stateful because a turn's thinking/text arrives as many deltas
 * that must be accumulated and flushed as ONE summary line at its `*_end` (or at `flush()` if the
 * stream was cut off mid-turn). `feed` returns the lines a single event produced (usually none).
 * The follow loop drives one distiller per node; `distillEvents` runs a whole list through one.
 */
export function makeDistiller(): { feed(ev: PiEvent): string[]; flush(): string[] } {
  let think = '';
  let text = '';
  const thinkLine = (): string => `  … thinking (${think.length} chars): ${oneLine(think, 100)}`;
  const textLine = (): string => `  ␃ says (${text.length} chars): ${oneLine(text, 160)}`;
  return {
    feed(ev: PiEvent): string[] {
      const a = inner(ev);
      const kind = (a?.type ?? ev.type) as string | undefined;
      const out: string[] = [];
      switch (kind) {
        case 'tool_execution_start':
          out.push(`▸ ${String(ev.toolName ?? '?')}${argTail(ev.args)}`);
          break;
        case 'thinking_delta':
          if (typeof a?.delta === 'string') think += a.delta;
          break;
        case 'thinking_end':
          if (think.trim()) out.push(thinkLine());
          think = '';
          break;
        case 'text_delta':
          if (typeof a?.delta === 'string') text += a.delta;
          break;
        case 'text_end':
          if (text.trim()) out.push(textLine());
          text = '';
          break;
        case 'stderr':
          out.push(`  ✕ ${oneLine(ev.text, 200)}`);
          break;
        case 'raw':
          out.push(`  · ${oneLine(ev.text, 200)}`);
          break;
        default:
          break;
      }
      return out;
    },
    flush(): string[] {
      const out: string[] = [];
      if (think.trim()) out.push(thinkLine());
      if (text.trim()) out.push(textLine());
      think = '';
      text = '';
      return out;
    },
  };
}

/** Fold an event LIST into concise display lines (one distiller, then flush). Deterministic. */
export function distillEvents(events: PiEvent[]): string[] {
  const d = makeDistiller();
  const out: string[] = [];
  for (const ev of events) out.push(...d.feed(ev));
  out.push(...d.flush());
  return out;
}

export function parseEventsFile(file: string): PiEvent[] {
  if (!existsSync(file)) return [];
  const evs: PiEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { evs.push(JSON.parse(line) as PiEvent); } catch { /* skip a torn line */ }
  }
  return evs;
}

/** One-shot: the distilled (or `--raw`) lines for one node. `--raw` prints the literal archive bytes (no
 *  recovery — that is the audit view); the distilled view RECOVERS a starved archive from the native session
 *  (a session-only node) so the one-shot replay isn't near-empty. `ref` supplies the session id/dir. */
export function tailNode(outDir: string, nodeId: string, opts: { raw?: boolean; ref?: SessionRef } = {}): string[] {
  const file = eventsPath(outDir, nodeId);
  if (opts.raw) return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  return distillEvents(readNodeObserveEvents(outDir, nodeId, opts.ref ?? {}));
}

/** Pull the session-recovery ref (id/dir) off a run-status node record. */
function sessionRef(n: StatusNode): SessionRef {
  return { sessionId: n.sessionId, sessionDir: n.sessionDir };
}

interface StatusNode {
  id: string;
  status: string;
  exitCode?: number;
  killedTimeout?: boolean;
  killedStall?: boolean;
  killedToolLoop?: boolean;
  killedIdle?: boolean;
  durationMs?: number;
  artifacts?: { path: string; exists: boolean; bytes?: number }[];
  /** The node's native session (id/dir) — the source an executor's transcript adapter falls back to when
   *  the events.jsonl archive is starved or lossy (run 260715-02/plan). Absent ⇒ no fallback. */
  sessionId?: string;
  sessionDir?: string;
  /** (P3) The stamped executor/driver id — the key that routes this node to its transcript adapter. Absent
   *  on a pre-P3 record ⇒ `DriverTable.get(undefined)` defaults to `pi`, the historical behaviour. */
  driverId?: string;
}
interface StatusShape {
  run?: string;
  done?: boolean;
  ok?: boolean | null;
  nodes?: Record<string, StatusNode>;
}
function readStatus(outDir: string): StatusShape | null {
  try { return JSON.parse(readFileSync(statusFilePath(outDir), 'utf8')) as StatusShape; } catch { return null; }
}
/** Nodes that have started (running or terminal) — the ones with an archive worth streaming, in order. */
function activeNodeIds(st: StatusShape | null): string[] {
  return Object.values(st?.nodes ?? {}).filter((n) => n.status !== 'pending').map((n) => n.id);
}

// ── post-run diagnosis (`piflowctl logs --summary`) ────────────────────────────────────────────────────
// Correlate run-status (the verdict + declared artifacts) with the event archive (what the model
// actually did) into a one-glance per-node diagnosis. The headline case it makes obvious: a node that
// exits clean but writes nothing — the never-write — surfaced as `0 writes · missing <artifact>` with
// the model's own last words attached.

export interface NodeDiagnosis {
  id: string;
  status: string;
  exitCode?: number;
  killed?: 'timeout' | 'stall' | 'tool-loop' | 'idle';
  durationMs?: number;
  writes: number;   // write/edit tool calls
  reads: number;    // read tool calls
  tools: number;    // all tool calls
  missing: string[]; // declared artifacts NOT on disk
  lastSay: string;   // the model's last emitted text (the smoking gun on a never-write)
  stderr: string[];
  note: string;      // the one-line diagnosis
  /** Set when the node's executor adapter CANNOT read this node's record — the reason, verbatim. When
   *  present, `writes`/`reads`/`tools` are UNKNOWN, not zero, and the renderer prints `?w/?r/?t`. */
  blind?: string;
}

/**
 * Tally one node's activity from the shared transcript vocabulary — EXECUTOR-BLIND. `writes`/`reads`/`tools`
 * come from the port's op KINDS, so a claude-code `Write` counts exactly like a pi `write` without this
 * function knowing either name. (Pre-port this switched on pi's lowercase tool names against pi's flat
 * events, which is why every claude node reported `0w/0r/0t` — a zero that reads like a never-write verdict
 * on a node that had written three files.)
 *
 * `stderr` stays on the RAW events: it is a piflow CAPTURE artifact (the runner's own stderr tee), not part
 * of any executor's model transcript, so it has no place in the port's vocabulary.
 */
function countNode(source: TranscriptSource, events: PiEvent[]): Pick<NodeDiagnosis, 'writes' | 'reads' | 'tools' | 'lastSay' | 'stderr'> {
  let writes = 0, reads = 0;
  const ops = source.ops();
  for (const op of ops) {
    if (WRITE_KINDS.has(op.kind)) writes++;
    else if (op.kind === 'read') reads++;
  }
  // the model's LAST non-empty utterance — the smoking gun beside a zero write count.
  let lastSay = '';
  for (const t of source.turns()) if (t.text.trim()) lastSay = t.text;
  const stderr: string[] = [];
  for (const ev of events) if (ev.type === 'stderr' && typeof ev.text === 'string') stderr.push(ev.text);
  return { writes, reads, tools: ops.length, lastSay, stderr };
}

/**
 * Read a run dir → a per-node diagnosis (run-status ⋈ the node's transcript). Pure over the files.
 * `drivers` defaults to `builtinDrivers()`; each node routes to ITS executor's transcript adapter by the
 * stamped `driverId`, so the tally is honest for every registered executor and an unknown/unread one reports
 * `SKIP` rather than zeros.
 */
export function diagnoseRun(outDir: string, drivers: DriverTable = builtinDrivers()): { run?: string; done?: boolean; ok?: boolean | null; nodes: NodeDiagnosis[] } {
  const st = readStatus(outDir);
  const nodes: NodeDiagnosis[] = [];
  for (const n of Object.values(st?.nodes ?? {})) {
    if (n.status === 'pending') continue;
    // Route to the node's OWN executor adapter (which owns its source policy — e.g. pi recovers a starved
    // events.jsonl from its native session; claude-code prefers its native transcript over the lossy archive).
    const source = drivers.transcriptFor(n.driverId, outDir, n.id, sessionRef(n));
    const c = countNode(source, readNodeObserveEvents(outDir, n.id, sessionRef(n)));
    const blind = source.capabilities().ops ? null : source.limitation('ops');
    const missing = (n.artifacts ?? []).filter((a) => !a.exists).map((a) => a.path);
    const killed = n.killedTimeout ? 'timeout' : n.killedStall ? 'stall' : n.killedToolLoop ? 'tool-loop' : n.killedIdle ? 'idle' : undefined;
    let note: string;
    if (n.status === 'ok' || n.status === 'reused') note = 'ok';
    else if (killed) note = `killed: ${killed === 'timeout' ? 'node-timeout' : killed === 'stall' ? 'silent-stall' : killed === 'idle' ? 'idle-watchdog (request silent, re-execs exhausted)' : 'tool-loop (identical-args)'}`;
    // The never-write verdict is a claim about what the model DID — only assertable when the transcript is
    // actually readable. With a blind source the counts are unknown, not zero, so we say that instead.
    else if (blind) note = `SKIP: ${blind}`;
    else if (c.writes === 0 && missing.length && c.lastSay) note = 'never-write: emitted text but called NO write tool';
    else if (missing.length) note = `missing ${missing.length} declared artifact(s)`;
    else note = n.status;
    nodes.push({ id: n.id, status: n.status, exitCode: n.exitCode, killed, durationMs: n.durationMs, ...c, missing, note, ...(blind ? { blind } : {}) });
  }
  return { run: st?.run, done: st?.done, ok: st?.ok, nodes };
}

/** Render `diagnoseRun` as concise, scannable lines. */
export function renderDiagnosis(d: ReturnType<typeof diagnoseRun>): string[] {
  const out: string[] = [];
  const ok = (s: string): boolean => s === 'ok' || s === 'reused';
  out.push(`run ${d.run ?? '?'} — ${d.done ? (d.ok ? 'DONE ✓' : 'FAILED ✕') : 'running…'}  (${d.nodes.length} node(s))`);
  for (const n of d.nodes) {
    const mark = ok(n.status) ? '✓' : '✕';
    const secs = n.durationMs != null ? ` ${Math.round(n.durationMs / 1000)}s` : '';
    // A blind source renders `?w/?r/?t` — an UNKNOWN is not a zero, and `0w/0r/0t` on an unreadable node is
    // the exact false finding the transcript port exists to prevent.
    const tally = n.blind ? '?w/?r/?t' : `${n.writes}w/${n.reads}r/${n.tools}t`;
    out.push(`${mark} ${n.id}  [${n.status}${n.exitCode != null ? ` exit ${n.exitCode}` : ''}${secs}] — ${tally} · ${n.note}`);
    if (n.missing.length) out.push(`    missing: ${n.missing.join(', ')}`);
    if (!ok(n.status) && n.lastSay) out.push(`    last said: ${oneLine(n.lastSay, 200)}`);
    if (n.stderr.length) out.push(`    stderr: ${oneLine(n.stderr.join(' '), 200)}`);
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface FollowOpts {
  node?: string;
  raw?: boolean;
  pollMs?: number;
  print?: (line: string) => void;
  /** Test seam: stop after this many polls regardless (default: until status.done). */
  maxPolls?: number;
}

/**
 * Live follow — `docker logs -f` for the run. Tails the events archive of every started node (or just
 * `opts.node`), printing newly-appended distilled lines prefixed `[<node>]`, until the run is `done`.
 * "Attach to the workflow and stream wherever it's processing" = pump all started nodes each tick.
 */
export async function followRun(outDir: string, opts: FollowOpts = {}): Promise<void> {
  const poll = opts.pollMs ?? 700;
  const print = opts.print ?? ((s) => process.stdout.write(s + '\n'));
  const offsets = new Map<string, number>();                 // byte offset already consumed, per node
  const carry = new Map<string, string>();                   // partial trailing line, per node
  const distillers = new Map<string, ReturnType<typeof makeDistiller>>();
  const ended = new Set<string>();                           // nodes already flushed

  const pump = (nodeId: string): void => {
    const file = eventsPath(outDir, nodeId);
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    const from = offsets.get(nodeId) ?? 0;
    if (size <= from) return;
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    closeSync(fd);
    offsets.set(nodeId, size);
    const lines = ((carry.get(nodeId) ?? '') + buf.toString('utf8')).split('\n');
    carry.set(nodeId, lines.pop() ?? '');
    if (!distillers.has(nodeId)) distillers.set(nodeId, makeDistiller());
    const d = distillers.get(nodeId)!;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (opts.raw) { print(`[${nodeId}] ${line}`); continue; }
      let ev: PiEvent;
      try { ev = JSON.parse(line) as PiEvent; } catch { continue; }
      for (const out of d.feed(ev)) print(`[${nodeId}] ${out}`);
    }
  };

  let polls = 0;
  for (;;) {
    const st = readStatus(outDir);
    const targets = opts.node ? [opts.node] : activeNodeIds(st);
    for (const id of targets) pump(id);
    // flush a node's distiller once it reaches a terminal status (surface a cut-off thinking/text).
    for (const n of Object.values(st?.nodes ?? {})) {
      if (n.status !== 'pending' && n.status !== 'running' && !ended.has(n.id)) {
        pump(n.id);
        const d = distillers.get(n.id);
        if (d) for (const out of d.flush()) print(`[${n.id}] ${out}`);
        ended.add(n.id);
      }
    }
    polls += 1;
    if (st?.done) break;
    if (opts.maxPolls != null && polls >= opts.maxPolls) break;
    await sleep(poll);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────
// Resolve a positional that is EITHER a run dir (holds the .pi/ layout) OR a bare run id (→ out/<id>).
function resolveOutDir(arg: string | undefined): string {
  const a = arg && arg.trim() ? arg : '.';
  if (existsSync(statusFilePath(a))) return path.resolve(a);
  const guess = path.join('out', a);
  if (existsSync(statusFilePath(guess))) return path.resolve(guess);
  return path.resolve(a);
}

export const LOGS_USAGE = `piflowctl logs <rundir|run> [nodeId] [options]  — stream / replay / diagnose a run

  <rundir|run>  a run dir (holds .pi/) OR a bare run id (→ out/<id>)
  [nodeId]      restrict to one node (positional, like status/telemetry/trace); omit for all started nodes

OPTIONS
  -f, --follow    watch the run live (docker logs -f)
  --summary       one-glance post-run diagnosis (the never-write made obvious)
  --node <id>     alternative to the positional nodeId
  --raw           print the raw event lines, undistilled
  --poll <ms>     follow poll interval
  -h, --help      print this usage`;

export interface ParsedLogsArgs {
  dir?: string;
  node?: string;
  follow: boolean;
  raw: boolean;
  summary: boolean;
  pollMs?: number;
  help: boolean;
}

/** Parse `[dir|run] [nodeId] [--node <id>] [-f|--follow] [--raw] [--summary] [--poll <ms>] [--help]`.
 *  Positionals bind `<rundir> [nodeId]` — the SAME shape status/telemetry/trace use — so the second
 *  positional is the node (an explicit `--node` still wins). Previously the last positional overwrote the
 *  dir, dropping the rundir; `--help` had no home and fell through to run-dir resolution. */
export function parseLogsArgs(argv: string[]): ParsedLogsArgs {
  const out: ParsedLogsArgs = { follow: false, raw: false, summary: false, help: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '-f' || k === '--follow') out.follow = true;
    else if (k === '--raw') out.raw = true;
    else if (k === '--summary') out.summary = true;
    else if (k === '-h' || k === '--help') out.help = true;
    else if (k === '--node') out.node = argv[++i];
    else if (k === '--poll') out.pollMs = Number(argv[++i]);
    else if (!k.startsWith('-')) positionals.push(k);
  }
  if (positionals[0]) out.dir = positionals[0];
  if (out.node === undefined && positionals[1]) out.node = positionals[1];
  return out;
}

/** The body behind `piflowctl logs` — see `parseLogsArgs` / `LOGS_USAGE`. */
export async function runLogsCli(argv: string[]): Promise<void> {
  const a = parseLogsArgs(argv);
  if (a.help) {
    process.stdout.write(LOGS_USAGE + '\n');
    return;
  }
  const outDir = resolveOutDir(a.dir);
  if (!existsSync(statusFilePath(outDir))) {
    process.stderr.write(`piflowctl logs: no .pi/run.json under ${outDir}\n`);
    process.exitCode = 1;
    return;
  }
  if (a.summary) {
    for (const line of renderDiagnosis(diagnoseRun(outDir))) process.stdout.write(line + '\n');
    return;
  }
  if (a.follow) {
    await followRun(outDir, { node: a.node, raw: a.raw, pollMs: a.pollMs });
    return;
  }
  const st = readStatus(outDir);
  const ids = a.node ? [a.node] : activeNodeIds(st);
  for (const id of ids) {
    const rec = st?.nodes?.[id];
    for (const line of tailNode(outDir, id, { raw: a.raw, ref: rec ? sessionRef(rec) : undefined })) {
      process.stdout.write(`[${id}] ${line}\n`);
    }
  }
}
