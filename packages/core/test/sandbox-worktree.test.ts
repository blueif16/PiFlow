import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/dag.js';
import { runWorkflow } from '../src/runner/runner.js';
import type { NodeIntent, WorkflowSpec } from '../src/types.js';
import { WorktreeSandboxProvider } from '../src/sandbox/worktree.js';

// ─────────────────────────────────────────────────────────────────────────────
// These tests run the WorktreeSandboxProvider ONLY against a THROWAWAY git repo —
// `git init` in an OS temp dir, committed — passed as `repoRoot`. NEVER against the
// Pi Flow repo itself (that would create real `pi/<run>` branches + a `.pi-worktrees/`
// dir in our repo). Each fixture cleans up its temp repo, its sibling worktree dir,
// AND the branch it made, in a finally.
// ─────────────────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

/**
 * Stand up a throwaway git repo: an isolated parent dir (so the sibling `.pi-worktrees/<run>` the
 * provider creates lands under OUR temp tree, never the real cwd's parent), a `repo/` checkout inside
 * it with one committed file. Returns { parent, repoRoot } + a cleanup that nukes the whole parent.
 */
async function tmpRepo(): Promise<{ parent: string; repoRoot: string; cleanup: () => Promise<void> }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-wt-fixture-'));
  const repoRoot = path.join(parent, 'repo');
  await fs.mkdir(repoRoot, { recursive: true });
  git(repoRoot, 'init', '-q');
  git(repoRoot, 'config', 'user.email', 'test@piflow.local');
  git(repoRoot, 'config', 'user.name', 'Pi Flow Test');
  git(repoRoot, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoRoot, 'README.md'), '# fixture\n');
  await fs.writeFile(path.join(repoRoot, '.gitignore'), 'out/\nnode_modules/\n');
  git(repoRoot, 'add', '-A');
  git(repoRoot, 'commit', '-q', '-m', 'init');
  const cleanup = async (): Promise<void> => {
    await fs.rm(parent, { recursive: true, force: true });
  };
  return { parent, repoRoot, cleanup };
}

// ── workflow helpers (mirror runner.test.ts / sandbox-seatbelt.test.ts) ─────────────────────────────

function n(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return {
    label,
    prompt: `do ${label}`,
    tools: {},
    io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) },
    ...over,
  };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
async function tmpOut(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-wt-run-'));
}

