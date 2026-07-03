// `buildSkillIndex` — the artifact BUILDER behind the bundled marketplace index (published as a static
// asset of the Vercel site; the GUI searches it client-side, the CLI's 'index' source fetches it). It
// harvests the BOUNDED bulk sources (topagentskills llms-full.txt · skillregistry lite index ·
// claude-plugins pages), dedups by name+repo with source priority, and emits a compact ranked artifact.
// EXTERNAL-API GLUE gate: fixture payloads mirror the live shapes pinned in skill-remote-sources.test.ts.

import { describe, it, expect } from 'vitest';
import { buildSkillIndex } from '../src/workflow/ops/skill-index-build.js';

const NOW = '2026-07-03T12:00:00.000Z';

const LLMS = `# Top Agent Skills — full skill catalog with install snippets

---

---
name: frontend-design
slug: frontend-design
score: 92
publisher: Anthropic
canonical: https://top-agent-skills.com/skill/frontend-design
---

# frontend-design

Escape generic AI-generated UIs.

## Metadata

- Source: https://github.com/anthropics/skills/tree/main/skills/frontend-design

---
`;

const REGISTRY_LITE = [
  {
    id: 'reg-uint',
    name: 'add-uint-support',
    description: 'Add unsigned integer support to PyTorch operators',
    repo: 'pytorch/pytorch',
    owner: 'pytorch',
    branch: 'main',
    path: '.claude/skills/add-uint-support',
    stars: 84000,
    quality_score: 81,
    tags: ['pytorch'],
  },
  { id: 'reg-orphan', name: 'orphan', description: 'no repo' },
];

const PLUGINS_PAGE0 = {
  skills: [
    {
      id: 'p1',
      name: 'pdf',
      namespace: '@anthropics/skills/pdf',
      description: 'Extract and create PDF content',
      author: 'anthropics',
      stars: 52420,
      installs: 22343,
      metadata: { repoOwner: 'anthropics', repoName: 'skills', directoryPath: 'skills/pdf' },
    },
    {
      // DUPLICATE of the topagentskills row (same name + repo) — must dedup, keeping the curated row but
      // MERGING the popularity signal this source carries and the curated row lacks.
      id: 'p2',
      name: 'frontend-design',
      namespace: '@anthropics/skills/frontend-design',
      description: 'Frontend design skill',
      author: 'anthropics',
      stars: 52420,
      installs: 9000,
      metadata: { repoOwner: 'anthropics', repoName: 'skills', directoryPath: 'skills/frontend-design' },
    },
  ],
  total: 2,
};
const PLUGINS_EMPTY = { skills: [], total: 2 };

function routedFetch(routes: Array<[string, unknown, { status?: number; text?: boolean }?]>) {
  const requested: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    for (const [match, body, opts] of routes) {
      if (!url.includes(match)) continue;
      const status = opts?.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => (opts?.text ? String(body) : JSON.stringify(body)),
      } as Response;
    }
    throw new Error(`unrouted ${url}`);
  }) as typeof fetch;
  return { impl, requested };
}

/** Routes for the healthy three-source case; claude-plugins pages: offset=0 full, everything else empty. */
function healthyRoutes(): Array<[string, unknown, { status?: number; text?: boolean }?]> {
  return [
    ['top-agent-skills.com/llms-full.txt', LLMS, { text: true }],
    ['claude-skill-registry-core/search-index-lite.json', REGISTRY_LITE],
    ['claude-plugins.dev/api/skills?limit=100&offset=0', PLUGINS_PAGE0],
    ['claude-plugins.dev/api/skills', PLUGINS_EMPTY],
  ];
}

describe('buildSkillIndex — harvest, dedup, rank, emit', () => {
  it('harvests all three sources, maps pop/quality, and stamps the envelope', async () => {
    const { impl } = routedFetch(healthyRoutes());
    const art = await buildSkillIndex({ fetchImpl: impl, now: NOW });

    expect(art.v).toBe(1);
    expect(art.builtAt).toBe(NOW);
    expect(art.sources.topagentskills).toBe(1);
    expect(art.sources.skillregistry).toBe(1); // the repo-less row never enters
    expect(art.sources['claude-plugins']).toBe(2);

    const bySlug = new Map(art.docs.map((d) => [d.slug, d]));
    // topagentskills: curated score → quality
    expect(bySlug.get('frontend-design')).toMatchObject({
      source: 'https://github.com/anthropics/skills',
      index: 'topagentskills',
      quality: 92,
    });
    // skillregistry: stars → pop, quality_score → quality
    expect(bySlug.get('reg-uint')).toMatchObject({
      source: 'https://github.com/pytorch/pytorch',
      pop: 84000,
      quality: 81,
    });
    // claude-plugins: stars + installs → pop
    expect(bySlug.get('@anthropics/skills/pdf')).toMatchObject({ pop: 52420 + 22343 });
  });

  it('dedups by name+repo with source PRIORITY — the curated row wins but absorbs the dup\'s pop', async () => {
    const { impl } = routedFetch(healthyRoutes());
    const art = await buildSkillIndex({ fetchImpl: impl, now: NOW });

    const fds = art.docs.filter((d) => d.name === 'frontend-design');
    expect(fds).toHaveLength(1);
    expect(fds[0].index).toBe('topagentskills'); // priority kept
    expect(fds[0].quality).toBe(92); // curated signal kept
    expect(fds[0].pop).toBe(52420 + 9000); // popularity MERGED from the claude-plugins duplicate
  });

  it('a dead source degrades to zero rows (counted honestly); the others still land', async () => {
    const routes = healthyRoutes().map(([m, b, o]): [string, unknown, { status?: number; text?: boolean }?] =>
      m.includes('claude-skill-registry-core') ? [m, { err: 'down' }, { status: 503 }] : [m, b, o],
    );
    const { impl } = routedFetch(routes);
    const art = await buildSkillIndex({ fetchImpl: impl, now: NOW });
    expect(art.sources.skillregistry).toBe(0);
    expect(art.sources.topagentskills).toBe(1);
  });

  it('EVERY source dead throws (an empty artifact must never silently replace a full one)', async () => {
    const routes = healthyRoutes().map(([m]): [string, unknown, { status?: number; text?: boolean }?] => [
      m,
      { err: 'down' },
      { status: 500 },
    ]);
    const { impl } = routedFetch(routes);
    await expect(buildSkillIndex({ fetchImpl: impl, now: NOW })).rejects.toThrow();
  });

  it('caps docs at maxDocs keeping the best (quality, then pop)', async () => {
    const { impl } = routedFetch(healthyRoutes());
    const art = await buildSkillIndex({ fetchImpl: impl, now: NOW, maxDocs: 2 });
    expect(art.docs).toHaveLength(2);
    // frontend-design (quality 92) and reg-uint (quality 81) outrank the quality-less pdf row.
    expect(art.docs.map((d) => d.name).sort()).toEqual(['add-uint-support', 'frontend-design']);
  });

  it('truncates a runaway description to 200 chars', async () => {
    const long = 'x'.repeat(500);
    const routes = healthyRoutes().map(([m, b, o]): [string, unknown, { status?: number; text?: boolean }?] =>
      m.includes('search-index-lite')
        ? [m, [{ ...REGISTRY_LITE[0], description: long }]]
        : [m, b, o],
    );
    const { impl } = routedFetch(routes);
    const art = await buildSkillIndex({ fetchImpl: impl, now: NOW });
    const doc = art.docs.find((d) => d.slug === 'reg-uint')!;
    expect(doc.description.length).toBeLessThanOrEqual(200);
  });
});
