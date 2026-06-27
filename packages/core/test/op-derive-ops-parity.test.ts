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
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (U0 · op⊖ops unification — docs/specs/op-ops-unification-plan.md §4) EXTENSION. This file now also pins:
//   (1) RUNTIME parity — a `hooks`-twin and an `op[]`-twin of all FIVE derive families, run end-to-end
//       through the REAL runner (`runWorkflow`, no-pi programmatic lane), produce BYTE-IDENTICAL artifacts
//       + promoted `state.json` channels + node status records. This is the GOLDEN oracle every migration
//       unit gates on (plan R4): the machine-checkable statement of the ADDITIVE/byte-identical invariant.
//       The earlier COMPILE-time `node.ops` parity alone would NOT catch a runtime read-site regression
//       once `node.ops` is gone — the runtime half is REQUIRED, not optional.
//   (2) `derivesFromOp` (runner/op-dispatch.ts) — the SINGLE home for the `OpSpec → executor-input`
//       adapters (plan §2.4). A direct unit test asserts it reconstructs, for all 5 families, the SAME
//       executor inputs the current `node.ops?.{…}` runner sites consume (cross-checked against
//       `opsToNodeOps`, the legacy bridge it principled-replaces). RED mutation (test-the-test): drop the
//       promote `reducer→merge` NAME FLIP (lower.ts:109) in `derivesFromOp` → the promote-adapter
//       assertion goes RED (the merged channel reducer vanishes).
//
// ⚠ D6 VERDICT (the `project` rich-vocabulary round-trip) — **opt-B** (the conservative, smaller-surface
//   choice; plan §2.4 D6 amended to match). EVIDENCE (grepped 2026-06-27 over the whole repo):
//     • the ONLY shipped `hooks.project` author shape is the BARE `{to, from}` form
//       (packages/core/test/fixtures/template-min/nodes/w2b-assets/node.json) — ZERO `copy`/`assemble`/
//       `union`/rich-`merge` project op-vocabularies are authored in ANY `node.json` `hooks.project`;
//     • the rich `applyProjectionOp` vocabulary (project.ts:84-228) is reached EXCLUSIVELY through a
//       registry-record `projections` map via `projectRegistry`/`runProjection` (see union-projection.test.ts),
//       NEVER through `hooks.project`. `lower.ts:61-64` lowers a `hooks.project` to `{kind:'project', from}`
//       only, and `opsToNodeOps` (lower.ts:104-105) reconstructs `{to:writes[0], from}` — the bare form;
//     • a bare `{to, from}` project op carries NO `copy/assemble/merge/union` key, so `applyProjectionOp`
//       hits its "no recognized op" fall-through (project.ts:230) — i.e. the inline `hooks.project` derive
//       is itself a graceful executor-level NO-OP today (it reads the source, writes nothing).
//   THEREFORE the rich `project` case is NOT in op[]-only scope: it was never lossy through `op[]` because
//   it never ENTERED op[] via `hooks.project`. `derivesFromOp`'s project adapter reproduces ONLY the bare
//   `{to: writes[0], from}` obj — byte-identical to `opsToNodeOps` and to the `node.ops.project[]` site.
//   (opt-A — widening `lower.ts` to carry the rich op set into `transform.ops` — is unnecessary: there is
//   no rich `hooks.project` author shape to carry. If one is ever introduced, revisit per plan §2.4 D6.)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTemplate, compile } from '../src/index.js';
import { runWorkflow, type ExecRunner } from '../src/runner/index.js';
import { derivesFromOp } from '../src/runner/op-dispatch.js';
import { opsToNodeOps } from '../src/workflow/template/lower.js';
import type { CommandBuilder } from '../src/index.js';
import type { NodeOps, OpSpec } from '../src/types.js';

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

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (U0) `derivesFromOp` — the UNIT bar for the single OpSpec→executor-input adapter home (plan §2.4).
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('derivesFromOp — reconstructs the SAME executor inputs the node.ops?.{…} derive sites consume', () => {
  // The five derive families authored DIRECTLY in op[] (the canonical envelope the runner will read). NOTE
  // the promote NAME FLIP: the transform field is `reducer`; the executor input (parsePromote) takes `merge`.
  const op: OpSpec[] = [
    { when: 'pre', writes: ['spec/seed.json'], transform: { kind: 'seed', from: '{{WORKSPACE}}/seed.json' } },
    { when: 'post', writes: ['out/projected.json'], reads: ['in/raw.json'], transform: { kind: 'project', from: 'in/raw.json' } },
    { when: 'post', transform: { kind: 'merge', ops: [{ fold: { into: 'm', to: 'out/merged.json', from: 'a.json' } }] } },
    { when: 'post', transform: { kind: 'promote', from: 'out/report.json:value', to: 'summary', reducer: 'append' } },
    { when: 'post', transform: { kind: 'projectRegistry', source: 'out/report.json', mapRef: '{{RUN}}/index.json', key: 'derive' } },
  ];

  it('yields, for all 5 families, exactly the executor inputs the runner.ts derive sites pass today', () => {
    const d = derivesFromOp(op);

    // seed (runner.ts:999/1356 → stageSeed): { to: writes[0], from: transform.from }.
    expect(d.seeds).toEqual([{ to: 'spec/seed.json', from: '{{WORKSPACE}}/seed.json' }]);
    // project (runner.ts:1048/1537 → applyProjectionOp): the loose op obj { to: writes[0], from } — the
    // BARE form (D6/opt-B: no rich copy/assemble/union vocabulary round-trips through hooks.project).
    expect(d.projects).toEqual([{ to: 'out/projected.json', from: 'in/raw.json' }]);
    // merge (runner.ts:1069/1564 → runMerge): MergeSpec { ops: transform.ops }, carried verbatim.
    expect(d.merges).toEqual([{ ops: [{ fold: { into: 'm', to: 'out/merged.json', from: 'a.json' } }] }]);
    // promote (runner.ts:1161/1795 → parsePromote): { from, to, merge } — the reducer→merge NAME FLIP.
    expect(d.promotes).toEqual([{ from: 'out/report.json:value', to: 'summary', merge: 'append' }]);
    // registryProject (runner.ts:1056/1545 → runProjection): { source, mapRef, key } from transform.
    expect(d.registryProjects).toEqual([{ source: 'out/report.json', mapRef: '{{RUN}}/index.json', key: 'derive' }]);
  });

  it('is a faithful inverse of opsToNodeOps (the legacy bridge it principled-replaces)', () => {
    // The migration target: `derivesFromOp` reading op[] must reconstruct the SAME per-family executor inputs
    // that `opsToNodeOps(op)` (→ node.ops → the runner sites) produces today. Cross-check field-for-field.
    const d = derivesFromOp(op);
    const legacy = opsToNodeOps(op)!;
    expect(d.seeds).toEqual(legacy.seed);
    expect(d.projects).toEqual(legacy.project);
    expect(d.merges[0]).toEqual(legacy.merge); // node.ops carries a single merge; the helper a 1-element list
    expect(d.promotes).toEqual(legacy.promote); // INCL. the reducer→merge flip — the RED-mutation tripwire
    expect(d.registryProjects[0]).toEqual(legacy.registryProject);
  });

  it('an op-free / gate-only op[] derives NOTHING (additive — five empty lists)', () => {
    expect(derivesFromOp(undefined)).toEqual({ seeds: [], projects: [], registryProjects: [], merges: [], promotes: [] });
    const gateOnly: OpSpec[] = [{ when: 'pre', gate: { kind: 'non-empty', path: 'x' } }, { when: 'post', run: { cmd: 'true' } }];
    expect(derivesFromOp(gateOnly)).toEqual({ seeds: [], projects: [], registryProjects: [], merges: [], promotes: [] });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (U0 · R4) RUNTIME PARITY — the GOLDEN oracle. A `hooks`-twin and an `op[]`-twin of all five derive
// families, each run END-TO-END through the real `runWorkflow` (no-pi programmatic lane), produce
// BYTE-IDENTICAL artifacts + promoted `state.json` channels + node status records. This is the
// machine-checkable ADDITIVE/byte-identical invariant every migration unit gates on.
//
// The node is PROGRAMMATIC (spawns no pi — derives are deterministic, no model). Its inputs are STAGED by
// the `seed` family from a fixture `{{WORKSPACE}}`, then the POST derives consume them: `merge`(concat) →
// a merged file, `promote` → a state channel, `projectRegistry`(union) → index.json. `project` is the bare
// `{to,from}` form (a graceful executor no-op per D6/opt-B) — present so all five families ride the run.
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** A pi seam that MUST NOT fire on a programmatic node (mirrors programmatic.test.ts) — a guard the run is no-pi. */
function piSeam(): { buildCommand: CommandBuilder; execRunner: ExecRunner; calls: { build: number; exec: number } } {
  const calls = { build: 0, exec: 0 };
  const buildCommand = (() => {
    calls.build++;
    throw new Error('buildCommand must NOT be called for a programmatic node');
  }) as unknown as CommandBuilder;
  const execRunner: ExecRunner = async () => {
    calls.exec++;
    throw new Error('execRunner must NOT be called for a programmatic node');
  };
  return { buildCommand, execRunner, calls };
}

/** Stand up the fixture `{{WORKSPACE}}` the seed family stages its starting artifacts FROM. */
async function fixtureWorkspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-parity-ws-'));
  await fs.mkdir(path.join(ws, 'frag'), { recursive: true });
  await fs.writeFile(path.join(ws, 'frag', 'a.md'), 'alpha body');
  await fs.writeFile(path.join(ws, 'frag', 'b.md'), 'beta body');
  await writeJson(path.join(ws, 'report.json'), { value: 'the-summary' });
  await writeJson(path.join(ws, 'bp.json'), {
    meta: { archetype: 'demo' },
    assetList: [{ slot: 'hero', type: 'sprite', description: 'the hero' }],
    entities: [{ assetSlot: 'hero' }, { assetSlot: 'coin', type: 'sprite' }], // hero dup ⇒ dedup; coin new
  });
  await writeJson(path.join(ws, 'genres.json'), {
    genres: [
      {
        id: 'demo',
        projections: {
          index: {
            to: 'index.json',
            union: { key: 'slot', carry: ['type', 'description'], row: { status: 'pending' }, envelope: { archetype: 'meta.archetype' }, itemsKey: 'slots', from: ['assetList', 'entities[].assetSlot'] },
          },
        },
      },
    ],
  });
  return ws;
}

/** The shared contract for both runtime twins — the artifacts the derives produce + the seeded inputs. */
const rtContract = {
  artifacts: ['merged.md', 'index.json'],
  owns: ['**'],
  readScope: ['{{RUN}}', '{{WORKSPACE}}'],
};

/** All five derive families authored via the `hooks` alias (the path that already works). */
const hooksDeriveDef = {
  id: 'derive',
  phase: 'build',
  deps: [],
  programmatic: true,
  contract: rtContract,
  hooks: {
    seed: [
      { to: 'frag/a.md', from: '{{WORKSPACE}}/frag/a.md' },
      { to: 'frag/b.md', from: '{{WORKSPACE}}/frag/b.md' },
      { to: 'report.json', from: '{{WORKSPACE}}/report.json' },
      { to: 'bp.json', from: '{{WORKSPACE}}/bp.json' },
      { to: 'genres.json', from: '{{WORKSPACE}}/genres.json' },
    ],
    project: [{ to: 'projected.json', from: 'report.json' }], // bare {to,from} — a graceful no-op (D6/opt-B)
    merge: { ops: [{ concat: { glob: 'frag/*.md', to: 'merged.md' } }] },
    promote: [{ from: 'report.json:value', to: 'summary', merge: 'append' }],
    registryProject: { source: 'bp.json', mapRef: 'genres.json', key: 'demo' },
  },
};

/** The SAME five derives authored DIRECTLY in the unified op[] envelope (the migration table, inverted). */
const opDeriveDef = {
  id: 'derive',
  phase: 'build',
  deps: [],
  programmatic: true,
  contract: rtContract,
  op: [
    { when: 'pre', writes: ['frag/a.md'], transform: { kind: 'seed', from: '{{WORKSPACE}}/frag/a.md' } },
    { when: 'pre', writes: ['frag/b.md'], transform: { kind: 'seed', from: '{{WORKSPACE}}/frag/b.md' } },
    { when: 'pre', writes: ['report.json'], transform: { kind: 'seed', from: '{{WORKSPACE}}/report.json' } },
    { when: 'pre', writes: ['bp.json'], transform: { kind: 'seed', from: '{{WORKSPACE}}/bp.json' } },
    { when: 'pre', writes: ['genres.json'], transform: { kind: 'seed', from: '{{WORKSPACE}}/genres.json' } },
    { when: 'post', writes: ['projected.json'], reads: ['report.json'], transform: { kind: 'project', from: 'report.json' } },
    { when: 'post', transform: { kind: 'merge', ops: [{ concat: { glob: 'frag/*.md', to: 'merged.md' } }] } },
    { when: 'post', transform: { kind: 'promote', from: 'report.json:value', to: 'summary', reducer: 'append' } },
    { when: 'post', writes: ['index.json'], transform: { kind: 'projectRegistry', source: 'bp.json', mapRef: 'genres.json', key: 'demo' } },
  ],
};

/** Run a one-node template END-TO-END through the real runner and read back the byte-level run artifacts. */
async function runTwin(def: Record<string, unknown>, ws: string): Promise<{
  status: import('../src/runner/index.js').RunResult['status'];
  artifacts: Record<string, string>;
  state: unknown;
  calls: { build: number; exec: number };
}> {
  const dir = await templateWith(def);
  dirs.push(dir);
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-parity-out-'));
  dirs.push(outDir);
  const { buildCommand, execRunner, calls } = piSeam();
  const { status } = await runWorkflow(compile(await loadTemplate(dir)), {
    run: 'parity', outDir, workspace: ws, buildCommand, execRunner,
  });
  // The byte-level produced set: every derive output + the seeded copies (read as raw bytes for an exact compare).
  const read = async (rel: string): Promise<string> => {
    try {
      return await fs.readFile(path.join(outDir, rel), 'utf8');
    } catch {
      return ' MISSING ';
    }
  };
  const artifacts: Record<string, string> = {};
  for (const rel of ['merged.md', 'index.json', 'projected.json', 'frag/a.md', 'frag/b.md', 'report.json']) {
    artifacts[rel] = await read(rel);
  }
  // The promoted state channels (`.pi/state.json` — the per-thread barrier checkpoint).
  let state: unknown = null;
  try {
    state = JSON.parse(await fs.readFile(path.join(outDir, '.pi', 'state.json'), 'utf8'));
  } catch {
    state = ' NO-STATE ';
  }
  return { status, artifacts, state, calls };
}

/** Strip the per-run NON-DETERMINISTIC fields (wall-clock timing) so two runs compare byte-for-byte. */
function normalizeStatus(s: import('../src/runner/index.js').RunResult['status']): unknown {
  const stripNode = (n: Record<string, unknown>): unknown => {
    const { startedAt, endedAt, durationMs, command, ...rest } = n;
    void startedAt; void endedAt; void durationMs; void command;
    return rest;
  };
  const nodes: Record<string, unknown> = {};
  for (const [id, n] of Object.entries(s.nodes)) nodes[id] = stripNode(n as Record<string, unknown>);
  const { startedAt, updatedAt, durationMs, ...rest } = s as Record<string, unknown>;
  void startedAt; void updatedAt; void durationMs;
  return { ...rest, nodes };
}

describe('RUNTIME parity (R4) — hooks-twin and op[]-twin produce a byte-identical run across all 5 families', () => {
  it('byte-identical artifacts + promoted state.json + status records', async () => {
    const ws = await fixtureWorkspace();
    dirs.push(ws);

    const hooksRun = await runTwin(hooksDeriveDef, ws);
    const opRun = await runTwin(opDeriveDef, ws);

    // No pi was spawned by EITHER twin (the derives ran in the programmatic lane).
    expect(hooksRun.calls, 'hooks twin must spawn no pi').toEqual({ build: 0, exec: 0 });
    expect(opRun.calls, 'op[] twin must spawn no pi').toEqual({ build: 0, exec: 0 });

    // Both finished ok (the derives actually ran — artifacts present, no contract breach).
    expect(hooksRun.status.nodes.derive.status, hooksRun.status.nodes.derive.issues?.join(' | ')).toBe('ok');
    expect(opRun.status.nodes.derive.status, opRun.status.nodes.derive.issues?.join(' | ')).toBe('ok');

    // (1) BYTE-IDENTICAL artifacts — the merge/registry derive outputs + the seeded copies match exactly.
    expect(opRun.artifacts).toEqual(hooksRun.artifacts);
    // Sanity: the derives genuinely produced their outputs (not a both-empty false pass).
    expect(opRun.artifacts['merged.md']).toContain('alpha body');
    expect(JSON.parse(opRun.artifacts['index.json']).slots.map((x: { slot: string }) => x.slot)).toEqual(['hero', 'coin']);

    // (2) BYTE-IDENTICAL promoted state — the `summary` channel lifted by the promote derive (append reducer).
    expect(opRun.state).toEqual(hooksRun.state);
    expect((opRun.state as Record<string, unknown>).summary, 'the promote derive lifted the summary channel').toEqual(['the-summary']);

    // (3) BYTE-IDENTICAL status records (timing/command stripped) — same status/artifacts/issues/checks.
    expect(normalizeStatus(opRun.status)).toEqual(normalizeStatus(hooksRun.status));
  });
});
