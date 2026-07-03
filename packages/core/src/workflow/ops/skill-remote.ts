// `searchRemote` — the ONLINE discovery lane: search remote skill indexes so an agent (or human, or the
// GUI's marketplace panel) can find a skill beyond the local rings, then install it with the EXISTING
// `piflowctl skill add <source>`. This module is discovery ONLY — it never installs anything; every row's
// `source` is meant to be fed to `skill add` verbatim. It lives in core (moved from @piflow/cli 2026-07-03)
// so the CLI verb AND the control-plane server share ONE implementation — the ONLINE-FIRST posture: the
// local rings are an offload cache, the live indexes are the catalog.
//
// VERIFIED LIVE FACTS (probed 2026-07-03 against the real APIs — pin these, don't re-assume a nicer shape):
//
//   ClaudSkills (https://claudskills.com/api/v1, REST, CORS-open, no auth):
//     • `GET /skills?limit&offset&category&tag&daily_eligible` — confirmed against `/openapi.json` AND the
//       root discovery doc. There is NO free-text query parameter: `q=`, `search=`, and `query=` are all
//       silently ignored by the live API (the response's `total` never changes, and the row order is stable
//       across them) — and `/search`, `/find`, `/query` all 404. `category`/`tag` are the only real
//       server-side filters (verified: `?tag=lang:python` genuinely narrows `total`).
//     • Because there is no server-side free-text search, `searchClaudskills` PAGINATES `/skills` and
//       filters CLIENT-SIDE over slug/name/description/tags/category — the same posture as the local
//       `skill search`. The catalog is huge (145,336 rows on 2026-07-03, alphabetical-by-slug, unsorted by
//       relevance), so the scan is bounded (`CLAUDSKILLS_MAX_SCAN_PAGES`) to stay fast; a query with no
//       hits in the scanned window returns empty rather than paging through the whole catalog. The FULL
//       catalog ships as a nightly dump at `/data/skills.json` — 93.8MB measured live, too heavy to fetch
//       per-search; a local mirror lane is the follow-up, not this module's job.
//     • `url` is the catalog's OWN detail page (`https://claudskills.com/skills/<slug>/`), NOT a git
//       remote — the API rows expose no origin-repo field (`source_url` exists ONLY in the bulk dump).
//       We map `url` anyway (falling back to `author_url`) as the best available discovery pointer per the
//       row contract — `skill add <source>` against a claudskills row will fail CLEANLY (a git-clone error,
//       not silent corruption). This is a known limitation, not a bug in this module.
//
//   SkillsMP (https://skillsmp.com/api/v1, 50 req/day + 10/min anonymous — kept OUT of the default source
//   list to respect that quota; 500/day with a free key):
//     • `GET /skills/search?q=<text>` DOES filter server-side (confirmed live). `githubUrl` is a repo TREE
//       link (`.../tree/<branch>/<subdir>`); `skill add` clones the repo ROOT then locates the SKILL.md
//       inside (via `--skill <name>` when ambiguous), so `source` is DERIVED as the repo root.
//
//   AgentSkill.sh (https://agentskill.sh/api, no auth, no rate-limit headers observed live):
//     • `GET /api/agent/search?q=<text>` filters server-side → `{ results: [...] }`; the catalog reported
//       274,701 skills live via `GET /api/skills/count` on 2026-07-03 — the widest searchable index probed.
//     • Rows carry `slug` (`owner/name`), `name`, `owner`, `description`, `repositoryUrl`, and
//       `githubOwner`/`githubRepo` — `source` = `repositoryUrl`, falling back to the derived
//       `https://github.com/{githubOwner}/{githubRepo}`. Verified: the derived repo returned 200 on the
//       GitHub API and the row's `githubSha` matched GitHub's blob sha exactly.
//
//   Claude Plugins (https://claude-plugins.dev/api/skills, no auth, no rate-limit headers observed live):
//     • `GET /api/skills?q=<text>&limit=<n>` filters server-side (verified: `total` drops 50,497 → 542 for
//       q=pdf) → `{ skills: [...], total }`. maxPageSize 100.
//     • Rows carry `metadata.repoOwner`/`metadata.repoName` (verified 200 on the GitHub API) → `source` =
//       `https://github.com/{repoOwner}/{repoName}`; `namespace` (`@owner/repo/skill`) is the slug.
//
//   skills.re (https://api.skills.re, no auth, documented OpenAPI at /spec.json — 67 paths, probed live):
//     • `POST /skills/search` with JSON body `{ query }` → `{ page: [...] }` rows of
//       `{ id, slug, title, description }`; 7,457 skills via `GET /skills/count` on 2026-07-03.
//     • Search rows carry NO repo field; the documented resolve step is
//       `GET /cli/skills/resolve-install?skill=<slug>` → `lockEntry.sourceUrl` (verified a real clonable
//       GitHub repo, 200 on the GitHub API). We resolve up to `limit` rows (bounded, no observed rate
//       limit); a failed resolve falls back to the browse page `https://skills.re/skills/<slug>`.
//
//   Top Agent Skills (https://top-agent-skills.com, static Vercel-edge files, no auth, no rate limits):
//     • NO query API — the whole curated catalog (146 skills, ranked by a documented composite quality
//       score) ships as ONE 179KB text file `GET /llms-full.txt`; we fetch it and filter CLIENT-SIDE.
//     • Each block carries `name:`/`slug:`/`score:`/`description:` lines and a
//       `- Source: https://github.com/{owner}/{repo}[/tree/...]` line → `source` = the repo root (verified
//       via the GitHub contents API across two different publishers). Curated + quality-ranked ⇒ FIRST in
//       the default source order.
//
//   Claude Skill Registry / majiayu000 (https://majiayu000.github.io/claude-skill-registry-core/, static
//   GitHub-Pages JSON, no auth; 161,118 deduped skills per its stats.json on 2026-07-03):
//     • NO query API — `search-index-lite.json` (~3.5MB, the top ~5000 rows by relevance) is fetched and
//       filtered CLIENT-SIDE; the full 202,658-record catalog lives in 6 shards behind
//       `search-index-manifest.json` (too heavy per-search — the lite index is the search surface).
//     • Rows carry `repo` (`owner/name`, verified 200 on the GitHub API), `path`, `branch`, and
//       quality/security grades → `source` = `https://github.com/{repo}`. The 3.5MB fetch is why this
//       source is OPT-IN rather than a default.

