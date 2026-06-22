// The tiny persisted, searchable tool catalog + its seeded registry, and the OpenClaw sdk reference
// seed (calc:add) wired end-to-end through resolve()→bundle. These tests assert the SEEDING is real:
// the seed is discoverable + selectable, its plugin is PURE and its native execute works under the
// capture-shim, and resolving it produces a LEAN self-contained bundle (the shim-subpath fix — without
// it the bundle would drag the whole @piflow/core barrel ≈ 2.6 MB instead of a few KB).

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { seededRegistry, OPENCLAW_SEED_CATALOG, loadCatalog } from '../src/tools/catalog.js';
import { captureOpenClawTools } from '../src/tools/openclaw-shim.js';
import calcSeed from '../src/seeds/calc.js';

describe('tool catalog — seeded registry (builtins + the persisted OpenClaw seed)', () => {
  it('seeds the registry with the pi builtins AND the catalog, and resolves the seed address', () => {
    const reg = seededRegistry();
    const addrs = reg.list().map((e) => e.address);
    expect(addrs).toContain('fs:read'); // a pi builtin survives
    expect(addrs).toContain('oc.calc:add'); // the persisted OpenClaw seed is present
    // the seed resolves to its bare pi name (sdk-prefixed), with a generated extension (non-empty).
    const res = reg.resolve({ allow: ['oc.calc:add'] });
    expect(res.piTools).toEqual(['calc_add']);
    expect(res.extension).toBeTruthy();
  });

  it('makes the seed DISCOVERABLE via search (tag + keyword)', () => {
    const reg = seededRegistry();
    expect(reg.search('arithmetic').map((e) => e.address)).toContain('oc.calc:add');
    expect(reg.search('openclaw', { source: 'sdk' }).map((e) => e.address)).toContain('oc.calc:add');
  });

  it('loadCatalog returns the persisted entries (a copy, not the shared array)', () => {
    const a = loadCatalog();
    expect(a.map((e) => e.address)).toEqual(OPENCLAW_SEED_CATALOG.map((e) => e.address));
    a.push({ address: 'x:y', source: 'sdk', piName: 'x_y', description: '' });
    expect(loadCatalog().some((e) => e.address === 'x:y')).toBe(false); // copy — mutation didn't leak
  });
});

describe('OpenClaw seed plugin — PURE + its native execute works under the capture-shim', () => {
  it('captures the calc:add def with a working, pure native execute (sum)', () => {
    const caps = captureOpenClawTools(calcSeed);
    const add = caps.find((c) => c.def.name === 'add');
    expect(add).toBeTruthy();
    // PURE: execute reads only its params (no gateway api), so it runs fine off the shim's no-op api.
    const out = add!.def.execute('call-1', { a: 2, b: 3 }) as { details?: { sum?: number } };
    expect(out.details?.sum).toBe(5);
  });
});

describe('OpenClaw seed — resolve()→bundle is LEAN + native (the shim-subpath fix)', () => {
  // esbuild (inside resolve) resolves @piflow/core/{seeds/calc,tools/openclaw-shim} via the package
  // `exports` map → dist, so the dist must be built first.
  beforeAll(() => {
    execSync('npm run build', { cwd: process.cwd(), stdio: 'ignore' });
  });

  it('binds the NATIVE execute (no bridge) and stays LEAN (subpath shim, not the core barrel)', () => {
    const reg = seededRegistry();
    const ext = reg.resolve({ allow: ['oc.calc:add'] }).extension!;
    expect(ext).toContain('sum'); // the seed's native execute was inlined into the bundle
    expect(ext).not.toContain('callTool('); // sdk-native: it does NOT route through the MCP bridge
    // LEAN: with the subpath shim the bundle is a few KB; if it regressed to the `@piflow/core` barrel
    // (esbuild + daytona pulled in) it would be ~2.6 MB. A generous ceiling catches that regression.
    expect(ext.length).toBeLessThan(200_000);
  });
});
