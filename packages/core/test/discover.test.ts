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
import { runJsonFile } from '../src/runner/layout.js';
import { buildSnapshot, discoverRunDirs, type Registry } from '../src/observe/discover.js';

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