/** One discoverable remote skill — `source` feeds `piflowctl skill add <source>` verbatim. */
export interface RemoteSkillRow {
  slug: string;
  name: string;
  description: string;
  /** Installable: a repo URL (or `owner/repo`) for `skill add`. See the ClaudSkills caveat above — not
   *  every index's `source` is a VERIFIED git remote; unverified ones are documented at the mapping site. */
  source: string;
  author?: string;
  /** Which index this row came from (`'topagentskills' | 'agentskill' | 'claude-plugins' | 'claudskills'
   *  | 'skills-re' | 'skillsmp' | 'skillregistry'`). */
  index: string;
}

/** Inputs to `searchRemote`. All optional; `fetchImpl` is the network seam (default `globalThis.fetch`). */
export interface SearchRemoteOpts {
  fetchImpl?: typeof fetch;
  /** Which indexes to query, in order, until `limit` rows are collected. Default `DEFAULT_SOURCES`. */
  sources?: string[];
  /** Max rows to return across all queried sources. Default 20. */
  limit?: number;
}

const DEFAULT_LIMIT = 20;
/** Quality-first, then breadth: the curated ranked 146 → the 274k searchable giant → the 50k searchable
 *  index → the 145k client-filtered brand. SkillsMP (50/day quota), skills.re (per-row resolve calls) and
 *  skillregistry (3.5MB static fetch) are OPT-IN via `sources`. */
const DEFAULT_SOURCES = ['topagentskills', 'agentskill', 'claude-plugins', 'claudskills'];

