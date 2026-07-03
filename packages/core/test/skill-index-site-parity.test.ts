// PARITY GATE — core's `buildSkillIndex` and the site's standalone `build-skills-index.mjs` are TWO
// implementations of the same harvest (the site script cannot import core: site-piflow lives outside the
// pnpm workspace). This test runs BOTH against the same fixtures and diffs the artifacts — edit either
// implementation and this goes red until the other matches. That is the ONLY thing keeping them honest;
// do not weaken it to "similar shape" — the artifacts must be deep-EQUAL.

import { describe, it, expect } from 'vitest';
import { buildSkillIndex as coreBuild } from '../src/workflow/ops/skill-index-build.js';
// @ts-expect-error — plain .mjs, no types; the parity diff below is the contract.
import { buildSkillIndex as siteBuild } from '../../../site-piflow/scripts/build-skills-index.mjs';

const NOW = '2026-07-03T12:00:00.000Z';

const LLMS = `# Top Agent Skills

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
name: no-source-skill
slug: no-source-skill
score: 60
publisher: Community
canonical: https://top-agent-skills.com/skill/no-source-skill
---

# no-source-skill

Falls back to its canonical page.

---
`;

const REGISTRY_LITE = [
  {
    id: 'reg-uint',
    name: 'add-uint-support',
    description: 'Add unsigned integer support — plus a long tail: ' + 'y'.repeat(400),
    repo: 'pytorch/pytorch',
    owner: 'pytorch',
    stars: 84000,
    quality_score: 81,
  },
  { id: 'reg-orphan', name: 'orphan', description: 'no repo — dropped by both impls' },
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
      metadata: { repoOwner: 'anthropics', repoName: 'skills' },
    },
    {
      // duplicate of the curated frontend-design (same name+repo) — dedup + pop-merge must agree too
      id: 'p2',
      name: 'frontend-design',
      namespace: '@anthropics/skills/frontend-design',
      description: 'dup',
      author: 'anthropics',
      stars: 1000,
      installs: 500,
      metadata: { repoOwner: 'anthropics', repoName: 'skills' },
    },
  ],
};

function fixtureFetch() {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const route = (body: unknown, text = false) =>
      ({ ok: true, status: 200, json: async () => body, text: async () => (text ? String(body) : JSON.stringify(body)) }) as Response;
    if (url.includes('top-agent-skills.com')) return route(LLMS, true);
    if (url.includes('claude-skill-registry-core')) return route(REGISTRY_LITE);
    if (url.includes('claude-plugins.dev') && url.includes('offset=0')) return route(PLUGINS_PAGE0);
    if (url.includes('claude-plugins.dev')) return route({ skills: [] });
    throw new Error(`unrouted ${url}`);
  }) as typeof fetch;
}

describe('site-script ↔ core builder parity', () => {
  it('both implementations emit deep-EQUAL artifacts from identical inputs', async () => {
    const a = await coreBuild({ fetchImpl: fixtureFetch(), now: NOW });
    const b = await siteBuild({ fetchImpl: fixtureFetch(), now: NOW });
    expect(b).toEqual(a);
    // and the fixture actually exercised the interesting paths (guard against a vacuous pass):
    expect(a.docs.length).toBeGreaterThanOrEqual(4);
    expect(a.docs.some((d) => d.quality !== undefined)).toBe(true);
    expect(a.docs.some((d) => d.pop !== undefined)).toBe(true);
  });
});
