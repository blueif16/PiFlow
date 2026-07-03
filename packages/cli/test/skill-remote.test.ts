// `searchRemote` — the ONLINE discovery lane over remote skill indexes (now in @piflow/core; this suite
// exercises it through the CLI re-export and pins the ClaudSkills + SkillsMP source behaviors — the newer
// sources and the quality-first default order are pinned by core's skill-remote-sources.test.ts).
// This is EXTERNAL-API GLUE (test-discipline §0): the network seam (`fetchImpl`) is
// ALWAYS injected here — zero real network in this suite. Two levels of fixture:
//   • a FROZEN-SCHEMA snippet taken VERBATIM from a live probe of each index (2026-07-03) — asserts the
//     fields we actually consume still exist on the real response shape.
//   • a synthetic multi-page TAPE (shape verbatim from the live API, values invented) for clean, readable
//     assertions on pagination/query-matching/limit behavior (the catalog-sync.test.ts precedent).
//
// VERIFIED LIVE FACTS pinned by this suite (see skill-remote.ts header for the full writeup):
//   • ClaudSkills' `/skills` list has NO working free-text query param (`q`/`search`/`query` are silently
//     ignored — `total` never changes) — so `searchRemote` PAGINATES `/skills?limit&offset` and filters
//     CLIENT-SIDE over slug/name/description/tags/category, bounded by a max scan-page count.
//   • ClaudSkills' `url` field is the catalog's OWN detail page, not a git remote; `author_url` is a GitHub
//     PROFILE, not a repo — neither is a verified `skill add`-able source (mapped anyway, marked UNVERIFIED).
//   • SkillsMP's `/skills/search?q=` DOES filter server-side (real free-text search, confirmed against the
//     live API), and its `githubUrl` is a repo TREE link — the repo ROOT is derived from it for `source`.

import { describe, it, expect } from 'vitest';
import { searchRemote, type RemoteSkillRow } from '../src/skill-remote.js';

/** A minimal fetch Response stand-in — only what searchRemote reads (`ok`, `status`, `.json()`). */
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

// ── Frozen-schema fixtures — VERBATIM from a live probe (2026-07-03) ─────────────────────────────────
// GET https://claudskills.com/api/v1/skills?limit=1
const CLAUDSKILLS_LIVE_ROW = {
  slug: '0-0-bibliotecas-y-talleres',
  name: 'creating-gh-issues',
  description:
    'Creates a GitHub issue based on a provided specification or context. To be used to create issues for features, bug corrections, or enhancements.',
  category: 'general',
  subcategory: 'general-misc',
  tags: [],
  daily_eligible: false,
  featured: false,
  author: 'TrainingITCourses',
  author_url: 'https://github.com/TrainingITCourses',
  license: 'MIT',
  url: 'https://claudskills.com/skills/0-0-bibliotecas-y-talleres/',
  og_image: 'https://claudskills.com/og/0-0-bibliotecas-y-talleres.png',
};

// GET https://skillsmp.com/api/v1/skills/search?q=research (first row)
const SKILLSMP_LIVE_ROW = {
  id: 'affaan-m-ecc-skills-prediction-market-oracle-research-skill-md',
  name: 'prediction-market-oracle-research',
  author: 'affaan-m',
  description:
    'Research prediction markets as data sources or oracle signals for products, agents, dashboards, and corporate decision intelligence.',
  githubUrl: 'https://github.com/affaan-m/ECC/tree/main/skills/prediction-market-oracle-research',
  skillUrl: 'https://skillsmp.com/creators/affaan-m/ecc/skills-prediction-market-oracle-research',
  stars: 219439,
  updatedAt: '1781179941',
};

describe('frozen-schema — the live response still carries the fields we consume', () => {
  it('ClaudSkills row carries slug/name/description/url/author/tags/category', () => {
    for (const key of ['slug', 'name', 'description', 'url', 'author', 'author_url', 'tags', 'category']) {
      expect(CLAUDSKILLS_LIVE_ROW).toHaveProperty(key);
    }
  });

  it('SkillsMP row carries id/name/description/githubUrl/author', () => {
    for (const key of ['id', 'name', 'description', 'githubUrl', 'author']) {
      expect(SKILLSMP_LIVE_ROW).toHaveProperty(key);
    }
  });
});

