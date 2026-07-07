// Smoke test for `piflowctl trace <run> [node] [--json]` (packages/cli/src/trace.ts) — the "element
// tree" CLI: everything that reached the model for one node run, ordered, with coverage/sha/via, plus
// the advertised-vs-read `composition` roll-up.
//
// It drives the REAL run-dir data path (`buildRunView`), reusing the SAME gm10-derived fixture the
// `@piflow/core` reducer unit test (`packages/core/test/context-composition.test.ts`) uses — proving the
// CLI wiring, not re-deriving the reducer's own math. A test-first mutation check: swap `renderTrace`'s
// `advertisedUnread` label for `advertised` and this test must fail (asserts the label text, not just
// substring presence of the path).
//
// Run: npx vitest run packages/cli/test/trace.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRunView, piDir, runJsonFile, nodeDir } from '@piflow/core';
import { renderTrace, parseTraceArgs } from '../src/trace.js';

const FIX = path.join(__dirname, '..', '..', 'core', 'test', 'fixtures', 'context-composition');

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-trace-'));
  await fs.mkdir(piDir(dir), { recursive: true });

  // ── minimal run.json declaring one node, "gameplay" (matches the fixture's node id + prompt). ──
  const runJson = {
    run: path.basename(dir),
    source: 'game-omni.js',
    provider: 'cp',
    model: 'MiniMax-M3',
    startedAt: '2026-07-03T21:14:35.000Z',
    updatedAt: '2026-07-03T21:15:00.000Z',
    done: true,
    ok: true,
    nodes: {
      gameplay: {
        id: 'gameplay',
        label: 'Harden',
        status: 'ok',
        artifacts: [{ path: 'spec/blueprint.json', exists: true, bytes: 4000 }],
        issues: [],
      },
    },
  };
  await fs.writeFile(runJsonFile(dir), JSON.stringify(runJson, null, 2));

  // ── stage the reducer's own fixture (events.jsonl + prompt.md + reads-manifest.json) verbatim into
  //    .pi/nodes/gameplay/ — SAME data the core unit test drives, so this test proves CLI wiring only. ──
  const nd = nodeDir(dir, 'gameplay');
  await fs.mkdir(nd, { recursive: true });
  await Promise.all(
    ['events.jsonl', 'prompt.md', 'reads-manifest.json'].map(async (f) => {
      const body = await fs.readFile(path.join(FIX, f), 'utf8');
      await fs.writeFile(path.join(nd, f), body);
    }),
  );
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('parseTraceArgs', () => {
  it('parses <run> [node] [--json]', () => {
    expect(parseTraceArgs(['gm10', 'gameplay', '--json'])).toEqual({ run: 'gm10', nodeId: 'gameplay', json: true });
    expect(parseTraceArgs(['gm10'])).toEqual({ run: 'gm10', nodeId: undefined, json: false });
  });
});

describe('renderTrace — over the REAL buildRunView data path', () => {
  it('renders the ordered element tree: inject at seq 0, then the read/grep ops', () => {
    const { view } = buildRunView(dir);
    const out = renderTrace(view, 'gameplay');
    expect(out).toMatch(/\bnode "gameplay"/);
    expect(out).toMatch(/^\s*0\s+inject/m); // seq 0 is the injected prompt
    expect(out).toContain('read');
  });

  it('surfaces the advertisedUnread BLIND SPOT for design-rules.md (advertised, 0 reads)', () => {
    const { view } = buildRunView(dir);
    const out = renderTrace(view, 'gameplay');
    expect(out).toMatch(/advertisedUnread \(\d+\) — BLIND SPOT:.*design-rules\.md/);
  });

  it('reports the injectedBytes/readFiles composition summary', () => {
    const { view } = buildRunView(dir);
    const out = renderTrace(view, 'gameplay');
    expect(out).toMatch(/composition: injectedBytes=\d+ readFiles=\d+/);
  });

  it('an unknown node id reports the miss (not a crash)', () => {
    const { view } = buildRunView(dir);
    expect(renderTrace(view, 'no-such-node')).toMatch(/no node "no-such-node"/);
  });
});
