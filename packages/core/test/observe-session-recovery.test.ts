// observe-session-recovery.test.ts — READ-PATH resilience. When a pi node's stdout tee (events.jsonl)
// carried NO model usage (e.g. a failed `--session` resume that still ran, whose events.jsonl holds only a
// stderr line) but pi persisted its NATIVE per-node session file (`<sessionDir>/<ISO-ts>_<sessionId>.jsonl`),
// buildRunView must recover the node's real model/tool/token signal from that session instead of reporting a
// FALSE zero. Mirrors the real run 260715-02/plan (688KB session, 0-usage events.jsonl, `telemetry plan` → 0).
//
// Run: npx vitest run packages/core/test/observe-session-recovery.test.ts

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runJsonFile, nodeEventsFile, piSessionsDir, writeNodeIo } from '../src/runner/layout.js';
import type { RunStatus } from '../src/runner/status.js';
import { buildRunView } from '../src/observe/runView.js';

const mkRunDir = (): string => mkdtempSync(path.join(tmpdir(), 'piflow-session-recover-'));

async function writeRunJson(runDir: string, status: RunStatus): Promise<void> {
  const rj = runJsonFile(runDir);
  await fs.mkdir(path.dirname(rj), { recursive: true });
  await fs.writeFile(rj, JSON.stringify(status, null, 2));
}

const baseStatus = (nodes: RunStatus['nodes']): RunStatus => ({
  run: 'sa1', startedAt: '2026-07-15T21:14:38.568Z', updatedAt: '2026-07-15T21:18:28.065Z',
  done: true, ok: false, durationMs: 229497, stage: null, totals: { nodes: 1, ok: 0, failed: 1 },
  nodes,
});

/** A pi NATIVE session line — an assistant turn as pi's session-manager persists it (`type:'message'`,
 *  the nested `message` carrying role/model/provider/usage/stopReason + `toolCall`/`thinking` content). */
const sessionMessage = (m: {
  usage: Record<string, number>;
  stopReason?: string;
  tool?: { name: string; args?: unknown };
  thinking?: string;
}): string =>
  JSON.stringify({
    type: 'message',
    id: Math.random().toString(36).slice(2),
    timestamp: '2026-07-15T21:15:00.000Z',
    message: {
      role: 'assistant',
      provider: 'mmgw',
      model: 'MiniMax-M3',
      api: 'openai-completions',
      stopReason: m.stopReason ?? 'stop',
      usage: m.usage,
      content: [
        ...(m.thinking ? [{ type: 'thinking', thinking: m.thinking }] : []),
        ...(m.tool ? [{ type: 'toolCall', id: `call_${m.tool.name}`, name: m.tool.name, arguments: m.tool.args ?? {} }] : []),
      ],
    },
  });

/** Seed a node's pi session file under the TIMESTAMP-PREFIXED name pi mints (`<ISO-ts>_<sessionId>.jsonl`). */
async function seedSession(runDir: string, sessionId: string, lines: string[]): Promise<void> {
  const dir = piSessionsDir(runDir);
  await fs.mkdir(dir, { recursive: true });
  const header = [
    JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: '2026-07-15T21:14:54.714Z' }),
    JSON.stringify({ type: 'model_change', id: 'm0', provider: 'mmgw', modelId: 'MiniMax-M3', timestamp: '2026-07-15T21:14:54.724Z' }),
  ];
  await fs.writeFile(path.join(dir, `2026-07-15T21-14-54-714Z_${sessionId}.jsonl`), [...header, ...lines].join('\n') + '\n');
}

describe('buildRunView — a 0-usage events.jsonl is BACKFILLED from pi\'s native session file', () => {
  it('recovers the real model calls, tool calls and tokens instead of a false zero (run 260715-02/plan)', async () => {
    const runDir = mkRunDir();
    // The EXACT failing shape: status error, NO usage rollup, driverId pi, a sessionId/sessionDir recorded.
    await writeRunJson(runDir, baseStatus({
      plan: {
        id: 'plan', label: 'Plan', status: 'error', artifacts: [], issues: ['nonzero exit 1'],
        durationMs: 214187, driverId: 'pi', sessionId: 'plan', sessionDir: piSessionsDir(runDir),
      },
    }));
    await writeNodeIo(runDir, { id: 'plan', label: 'Plan', phase: null, reads: [], writes: [], promotes: [], status: 'error' });
    // events.jsonl holds ONLY pi's session-resolve stderr — no model usage at all (the reported symptom).
    const ef = nodeEventsFile(runDir, 'plan');
    await fs.mkdir(path.dirname(ef), { recursive: true });
    await fs.writeFile(ef, JSON.stringify({ type: 'stderr', text: "No session found matching 'plan'" }) + '\n');
    // …but the native session persisted two real assistant turns (each with usage + a tool call).
    await seedSession(runDir, 'plan', [
      sessionMessage({ usage: { input: 100, output: 50, cacheRead: 200, totalTokens: 300 }, thinking: 'plan it', tool: { name: 'read' } }),
      sessionMessage({ usage: { input: 20, output: 5, cacheRead: 400, totalTokens: 425 }, tool: { name: 'write' }, stopReason: 'stop' }),
    ]);

    const { view } = buildRunView(runDir);
    const node = view.nodes.find((n) => n.id === 'plan')!;

    expect(node.modelCalls).toBe(2);       // NOT 0 — two assistant turns recovered
    expect(node.toolCalls).toBe(2);        // NOT 0 — read + write recovered from the toolCall content blocks
    expect(node.tokens!.input).toBe(120);  // 100 + 20 summed, NOT 0
    expect(node.tokens!.output).toBe(55);  // 50 + 5
    expect(node.tokens!.contextPeak).toBe(425); // MAX totalTokens, not a sum
    expect(node.model).toBe('MiniMax-M3'); // NOT null
    expect(node.provider).toBe('mmgw');
  });

  it('does NOT override a node whose events.jsonl already carries usage (the gate — no double source)', async () => {
    const runDir = mkRunDir();
    await writeRunJson(runDir, baseStatus({
      plan: {
        id: 'plan', label: 'Plan', status: 'ok', artifacts: [], issues: [],
        durationMs: 1000, driverId: 'pi', sessionId: 'plan', sessionDir: piSessionsDir(runDir),
      },
    }));
    await writeNodeIo(runDir, { id: 'plan', label: 'Plan', phase: null, reads: [], writes: [], promotes: [], status: 'ok' });
    // events.jsonl DOES carry usage (a normal run) — authoritative; the session must not be consulted.
    const ef = nodeEventsFile(runDir, 'plan');
    await fs.mkdir(path.dirname(ef), { recursive: true });
    await fs.writeFile(ef, [
      JSON.stringify({ type: 'message_start', message: { role: 'assistant', model: 'm1', provider: 'cp' } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 7, output: 3, totalTokens: 10 }, stopReason: 'end_turn' } }),
    ].join('\n') + '\n');
    // A session with DIFFERENT (larger) numbers — if the fallback wrongly fired, the assertion below breaks.
    await seedSession(runDir, 'plan', [
      sessionMessage({ usage: { input: 9999, output: 8888, cacheRead: 0, totalTokens: 18887 } }),
    ]);

    const { view } = buildRunView(runDir);
    const node = view.nodes.find((n) => n.id === 'plan')!;
    expect(node.tokens!.input).toBe(7);  // from events.jsonl, NOT the session's 9999
    expect(node.tokens!.output).toBe(3);
    expect(node.modelCalls).toBe(1);
  });
});