// ── Synthetic tape — shape verbatim from the live API, values invented for clean assertions ───────────
// A single-page catalog (`next: null`) — for tests that only care about field mapping / filtering on ONE
// fetched page, with no pagination in play.
const CS_SINGLE_PAGE = {
  data: [
    {
      slug: 'alpha-telemetry',
      name: 'alpha-telemetry',
      description: 'reads the alpha telemetry stream',
      category: 'engineering',
      tags: ['ai:claude'],
      author: 'alice',
      author_url: 'https://github.com/alice',
      url: 'https://claudskills.com/skills/alpha-telemetry/',
    },
    {
      slug: 'unrelated-skill',
      name: 'unrelated-skill',
      description: 'does something else entirely',
      category: 'general',
      tags: [],
      author: 'bob',
      author_url: 'https://github.com/bob',
      url: 'https://claudskills.com/skills/unrelated-skill/',
    },
  ],
  next: null,
  total: 2,
  limit: 200,
  offset: 0,
};

// A two-page catalog — page 1 carries a `next` cursor, page 2 is the last page (`next: null`). Neither
// page's match count reaches a default `limit`, so the ONLY thing that stops the scan is `next` running out.
const CS_MULTI_PAGE1 = {
  data: [
    {
      slug: 'gamma-unrelated',
      name: 'gamma-unrelated',
      description: 'not what we are looking for',
      category: 'general',
      tags: [],
      author: 'dave',
      author_url: 'https://github.com/dave',
      url: 'https://claudskills.com/skills/gamma-unrelated/',
    },
  ],
  next: 'https://claudskills.com/api/v1/skills?limit=200&offset=200',
  total: 2,
  limit: 200,
  offset: 0,
};
const CS_MULTI_PAGE2 = {
  data: [
    {
      slug: 'beta-research-brief',
      name: 'beta-research-brief',
      description: 'writes the beta research brief',
      category: 'science',
      tags: ['research'],
      author: 'carol',
      author_url: 'https://github.com/carol',
      url: 'https://claudskills.com/skills/beta-research-brief/',
    },
  ],
  next: null,
  total: 2,
  limit: 200,
  offset: 200,
};

