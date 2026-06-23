// Per-node event-stream capture — the observability backbone. The runner taps each node's agent
// stdout (the `pi --mode json` event stream), SLIMS it (drops the heavy cumulative message
// snapshots + truncates large tool results), stamps a node-relative clock, and appends one JSON
// event per line to the canonical `.pi/nodes/<id>/events.jsonl` (the `nodeEventsFile` layout helper).
// That archive is what makes a run observable post-hoc and tail-able live — the SAME path the shared
// observe stream (observe/watch.ts) tails and the `piflow logs` reader (./logs.ts) replays.
//
// It is execRunner-AGNOSTIC: the runner wraps the Sandbox with `recordingSandbox` BEFORE handing it
// to the (injectable) execRunner, so the tap survives any custom exec primitive. The wrap CHAINS the
// caller's own onStdout/onStderr (the watchdog's silent-stall `touch`) — recording is purely
// additive and can never disable the kill seam.

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { nodeEventsFile } from './layout.js';
import type { Sandbox, ExecOpts, ExecResult, ProcessHandle } from '../types.js';

/** A pi `--mode json` event — loosely shaped on purpose (we forward, we don't own the schema). */
export type PiEvent = Record<string, unknown>;

/** A live sink for parsed events (the TUI/GUI push seam). Never throws into the run. */
export type EventSink = (nodeId: string, event: PiEvent) => void;

/** Hard cap on one archived line so a runaway tool result / snapshot can't bloat the log. */
const MAX_LINE = 8192;
/** Tool-result payloads (file reads) get truncated to this before archiving. */
const MAX_RESULT = 2048;

/**
 * Slim ONE parsed event for the archive. The killer of size is the cumulative `message` snapshot pi
 * re-embeds on EVERY event (`message_update` per token, `turn_*`/`message_*` per turn) — the whole
 * accumulated transcript, re-sent each delta; that redundancy is what makes a raw stream 100s of MB.
 * The unique content lives in the per-event `delta` (and the bounded tool fields), so we strip the
 * snapshot everywhere, drop the `assistantMessageEvent.partial` cumulative on a delta, and truncate a
 * large `tool_execution_end` result. Returns `ev` UNCHANGED (same ref) when there is nothing to slim.
 */
export function slimEvent(ev: PiEvent): PiEvent | null {
  if (!ev || typeof ev !== 'object') return null;
  const a = ev.assistantMessageEvent as Record<string, unknown> | undefined;
  const hasMessage = 'message' in ev;
  const hasPartial = !!a && typeof a === 'object' && 'partial' in a;
  const bigResult = ev.type === 'tool_execution_end' && 'result' in ev;
  if (!hasMessage && !hasPartial && !bigResult) return ev; // nothing to strip — pass through
  const out: PiEvent = { ...ev };
  if (hasMessage) delete out.message;
  if (hasPartial) { const ae = { ...a }; delete ae.partial; out.assistantMessageEvent = ae; }
  if (bigResult) out.result = truncResult(out.result);
  return out;
}

function truncResult(result: unknown): unknown {
  try {
    const s = JSON.stringify(result);
    return s.length <= MAX_RESULT ? result : { truncated: true, preview: s.slice(0, MAX_RESULT) };
  } catch {
    return { truncated: true };
  }
}

/**
 * Buffers an agent's raw stdout chunks into whole lines, slims each, stamps `_t` (ms since the
 * recorder opened) + `_rt` (wall ISO), appends to the events file, and pushes the parsed event to
 * an optional live sink. One per node; `close()` flushes the trailing partial line. The write stream
 * is opened LAZILY (first event), so a node that emits nothing leaves no empty file.
 */
export class NodeRecorder {
  private stream: WriteStream | null = null;
  private buf = '';
  private readonly t0 = Date.now();
  constructor(
    private readonly outDir: string,
    private readonly nodeId: string,
    private readonly onEvent?: EventSink,
  ) {}

  feedStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.writeLine(line);
    }
  }

  feedStderr(chunk: string): void {
    const text = String(chunk).trim();
    if (text) this.emit({ type: 'stderr', text });
  }

  private writeLine(line: string): void {
    const s = line.trim();
    if (!s) return;
    let ev: PiEvent;
    try { ev = JSON.parse(s) as PiEvent; } catch { ev = { type: 'raw', text: s }; }
    this.emit(ev);
  }

  private emit(ev: PiEvent): void {
    const synthetic = ev.type === 'raw' || ev.type === 'stderr';
    const slim = synthetic ? ev : slimEvent(ev);
    if (!slim) return;
    slim._t = Date.now() - this.t0;
    slim._rt = new Date().toISOString();
    let out = JSON.stringify(slim);
    if (out.length > MAX_LINE) out = out.slice(0, MAX_LINE);
    try { this.ensure().write(out + '\n'); } catch { /* best-effort archive — never break the run */ }
    if (this.onEvent) { try { this.onEvent(this.nodeId, slim); } catch { /* a bad sink never breaks the run */ } }
  }

  private ensure(): WriteStream {
    if (this.stream) return this.stream;
    // Append to the CANONICAL `.pi/nodes/<id>/events.jsonl` — the SAME `nodeEventsFile` path
    // observe/watch.ts tails — so a live run streams node-events end-to-end (closing the write side
    // that writeStatus already opened for `.pi/run.json`).
    const file = nodeEventsFile(this.outDir, this.nodeId);
    mkdirSync(path.dirname(file), { recursive: true });
    this.stream = createWriteStream(file);
    return this.stream;
  }

  /** Flush the trailing partial line and end the stream; resolves once the bytes are on disk. */
  close(): Promise<void> {
    if (this.buf.trim()) { this.writeLine(this.buf); this.buf = ''; }
    const s = this.stream;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => { try { s.end(() => resolve()); } catch { resolve(); } });
  }
}

function wrapOpts(opts: ExecOpts | undefined, recorder: NodeRecorder): ExecOpts {
  const o = opts ?? {};
  return {
    ...o,
    onStdout: (chunk: string) => { recorder.feedStdout(chunk); o.onStdout?.(chunk); },
    onStderr: (chunk: string) => { recorder.feedStderr(chunk); o.onStderr?.(chunk); },
  };
}

/**
 * Wrap a Sandbox so every `exec`/`spawn` tees its stdout/stderr into `recorder` WHILE still
 * forwarding the caller's own onStdout/onStderr — recording is additive, never a kill-seam
 * regression. All other Sandbox methods delegate to `inner` unchanged.
 */
export function recordingSandbox(inner: Sandbox, recorder: NodeRecorder): Sandbox {
  const wrapped: Sandbox = {
    putFiles: (files) => inner.putFiles(files),
    writeFile: (p, data) => inner.writeFile(p, data),
    readFile: (p, opts) => inner.readFile(p, opts),
    downloadDir: (remote, local) => inner.downloadDir(remote, local),
    dispose: () => inner.dispose(),
    exec: (cmd: string, opts?: ExecOpts): Promise<ExecResult> => inner.exec(cmd, wrapOpts(opts, recorder)),
  };
  if (inner.spawn) {
    wrapped.spawn = (cmd: string, opts?: ExecOpts): Promise<ProcessHandle> => inner.spawn!(cmd, wrapOpts(opts, recorder));
  }
  return wrapped;
}
