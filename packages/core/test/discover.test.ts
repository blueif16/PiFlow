// Fleet discovery (`buildSnapshot` / `discoverRunDirs`) — PURE LOGIC gate (test-discipline §0): example
// tests over a fixture repo built on the §D9 canonical home `<root>/.piflow/<wf>/{template,runs}`, through
// the SAME `runJsonFile` layout helper the engine writes (never a hardcoded `.pi/run.json` path). The
// behaviors that MUST hold:
//   • a workflow's template + its run thread are discovered and filed under the workflow's namespace.
//   • a run dir WITHOUT `.pi/run.json` is SKIPPED — the exact contract that explains why an aborted/dry run
//     never shows in the GUI/TUI (it has a `.pi/` but no RunStatus).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runJsonFile, nodeIoFile, nodeEventsFile } from '../src/runner/layout.js';
import { buildSnapshot, discoverRunDirs, summarizeRun, STALE_MS_THRESHOLD, type Registry } from '../src/observe/discover.js';

/** A minimal valid `RunStatus` (one terminal-OK node) `readRunModel` can fold into a RunModel. */
function runStatus(run: string, source: string) {
  return {
    run,
    source,
    done: true,
    ok: true,
    durationMs: 100,
    stage: null,
    totals: null,
    nodes: { n1: { id: 'n1', label: 'N1', status: 'ok', artifacts: [], issues: [] } },
  };
}

/** Materialize `<repo>/.piflow/<wf>/runs/<id>/.pi/run.json`. Omit `status` to leave a `.pi/` with NO run.json. */
function writeRun(repo: string, wf: string, id: string, status?: unknown) {
  const runDir = path.join(repo, '.piflow', wf, 'runs', id);
  if (status === undefined) {
    mkdirSync(path.join(runDir, '.pi', 'nodes'), { recursive: true }); // a `.pi/` exists, but no run.json
    return runDir;
  }
  const rj = runJsonFile(runDir);
  mkdirSync(path.dirname(rj), { recursive: true });
  writeFileSync(rj, JSON.stringify(status));
  return runDir;
}

/** A repo with one workflow template + the given runs. */
function fixtureRepo(wf: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'piflow-repo-'));
  const tpl = path.join(repo, '.piflow', wf, 'template', 'meta.json');
  mkdirSync(path.dirname(tpl), { recursive: true });
  writeFileSync(tpl, JSON.stringify({ id: wf, name: wf, phases: ['a', 'b'] }));
  return repo;
}

describe('discoverRunDirs', () => {
  it('finds the run WITH run.json and SKIPS the one without', () => {
    const repo = fixtureRepo('lesson-build');
    const real = writeRun(repo, 'lesson-build', 'ctt-1', runStatus('ctt-1', 'lesson-build'));
    writeRun(repo, 'lesson-build', 'aborted', undefined); // `.pi/` but no run.json → must be skipped

    const { runDirs } = discoverRunDirs(repo);
    expect(runDirs).toContain(real);
    expect(runDirs.some((d) => d.endsWith(path.join('runs', 'aborted')))).toBe(false);
  });
});

describe('buildSnapshot', () => {
  it('discovers the workflow namespace and files its real run under it', async () => {
    const repo = fixtureRepo('lesson-build');
    writeRun(repo, 'lesson-build', 'ctt-1', runStatus('ctt-1', 'lesson-build'));
    writeRun(repo, 'lesson-build', 'aborted', undefined); // no run.json → absent from the snapshot

    const registry: Registry = { products: [{ id: 'animation-test', name: 'animation-test', root: repo }] };
    const snap = await buildSnapshot(registry);

    expect(snap.products).toHaveLength(1);
    const ns = snap.products[0].namespaces.find((n) => n.id === 'lesson-build');
    expect(ns, 'workflow namespace discovered from template/meta.json').toBeTruthy();
    expect(ns!.threads.map((t) => t.run)).toEqual(['ctt-1']); // only the run WITH run.json
    expect(ns!.threads[0].nodesTotal).toBe(1);
    expect(ns!.threads[0].state).toBe('done');
  });
});

// ── summarizeRun LIVE fields ────────────────────────────────────────────────────────────────────────
// The thread row the fleet pickers (CLI/TUI/GUI) render must carry the LIVE running-thread signals — the
// previous stubs (phase/updatedAt/staleMs = null, runningStalled = false, runningTool = null) left the
// TUI's stale highlight + `runningNode:runningTool` display dead. These tests target exactly those fields,
// so they FAIL on the stubbed producer.

