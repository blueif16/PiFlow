// `packages/cli/src/remote.ts` — the SSE-over-fetch client that lets the CLI's observe/start subcommands
// talk to a REMOTE `serve` when the active context is not `local`. These tests drive the PURE frame parser
// directly and the fetch-backed helpers with an INJECTED `fetchImpl` (a fake ReadableStream body), so no
// real network is ever touched. The test-the-test mutations (drop the last event / return a wrong model /
// omit the Bearer header) are noted at each block.

import { describe, it, expect } from 'vitest';
import type { RunModel, NodeView, RunUpdate } from '@piflow/core';
import {
  parseSseFrames,
  sseEvents,
  remoteRunModel,
  remoteUpdates,
  startRemoteRun,
  streamUrlFor,
} from '../src/remote.js';
import type { ContextEntry } from '../src/context-store.js';

function nodeView(id: string, status: NodeView['status']): NodeView {
  return {
    id, label: id, phase: null, status, reported: status,
    artifactsVerified: 0, artifactsTotal: 0, missing: [], stageIndex: 1, lane: 0,
  };
}
function model(nodes: NodeView[], extra: Partial<RunModel> = {}): RunModel {
  return {
    run: 'r', done: false, ok: null, durationMs: null, stage: null, totals: null,
    nodes, stages: [], edges: [], ...extra,
  };
}
const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

/**
 * A fake `fetch` returning a response whose body streams `chunks` (each a string) as one Uint8Array per
 * chunk — the shape `sseEvents` iterates. `captured` records the request init so a test asserts the Bearer
 * header rode along. `status`/`body` override the happy path for the error cases.
 */
