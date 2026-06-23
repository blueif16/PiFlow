import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeRecorder, recordingSandbox, slimEvent, type PiEvent } from '../src/runner/events.js';
import { distillEvents, parseEventsFile, eventsPath, diagnoseRun } from '../src/runner/logs.js';
import { auditWorkflow } from '../src/runner/audit.js';
import { tailAppend } from '../src/sandbox/capture.js';
import type { Sandbox, ExecOpts, ExecResult, Workflow } from '../src/types.js';

// Write a fixture run dir: run-status.json + per-node _pi/<id>.events.jsonl.
function fixtureRun(status: unknown, events: Record<string, PiEvent[]>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'piflow-run-'));
  writeFileSync(path.join(dir, 'run-status.json'), JSON.stringify(status));
  mkdirSync(path.join(dir, '_pi'), { recursive: true });
  for (const [id, evs] of Object.entries(events)) {
    writeFileSync(path.join(dir, '_pi', `${id}.events.jsonl`), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return dir;
}

const tmp = (): string => mkdtempSync(path.join(tmpdir(), 'piflow-obs-'));

// A minimal Sandbox whose exec replays canned stdout chunks through opts.onStdout, then resolves.
function fakeSandbox(emit: (onStdout: (c: string) => void) => void): Sandbox {
  return {
    putFiles: async () => {},
    writeFile: async () => {},
    readFile: async () => '',
    downloadDir: async () => {},
    dispose: async () => {},
    exec: async (_cmd: string, opts?: ExecOpts): Promise<ExecResult> => {
      emit(opts?.onStdout ?? (() => {}));
      return { stdout: '', stderr: '', code: 0 };
    },
  };
}

describe('distillEvents — the firehose → one line per meaningful action', () => {
  it('surfaces a tool call with its path target', () => {
    const lines = distillEvents([
      { type: 'tool_execution_start', toolName: 'write', args: { path: 'spec/classification.json' } },
    ]);
    expect(lines).toEqual(['▸ write spec/classification.json']);
  });

  it('accumulates thinking deltas into ONE summary line at thinking_end', () => {
    const lines = distillEvents([
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'first ' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'second' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_end' } },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('thinking (12 chars)');
    expect(lines[0]).toContain('first second');
  });

  // THE gate-3 symptom, made visible: the model emits the answer as TEXT and never calls a write tool.
  it('shows a text answer with NO write call — the cheap-model never-write failure is legible', () => {
    const lines = distillEvents([
      { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '{"archetype":"platformer"}' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0 } },
    ]);
    expect(lines.some((l) => l.includes('␃ says'))).toBe(true);
    expect(lines.some((l) => l.startsWith('▸'))).toBe(false); // no tool call ⇒ it never wrote
  });

  it('flushes an unterminated text turn (node killed mid-stream)', () => {
    const lines = distillEvents([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial answer' } },
    ]);
    expect(lines.some((l) => l.includes('␃ says') && l.includes('partial answer'))).toBe(true);
  });
});

describe('slimEvent — keep the signal, drop the bulk', () => {
  // THE bloat bug: pi re-embeds the whole accumulated transcript in `message` on EVERY delta. Left in,
  // each message_update grows unbounded → a 20MB+ archive of truncated-invalid-JSON lines. Strip it.
  it('strips the cumulative message snapshot + partial from a per-token message_update, keeping the delta', () => {
    const ev = {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'tiny', partial: 'the WHOLE accumulated transcript so far …' },
      message: { role: 'assistant', content: 'the WHOLE accumulated transcript so far …' },
    };
    expect(slimEvent(ev)).toEqual({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'tiny' },
    });
  });
  it('strips the snapshot from a turn_end too (not just message_update)', () => {
    expect(slimEvent({ type: 'turn_end', message: { content: 'huge' } })).toEqual({ type: 'turn_end' });
  });
  it('strips the body from message_end but keeps token/usage sibling fields', () => {
    expect(slimEvent({ type: 'message_end', message: { big: 1 }, usage: { tokens: 42 } }))
      .toEqual({ type: 'message_end', usage: { tokens: 42 } });
  });
  it('truncates a large tool_execution_end result, leaves a small one intact', () => {
    const big = slimEvent({ type: 'tool_execution_end', toolName: 'read', result: { content: 'x'.repeat(5000) } }) as PiEvent;
    expect((big.result as { truncated?: boolean }).truncated).toBe(true);
    const small = slimEvent({ type: 'tool_execution_end', toolName: 'read', result: { content: 'ok' } }) as PiEvent;
    expect(small.result).toEqual({ content: 'ok' });
  });
  it('passes a normal delta through unchanged', () => {
    const ev = { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } };
    expect(slimEvent(ev)).toBe(ev);
  });
});

