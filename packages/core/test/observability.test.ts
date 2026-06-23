import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeRecorder, recordingSandbox, slimEvent, type PiEvent } from '../src/runner/events.js';
import { distillEvents, parseEventsFile, eventsPath } from '../src/runner/logs.js';
import type { Sandbox, ExecOpts, ExecResult } from '../src/types.js';

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
  it('drops the cumulative message_start snapshot entirely', () => {
    expect(slimEvent({ type: 'message_start', message: { role: 'user' } })).toBeNull();
  });
  it('strips the body from message_end but keeps token/usage fields', () => {
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

describe('NodeRecorder + recordingSandbox — the capture seam', () => {
  it('tees stdout into the slimmed archive AND still calls the caller onStdout (watchdog preserved)', async () => {
    const dir = tmp();
    const rec = new NodeRecorder(dir, 'w0-classify');
    const sb = fakeSandbox((onStdout) => {
      onStdout('{"type":"message_start","message":{"big":"snapshot"}}\n'); // must be DROPPED
      onStdout('{"type":"tool_execution_start","toolName":"write","args":{"path":"spec/x.json"}}\n'); // must be KEPT
    });
    const callerSpy = vi.fn();
    await recordingSandbox(sb, rec).exec('pi …', { onStdout: callerSpy });
    await rec.close();

    // (1) the watchdog's own onStdout still fired for every chunk — recording is additive, not a regression.
    expect(callerSpy).toHaveBeenCalledTimes(2);

    // (2) the archive kept only the tool event, slimmed + clock-stamped.
    const evs = parseEventsFile(eventsPath(dir, 'w0-classify'));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: 'tool_execution_start', toolName: 'write' });
    expect(typeof evs[0]._t).toBe('number');
    expect(typeof evs[0]._rt).toBe('string');
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
