// Ported from game-omni pi-runner/hooks/test/project.test.mjs — the GENERIC projection transforms
// (copy | assemble | merge), re-rooted onto the U7 resolver (paths under {{RUN}}). The game-omni-specific
// `union` op (asset-slot + genre-record + golden-blueprint) stays a CONSUMER concern, NOT in core (flagged).
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyProjectionOp } from '../src/index.js';
// runProjection is not re-exported from the barrel yet (the index/types wiring is the runner thread's job),
// so import it directly from the op module.
import { runProjection } from '../src/workflow/ops/project.js';

let tmp: string | undefined;
afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const mkTmp = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-project-'));
const readJson = async (p: string): Promise<unknown> => JSON.parse(await fs.readFile(p, 'utf8'));
const writeJson = async (p: string, o: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(o, null, 2) + '\n');
};

// ---------- copy ----------
describe('applyProjectionOp — copy', () => {
  it('writes the drilled subtree verbatim (2-space + trailing newline)', async () => {
    tmp = await mkTmp();
    const spec = { layout: { voxelWorld: { size: [4, 4], blocks: [{ x: 1 }] } } };
    const res = await applyProjectionOp(
      'runtimeData',
      { to: 'src/world/world1.json', copy: 'layout.voxelWorld' },
      spec,
      tmp,
    );
    expect(res).toEqual({ to: 'src/world/world1.json', op: 'copy', wrote: true });
    const onDisk = await fs.readFile(path.join(tmp, 'src/world/world1.json'), 'utf8');
    expect(onDisk).toBe(JSON.stringify(spec.layout.voxelWorld, null, 2) + '\n');
  });

  it('skips (no write) when the source path is absent', async () => {
    tmp = await mkTmp();
    const res = await applyProjectionOp('x', { to: 'out.json', copy: 'no.such.path' }, { a: 1 }, tmp);
    expect(res.wrote).toBe(false);
    expect(res.skipped).toMatch(/not found/);
    expect(await fs.stat(path.join(tmp, 'out.json')).then(() => true, () => false)).toBe(false);
  });
});

// ---------- assemble ----------
describe('applyProjectionOp — assemble', () => {
  it('= onDisk ∪ (spread keys minus @entity keys) ∪ deterministic fields; @entity preserved', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'src/levels/L.json'), { scene: 'OLD', player: { woven: true }, leftover: 9 });
    const spec = {
      layout: { platforms: [1, 2], goal: { id: 'g' }, player: { SHOULD_NOT_WIN: true } },
      systems: ['S1'],
      config: { hazardTimePenalty: 50 },
    };
    const opSpec = {
      to: 'src/levels/L.json',
      assemble: {
        spread: 'layout',
        fields: {
          scene: { value: 'Level1Scene' },
          systems: 'systems',
          hitTimePenalty: { from: 'config.hazardTimePenalty', default: 0 },
          player: '@entity:weave the player',
        },
      },
    };
    const res = await applyProjectionOp('runtimeData', opSpec, spec, tmp);
    expect(res.op).toBe('assemble');
    expect(res.modelOwns).toEqual(['player']);
    expect(await readJson(path.join(tmp, 'src/levels/L.json'))).toEqual({
      scene: 'Level1Scene',
      player: { woven: true },
      leftover: 9,
      platforms: [1, 2],
      goal: { id: 'g' },
      systems: ['S1'],
      hitTimePenalty: 50,
    });
  });

  it('falls back to the spread skeleton when no on-disk file exists', async () => {
    tmp = await mkTmp();
    const spec = { layout: { a: 1, b: 2 }, systems: ['x'] };
    const res = await applyProjectionOp(
      'rt',
      { to: 'lvl.json', assemble: { spread: 'layout', fields: { systems: 'systems' } } },
      spec,
      tmp,
    );
    expect(res.wrote).toBe(true);
    expect(await readJson(path.join(tmp, 'lvl.json'))).toEqual({ a: 1, b: 2, systems: ['x'] });
  });

  it('DROPS a deterministic string-path field whose source is absent (no seed leak)', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'lvl.json'), { brickGrid: { placeholder: true }, keep: 1 });
    const spec = { layout: { bricks: [1, 2, 3] } };
    const opSpec = {
      to: 'lvl.json',
      assemble: { spread: 'layout', fields: { bricks: 'layout.bricks', brickGrid: 'layout.brickGrid' } },
    };
    await applyProjectionOp('rt', opSpec, spec, tmp);
    const out = (await readJson(path.join(tmp, 'lvl.json'))) as Record<string, unknown>;
    expect('brickGrid' in out).toBe(false);
    expect(out.bricks).toEqual([1, 2, 3]);
    expect(out.keep).toBe(1);
  });

  it('DROPS a {from} field whose source is absent AND has no default', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'o.json'), { ghost: 'SEED', real: 0 });
    const spec = { cfg: { real: 7 } };
    const opSpec = {
      to: 'o.json',
      assemble: { fields: { real: { from: 'cfg.real', default: -1 }, ghost: { from: 'cfg.ghost' } } },
    };
    await applyProjectionOp('rt', opSpec, spec, tmp);
    const out = (await readJson(path.join(tmp, 'o.json'))) as Record<string, unknown>;
    expect('ghost' in out).toBe(false);
    expect(out.real).toBe(7);
  });

  it('APPLIES a {from} default when the source is absent (the drop must NOT over-reach)', async () => {
    tmp = await mkTmp();
    const spec = { cfg: {} };
    await applyProjectionOp(
      'rt',
      { to: 'd.json', assemble: { fields: { speed: { from: 'cfg.speed', default: 99 } } } },
      spec,
      tmp,
    );
    expect(await readJson(path.join(tmp, 'd.json'))).toEqual({ speed: 99 });
  });
});

