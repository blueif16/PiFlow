// logs-cli-args.test.ts — `piflowctl logs` argument parsing. The sibling read verbs (status/telemetry/
// trace) all take `<rundir> [nodeId]` POSITIONALLY; `logs` regressed to "last positional wins", so
// `logs <rundir> <nodeId>` dropped the rundir and tried to resolve the nodeId as the run dir
// (`no .pi/run.json under <cwd>/plan`), and `--help` fell through to that same resolution instead of
// printing usage. These pin both.
//
// Run: npx vitest run packages/core/test/logs-cli-args.test.ts

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runLogsCli } from '../src/runner/logs.js';
import { runJsonFile, nodeEventsFile } from '../src/runner/layout.js';

/** A minimal run dir with one node that recorded a single tool call in its events.jsonl. */
function mkRun(): { runDir: string; nodeId: string } {
  const runDir = mkdtempSync(path.join(tmpdir(), 'piflow-logs-args-'));
  const rj = runJsonFile(runDir);
  mkdirSync(path.dirname(rj), { recursive: true });
  writeFileSync(rj, JSON.stringify({ run: 'r1', done: true, ok: true, nodes: { plan: { id: 'plan', status: 'ok' } } }));
  const ef = nodeEventsFile(runDir, 'plan');
  mkdirSync(path.dirname(ef), { recursive: true });
  writeFileSync(ef, JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: 'brief.yaml' }, toolCallId: 't1' }) + '\n');
  return { runDir, nodeId: 'plan' };
}

/** Capture stdout+stderr writes + the final process.exitCode across a runLogsCli call. */
async function capture(argv: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
  const se = vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => { err.push(String(s)); return true; });
  const prev = process.exitCode;
  process.exitCode = undefined;
  try {
    await runLogsCli(argv);
    return { out: out.join(''), err: err.join(''), exitCode: process.exitCode };
  } finally {
    process.exitCode = prev;
    so.mockRestore();
    se.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

describe('runLogsCli — `<rundir> [nodeId]` positional parsing (matching status/telemetry/trace)', () => {
  it('logs <rundir> <nodeId> resolves the rundir positional and tails the named node', async () => {
    const { runDir } = mkRun();
    const { out, err, exitCode } = await capture([runDir, 'plan']);
    // BUG: previously the SECOND positional overwrote `dir`, so this errored on `<cwd>/plan`.
    expect(err).not.toMatch(/no \.pi\/run\.json/);
    expect(exitCode).not.toBe(1);
    expect(out).toContain('[plan]');       // the node was tailed
    expect(out).toContain('read');         // its recorded tool call surfaced
  });

  it('logs --help prints usage instead of falling through to run-dir resolution', async () => {
    const { out, err, exitCode } = await capture(['--help']);
    expect(err).not.toMatch(/no \.pi\/run\.json/); // did NOT try to resolve a run dir
    expect(exitCode).not.toBe(1);
    expect(out).toMatch(/logs/);                   // printed the usage text
  });
});
