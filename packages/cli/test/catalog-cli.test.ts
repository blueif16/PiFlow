// `piflowctl catalog sync|introspect` — THIN wrappers over @piflow/core's `syncMcpCatalog` /
// `introspectMcpServer`. The CLI layer is dispatch + flag-mapping + formatting ONLY: network lives in the
// core lib, so these tests inject FAKE core functions (the docker-work dispatch pattern — run-docker.test.ts
// injected a fake provider factory) and assert the argv → opts mapping + the rendering. ZERO network.
//
// Load-bearing behaviors pinned here:
//   • `sync` calls the core seam with the mapped { baseUrl, maxPages } (flags absent ⇒ absent, so core's
//     own defaults rule) and renders the SyncResult; `--json` emits the raw SyncResult.
//   • `introspect <server>` calls the seam with { server }; a missing server arg is usage (exit 1, no call).
//   • a core failure surfaces as a message + exit 1 (never an unhandled rejection).

import { describe, it, expect } from 'vitest';
import type { SyncMcpCatalogOpts, SyncResult, IntrospectMcpServerOpts, IntrospectResult } from '@piflow/core';
import { runCatalogCli, type CatalogDeps } from '../src/catalog.js';

function sink(): { text: string; write: (s: string) => void } {
  const parts: string[] = [];
  return {
    write: (s: string) => void parts.push(s),
    get text() {
      return parts.join('');
    },
  };
}

const SYNCED: SyncResult = { pages: 3, upserted: 12, removed: 2, lastUpdatedSince: '2026-07-03T00:00:00Z' };
const INTROSPECTED: IntrospectResult = {
  server: 'everything',
  toolCount: 2,
  addresses: ['mcp.everything:echo', 'mcp.everything:add'],
};

async function run(
  argv: string[],
  deps: Pick<CatalogDeps, 'sync' | 'introspect'> = {},
): Promise<{ out: string; err: string; code: number }> {
  const o = sink();
  const e = sink();
  const code = await runCatalogCli(argv, { out: o.write, err: e.write, ...deps });
  return { out: o.text, err: e.text, code };
}

describe('piflowctl catalog sync — dispatch to the injected core seam', () => {
  it('maps --base-url and --max-pages onto SyncMcpCatalogOpts and renders the result', async () => {
    let seen: SyncMcpCatalogOpts | undefined;
    const r = await run(['sync', '--base-url', 'https://mirror.example', '--max-pages', '5'], {
      sync: async (opts) => {
        seen = opts;
        return SYNCED;
      },
    });
    expect(r.code).toBe(0);
    expect(seen?.baseUrl).toBe('https://mirror.example');
    expect(seen?.maxPages).toBe(5);
    // the human summary carries the run numbers
    expect(r.out).toMatch(/3/);
    expect(r.out).toMatch(/12/);
    expect(r.out).toMatch(/2/);
  });

  it('bare sync CALLS the seam, passing NO baseUrl/maxPages (core defaults rule)', async () => {
    let calls = 0;
    let seen: SyncMcpCatalogOpts | undefined;
    await run(['sync'], {
      sync: async (opts) => {
        calls++;
        seen = opts;
        return SYNCED;
      },
    });
    expect(calls).toBe(1); // the seam actually ran (vacuous-undefined guard)
    expect(seen?.baseUrl).toBeUndefined();
    expect(seen?.maxPages).toBeUndefined();
  });

  it('--json emits the raw SyncResult for an agent to consume', async () => {
    const r = await run(['sync', '--json'], { sync: async () => SYNCED });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(SYNCED);
  });

  it('a core failure surfaces as a message + exit 1, never an unhandled rejection', async () => {
    const r = await run(['sync'], {
      sync: async () => {
        throw new Error('registry unreachable');
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('registry unreachable');
  });
});

describe('piflowctl catalog introspect — dispatch to the injected core seam', () => {
  it('maps the positional server arg onto { server } and renders the addresses', async () => {
    let seen: IntrospectMcpServerOpts | undefined;
    const r = await run(['introspect', 'everything'], {
      introspect: async (opts) => {
        seen = opts;
        return INTROSPECTED;
      },
    });
    expect(r.code).toBe(0);
    expect(seen?.server).toBe('everything');
    expect(r.out).toContain('mcp.everything:echo');
    expect(r.out).toContain('mcp.everything:add');
  });

  it('--json emits the raw IntrospectResult', async () => {
    const r = await run(['introspect', 'everything', '--json'], { introspect: async () => INTROSPECTED });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(INTROSPECTED);
  });

  it('a missing server arg is usage: exit 1 and the seam is NEVER called', async () => {
    let called = false;
    const r = await run(['introspect'], {
      introspect: async () => {
        called = true;
        return INTROSPECTED;
      },
    });
    expect(r.code).toBe(1);
    expect(called).toBe(false);
    expect(r.err).toContain('introspect');
  });

  it('a core failure (e.g. no serverConfig) surfaces as a message + exit 1', async () => {
    const r = await run(['introspect', 'ghost'], {
      introspect: async () => {
        throw new Error('no listTools seam and no serverConfig');
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('no listTools seam');
  });
});

describe('piflowctl catalog — dispatch edges', () => {
  it('an unknown subcommand exits non-zero with usage', async () => {
    const r = await run(['frobnicate']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('catalog');
  });
});
