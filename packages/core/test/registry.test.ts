// Registry (`~/.piflow/products.json`) — PURE LOGIC gate (test-discipline §0): example tests with
// independently-justified assertions. The `PIFLOW_HOME` seam points the global dir at a temp dir so the
// real `~/.piflow` is never touched. The behaviors that MUST hold (and fail loudly if broken):
//   • upsertRoot is IDEMPOTENT — registering the same repo twice yields exactly one entry.
//   • upsertRoot REFRESHES a moved/renamed dir matched by basename id (no duplicate, root updated).
//   • registerProductRoot PERSISTS a REAL root to products.json under the home.
//   • (M3) registerProductRoot NEVER self-registers a root under os.tmpdir() — the ~290-corpse leak a test
//     suite caused by running workflows without setting PIFLOW_HOME (packages/server/test/http-replay-e2e).
//   • (M3) saveRegistry SELF-HEALS: an entry whose root no longer exists on disk is dropped before writing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadRegistry,
  upsertRoot,
  registerProductRoot,
  saveRegistry,
  productsFile,
  type Registry,
} from '../src/observe/registry.js';

let home: string;
let prevHome: string | undefined;
// REAL (non-tmp) scratch dirs this file creates for a "registers a genuine root" case — tracked here so
// every test cleans up after itself regardless of which describe block created them.
const realScratchDirs: string[] = [];
function mkRealDir(): string {
  const d = mkdtempSync(path.join(process.cwd(), '.piflow-registry-test-'));
  realScratchDirs.push(d);
  return d;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'piflow-home-'));
  prevHome = process.env.PIFLOW_HOME;
  process.env.PIFLOW_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  for (const d of realScratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('upsertRoot', () => {
  it('registers the same root twice as ONE entry (idempotent)', () => {
    const reg: Registry = { products: [] };
    upsertRoot(reg, '/Users/me/Desktop/animation-test');
    upsertRoot(reg, '/Users/me/Desktop/animation-test');
    expect(reg.products).toHaveLength(1);
    expect(reg.products[0].root).toBe('/Users/me/Desktop/animation-test');
    expect(reg.products[0].id).toBe('animation-test');
  });

  it('refreshes a moved dir matched by basename id (one entry, new root)', () => {
    const reg: Registry = { products: [] };
    upsertRoot(reg, '/old/place/lessons');
    upsertRoot(reg, '/new/place/lessons'); // same basename `lessons` → same product, moved
    expect(reg.products).toHaveLength(1);
    expect(reg.products[0].root).toBe('/new/place/lessons');
  });
});

describe('registerProductRoot', () => {
  it('persists a REAL root to products.json under PIFLOW_HOME, readable by loadRegistry', async () => {
    const root = mkRealDir();
    expect(existsSync(productsFile())).toBe(false); // nothing written yet
    await registerProductRoot(root);

    const onDisk = JSON.parse(readFileSync(productsFile(), 'utf8'));
    expect(onDisk.products.map((p: { root: string }) => p.root)).toContain(root);
    // a fresh loadRegistry reads back the SAME registry (the GUI/TUI path).
    expect(loadRegistry().products.some((p) => p.root === root)).toBe(true);
  });

  // ── M3 — stop the ~290-corpse leak ──────────────────────────────────────────────────────────────────
  // A test suite that boots a run WITHOUT setting PIFLOW_HOME (a confirmed offender:
  // packages/server/test/http-replay-e2e.test.ts) used to self-register its mkdtemp scratch dir into the
  // REAL ~/.piflow/products.json on every CI run. registerProductRoot must no-op for any root living under
  // the OS temp dir — compared by REALPATH, since macOS's os.tmpdir() is itself a `/var` symlink to
  // `/private/var` (a raw-string prefix check silently fails to catch this).
  it('M3: no-ops for a root under os.tmpdir() — products.json is never even created', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'piflow-scratch-'));
    try {
      const before = loadRegistry();
      const after = await registerProductRoot(scratch);
      expect(existsSync(productsFile())).toBe(false); // no write happened at all
      expect(after).toEqual(before); // returns the loaded registry UNCHANGED, per the contract
      expect(after.products.some((p) => p.root === scratch)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('saveRegistry — self-heals dead entries (M3)', () => {
  it('drops an entry whose root no longer exists on disk before writing', async () => {
    const alive = mkRealDir();
    const ghostRoot = path.join(tmpdir(), 'piflow-ghost-does-not-exist-xyz-12345');
    expect(existsSync(ghostRoot)).toBe(false); // never created — simulates a deleted/moved repo

    await saveRegistry({
      products: [
        { id: 'alive', name: 'alive', root: alive },
        { id: 'ghost', name: 'ghost', root: ghostRoot },
      ],
    });

    const onDisk = JSON.parse(readFileSync(productsFile(), 'utf8')) as Registry;
    const roots = onDisk.products.map((p) => p.root);
    expect(roots).toContain(alive); // a real, existing root survives
    expect(roots).not.toContain(ghostRoot); // a dead root is pruned, never resurrected
  });
});
