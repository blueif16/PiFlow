// The CLIENT-SIDE ranker over the bundled skills-index artifact — ONE pure module (NO node imports, no
// fetch, no fs) so the SAME ranking runs in the GUI's browser bundle (direct TS import) and in the CLI's
// 'index' remote source. The artifact itself is built by `skill-index-build.ts` and published as a static
// asset of the Vercel site (`site-piflow/public/skills-index.json`) — the front-end bundle IS the index
// host, per the online-first design: search hits the bundled artifact instantly; the live source fan-out
// is the deep-search fallback for the long tail.
//
// Scoring is BM25-LITE + boosts, tuned for a small (~10k), quality-gated corpus:
//   • text relevance: per-query-token idf (computed over the searched corpus) × tf saturation, with field
//     weights name(3) > slug(2) > description/author(1) — idf + saturation together already make an
//     all-terms match dominate a one-term spammer (pinned by test; no extra coverage lever needed);
//   • popularity (`pop`, stars+installs): a log-scaled MULTIPLIER on the text score — it can reorder
//     text-equal docs but a zero-text doc stays zero (popularity never invents relevance);
//   • quality (0-100, from curated/audited sources): a small additional multiplier, breaking pop ties.

/** One doc in the bundled skills-index artifact. The first six fields mirror `RemoteSkillRow` so a scored
 *  doc feeds every existing marketplace surface (cards, tables, `skill add`) without mapping. */
export interface SkillIndexDoc {
  slug: string;
  name: string;
  description: string;
  /** Installable repo URL (or the best available discovery pointer). */
  source: string;
  author?: string;
  /** Which upstream index the doc was harvested from. */
  index: string;
  /** Popularity signal (stars + installs where the upstream exposes them). */
  pop?: number;
  /** Quality signal 0-100 (curated composite score / audit grade where the upstream exposes one). */
  quality?: number;
}

/** The published artifact envelope. */
export interface SkillIndexArtifact {
  v: 1;
  builtAt: string;
  /** Rows harvested per upstream source id (honest coverage accounting — see the builder's caps). */
  sources: Record<string, number>;
  docs: SkillIndexDoc[];
}

/** Lowercased alphanumeric tokens, length ≥ 2 ('a'/'x' add noise, not signal, on skill names). */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** Occurrences of `token` in `tokens` (exact) plus prefix hits at half weight ('kube' finds 'kubernetes'). */
function tf(token: string, tokens: string[]): number {
  let exact = 0;
  let prefix = 0;
  for (const t of tokens) {
    if (t === token) exact++;
    else if (t.startsWith(token)) prefix++;
  }
  return exact + prefix * 0.5;
}

/**
 * Rank `docs` for `q`, best first, at most `limit` rows. Pure and synchronous — a ~10k-doc corpus scores in
 * single-digit milliseconds, which is what makes search-as-you-type instant in the GUI. An empty/whitespace
 * query returns `[]` (the caller shows its idle hint). Docs with zero text relevance are excluded — the
 * popularity/quality boosts only ever REORDER matching docs.
 */
export function searchSkillIndex(docs: SkillIndexDoc[], q: string, limit = 30): SkillIndexDoc[] {
  const queryTokens = [...new Set(tokenize(q))];
  if (queryTokens.length === 0) return [];

  // Pre-tokenize the fields once per doc; compute per-token document frequency for idf.
  const fields = docs.map((d) => ({
    name: tokenize(d.name),
    slug: tokenize(d.slug),
    rest: tokenize(`${d.description} ${d.author ?? ''}`),
  }));
  const df = new Map<string, number>();
  for (const qt of queryTokens) {
    let n = 0;
    for (const f of fields) {
      if (tf(qt, f.name) > 0 || tf(qt, f.slug) > 0 || tf(qt, f.rest) > 0) n++;
    }
    df.set(qt, n);
  }
  const N = docs.length;

  const scored: Array<{ doc: SkillIndexDoc; score: number }> = [];
  for (let i = 0; i < docs.length; i++) {
    const f = fields[i];
    let text = 0;
    let matched = 0;
    for (const qt of queryTokens) {
      const raw = 3 * tf(qt, f.name) + 2 * tf(qt, f.slug) + tf(qt, f.rest);
      if (raw <= 0) continue;
      matched++;
      const idf = Math.log(1 + (N - (df.get(qt) ?? 0) + 0.5) / ((df.get(qt) ?? 0) + 0.5));
      text += idf * (raw / (raw + 1.2)); // BM25-style tf saturation
    }
    if (matched === 0) continue;
    const pop = 1 + 0.1 * Math.log10(1 + Math.max(0, docs[i].pop ?? 0));
    const quality = 1 + 0.002 * Math.max(0, Math.min(100, docs[i].quality ?? 0));
    scored.push({ doc: docs[i], score: text * pop * quality });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.doc);
}
