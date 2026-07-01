import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProductRootsUnder, resolveGuiScope } from '../src/gui.js';

// `piflowctl gui` scopes the viewer to the LAUNCHED PROJECT: the enclosing project (walk up) plus every
// product beneath it (walk down). A "product" is a dir whose `.piflow/` holds a REAL workflow
// (`<wf>/template/meta.json` or `<wf>/runs/`) — NOT a bare `.piflow` (that shape is the GLOBAL home
// `~/.piflow`, which holds products.json/index.json/agents and must never be mistaken for a project).
//
// Fixture tree (built once under a tmp dir):
//   root/                         (not a product)
//     projA/.piflow/wf1/template/meta.json          → product
//       projA/src/foo/                              (a deep cwd inside projA)
//       projA/sub/projA2/.piflow/wf/template/meta.json → nested product under projA
//     projB/.piflow/wf/runs/r1/.pi/run.json         → product (discovered via runs/, no template)
//     fakeHome/.piflow/products.json                → NOT a product (global-home shape: bare .piflow)
//     fakeHome/.piflow/agents/x.md
//     node_modules/dep/.piflow/wf/template/meta.json → NOT found (skipped dir)
//     .hidden/proj/.piflow/wf/template/meta.json     → NOT found (dot-dir skipped)
//     deep/a/b/c/d/e/f/g/.piflow/wf/template/meta.json → beyond default maxDepth (not found)

let ROOT: string;
let projA: string, projA2: string, projB: string, deepProduct: string;

async function mkProduct(dir: string, wf = 'wf'): Promise<string> {
  await fs.mkdir(path.join(dir, '.piflow', wf, 'template'), { recursive: true });
  await fs.writeFile(path.join(dir, '.piflow', wf, 'template', 'meta.json'), JSON.stringify({ name: wf }));
  return dir;
}
async function mkProductWithRunOnly(dir: string, wf = 'wf'): Promise<string> {
  await fs.mkdir(path.join(dir, '.piflow', wf, 'runs', 'r1', '.pi'), { recursive: true });
  await fs.writeFile(path.join(dir, '.piflow', wf, 'runs', 'r1', '.pi', 'run.json'), JSON.stringify({ run: 'r1' }));
  return dir;
}

beforeAll(async () => {
  ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-gui-scope-'));
  projA = await mkProduct(path.join(ROOT, 'projA'), 'wf1');
  await fs.mkdir(path.join(projA, 'src', 'foo'), { recursive: true });
  projA2 = await mkProduct(path.join(projA, 'sub', 'projA2'));
  projB = await mkProductWithRunOnly(path.join(ROOT, 'projB'));

  // global-home shape: a bare `.piflow` with only files/agents (no <wf>/template|runs) — must NOT be a product.
  await fs.mkdir(path.join(ROOT, 'fakeHome', '.piflow', 'agents'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'fakeHome', '.piflow', 'products.json'), '{"products":[]}');
  await fs.writeFile(path.join(ROOT, 'fakeHome', '.piflow', 'agents', 'x.md'), '# preset');

  // noise dirs that must be skipped even though they contain a real product shape
  await mkProduct(path.join(ROOT, 'node_modules', 'dep'));
  await mkProduct(path.join(ROOT, '.hidden', 'proj'));

  // beyond default maxDepth (6): root/deep/a/b/c/d/e/f/g → g at depth 8
  deepProduct = await mkProduct(path.join(ROOT, 'deep', 'a', 'b', 'c', 'd', 'e', 'f', 'g'));
});
afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('findProductRootsUnder', () => {
  it('finds the start dir itself when it is a product', () => {
    expect(findProductRootsUnder(projA)).toContain(projA);
  });

  it('finds nested products beneath the start', () => {
    const roots = findProductRootsUnder(ROOT);
    expect(roots).toContain(projA);
    expect(roots).toContain(projA2);
    expect(roots).toContain(projB);
  });

  it('treats a `.piflow` with runs/ (no template) as a product', () => {
    expect(findProductRootsUnder(projB)).toContain(projB);
  });

  it('does NOT treat a bare `.piflow` (global-home shape) as a product', () => {
    const roots = findProductRootsUnder(ROOT);
    expect(roots).not.toContain(path.join(ROOT, 'fakeHome'));
  });

  it('skips node_modules and dot-dirs', () => {
    const roots = findProductRootsUnder(ROOT);
    expect(roots).not.toContain(path.join(ROOT, 'node_modules', 'dep'));
    expect(roots).not.toContain(path.join(ROOT, '.hidden', 'proj'));
  });

  it('respects the depth bound (a product past maxDepth is not found)', () => {
    expect(findProductRootsUnder(ROOT)).not.toContain(deepProduct);
    // …but a shallower start reaches it
    expect(findProductRootsUnder(path.join(ROOT, 'deep', 'a', 'b'))).toContain(deepProduct);
  });
});

describe('resolveGuiScope', () => {
  it('from a subfolder inside a project, scopes to the project root + its sub-products', () => {
    const { scopeRoot, roots } = resolveGuiScope(path.join(projA, 'src', 'foo'));
    expect(scopeRoot).toBe(projA);
    expect(roots).toContain(projA);
    expect(roots).toContain(projA2);
    // projB is a SIBLING of projA (not under it) → out of scope
    expect(roots).not.toContain(projB);
  });

  it('from a parent of several projects (not itself a product), scopes to all of them', () => {
    const { scopeRoot, roots } = resolveGuiScope(ROOT);
    expect(scopeRoot).toBe(ROOT);
    expect(roots).toContain(projA);
    expect(roots).toContain(projB);
    expect(roots).not.toContain(path.join(ROOT, 'fakeHome'));
  });

  it('from a dir with no project at or under it, returns an empty root set', () => {
    const empty = path.join(ROOT, 'fakeHome', '.piflow', 'agents'); // a leaf with nothing product-shaped under it
    const { roots } = resolveGuiScope(empty);
    expect(roots).toEqual([]);
  });
});
