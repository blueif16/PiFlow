// `piflowctl skill index build` — the CLI wrapper that BUILDS the bundled marketplace artifact and writes
// it where the caller points (`--out`, e.g. site-piflow/public/skills-index.json — the Vercel bundle).
// The CLI layer is dispatch + file-write + summary ONLY: the harvest lives in core's `buildSkillIndex`
// (its own suite); here the builder is injected (the catalog-cli.test.ts dispatch pattern) — zero network.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runSkillCli, type SkillDeps } from '../src/skill.js';
import type { SkillIndexArtifact } from '@piflow/core';

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
  deps: Pick<SkillDeps, 'buildIndex'> = {},
): Promise<{ out: string; err: string; code: number }> {
  const o = sink();
  const e = sink();
  const code = await runSkillCli(argv, { out: o.write, err: e.write, ...deps });
  return { out: o.text, err: e.text, code };
}

const ARTIFACT: SkillIndexArtifact = {
  v: 1,
  builtAt: '2026-07-03T12:00:00.000Z',
  sources: { topagentskills: 146, skillregistry: 4980, 'claude-plugins': 2987 },
  docs: [
    {
      slug: 'frontend-design',
      name: 'frontend-design',
      description: 'Escape generic AI-generated UIs.',
      source: 'https://github.com/anthropics/skills',
      author: 'Anthropic',
      index: 'topagentskills',
      quality: 92,
    },
  ],
};

describe('piflowctl skill index build — dispatch + write + summary', () => {
  it('calls the builder, writes the artifact JSON to --out, and prints the per-source counts', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'piflow-skill-index-'));
    const outFile = path.join(dir, 'skills-index.json');
    try {
      const r = await run(['index', 'build', '--out', outFile], { buildIndex: async () => ARTIFACT });
      expect(r.code).toBe(0);
      expect(JSON.parse(readFileSync(outFile, 'utf8'))).toEqual(ARTIFACT);
      expect(r.out).toContain('1 doc');
      expect(r.out).toContain('topagentskills 146');
      expect(r.out).toContain(outFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a builder failure is one stderr line + exit 1, and NO file is written', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'piflow-skill-index-'));
    const outFile = path.join(dir, 'skills-index.json');
    try {
      const r = await run(['index', 'build', '--out', outFile], {
        buildIndex: async () => {
          throw new Error('every harvest lane died');
        },
      });
      expect(r.code).toBe(1);
      expect(r.err).toContain('every harvest lane died');
      expect(existsSync(outFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unknown index subcommand is usage: exit 1, builder never called', async () => {
    let called = false;
    const r = await run(['index', 'frobnicate'], {
      buildIndex: async () => {
        called = true;
        return ARTIFACT;
      },
    });
    expect(r.code).toBe(1);
    expect(called).toBe(false);
    expect(r.err).toContain('index');
  });
});
