import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';
import { stashNodeOwns, ownsPath } from '../src/runner/stash.js';
import type { NodeSpec } from '../src/types.js';

// ── harness (mirrors freeze-resume.test.ts) ─────────────────────────────────────────────────────
function n(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return { label, prompt: `do ${label}`, tools: {}, io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) }, ...over };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 'stash-t', description: 'd' }, nodes });
async function tmpOut(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-stash-'));
}
/** Offline builder: each node writes its declared artifacts (given content) + an ok return. */
function stubBuilder(content: (id: string) => string) {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => `mkdir -p ${node.sandbox.output} && printf '%s' ${content(node.id)} > ${node.sandbox.output}/${a.path}`)
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok"}\\n\`\`\`'`;
    return `${writes} && ${ret}`;
  };
}
// A → B; B owns its artifact (sandbox.write = contract.owns after template load).
const twoStage = () =>
  compile(wf([
    n('A', [], ['a.txt'], { sandbox: { write: ['a.txt'] } }),
    n('B', ['a.txt'], ['b.txt'], { sandbox: { write: ['b.txt'] } }),
  ]));

async function stashEntries(outDir: string, nodeId: string): Promise<string[]> {
  const dir = path.join(outDir, '.pi', 'stash', nodeId);
  if (!existsSync(dir)) return [];
  return fs.readdir(dir);
}

describe('node --rerun stashes the target\'s owned artifacts (fresh production, never confirm)', () => {
  it('moves the prior artifact into .pi/stash/<node>/<stamp>/ and the rerun produces fresh bytes', async () => {
    const outDir = await tmpOut();
    // 1) full run — both artifacts land at the run root.
    const r1 = await runWorkflow(twoStage(), { outDir, buildCommand: stubBuilder(() => 'v1') as never, lease: false });
    expect(r1.status.ok).toBe(true);
    expect(await fs.readFile(path.join(outDir, 'b.txt'), 'utf8')).toBe('v1');

    // 2) rerun ONLY b, producing different bytes.
    const r2 = await runWorkflow(twoStage(), {
      outDir,
      buildCommand: stubBuilder(() => 'v2') as never,
      rerunNodes: new Set(['b']),
      lease: false,
    });
    expect(r2.status.ok).toBe(true);
    expect(r2.status.nodes['a'].status).toBe('reused');

    // The PRIOR bytes were stashed (not lost, not left in place to be "confirmed").
    const stamps = await stashEntries(outDir, 'b');
    expect(stamps.length).toBe(1);
    const stashedFile = path.join(outDir, '.pi', 'stash', 'b', stamps[0], 'b.txt');
    expect(await fs.readFile(stashedFile, 'utf8')).toBe('v1');

    // The rerun REPRODUCED the artifact fresh.
    expect(await fs.readFile(path.join(outDir, 'b.txt'), 'utf8')).toBe('v2');

    // The reused node's artifact was NEVER touched.
    expect(await fs.readFile(path.join(outDir, 'a.txt'), 'utf8')).toBe('v1');
    expect(await stashEntries(outDir, 'a')).toEqual([]);
  });

  it('a plain resume (no rerunNodes) never stashes anything', async () => {
    const outDir = await tmpOut();
    await runWorkflow(twoStage(), { outDir, buildCommand: stubBuilder(() => 'v1') as never, lease: false });
    const r2 = await runWorkflow(twoStage(), { outDir, buildCommand: stubBuilder(() => 'v2') as never, lease: false });
    expect(r2.status.ok).toBe(true);
    expect(existsSync(path.join(outDir, '.pi', 'stash'))).toBe(false);
    // full reuse — bytes untouched
    expect(await fs.readFile(path.join(outDir, 'b.txt'), 'utf8')).toBe('v1');
  });
});

describe('stashNodeOwns (unit)', () => {
  const spec = (write: string[]): NodeSpec =>
    compile(wf([n('X', [], ['x.txt'], { sandbox: { write } })])).nodes['x'];

  it('moves files and glob-suffixed dirs; returns the stashed set', async () => {
    const outDir = await tmpOut();
    await fs.writeFile(path.join(outDir, 'x.txt'), 'X');
    await fs.mkdir(path.join(outDir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'assets', 'one.png'), 'P');
    const node = spec(['x.txt', 'assets/**']);
    const res = await stashNodeOwns(outDir, node, { run: outDir, workspace: outDir, state: {} }, 'stamp1');
    expect(res?.stashed.sort()).toEqual(['assets', 'x.txt']);
    expect(existsSync(path.join(outDir, 'x.txt'))).toBe(false);
    expect(existsSync(path.join(outDir, 'assets'))).toBe(false);
    expect(await fs.readFile(path.join(outDir, '.pi', 'stash', 'x', 'stamp1', 'x.txt'), 'utf8')).toBe('X');
    expect(await fs.readFile(path.join(outDir, '.pi', 'stash', 'x', 'stamp1', 'assets', 'one.png'), 'utf8')).toBe('P');
  });

  it('skips glob-only entries, paths outside the run dir, and missing files (no-op ⇒ null)', async () => {
    const outDir = await tmpOut();
    const outside = await tmpOut();
    await fs.writeFile(path.join(outside, 'w.txt'), 'W');
    // '**' must never resolve to the run root; an absolute path outside outDir must never be stashed.
    const node = spec(['**', path.join(outside, 'w.txt'), 'missing.txt']);
    const res = await stashNodeOwns(outDir, node, { run: outDir, workspace: outDir, state: {} }, 'stamp1');
    expect(res).toBeNull();
    expect(await fs.readFile(path.join(outside, 'w.txt'), 'utf8')).toBe('W'); // untouched
    expect(existsSync(path.join(outDir, '.pi', 'stash'))).toBe(false);
  });
});

describe('ownsPath (unit)', () => {
  it('strips trailing glob suffixes to the concrete root', () => {
    expect(ownsPath('spec/blueprint.json')).toBe('spec/blueprint.json');
    expect(ownsPath('assets/**')).toBe('assets');
    expect(ownsPath('assets/*')).toBe('assets');
    expect(ownsPath('**')).toBe('');
  });
});
