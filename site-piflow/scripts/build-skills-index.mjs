// Build `public/skills-index.json` — the BUNDLED marketplace index the deployed site serves at
// /skills-index.json (the GUI searches it client-side instantly; piflowctl's 'index' source fetches it).
// Runs in `prebuild` on EVERY Vercel deploy, so each deploy ships a fresh snapshot; the scheduled
// `.github/workflows/skills-index.yml` pokes a deploy hook twice a day for freshness between pushes.
//
// STANDALONE by necessity: site-piflow lives OUTSIDE the pnpm workspace (own npm lockfile), so this script
// cannot import @piflow/core. It MIRRORS core's `skill-index-build.ts` harvest exactly, and the monorepo's
// `packages/core/test/skill-index-site-parity.test.ts` runs BOTH against the same fixtures and diffs the
// artifacts — edit either implementation and the parity gate goes red until the other matches.
//
// FAIL-OPEN: a dead harvest logs loudly and exits 0 WITHOUT writing — the site still deploys, the GUI
// degrades to the live source fan-out (its built-in fallback). A partial harvest (some lanes dead) writes
// what it got, with honest per-source counts.

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY_LITE_URL = 'https://majiayu000.github.io/claude-skill-registry-core/search-index-lite.json';
const TOPAGENTSKILLS_URL = 'https://top-agent-skills.com/llms-full.txt';
const CLAUDE_PLUGINS_BASE = 'https://claude-plugins.dev/api';
const MAX_DESCRIPTION = 200;

const truncate = (s) => (s.length > MAX_DESCRIPTION ? `${s.slice(0, MAX_DESCRIPTION - 1)}…` : s);

/** `.../tree/<branch>/<subdir>` → the clonable repo root (mirrors core's repoRootFromGithubTreeUrl). */
function repoRootFromGithubTreeUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/|$)/.exec(url);
  return m ? `https://github.com/${m[1]}/${m[2]}` : undefined;
}

/** Mirrors core's parseTopagentskillsCatalog (frontmatter/body split on `---` segments). */
function parseTopagentskills(text) {
  const segments = text.split(/^---$/m);
  const rows = [];
  for (let i = 0; i < segments.length; i++) {
    const fm = segments[i];
    const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim();
    const slug = /^slug:\s*(.+)$/m.exec(fm)?.[1]?.trim();
    if (!name || !slug) continue;
    const publisher = /^publisher:\s*(.+)$/m.exec(fm)?.[1]?.trim();
    const canonical = /^canonical:\s*(\S+)$/m.exec(fm)?.[1]?.trim();
    const scoreRaw = /^score:\s*(\d+(?:\.\d+)?)$/m.exec(fm)?.[1];
    const quality = scoreRaw !== undefined ? Number(scoreRaw) : undefined;

    let body = '';
    for (let j = i + 1; j < segments.length; j++) {
      if (/^name:\s*.+$/m.test(segments[j]) && /^slug:\s*.+$/m.test(segments[j])) break;
      body += segments[j];
    }
    const description =
      body
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !/^(#|```|-|>|_|\||\*)/.test(l)) ?? '';
    const sourceLine = /^-\s*Source:\s*(\S+)/m.exec(body)?.[1]?.trim();
    const source = sourceLine ? (repoRootFromGithubTreeUrl(sourceLine) ?? sourceLine) : canonical;
    if (!source) continue;
    rows.push({
      slug,
      name,
      description: truncate(description),
      source,
      author: publisher,
      index: 'topagentskills',
      ...(quality !== undefined ? { quality } : {}),
    });
  }
  return rows;
}

async function harvestTopagentskills(f) {
  const res = await f(TOPAGENTSKILLS_URL);
  if (!res.ok) throw new Error(`topagentskills: catalog fetch failed (HTTP ${res.status})`);
  return parseTopagentskills(await res.text());
}

async function harvestSkillregistry(f) {
  const res = await f(REGISTRY_LITE_URL);
  if (!res.ok) throw new Error(`skillregistry: index fetch failed (HTTP ${res.status})`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : (body.skills ?? body.rows ?? []);
  const docs = [];
  for (const r of list) {
    if (!r.repo) continue;
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

async function harvestClaudePlugins(f, pages) {
  const docs = [];
  for (let page = 0; page < pages; page++) {
    const res = await f(`${CLAUDE_PLUGINS_BASE}/skills?limit=100&offset=${page * 100}`);
    if (!res.ok) throw new Error(`claude-plugins: page fetch failed (HTTP ${res.status})`);
    const body = await res.json();
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

function dedupKey(d) {
  const src = d.source
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  return `${d.name.toLowerCase()}|${src}`;
}

/** The artifact builder — parameter-for-parameter the mirror of core's `buildSkillIndex` (parity-gated). */
export async function buildSkillIndex(opts = {}) {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date().toISOString();
  const pages = opts.claudePluginsPages ?? 30;
  const maxDocs = opts.maxDocs ?? 12_000;

  const lanes = [
    { id: 'topagentskills', run: () => harvestTopagentskills(f) },
    { id: 'skillregistry', run: () => harvestSkillregistry(f) },
    { id: 'claude-plugins', run: () => harvestClaudePlugins(f, pages) },
  ];
  const settled = await Promise.allSettled(lanes.map((l) => l.run()));
  if (settled.every((s) => s.status === 'rejected')) throw settled[0].reason;

  const sources = {};
  const byKey = new Map();
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
      if (doc.pop !== undefined) kept.pop = Math.max(kept.pop ?? 0, doc.pop);
      if (doc.quality !== undefined && kept.quality === undefined) kept.quality = doc.quality;
    }
  }

  const docs = [...byKey.values()]
    .sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || (b.pop ?? 0) - (a.pop ?? 0))
    .slice(0, maxDocs);

  return { v: 1, builtAt: now, sources, docs };
}

// ── main (prebuild entry) ────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const outFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'skills-index.json');
  try {
    const artifact = await buildSkillIndex();
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(artifact)}\n`, 'utf8');
    const counts = Object.entries(artifact.sources)
      .map(([id, n]) => `${id} ${n}`)
      .join(' · ');
    console.log(`skills-index: ${artifact.docs.length} doc(s) (${counts}) → ${outFile}`);
  } catch (e) {
    // FAIL-OPEN: never kill the site deploy — the GUI degrades to live search when the artifact is absent.
    console.warn(`skills-index: harvest failed (${e instanceof Error ? e.message : e}) — deploying WITHOUT the bundled index; the GUI will fall back to live search.`);
  }
}
