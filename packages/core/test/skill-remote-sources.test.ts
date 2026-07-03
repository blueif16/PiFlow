// `searchRemote` (core) — the ONLINE discovery lane's NEW sources, each pinned against the REAL response
// shapes probed live 2026-07-03 (the workflow's sampleEvidence snippets are the spec here — the fakes
// mirror those payloads byte-shape-for-byte-shape, NOT whatever the implementation happens to read).
// EXTERNAL-API GLUE gate (test-discipline §0): fakes carry the COMPLETE observed row schema, not just the
// fields the mapper reads, so a field rename upstream breaks THESE tests, not production silently.
//
// Behaviors pinned:
//   • agentskill — GET /api/agent/search?q=; `repositoryUrl` wins; githubOwner/Repo derives a fallback
//     root; a row with neither is dropped (never an uninstallable empty source).
//   • claude-plugins — GET /api/skills?q=&limit=; source = repo root from metadata.repoOwner/repoName;
//     namespace is the slug.
//   • skills-re — POST /skills/search {query}; each row resolved via /cli/skills/resolve-install →
//     lockEntry.sourceUrl; a failed resolve degrades to the skills.re browse page (never throws).
//   • topagentskills — ONE static llms-full.txt fetch, client-side filter, `- Source:` → repo root.
//   • skillregistry — ONE static search-index-lite.json fetch, client-side filter, `repo` → repo root,
//     a row without `repo` is dropped.
//   • searchRemote — quality-first default order (topagentskills fills before the giants; unneeded
//     sources are NEVER fetched), cross-source dedup (same name+repo keeps the earlier source's row).

import { describe, it, expect } from 'vitest';
import { searchRemote, remoteSourceIds } from '../src/workflow/ops/skill-remote.js';

/** A URL-routed fetch fake: `routes` maps a substring → a JSON body (or a raw string for text bodies).
 *  Records every requested URL so tests can assert what was (and was NOT) fetched. */
function fakeFetch(routes: Array<[match: string, body: unknown, opts?: { status?: number; text?: boolean }]>) {
  const requested: string[] = [];
  const impl = (async (input: string | URL | Request, _init?: RequestInit) => {
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
    throw new Error(`fakeFetch: unrouted URL ${url}`);
  }) as typeof fetch;
  return { impl, requested };
}

// ── agentskill.sh — search rows carry NO repo fields (live-verified 2026-07-03); the repo comes from a
// per-row detail fetch `GET /api/skills/{slug}` → `data.repositoryUrl` / `data.githubOwner`+`githubRepo`. ──
const AGENTSKILL_SEARCH_ROW = {
  slug: 'anthropics/docx',
  name: 'docx',
  owner: 'anthropics',
  description: 'Create and edit Word documents',
  category: 'documents',
  jobCategories: ['writing'],
  platforms: ['claude-code'],
  skillTypes: ['skill'],
  installCount: 22343,
  githubStars: 157953,
  score: 98,
  ratingCount: 12,
  securityScore: 98,
  contentQualityScore: 91,
  contentSha: 'cfbabd7',
  updatedAt: '2026-07-01T18:11:25Z',
};
const AGENTSKILL_DETAIL = {
  data: {
    _id: '698946ffaf18a4e4066f43a2',
    slug: 'anthropics/docx',
    githubOwner: 'anthropics',
    githubRepo: 'skills',
    githubPath: 'skills/docx/SKILL.md',
    githubBranch: 'main',
    githubSha: '2951e559989765293b6fbf83942378a3c2d0cba6',
    repositoryUrl: 'https://github.com/anthropics/skills',
    securityScore: 98,
  },
};