// ---------- merge (the projection merge: .value overwrite + literal coalesce) ----------
describe('applyProjectionOp — merge', () => {
  it('overwrites .value of seeded group keys + sets top-level literals (coalesce + absent→"")', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'src/gameConfig.json'), {
      playerConfig: {
        gravityY: { value: 1, type: 'number', description: 'g' },
        jumpPower: { value: 2, type: 'number', description: 'j' },
        unrelatedKept: { value: 99, type: 'number', description: 'keep' },
      },
      otherGroup: { foo: { value: 'bar' } },
    });
    const spec = {
      config: { gravityY: 1180, jumpPower: 620, notInGroup: 7 },
      meta: { failModel: 'respawn' },
      controls: [{ input: 'A', action: 'left' }],
      winCondition: { description: 'win!' },
    };
    const opSpec = {
      to: 'src/gameConfig.json',
      merge: {
        wrapInto: 'playerConfig',
        from: 'config',
        literals: {
          failModel: 'meta.failModel',
          controlsHelp: 'controls',
          objective: ['meta.objective', 'winCondition.description'],
          missingLiteral: 'nowhere.at.all',
        },
      },
    };
    const res = await applyProjectionOp('gameConfig', opSpec, spec, tmp);
    expect(res.op).toBe('merge');
    const out = (await readJson(path.join(tmp, 'src/gameConfig.json'))) as any;
    expect(out.playerConfig.gravityY.value).toBe(1180);
    expect(out.playerConfig.jumpPower.value).toBe(620);
    expect(out.playerConfig.unrelatedKept.value).toBe(99);
    expect('notInGroup' in out.playerConfig).toBe(false);
    expect(out.otherGroup.foo.value).toBe('bar');
    expect(out.failModel).toBe('respawn');
    expect(out.controlsHelp).toEqual([{ input: 'A', action: 'left' }]);
    expect(out.objective).toBe('win!');
    expect(out.missingLiteral).toBe('');
  });
});

// ---------- unknown op ----------
describe('applyProjectionOp — unknown', () => {
  it('returns a skip for an unrecognized op (no recognized copy|assemble|merge)', async () => {
    tmp = await mkTmp();
    const res = await applyProjectionOp('weird', { to: 'x.json' }, { a: 1 }, tmp);
    expect(res.wrote).toBe(false);
    expect(res.op).toBe('unknown');
  });
});

