// remoteSkillDoc — fetch RICHER detail for an ONLINE marketplace row so its detail panel can show the full
// description + the SKILL.md body + requires/allowed, not just the search-row metadata. A remote row carries
// only { name, description, source, … } (no manifest); the full SKILL.md lives in the source repo. When the
// source is a GitHub repo we fetch its raw SKILL.md STRAIGHT from raw.githubusercontent.com (CORS-open, no
// server hop) and parse it with core's PURE `parseSkillDoc` — the SAME parser the local skill panel uses, so
// a remote card's detail can never disagree with a local one. A non-GitHub source (e.g. a claudskills catalog
// page) yields no candidates ⇒ the panel degrades honestly to the metadata it already has + the source link.
//
// GOTCHA (live-verified): raw.githubusercontent.com omits its CORS header on a 404, so a browser fetch for a
// MISS REJECTS with a network error rather than resolving with status 404 — every candidate attempt is wrapped
// in try/catch, never gated on `res.ok` alone.
import { parseSkillDoc } from "../../../packages/core/src/workflow/ops/skill-manifest";

export interface RemoteSkillDetail {
  /** The frontmatter description (fuller than the search row's, unclamped). */
  description: string;
  /** The SKILL.md markdown body. */
  body: string;
  /** The manifest floor/ceiling (empty when the SKILL.md declares none). */
  requires: string[];
  allowed: string[];
  /** The raw URL the detail was fetched from (provenance shown in the panel). */
  fetchedFrom: string;
}

/** Parse a `github.com/<owner>/<repo>[/(tree|blob)/<branch>/<subdir>]` (or bare `owner/repo`) source. */
function parseGithub(source: string): { owner: string; repo: string; branch?: string; subdir?: string } | null {
  const s = source.trim().replace(/\/+$/, "");
  // A bare `owner/repo` shorthand (what `skill add` expands to a github URL).
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) {
    const [owner, repo] = s.split("/");
    return { owner, repo: repo.replace(/\.git$/, "") };
  }
  const m = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)\/(.*))?$/.exec(s);
  if (!m) return null;
  const [, owner, repo, kind, branch, rest] = m;
  if (!kind) return { owner, repo };
  // A blob link points AT the SKILL.md file; a tree link points at its dir — normalize both to the dir.
  const subdir = kind === "blob" && rest ? rest.replace(/\/?SKILL\.md$/i, "") : (rest ?? "");
  return { owner, repo, branch, subdir };
}

/**
 * Candidate raw SKILL.md URLs for a remote row, most-likely-first — PURE. A `tree`/`blob` link names the exact
 * branch + subdir, so it resolves in ONE try; a bare repo guesses the SKILL.md location (root, `<slug>/`, then
 * `skills/<slug>/` — the CLI's own findCandidates scan order) across the likely default branch (`main`, then
 * `master`), BRANCH-major so the common branch is exhausted before the fallback. A non-GitHub source ⇒ `[]`.
 */
export function remoteRawCandidates(source: string, slug: string): string[] {
  const gh = parseGithub(source);
  if (!gh) return [];
  const { owner, repo, branch, subdir } = gh;
  const raw = (b: string, p: string) => `https://raw.githubusercontent.com/${owner}/${repo}/${b}/${p}`;
  if (branch && subdir !== undefined) {
    return [raw(branch, subdir ? `${subdir}/SKILL.md` : "SKILL.md")];
  }
  const paths = ["SKILL.md", `${slug}/SKILL.md`, `skills/${slug}/SKILL.md`];
  const branches = branch ? [branch] : ["main", "master"];
  const out: string[] = [];
  for (const b of branches) for (const p of paths) out.push(raw(b, p));
  return out;
}

/**
 * Best-effort fetch of a remote skill's full SKILL.md. Tries each candidate URL (each wrapped for the raw-404
 * reject gotcha), and on the first that resolves parses it with core's `parseSkillDoc`. Returns `null` when
 * no candidate resolves (non-GitHub source, private repo, or an unfindable SKILL.md) OR the fetched SKILL.md
 * fails to parse (a broken manifest is display-degraded, not surfaced) — the caller then shows metadata only.
 */
export async function fetchRemoteSkillDoc(source: string, slug: string): Promise<RemoteSkillDetail | null> {
  for (const url of remoteRawCandidates(source, slug)) {
    let raw: string;
    try {
      const res = await fetch(url);
      if (!res.ok) continue; // a CORS-permissive 404 (some hosts do send one) — try the next candidate
      raw = await res.text();
    } catch {
      continue; // raw.githubusercontent.com 404s omit CORS ⇒ fetch rejects — try the next candidate
    }
    try {
      const doc = parseSkillDoc(raw, slug);
      return { description: doc.description, body: doc.body, requires: doc.requires, allowed: doc.allowed, fetchedFrom: url };
    } catch {
      return null; // found the file but its manifest is invalid — degrade to the row's metadata
    }
  }
  return null;
}
