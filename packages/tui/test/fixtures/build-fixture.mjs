// ── packages/tui/test/fixtures/build-fixture.mjs ────────────────────────────────
// Materialize a real `.pi/` run dir on disk using @piflow/core's OWN layout helpers, so the render
// test exercises the migrated reader against the exact paths the engine writes — never a hand-rolled
// path. Covers the three load-bearing statuses (ok · blocked · running) + a parallel lane + an io
// ledger that wires a data-flow edge + a couple of events.jsonl lines for one node.
//
// Returns the absolute run dir; the caller points `piflow-tui <rundir>` (and buildModel) at it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runJsonFile, nodeEventsFile, nodeIoFile, nodeDir, piDir } from '@piflow/core';

// A faithful RunStatus (packages/core/src/runner/status.ts) — what the engine writes to .pi/run.json.
export function fixtureStatus(run = 'demo') {
  return {
    run,
    source: 'demo.workflow',
    provider: 'cp',
    model: 'demo-model',
    startedAt: '2026-06-23T10:00:00.000Z',
    updatedAt: '2026-06-23T10:02:00.000Z',
    done: false,
    ok: null,
    durationMs: null,
    stage: { index: 2, total: 2, nodeIds: ['w1-design', 'w1-assets'] },
    totals: null,
    nodes: {
      'w0-classify': {
        id: 'w0-classify',
        label: 'W0 Classify',
        status: 'ok',
        startedAt: '2026-06-23T10:00:00.000Z',
        endedAt: '2026-06-23T10:00:30.000Z',
        durationMs: 30000,
        artifacts: [{ path: 'spec/classification.json', exists: true, bytes: 412 }],
        issues: [],
        summary: 'routed to platformer',
      },
      'w1-design': {
        id: 'w1-design',
        label: 'W1 Design',
        status: 'running',
        startedAt: '2026-06-23T10:00:30.000Z',
        artifacts: [],
        issues: [],
      },
      'w1-assets': {
        id: 'w1-assets',
        label: 'W1 Assets',
        status: 'blocked',
        startedAt: '2026-06-23T10:00:30.000Z',
        endedAt: '2026-06-23T10:01:10.000Z',
        durationMs: 40000,
        artifacts: [{ path: 'public/assets/ASSETS.md', exists: false, bytes: 0 }],
        issues: ['required artifact missing: public/assets/ASSETS.md'],
      },
    },
  };
}

// The per-node io.json ledgers (packages/core/src/types.ts NodeIo: reads/writes/promotes). The
// data-flow edge w0-classify → w1-design is encoded by w1 READING what w0 WROTE (same path).
function fixtureIo() {
  return {
    'w0-classify': {
      id: 'w0-classify',
      label: 'W0 Classify',
      phase: 'classify',
      reads: [{ path: 'prompt.txt', via: 'input' }],
      writes: [{ path: 'spec/classification.json', verified: true, bytes: 412 }],
      promotes: [],
      status: 'ok',
      startedAt: '2026-06-23T10:00:00.000Z',
      endedAt: '2026-06-23T10:00:30.000Z',
      durationMs: 30000,
    },
    'w1-design': {
      id: 'w1-design',
      label: 'W1 Design',
      phase: 'design',
      reads: [{ path: 'spec/classification.json', via: 'upstream' }],
      writes: [{ path: 'spec/gdd.md', verified: false }],
      promotes: [],
      status: 'running',
      startedAt: '2026-06-23T10:00:30.000Z',
    },
    'w1-assets': {
      id: 'w1-assets',
      label: 'W1 Assets',
      phase: 'design',
      reads: [{ path: 'spec/classification.json', via: 'upstream' }],
      writes: [{ path: 'public/assets/ASSETS.md', verified: false }],
      promotes: [],
      status: 'blocked',
      startedAt: '2026-06-23T10:00:30.000Z',
      endedAt: '2026-06-23T10:01:10.000Z',
      durationMs: 40000,
    },
  };
}

/** Write the fixture run dir under `<dir>/<run>` and return its absolute path. */
export async function buildFixture(dir, run = 'demo') {
  const runDir = path.resolve(dir, run);
  await fs.rm(runDir, { recursive: true, force: true });
  await fs.mkdir(piDir(runDir), { recursive: true });
  await fs.writeFile(runJsonFile(runDir), JSON.stringify(fixtureStatus(run), null, 2));

  const ios = fixtureIo();
  for (const [id, rec] of Object.entries(ios)) {
    await fs.mkdir(nodeDir(runDir, id), { recursive: true });
    await fs.writeFile(nodeIoFile(runDir, id), JSON.stringify(rec, null, 2));
  }

  // A couple of events.jsonl lines for ONE node (the running w1-design) — the live tail source.
  const evLines = [
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'designing the ' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'core loop…' } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(nodeEventsFile(runDir, 'w1-design'), evLines);

  return runDir;
}

// Allow `node build-fixture.mjs <dir>` for the manual smoke check.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'demo-run');
  buildFixture(dir).then((p) => console.log(p));
}
