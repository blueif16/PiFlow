import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveScope, loadScopedRegistry, templateLayout } from '../src/observe/scope.js';

// The SHARED project-scope resolver (used by `piflowctl gui`, `piflowctl tui`, and the TUI's in-process fleet
// discovery). A "product" is a dir whose `.piflow/` holds a REAL workflow (`<wf>/template/meta.json` or
// `<wf>/runs/`) — NOT a bare `.piflow` (that shape is the GLOBAL home `~/.piflow`, which must never be
// mistaken for a project).
//
// THE LAW (M2): one product workspace = exactly ONE `.piflow/`, scanned only at that product's OWN root.
// `resolveScope` walks UP to find the nearest enclosing product and stops there — it never recurses back
// DOWN to pick up nested/sibling products, so a workspace view never bleeds another workspace's runs in.
//
// Fixture tree (built once under a tmp dir):
//   root/                         (not a product)
//     projA/.piflow/wf1/template/meta.json          → product
//       projA/src/foo/                              (a deep cwd inside projA)
//       projA/sub/projA2/.piflow/wf/template/meta.json → NESTED product under projA (must NOT leak into scope)
//     projB/.piflow/wf/runs/r1/.pi/run.json         → product (discovered via runs/, no template)
//     fakeHome/.piflow/products.json                → NOT a product (global-home shape: bare .piflow)
//     fakeHome/.piflow/agents/x.md

let ROOT: string;
let projA: string, projA2: string, projB: string;

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
  ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-scope-'));
  projA = await mkProduct(path.join(ROOT, 'projA'), 'wf1');
  await fs.mkdir(path.join(projA, 'src', 'foo'), { recursive: true });
  projA2 = await mkProduct(path.join(projA, 'sub', 'projA2')); // NESTED under projA
  projB = await mkProductWithRunOnly(path.join(ROOT, 'projB'));

  // global-home shape: a bare `.piflow` with only files/agents (no <wf>/template|runs) — must NOT be a product.
  await fs.mkdir(path.join(ROOT, 'fakeHome', '.piflow', 'agents'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'fakeHome', '.piflow', 'products.json'), '{"products":[]}');
  await fs.writeFile(path.join(ROOT, 'fakeHome', '.piflow', 'agents', 'x.md'), '# preset');
});
afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('templateLayout', () => {
  it('derives productRoot + runsHome from a .piflow/<wf>/template path', () => {
    const tdir = path.join(projA, '.piflow', 'wf1', 'template');
    expect(templateLayout(tdir)).toEqual({
      productRoot: projA,
      runsHome: path.join(projA, '.piflow', 'wf1', 'runs'),
    });
  });

  it('resolves a relative template path to an absolute productRoot (never cwd-relative)', () => {
    const abs = path.join(projA2, '.piflow', 'wf', 'template');
    const rel = path.relative(process.cwd(), abs);
    expect(templateLayout(rel).productRoot).toBe(projA2);
  });

  it('a loose template (not under .piflow) still gets a sibling runsHome, but null productRoot', () => {
    // runsHome stays loose so a run never falls back to out/<id> at cwd; productRoot is strict (needs .piflow).
    expect(templateLayout('/tmp/loose/template')).toEqual({
      productRoot: null,
      runsHome: path.join('/tmp', 'loose', 'runs'),
    });
  });

  it('returns all-null when the path is not a template dir at all', () => {
    expect(templateLayout(path.join(projA, 'src', 'foo'))).toEqual({ productRoot: null, runsHome: null });
    expect(templateLayout(path.join(projA, '.piflow', 'wf1'))).toEqual({ productRoot: null, runsHome: null });
  });
});

describe('resolveScope — ONE workspace per scope (M2)', () => {
  it('from a subfolder inside a project, scopes to ONLY that project — never a nested product inside it', () => {
    const { scopeRoot, roots } = resolveScope(path.join(projA, 'src', 'foo'));
    expect(scopeRoot).toBe(projA);
    expect(roots).toEqual([projA]); // exactly one root — NOT projA2, even though it's nested under projA
  });

  it('the acceptance case: a NESTED product dir inside the outer product never leaks in', () => {
    // launched from INSIDE the outer product (not the nested one) → scope is the outer root alone.
    const { roots } = resolveScope(projA);
    expect(roots).toEqual([projA]);
    expect(roots).not.toContain(projA2);
  });

  it('from inside the NESTED product itself, scopes to the nested product, not the outer one', () => {
    const { scopeRoot, roots } = resolveScope(projA2);
    expect(scopeRoot).toBe(projA2);
    expect(roots).toEqual([projA2]);
  });

  it('from a parent of several projects (not itself a product, no enclosing product), returns NO roots', () => {
    const { scopeRoot, roots } = resolveScope(ROOT);
    expect(scopeRoot).toBe(ROOT);
    expect(roots).toEqual([]); // no recursive down-discovery — the caller falls back to the registry
  });

  it('from a dir with no project at or under it, returns an empty root set', () => {
    const empty = path.join(ROOT, 'fakeHome', '.piflow', 'agents');
    const { roots } = resolveScope(empty);
    expect(roots).toEqual([]);
  });
});

describe('loadScopedRegistry', () => {
  const savedScope = process.env.PIFLOW_SCOPE_ROOTS;
  const savedHome = process.env.PIFLOW_HOME;
  afterEach(() => {
    if (savedScope === undefined) delete process.env.PIFLOW_SCOPE_ROOTS;
    else process.env.PIFLOW_SCOPE_ROOTS = savedScope;
    if (savedHome === undefined) delete process.env.PIFLOW_HOME;
    else process.env.PIFLOW_HOME = savedHome;
  });

  it('PIFLOW_SCOPE_ROOTS wins: an ephemeral registry of exactly those roots (ignoring cwd)', () => {
    process.env.PIFLOW_SCOPE_ROOTS = [projA, projB].join(path.delimiter);
    const reg = loadScopedRegistry(projA2); // cwd given, but the env must take precedence
    expect(reg.products.map((p) => p.root).sort()).toEqual([projA, projB].sort());
  });

  it('no env, cwd inside a project: scopes to ONLY that project — never the nested sub-product or a sibling', () => {
    delete process.env.PIFLOW_SCOPE_ROOTS;
    const reg = loadScopedRegistry(path.join(projA, 'src', 'foo'));
    const roots = reg.products.map((p) => p.root);
    expect(roots).toEqual([projA]);
  });

  it('no env + nothing product-shaped in scope: falls back to the GLOBAL ~/.piflow registry', async () => {
    delete process.env.PIFLOW_SCOPE_ROOTS;
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-home-'));
    await fs.writeFile(
      path.join(home, 'products.json'),
      JSON.stringify({ products: [{ id: 'glob', name: 'glob', root: '/some/global/repo' }] }),
    );
    process.env.PIFLOW_HOME = home;
    const empty = path.join(ROOT, 'fakeHome', '.piflow', 'agents'); // no project at/under it
    // both a scope-less cwd AND no cwd at all fall through to the global registry
    expect(loadScopedRegistry(empty).products.map((p) => p.root)).toEqual(['/some/global/repo']);
    expect(loadScopedRegistry().products.map((p) => p.root)).toEqual(['/some/global/repo']);
    await fs.rm(home, { recursive: true, force: true });
  });
});
