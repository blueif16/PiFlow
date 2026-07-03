// `piflowctl skill search <q> --remote` — the ONLINE discovery lane dispatch. The CLI layer is
// flag-mapping + rendering ONLY: the network lives in `skill-remote.ts`'s `searchRemote` (its own suite,
// skill-remote.test.ts, covers the field-mapping/pagination/error behaviors against a fake `fetchImpl`).
// Here `searchRemote` itself is injected via `SkillDeps` (the catalog-cli.test.ts dispatch pattern) — ZERO
// network in this file.
//
// Load-bearing behaviors pinned here:
//   • `--remote` renders a SLUG · NAME · DESCRIPTION · SOURCE table; `--json` emits the rows verbatim.
//   • `--limit N` is parsed and forwarded to `searchRemote` (a bad value is usage, exit 1, seam never called).
//   • a `searchRemote` rejection (HTTP failure / network error) is ONE clear stderr line + exit 1 — never a
//     dumped stack trace.
//   • an overlong description/source is truncated sanely in the human table (JSON stays verbatim, untruncated).
//   • local `search` (no `--remote`) is UNCHANGED — see skill-cli.test.ts (not touched by this file).

import { describe, it, expect } from 'vitest';
import { runSkillCli, type SkillDeps } from '../src/skill.js';
import type { RemoteSkillRow, SearchRemoteOpts } from '../src/skill-remote.js';

function sink(): { text: string; write: (s: string) => void } {
  const parts: string[] = [];
  return {
    write: (s: string) => void parts.push(s),
    get text() {
      return parts.join('');
    },
  };
}

async function run(
  argv: string[],
  deps: Pick<SkillDeps, 'searchRemote'> = {},
): Promise<{ out: string; err: string; code: number }> {
  const o = sink();
  const e = sink();
  const code = await runSkillCli(argv, { out: o.write, err: e.write, ...deps });
  return { out: o.text, err: e.text, code };
}

const ROWS: RemoteSkillRow[] = [
  {
    slug: 'alpha-telemetry',
    name: 'alpha-telemetry',
    description: 'reads the alpha telemetry stream',
    source: 'https://github.com/alice/alpha-telemetry',
    author: 'alice',
    index: 'claudskills',
  },
  {
    slug: 'beta-research',
    name: 'beta-research',
    description: 'writes the beta research brief',
    source: 'carol/beta-research',
    index: 'claudskills',
  },
];

describe('piflowctl skill search <q> --remote — dispatch to the injected searchRemote seam', () => {
  it('renders a SLUG/NAME/DESCRIPTION/SOURCE table', async () => {
    const r = await run(['search', 'telemetry', '--remote'], { searchRemote: async () => ROWS });
    expect(r.code).toBe(0);
    expect(r.out).toContain('SLUG');
    expect(r.out).toContain('NAME');
    expect(r.out).toContain('DESCRIPTION');
    expect(r.out).toContain('SOURCE');
    expect(r.out).toContain('alpha-telemetry');
    expect(r.out).toContain('reads the alpha telemetry stream');
    expect(r.out).toContain('https://github.com/alice/alpha-telemetry');
    expect(r.out).toContain('beta-research');
  });

  it('--json emits the rows verbatim', async () => {
    const r = await run(['search', 'telemetry', '--remote', '--json'], { searchRemote: async () => ROWS });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(ROWS);
  });

  it('forwards --limit to searchRemote', async () => {
    let seen: SearchRemoteOpts | undefined;
    const r = await run(['search', 'telemetry', '--remote', '--limit', '5'], {
      searchRemote: async (_q, opts) => {
        seen = opts;
        return ROWS;
      },
    });
    expect(r.code).toBe(0);
    expect(seen?.limit).toBe(5);
  });

  it('a non-numeric --limit is usage: exit 1, searchRemote never called', async () => {
    let called = false;
    const r = await run(['search', 'telemetry', '--remote', '--limit', 'abc'], {
      searchRemote: async () => {
        called = true;
        return ROWS;
      },
    });
    expect(r.code).toBe(1);
    expect(called).toBe(false);
    expect(r.err).toContain('limit');
  });

  it('no remote matches prints a clear empty-result line (not an empty table)', async () => {
    const r = await run(['search', 'nope', '--remote'], { searchRemote: async () => [] });
    expect(r.code).toBe(0);
    expect(r.out).toContain('nope');
  });

  it('a searchRemote failure (HTTP/network) is one clear stderr line + exit 1, no stack trace', async () => {
    const r = await run(['search', 'telemetry', '--remote'], {
      searchRemote: async () => {
        throw new Error('claudskills: search request failed (HTTP 500)');
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('HTTP 500');
    expect(r.err).not.toContain('at '); // no stack-frame dump
    expect(r.err.trim().split('\n')).toHaveLength(1); // exactly one line
  });

  it('a network-error rejection is also one clear stderr line + exit 1', async () => {
    const r = await run(['search', 'telemetry', '--remote'], {
      searchRemote: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('fetch failed');
    expect(r.err.trim().split('\n')).toHaveLength(1);
  });

  it('truncates an overlong description/source sanely in the human table (--json stays verbatim)', async () => {
    const longRow: RemoteSkillRow = {
      slug: 'long-one',
      name: 'long-one',
      description: 'x'.repeat(300),
      source: 'https://github.com/' + 'y'.repeat(200),
      index: 'claudskills',
    };
    const table = await run(['search', 'q', '--remote'], { searchRemote: async () => [longRow] });
    expect(table.code).toBe(0);
    // no output line is anywhere near the full 300/200-char field length
    for (const line of table.out.split('\n')) expect(line.length).toBeLessThan(250);
    expect(table.out).toContain('…');

    const json = await run(['search', 'q', '--remote', '--json'], { searchRemote: async () => [longRow] });
    expect(JSON.parse(json.out)).toEqual([longRow]); // JSON is verbatim, untruncated
  });
});
