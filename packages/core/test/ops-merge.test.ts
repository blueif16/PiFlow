// Ported from game-omni pi-runner/hooks/test/merge.test.mjs — the DRIVER-MERGE filesystem-merge ops
// (concat | reconcile | fold | run), re-rooted onto the U7 resolver (relative paths resolve under
// `projectBase` = the resolved {{RUN}}). The optional ajv schema gate is dropped (a game-omni consumer
// concern; flagged) — the transforms themselves are byte-preserving.
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMergeOp, runMerge } from '../src/index.js';

let tmp: string | undefined;
afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const mkTmp = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-merge-'));
const readJson = async (p: string): Promise<any> => JSON.parse(await fs.readFile(p, 'utf8'));
const writeJson = async (p: string, o: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(o, null, 2) + '\n');
};
const writeText = async (p: string, s: string): Promise<void> => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, s);
};

// ---------- concat ----------
describe('applyMergeOp — concat', () => {
  it('globs matching files, stable lexical order, each under a formatted heading; excludes the dest', async () => {
    tmp = await mkTmp();
    await writeText(path.join(tmp, 'MEMORY.b.md'), 'B body\n\n');
    await writeText(path.join(tmp, 'MEMORY.a.md'), 'A body');
    await writeText(path.join(tmp, 'MEMORY.md'), 'STALE — must be excluded (it is the dest)');
    const res = await applyMergeOp(
      { concat: { glob: 'MEMORY.*.md', to: 'MEMORY.md', heading: '## {name}' } },
      tmp,
    );
    expect(res).toEqual({ op: 'concat', to: 'MEMORY.md', wrote: true, merged: 2 });
    expect(await fs.readFile(path.join(tmp, 'MEMORY.md'), 'utf8')).toBe(
      '## MEMORY.a.md\n\nA body\n\n## MEMORY.b.md\n\nB body\n',
    );
  });

  it('skips (0 files) when nothing matches', async () => {
    tmp = await mkTmp();
    const res = await applyMergeOp({ concat: { glob: 'NONE.*.md', to: 'out.md' } }, tmp);
    expect(res).toEqual({ op: 'concat', to: 'out.md', wrote: false, skipped: 'no files match NONE.*.md', merged: 0 });
  });
});

// ---------- reconcile ----------
describe('applyMergeOp — reconcile', () => {
  it('copies manifest fields onto matching rows; conditional `when`; untouched rows kept', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'index.json'), {
      slots: [
        { slot: 'hero', status: 'pending', path: 'sprites/hero.png' },
        { slot: 'coin', status: 'pending', path: 'sprites/coin.png' },
        { slot: 'orphan', status: 'pending', path: 'sprites/orphan.png' },
      ],
    });
    await writeJson(path.join(tmp, 'asset-manifest.json'), {
      slots: {
        hero: { status: 'generated', path: 'sprites/hero.real.png' },
        coin: { status: 'failed', path: 'sprites/coin.real.png' },
      },
    });
    const opSpec = {
      reconcile: {
        from: 'asset-manifest.json',
        to: 'index.json',
        key: 'slot',
        fields: ['status', { name: 'path', when: { field: 'status', equals: 'generated' } }],
      },
    };
    const res = await applyMergeOp(opSpec, tmp);
    expect(res.op).toBe('reconcile');
    expect(res.reconciled).toBe(2);
    const out = await readJson(path.join(tmp, 'index.json'));
    expect(out.slots[0]).toEqual({ slot: 'hero', status: 'generated', path: 'sprites/hero.real.png' });
    expect(out.slots[1]).toEqual({ slot: 'coin', status: 'failed', path: 'sprites/coin.png' });
    expect(out.slots[2]).toEqual({ slot: 'orphan', status: 'pending', path: 'sprites/orphan.png' });
  });

  it('is GRACEFUL when the source manifest is absent (target left unchanged)', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'index.json'), { slots: [{ slot: 'a', status: 'pending' }] });
    const res = await applyMergeOp({ reconcile: { from: 'nope.json', to: 'index.json', fields: ['status'] } }, tmp);
    expect(res.wrote).toBe(false);
    expect(res.skipped).toMatch(/source unreadable/);
    expect(await readJson(path.join(tmp, 'index.json'))).toEqual({ slots: [{ slot: 'a', status: 'pending' }] });
  });
});

