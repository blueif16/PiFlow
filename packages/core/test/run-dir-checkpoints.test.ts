import { describe, it, expect } from 'vitest';
import { promises as fs, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';
import { loadJournal } from '../src/runner/journal.js';
import {
  snapshotGitDir,
  snapshotList,
  snapshotRestore,
  snapshotExists,
} from '../src/runner/snapshot.js';

// ── harness (mirrors freeze-resume.test.ts) ──────────────────────────────────────────────────────────
function n(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return { label, prompt: `do ${label}`, tools: {}, io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) }, ...over };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 'ckpt-t', description: 'd' }, nodes });
/** Offline builder: each node writes its declared artifacts into its sandbox output dir + an ok return. */
function stubBuilder() {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => `mkdir -p ${node.sandbox.output} && printf '%s' ${node.id} > ${node.sandbox.output}/${a.path}`)
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok"}\\n\`\`\`'`;
    return `${writes} && ${ret}`;
  };
}
// A → B → C (each reads the prior's artifact) ⇒ THREE topological stages (0,1,2).
const threeStage = () => compile(wf([n('A', [], ['a.txt']), n('B', ['a.txt'], ['b.txt']), n('C', ['b.txt'], ['c.txt'])]));

/** A run dir under the canonical `.piflow/<wf>/runs/<id>` layout so `snapshotGitDir` derives the sibling store. */
async function tmpRun(): Promise<{ runDir: string; gitDir: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-ckpt-'));
  const runDir = path.join(base, '.piflow', 'wf', 'runs', 'r1');
  await fs.mkdir(runDir, { recursive: true });
  return { runDir, gitDir: snapshotGitDir(runDir) };
}

const runAll = (outDir: string, over: Record<string, unknown> = {}) =>
  runWorkflow(threeStage(), { outDir, buildCommand: stubBuilder() as never, lease: false, ...over });