// ---------- union (asset-slot manifest) ----------
// The .mjs union goldens read out/p02 + the live templates/genres.json (absent in piflow), so those two cases
// are re-grounded onto INLINE fixtures here; the self-contained .mjs dedup case ports verbatim.
describe('applyProjectionOp — union', () => {
  // Re-grounded p02 golden: an assetList with conventional rows + an entities[].assetSlot ref carrying one
  // dup (deduped) and one NEW slot. Asserts the deduped rows, the assetDefaultPath convention, the
  // {archetype,assetsDir,slots} shape, the constant row key (status:"pending"), and that absent
  // depth/frames/entityIds are omitted. NO `schema` field — the ajv gate is deferred (see SCOPE NOTE).
  it('builds the index.json manifest: deduped rows, conventional paths, const row, omitted optionals', async () => {
    tmp = await mkTmp();
    const spec = {
      meta: { archetype: 'platformer' },
      assetList: [
        { slot: 'monkey', type: 'sprite', width: 36, height: 44, description: 'a small brown monkey' },
        { slot: 'platform', type: 'tileset', width: 64, height: 16, description: 'a stone platform tile' },
        { slot: 'jingle', type: 'audio', description: 'a victory jingle' },
      ],
      entities: [
        { assetSlot: 'monkey', type: 'sprite' }, // dup of assetList[0] ⇒ dropped (first wins)
        { assetSlot: 'coin', type: 'sprite' }, // NEW ⇒ appended with width/height defaults
      ],
    };
    const opSpec = {
      to: 'index.json',
      union: ['assetList', 'entities[].assetSlot'],
      row: { status: 'pending' },
    };
    const res = await applyProjectionOp('index', opSpec, spec, tmp);
    expect({ op: res.op, wrote: res.wrote, rows: res.rows }).toEqual({ op: 'union', wrote: true, rows: 4 });

    const out = (await readJson(path.join(tmp, 'index.json'))) as any;
    expect(out.archetype).toBe('platformer');
    expect(out.assetsDir).toBe('public/assets');
    expect(out.slots.map((s: any) => s.slot)).toEqual(['monkey', 'platform', 'jingle', 'coin']);
    // assetList row: full key set, conventional sprite path, const row appended, no optionals.
    expect(out.slots[0]).toEqual({
      slot: 'monkey',
      type: 'sprite',
      path: 'sprites/monkey.png',
      width: 36,
      height: 44,
      description: 'a small brown monkey',
      status: 'pending',
    });
    // type→dir/ext convention: tileset → tiles/*.png, audio → audio/*.mp3, audio width/height default to 32.
    expect(out.slots[1].path).toBe('tiles/platform.png');
    expect(out.slots[2]).toEqual({
      slot: 'jingle',
      type: 'audio',
      path: 'audio/jingle.mp3',
      width: 32,
      height: 32,
      description: 'a victory jingle',
      status: 'pending',
    });
    // coin came from entities[].assetSlot: width/height default to 32, no description; optionals omitted.
    expect(out.slots[3]).toEqual({
      slot: 'coin',
      type: 'sprite',
      path: 'sprites/coin.png',
      width: 32,
      height: 32,
      status: 'pending',
    });
    for (const row of out.slots) {
      expect('depth' in row).toBe(false);
      expect('frames' in row).toBe(false);
      expect('entityIds' in row).toBe(false);
    }
  });

  // Ported VERBATIM from the .mjs (already self-contained, inline fixtures): a slot present in BOTH refs
  // appears once; the entities-sourced row gets the width/height/path defaults and no description.
  it('dedups across the two union refs (a slot in BOTH appears once)', async () => {
    tmp = await mkTmp();
    const spec = {
      meta: { archetype: 'demo' },
      assetList: [{ slot: 'hero', type: 'sprite', width: 10, height: 20 }],
      entities: [{ assetSlot: 'hero' }, { assetSlot: 'coin', type: 'sprite' }], // hero dup ⇒ dropped, coin new
    };
    const opSpec = { to: 'index.json', union: ['assetList', 'entities[].assetSlot'], row: { status: 'pending' } };
    const res = await applyProjectionOp('index', opSpec, spec, tmp);
    expect(res.rows).toBe(2); // hero (from assetList) + coin (from entities); hero NOT counted twice
    const out = (await readJson(path.join(tmp, 'index.json'))) as any;
    expect(out.slots.map((s: any) => s.slot)).toEqual(['hero', 'coin']);
    // coin came from entities[].assetSlot: defaults width/height 32, path sprites/coin.png, no description.
    expect(out.slots[1]).toEqual({
      slot: 'coin',
      type: 'sprite',
      path: 'sprites/coin.png',
      width: 32,
      height: 32,
      status: 'pending',
    });
  });
});

