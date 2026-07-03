// `searchRemote` — the ONLINE discovery lane for `piflowctl skill search <q> --remote`: search remote
// skill indexes so an agent (or human) can find a skill beyond the local rings, then install it with the
// EXISTING `skill add <source>`. This module is discovery ONLY — it never installs anything; every row's
// `source` is meant to be fed to `skill add` verbatim.
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
//       `skill search`. The catalog is huge (145k+ rows, alphabetical-by-slug, unsorted by relevance), so
//       the scan is bounded (`CLAUDSKILLS_MAX_SCAN_PAGES`) to stay fast; a query with no hits in the
//       scanned window returns empty rather than paging through the whole catalog.
//     • `url` is the catalog's OWN detail page (`https://claudskills.com/skills/<slug>/`), NOT a git
//       remote — the API exposes no origin-repo field. `author_url` is a GitHub PROFILE, not a repo.
//       Neither is a VERIFIED `skill add`-able source; we map `url` anyway (falling back to `author_url`)
//       as the best available discovery pointer per the row contract — `skill add <source>` against a
//       claudskills row will fail CLEANLY (a git-clone error, not silent corruption), and the human/agent
//       must open the page to find the real repo. This is a known limitation, not a bug in this module.
//
//   SkillsMP (https://skillsmp.com/api/v1, 50 req/day anonymous — kept OUT of the default source list):
//     • `GET /skills/search?q=<text>` DOES filter server-side (confirmed live: distinct queries return
//       distinct, relevant result sets) — a real free-text search, unlike ClaudSkills.
//     • `githubUrl` is a repo TREE link (`.../tree/<branch>/<subdir>`); `skill add` clones the repo ROOT
//       then locates the SKILL.md inside (via `--skill <name>` when ambiguous), so `source` is DERIVED as
//       the `https://github.com/<owner>/<repo>` root, not the deep tree link.

/** One discoverable remote skill — `source` feeds `piflowctl skill add <source>` verbatim. */
export interface RemoteSkillRow {
  slug: string;
  name: string;
  description: string;
  /** Installable: a repo URL (or `owner/repo`) for `skill add`. See the ClaudSkills caveat above — not
   *  every index's `source` is a VERIFIED git remote; unverified ones are documented at the mapping site. */
  source: string;
  author?: string;
  /** Which index this row came from (`'claudskills'` | `'skillsmp'`). */
  index: string;
}

/** Inputs to `searchRemote`. All optional; `fetchImpl` is the network seam (default `globalThis.fetch`). */
export interface SearchRemoteOpts {
  fetchImpl?: typeof fetch;
  /** Which indexes to query, in order, until `limit` rows are collected. Default `['claudskills']`. */
  sources?: string[];
  /** Max rows to return across all queried sources. Default 20. */
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_SOURCES = ['claudskills'];

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
  const rows: RemoteSkillRow[] = [];
  for (let page = 0; page < CLAUDSKILLS_MAX_SCAN_PAGES && rows.length < limit; page++) {
    const offset = page * CLAUDSKILLS_PAGE_SIZE;
    const res = await f(`${CLAUDSKILLS_BASE}/skills?limit=${CLAUDSKILLS_PAGE_SIZE}&offset=${offset}`);
    if (!res.ok) throw new Error(`claudskills: search request failed (HTTP ${res.status})`);
    const body = (await res.json()) as ClaudskillsPage;
    for (const r of body.data ?? []) {
      if (rows.length >= limit) break;
      if (!claudskillsMatches(r, needle)) continue;
      const mapped = mapClaudskillsRow(r);
      if (mapped) rows.push(mapped);
    }
    if (!body.next || !body.data?.length) break;
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

const SOURCES: Record<string, RemoteSource> = {
  claudskills: { search: searchClaudskills },
  skillsmp: { search: searchSkillsmp },
};

/**
 * Search remote skill indexes for `q`, returning at most `limit` rows (default source: ClaudSkills only —
 * SkillsMP is opt-in via `sources: ['skillsmp']`, kept out of the default to respect its 50 req/day anon
 * quota). Rows from earlier sources fill `limit` before later sources are queried. Throws on an unknown
 * source id, an HTTP error, or a network failure — the CLI layer is responsible for turning that into a
 * clean one-line stderr message (never a stack trace).
 */
export async function searchRemote(q: string, opts: SearchRemoteOpts = {}): Promise<RemoteSkillRow[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`searchRemote: limit must be a positive integer (got ${opts.limit})`);
  }
  const ids = opts.sources ?? DEFAULT_SOURCES;
  const rows: RemoteSkillRow[] = [];
  for (const id of ids) {
    if (rows.length >= limit) break;
    const source = SOURCES[id];
    if (!source) throw new Error(`searchRemote: unknown source '${id}' (known: ${Object.keys(SOURCES).sort().join(', ')})`);
    const got = await source.search(q, { fetchImpl: opts.fetchImpl, limit: limit - rows.length });
    rows.push(...got);
  }
  return rows;
}
