import { describe, it, expect } from 'vitest';
import { pieSlug, pieSlugList } from '../src/names/slugify.js';
import { generateRunName, ADJECTIVES, PIES, type Rng } from '../src/names/generator.js';

// ─────────────────────────────────────────────────────────────────────────────
// (A) SLUGIFIER — the single rule that derives pies.json from named_pie_versions.csv. Assert EXACT slugs
// on the tricky rows the design calls out: diacritics/ligatures, a trailing "pie"/"tart" to drop, and
// single-word exotics to KEEP whole. A test here FAILS the moment the slug rule regresses (e.g. someone
// stops folding diacritics, or strips the wrong trailing word), which would silently corrupt pies.json.
// ─────────────────────────────────────────────────────────────────────────────
describe('pieSlug — the CSV name → slug rule', () => {
  it('drops a trailing "pie"/"tart"/"flan" when a meaningful remainder survives', () => {
    expect(pieSlug('Apple pie')).toBe('apple');
    expect(pieSlug('Banoffee pie')).toBe('banoffee');
    expect(pieSlug('Pecan pie')).toBe('pecan');
    expect(pieSlug('Bakewell tart')).toBe('bakewell');
    expect(pieSlug('Butter tart')).toBe('butter');
  });

  it('keeps a single-word exotic WHOLE (nothing meaningful left if the only word were dropped)', () => {
    expect(pieSlug('Quiche')).toBe('quiche');
    expect(pieSlug('Empanada')).toBe('empanada');
    expect(pieSlug('Pirog')).toBe('pirog');
    expect(pieSlug('Burek')).toBe('burek');
    // a bare "Pie"/"Tart" has no remainder ⇒ NOT dropped (the rule only cuts when a word survives).
    expect(pieSlug('Pie')).toBe('pie');
  });

  it('folds diacritics + ligatures to plain ASCII (ü→u, è→e, æ→ae, ø→o, ç→c, å→a, ş→s, …)', () => {
    expect(pieSlug('Tourtière')).toBe('tourtiere');
    expect(pieSlug('Bündner Nusstorte')).toBe('bundner-nusstorte');
    expect(pieSlug('Wähe')).toBe('wahe');
    // synthetic coverage for the explicit ligature/diacritic table.
    expect(pieSlug('Æbleskiver')).toBe('aebleskiver');
    expect(pieSlug('Gâteau Pithivière')).toBe('gateau-pithiviere');
    expect(pieSlug('Smørbrød')).toBe('smorbrod');
  });

  it('hyphenates spaces + apostrophes, collapses repeats, trims edges', () => {
    expect(pieSlug("Shepherd's pie")).toBe('shepherd-s');
    expect(pieSlug('Bacon and egg pie')).toBe('bacon-and-egg');
    expect(pieSlug('  Spiced   Apple  ')).toBe('spiced-apple');
  });

  it('pieSlugList dedupes + sorts (two names that slug the same collapse to one)', () => {
    const out = pieSlugList(['Apple pie', 'Apple', 'Banoffee pie', 'Quiche']);
    expect(out).toEqual(['apple', 'banoffee', 'quiche']); // 'Apple pie' and 'Apple' both → 'apple'
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) generateRunName — Docker-style `<adjective>-<pie>` with COLLISION re-pick. The collision test
// injects an RNG that makes the FIRST pick land on a name already in `existing`, then asserts the result
// is a DIFFERENT, non-colliding name. This FAILS if collision-checking is removed (it would return the
// taken name) — the meaningful guard the design asks for.
// ─────────────────────────────────────────────────────────────────────────────
describe('generateRunName — memorable, collision-free run identity', () => {
  it('produces `<adjective>-<pie>` from the two lists', () => {
    const name = generateRunName([], () => 0); // first element of each list
    expect(name).toBe(`${ADJECTIVES[0]}-${PIES[0]}`);
    expect(name).toMatch(/^[a-z0-9-]+-[a-z0-9-]+$/);
  });

  it('RE-PICKS when the first RNG pick collides with an existing name', () => {
    // A scripted RNG: the FIRST two draws select ADJECTIVES[0]+PIES[0] (the taken name); the NEXT two
    // select ADJECTIVES[1]+PIES[1] (a free name). 0 → index 0; a value that maps to index 1 for each list.
    const taken = `${ADJECTIVES[0]}-${PIES[0]}`;
    const draws = [
      0, 0, // pick #1 → ADJECTIVES[0], PIES[0]  == taken  → must re-pick
      1 / ADJECTIVES.length, 1 / PIES.length, // pick #2 → ADJECTIVES[1], PIES[1] == free
    ];
    let i = 0;
    const rng: Rng = () => draws[i++] ?? 0;

    const name = generateRunName([taken], rng);
    expect(name).not.toBe(taken); // the bug: returning the colliding `taken` would fail here
    expect(name).toBe(`${ADJECTIVES[1]}-${PIES[1]}`);
  });

  it('never returns a name in `existing` even when the RNG is pathological (always index 0)', () => {
    // RNG always 0 ⇒ every plain pick is the same taken name; the function MUST escape via a suffix.
    const taken = `${ADJECTIVES[0]}-${PIES[0]}`;
    const name = generateRunName([taken], () => 0);
    expect(name).not.toBe(taken);
    expect(name.startsWith(taken)).toBe(true); // a `<taken>-N` suffix escape, still memorable
  });
});
