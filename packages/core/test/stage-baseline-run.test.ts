// stageBaselineRun — the shared "fork a completed run's durable state into a fresh run dir" primitive.
// It is the SAME bundle-minus-journal → unpack step spawnChildRun uses to construct a replay-from-node-start
// (extracted so the `run --baseline` CLI path and spawnChildRun share ONE implementation, never two).
//
// The three load-bearing behaviors (test-discipline — each MUST go red if the seed regresses):
//   (1) EVERY durable file travels — artifacts + .pi/state.json + run.json + workflow.json — so the
//       --from-pinned upstream is frozen ON DISK (the reuse the windowed re-run depends on).
//   (2) the JOURNAL is DROPPED — without it the windowed tail has no reuse entry and unconditionally
//       re-runs (journal.ts), while the host-local sentinels (run.lock/freeze) never travel either.
//   (3) skip-filled: a caller's PRE-PLACED file (a pin) is NEVER clobbered by the seed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageBaselineRun } from '../src/runner/migrate.js';

/** Write a realistic finished-run dir: artifacts + the full .pi tree (state, journal, run.json, sentinels). */
async function writeBaselineRun(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, '.pi', 'nodes', 'a'), { recursive: true });
  await fs.mkdir(path.join(dir, 'spec'), { recursive: true });
  await fs.writeFile(path.join(dir, 'a.txt'), 'a-artifact');
  await fs.writeFile(path.join(dir, 'spec', 'x.json'), '{"k":1}');
  await fs.writeFile(path.join(dir, '.pi', 'state.json'), '{"archetype":"platformer"}');
  await fs.writeFile(path.join(dir, '.pi', 'run.json'), '{"run":"base","source":"t"}');
  await fs.writeFile(path.join(dir, '.pi', 'journal.json'), '{"nodes":{"a":{"decision":"ok"}}}');
  await fs.writeFile(path.join(dir, '.pi', 'journal.bak'), '{"nodes":{"a":{"decision":"ok"}}}'); // the fallback loadJournal reads
  await fs.writeFile(path.join(dir, '.pi', 'workflow.json'), '{"meta":{"name":"t"}}');
  await fs.writeFile(path.join(dir, '.pi', 'run.lock'), 'host-42'); // host-local — must NOT travel
  await fs.writeFile(path.join(dir, '.pi', 'nodes', 'a', 'io.json'), '{"artifacts":[]}');
}

describe('stageBaselineRun — fork a completed run into a fresh run dir', () => {
  let baseline: string;
  let dest: string;
  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-stage-baseline-'));
    baseline = path.join(root, 'base');
    dest = path.join(root, 'fork');
    await writeBaselineRun(baseline);
  });
  afterEach(async () => {
    await fs.rm(path.dirname(baseline), { recursive: true, force: true });
  });

  it('carries every durable file (artifacts + state + run.json + workflow.json) so upstream is frozen on disk', async () => {
    await stageBaselineRun(baseline, dest);
    expect(await fs.readFile(path.join(dest, 'a.txt'), 'utf8')).toBe('a-artifact');
    expect(await fs.readFile(path.join(dest, 'spec', 'x.json'), 'utf8')).toBe('{"k":1}');
    // .pi/state.json is the promoted-channel state the reused upstream's {{state.*}} tokens resolve against.
    expect(await fs.readFile(path.join(dest, '.pi', 'state.json'), 'utf8')).toBe('{"archetype":"platformer"}');
    expect(existsSync(path.join(dest, '.pi', 'run.json'))).toBe(true);
    expect(existsSync(path.join(dest, '.pi', 'workflow.json'))).toBe(true);
    expect(existsSync(path.join(dest, '.pi', 'nodes', 'a', 'io.json'))).toBe(true);
  });

  it('DROPS the journal (so the windowed tail re-runs) and never carries the host-local run.lock/freeze', async () => {
    await stageBaselineRun(baseline, dest);
    // The whole point: no journal entry in the fork ⇒ the windowed node has nothing to `reused` against and
    // unconditionally re-runs; the --from pin (not the journal) is what freezes the upstream prefix. BOTH the
    // primary AND the .bak fallback must be dropped (loadJournal reads the .bak when the primary is absent).
    expect(existsSync(path.join(dest, '.pi', 'journal.json'))).toBe(false);
    expect(existsSync(path.join(dest, '.pi', 'journal.bak'))).toBe(false);
    // run.lock is per-HOST coordination — carrying it would make the fork think it is already locked.
    expect(existsSync(path.join(dest, '.pi', 'run.lock'))).toBe(false);
  });

  it('skip-filled: a caller PRE-PLACED file is never clobbered by the seed', async () => {
    // The stage-only pin flow: a file already present in the dest survives the seed VERBATIM.
    await fs.mkdir(path.join(dest, 'spec'), { recursive: true });
    await fs.writeFile(path.join(dest, 'spec', 'x.json'), 'PINNED');
    await stageBaselineRun(baseline, dest);
    expect(await fs.readFile(path.join(dest, 'spec', 'x.json'), 'utf8')).toBe('PINNED'); // NOT the baseline's {"k":1}
    // an absent dest is still seeded from the baseline (skip-filled only skips ALREADY-FILLED dests).
    expect(await fs.readFile(path.join(dest, 'a.txt'), 'utf8')).toBe('a-artifact');
  });
});
