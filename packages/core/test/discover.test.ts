// Fleet discovery (`buildSnapshot` / `discoverRunDirs`) — PURE LOGIC gate (test-discipline §0): example
// tests over a fixture repo built on the §D9 canonical home `<root>/.piflow/<wf>/{template,runs}`, through
// the SAME `runJsonFile` layout helper the engine writes (never a hardcoded `.pi/run.json` path). The
// behaviors that MUST hold:
//   • a workflow's template + its run thread are discovered and filed under the workflow's namespace.
//   • a run dir WITHOUT `.pi/run.json` is SKIPPED — the exact contract that explains why an aborted/dry run
//     never shows in the GUI/TUI (it has a `.pi/` but no RunStatus).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runJsonFile, nodeIoFile, nodeEventsFile } from '../src/runner/layout.js';
import {
  buildSnapshot, discoverRunDirs, summarizeRun, groupByParent, STALE_MS_THRESHOLD,
  resolveRunHome, resolveNamespaceTemplate,
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

// ── M1-REVISED — meta.id IS the workflow's identity; filing stays PATH-derived ─────────────────────────
// THE LAW (user-corrected): `meta.id` is the workflow's identity (fallback: the dir name when meta.json is
// absent/unparseable or id empty). Several sibling dirs under one product's `.piflow/` sharing a meta.id
// (game-omni's cObl/gLG/gmB/gmC/gmD/game-omni — variant/experiment HOMES of the ONE workflow) MERGE into
// ONE namespace emitted EXACTLY ONCE, whose threads are the UNION of every home's runs. The original ×6 bug
// was only the duplicate emission (the un-deduped ordered-ns list), never the merging. A run still files by
// its PATH — the meta.id of the wf dir it physically lives in — NEVER by parsing `run.json.source`, never
// cross-product, never an 'unfiled' bucket.
describe('buildSnapshot — meta.id identity with merged homes (M1-REVISED)', () => {
  it('MERGES sibling dirs sharing one meta.id into ONE namespace, emitted once, threads = the union', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'piflow-repo-'));
    // Two variant HOMES of the one workflow — both declare id "game-omni" (the exact game-omni shape).
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
    // ONE namespace, emitted EXACTLY ONCE — this fails BOTH regressions: restoring the duplicate emission
    // (the ns appearing twice) AND keying by dir name (two namespaces gmA/gmB instead of one game-omni).
    expect(namespaces.map((n) => n.id)).toEqual(['game-omni']);
    const ns = namespaces[0];
    expect(ns.name).toBe('Game Omni');
    // threads = the UNION of every home's runs (filed by each run's own path, never run.json.source).
    expect(ns.threads.map((t) => t.run).sort()).toEqual(['a1', 'a2', 'b1']);
  });

  it('canonical templatePath prefers the MAIN home (the dir whose NAME equals the meta.id)', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'piflow-repo-'));
    // Discovery order is readdir order — 'aVariant' sorts BEFORE 'game-omni', so first-discovered would be
    // the variant; the main home must still win because its dir name equals the id (StartRunPanel launches
    // off ns.templatePath, so this must be the canonical template, not whichever variant readdir hit first).
    for (const wf of ['aVariant', 'game-omni', 'zVariant']) {
      const tpl = path.join(repo, '.piflow', wf, 'template', 'meta.json');
      mkdirSync(path.dirname(tpl), { recursive: true });
      writeFileSync(tpl, JSON.stringify({ id: 'game-omni', name: 'Game Omni' }));
    }
    const registry: Registry = { products: [{ id: 'p', name: 'p', root: repo }] };
    const snap = await buildSnapshot(registry);
    const ns = snap.products[0].namespaces.find((n) => n.id === 'game-omni')!;
    expect(ns.templatePath).toBe(path.join(repo, '.piflow', 'game-omni', 'template', 'meta.json'));
  });

  it('falls back to the FIRST-discovered home when no dir name equals the meta.id', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'piflow-repo-'));
    for (const wf of ['homeA', 'homeB']) {
      const tpl = path.join(repo, '.piflow', wf, 'template', 'meta.json');
      mkdirSync(path.dirname(tpl), { recursive: true });
      writeFileSync(tpl, JSON.stringify({ id: 'shared-wf' }));
    }
    const registry: Registry = { products: [{ id: 'p', name: 'p', root: repo }] };
    const snap = await buildSnapshot(registry);
    const ns = snap.products[0].namespaces.find((n) => n.id === 'shared-wf')!;
    expect(ns.templatePath).toBe(path.join(repo, '.piflow', 'homeA', 'template', 'meta.json'));
  });

  it('keeps DISTINCT meta.ids distinct, with display name = meta.name || id', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'piflow-repo-'));
    const t1 = path.join(repo, '.piflow', 'dirX', 'template', 'meta.json');
    mkdirSync(path.dirname(t1), { recursive: true });
    writeFileSync(t1, JSON.stringify({ id: 'wf-one', name: 'Workflow One' }));
    const t2 = path.join(repo, '.piflow', 'dirY', 'template', 'meta.json');
    mkdirSync(path.dirname(t2), { recursive: true });
    writeFileSync(t2, JSON.stringify({ id: 'wf-two' })); // no name → display = the id
    const registry: Registry = { products: [{ id: 'p', name: 'p', root: repo }] };
    const snap = await buildSnapshot(registry);
    const ids = snap.products[0].namespaces.map((n) => n.id).sort();
    expect(ids).toEqual(['wf-one', 'wf-two']);
    expect(snap.products[0].namespaces.find((n) => n.id === 'wf-one')!.name).toBe('Workflow One');
    expect(snap.products[0].namespaces.find((n) => n.id === 'wf-two')!.name).toBe('wf-two');
  });

  it('falls back to the dir name as identity when meta.json declares no id', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'piflow-repo-'));
    const tpl = path.join(repo, '.piflow', 'bare-wf', 'template', 'meta.json');
    mkdirSync(path.dirname(tpl), { recursive: true });
    writeFileSync(tpl, JSON.stringify({ name: 'Bare' })); // no id → identity = the dir name
    const registry: Registry = { products: [{ id: 'p', name: 'p', root: repo }] };
    const snap = await buildSnapshot(registry);
    const ns = snap.products[0].namespaces.find((n) => n.id === 'bare-wf');
    expect(ns, 'no declared id ⇒ the dir name is the identity').toBeTruthy();
    expect(ns!.name).toBe('Bare');
  });

  it('files a run in a template-less wf dir under that dir name — no "unfiled" bucket', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'piflow-repo-'));
    // 'orphan-wf' has NO template/meta.json — no meta.id exists, so the dir name is its identity; its run
    // must surface there, never in a catch-all "unfiled" bucket.
    writeRun(repo, 'orphan-wf', 'o1', runStatus('o1', 'whatever'));
    const registry: Registry = { products: [{ id: 'p', name: 'p', root: repo }] };
    const snap = await buildSnapshot(registry);
    const ids = snap.products[0].namespaces.map((n) => n.id);
    expect(ids).toContain('orphan-wf');
    expect(ids).not.toContain('unfiled');
    const ns = snap.products[0].namespaces.find((n) => n.id === 'orphan-wf')!;
    expect(ns.threads.map((t) => t.run)).toEqual(['o1']);
  });

  it('a run in a VARIANT home files under the merged namespace via ITS OWN dir meta.id, not source text', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'piflow-repo-'));
    // One main home + one variant home; the run lives ONLY in the variant. Its run.json.source names a
    // string that matches NOTHING — filing must come from the variant dir's meta.id alone.
    for (const wf of ['game-omni', 'gmVariant']) {
      const tpl = path.join(repo, '.piflow', wf, 'template', 'meta.json');
      mkdirSync(path.dirname(tpl), { recursive: true });
      writeFileSync(tpl, JSON.stringify({ id: 'game-omni' }));
    }
    writeRun(repo, 'gmVariant', 'v1', runStatus('v1', 'totally-unrelated-source'));
    const registry: Registry = { products: [{ id: 'p', name: 'p', root: repo }] };
    const snap = await buildSnapshot(registry);
    const namespaces = snap.products[0].namespaces;
    expect(namespaces.map((n) => n.id)).toEqual(['game-omni']); // one merged namespace, once
    expect(namespaces[0].threads.map((t) => t.run)).toEqual(['v1']);
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
function writeRunningRun(opts: { updatedAt: string; startedAt?: string; phase?: string; openTool?: string; controllerPid?: number }): string {
  const runDir = mkdtempSync(path.join(tmpdir(), 'piflow-run-'));
  const status = {
    run: 'live-1',
    source: 'lesson-build',
    done: false,
    ok: null,
    ...(opts.controllerPid ? { controllerPid: opts.controllerPid } : {}),
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

// ── summarizeRun — orphaned-run propagation ─────────────────────────────────────────────────────────
// A run whose controller process died is not just a `readRunModel` concern — the FLEET row (what the GUI
// switcher actually renders) must stop reading `state: 'running'` too. `summarizeRun` threads an injectable
// `isAlive` through to `readRunModel` so this is provable without touching a real process.
describe('summarizeRun — orphaned run propagation (dead controller)', () => {
  it('reports state:"failed" + orphaned:true for a run whose controllerPid is confirmed dead', async () => {
    const updatedAt = new Date(Date.now() - 5_000).toISOString(); // recently written — NOT merely stale
    const runDir = writeRunningRun({ updatedAt, controllerPid: 4242 });

    const t = await summarizeRun(runDir, { isAlive: () => false });
    expect(t!.state).toBe('failed');
    expect(t!.orphaned).toBe(true);
  });

  it('leaves state:"running" + orphaned:false when the controllerPid is alive', async () => {
    const updatedAt = new Date(Date.now() - 5_000).toISOString();
    const runDir = writeRunningRun({ updatedAt, controllerPid: 4242 });

    const t = await summarizeRun(runDir, { isAlive: () => true });
    expect(t!.state).toBe('running');
    expect(t!.orphaned).toBe(false);
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

// ── resolveRunHome / resolveNamespaceTemplate — cheap PATH-ONLY resolution ─────────────────────────────
// The perf bug these exist to fix: every "where does run X live" / "where is namespace Y's template"
// lookup (the server's resolveRunDir/resolveTemplateDir, used by run-view/stream/file/tree/preview/skill/
// template-view) used to call the FULL `buildSnapshot` — which folds `summarizeRun` (a full `buildRunView`
// replay of every node's events.jsonl) over EVERY run in EVERY namespace in EVERY registered product just
// to resolve one path. These resolve PURELY from directory shape (discoverRunDirs/discoverNamespaces —
// existence checks only), so they must keep working even when a run's `.pi/run.json` is garbage
// (summarizeRun would choke on it and drop the run from buildSnapshot entirely — the exact case that made
// a corrupted run invisible to every endpoint before this fix).
describe('resolveRunHome', () => {
  it('resolves a run dir straight from directory shape, ignoring unparseable run.json content', () => {
    const repo = fixtureRepo('lesson-build');
    const garbledDir = path.join(repo, '.piflow', 'lesson-build', 'runs', 'garbled');
    mkdirSync(path.dirname(runJsonFile(garbledDir)), { recursive: true });
    writeFileSync(runJsonFile(garbledDir), '{not json'); // summarizeRun would throw + drop this run entirely
    const sibling = writeRun(repo, 'lesson-build', 'sibling-1', runStatus('sibling-1', 'lesson-build'));
    writeRun(repo, 'other-wf', 'other-1', runStatus('other-1', 'other-wf')); // must NOT leak into historyDirs

    const registry: Registry = { products: [{ id: 'p', name: 'p', root: repo }] };
    const hit = resolveRunHome(registry, 'garbled');

    expect(hit, 'resolves from dir shape alone, even with unreadable run.json').toBeTruthy();
    expect(hit!.runDir).toBe(garbledDir);
    expect(hit!.workspaceRoot).toBe(repo);
    expect(hit!.historyDirs.slice().sort()).toEqual([garbledDir, sibling].sort()); // scoped to lesson-build only
  });

  it('returns null for an unknown run id', () => {
    const repo = fixtureRepo('lesson-build');
    const registry: Registry = { products: [{ id: 'p', name: 'p', root: repo }] };
    expect(resolveRunHome(registry, 'no-such-run')).toBeNull();
  });
});

describe('resolveNamespaceTemplate', () => {
  it('resolves a namespace with ZERO runs — the pinned-template surface needs no run at all', () => {
    const repo = fixtureRepo('lesson-build'); // template only, no runs written
    const registry: Registry = { products: [{ id: 'demo', name: 'demo', root: repo }] };

    const hit = resolveNamespaceTemplate(registry, 'demo', 'lesson-build');
    expect(hit).toEqual({ templateDir: path.join(repo, '.piflow', 'lesson-build', 'template') });
  });

  it('returns null for an unregistered product or an unknown namespace', () => {
    const repo = fixtureRepo('lesson-build');
    const registry: Registry = { products: [{ id: 'demo', name: 'demo', root: repo }] };
    expect(resolveNamespaceTemplate(registry, 'not-a-product', 'lesson-build')).toBeNull();
    expect(resolveNamespaceTemplate(registry, 'demo', 'not-a-namespace')).toBeNull();
  });
});

// ── summarizeRun — done-run token/cost cache ───────────────────────────────────────────────────────────
// A DONE run's `.pi/` never changes again in the ordinary path, so re-running buildRunView's full
// events.jsonl replay on every fleet-listing poll (the GUI re-polls /__piflow/index.json every 4s) is pure
// waste. The cache is keyed by run.json's mtime: unchanged mtime ⇒ reuse; a genuine rewrite (e.g. the
// fusion run-first bake) bumps mtime ⇒ recompute. Proven here by mutating the underlying node `usage`
// WITHOUT touching run.json's mtime (must still read the STALE cached numbers) and then WITH a bumped
// mtime (must pick up the new numbers) — a real "always recompute" implementation fails the first
// assertion; a real "cache forever, ignore mtime" implementation fails the second.
describe('summarizeRun — done-run token/cost cache', () => {
  it('reuses the cached tokenTotal across calls when run.json is unchanged, and recomputes once its mtime bumps', async () => {
    const repo = fixtureRepo('lesson-build');
    const status = {
      ...runStatus('cached-1', 'lesson-build'),
      nodes: { n1: { id: 'n1', label: 'N1', status: 'ok', artifacts: [], issues: [], usage: { inputTokens: 10, outputTokens: 5, cost: 1 } } },
    };
    const runDir = writeRun(repo, 'lesson-build', 'cached-1', status);
    const rj = runJsonFile(runDir);
    // Pin the mtime to an explicit, whole-millisecond instant up front — never read a NATURAL fs-generated
    // mtime and feed it back through `utimesSync` to "restore" it: `Date` only carries whole-ms precision,
    // but a real write's `statSync().mtimeMs` can carry a sub-ms fraction (e.g. on APFS), so a read-then-
    // restore round trip silently drifts and the cache would (correctly) see it as "changed". Setting the
    // SAME explicit Date twice has no such loss, since both writes target the identical requested instant.
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(rj, t0, t0);

    const first = await summarizeRun(runDir);
    expect(first!.tokensBillable).toBe(15);
    expect(first!.cost).toBe(1);

    // Mutate the usage but re-pin the SAME mtime instant — a cache keyed on mtime must miss the change and
    // keep returning the FIRST computation.
    const mutated = JSON.parse(readFileSync(rj, 'utf8'));
    mutated.nodes.n1.usage = { inputTokens: 999, outputTokens: 999, cost: 42 };
    writeFileSync(rj, JSON.stringify(mutated));
    utimesSync(rj, t0, t0);

    const second = await summarizeRun(runDir);
    expect(second!.tokensBillable, 'cache hit — must ignore the content change under an unchanged mtime').toBe(15);
    expect(second!.cost).toBe(1);

    // Now bump the mtime for real (a genuine rewrite) — the cache must invalidate and reflect the new usage.
    const t1 = new Date(t0.getTime() + 60_000);
    utimesSync(rj, t1, t1);

    const third = await summarizeRun(runDir);
    expect(third!.tokensBillable, 'mtime bump must invalidate the cache').toBe(1998);
    expect(third!.cost).toBe(42);
  });
});