// The stub command builder (port of runner.test.ts): each node writes its declared artifacts into its
// sandbox OUTPUT dir at <output>/<path> (downloadDir flattens onto the host run dir), plus a return JSON.
function stubBuilder() {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => {
        const dest = `${node.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${node.id} done"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

// ── 1. plugs into runWorkflow unchanged ─────────────────────────────────────────────────────────────

describe('WorktreeSandboxProvider — plugs into runWorkflow unchanged', () => {
  it('runs a producer→consumer workflow under a git worktree: nodes ok, artifacts on host outDir', async () => {
    // The whole point: `provider: new WorktreeSandboxProvider()` drops into the EXISTING runner with no
    // runner change. The runner calls openRun (one worktree for the run), every node's sandbox is a view
    // INSIDE it, and the per-node downloadDir collects each artifact onto the host run dir. A producer →
    // consumer (the consumer reads the producer's artifact, staged across sandboxes via the host run dir).
    const { repoRoot, cleanup } = await tmpRepo();
    const outDir = await tmpOut();
    try {
      const g = compile(wf([n('Producer', [], ['a.txt']), n('Consumer', ['a.txt'], ['b.txt'])]));
      const { status } = await runWorkflow(g, {
        run: 'wt-e2e',
        outDir,
        repoRoot,
        provider: new WorktreeSandboxProvider(),
        buildCommand: stubBuilder(),
        nodeTimeoutMs: 15000,
      });

      expect(status.ok).toBe(true);
      expect(status.done).toBe(true);
      expect(status.nodes.producer.status).toBe('ok');
      expect(status.nodes.consumer.status).toBe('ok');
      // Both artifacts landed on the HOST run dir (downloadDir flattened <output>/<path> → host).
      expect(await fs.readFile(path.join(outDir, 'a.txt'), 'utf8')).toBe('producer');
      expect(await fs.readFile(path.join(outDir, 'b.txt'), 'utf8')).toBe('consumer');
    } finally {
      try { git(repoRoot, 'worktree', 'prune'); } catch { /* fixture teardown */ }
      await fs.rm(outDir, { recursive: true, force: true });
      await cleanup();
    }
  }, 30000);
});

// ── 2. write-isolation: nodes write INSIDE the worktree, NOT the main checkout ──────────────────────

describe('WorktreeSandboxProvider — write isolation (main checkout stays clean)', () => {
  it('node scratch writes land in the worktree branch, never the main working tree', async () => {
    // Prove the isolation is REAL: a node writes a scratch file at the repo ROOT of its sandbox (workdir
    // '.'), which — under this provider — is the WORKTREE root, not the main checkout. After the run, the
    // main checkout's working tree must be CLEAN of that scratch file (it only exists on the pi/<run>
    // branch, committed by dispose), proving the node's writes never touched the main tree. If create()
    // wrongly used the main checkout, `scratch.txt` would appear in the main repoRoot and `git status`
    // there would be dirty — both assertions below would then fail.
    const { repoRoot, cleanup } = await tmpRepo();
    const outDir = await tmpOut();
    const run = 'wt-iso';
    try {
      // A node whose command writes a scratch file at its workdir root (the worktree root) IN ADDITION to
      // its declared artifact. workspace '.' ⇒ workdir IS the worktree root.
      const builder = (node: { id: string; sandbox: { output: string } }): string =>
        `printf '%s' scratch > scratch.txt && ` +
        `mkdir -p ${node.sandbox.output} && printf '%s' ${node.id} > ${node.sandbox.output}/done.txt && ` +
        `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"done"}\\n\`\`\`'`;
      const g = compile(wf([n('Writer', [], ['done.txt'], { sandbox: { workspace: '.' } })]));

      const { status } = await runWorkflow(g, {
        run,
        outDir,
        repoRoot,
        provider: new WorktreeSandboxProvider(),
        buildCommand: builder,
        nodeTimeoutMs: 15000,
      });
      expect(status.nodes.writer.status).toBe('ok');

      // (a) The MAIN checkout working tree never saw the scratch file.
      await expect(fs.access(path.join(repoRoot, 'scratch.txt'))).rejects.toThrow();
      // (b) `git status` on the MAIN checkout is CLEAN (no untracked/modified — the writes were isolated).
      expect(git(repoRoot, 'status', '--porcelain')).toBe('');
      // (c) The scratch file DOES exist on the run's branch (the work is captured by dispose's commit) —
      //     read the blob straight from the branch tip without checking it out.
      expect(git(repoRoot, 'show', `pi/${run}:scratch.txt`)).toBe('scratch');
    } finally {
      try { git(repoRoot, 'branch', '-D', `pi/${run}`); } catch { /* fixture teardown */ }
      try { git(repoRoot, 'worktree', 'prune'); } catch { /* fixture teardown */ }
      await fs.rm(outDir, { recursive: true, force: true });
      await cleanup();
    }
  }, 30000);

  it('two runs with different run ids get different, non-colliding worktree paths', async () => {
    // Distinct run ids ⇒ distinct `.pi-worktrees/<run>` checkouts + distinct `pi/<run>` branches, so two
    // runs cannot collide. We open each scope, assert the roots differ and both live under the fixture's
    // sibling `.pi-worktrees`, then dispose both.
    const { parent, repoRoot, cleanup } = await tmpRepo();
    const provider = new WorktreeSandboxProvider();
    try {
      const a = await provider.openRun({ run: 'run-a', repoRoot, outDir: path.join(parent, 'out-a') });
      const b = await provider.openRun({ run: 'run-b', repoRoot, outDir: path.join(parent, 'out-b') });
      try {
        expect(a.root).not.toBe(b.root);
        expect(a.root).toBe(path.join(parent, '.pi-worktrees', 'run-a'));
        expect(b.root).toBe(path.join(parent, '.pi-worktrees', 'run-b'));
        // Both checkouts physically exist and are independent dirs.
        expect((await fs.stat(a.root)).isDirectory()).toBe(true);
        expect((await fs.stat(b.root)).isDirectory()).toBe(true);
      } finally {
        await a.dispose();
        await b.dispose();
      }
    } finally {
      try { git(repoRoot, 'branch', '-D', 'pi/run-a'); } catch { /* teardown */ }
      try { git(repoRoot, 'branch', '-D', 'pi/run-b'); } catch { /* teardown */ }
      try { git(repoRoot, 'worktree', 'prune'); } catch { /* teardown */ }
      await cleanup();
    }
  }, 30000);
});

