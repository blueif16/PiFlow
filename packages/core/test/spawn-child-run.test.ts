import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFromTemplate } from '../src/runner/index.js';
import { childRunName } from '../src/names/index.js';
import type { Workflow, NodeSpec } from '../src/types.js';
import { spawnChildRun, resolveChildWindow } from '../src/optimize/substrate/child-run.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, 'fixtures', 'template-child-run');

// The offline stub: write each declared artifact (run-relative path) into the sandbox output, + a fence
// (mirrors entry.test's stubBuilder — the shared convention for exercising the real lifecycle offline).
function stubBuilder() {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => {
        const dest = `${node.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) resolveChildWindow — the ambiguous-window GUARD, tested in isolation (pure, no fs): a hand-built
// compiled Workflow where node "publish" is unambiguous, but node "publish" would ALSO substring-match a
// later stage's id "republish" — selectWindow (window.ts) is a substring match, so resolveChildWindow must
// refuse to trust a single-node window in that case.
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveChildWindow — the ambiguous --from/--until substring-match guard (M1.4)', () => {
  function stub(id: string): NodeSpec {
    return {
      id,
      label: id,
      tools: {},
      io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
      sandbox: { provider: 'inmemory', workspace: '.', read: [], write: [], output: `out/${id}` },
    } as unknown as NodeSpec;
  }
  function wfWith(ids: string[]): Workflow {
    return {
      meta: { name: 't', description: 'd' },
      nodes: Object.fromEntries(ids.map((id) => [id, stub(id)])),
      stages: ids.map((id, i) => ({ index: i + 1, phase: null, parallel: false, nodeIds: [id] })),
      edges: [],
    };
  }

  it('resolves the exact single stage for an UNAMBIGUOUS node id', () => {
    const wf = wfWith(['draft', 'publish', 'republish']);
    expect(resolveChildWindow(wf, 'draft')).toEqual({ fromIdx: 0, untilIdx: 0 });
  });

  it('THROWS when another stage id substring-contains the target (the selectWindow trap)', () => {
    // "republish".includes("publish") === true ⇒ selectWindow(wf,'publish','publish') would span
    // stage 1 (publish) .. stage 2 (republish) — a silent widen this guard must refuse.
    const wf = wfWith(['draft', 'publish', 'republish']);
    expect(() => resolveChildWindow(wf, 'publish')).toThrow(/AMBIGUOUS/);
  });

  it('throws when the node id is not part of the compiled stages at all', () => {
    const wf = wfWith(['draft', 'publish']);
    expect(() => resolveChildWindow(wf, 'ghost')).toThrow(/not part of this template/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) spawnChildRun — the integration path over a real fixture template (draft -> publish). A tmp
// runs-home holds the PARENT run (fully executed); spawnChildRun then replays ONLY "publish" into a fresh
// sibling child dir.
// ─────────────────────────────────────────────────────────────────────────────
describe('spawnChildRun — replay-from-node-start (M1.4)', () => {
  let runsHome: string;
  let parentDir: string;

  beforeAll(async () => {
    runsHome = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-child-run-'));
    parentDir = path.join(runsHome, 'parent-1');
    const res = await runFromTemplate(FIXTURE, { run: 'parent-1', runDir: parentDir, buildCommand: stubBuilder() });
    expect(res.status.ok).toBe(true);
    expect(await fs.readFile(path.join(parentDir, 'draft.txt'), 'utf8')).toBe('draft');
    expect(await fs.readFile(path.join(parentDir, 'final.txt'), 'utf8')).toBe('publish');

    // Simulate a prior LOCAL run's warm sessions (spawnChildRun must clear ONLY the target node's).
    const sessDir = path.join(parentDir, '.pi-sessions');
    await fs.mkdir(sessDir, { recursive: true });
    await fs.writeFile(path.join(sessDir, '20260706120000_publish.jsonl'), '{"type":"session"}\n');
    await fs.writeFile(path.join(sessDir, '20260706120000_draft.jsonl'), '{"type":"session"}\n');
  });
  afterAll(async () => {
    await fs.rm(runsHome, { recursive: true, force: true });
  });

  it('re-runs ONLY the target node: write-scope reset (regenerated), upstream untouched, lineage + session-clear', async () => {
    const expectedChildId = childRunName('parent-1', 'publish', ['parent-1']);
    const expectedChildDir = path.join(runsHome, expectedChildId);

    // Observe, at BUILD TIME (host-side, before the shell command ever runs), whether the child's
    // final.txt still exists — proving the RESET (delete-then-regenerate) actually happened, not just
    // that the stub happens to overwrite unconditionally.
    let finalExistedAtBuildTime: boolean | undefined;
    const observingBuild = (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
      if (node.id === 'publish') finalExistedAtBuildTime = existsSync(path.join(expectedChildDir, 'final.txt'));
      return stubBuilder()(node);
    };

    const { childId, childDir, result } = await spawnChildRun(parentDir, 'publish', {
      templateDir: FIXTURE,
      spawnedBy: { by: 'substrate-fix', issue: 'soggy-crust', issueId: 'sha256:abc' },
      buildCommand: observingBuild,
    });

    expect(childId).toBe(expectedChildId);
    expect(childDir).toBe(expectedChildDir);

    // (1) ONLY the target node re-ran; the upstream node was REUSED (skipped), not re-executed.
    expect(result.status.nodes.draft.status).toBe('reused');
    expect(result.status.nodes.publish.status).toBe('ok');

    // (2) the reset actually happened: final.txt was ABSENT at the moment the node's command was built
    // (deleted from the bundled copy), then REGENERATED by the node's own re-run.
    expect(finalExistedAtBuildTime).toBe(false);
    expect(await fs.readFile(path.join(childDir, 'final.txt'), 'utf8')).toBe('publish');

    // (3) upstream artifacts are untouched — carried verbatim from the parent's copy, never regenerated.
    expect(await fs.readFile(path.join(childDir, 'draft.txt'), 'utf8')).toBe('draft');

    // (4) lineage recorded into the child's run.json.
    expect(result.status.parent).toBe('parent-1');
    expect(result.status.spawnedBy).toEqual({ by: 'substrate-fix', issue: 'soggy-crust', issueId: 'sha256:abc' });

    // (5) the target node's warm session was cleared (cold start); a DIFFERENT node's session survives.
    const childSessions = await fs.readdir(path.join(childDir, '.pi-sessions')).catch(() => [] as string[]);
    expect(childSessions.some((f) => f.endsWith('_publish.jsonl'))).toBe(false);
    expect(childSessions.some((f) => f.endsWith('_draft.jsonl'))).toBe(true);
  });

  it('an UNKNOWN node id throws before anything is spawned (no child dir created)', async () => {
    // Reuse the real template but ask for a node id that isn't in it — spawnChildRun's compiled-workflow
    // lookup (guarding the SAME resolveChildWindow this pins directly above) fires before any pack/unpack/run I/O.
    await expect(
      spawnChildRun(parentDir, 'ghost-node', { templateDir: FIXTURE, spawnedBy: { by: 'substrate-fix' } }),
    ).rejects.toThrow(/unknown node "ghost-node"/);
    expect(existsSync(path.join(runsHome, 'parent-1.ghost-node'))).toBe(false);
  });
});
