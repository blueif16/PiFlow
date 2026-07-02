// _rank.mjs — the OKF slice RANKER: the ONE scoring source for FIND (query → owning card).
//
// Pure, zero-dependency, ZERO side effects (no config read, no argv, no process.exit) — on purpose, so it
// is (a) vendored into any repo's `.agents/okf/` alongside `_generate.mjs`, giving `node _generate.mjs
// --find` standalone ranked retrieval on `node` alone (no piflowctl), and (b) unit-testable in-process.
// NEVER re-implement this scoring in TypeScript: the CLI reader and the optimizer's fixer wire source
// ranking from HERE (via the engine's `--find`), so the two can never drift.

const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const AUTO_START = '<!-- okf:auto-start -->';

/** Tiny YAML subset — scalars + inline `[a, b]` arrays — matching the generator's own parser. */
function parseFrontmatter(fmText) {
  const fm = {};
  for (const line of fmText.split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (v.startsWith('[') && v.endsWith(']')) {
      fm[k] = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      fm[k] = v.replace(/^["']|["']$/g, '');
    }
  }
  return fm;
}

/** Parse one card's text into the ranker card shape. `fallbackKey` (the filename) is used when frontmatter omits `key`. */
export function parseCardForRank(fallbackKey, text) {
  const m = text.match(FM_RE);
  const fm = m ? parseFrontmatter(m[1]) : {};
  const body = m ? m[2] : text;
  const curated = body.split(AUTO_START)[0].trimEnd();
  const str = (v) => (typeof v === 'string' ? v : '');
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    key: str(fm.key) || fallbackKey,
    title: str(fm.title) || fallbackKey,
    resource: str(fm.resource),
    seeds: arr(fm.seeds),
    symbols: arr(fm.symbols),
    aliases: arr(fm.aliases),
    tags: arr(fm.tags),
    curated,
    curatedLower: curated.toLowerCase(),
  };
}

/**
 * Rank cards for `query`, OWNERSHIP over mention (the MODE-A rule): a card that declares the query in its
 * frontmatter (key/resource/seeds/symbols/aliases/tags) scores far above one that merely name-drops it in
 * prose. Deterministic: score desc, ties broken by key asc. Only positive scores are returned (`[]` =
 * uncovered).
 */
export function rankCards(cards, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  // OWNERSHIP score — the frontmatter rungs only (key/symbols/aliases/resource/seeds/tags/title).
  // Kept separate from the prose bonus so the phrase fallback can enforce the law structurally.
  const scoreOwnership = (card, term) => {
    const eq = (s) => s.toLowerCase() === term;
    const has = (s) => s.toLowerCase().includes(term);
    const pathHit = (p) => {
      const pl = p.toLowerCase();
      return pl.includes(term) || term.includes(pl); // a file query may be longer OR shorter than the stored path
    };
    let score = 0;
    if (eq(card.key)) score += 100;
    else if (has(card.key)) score += 50; // partial key (a broader/narrower name)
    if (card.symbols.some(eq)) score += 70;
    else if (card.symbols.some(has)) score += 35;
    if (card.aliases.some(eq)) score += 55;
    else if (card.aliases.some(has)) score += 20;
    if (card.resource && pathHit(card.resource)) score += 60;
    if (card.seeds.some(pathHit)) score += 45;
    if (card.tags.some(eq)) score += 30;
    if (has(card.title)) score += 25;
    return score;
  };
  const proseBonus = (card, term) => (card.curatedLower.includes(term) ? 8 : 0); // WEAK — a bare mention

  let scored = cards
    .map((card) => ({ card, score: scoreOwnership(card, q) + proseBonus(card, q) }))
    .filter((r) => r.score > 0);

  // PHRASE fallback: a natural-language question never matches as one substring, so when the whole
  // query scores nothing, re-score per TOKEN and sum — gated STRUCTURALLY by the ownership law:
  // English glue words ("how", "does", "that") live in every card's PROSE but never in frontmatter,
  // so requiring at least one OWNERSHIP hit neutralizes them with no hardcoded stopword list, and a
  // card grazed only by prose mentions stays uncovered rather than masquerading as an owner.
  if (scored.length === 0) {
    const toks = [...new Set(q.split(/[^a-z0-9_$./-]+/).filter((t) => t.length >= 4))];
    if (toks.length >= 2) {
      scored = cards
        .map((card) => {
          const own = toks.reduce((s, t) => s + scoreOwnership(card, t), 0);
          return { card, score: own > 0 ? own + toks.reduce((s, t) => s + proseBonus(card, t), 0) : 0 };
        })
        .filter((r) => r.score > 0);
    }
  }

  scored.sort((a, b) => b.score - a.score || a.card.key.localeCompare(b.card.key));
  return scored;
}

export { AUTO_START };
