// `buildSkillIndex` — builds the BUNDLED marketplace index artifact: a compact, quality-ranked snapshot of
// the skill universe that ships as a STATIC ASSET of the Vercel site (`site-piflow/public/skills-index.json`,
// served at https://piflow.sh/skills-index.json). The front-end bundle hosts the index — the GUI fetches it
// same-origin once and searches client-side (skill-index-search.ts) INSTANTLY; the CLI's 'index' source
// fetches the same URL. A scheduled CI job (`.github/workflows/skills-index.yml`) rebuilds it twice a day
// and commits the refresh, which redeploys the site. This module performs NO fs writes — it returns the
// artifact object; the CLI verb owns the file.
//
// HARVESTED sources — only the ones with a BOUNDED bulk lane (probed live 2026-07-03, shapes pinned in
// skill-remote.ts's header; the fixtures in skill-index-build.test.ts mirror them):
//   • topagentskills — ONE 179KB llms-full.txt: 146 curated skills, composite score → `quality`.
//   • skillregistry (majiayu000) — ONE ~3.5MB search-index-lite.json (the registry's own top ~5k by
//     relevance): `repo` → source, `stars` → pop, `quality_score` → quality.
//   • claude-plugins — `/api/skills?limit=100&offset=N` pages (stars + installs → pop), capped at
//     `claudePluginsPages` (default 30 → ~3k rows, its most-installed head).
// NOT harvested (documented, not silent): claudskills' full dump is 93.8MB/day (too heavy per build for
// the marginal head-quality gain — its rows carry no popularity signal); agentskill/skillsmp/skills-re have
// no bulk lane. The LIVE source fan-out remains the deep-search fallback for all of that long tail.

import type { RemoteSkillRow } from './skill-remote.js';
import { parseTopagentskillsCatalog } from './skill-remote.js';
import type { SkillIndexArtifact, SkillIndexDoc } from './skill-index-search.js';

export interface BuildSkillIndexOpts {
  /** The network seam (default `globalThis.fetch`). */
  fetchImpl?: typeof fetch;
  /** RFC3339 stamp for `builtAt` (injectable for determinism). Default `new Date().toISOString()`. */
  now?: string;
  /** claude-plugins page cap (100 rows/page). Default 30 (~3k rows — the most-installed head). */
  claudePluginsPages?: number;
  /** Total doc cap; the best (quality desc, then pop desc) survive. Default 12000. */
  maxDocs?: number;
}

const REGISTRY_LITE_URL = 'https://majiayu000.github.io/claude-skill-registry-core/search-index-lite.json';
const TOPAGENTSKILLS_URL = 'https://top-agent-skills.com/llms-full.txt';
const CLAUDE_PLUGINS_BASE = 'https://claude-plugins.dev/api';
const MAX_DESCRIPTION = 200;

interface RegistryLiteRow {
  id?: string;
  name: string;
  description?: string;
  repo?: string;
  owner?: string;
  stars?: number;
  quality_score?: number;
  tags?: string[];
}

interface ClaudePluginsRow {
  id: string;
  name: string;
  namespace?: string;
  description?: string;
  author?: string;
  stars?: number;
  installs?: number;
  metadata?: { repoOwner?: string; repoName?: string };
}

function truncate(s: string): string {
  return s.length > MAX_DESCRIPTION ? `${s.slice(0, MAX_DESCRIPTION - 1)}…` : s;
}

/** The same cross-source identity `searchRemote` dedups by: name + normalized repo URL. */
function dedupKey(d: { name: string; source: string }): string {
  const src = d.source
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  return `${d.name.toLowerCase()}|${src}`;
}

async function harvestTopagentskills(f: typeof fetch): Promise<SkillIndexDoc[]> {
  const res = await f(TOPAGENTSKILLS_URL);
  if (!res.ok) throw new Error(`topagentskills: catalog fetch failed (HTTP ${res.status})`);
  return parseTopagentskillsCatalog(await res.text()).map((r: RemoteSkillRow) => ({
    ...r,
    description: truncate(r.description),
  }));
}