/** One source module's contract: search for `q`, returning at most `limit` mapped rows. */
interface RemoteSource {
  search(q: string, opts: { fetchImpl?: typeof fetch; limit: number }): Promise<RemoteSkillRow[]>;
}

// ── ClaudSkills ──────────────────────────────────────────────────────────────────────────────────────
const CLAUDSKILLS_BASE = 'https://claudskills.com/api/v1';
/** The API's own documented max (`/openapi.json`: `limit` schema max 200). */
const CLAUDSKILLS_PAGE_SIZE = 200;
/** Bounded scan depth (see the header note: no server-side free-text filter to rely on instead). */
const CLAUDSKILLS_MAX_SCAN_PAGES = 10;

/** The `Skill` shape per `/openapi.json` (`required: [slug, name, url]`; everything else optional). */
interface ClaudskillsRow {
  slug: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  author?: string | null;
  author_url?: string | null;
  url: string;
}
interface ClaudskillsPage {
  data: ClaudskillsRow[];
  next: string | null;
  total: number;
  limit: number;
  offset: number;
}

function claudskillsMatches(r: ClaudskillsRow, needle: string): boolean {
  const hay = [r.slug, r.name, r.description ?? '', r.category ?? '', ...(r.tags ?? [])].join(' ').toLowerCase();
  return hay.includes(needle);
}

/** Map one ClaudSkills row. `undefined` when NEITHER `url` nor `author_url` gives even a discovery
 *  pointer (a row this bare isn't worth surfacing). See the header note on the UNVERIFIED source mapping. */
function mapClaudskillsRow(r: ClaudskillsRow): RemoteSkillRow | undefined {
  const source = r.url || r.author_url || '';
  if (!source) return undefined;
  return {
    slug: r.slug,
    name: r.name,
    description: r.description ?? '',
    source,
    author: r.author ?? undefined,
    index: 'claudskills',
  };
}

async function searchClaudskills(
  q: string,
  { fetchImpl, limit }: { fetchImpl?: typeof fetch; limit: number },
): Promise<RemoteSkillRow[]> {
  const f = fetchImpl ?? fetch;
  const needle = q.toLowerCase();
  // Fire the whole bounded page window CONCURRENTLY — the sequential scan cost ~11s wall-clock live
  // (10 round trips); concurrent it is one. A page past the catalog end returns an empty body (harmless),
  // a single dead page degrades to empty (page order preserved); ALL pages dead throws the first failure.
  const settled = await Promise.allSettled(
    Array.from({ length: CLAUDSKILLS_MAX_SCAN_PAGES }, (_, page) => {
      const offset = page * CLAUDSKILLS_PAGE_SIZE;
      return f(`${CLAUDSKILLS_BASE}/skills?limit=${CLAUDSKILLS_PAGE_SIZE}&offset=${offset}`).then(async (res) => {
        if (!res.ok) throw new Error(`claudskills: search request failed (HTTP ${res.status})`);
        return (await res.json()) as ClaudskillsPage;
      });
    }),
  );
  if (settled.every((s) => s.status === 'rejected')) throw (settled[0] as PromiseRejectedResult).reason;

  const rows: RemoteSkillRow[] = [];
  for (const s of settled) {
    if (rows.length >= limit) break;
    if (s.status !== 'fulfilled') continue;
    for (const r of s.value.data ?? []) {
      if (rows.length >= limit) break;
      if (!claudskillsMatches(r, needle)) continue;
      const mapped = mapClaudskillsRow(r);
      if (mapped) rows.push(mapped);
    }
  }
  return rows;
}

// ── SkillsMP ─────────────────────────────────────────────────────────────────────────────────────────
const SKILLSMP_BASE = 'https://skillsmp.com/api/v1';

interface SkillsmpRow {
  id: string;
  name: string;
  author?: string;
  description?: string;
  githubUrl: string;
}
interface SkillsmpResponse {
  success: boolean;
  data?: { skills: SkillsmpRow[] };
}

