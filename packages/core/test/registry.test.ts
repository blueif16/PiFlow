// Registry (`~/.piflow/products.json`) — PURE LOGIC gate (test-discipline §0): example tests with
// independently-justified assertions. The `PIFLOW_HOME` seam points the global dir at a temp dir so the
// real `~/.piflow` is never touched. The behaviors that MUST hold (and fail loudly if broken):
//   • upsertRoot is IDEMPOTENT — registering the same repo twice yields exactly one entry.
//   • upsertRoot REFRESHES a moved/renamed dir matched by basename id (no duplicate, root updated).
//   • registerProductRoot PERSISTS the root to products.json under the home.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadRegistry,
  upsertRoot,
  registerProductRoot,
  productsFile,
  type Registry,
} from '../src/observe/registry.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'piflow-home-'));
  prevHome = process.env.PIFLOW_HOME;
  process.env.PIFLOW_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
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
  it('persists the root to products.json under PIFLOW_HOME, readable by loadRegistry', async () => {
    expect(existsSync(productsFile())).toBe(false); // nothing written yet
    await registerProductRoot('/Users/me/Desktop/animation-test');

    const onDisk = JSON.parse(readFileSync(productsFile(), 'utf8'));
    expect(onDisk.products.map((p: { root: string }) => p.root)).toContain(
      '/Users/me/Desktop/animation-test',
    );
    // a fresh loadRegistry reads back the SAME registry (the GUI/TUI path).
    expect(loadRegistry().products.some((p) => p.id === 'animation-test')).toBe(true);
  });
});
