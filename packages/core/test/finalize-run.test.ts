// `finalizeRun` (runner/finalize.ts) — the core write primitive behind `piflowctl node --finalize` and
// `piflowctl runs sweep --apply`: force-close a STUCK (`!done`) run record. PURE LOGIC gate (test-discipline
// §0): real temp dirs + the real `writeStatus`/`readRunJson`, never a mocked filesystem — the behavior under
// test IS "does this actually write (or refuse to write) the right bytes to `.pi/run.json`".
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finalizeRun } from '../src/runner/finalize.js';
import { writeStatus, type RunStatus } from '../src/runner/status.js';
import { runJsonFile } from '../src/runner/layout.js';

/** A minimal `!done` RunStatus with one already-recorded node — the shape finalize must preserve verbatim. */
function stuckStatus(over: Partial<RunStatus> = {}): RunStatus {
  return {
    run: 'stuck-1',
    startedAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:05:00.000Z',
    done: false,
    ok: null,
    durationMs: null,
    stage: null,
    totals: { nodes: 2, ok: 1, failed: 0 },
    nodes: {
      n1: { id: 'n1', label: 'N1', status: 'ok', artifacts: [], issues: [] },
      n2: { id: 'n2', label: 'N2', status: 'running', artifacts: [], issues: [] },
    },
    ...over,
  };
}

describe('finalizeRun', () => {
  let TMP: string;
  beforeEach(() => {
    TMP = mkdtempSync(path.join(os.tmpdir(), 'piflow-finalize-'));
  });
  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it('writes done:true, ok:false (default) on a !done run with no controllerPid, preserving every other field', async () => {
    await writeStatus(TMP, stuckStatus());

    const result = await finalizeRun(TMP);

    expect(result.wrote).toBe(true);
    if (!result.wrote) throw new Error('unreachable');
    expect(result.after.done).toBe(true);
    expect(result.after.ok).toBe(false); // default — a force-close is NOT a celebration
    // Every other field survives VERBATIM — finalize closes the record, it does not re-judge the nodes.
    expect(result.after.nodes).toEqual(stuckStatus().nodes);
    expect(result.after.totals).toEqual({ nodes: 2, ok: 1, failed: 0 });
    expect(result.after.startedAt).toBe('2026-06-01T00:00:00.000Z');

    // The write actually landed on disk via the ATOMIC writer (readable back, not just returned in-memory).
    const onDisk = JSON.parse(await fs.readFile(runJsonFile(TMP), 'utf8')) as RunStatus;
    expect(onDisk.done).toBe(true);
    expect(onDisk.ok).toBe(false);
  });

  it('honors an explicit opts.ok:true', async () => {
    await writeStatus(TMP, stuckStatus());

    const result = await finalizeRun(TMP, { ok: true });

    expect(result.wrote).toBe(true);
    if (!result.wrote) throw new Error('unreachable');
    expect(result.after.done).toBe(true);
    expect(result.after.ok).toBe(true);
  });

  it('REFUSES (no write) when the run is already done:true — the file is byte-identical after the call', async () => {
    await writeStatus(TMP, stuckStatus({ done: true, ok: true }));
    const before = await fs.readFile(runJsonFile(TMP), 'utf8');

    const result = await finalizeRun(TMP);

    expect(result.wrote).toBe(false);
    if (result.wrote) throw new Error('unreachable');
    expect(result.reason.toLowerCase()).toContain('done'); // actionable: names WHY it refused

    const after = await fs.readFile(runJsonFile(TMP), 'utf8');
    expect(after).toBe(before); // byte-identical — no write happened
  });

  it('reports a clear failure (no throw) when there is no readable .pi/run.json at all', async () => {
    const result = await finalizeRun(TMP); // TMP has no .pi/run.json yet

    expect(result.wrote).toBe(false);
    if (result.wrote) throw new Error('unreachable');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
