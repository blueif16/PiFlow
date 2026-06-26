// ── tui/test/fleet.test.mjs ────────────────────────────────────────────
// The FLEET-MAPPING oracle: `discoverFleet()` must FLATTEN the shared `buildSnapshot` fleet (products →
// namespaces → threads) into the ONE flat namespace list the App iterates — keeping EVERY namespace and
// EVERY thread, and carrying each thread's `runDir` through so drilling in opens that exact run. We stub
// `@piflow/core` so this tests the MAPPING alone (not core's filesystem discovery): the snapshot is a
// fixture, deterministic. It REDDENS if the mapping drops a namespace, drops a thread, or loses `runDir`.
import { describe, it, expect, vi } from 'vitest';

// A 2-product / multi-namespace / multi-thread snapshot — the exact shape `buildSnapshot` returns.
// product A: 2 namespaces (3 threads total); product B: 1 namespace (2 threads). 3 ns, 5 threads.
const SNAPSHOT = {
  generatedAt: '2026-06-26T00:00:00.000Z',
  products: [
    {
      id: 'repoA', name: 'repoA', root: '/repos/A',
      namespaces: [
        { id: 'game-omni', name: 'game-omni', templatePath: '/repos/A/.piflow/game-omni/template/meta.json', meta: {},
          threads: [
            { run: 'run-a1', runDir: '/repos/A/.piflow/game-omni/runs/a1', statusPath: '/repos/A/.piflow/game-omni/runs/a1', state: 'done', done: true, ok: true, nodesDone: 4, nodesTotal: 4 },
            { run: 'run-a2', runDir: '/repos/A/.piflow/game-omni/runs/a2', statusPath: '/repos/A/.piflow/game-omni/runs/a2', state: 'running', done: false, ok: null, nodesDone: 1, nodesTotal: 4 },
          ] },
        { id: 'unfiled', name: 'unfiled', templatePath: null, meta: null,
          threads: [
            { run: 'run-a3', runDir: '/repos/A/.piflow/orphan/runs/a3', statusPath: '/repos/A/.piflow/orphan/runs/a3', state: 'failed', done: true, ok: false, nodesDone: 0, nodesTotal: 2 },
          ] },
      ],
    },
    {
      id: 'repoB', name: 'repoB', root: '/repos/B',
      namespaces: [
        { id: 'lesson', name: 'lesson', templatePath: '/repos/B/.piflow/lesson/template/meta.json', meta: {},
          threads: [
            { run: 'run-b1', runDir: '/repos/B/.piflow/lesson/runs/b1', statusPath: '/repos/B/.piflow/lesson/runs/b1', state: 'done', done: true, ok: true, nodesDone: 3, nodesTotal: 3 },
            { run: 'run-b2', runDir: '/repos/B/.piflow/lesson/runs/b2', statusPath: '/repos/B/.piflow/lesson/runs/b2', state: 'done', done: true, ok: true, nodesDone: 3, nodesTotal: 3 },
          ] },
      ],
    },
  ],
};

// Stub ONLY the fleet surface this module imports; `summarizeRun` etc. stay irrelevant to discoverFleet.
vi.mock('@piflow/core', () => ({
  loadRegistry: () => ({ products: [{ id: 'repoA', name: 'repoA', root: '/repos/A' }, { id: 'repoB', name: 'repoB', root: '/repos/B' }] }),
  buildSnapshot: async () => SNAPSHOT,
  // unused-by-discoverFleet exports the module also imports at load time:
  summarizeRun: async () => null,
  readRunModel: async () => { throw new Error('not used in fleet mapping test'); },
  watchRun: async function* () {},
}));

describe('discoverFleet maps the shared snapshot → the App namespace list', () => {
  it('flattens EVERY namespace and EVERY thread, preserving each thread runDir', async () => {
    const { discoverFleet } = await import('../model.mjs');
    const nss = await discoverFleet();

    // EVERY namespace across BOTH products is present (2 from A + 1 from B = 3).
    const totalNs = SNAPSHOT.products.reduce((a, p) => a + p.namespaces.length, 0);
    expect(nss).toHaveLength(totalNs);
    expect(totalNs).toBe(3);

    // EVERY thread survives the flatten (2 + 1 + 2 = 5) — drop one and this fails.
    const totalThreads = SNAPSHOT.products.reduce((a, p) => a + p.namespaces.reduce((x, n) => x + n.threads.length, 0), 0);
    expect(nss.reduce((a, n) => a + n.threads.length, 0)).toBe(totalThreads);
    expect(totalThreads).toBe(5);

    // a specific thread's runDir is carried THROUGH so drilling in opens THAT run (not the namespace dir).
    const allThreads = nss.flatMap((n) => n.threads);
    const a2 = allThreads.find((t) => t.run === 'run-a2');
    expect(a2).toBeTruthy();
    expect(a2.runDir).toBe('/repos/A/.piflow/game-omni/runs/a2');

    // the App namespace shape: { name, dir, runDir, threads } — name disambiguated across >1 product.
    for (const n of nss) {
      expect(typeof n.name).toBe('string');
      expect(typeof n.dir).toBe('string');
      expect(typeof n.runDir).toBe('string');
      expect(Array.isArray(n.threads)).toBe(true);
    }
    expect(nss.map((n) => n.name)).toContain('repoA/game-omni');
    expect(nss.map((n) => n.name)).toContain('repoB/lesson');
  });
});