/** Materialize a RUNNING run dir: a running node with a `phase` (via io.json) + an IN-FLIGHT tool in its
 *  events.jsonl (a `tool_execution_start` with no matching `_end`). `updatedAt`/`startedAt` are caller-set
 *  so a test can place the last write recently (live) or long ago (stalled). Returns the run dir. */
function writeRunningRun(opts: { updatedAt: string; startedAt?: string; phase?: string; openTool?: string }): string {
  const runDir = mkdtempSync(path.join(tmpdir(), 'piflow-run-'));
  const status = {
    run: 'live-1',
    source: 'lesson-build',
    done: false,
    ok: null,
    startedAt: opts.startedAt ?? opts.updatedAt,
    updatedAt: opts.updatedAt,
    durationMs: null,
    provider: 'cp',
    model: 'demo-model',
    stage: { index: 1, total: 1, nodeIds: ['n1'] },
    totals: null,
    nodes: { n1: { id: 'n1', label: 'N1', status: 'running', startedAt: opts.startedAt ?? opts.updatedAt, artifacts: [], issues: [] } },
  };
  const rj = runJsonFile(runDir);
  mkdirSync(path.dirname(rj), { recursive: true });
  writeFileSync(rj, JSON.stringify(status));
  // io.json carries the running node's PHASE (readRunModel reads NodeView.phase from io.json).
  const io = nodeIoFile(runDir, 'n1');
  mkdirSync(path.dirname(io), { recursive: true });
  writeFileSync(io, JSON.stringify({ id: 'n1', label: 'N1', phase: opts.phase ?? 'design', reads: [], writes: [], promotes: [], status: 'running' }));
  // events.jsonl: an in-flight tool (a `tool_execution_start` with NO matching end) is the in-flight signal.
  if (opts.openTool) {
    const ev = nodeEventsFile(runDir, 'n1');
    const lines = [
      { type: 'tool_execution_start', toolName: 'read', toolCallId: 'c0', _t: 10 },
      { type: 'tool_execution_end', toolCallId: 'c0', _t: 20 },          // c0 closed
      { type: 'tool_execution_start', toolName: opts.openTool, toolCallId: 'c1', _t: 30 }, // c1 STILL OPEN
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(ev, lines);
  }
  return runDir;
}

describe('summarizeRun live fields', () => {
  it('populates updatedAt, staleMs, runningStalled, phase, runningTool for a RUNNING run', async () => {
    // Last write 5s ago → live, not stalled.
    const updatedAt = new Date(Date.now() - 5_000).toISOString();
    const runDir = writeRunningRun({ updatedAt, phase: 'design', openTool: 'edit' });

    const t = await summarizeRun(runDir);
    expect(t, 'a readable running run summarizes').toBeTruthy();
    expect(t!.state).toBe('running');

    // updatedAt mapped straight off the model (was stubbed null).
    expect(t!.updatedAt).toBe(updatedAt);
    // staleMs is a finite, non-negative clock delta (was stubbed null).
    expect(t!.staleMs).not.toBeNull();
    expect(Number.isFinite(t!.staleMs!)).toBe(true);
    expect(t!.staleMs!).toBeGreaterThanOrEqual(0);
    // 5s < 90s ⇒ not stalled (was stubbed false — this asserts the threshold direction, not just the stub).
    expect(t!.staleMs!).toBeLessThan(STALE_MS_THRESHOLD);
    expect(t!.runningStalled).toBe(false);
    // phase = the running node's phase from io.json (was stubbed null).
    expect(t!.phase).toBe('design');
    // runningTool = the LAST in-flight tool (c1='edit'), not the closed one (c0='read') (was stubbed null).
    expect(t!.runningNode).toBe('n1');
    expect(t!.runningTool).toBe('edit');
  });

  it('flags runningStalled when the last write is older than the 90s threshold', async () => {
    const updatedAt = new Date(Date.now() - (STALE_MS_THRESHOLD + 30_000)).toISOString();
    const runDir = writeRunningRun({ updatedAt, phase: 'design' });

    const t = await summarizeRun(runDir);
    expect(t!.staleMs!).toBeGreaterThan(STALE_MS_THRESHOLD);
    expect(t!.runningStalled).toBe(true);
  });

  it('leaves staleMs/runningStalled null/false and phase null for a DONE run', async () => {
    const repo = fixtureRepo('lesson-build');
    const runDir = writeRun(repo, 'lesson-build', 'done-1', runStatus('done-1', 'lesson-build'));

    const t = await summarizeRun(runDir);
    expect(t!.state).toBe('done');
    expect(t!.staleMs).toBeNull();
    expect(t!.runningStalled).toBe(false);
    expect(t!.phase).toBeNull();
    expect(t!.runningTool).toBeNull();
  });
});