describe('run-dir git checkpoints', () => {
  it('R1 · R5: --checkpoints commits pre-stage-0..N (C0 + one per stage); node_modules is NOT tracked', async () => {
    const { runDir, gitDir } = await tmpRun();
    // A pre-existing node_modules — the ignore floor must keep it out of the store (R5, first half).
    mkdirSync(path.join(runDir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(path.join(runDir, 'node_modules', 'dep', 'index.js'), 'BIG');

    const res = await runAll(runDir, { checkpoints: true });
    expect(res.status.done).toBe(true);
    expect(res.status.ok).toBe(true);

    // C0 (pre-stage-0) + one commit per barrier of the 3 stages = pre-stage-0..pre-stage-3 (4 tags).
    const tags = snapshotList(gitDir, runDir).map((e) => e.tag);
    expect(tags).toEqual(['pre-stage-0', 'pre-stage-1', 'pre-stage-2', 'pre-stage-3']);

    // R5 (second half): node_modules is not in the committed tree.
    const tracked = execFileSync('git', ['ls-files'], {
      env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: runDir },
    }).toString();
    expect(tracked).not.toContain('node_modules');
    expect(tracked).toContain('a.txt');
    expect(tracked).toContain('.pi/journal.json');
  });

  it('R2 · R3 · R6: restoring pre-stage-1 drops the downstream files + reverts the journal; a plain re-run replays from stage 1', async () => {
    const { runDir, gitDir } = await tmpRun();
    mkdirSync(path.join(runDir, 'node_modules'), { recursive: true });
    writeFileSync(path.join(runDir, 'node_modules', 'keep.txt'), 'survive-me');

    // 1) a full checkpointed run — all three artifacts + all three journal entries land.
    const first = await runAll(runDir, { checkpoints: true });
    expect(first.status.ok).toBe(true);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) expect(existsSync(path.join(runDir, f))).toBe(true);
    const jFull = await loadJournal(runDir);
    expect(jFull?.nodes.a && jFull?.nodes.b && jFull?.nodes.c).toBeTruthy();

    // 2) restore the ENTRY tree of stage 1 (after A ran, before B).
    const restore = snapshotRestore(gitDir, runDir, 'pre-stage-1');
    expect(restore.ok).toBe(true);

    // (a) the DOWNSTREAM files (written in stages 1 & 2) are GONE; stage-0's output stays. node_modules survives.
    expect(existsSync(path.join(runDir, 'a.txt'))).toBe(true);
    expect(existsSync(path.join(runDir, 'b.txt'))).toBe(false);
    expect(existsSync(path.join(runDir, 'c.txt'))).toBe(false);
    expect(existsSync(path.join(runDir, 'node_modules', 'keep.txt'))).toBe(true); // ignored ⇒ untouched (R5)

    // (b) the JOURNAL lost stage 1+ entries — A remains, B and C are gone.
    const jReverted = await loadJournal(runDir);
    expect(jReverted?.nodes.a).toBeTruthy();
    expect(jReverted?.nodes.b).toBeUndefined();
    expect(jReverted?.nodes.c).toBeUndefined();

    // (c) a PLAIN re-run (checkpoints OFF — proves R6: replay works without the flag) drives seedFromJournal off
    // the reverted journal: stage 0 REUSED, stages 1+ RE-EXECUTE. No --from needed.
    const second = await runAll(runDir); // checkpoints off
    expect(second.status.done).toBe(true);
    expect(second.status.ok).toBe(true);
    expect(second.status.nodes.a.status).toBe('reused'); // stage < 1 ⇒ reused
    expect(second.status.nodes.b.status).toBe('ok'); // stage 1 ⇒ re-ran
    expect(second.status.nodes.c.status).toBe('ok'); // stage 2 ⇒ re-ran
    expect(existsSync(path.join(runDir, 'b.txt'))).toBe(true); // regenerated
    expect(existsSync(path.join(runDir, 'c.txt'))).toBe(true);
  });

  it('the R2/R3 proof is REAL: WITHOUT the restore the downstream survives, the journal keeps every stage, and a re-run reuses ALL', async () => {
    // The red-check made permanent: this is the R2/R3 scenario with the `snapshotRestore` call OMITTED. If the
    // checkout were a no-op (didn't reset the tree/journal), R2/R3's "gone / undefined / re-ran" assertions
    // would look EXACTLY like this — so these opposite assertions pin that the restore is what does the work.
    const { runDir } = await tmpRun();
    const first = await runAll(runDir, { checkpoints: true });
    expect(first.status.ok).toBe(true);

    // No restore. The downstream files + full journal are still present.
    expect(existsSync(path.join(runDir, 'b.txt'))).toBe(true);
    expect(existsSync(path.join(runDir, 'c.txt'))).toBe(true);
    const j = await loadJournal(runDir);
    expect(j?.nodes.b).toBeTruthy();
    expect(j?.nodes.c).toBeTruthy();

    // And a re-run with the intact journal REUSES every node — nothing replays (the exact inverse of R3).
    const second = await runAll(runDir);
    expect(second.status.nodes.a.status).toBe('reused');
    expect(second.status.nodes.b.status).toBe('reused');
    expect(second.status.nodes.c.status).toBe('reused');
  });

  it('R4: a failing git at the barrier does NOT fail the run (best-effort)', async () => {
    const { runDir, gitDir } = await tmpRun();
    // Plant a FILE where the checkpoints dir must be created — so `snapshotInit`'s mkdir/`git init` throws and
    // every barrier commit no-ops. The run must still finish green.
    const ckParent = path.dirname(gitDir); // .piflow/wf/checkpoints
    await fs.writeFile(ckParent, 'not-a-dir'); // occupy the path with a file

    const res = await runAll(runDir, { checkpoints: true });
    expect(res.status.done).toBe(true);
    expect(res.status.ok).toBe(true); // git blew up, the run did not
    expect(snapshotExists(gitDir)).toBe(false); // no store was ever created
    for (const f of ['a.txt', 'b.txt', 'c.txt']) expect(existsSync(path.join(runDir, f))).toBe(true);
  });

  it('R6: checkpoints OFF ⇒ no store is created (additive default, byte-identical)', async () => {
    const { runDir, gitDir } = await tmpRun();
    const res = await runAll(runDir); // no checkpoints option
    expect(res.status.done).toBe(true);
    expect(res.status.ok).toBe(true);
    expect(snapshotExists(gitDir)).toBe(false); // the git store never came into existence
    for (const f of ['a.txt', 'b.txt', 'c.txt']) expect(existsSync(path.join(runDir, f))).toBe(true);
  });
});