describe('agentskill source', () => {
  it('searches /api/agent/search?q= then resolves each row via /api/skills/{slug} → repositoryUrl', async () => {
    const { impl, requested } = fakeFetch([
      ['agentskill.sh/api/agent/search', { results: [AGENTSKILL_SEARCH_ROW] }],
      ['agentskill.sh/api/skills/anthropics%2Fdocx', AGENTSKILL_DETAIL],
    ]);
    const rows = await searchRemote('docx', { fetchImpl: impl, sources: ['agentskill'] });
    expect(requested[0]).toBe('https://agentskill.sh/api/agent/search?q=docx');
    expect(requested[1]).toBe('https://agentskill.sh/api/skills/anthropics%2Fdocx');
    expect(rows).toEqual([
      {
        slug: 'anthropics/docx',
        name: 'docx',
        description: 'Create and edit Word documents',
        source: 'https://github.com/anthropics/skills',
        author: 'anthropics',
        index: 'agentskill',
      },
    ]);
  });

  it('repositoryUrl WINS over the derived github root (a non-github host must survive as-is)', async () => {
    // Kills the "derive-only" mutant: for most rows repositoryUrl EQUALS the derivation, so only a row
    // where they differ can tell the mapping order apart.
    const detail = { data: { ...AGENTSKILL_DETAIL.data, repositoryUrl: 'https://gitlab.com/z/gl' } };
    const { impl } = fakeFetch([
      ['agentskill.sh/api/agent/search', { results: [AGENTSKILL_SEARCH_ROW] }],
      ['agentskill.sh/api/skills/', detail],
    ]);
    const rows = await searchRemote('docx', { fetchImpl: impl, sources: ['agentskill'] });
    expect(rows[0].source).toBe('https://gitlab.com/z/gl');
  });

  it('derives the repo root from the detail githubOwner/githubRepo when repositoryUrl is absent', async () => {
    const detail = { data: { ...AGENTSKILL_DETAIL.data, repositoryUrl: undefined } };
    const { impl } = fakeFetch([
      ['agentskill.sh/api/agent/search', { results: [AGENTSKILL_SEARCH_ROW] }],
      ['agentskill.sh/api/skills/', detail],
    ]);
    const rows = await searchRemote('docx', { fetchImpl: impl, sources: ['agentskill'] });
    expect(rows[0].source).toBe('https://github.com/anthropics/skills');
  });

  it('a failed detail resolve DROPS the row (no invented browse URL, no thrown search)', async () => {
    const { impl } = fakeFetch([
      ['agentskill.sh/api/agent/search', { results: [AGENTSKILL_SEARCH_ROW] }],
      ['agentskill.sh/api/skills/', { error: 'nope' }, { status: 500 }],
    ]);
    const rows = await searchRemote('docx', { fetchImpl: impl, sources: ['agentskill'] });
    expect(rows).toEqual([]);
  });
});

