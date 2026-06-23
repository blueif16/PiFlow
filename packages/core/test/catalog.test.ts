// The tiny persisted, searchable tool catalog + its seeded registry, and the OpenClaw sdk reference
// seed (calc:add) wired end-to-end through resolve()→bundle. These tests assert the SEEDING is real:
// the seed is discoverable + selectable, its plugin is PURE and its native execute works under the
// capture-shim, and resolving it produces a LEAN self-contained bundle (the shim-subpath fix — without
// it the bundle would drag the whole @piflow/core barrel ≈ 2.6 MB instead of a few KB).

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { seededRegistry, OPENCLAW_SEED_CATALOG, loadCatalog } from '../src/tools/catalog.js';
import { OPENCLAW_COMMUNITY_CATALOG } from '../src/tools/openclaw-community.js';
import { captureOpenClawTools } from '../src/tools/openclaw-shim.js';
import { planTools, compileToolExtension } from '../src/tools/compile.js';
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

  it('loadCatalog returns BOTH tiers (executable seed + community), as a deep-enough copy', () => {
    const a = loadCatalog();
    const addrs = a.map((e) => e.address);
    expect(addrs).toContain('oc.calc:add'); // tier 1: the executable seed
    expect(addrs).toContain('oc.firecrawl:firecrawl_search'); // tier 2: a community entry
    expect(a.length).toBe(OPENCLAW_SEED_CATALOG.length + OPENCLAW_COMMUNITY_CATALOG.length);
    // copy at the array level AND the tags level — mutating the returned value must not leak into source.
    a.push({ address: 'x:y', source: 'sdk', piName: 'x_y', description: '' });
    a.find((e) => e.address === 'oc.calc:add')!.tags!.push('MUTATED');
    expect(loadCatalog().some((e) => e.address === 'x:y')).toBe(false);
    expect(loadCatalog().find((e) => e.address === 'oc.calc:add')!.tags).not.toContain('MUTATED');
  });
});

describe('OpenClaw COMMUNITY catalog — discoverable, gateway-coupled skeleton entries', () => {
  it('seeds REAL crawled plugins, discoverable by tool name, category tag, and coupling tag', () => {
    const reg = seededRegistry();
    // by tool name (address): the firecrawl + memory plugins are present
    expect(reg.search('firecrawl', { source: 'sdk' }).map((e) => e.address)).toContain('oc.firecrawl:firecrawl_search');
    expect(reg.search('memory', { source: 'sdk' }).map((e) => e.address)).toEqual(
      expect.arrayContaining(['oc.memory-core:memory_get', 'oc.memory-lancedb:memory_recall']),
    );
    // by coupling tag: EVERY community entry is tagged gateway-coupled (none is standalone-executable)
    const coupled = reg.search('gateway-coupled', { source: 'sdk' }).map((e) => e.address);
    expect(coupled).toEqual(expect.arrayContaining(OPENCLAW_COMMUNITY_CATALOG.map((e) => e.address)));
    expect(coupled).not.toContain('oc.calc:add'); // the pure seed is NOT gateway-coupled
  });

  it('records a git-source provenance pin and never fabricates a per-tool schema', () => {
    for (const e of OPENCLAW_COMMUNITY_CATALOG) {
      expect(e.source).toBe('sdk');
      expect(e.origin).toEqual({ kind: 'openclaw-plugin', ref: expect.stringMatching(/^openclaw@.+#extensions\//) });
      expect(e.parameters).toBeUndefined(); // names-only manifest → NO invented schema
      expect(e.tags).toContain('gateway-coupled');
    }
  });

  it('classifies a community entry as NON-native: the git-source pin is not bound/bundled as a module', () => {
    const fire = OPENCLAW_COMMUNITY_CATALOG.find((e) => e.address === 'oc.firecrawl:firecrawl_search')!;
    // the `#`-fragment git-source pin must NOT resolve to an importable module (else resolve would try to
    // `import "openclaw"` and drag the whole gateway into the bundle) — pluginModule stays undefined.
    expect(planTools([fire])[0].pluginModule).toBeUndefined();
    const src = compileToolExtension([fire]).source;
    expect(src).not.toContain('__ocPlugin'); // no native plugin import
    expect(src).not.toContain('captureOpenClawTools'); // not the native-bind path
    // POSITIVE: it routes through the bridge BY ITS oc ADDRESS (the load-bearing wiring) — the generated
    // execute calls `callTool("oc.firecrawl:firecrawl_search", …)`, which the bridge maps to the openclaw gateway.
    expect(src).toContain('callTool("oc.firecrawl:firecrawl_search"');
    // the executable seed, by contrast, DOES carry an importable native module (the pure-tool path).
    const calc = OPENCLAW_SEED_CATALOG.find((e) => e.address === 'oc.calc:add')!;
    expect(planTools([calc])[0].pluginModule).toBe('@piflow/core/seeds/calc');
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