async function harvestSkillregistry(f: typeof fetch): Promise<SkillIndexDoc[]> {
  const res = await f(REGISTRY_LITE_URL);
  if (!res.ok) throw new Error(`skillregistry: index fetch failed (HTTP ${res.status})`);
  const body = (await res.json()) as RegistryLiteRow[] | { skills?: RegistryLiteRow[]; rows?: RegistryLiteRow[] };
  const list = Array.isArray(body) ? body : (body.skills ?? body.rows ?? []);
  const docs: SkillIndexDoc[] = [];
  for (const r of list) {
    if (!r.repo) continue; // nothing installable to point at
    docs.push({
      slug: r.id ?? r.name,
      name: r.name,
      description: truncate(r.description ?? ''),
      source: `https://github.com/${r.repo}`,
      author: r.owner,
      index: 'skillregistry',
      ...(typeof r.stars === 'number' ? { pop: r.stars } : {}),
      ...(typeof r.quality_score === 'number' ? { quality: r.quality_score } : {}),
    });
  }
  return docs;
}

async function harvestClaudePlugins(f: typeof fetch, pages: number): Promise<SkillIndexDoc[]> {
  const docs: SkillIndexDoc[] = [];
  for (let page = 0; page < pages; page++) {
    const res = await f(`${CLAUDE_PLUGINS_BASE}/skills?limit=100&offset=${page * 100}`);
    if (!res.ok) throw new Error(`claude-plugins: page fetch failed (HTTP ${res.status})`);
    const body = (await res.json()) as { skills?: ClaudePluginsRow[] };
    const rows = body.skills ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      const source =
        r.metadata?.repoOwner && r.metadata?.repoName
          ? `https://github.com/${r.metadata.repoOwner}/${r.metadata.repoName}`
          : undefined;
      if (!source) continue;
      const pop = (r.stars ?? 0) + (r.installs ?? 0);
      docs.push({
        slug: r.namespace ?? r.name,
        name: r.name,
        description: truncate(r.description ?? ''),
        source,
        author: r.author,
        index: 'claude-plugins',
        ...(pop > 0 ? { pop } : {}),
      });
    }
  }
  return docs;
}

/**
 * Build the artifact: harvest every bulk source CONCURRENTLY, dedup by name+repo in PRIORITY order
 * (curated `topagentskills` > scored `skillregistry` > popular `claude-plugins`) while MERGING the
 * pop/quality signals a duplicate carries and the kept row lacks, rank (quality desc, pop desc), and cap
 * at `maxDocs`. A dead source degrades to zero rows (its `sources` count says so honestly); EVERY source
 * dead throws — an empty artifact must never silently replace a full one on the published site.
 */
export async function buildSkillIndex(opts: BuildSkillIndexOpts = {}): Promise<SkillIndexArtifact> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date().toISOString();
  const pages = opts.claudePluginsPages ?? 30;
  const maxDocs = opts.maxDocs ?? 12_000;

  const lanes: Array<{ id: string; run: () => Promise<SkillIndexDoc[]> }> = [
    { id: 'topagentskills', run: () => harvestTopagentskills(f) },
    { id: 'skillregistry', run: () => harvestSkillregistry(f) },
    { id: 'claude-plugins', run: () => harvestClaudePlugins(f, pages) },
  ];
  const settled = await Promise.allSettled(lanes.map((l) => l.run()));
  if (settled.every((s) => s.status === 'rejected')) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }

  const sources: Record<string, number> = {};
  const byKey = new Map<string, SkillIndexDoc>();
  for (let i = 0; i < lanes.length; i++) {
    const s = settled[i];
    const got = s.status === 'fulfilled' ? s.value : [];
    sources[lanes[i].id] = got.length;
    for (const doc of got) {
      const key = dedupKey(doc);
      const kept = byKey.get(key);
      if (!kept) {
        byKey.set(key, doc);
        continue;
      }
      // Priority (lane order) keeps the earlier row; a later duplicate donates the signals it has more of.
      if (doc.pop !== undefined) kept.pop = Math.max(kept.pop ?? 0, doc.pop);
      if (doc.quality !== undefined && kept.quality === undefined) kept.quality = doc.quality;
    }
  }

  const docs = [...byKey.values()]
    .sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || (b.pop ?? 0) - (a.pop ?? 0))
    .slice(0, maxDocs);

  return { v: 1, builtAt: now, sources, docs };
}
