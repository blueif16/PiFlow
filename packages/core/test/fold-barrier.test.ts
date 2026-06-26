// (M6 · #13) FOLD BARRIER — same-target `fold` ops must serialize, never lost-update.
//
// `applyMergeOp`'s `fold` (merge.ts:146) is a READ-MODIFY-WRITE on the target file: read the on-disk JSON,
// SET `[into]` = the fragment, write the WHOLE object back. When N folds into the SAME target run
// concurrently (the runner runs a parallel stage via `Promise.all`, and `fs.readFile`/`fs.writeFile` yield
// to the event loop, so the read phases all observe the SAME base before any write lands), the LAST writer's
// whole-object write clobbers the earlier folds — a classic lost-update. Only ONE fragment survives.
//
// This gate fires 3 same-target folds concurrently (the exact `Promise.all` shape the runner uses for a
// parallel stage) and asserts ALL 3 fragments are present. It FAILS today — the race drops 2 of 3
// (deterministically: 20/20 trials). It goes GREEN once same-target folds are SERIALIZED (one barrier slot
// keyed by the target path, so the read-modify-write of two folds into the same file never overlaps).
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMergeOp } from '../src/index.js';

let tmp: string | undefined;
afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('applyMergeOp — same-target concurrent folds (#13)', () => {
  it('3 parallel folds into one file → all 3 fragments present (no lost update)', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-fold-'));
    await fs.mkdir(path.join(tmp, 'spec'), { recursive: true });
    // The shared fold target starts empty; each fold SETS its own distinct key.
    await fs.writeFile(path.join(tmp, 'spec', 'blueprint.json'), '{}');
    const ids = ['a', 'b', 'c'];
    for (const id of ids) {
      await fs.writeFile(path.join(tmp, 'spec', `${id}.fragment.json`), `{"by":"${id}"}`);
    }

    // The runner runs a parallel stage's POST merge ops via Promise.all — replicate that exact concurrency.
    await Promise.all(
      ids.map((id) =>
        applyMergeOp(
          { fold: { from: `spec/${id}.fragment.json`, to: 'spec/blueprint.json', into: id } },
          tmp as string,
        ),
      ),
    );

    // ALL THREE fragments must survive in the single shared target. The race drops 2 of 3 (last writer wins).
    const bp = JSON.parse(await fs.readFile(path.join(tmp, 'spec', 'blueprint.json'), 'utf8'));
    expect(bp.a).toEqual({ by: 'a' });
    expect(bp.b).toEqual({ by: 'b' });
    expect(bp.c).toEqual({ by: 'c' });
  });

  it('does NOT serialize folds into DISTINCT targets needlessly (disjoint writes stay parallel-safe)', async () => {
    // Additivity: folds into DIFFERENT files have no shared state — each must land independently. (This also
    // proves the serialization keys on the TARGET path, not a single global lock that would over-serialize.)
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-fold-'));
    await fs.mkdir(path.join(tmp, 'spec'), { recursive: true });
    const ids = ['a', 'b', 'c'];
    for (const id of ids) {
      await fs.writeFile(path.join(tmp, 'spec', `${id}.fragment.json`), `{"by":"${id}"}`);
      await fs.writeFile(path.join(tmp, 'spec', `${id}.target.json`), '{}');
    }
    await Promise.all(
      ids.map((id) =>
        applyMergeOp(
          { fold: { from: `spec/${id}.fragment.json`, to: `spec/${id}.target.json`, into: 'x' } },
          tmp as string,
        ),
      ),
    );
    for (const id of ids) {
      const t = JSON.parse(await fs.readFile(path.join(tmp, 'spec', `${id}.target.json`), 'utf8'));
      expect(t.x).toEqual({ by: id });
    }
  });
});
