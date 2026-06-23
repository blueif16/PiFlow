// Per-node event-stream capture — the observability backbone. The runner taps each node's agent
// stdout (the `pi --mode json` event stream), SLIMS it (drops the heavy cumulative message
// snapshots + truncates large tool results), stamps a node-relative clock, and appends one JSON
// event per line to `<outDir>/_pi/<nodeId>.events.jsonl`. That archive is what makes a run
// observable post-hoc and tail-able live (see ./logs.ts) — `docker logs` for a workflow run.
//
// It is execRunner-AGNOSTIC: the runner wraps the Sandbox with `recordingSandbox` BEFORE handing it
// to the (injectable) execRunner, so the tap survives any custom exec primitive. The wrap CHAINS the
// caller's own onStdout/onStderr (the watchdog's silent-stall `touch`) — recording is purely
// additive and can never disable the kill seam.

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
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
 * Slim ONE parsed event for the archive. Drops the cumulative `message` snapshot that
 * `message_start`/`message_end` carry (the incremental deltas already reconstruct the text), and
 * truncates a large `tool_execution_end` result. Returns null to DROP the event. Everything else —
 * the deltas, tool starts, turn boundaries — passes through unchanged (small, all signal).
 */
export function slimEvent(ev: PiEvent): PiEvent | null {
  if (!ev || typeof ev !== 'object') return null;
  const t = ev.type;
  if (t === 'message_start') return null; // pure cumulative snapshot, zero delta signal
  if (t === 'message_end') {
    const { message, ...rest } = ev as Record<string, unknown>; // keep usage/tokens, drop the body
    void message;
    return rest;
  }
  if (t === 'tool_execution_end' && 'result' in ev) {
    return { ...ev, result: truncResult(ev.result) };
  }
  return ev;
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
    const dir = path.join(this.outDir, '_pi');
    mkdirSync(dir, { recursive: true });
    this.stream = createWriteStream(path.join(dir, `${this.nodeId}.events.jsonl`));
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