function fakeFetch(
  chunks: string[],
  captured?: { url?: string; headers?: Record<string, string> },
  opts: { status?: number; jsonBody?: unknown } = {},
): typeof fetch {
  const enc = new TextEncoder();
  return (async (url: string, init?: RequestInit) => {
    if (captured) {
      captured.url = String(url);
      captured.headers = (init?.headers as Record<string, string>) ?? {};
    }
    const body = {
      getReader() {
        let i = 0;
        return {
          read: async () =>
            i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined },
          releaseLock() {},
          cancel: async () => {},
        };
      },
    };
    return {
      ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
      status: opts.status ?? 200,
      statusText: '',
      body,
      text: async () => (typeof opts.jsonBody === 'string' ? opts.jsonBody : JSON.stringify(opts.jsonBody ?? {})),
      json: async () => opts.jsonBody ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('parseSseFrames — the pure SSE frame splitter', () => {
  it('parses MULTIPLE complete frames in one buffer, leaving empty rest', () => {
    const buf = frame({ kind: 'snapshot', model: model([nodeView('w0', 'running')]) }) + frame({ kind: 'done' });
    const { events, rest } = parseSseFrames(buf);
    // If the impl dropped the LAST complete frame, this length assertion goes RED (test-the-test target).
    expect(events).toHaveLength(2);
    expect((events[0] as { kind: string }).kind).toBe('snapshot');
    expect((events[1] as { kind: string }).kind).toBe('done');
    expect(rest).toBe('');
  });

  it('keeps a PARTIAL trailing frame as `rest` (parses only the complete ones)', () => {
    const partial = 'data: {"kind":"do'; // no terminating \n\n yet
    const buf = frame({ kind: 'node-status', id: 'w1', status: 'ok' }) + partial;
    const { events, rest } = parseSseFrames(buf);
    expect(events).toHaveLength(1);
    expect((events[0] as { kind: string }).kind).toBe('node-status');
    expect(rest).toBe(partial); // the incomplete frame is handed back for the next chunk
  });

  it('IGNORES non-data lines (`:ping` keepalives, `event:`), parses only `data:`', () => {
    const buf = ':ping\n\n' + 'event: message\n' + frame({ kind: 'done' });
    const { events } = parseSseFrames(buf);
    expect(events).toHaveLength(1);
    expect((events[0] as { kind: string }).kind).toBe('done');
  });
});

describe('sseEvents — fetch-backed RunUpdate iterable', () => {
  it('streams frames split ACROSS chunk boundaries and rides the Bearer header', async () => {
    // Split one frame across two chunks so the accumulation + re-parse path is exercised.
    const whole = frame({ kind: 'snapshot', model: model([nodeView('w0', 'running')]) }) + frame({ kind: 'done' });
    const cut = Math.floor(whole.length / 2);
    const captured: { url?: string; headers?: Record<string, string> } = {};
    const kinds: string[] = [];
    for await (const u of sseEvents('http://remote/stream/r', 'sk-tok', {
      fetchImpl: fakeFetch([whole.slice(0, cut), whole.slice(cut)], captured),
    })) {
      kinds.push((u as { kind: string }).kind);
    }
    expect(kinds).toEqual(['snapshot', 'done']);
    // The token MUST ride as `Authorization: Bearer <token>` (test-the-test: drop the header → RED).
    expect(captured.headers?.Authorization).toBe('Bearer sk-tok');
  });

  it('sends NO Authorization header when the context has no token', async () => {
    const captured: { url?: string; headers?: Record<string, string> } = {};
    for await (const _ of sseEvents('http://remote/stream/r', undefined, {
      fetchImpl: fakeFetch([frame({ kind: 'done' })], captured),
    })) { /* drain */ }
    expect(captured.headers?.Authorization).toBeUndefined();
  });

  it('filters out non-RunUpdate frames (`meta`, `stream-error`) the server interleaves', async () => {
    const chunks = [
      frame({ kind: 'meta', run: 'r', runDir: '/x' }), // server preamble — NOT a RunUpdate
      frame({ kind: 'snapshot', model: model([nodeView('w0', 'ok')]) }),
      frame({ kind: 'done' }),
    ];
    const kinds: string[] = [];
    for await (const u of sseEvents('http://remote/stream/r', undefined, { fetchImpl: fakeFetch(chunks) })) {
      kinds.push((u as { kind: string }).kind);
    }
    expect(kinds).toEqual(['snapshot', 'done']); // meta dropped
  });
});

describe('remoteRunModel — resolve the FIRST snapshot', () => {
  const entry: ContextEntry = { baseUrl: 'http://remote:5273', token: 'sk-9' };

  it('returns the model carried by the first snapshot frame', async () => {
    const m = model([nodeView('w0', 'ok'), nodeView('w1', 'running')], { run: 'demo' });
    const captured: { url?: string; headers?: Record<string, string> } = {};
    const got = await remoteRunModel(entry, 'demo', {
      fetchImpl: fakeFetch(
        [frame({ kind: 'meta', run: 'demo' }), frame({ kind: 'snapshot', model: m }), frame({ kind: 'done' })],
        captured,
      ),
    });
    // Test-the-test: if remoteRunModel returned a wrong/empty model, run !== 'demo' → RED.
    expect(got.run).toBe('demo');
    expect(got.nodes.map((n) => n.id)).toEqual(['w0', 'w1']);
    // it targets the encoded stream URL and carries the Bearer.
    expect(captured.url).toBe('http://remote:5273/__piflow/stream/demo');
    expect(captured.headers?.Authorization).toBe('Bearer sk-9');
  });

  it('THROWS when the stream ends with NO snapshot', async () => {
    await expect(
      remoteRunModel(entry, 'demo', {
        fetchImpl: fakeFetch([frame({ kind: 'meta', run: 'demo' }), frame({ kind: 'done' })]),
      }),
    ).rejects.toThrow(/no snapshot/i);
  });
});

describe('remoteUpdates — the RunUpdate iterable for watch', () => {
  it('yields the full RunUpdate sequence (snapshot → node-status → done)', async () => {
    const entry: ContextEntry = { baseUrl: 'http://remote:5273' };
    const kinds: string[] = [];
    for await (const u of remoteUpdates(entry, 'r', {
      fetchImpl: fakeFetch([
        frame({ kind: 'snapshot', model: model([nodeView('w0', 'running')]) }),
        frame({ kind: 'node-status', id: 'w2', status: 'blocked' }),
        frame({ kind: 'done' }),
      ]),
    })) {
      kinds.push((u as { kind: string }).kind);
    }
    expect(kinds).toEqual(['snapshot', 'node-status', 'done']);
  });
});

describe('startRemoteRun — POST /api/runs/start', () => {
  const entry: ContextEntry = { baseUrl: 'http://remote:5273/', token: 'sk-start' };

  it('POSTs the body with the Bearer header and returns the 202 {run,streamUrl}', async () => {
    const captured: { url?: string; headers?: Record<string, string> } = {};
    const got = await startRemoteRun(entry, { templateDir: '/t', sandbox: 'local' }, {
      fetchImpl: fakeFetch([], captured, { status: 202, jsonBody: { run: 'brave-tart', streamUrl: '/__piflow/stream/brave-tart' } }),
    });
    expect(got.run).toBe('brave-tart');
    expect(got.streamUrl).toBe('/__piflow/stream/brave-tart');
    // trailing slash on baseUrl is normalized; the Bearer rides (test-the-test: drop header → RED).
    expect(captured.url).toBe('http://remote:5273/api/runs/start');
    expect(captured.headers?.Authorization).toBe('Bearer sk-start');
    expect(captured.headers?.['Content-Type']).toBe('application/json');
  });

  it('THROWS the server error on a non-2xx response', async () => {
    await expect(
      startRemoteRun(entry, { product: 'ghost' }, {
        fetchImpl: fakeFetch([], undefined, { status: 400, jsonBody: { error: 'no product "ghost" in scope' } }),
      }),
    ).rejects.toThrow(/no product "ghost"/);
  });
});

describe('streamUrlFor — the stream URL helper', () => {
  it('joins baseUrl + encoded run id, stripping a trailing slash', () => {
    expect(streamUrlFor({ baseUrl: 'http://h:5273/' }, 'my run')).toBe('http://h:5273/__piflow/stream/my%20run');
    expect(streamUrlFor({ baseUrl: 'http://h:5273' }, 'r')).toBe('http://h:5273/__piflow/stream/r');
  });
});