describe('diagnoseRun — post-run verdict (the never-write made obvious)', () => {
  it('flags a blocked node that emitted text but called NO write tool', () => {
    const dir = fixtureRun(
      { run: 'r', done: true, ok: false, nodes: { w0: { id: 'w0', status: 'blocked', exitCode: 0, artifacts: [{ path: 'spec/x.json', exists: false, bytes: 0 }] } } },
      { w0: [
        { type: 'tool_execution_start', toolName: 'read', args: { path: 'a' } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'here is the classification {…}' } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_end' } },
      ] },
    );
    const n = diagnoseRun(dir).nodes[0];
    expect(n.writes).toBe(0);
    expect(n.reads).toBe(1);
    expect(n.missing).toEqual(['spec/x.json']);
    expect(n.note).toContain('never-write');
    expect(n.lastSay).toContain('here is the classification');
  });
  it('reports ok for a node that wrote its declared artifact', () => {
    const dir = fixtureRun(
      { run: 'r', done: true, ok: true, nodes: { w0: { id: 'w0', status: 'ok', exitCode: 0, durationMs: 4200, artifacts: [{ path: 'spec/x.json', exists: true, bytes: 10 }] } } },
      { w0: [{ type: 'tool_execution_start', toolName: 'write', args: { path: 'spec/x.json' } }] },
    );
    const n = diagnoseRun(dir).nodes[0];
    expect(n.writes).toBe(1);
    expect(n.note).toBe('ok');
  });
});

describe('auditWorkflow — static tool-binding audit (pre-run)', () => {
  const wfOf = (tools: unknown): Workflow => ({ nodes: { w0: { tools } } } as unknown as Workflow);
  it('flags an un-tokenized allow entry (the gate-3 bug)', () => {
    expect(auditWorkflow(wfOf({ allow: ['read ls write'] }))[0].findings.some((f) => f.includes('un-tokenized'))).toBe(true);
  });
  it('passes a properly tokenized allowlist', () => {
    expect(auditWorkflow(wfOf({ allow: ['read', 'ls', 'write'] }))[0].findings).toEqual([]);
  });
  it('flags a tool both allowed and denied', () => {
    expect(auditWorkflow(wfOf({ allow: ['read', 'write'], deny: ['write'] }))[0].findings.some((f) => f.includes('both allowed and denied'))).toBe(true);
  });
});

describe('tailAppend — bounded capture (the RangeError guard)', () => {
  it('appends verbatim while under the cap', () => {
    expect(tailAppend('abc', 'def', 100)).toBe('abcdef');
  });
  it('retains only the last `max` chars once over the cap (the snapshot-bloat blow-up)', () => {
    // buf already AT cap, then a big chunk arrives → result is exactly the cap length, ending in the chunk's tail
    const out = tailAppend('x'.repeat(10), 'y'.repeat(10), 10);
    expect(out).toBe('y'.repeat(10));
  });
  it('clips a single chunk that itself exceeds the cap (bound holds regardless of input size)', () => {
    const out = tailAppend('', 'z'.repeat(1000), 8);
    expect(out).toBe('z'.repeat(8));
  });
});

describe('NodeRecorder + recordingSandbox — the capture seam', () => {
  it('tees stdout into the slimmed archive AND still calls the caller onStdout (watchdog preserved)', async () => {
    const dir = tmp();
    const rec = new NodeRecorder(dir, 'w0-classify');
    const sb = fakeSandbox((onStdout) => {
      // a per-token delta carrying the cumulative snapshot (the bloat) — the snapshot must be stripped
      onStdout('{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"x"},"message":{"big":"cumulative snapshot"}}\n');
      onStdout('{"type":"tool_execution_start","toolName":"write","args":{"path":"spec/x.json"}}\n');
    });
    const callerSpy = vi.fn();
    await recordingSandbox(sb, rec).exec('pi …', { onStdout: callerSpy });
    await rec.close();

    // (1) the watchdog's own onStdout still fired for every chunk — recording is additive, not a regression.
    expect(callerSpy).toHaveBeenCalledTimes(2);

    // (2) both events archived; the cumulative `message` snapshot stripped; clock-stamped.
    const evs = parseEventsFile(eventsPath(dir, 'w0-classify'));
    expect(evs).toHaveLength(2);
    expect(evs[0]).not.toHaveProperty('message');               // bloat stripped
    expect(evs[0].assistantMessageEvent).toMatchObject({ delta: 'x' }); // delta preserved
    expect(evs[1]).toMatchObject({ type: 'tool_execution_start', toolName: 'write' });
    expect(typeof evs[1]._t).toBe('number');
    expect(typeof evs[1]._rt).toBe('string');
  });

  it('close() flushes a trailing partial line (no terminating newline)', async () => {
    const dir = tmp();
    const rec = new NodeRecorder(dir, 'n');
    rec.feedStdout('{"type":"tool_execution_start","toolName":"read","args":{"path":"a"}}'); // no \n
    await rec.close();
    const evs = parseEventsFile(eventsPath(dir, 'n'));
    expect(evs).toHaveLength(1);
    expect(evs[0].toolName).toBe('read');
  });
});