// ── 3. durable branch + teardown ────────────────────────────────────────────────────────────────────

describe('WorktreeSandboxProvider — durable branch, removed checkout', () => {
  it('after dispose: branch pi/<run> EXISTS (work durable) and the worktree checkout is GONE', async () => {
    // The dispose contract (port of finishWorktree): commit the run to its branch (durable for a
    // human-gated merge), then `git worktree remove` the checkout (the branch persists). So after a full
    // run: the branch is listed AND the worktree dir no longer exists / is no longer a registered
    // worktree. If dispose skipped the commit, the branch would be empty/absent of the run's work; if it
    // skipped the remove, the dir + the worktree registration would linger — each is caught below.
    const { repoRoot, cleanup } = await tmpRepo();
    const outDir = await tmpOut();
    const run = 'wt-durable';
    const wtPath = path.join(path.dirname(repoRoot), '.pi-worktrees', run);
    try {
      const g = compile(wf([n('Maker', [], ['m.txt'])]));
      const { status } = await runWorkflow(g, {
        run,
        outDir,
        repoRoot,
        provider: new WorktreeSandboxProvider(),
        buildCommand: stubBuilder(),
        nodeTimeoutMs: 15000,
      });
      expect(status.ok).toBe(true);

      // (a) The branch EXISTS — the run's work is durable.
      expect(git(repoRoot, 'branch', '--list', `pi/${run}`)).toContain(`pi/${run}`);
      // (b) The worktree CHECKOUT is gone — both the dir and the worktree registration.
      await expect(fs.access(wtPath)).rejects.toThrow();
      expect(git(repoRoot, 'worktree', 'list')).not.toContain(wtPath);
      // (c) The branch tip carries a real commit by this provider (not the fixture's `init`).
      expect(git(repoRoot, 'log', '-1', '--format=%s', `pi/${run}`)).toContain(`pi(${run})`);
    } finally {
      try { git(repoRoot, 'branch', '-D', `pi/${run}`); } catch { /* teardown */ }
      try { git(repoRoot, 'worktree', 'prune'); } catch { /* teardown */ }
      await fs.rm(outDir, { recursive: true, force: true });
      await cleanup();
    }
  }, 30000);

  it('bare create() rejects — the worktree provider requires the run-scoped openRun path', async () => {
    // The non-scoped fallback is an explicit guard: a worktree is run-level, so a per-node create with no
    // run scope has no shared worktree to place the node in. It must reject with a clear pointer to
    // openRun. (If it silently created a throwaway worktree, this assertion would fail.)
    const provider = new WorktreeSandboxProvider();
    await expect(
      provider.create({ readScope: [], outputDir: 'out', workdir: '.' }),
    ).rejects.toThrow(/openRun|run-scoped/);
  });
});