// ---------- fold ----------
describe('applyMergeOp — fold', () => {
  it('sets to[into] = the parsed fragment (synchronous read-modify-write; sibling untouched)', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'blueprint.json'), { meta: { x: 1 }, shell: { OLD: true } });
    await writeJson(path.join(tmp, 'shell.fragment.json'), { hud: ['score'], intro: 'go' });
    const res = await applyMergeOp(
      { fold: { from: 'shell.fragment.json', to: 'blueprint.json', into: 'shell' } },
      tmp,
    );
    expect(res).toEqual({ op: 'fold', to: 'blueprint.json', wrote: true, into: 'shell' });
    const out = await readJson(path.join(tmp, 'blueprint.json'));
    expect(out.shell).toEqual({ hud: ['score'], intro: 'go' });
    expect(out.meta).toEqual({ x: 1 });
  });

  it('is GRACEFUL when the fragment is absent (target unchanged)', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'b.json'), { keep: 1 });
    const res = await applyMergeOp({ fold: { from: 'missing.json', to: 'b.json', into: 'shell' } }, tmp);
    expect(res.wrote).toBe(false);
    expect(await readJson(path.join(tmp, 'b.json'))).toEqual({ keep: 1 });
  });
});

// ---------- run (subprocess exec) ----------
describe('applyMergeOp — run', () => {
  it('reports failed:true on a non-zero exit', async () => {
    tmp = await mkTmp();
    const res = await applyMergeOp({ run: { cmd: '/usr/bin/false' } }, tmp);
    expect(res.op).toBe('run');
    expect(res.failed).toBe(true);
    expect(res.exit).not.toBe(0);
  });

  it('captures stdout on a non-zero exit — a check script that prints its verdict to stdout (not stderr) must not go dark', async () => {
    // Live gap (run 260715-01): a failing gate script's real verdict text rode ONLY stderr in the MergeResult,
    // so a check that reports on stdout (common — most CLIs reserve stderr for actual errors) silently dropped
    // its verdict; the op-failure detail fell back to a bare "merge run failed (exit 1)". `spawnSync` already
    // captures stdout into `out` (line ~213) but the failure branch discarded it — this pins that it now rides.
    tmp = await mkTmp();
    const res = await applyMergeOp(
      { run: { cmd: 'node', args: ['-e', "console.log('capability-refs: bad id at mechanics[4]'); process.exit(1)"] } },
      tmp,
    );
    expect(res.failed).toBe(true);
    expect(res.stderr ?? '').toBe(''); // this failure mode has NOTHING on stderr — the live shape
    expect(res.stdout).toContain('capability-refs: bad id at mechanics[4]');
  });

  it('succeeds (exit 0) on a true command', async () => {
    tmp = await mkTmp();
    const res = await applyMergeOp({ run: { cmd: '/usr/bin/true' } }, tmp);
    expect(res.wrote).toBe(true);
    expect(res.exit).toBe(0);
  });

  it('resolves a BARE `node` cmd via the interpreter, not <project>/node (the ENOENT regression)', async () => {
    tmp = await mkTmp();
    const receipt = path.join(tmp, 'ran.txt');
    const res = await applyMergeOp(
      { run: { cmd: 'node', args: ['-e', `require('fs').writeFileSync(${JSON.stringify(receipt)}, 'ok')`] } },
      tmp,
    );
    expect(res.op).toBe('run');
    expect(res.wrote).toBe(true);
    expect(res.exit).toBe(0);
    expect(await fs.readFile(receipt, 'utf8')).toBe('ok');
  });
});

// ---------- runMerge wrapper ----------
describe('runMerge', () => {
  it('runs each op and aggregates; null/no-ops spec ⇒ null', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'b.json'), { shell: null });
    await writeJson(path.join(tmp, 'f.json'), { ok: 1 });
    const out = await runMerge({ ops: [{ fold: { from: 'f.json', to: 'b.json', into: 'shell' } }] }, tmp);
    expect(out?.ops.length).toBe(1);
    expect(out?.ops[0].wrote).toBe(true);
    expect(await runMerge(null, tmp)).toBe(null);
    expect(await runMerge({ notOps: true } as any, tmp)).toBe(null);
  });
});
