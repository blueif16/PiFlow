// ─────────────────────────────────────────────────────────────────────────────
// pieSlug — turn a raw pie name (the `named_pie_versions.csv` `name` column) into a clean, URL-safe
// slug for the Docker-style `<bake-adjective>-<pie>` run name (e.g. "Banoffee pie" → "banoffee").
//
// This is the SINGLE source of the slug rule: the committed generator (generate-pies.mjs) imports it to
// materialize pies.json from the CSV, and the unit test asserts it on tricky rows — so the data file is
// always reproducible from this one function. PURE: a name in, a slug out, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

// Generic trailing words to DROP when a meaningful remainder is left (so "Apple pie" → "apple" but a
// single-word exotic like "Quiche" is kept whole — we only strip when something survives the cut).
const TRAILING_GENERIC = new Set(['pie', 'tart', 'flan']);

// Diacritic/ligature folding to ASCII. `String.normalize('NFD')` + stripping combining marks handles the
// accented LATIN letters (é→e, ü→u, è→e, ç→c, å→a, ş→s, ă→a, ē→e, ô→o, î→i, ñ→n, à→a, â→a, ø→o…); the few
// LIGATURES that NFD does NOT decompose (æ, œ, ß) are expanded explicitly first.
const LIGATURES: Array<[RegExp, string]> = [
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
  [/ß/g, 'ss'],
  [/ø/g, 'o'], // ø has no NFD decomposition (the stroke is part of the base letter)
  [/đ/g, 'd'],
  [/ł/g, 'l'],
];

/** Fold diacritics + ligatures → plain lowercase ASCII letters (everything else handled by NFD). */
function foldDiacritics(s: string): string {
  let out = s;
  for (const [re, rep] of LIGATURES) out = out.replace(re, rep);
  // NFD splits a base letter from its combining marks; strip the marks (U+0300–U+036F).
  return out.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Slugify ONE pie name → `<lowercase-hyphenated>` per the design rule:
 *   1. lowercase + fold diacritics/ligatures (ü→u, è→e, æ→ae, ø→o, …);
 *   2. apostrophes/whitespace/punctuation → a single hyphen, collapse repeats, trim edge hyphens;
 *   3. drop a TRAILING generic word (pie/tart/flan) ONLY when a meaningful remainder survives
 *      ("Apple pie"→apple, "Bakewell tart"→bakewell), keeping single-word exotics whole
 *      ("Quiche"→quiche, "Empanada"→empanada, "Tourtière"→tourtiere, "Pirog"→pirog).
 * Returns '' only for an input with no slug-able characters (the caller drops empties).
 */
export function pieSlug(name: string): string {
  const folded = foldDiacritics(name.toLowerCase());
  // any run of non-[a-z0-9] (spaces, apostrophes, slashes, punctuation) → one hyphen; trim edges.
  const base = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) return '';

  const parts = base.split('-');
  // drop a trailing generic word only if a meaningful (non-empty) remainder is left.
  if (parts.length > 1 && TRAILING_GENERIC.has(parts[parts.length - 1])) {
    parts.pop();
  }
  return parts.join('-');
}

/**
 * Slugify a whole list of pie names → the DEDUPED, sorted slug list (the pies.json payload). Empties
 * (a name with no slug-able chars) are dropped; first occurrence wins on a collision, but the result is
 * sorted for a stable, diff-friendly data file.
 */
export function pieSlugList(names: string[]): string[] {
  const seen = new Set<string>();
  for (const n of names) {
    const slug = pieSlug(n);
    if (slug) seen.add(slug);
  }
  return [...seen].sort();
}