describe('searchRemote — claudskills (sources: [claudskills])', () => {
  it('filters a page client-side and maps the matching row (the fired window stays bounded)', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      const offset = new URL(url).searchParams.get('offset');
      if (offset === '0') return jsonResponse(200, CS_SINGLE_PAGE);
      return jsonResponse(200, { data: [], next: null, total: 2, limit: 200, offset: Number(offset) });
    };
    const rows = await searchRemote('telemetry', { fetchImpl, sources: ['claudskills'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual<RemoteSkillRow>({
      slug: 'alpha-telemetry',
      name: 'alpha-telemetry',
      description: 'reads the alpha telemetry stream',
      source: 'https://claudskills.com/skills/alpha-telemetry/',
      author: 'alice',
      index: 'claudskills',
    });
    // the concurrent scan is BOUNDED: never more than the documented window of pages.
    expect(calls.length).toBeLessThanOrEqual(10);
  });

  it('finds a match on page 2 (the bounded page WINDOW is scanned concurrently, results in page order)', async () => {
    // Pages are routed by offset — the scan fires the whole bounded window at once (wall-clock speed);
    // a page past the catalog end returns an empty body, exactly like the live API.
    const fetchImpl = async (url: string) => {
      const offset = new URL(url).searchParams.get('offset');
      if (offset === '0') return jsonResponse(200, CS_MULTI_PAGE1);
      if (offset === '200') return jsonResponse(200, CS_MULTI_PAGE2);
      return jsonResponse(200, { data: [], next: null, total: 2, limit: 200, offset: Number(offset) });
    };
    const rows = await searchRemote('research brief', { fetchImpl, sources: ['claudskills'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('beta-research-brief');
  });

  it('a query matching nothing across every page returns an empty array', async () => {
    const fetchImpl = async (url: string) => {
      const offset = new URL(url).searchParams.get('offset');
      if (offset === '0') return jsonResponse(200, CS_MULTI_PAGE1);
      if (offset === '200') return jsonResponse(200, CS_MULTI_PAGE2);
      return jsonResponse(200, { data: [], next: null, total: 2, limit: 200, offset: Number(offset) });
    };
    const rows = await searchRemote('nonexistent-xyz', { fetchImpl, sources: ['claudskills'] });
    expect(rows).toEqual([]);
  });

  it('a single dead page degrades (page-order kept); results from healthy pages still return', async () => {
    const fetchImpl = async (url: string) => {
      const offset = new URL(url).searchParams.get('offset');
      if (offset === '0') return jsonResponse(500, { error: 'edge hiccup' });
      if (offset === '200') return jsonResponse(200, CS_MULTI_PAGE2);
      return jsonResponse(200, { data: [], next: null, total: 2, limit: 200, offset: Number(offset) });
    };
    const rows = await searchRemote('research brief', { fetchImpl, sources: ['claudskills'] });
    expect(rows.map((r) => r.slug)).toEqual(['beta-research-brief']);
  });

  it('respects limit — stops collecting once the cap is reached, within one page', async () => {
    const page = {
      ...CS_SINGLE_PAGE,
      data: [
        { ...CS_SINGLE_PAGE.data[0], slug: 'match-one', description: 'match token here' },
        { ...CS_SINGLE_PAGE.data[1], slug: 'match-two', description: 'match token here too' },
      ],
    };
    const fetchImpl = async () => jsonResponse(200, page);
    const rows = await searchRemote('match token', { fetchImpl, limit: 1, sources: ['claudskills'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('match-one');
  });

  it('respects limit across the window and never fires past the bounded page cap', async () => {
    let call = 0;
    const fetchImpl = async () => {
      call++;
      return jsonResponse(200, CS_MULTI_PAGE1); // matches on 'unrelated' on every page
    };
    const rows = await searchRemote('unrelated', { fetchImpl, limit: 1, sources: ['claudskills'] });
    expect(rows).toHaveLength(1);
    expect(call).toBeLessThanOrEqual(10); // the window is bounded even when every page matches
  });

  it('an HTTP error surfaces as a thrown Error identifying the source and status', async () => {
    const fetchImpl = async () => jsonResponse(500, { error: 'boom' });
    await expect(searchRemote('anything', { fetchImpl, sources: ['claudskills'] })).rejects.toThrow(/claudskills.*500/i);
  });

  it('a network failure (fetch rejects) propagates rather than being swallowed', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(searchRemote('anything', { fetchImpl, sources: ['claudskills'] })).rejects.toThrow(/fetch failed/);
  });
});

describe('searchRemote — skillsmp (opt-in secondary)', () => {
  const SKILLSMP_PAGE = {
    success: true,
    data: {
      skills: [
        {
          id: 'affaan-m-ecc-skills-prediction-market-oracle-research-skill-md',
          name: 'prediction-market-oracle-research',
          author: 'affaan-m',
          description: 'Research prediction markets as data sources or oracle signals.',
          githubUrl: 'https://github.com/affaan-m/ECC/tree/main/skills/prediction-market-oracle-research',
          skillUrl: 'https://skillsmp.com/creators/affaan-m/ecc/skills-prediction-market-oracle-research',
          stars: 219439,
          updatedAt: '1781179941',
        },
      ],
    },
  };

  it('derives the clonable repo ROOT from the githubUrl tree link', async () => {
    const fetchImpl = async () => jsonResponse(200, SKILLSMP_PAGE);
    const rows = await searchRemote('research', { fetchImpl, sources: ['skillsmp'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual<RemoteSkillRow>({
      slug: 'affaan-m-ecc-skills-prediction-market-oracle-research-skill-md',
      name: 'prediction-market-oracle-research',
      description: 'Research prediction markets as data sources or oracle signals.',
      source: 'https://github.com/affaan-m/ECC', // NOT the /tree/main/... deep link
      author: 'affaan-m',
      index: 'skillsmp',
    });
  });

  it('is NOT queried by default (its 50/day anon quota keeps it opt-in — see core DEFAULT_SOURCES)', async () => {
    let called = false;
    // Route every default source to an empty result so the whole default chain runs dry — skillsmp must
    // still never be touched.
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('skillsmp.com')) called = true;
      if (u.includes('top-agent-skills.com'))
        return { ok: true, status: 200, text: async () => '# empty\n', json: async () => ({}) } as Response;
      if (u.includes('agentskill.sh')) return jsonResponse(200, { results: [] });
      if (u.includes('claude-plugins.dev')) return jsonResponse(200, { skills: [] });
      return jsonResponse(200, { data: [], next: null, total: 0, limit: 200, offset: 0 });
    }) as typeof fetch;
    await searchRemote('alpha', { fetchImpl });
    expect(called).toBe(false);
  });
});

describe('searchRemote — argument edges', () => {
  it('an unknown source id throws rather than silently returning nothing', async () => {
    await expect(searchRemote('x', { sources: ['not-a-real-index'] })).rejects.toThrow(/not-a-real-index/);
  });
});