/** `.../tree/<branch>/<subdir>` → the clonable repo root `https://github.com/<owner>/<repo>`.
 *  `undefined` when `githubUrl` doesn't match the expected github.com/owner/repo/... shape. */
function repoRootFromGithubTreeUrl(url: string): string | undefined {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/|$)/.exec(url);
  return m ? `https://github.com/${m[1]}/${m[2]}` : undefined;
}

function mapSkillsmpRow(r: SkillsmpRow): RemoteSkillRow | undefined {
  const source = repoRootFromGithubTreeUrl(r.githubUrl) ?? r.githubUrl;
  if (!source) return undefined;
  return { slug: r.id, name: r.name, description: r.description ?? '', source, author: r.author, index: 'skillsmp' };
}

async function searchSkillsmp(
  q: string,
  { fetchImpl, limit }: { fetchImpl?: typeof fetch; limit: number },
): Promise<RemoteSkillRow[]> {
  const f = fetchImpl ?? fetch;
  const res = await f(`${SKILLSMP_BASE}/skills/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`skillsmp: search request failed (HTTP ${res.status})`);
  const body = (await res.json()) as SkillsmpResponse;
  if (!body.success) throw new Error('skillsmp: search request unsuccessful');
  const rows: RemoteSkillRow[] = [];
  for (const r of body.data?.skills ?? []) {
    if (rows.length >= limit) break;
    const mapped = mapSkillsmpRow(r);
    if (mapped) rows.push(mapped);
  }
  return rows;
}

// ── AgentSkill.sh ────────────────────────────────────────────────────────────────────────────────────
const AGENTSKILL_BASE = 'https://agentskill.sh/api';

interface AgentskillRow {
  slug: string;
  name: string;
  owner?: string;
  description?: string;
}
interface AgentskillResponse {
  results?: AgentskillRow[];
}
/** `GET /api/skills/{slug}` — the ONLY place agentskill exposes the repo (live-verified 2026-07-03: search
 *  rows carry NO repositoryUrl/githubOwner/githubRepo at all; the earlier probe conflated the two shapes). */
interface AgentskillDetailResponse {
  data?: { repositoryUrl?: string; githubOwner?: string; githubRepo?: string };
}

async function searchAgentskill(
  q: string,
  { fetchImpl, limit }: { fetchImpl?: typeof fetch; limit: number },
): Promise<RemoteSkillRow[]> {
  const f = fetchImpl ?? fetch;
  const res = await f(`${AGENTSKILL_BASE}/agent/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`agentskill: search request failed (HTTP ${res.status})`);
  const body = (await res.json()) as AgentskillResponse;
  // Resolve the repo via the per-row detail endpoint, CONCURRENTLY (a serial N+1 here made the whole
  // default fan-out crawl). `repositoryUrl` wins; else derive the github root. A failed/repo-less resolve
  // DROPS that row — we never invent a browse URL agentskill has not published, and one dead detail must
  // not kill the whole search.
  const kept = (body.results ?? []).slice(0, limit);
  const resolved = await Promise.all(
    kept.map(async (r): Promise<RemoteSkillRow | undefined> => {
      try {
        const dr = await f(`${AGENTSKILL_BASE}/skills/${encodeURIComponent(r.slug)}`);
        if (!dr.ok) return undefined;
        const detail = ((await dr.json()) as AgentskillDetailResponse).data;
        const source =
          detail?.repositoryUrl ||
          (detail?.githubOwner && detail?.githubRepo
            ? `https://github.com/${detail.githubOwner}/${detail.githubRepo}`
            : '');
        if (!source) return undefined;
        return {
          slug: r.slug,
          name: r.name,
          description: r.description ?? '',
          source,
          author: r.owner,
          index: 'agentskill',
        };
      } catch {
        return undefined;
      }
    }),
  );
  return resolved.filter((r): r is RemoteSkillRow => r !== undefined);
}

// ── Claude Plugins (claude-plugins.dev) ──────────────────────────────────────────────────────────────
const CLAUDE_PLUGINS_BASE = 'https://claude-plugins.dev/api';
/** The API's observed max page size (probed live). */
const CLAUDE_PLUGINS_MAX_LIMIT = 100;

