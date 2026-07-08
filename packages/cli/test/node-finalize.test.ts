// `piflowctl node <run> --finalize [--ok=true|false]` — force-close ONE explicitly-named STUCK run. A
// run-level-only action (no nodeId needed — naming the exact `<run>` IS the confirmation), reusing
// `resolveNodeRunDir` for lookup and the core `finalizeRun` primitive for the write. Real temp dirs + the
// real `writeStatus`/`readRunJson` (via `@piflow/core`) — never a mocked filesystem.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runNodeCli, parseNodeArgs } from '../src/node.js';
import { writeStatus, readRunJson, runJsonFile, type RunStatus } from '@piflow/core';

function stuckStatus(over: Partial<RunStatus> = {}): RunStatus {
  return {
    run: 'stuck-1',
    startedAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:05:00.000Z',
    done: false,
    ok: null,
    durationMs: null,
    stage: null,
    totals: null,
    nodes: { n1: { id: 'n1', label: 'N1', status: 'ok', artifacts: [], issues: [] } },
    ...over,
  };
}

describe('parseNodeArgs — --finalize needs no nodeId positional', () => {
  it('parses a bare `<run> --finalize` (one positional) with finalize:true', () => {
    const parsed = parseNodeArgs(['my-run', '--finalize']);
    expect(parsed.run).toBe('my-run');
    expect(parsed.finalize).toBe(true);
  });

  it('parses --ok=true / --ok=false off the --finalize action', () => {
    expect(parseNodeArgs(['r', '--finalize', '--ok=true']).ok).toBe(true);
    expect(parseNodeArgs(['r', '--finalize', '--ok=false']).ok).toBe(false);
    expect(parseNodeArgs(['r', '--finalize']).ok).toBeUndefined(); // no --ok ⇒ let the primitive default
  });
});

describe('runNodeCli --finalize', () => {
  let TMP: string;
  let runDir: string;
  beforeEach(async () => {
    TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-node-finalize-'));
    runDir = path.join(TMP, 'run-a');
  });
  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it('finalizes a stuck (!done, no controllerPid) run: done:true, ok:false (default), exits 0, prints old→new', async () => {
    await writeStatus(runDir, stuckStatus());
    const printed: string[] = [];

    const code = await runNodeCli(['run-a', '--finalize'], {
      resolveRunDir: () => runDir,
      print: (s) => printed.push(s),
      error: () => {},
    });

    expect(code).toBe(0);
    const after = await readRunJson(runDir);
    expect(after!.done).toBe(true);
    expect(after!.ok).toBe(false);
    expect(after!.nodes).toEqual(stuckStatus().nodes); // untouched node-level records

    // Legible transcript: names the old state and the new state.
    const out = printed.join('\n');
    expect(out).toContain('run-a');
    expect(out.toLowerCase()).toMatch(/done:\s*false.*done:\s*true|false.*→.*true/is);
  });

  it('--ok=true records ok:true on the finalized run', async () => {
    await writeStatus(runDir, stuckStatus());

    const code = await runNodeCli(['run-a', '--finalize', '--ok=true'], {
      resolveRunDir: () => runDir,
      print: () => {},
      error: () => {},
    });

    expect(code).toBe(0);
    const after = await readRunJson(runDir);
    expect(after!.ok).toBe(true);
  });

  it('refuses (non-zero exit, no write) on an already done:true run', async () => {
    await writeStatus(runDir, stuckStatus({ done: true, ok: true }));
    const before = await fs.readFile(runJsonFile(runDir), 'utf8');
    const errs: string[] = [];

    const code = await runNodeCli(['run-a', '--finalize'], {
      resolveRunDir: () => runDir,
      print: () => {},
      error: (s) => errs.push(s),
    });

    expect(code).not.toBe(0);
    expect(errs.join('\n').toLowerCase()).toContain('done');
    const after = await fs.readFile(runJsonFile(runDir), 'utf8');
    expect(after).toBe(before); // byte-identical — no write happened
  });

  it('rejects passing --finalize together with another action (exactly one action required)', async () => {
    await writeStatus(runDir, stuckStatus());
    const errs: string[] = [];

    const code = await runNodeCli(['run-a', '--finalize', '--stop'], {
      resolveRunDir: () => runDir,
      print: () => {},
      error: (s) => errs.push(s),
    });

    expect(code).not.toBe(0);
    expect(errs.join('\n')).toContain('exactly one');
  });
});