// ---------- runProjection (marker → genre record → ops) ----------
describe('runProjection', () => {
  // Re-grounded live test: one inline genre record running all 3 op kinds (copy/merge/union) over an inline
  // blueprint + a seeded gameConfig target. Asserts summary.genre and that all 3 ops wrote.
  it('resolves the genre record and runs all 3 ops (runtimeData/gameConfig/index)', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'bp.json'), {
      meta: { archetype: 'demo', failModel: 'respawn' },
      layout: { platforms: [1, 2] },
      config: { gravityY: 1180 },
      assetList: [{ slot: 'hero', type: 'sprite', width: 10, height: 20 }],
      entities: [{ assetSlot: 'coin', type: 'sprite' }],
    });
    // Seed the gameConfig merge target with a template group.
    await writeJson(path.join(tmp, 'src/gameConfig.json'), {
      playerConfig: { gravityY: { value: 1, type: 'number', description: 'g' } },
    });
    await writeJson(path.join(tmp, 'genres.json'), {
      genres: [
        {
          id: 'demo',
          projections: {
            runtimeData: { to: 'src/level.json', copy: 'layout' },
            gameConfig: { to: 'src/gameConfig.json', merge: { wrapInto: 'playerConfig', from: 'config', literals: { failModel: 'meta.failModel' } } },
            index: { to: 'index.json', union: ['assetList', 'entities[].assetSlot'], row: { status: 'pending' } },
          },
        },
      ],
    });
    const proj = { source: 'bp.json', genreToken: 'demo', mapRef: 'genres.json' };
    const summary = await runProjection(proj, tmp);
    expect(summary?.genre).toBe('demo');
    const byOp = Object.fromEntries((summary!.ops ?? []).map((o) => [o.op, o]));
    expect(byOp.copy.wrote).toBe(true);
    expect(byOp.merge.wrote).toBe(true);
    expect(byOp.union.wrote).toBe(true);
    // Each op landed on disk.
    expect(await readJson(path.join(tmp, 'src/level.json'))).toEqual({ platforms: [1, 2] });
    expect(((await readJson(path.join(tmp, 'src/gameConfig.json'))) as any).failModel).toBe('respawn');
    expect(((await readJson(path.join(tmp, 'index.json'))) as any).slots.map((s: any) => s.slot)).toEqual(['hero', 'coin']);
  });

  it('skips gracefully when the genre record is absent', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'genres.json'), { genres: [{ id: 'platformer', projections: {} }] });
    const proj = { source: 'x.json', genreToken: 'no-such-genre', mapRef: 'genres.json' };
    const summary = await runProjection(proj, tmp);
    expect(summary?.skipped).toMatch(/no genre record/);
  });

  // GENRE-PREFIX fallback: record ids are compound "archetype:subgenre" but the token is the bare archetype,
  // so a single-genre archetype needs the exact→prefix fallback or its whole projection is silently skipped.
  it('falls back from exact id to the archetype PREFIX for a bare-archetype token', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'genres.json'), {
      genres: [{ id: 'paddle_ball:brick-breaker', projections: { rt: { to: 'out.json', copy: 'layout' } } }],
    });
    await writeJson(path.join(tmp, 'bp.json'), { layout: { a: 1 } });
    const proj = { source: 'bp.json', genreToken: 'paddle_ball', mapRef: 'genres.json' };
    const summary = await runProjection(proj, tmp);
    expect(summary?.skipped).toBeUndefined(); // exact-only ⇒ would skip; prefix fallback resolves it
    expect(summary?.genre).toBe('paddle_ball');
    expect(summary?.ops?.[0].wrote).toBe(true);
    expect(await readJson(path.join(tmp, 'out.json'))).toEqual({ a: 1 });
  });

  it('prefers an EXACT id over an archetype-prefix sibling', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'genres.json'), {
      genres: [
        { id: 'platformer:combat', projections: { rt: { to: 'wrong.json', copy: 'layout' } } },
        { id: 'platformer', projections: { rt: { to: 'right.json', copy: 'layout' } } },
      ],
    });
    await writeJson(path.join(tmp, 'bp.json'), { layout: { a: 1 } });
    const proj = { source: 'bp.json', genreToken: 'platformer', mapRef: 'genres.json' };
    const summary = await runProjection(proj, tmp);
    expect(summary?.skipped).toBeUndefined();
    expect(await fs.stat(path.join(tmp, 'right.json')).then(() => true, () => false)).toBe(true); // exact ran
    expect(await fs.stat(path.join(tmp, 'wrong.json')).then(() => true, () => false)).toBe(false); // prefix did not
  });

  it('picks the FIRST when a bare archetype maps to multiple subgenres', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'genres.json'), {
      genres: [
        { id: 'z:one', projections: { rt: { to: 'first.json', copy: 'k' } } },
        { id: 'z:two', projections: { rt: { to: 'second.json', copy: 'k' } } },
      ],
    });
    await writeJson(path.join(tmp, 'bp.json'), { k: { v: 1 } });
    const proj = { source: 'bp.json', genreToken: 'z', mapRef: 'genres.json' };
    const summary = await runProjection(proj, tmp);
    expect(summary?.skipped).toBeUndefined();
    expect(await fs.stat(path.join(tmp, 'first.json')).then(() => true, () => false)).toBe(true); // z:one ran
    expect(await fs.stat(path.join(tmp, 'second.json')).then(() => true, () => false)).toBe(false); // z:two did not
  });
});