interface CludePluginsRow {
  id: string;
  name: string;
  namespace?: string;
  description?: string;
  author?: string;
  sourceUrl?: string;
  metadata?: { repoOwner?: string; repoName?: string; directoryPath?: string };
}
interface ClaudePluginsResponse {
  skills?: CludePluginsRow[];
  total?: number;
}

/** Map one claude-plugins.dev row: the repo root from `metadata.repoOwner`/`repoName` (verified clonable);
 *  falls back to the repo root derived from `sourceUrl` (a tree link). `undefined` when neither resolves. */
function mapClaudePluginsRow(r: CludePluginsRow): RemoteSkillRow | undefined {
  const source =
    r.metadata?.repoOwner && r.metadata?.repoName
      ? `https://github.com/${r.metadata.repoOwner}/${r.metadata.repoName}`
      : r.sourceUrl
        ? repoRootFromGithubTreeUrl(r.sourceUrl)
        : undefined;
  if (!source) return undefined;
  return {
    slug: r.namespace ?? r.name,
    name: r.name,
    description: r.description ?? '',
    source,
    author: r.author,
    index: 'claude-plugins',
  };
}

async function searchClaudePlugins(
  q: string,
  { fetchImpl, limit }: { fetchImpl?: typeof fetch; limit: number },
): Promise<RemoteSkillRow[]> {
  const f = fetchImpl ?? fetch;
  const pageLimit = Math.min(limit, CLAUDE_PLUGINS_MAX_LIMIT);
  const res = await f(`${CLAUDE_PLUGINS_BASE}/skills?q=${encodeURIComponent(q)}&limit=${pageLimit}`);
  if (!res.ok) throw new Error(`claude-plugins: search request failed (HTTP ${res.status})`);
  const body = (await res.json()) as ClaudePluginsResponse;
  const rows: RemoteSkillRow[] = [];
  for (const r of body.skills ?? []) {
    if (rows.length >= limit) break;
    const mapped = mapClaudePluginsRow(r);
    if (mapped) rows.push(mapped);
  }
  return rows;
}

// ── skills.re ────────────────────────────────────────────────────────────────────────────────────────
const SKILLS_RE_BASE = 'https://api.skills.re';

interface SkillsReSearchRow {
  id?: string;
  slug: string;
  title?: string;
  description?: string;
}
interface SkillsReSearchResponse {
  page?: SkillsReSearchRow[];
}
interface SkillsReResolveResponse {
  lockEntry?: { sourceUrl?: string };
}

async function searchSkillsRe(
  q: string,
  { fetchImpl, limit }: { fetchImpl?: typeof fetch; limit: number },
): Promise<RemoteSkillRow[]> {
  const f = fetchImpl ?? fetch;
  const res = await f(`${SKILLS_RE_BASE}/skills/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  if (!res.ok) throw new Error(`skills-re: search request failed (HTTP ${res.status})`);
  const body = (await res.json()) as SkillsReSearchResponse;
  // Search rows carry no repo field (see the header): resolve each kept row via the documented
  // resolve-install endpoint, CONCURRENTLY (bounded by `limit`); a failed resolve degrades to the
  // browse page — discovery must not fail on one row's resolve.
  const kept = (body.page ?? []).slice(0, limit);
  return Promise.all(
    kept.map(async (r): Promise<RemoteSkillRow> => {
      let source = `https://skills.re/skills/${r.slug}`;
      try {
        const rr = await f(`${SKILLS_RE_BASE}/cli/skills/resolve-install?skill=${encodeURIComponent(r.slug)}`);
        if (rr.ok) {
          const resolved = (await rr.json()) as SkillsReResolveResponse;
          if (resolved.lockEntry?.sourceUrl) source = resolved.lockEntry.sourceUrl;
        }
      } catch {
        /* degrade to the browse page */
      }
      return { slug: r.slug, name: r.title ?? r.slug, description: r.description ?? '', source, index: 'skills-re' };
    }),
  );
}

