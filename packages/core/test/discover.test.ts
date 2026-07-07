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
import {
  buildSnapshot, discoverRunDirs, summarizeRun, groupByParent, STALE_MS_THRESHOLD,
  type Registry, type ThreadRow,
} from '../src/observe/discover.js';

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

// ── M1 — path-derived namespace identity ────────────────────────────────────────────────────────────
// THE LAW: a workflow's identity is its DIRECTORY under `.piflow/`, never the free-text `meta.json.id` an
// author can (and, in game-omni, DOES) copy-paste identically across several dirs. A run files under the
// wf dir it PHYSICALLY lives in (`<root>/.piflow/<wf>/runs/<id>`), never by parsing `run.json.source`. These
// tests reproduce the diagnosed bug exactly: 6 dirs (here, 2) sharing one declared meta.id must still
// surface as that many DISTINCT namespaces with DISJOINT runs — not one namespace object repeated N× with
// every run unioned together.
describe('buildSnapshot — path-derived namespace identity (M1)', () => {
  it('keys namespaces by DIRECTORY name, not by a shared meta.id, and files runs by their own dir', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'piflow-repo-'));
    // Two workflow DIRS that both declare the SAME meta.id — the exact game-omni shape (cObl/game-omni/gLG/…
    // all declare id "game-omni"). Display name may collide; identity (namespace.id) must not.
    for (const wf of ['gmA', 'gmB']) {
      const tpl = path.join(repo, '.piflow', wf, 'template', 'meta.json');
      mkdirSync(path.dirname(tpl), { recursive: true });
      writeFileSync(tpl, JSON.stringify({ id: 'game-omni', name: 'Game Omni' }));
    }
    writeRun(repo, 'gmA', 'a1', runStatus('a1', 'irrelevant-never-parsed'));
    writeRun(repo, 'gmA', 'a2', runStatus('a2', 'irrelevant-never-parsed'));
    writeRun(repo, 'gmB', 'b1', runStatus('b1', 'irrelevant-never-parsed'));

    const registry: Registry = { products: [{ id: 'game-omni-repo', name: 'game-omni-repo', root: repo }] };
    const snap = await buildSnapshot(registry);

    expect(snap.products).toHaveLength(1);
    const namespaces = snap.products[0].namespaces;
    const ids = namespaces.map((n) => n.id).sort();
    // ONE namespace PER DIR (2 dirs → 2 namespaces) — the pre-fix code collapsed nsById on the shared
    // "game-omni" key but still emitted the SAME object once per raw `namespaces` entry (6× on game-omni's
    // real fixture); asserting the id set AND its uniqueness catches both the collapse and the repeat-emit.
    expect(ids).toEqual(['gmA', 'gmB']);
    expect(new Set(namespaces.map((n) => n.id)).size).toBe(namespaces.length); // no namespace repeated

    const gmA = namespaces.find((n) => n.id === 'gmA')!;
    const gmB = namespaces.find((n) => n.id === 'gmB')!;
    expect(gmA.threads.map((t) => t.run).sort()).toEqual(['a1', 'a2']); // disjoint — never gmB's run
    expect(gmB.threads.map((t) => t.run).sort()).toEqual(['b1']);       // disjoint — never gmA's runs
    // display name still reads meta.name (a DISPLAY collision is fine; only identity must never collide)
    expect(gmA.name).toBe('Game Omni');
    expect(gmB.name).toBe('Game Omni');
  });

  it('falls back to the dir name as display name when meta.json carries no name', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'piflow-repo-'));
    const tpl = path.join(repo, '.piflow', 'bare-wf', 'template', 'meta.json');
    mkdirSync(path.dirname(tpl), { recursive: true });
    writeFileSync(tpl, JSON.stringify({ id: 'some-other-id' })); // no `name` — and an id that ISN'T the dir
    const registry: Registry = { products: [{ id: 'p', name: 'p', root: repo }] };
    const snap = await buildSnapshot(registry);
    const ns = snap.products[0].namespaces.find((n) => n.id === 'bare-wf');
    expect(ns, 'namespace id is the DIRECTORY name, ignoring meta.id entirely').toBeTruthy();
    expect(ns!.name).toBe('bare-wf');
  });

  it('files a run under its own template-less wf dir (runs/ with no template) — no "unfiled" bucket', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'piflow-repo-'));
    // 'orphan-wf' has NO template/meta.json — discoverNamespaces never lists it — yet its run must still
    // surface under a namespace keyed by ITS OWN dir name, never a catch-all "unfiled" bucket.
    writeRun(repo, 'orphan-wf', 'o1', runStatus('o1', 'whatever'));
    const registry: Registry = { products: [{ id: 'p', name: 'p', root: repo }] };
    const snap = await buildSnapshot(registry);
    const ids = snap.products[0].namespaces.map((n) => n.id);
    expect(ids).toContain('orphan-wf');
    expect(ids).not.toContain('unfiled');
    const ns = snap.products[0].namespaces.find((n) => n.id === 'orphan-wf')!;
    expect(ns.threads.map((t) => t.run)).toEqual(['o1']);
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

