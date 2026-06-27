// (G13 — M5) op[]-derive PARITY — the silent-derive red bar. A node authored DIRECTLY in the unified
// `op[]` envelope whose body is a DERIVE transform (seed/project/merge/promote/projectRegistry) must
// compile to the SAME runtime `NodeSpec.ops` as its `hooks`-authored TWIN. This is load-bearing: the
// runner's POST-derive executors read `node.ops?.{seed,project,merge,promote,registryProject}` (runner.ts
// ~999/1048/1056/1069/1161 + ~1356/1537/1545/1564/1795). Before the loader's inverse back-fill, an
// op[]-authored derive set `node.op` but left `node.ops` UNDEFINED — so those executors never fired and
// the derive SILENTLY never ran. Intent-layer `node.ops` parity ⇒ runtime parity (the executors are shared).
//
// Written test-first: today `loadTemplate` only single-sources `node.ops` from `n.def.hooks`, so the
// op[]-authored twin's `node.ops` is undefined and the parity assertion goes RED for the right reason.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTemplate, compile } from '../src/index.js';
import type { NodeOps } from '../src/types.js';

const writeJson = (p: string, v: unknown): Promise<void> => fs.writeFile(p, JSON.stringify(v, null, 2) + '\n');

/** Stand up a one-node template in a fresh tmp dir from the given node.json def + prose. */
async function templateWith(def: Record<string, unknown>, prose = 'do the thing'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-derive-parity-'));
  await writeJson(path.join(dir, 'meta.json'), { id: 't', name: 't', description: 'd', phases: ['build'] });
  const ndir = path.join(dir, 'nodes', String(def.id));
  await fs.mkdir(ndir, { recursive: true });
  await writeJson(path.join(ndir, 'node.json'), def);
  await fs.writeFile(path.join(ndir, 'prompt.md'), prose);
  return dir;
}

/** Compile a template dir → the single node's dense NodeSpec.ops. */
async function compiledOps(dir: string, id: string): Promise<NodeOps | undefined> {
  const wf = compile(await loadTemplate(dir));
  return wf.nodes[id].ops;
}

/** The shared contract for both twins (artifacts/owns/readScope). */
const contract = {
  artifacts: ['out/report.json'],
  owns: ['out/**'],
  readScope: ['{{RUN}}'],
};

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

describe('op[]-derive parity — a directly-authored derive op[] back-fills the SAME node.ops as its hooks twin', () => {
  it('covers ALL FIVE derive families (seed/project/merge/promote/projectRegistry)', async () => {
    // The DERIVE families authored via the deprecated `hooks` alias (the path that already works).
    const hooksDef = {
      id: 'derive',
      phase: 'build',
      deps: [],
      programmatic: true,
      contract,
      hooks: {
        seed: [{ to: 'spec/seed.json', from: '{{WORKSPACE}}/seed.json' }],
        project: [{ to: 'out/projected.json', from: 'in/raw.json' }],
        merge: { ops: [{ fold: { into: 'out/merged.json', from: ['a.json', 'b.json'] } }] },
        promote: [{ from: 'out/report.json', to: 'summary', merge: 'append' }],
        registryProject: { source: 'out/report.json', mapRef: '{{RUN}}/index.json', key: 'derive' },
      },
    };

    // The SAME derives authored DIRECTLY in the unified op[] envelope (the migration table, design §2.2,
    // inverted). NOTE the NAME FLIP: the promote transform field is `reducer`; NodeOps.promote is `merge`.
    const opDef = {
      id: 'derive',
      phase: 'build',
      deps: [],
      programmatic: true,
      contract,
      op: [
        { when: 'pre', writes: ['spec/seed.json'], transform: { kind: 'seed', from: '{{WORKSPACE}}/seed.json' } },
        { when: 'post', writes: ['out/projected.json'], reads: ['in/raw.json'], transform: { kind: 'project', from: 'in/raw.json' } },
        { when: 'post', transform: { kind: 'merge', ops: [{ fold: { into: 'out/merged.json', from: ['a.json', 'b.json'] } }] } },
        { when: 'post', transform: { kind: 'promote', from: 'out/report.json', to: 'summary', reducer: 'append' } },
        { when: 'post', transform: { kind: 'projectRegistry', source: 'out/report.json', mapRef: '{{RUN}}/index.json', key: 'derive' } },
      ],
    };

    const hooksDir = await templateWith(hooksDef);
    dirs.push(hooksDir);
    const hooksOps = await compiledOps(hooksDir, 'derive');

    const opDir = await templateWith(opDef);
    dirs.push(opDir);
    const opOps = await compiledOps(opDir, 'derive');

    // The hooks-authored twin always single-sources node.ops (the path that works today).
    expect(hooksOps, 'hooks-authored derive must produce node.ops').toBeDefined();

    // THE LOAD-BEARING ASSERTION (RED before the fix: opOps is undefined — the loader never derives
    // node.ops from the op[] transforms, so the runner's derive executors never fire for an op[] node).
    expect(opOps, 'op[]-authored derive must back-fill node.ops so the runtime executors run').toBeDefined();
    expect(opOps).toEqual(hooksOps);
  });
});
