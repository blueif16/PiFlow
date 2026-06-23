// A realistic `.pi/` run-dir fixture, built through @piflow/core's OWN layout helpers (never a
// hardcoded `.pi/...` path) so the test reads exactly the shape the engine writes. The run holds four
// nodes across three stages, covering the three states the status reader must get right:
//   • w0      — ok: its one declared artifact exists ON DISK (verified, not merely self-reported).
//   • w1a/w1b — a PARALLEL lane (one stage, two node ids), both ok with their artifacts present.
//   • w2      — BLOCKED: its declared artifact is MISSING on disk. The record may even SELF-REPORT a
//               status; the reader must derive `blocked` from the absent file, not trust the field.
//
// Returns the run dir + the ground-truth the tests assert against.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  piDir,
  nodeDir,
  runJsonFile,
  writeNodeIo,
  type RunStatus,
  type NodeStatusRecord,
  type NodeIo,
} from '@piflow/core';

/** Write one artifact file under the run dir (so the on-disk verification sees it). */
async function writeArtifact(run: string, rel: string, body: string): Promise<void> {
  const abs = path.join(run, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
}

interface FixtureOpts {
  /** Override the SELF-REPORTED status the record carries for w2 (default 'blocked'). Set 'ok' to
   *  prove the reader DERIVES blocked from the missing file rather than trusting the field. */
  w2SelfReport?: NodeStatusRecord['status'];
  /** When true, the run is finished (done:true) with a rollup; else it is mid-flight. */
  done?: boolean;
  /** Drop the w2 record's declared artifact onto disk too (turns the blocked case into an ok case). */
  materializeW2?: boolean;
}

/**
 * Build the fixture under `dir` (must be empty/new). Writes `.pi/run.json` + each node's
 * `.pi/nodes/<id>/io.json` via the layout helpers, and the present artifacts onto disk.
 */
export async function buildRunFixture(dir: string, opts: FixtureOpts = {}): Promise<string> {
  const run = dir;
  await fs.mkdir(piDir(run), { recursive: true });

  // ── on-disk artifacts: present for w0/w1a/w1b; w2's is ABSENT unless materializeW2. ──
  await writeArtifact(run, 'spec/classification.json', '{"archetype":"platformer"}');
  await writeArtifact(run, 'spec/gdd.md', '# GDD\n');
  await writeArtifact(run, 'spec/blueprint.json', '{"frozen":true}');
  if (opts.materializeW2) await writeArtifact(run, 'src/index.ts', 'export {};\n');

  // ── the run-status record (faithful to RunStatus). status fields are what the WRITER stamped; the
  //    reader re-verifies them against the artifacts[].exists flags + on-disk reality. ──
  const node = (
    id: string,
    label: string,
    status: NodeStatusRecord['status'],
    artifacts: { path: string; exists: boolean; bytes: number }[],
    durationMs: number,
  ): NodeStatusRecord => ({ id, label, status, durationMs, artifacts, issues: [] });

  const nodes: Record<string, NodeStatusRecord> = {
    w0: node('w0', 'W0 Classify', 'ok', [{ path: 'spec/classification.json', exists: true, bytes: 32 }], 4200),
    w1a: node('w1a', 'W1 Design', 'ok', [{ path: 'spec/gdd.md', exists: true, bytes: 6 }], 9100),
    w1b: node('w1b', 'Harden', 'ok', [{ path: 'spec/blueprint.json', exists: true, bytes: 16 }], 8700),
    w2: node(
      'w2',
      'W2 Scaffold',
      opts.w2SelfReport ?? 'blocked',
      [{ path: 'src/index.ts', exists: !!opts.materializeW2, bytes: opts.materializeW2 ? 11 : 0 }],
      opts.materializeW2 ? 5000 : 3300,
    ),
  };

  const run0 = '2026-06-23T10:00:00.000Z';
  const status: RunStatus = {
    run: path.basename(run),
    source: 'game-omni.js',
    provider: 'cp',
    model: 'MiniMax-M3',
    startedAt: run0,
    updatedAt: run0,
    done: !!opts.done,
    ok: opts.done ? false : null,
    durationMs: opts.done ? 30300 : null,
    stage: opts.done ? null : { index: 3, total: 3, nodeIds: ['w2'] },
    totals: opts.done ? { nodes: 4, ok: 3, failed: 1 } : null,
    nodes,
  };

  await fs.writeFile(runJsonFile(run), JSON.stringify(status, null, 2));

  // ── per-node io.json ledgers (the `writes[].verified` on-disk check the table can prefer). ──
  const io = (id: string, writes: { path: string; verified: boolean }[]): NodeIo => ({
    id,
    reads: [],
    writes: writes.map((w) => ({ ...w, bytes: 0 })),
    promotes: [],
    status: nodes[id].status,
  });
  await writeNodeIo(run, io('w0', [{ path: 'spec/classification.json', verified: true }]));
  await writeNodeIo(run, io('w1a', [{ path: 'spec/gdd.md', verified: true }]));
  await writeNodeIo(run, io('w1b', [{ path: 'spec/blueprint.json', verified: true }]));
  await writeNodeIo(run, io('w2', [{ path: 'src/index.ts', verified: !!opts.materializeW2 }]));

  // sanity: nodeDir is the helper the reader must use to find io.json (referenced so it's load-bearing).
  void nodeDir;
  return run;
}