// ── M8.1 — lineage rides the index: ThreadRow widening ─────────────────────────────────────────────────
// `RunStatus.parent`/`spawnedBy` (M1) are read by `readRunModel` today and dropped before reaching a
// `ThreadRow` — these tests target exactly that: they FAIL while `summarizeRun` stubs the fields (or never
// reads them), and pass once the RunModel/ThreadRow chain carries them verbatim off the parsed status.
describe('summarizeRun — M1 lineage passthrough', () => {
  it('carries parent + spawnedBy verbatim off RunStatus onto the ThreadRow', async () => {
    const repo = fixtureRepo('lesson-build');
    const status = {
      ...runStatus('260706-01.gameplay', 'lesson-build'),
      parent: '260706-01',
      spawnedBy: { by: 'substrate-fix', issue: 'soggy-crust', issueId: 'sha256:deadbeef' },
    };
    const runDir = writeRun(repo, 'lesson-build', '260706-01.gameplay', status);

    const t = await summarizeRun(runDir);
    expect(t!.parent).toBe('260706-01');
    expect(t!.spawnedBy).toEqual({ by: 'substrate-fix', issue: 'soggy-crust', issueId: 'sha256:deadbeef' });
  });

  it('leaves parent/spawnedBy undefined for a normal top-level run', async () => {
    const repo = fixtureRepo('lesson-build');
    const runDir = writeRun(repo, 'lesson-build', 'ctt-1', runStatus('ctt-1', 'lesson-build'));

    const t = await summarizeRun(runDir);
    expect(t!.parent).toBeUndefined();
    expect(t!.spawnedBy).toBeUndefined();
  });
});

// ── M8.1 — groupByParent: the pure forest-builder the GUI run switcher nests on ────────────────────────
describe('groupByParent', () => {
  const row = (run: string, overrides: Partial<ThreadRow> = {}): ThreadRow => ({
    run, runDir: `/runs/${run}`, statusPath: `/runs/${run}`, state: 'done', done: true, ok: true,
    stageIndex: null, stageTotal: null, phase: null, runningNode: null, runningTool: null,
    runningStalled: false, nodesDone: 1, nodesTotal: 1, frac: 1, elapsedMs: null, tokensBillable: 0,
    cost: 0, provider: null, model: null, updatedAt: null, staleMs: null, errorNode: null,
    ...overrides,
  });

  it('nests a child under its parent (depth-1) and leaves a parentless run at top level', () => {
    const parent = row('260706-01');
    const child = row('260706-01.gameplay', { parent: '260706-01', spawnedBy: { by: 'substrate-fix', issue: 'soggy-crust' } });
    const unrelated = row('ctt-1');

    const forest = groupByParent([parent, child, unrelated]);

    expect(forest.map((n) => n.thread.run)).toEqual(['260706-01', 'ctt-1']); // top-level order preserved
    const parentNode = forest.find((n) => n.thread.run === '260706-01')!;
    expect(parentNode.children).toHaveLength(1);
    expect(parentNode.children[0].thread.run).toBe('260706-01.gameplay');
    expect(parentNode.children[0].thread.spawnedBy?.issue).toBe('soggy-crust');
    expect(parentNode.children[0].children).toEqual([]); // depth-1: the child has no children of its own
    const unrelatedNode = forest.find((n) => n.thread.run === 'ctt-1')!;
    expect(unrelatedNode.children).toEqual([]);
  });

  it('promotes an ORPHAN child (parent not in the input set) to top-level instead of dropping it', () => {
    const orphan = row('260706-01.gameplay', { parent: '260706-01' }); // '260706-01' is NOT in this set
    const forest = groupByParent([orphan]);
    expect(forest.map((n) => n.thread.run)).toEqual(['260706-01.gameplay']);
    expect(forest[0].children).toEqual([]);
  });

  it('is deterministic: preserves input order at every level, independent of run-id lexical order', () => {
    const parent = row('260706-02'); // lexically AFTER its children — order must still come from the input
    const childB = row('260706-02.b', { parent: '260706-02' });
    const childA = row('260706-02.a', { parent: '260706-02' });
    const forest = groupByParent([parent, childB, childA]); // b before a in the input

    expect(forest).toHaveLength(1);
    expect(forest[0].children.map((n) => n.thread.run)).toEqual(['260706-02.b', '260706-02.a']);
  });
});