// ── Top Agent Skills (curated, quality-ranked, static) ──────────────────────────────────────────────
const TOPAGENTSKILLS_CATALOG_URL = 'https://top-agent-skills.com/llms-full.txt';

/** Parse the llms-full.txt bulk file into rows: blocks are separated by `---` lines; each skill block
 *  carries `name:`/`slug:`/`description:`/`publisher:` fields and a `- Source: <github url>` line. */
function parseTopagentskillsCatalog(text: string): RemoteSkillRow[] {
  // The REAL file shape (live-verified 2026-07-03): each skill is a `---`-fenced FRONTMATTER segment
  // (`name:`/`slug:`/`publisher:`/`canonical:` — NO description field) followed by one-or-more BODY
  // segments (a `# <name>` heading, a prose description line, install snippets, and a Metadata list whose
  // `- Source: <github url>` names the repo — present on ~102/146 skills). A skill without a Source line
  // falls back to its `canonical:` page (browsable, still a discovery pointer).
  const segments = text.split(/^---$/m);
  const rows: RemoteSkillRow[] = [];
  for (let i = 0; i < segments.length; i++) {
    const fm = segments[i];
    const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim();
    const slug = /^slug:\s*(.+)$/m.exec(fm)?.[1]?.trim();
    if (!name || !slug) continue;
    const publisher = /^publisher:\s*(.+)$/m.exec(fm)?.[1]?.trim();
    const canonical = /^canonical:\s*(\S+)$/m.exec(fm)?.[1]?.trim();

    // The body = every following segment up to (not including) the next frontmatter segment.
    let body = '';
    for (let j = i + 1; j < segments.length; j++) {
      if (/^name:\s*.+$/m.test(segments[j]) && /^slug:\s*.+$/m.test(segments[j])) break;
      body += segments[j];
    }

    // Description = the first prose line of the body (skip headings, fences, lists, quotes, emphasis-only).
    const description =
      body
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !/^(#|```|-|>|_|\||\*)/.test(l)) ?? '';

    const sourceLine = /^-\s*Source:\s*(\S+)/m.exec(body)?.[1]?.trim();
    const source = sourceLine ? (repoRootFromGithubTreeUrl(sourceLine) ?? sourceLine) : canonical;
    if (!source) continue;
    rows.push({ slug, name, description, source, author: publisher, index: 'topagentskills' });
  }
  return rows;
}

async function searchTopagentskills(
  q: string,
  { fetchImpl, limit }: { fetchImpl?: typeof fetch; limit: number },
): Promise<RemoteSkillRow[]> {
  const f = fetchImpl ?? fetch;
  const res = await f(TOPAGENTSKILLS_CATALOG_URL);
  if (!res.ok) throw new Error(`topagentskills: catalog fetch failed (HTTP ${res.status})`);
  const needle = q.toLowerCase();
  const all = parseTopagentskillsCatalog(await res.text());
  return all
    .filter((r) => [r.slug, r.name, r.description].join(' ').toLowerCase().includes(needle))
    .slice(0, limit);
}

// ── Claude Skill Registry (majiayu000, static lite index — OPT-IN: ~3.5MB per fetch) ────────────────
const SKILLREGISTRY_LITE_URL = 'https://majiayu000.github.io/claude-skill-registry-core/search-index-lite.json';

interface SkillregistryRow {
  id?: string;
  name: string;
  description?: string;
  repo?: string;
  owner?: string;
  tags?: string[];
}

async function searchSkillregistry(
  q: string,
  { fetchImpl, limit }: { fetchImpl?: typeof fetch; limit: number },
): Promise<RemoteSkillRow[]> {
  const f = fetchImpl ?? fetch;
  const res = await f(SKILLREGISTRY_LITE_URL);
  if (!res.ok) throw new Error(`skillregistry: index fetch failed (HTTP ${res.status})`);
  const body = (await res.json()) as SkillregistryRow[] | { skills?: SkillregistryRow[]; rows?: SkillregistryRow[] };
  const list = Array.isArray(body) ? body : (body.skills ?? body.rows ?? []);
  const needle = q.toLowerCase();
  const rows: RemoteSkillRow[] = [];
  for (const r of list) {
    if (rows.length >= limit) break;
    if (!r.repo) continue; // no repo ⇒ nothing installable to point at
    const hay = [r.name, r.description ?? '', ...(r.tags ?? [])].join(' ').toLowerCase();
    if (!hay.includes(needle)) continue;
    rows.push({
      slug: r.id ?? r.name,
      name: r.name,
      description: r.description ?? '',
      source: `https://github.com/${r.repo}`,
      author: r.owner,
      index: 'skillregistry',
    });
  }
  return rows;
}

const SOURCES: Record<string, RemoteSource> = {
  topagentskills: { search: searchTopagentskills },
  agentskill: { search: searchAgentskill },
  'claude-plugins': { search: searchClaudePlugins },
  claudskills: { search: searchClaudskills },
  'skills-re': { search: searchSkillsRe },
  skillsmp: { search: searchSkillsmp },
  skillregistry: { search: searchSkillregistry },
};

/** The registered remote index ids, in the order they'd be tried by default-like usage. */
export function remoteSourceIds(): string[] {
  return Object.keys(SOURCES);
}

/** Cross-source dedup key: the same skill surfaced by two indexes shares a name + normalized repo URL
 *  (slugs differ per index — `anthropics/docx` vs `docx` — so the name is the comparable half). */
function dedupKey(r: RemoteSkillRow): string {
  const src = r.source
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  return `${r.name.toLowerCase()}|${src}`;
}

/**
 * Search remote skill indexes for `q`, returning at most `limit` rows. Default sources (in fill order):
 * `topagentskills` (curated, quality-ranked) → `agentskill` (274k, server-side search) → `claude-plugins`
 * (50k, server-side search) → `claudskills` (145k, bounded client scan). `skillsmp` (anon quota),
 * `skills-re` (per-row resolves) and `skillregistry` (3.5MB static index) are OPT-IN via `sources`.
 * Rows from earlier sources fill `limit` before later sources are queried; duplicate rows (same
 * name + repo across indexes) are dropped, keeping the earlier source's row. Throws on an unknown source
 * id, an HTTP error, or a network failure — the caller (CLI verb / server handler) is responsible for
 * turning that into a clean one-line message (never a stack trace).
 */
export async function searchRemote(q: string, opts: SearchRemoteOpts = {}): Promise<RemoteSkillRow[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`searchRemote: limit must be a positive integer (got ${opts.limit})`);
  }
  const ids = opts.sources ?? DEFAULT_SOURCES;
  // Validate EVERY id before firing anything — an unknown id is caller error, not a degraded source.
  for (const id of ids) {
    if (!SOURCES[id]) throw new Error(`searchRemote: unknown source '${id}' (known: ${Object.keys(SOURCES).sort().join(', ')})`);
  }

  // Fire ALL sources CONCURRENTLY (wall-clock is the contract — a sequential fill made the GUI's live
  // search feel dead), then fill in priority order with cross-source dedup. Each source is asked for the
  // full `limit` (we can't know the earlier sources' yield before they resolve; the trim happens here).
  const settled = await Promise.allSettled(
    ids.map((id) => SOURCES[id].search(q, { fetchImpl: opts.fetchImpl, limit })),
  );

  const rows: RemoteSkillRow[] = [];
  const seen = new Set<string>();
  for (const s of settled) {
    if (rows.length >= limit) break;
    if (s.status !== 'fulfilled') continue; // a dead source degrades; the healthy ones still answer
    for (const r of s.value) {
      if (rows.length >= limit) break;
      const key = dedupKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
  }

  // No rows AND at least one failure ⇒ surface the first failure — an all-dead (or lone-source-dead)
  // search must not masquerade as "no skills match".
  const firstFailure = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult | undefined;
  if (rows.length === 0 && firstFailure) throw firstFailure.reason;
  return rows;
}