// ── claude-plugins.dev — the COMPLETE observed row shape (probe evidence: q=pdf) ─────────────────────
const CLAUDE_PLUGINS_ROW = {
  id: '4c08e453-73f3-4c10-9dbc-2174ed8e3f11',
  name: 'pdf',
  namespace: '@anthropics/skills/pdf',
  sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
  description: 'Extract and create PDF content',
  version: '1.0.0',
  dependencies: [],
  author: 'anthropics',
  stars: 52420,
  installs: 22343,
  metadata: {
    repoOwner: 'anthropics',
    repoName: 'skills',
    directoryPath: 'skills/pdf',
    rawFileUrl: 'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md',
  },
  createdAt: '2025-10-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};

describe('claude-plugins source', () => {
  it('hits /api/skills?q=&limit= and maps metadata repoOwner/repoName to the repo root; namespace is the slug', async () => {
    const { impl, requested } = fakeFetch([
      ['claude-plugins.dev/api/skills', { skills: [CLAUDE_PLUGINS_ROW], total: 542 }],
    ]);
    const rows = await searchRemote('pdf', { fetchImpl: impl, sources: ['claude-plugins'], limit: 5 });
    expect(requested[0]).toBe('https://claude-plugins.dev/api/skills?q=pdf&limit=5');
    expect(rows).toEqual([
      {
        slug: '@anthropics/skills/pdf',
        name: 'pdf',
        description: 'Extract and create PDF content',
        source: 'https://github.com/anthropics/skills',
        author: 'anthropics',
        index: 'claude-plugins',
      },
    ]);
  });
});

// ── skills.re — POST search + per-row resolve (probe evidence: reddit-to-linkedin-posts) ─────────────
describe('skills-re source', () => {
  it('POSTs {query} to /skills/search then resolves each row via resolve-install → lockEntry.sourceUrl', async () => {
    let postBody: unknown;
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.skills.re/skills/search') {
        postBody = JSON.parse(String(init?.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            continueCursor: 'eyJpZCI6...',
            isDone: false,
            page: [
              {
                id: 'UbMgWIPbHy6AMkMCEzx3o',
                slug: 'reddit-to-linkedin-posts',
                title: 'reddit-to-linkedin-posts',
                description: 'Turn a Reddit thread into LinkedIn-ready posts',
                syncTime: 1783028254834,
              },
            ],
          }),
        } as Response;
      }
      if (url.startsWith('https://api.skills.re/cli/skills/resolve-install?skill=reddit-to-linkedin-posts')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            lockEntry: {
              sourceUrl: 'https://github.com/federicodeponte/reddit-to-linkedin-posts',
              skillPath: 'skills/reddit-to-linkedin-posts/SKILL.md',
            },
            archive: { downloadUrl: 'https://api.skills.re/skills/download?snapshotId=abc' },
          }),
        } as Response;
      }
      throw new Error(`unrouted ${url}`);
    }) as typeof fetch;

    const rows = await searchRemote('reddit', { fetchImpl: impl, sources: ['skills-re'] });
    expect(postBody).toEqual({ query: 'reddit' });
    expect(rows).toEqual([
      {
        slug: 'reddit-to-linkedin-posts',
        name: 'reddit-to-linkedin-posts',
        description: 'Turn a Reddit thread into LinkedIn-ready posts',
        source: 'https://github.com/federicodeponte/reddit-to-linkedin-posts',
        index: 'skills-re',
      },
    ]);
  });

  it('a failed resolve degrades that row to the skills.re browse page (discovery never dies on one row)', async () => {
    const { impl } = fakeFetch([
      ['api.skills.re/skills/search', { page: [{ slug: 'ghost-skill', title: 'ghost', description: '' }] }],
      ['api.skills.re/cli/skills/resolve-install', { error: 'not found' }, { status: 500 }],
    ]);
    const rows = await searchRemote('ghost', { fetchImpl: impl, sources: ['skills-re'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('https://skills.re/skills/ghost-skill');
  });
});

// ── topagentskills — ONE static llms-full.txt, shaped exactly like the probed file ───────────────────
const LLMS_FULL_TXT = `# Top Agent Skills — full skill catalog with install snippets

> 146 skills ranked by composite score. Each entry includes per-agent install snippets.

> Canonical: https://top-agent-skills.com/llms-full.txt

---

---
name: frontend-design
slug: frontend-design
score: 92
rubric: 1.0
provenance: anthropic
publisher: Anthropic
license: MIT
capability: read-only
canonical: https://top-agent-skills.com/skill/frontend-design
---

# frontend-design

Escape generic AI-generated UIs. Forces a bold, distinctive design direction before any code is written.

## Install

### Claude Code

\`\`\`bash
npx skills add github.com/anthropics/skills --skill frontend-design
\`\`\`

## Metadata

- Categories: frontend-design
- Tags: React, Tailwind, Design
- Source: https://github.com/anthropics/skills/tree/main/skills/frontend-design
- Docs: https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md

---
name: stripe-best-practices
slug: stripe-best-practices
score: 88
provenance: verified-org
publisher: Stripe
canonical: https://top-agent-skills.com/skill/stripe-best-practices
---

# stripe-best-practices

Integrate Stripe payments the supported way.

## Metadata

- Source: https://github.com/stripe/ai/tree/main/skills/stripe-best-practices

---
name: orphan-quality-skill
slug: orphan-quality-skill
score: 71
publisher: Community
canonical: https://top-agent-skills.com/skill/orphan-quality-skill
---

# orphan-quality-skill

A ranked skill whose block carries no Source line.

---

_Indexed by Top Agent Skills. Score breakdown: https://top-agent-skills.com/about/methodology_
`;

describe('topagentskills source', () => {
  it('fetches the static catalog once, filters client-side, and maps the body Metadata Source to the repo root', async () => {
    const { impl, requested } = fakeFetch([
      ['top-agent-skills.com/llms-full.txt', LLMS_FULL_TXT, { text: true }],
    ]);
    const rows = await searchRemote('stripe', { fetchImpl: impl, sources: ['topagentskills'] });
    expect(requested).toEqual(['https://top-agent-skills.com/llms-full.txt']);
    expect(rows).toEqual([
      {
        slug: 'stripe-best-practices',
        name: 'stripe-best-practices',
        description: 'Integrate Stripe payments the supported way.',
        source: 'https://github.com/stripe/ai',
        author: 'Stripe',
        index: 'topagentskills',
        quality: 88, // the frontmatter `score:` — the curated composite the ranker boosts on
      },
    ]);
  });

  it('a skill block WITHOUT a Source line falls back to its canonical page (never dropped, never empty)', async () => {
    const { impl } = fakeFetch([['top-agent-skills.com/llms-full.txt', LLMS_FULL_TXT, { text: true }]]);
    const rows = await searchRemote('orphan', { fetchImpl: impl, sources: ['topagentskills'] });
    expect(rows).toEqual([
      {
        slug: 'orphan-quality-skill',
        name: 'orphan-quality-skill',
        description: 'A ranked skill whose block carries no Source line.',
        source: 'https://top-agent-skills.com/skill/orphan-quality-skill',
        author: 'Community',
        index: 'topagentskills',
        quality: 71,
      },
    ]);
  });

  it('the file header/footer never become rows; all three skill blocks parse', async () => {
    const { impl } = fakeFetch([['top-agent-skills.com/llms-full.txt', LLMS_FULL_TXT, { text: true }]]);
    const rows = await searchRemote('e', { fetchImpl: impl, sources: ['topagentskills'], limit: 50 });
    expect(rows.map((r) => r.slug).sort()).toEqual([
      'frontend-design',
      'orphan-quality-skill',
      'stripe-best-practices',
    ]);
  });
});

// ── skillregistry (majiayu000) — ONE static lite index, rows carry `repo` (probe evidence) ───────────
const SKILLREGISTRY_LITE = [
  {
    id: 'o1ubr0viuvmjznzl6losm9o-pz2hgpkj5jvfgkyjb3e',
    name: 'add-uint-support',
    description: 'Add unsigned integer (uint) support to PyTorch operators',
    category: 'development',
    tags: ['pytorch', 'c++'],
    repo: 'pytorch/pytorch',
    owner: 'pytorch',
    path: '.claude/skills/add-uint-support',
    install: 'pytorch/pytorch/.claude/skills/add-uint-support',
    branch: 'main',
    stars: 84000,
    quality_grade: 'A',
    security_status: 'clean',
  },
  { id: 'no-repo-row', name: 'orphan-skill', description: 'indexed but repo-less' },
];

describe('skillregistry source', () => {
  it('fetches the lite index once, filters client-side, maps repo → github root, drops repo-less rows', async () => {
    const { impl, requested } = fakeFetch([
      ['majiayu000.github.io/claude-skill-registry-core/search-index-lite.json', SKILLREGISTRY_LITE],
    ]);
    const rows = await searchRemote('uint', { fetchImpl: impl, sources: ['skillregistry'] });
    expect(requested).toHaveLength(1);
    expect(rows).toEqual([
      {
        slug: 'o1ubr0viuvmjznzl6losm9o-pz2hgpkj5jvfgkyjb3e',
        name: 'add-uint-support',
        description: 'Add unsigned integer (uint) support to PyTorch operators',
        source: 'https://github.com/pytorch/pytorch',
        author: 'pytorch',
        index: 'skillregistry',
      },
    ]);
    // the repo-less row can NEVER surface, whatever the query
    const orphan = await searchRemote('orphan', { fetchImpl: impl, sources: ['skillregistry'] });
    expect(orphan).toEqual([]);
  });
});

// ── searchRemote orchestration: default order, laziness, dedup ───────────────────────────────────────
describe('searchRemote defaults + dedup', () => {
  it('the bundled INDEX answers alone when it fills the limit — no live API is ever touched', async () => {
    const artifact = {
      v: 1,
      builtAt: '2026-07-03T07:00:00.000Z',
      sources: { topagentskills: 1 },
      docs: [
        {
          slug: 'stripe-best-practices',
          name: 'stripe-best-practices',
          description: 'Integrate Stripe payments the supported way.',
          source: 'https://github.com/stripe/ai',
          author: 'Stripe',
          index: 'topagentskills',
          quality: 88,
        },
      ],
    };
    const { impl, requested } = fakeFetch([['piflow.sh/skills-index.json', artifact]]);
    const rows = await searchRemote('stripe', { fetchImpl: impl, limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].index).toBe('topagentskills'); // provenance = the upstream index, not 'index'
    expect(rows[0].quality).toBe(88);
    expect(requested).toEqual(['https://piflow.sh/skills-index.json']); // the live fan-out never fired
  });

  it('an unavailable index falls through to the live fan-out: all live defaults fire CONCURRENTLY, priority order kept', async () => {
    const { impl, requested } = fakeFetch([
      ['piflow.sh/skills-index.json', { error: 'not deployed yet' }, { status: 404 }],
      ['top-agent-skills.com/llms-full.txt', LLMS_FULL_TXT, { text: true }],
      ['agentskill.sh/api/agent/search', { results: [AGENTSKILL_SEARCH_ROW] }],
      ['agentskill.sh/api/skills/', AGENTSKILL_DETAIL],
      ['claude-plugins.dev', { skills: [CLAUDE_PLUGINS_ROW] }],
      ['claudskills.com', { data: [], next: null, total: 0, limit: 200, offset: 0 }],
    ]);
    const rows = await searchRemote('stripe', { fetchImpl: impl, limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].index).toBe('topagentskills'); // priority order survives the parallel fan-out
    const hosts = new Set(requested.map((u) => new URL(u).host));
    expect(hosts).toContain('top-agent-skills.com');
    expect(hosts).toContain('agentskill.sh');
    expect(hosts).toContain('claude-plugins.dev');
    expect(hosts).toContain('claudskills.com');
  });

  it('one source failing does NOT kill the search when others return rows (degrade, do not die)', async () => {
    const { impl } = fakeFetch([
      ['piflow.sh/skills-index.json', { error: 'down' }, { status: 500 }],
      ['top-agent-skills.com/llms-full.txt', LLMS_FULL_TXT, { text: true }],
      ['agentskill.sh/api/agent/search', { results: [] }],
      ['claude-plugins.dev', { error: 'boom' }, { status: 503 }],
      ['claudskills.com', { data: [], next: null, total: 0, limit: 200, offset: 0 }],
    ]);
    const rows = await searchRemote('stripe', { fetchImpl: impl, limit: 5 });
    expect(rows.map((r) => r.index)).toContain('topagentskills');
  });

  it('EVERY source failing throws the first failure (an all-dead search must not look like no-match)', async () => {
    const { impl } = fakeFetch([
      ['piflow.sh/skills-index.json', { error: 'down' }, { status: 500 }],
      ['top-agent-skills.com/llms-full.txt', 'down', { status: 500, text: true }],
      ['agentskill.sh/api/agent/search', { error: 'down' }, { status: 500 }],
      ['claude-plugins.dev', { error: 'down' }, { status: 500 }],
      ['claudskills.com', { error: 'down' }, { status: 500 }],
    ]);
    await expect(searchRemote('stripe', { fetchImpl: impl, limit: 5 })).rejects.toThrow(/HTTP 500/);
  });

  it('cross-source dedup: the same name+repo from a later source is dropped (earlier source wins)', async () => {
    // agentskill and claude-plugins both surface anthropics/skills' `pdf` — one row must survive.
    const agentskillPdf = { ...AGENTSKILL_SEARCH_ROW, slug: 'anthropics/pdf', name: 'pdf' };
    const pdfDetail = { data: { ...AGENTSKILL_DETAIL.data, slug: 'anthropics/pdf' } };
    const { impl } = fakeFetch([
      ['piflow.sh/skills-index.json', { error: 'absent' }, { status: 404 }],
      ['top-agent-skills.com/llms-full.txt', '# empty\n', { text: true }],
      ['agentskill.sh/api/agent/search', { results: [agentskillPdf] }],
      ['agentskill.sh/api/skills/', pdfDetail],
      ['claude-plugins.dev', { skills: [CLAUDE_PLUGINS_ROW], total: 1 }],
      ['claudskills.com', { data: [], next: null, total: 0, limit: 200, offset: 0 }],
    ]);
    const rows = await searchRemote('pdf', { fetchImpl: impl, limit: 20 });
    const pdfRows = rows.filter((r) => r.name === 'pdf');
    expect(pdfRows).toHaveLength(1);
    expect(pdfRows[0].index).toBe('agentskill');
  });

  it('same NAME from DIFFERENT repos is NOT a duplicate — both rows survive (name collisions are routine)', async () => {
    // Kills the "dedup by name only" mutant: every index carries a dozen unrelated `pdf` skills.
    const communityPdf = { ...AGENTSKILL_SEARCH_ROW, slug: 'ranbot-ai/docx', name: 'docx', owner: 'ranbot-ai' };
    const communityDetail = {
      data: { ...AGENTSKILL_DETAIL.data, slug: 'ranbot-ai/docx', repositoryUrl: 'https://github.com/ranbot-ai/skills' },
    };
    const { impl } = fakeFetch([
      ['agentskill.sh/api/agent/search', { results: [AGENTSKILL_SEARCH_ROW, communityPdf] }],
      ['agentskill.sh/api/skills/anthropics%2Fdocx', AGENTSKILL_DETAIL],
      ['agentskill.sh/api/skills/ranbot-ai%2Fdocx', communityDetail],
    ]);
    const rows = await searchRemote('docx', { fetchImpl: impl, sources: ['agentskill'], limit: 20 });
    expect(rows.map((r) => r.source).sort()).toEqual([
      'https://github.com/anthropics/skills',
      'https://github.com/ranbot-ai/skills',
    ]);
  });

  it('remoteSourceIds names every registered index (the GUI/CLI source pickers read this)', () => {
    expect(remoteSourceIds().sort()).toEqual(
      ['agentskill', 'claude-plugins', 'claudskills', 'index', 'skillregistry', 'skills-re', 'skillsmp', 'topagentskills'].sort(),
    );
  });
});
