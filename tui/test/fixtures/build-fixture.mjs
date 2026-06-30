// ── tui/test/fixtures/build-fixture.mjs ────────────────────────────────
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

  // MATERIALIZE the declared artifacts the shared reader VERIFIES on disk (verified-not-trusted): a node
  // whose declared write is PRESENT reads `ok`/keeps its status; an ABSENT one reads `blocked`. w0's
  // spec/classification.json exists (→ ok); w1-assets' public/assets/ASSETS.md stays ABSENT (→ blocked).
  await writeArtifact(runDir, 'spec/classification.json', '{"archetype":"platformer"}');
  // (spec/gdd.md for the running w1-design is unverified anyway; leave absent — running passes through.)

  // A couple of events.jsonl lines for ONE node (the running w1-design) — the post-hoc archive. The LIVE
  // tail is streamed by watchRun (only lines appended AFTER the snapshot); tests that exercise the live
  // path append their own lines after subscribing (mirroring a run writing as it goes).
  const evLines = [
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'designing the ' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'core loop…' } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(nodeEventsFile(runDir, 'w1-design'), evLines);

  return runDir;
}

/** Write one artifact file under the run dir (so the shared reader's on-disk verification sees it). */
async function writeArtifact(runDir, rel, body) {
  const abs = path.resolve(runDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
}

// ── REAL-RUN-shaped fixture: a run-local resolved DAG (`.pi/workflow.json`) but NO io.json ledger ──────
// This mirrors how a real `piflowctl run` records itself (the GUI reads the resolved DAG; the io.json
// ledger is often empty): `readRunModel` finds ZERO data-flow edges (it only knows the io ledger) and
// collapses every node into its own singleton stage, while `buildRunView` reads `.pi/workflow.json` for
// the AUTHORITATIVE stages + edges. The TUI must adopt that rich topology — drive its DAG + inspector
// from it — or it draws disconnected boxes with no inputs/outputs. Returns the absolute run dir.
export function resolvedDagStatus(run = 'real') {
  return {
    run, source: 'real.workflow', provider: 'mmgw', model: null,
    startedAt: '2026-06-23T10:00:00.000Z', updatedAt: '2026-06-23T10:05:00.000Z',
    done: true, ok: true, durationMs: 300000,
    stage: { index: 3, total: 3, nodeIds: ['build-a', 'build-b'] }, totals: null,
    nodes: {
      'classify': { id: 'classify', label: 'Classify', status: 'ok', startedAt: '2026-06-23T10:00:00.000Z', endedAt: '2026-06-23T10:01:00.000Z', durationMs: 60000, artifacts: [{ path: 'spec/classification.json', exists: true, bytes: 40 }], issues: [], summary: 'routed' },
      'design':   { id: 'design',   label: 'Design',   status: 'ok', startedAt: '2026-06-23T10:01:00.000Z', endedAt: '2026-06-23T10:02:00.000Z', durationMs: 60000, artifacts: [{ path: 'spec/gdd.md', exists: true, bytes: 80 }], issues: [], summary: 'designed' },
      'build-a':  { id: 'build-a',  label: 'Build A',  status: 'ok', startedAt: '2026-06-23T10:02:00.000Z', endedAt: '2026-06-23T10:03:00.000Z', durationMs: 60000, artifacts: [{ path: 'public/a.txt', exists: true, bytes: 10 }], issues: [], summary: 'built a' },
      'build-b':  { id: 'build-b',  label: 'Build B',  status: 'ok', startedAt: '2026-06-23T10:02:00.000Z', endedAt: '2026-06-23T10:03:30.000Z', durationMs: 90000, artifacts: [{ path: 'public/b.txt', exists: true, bytes: 12 }], issues: [], summary: 'built b' },
    },
  };
}

// The resolved DAG the runner writes to `.pi/workflow.json`: stages (columns + parallel lanes) and the
// DECLARED data-flow edges. `design → build-b` carries NO files (a contract edge) to exercise the
// synthetic-output path that keeps a file-less edge in the graph.
export function resolvedDagWorkflow() {
  return {
    stages: [
      { index: 1, phase: 'classify', parallel: false, nodeIds: ['classify'] },
      { index: 2, phase: 'design', parallel: false, nodeIds: ['design'] },
      { index: 3, phase: 'build', parallel: true, nodeIds: ['build-a', 'build-b'] },
    ],
    edges: [
      { from: 'classify', to: 'design', files: ['spec/classification.json'] },
      { from: 'design', to: 'build-a', files: ['spec/gdd.md'] },
      { from: 'design', to: 'build-b' },
    ],
  };
}

/** Materialize the real-run-shaped fixture (resolved DAG, no io.json) under `<dir>/<run>`. */
export async function buildResolvedDagFixture(dir, run = 'real') {
  const runDir = path.resolve(dir, run);
  await fs.rm(runDir, { recursive: true, force: true });
  await fs.mkdir(piDir(runDir), { recursive: true });
  await fs.writeFile(runJsonFile(runDir), JSON.stringify(resolvedDagStatus(run), null, 2));
  // The run-local resolved DAG — the authoritative topology buildRunView reads, readRunModel ignores.
  await fs.writeFile(path.join(piDir(runDir), 'workflow.json'), JSON.stringify(resolvedDagWorkflow(), null, 2));
  // Materialize each declared artifact so the verified-not-trusted reader keeps the node `ok` (and the
  // rich view's output rows read exists=true). NOTE: NO io.json is written — that is the whole point.
  for (const rec of Object.values(resolvedDagStatus(run).nodes)) {
    for (const a of rec.artifacts) await writeArtifact(runDir, a.path, 'x'.repeat(a.bytes || 1));
  }
  return runDir;
}

// Allow `node build-fixture.mjs <dir>` for the manual smoke check.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'demo-run');
  buildFixture(dir).then((p) => console.log(p));
}
