import { describe, it, expect } from 'vitest';
import { pieSlug, pieSlugList } from '../src/names/slugify.js';
import { generateRunName, ADJECTIVES, PIES, type Rng } from '../src/names/generator.js';
import { generateDateSeqName } from '../src/names/date-seq.js';
import { childRunName } from '../src/names/child.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// (C) generateDateSeqName — M1's scalable default: `YYMMDD-NN`, a zero-padded PER-DAY counter scanned
// from `existing` (collision-safe like generateRunName, but deterministic — no RNG). `now` is injected so
// the day-rollover and formatting are asserted exactly, never against the wall clock.
// ─────────────────────────────────────────────────────────────────────────────
describe('generateDateSeqName — scannable YYMMDD-NN run identity (M1)', () => {
  const day = new Date('2026-07-06T09:00:00.000Z'); // UTC ⇒ "260706", hermetic regardless of TZ

  it('mints "YYMMDD-01" for a fresh day with no existing runs', () => {
    expect(generateDateSeqName([], day)).toBe('260706-01');
  });

  it('increments the zero-padded counter when the day already has runs', () => {
    expect(generateDateSeqName(['260706-01'], day)).toBe('260706-02');
    expect(generateDateSeqName(['260706-01', '260706-02'], day)).toBe('260706-03');
  });

  it('a SPARSE existing set is SCANNED (gap-filled), not maxed — the bug this guards is jumping past a hole', () => {
    // "-02" is missing (e.g. a deleted run); the function must not blindly continue from the highest seen.
    expect(generateDateSeqName(['260706-01', '260706-03'], day)).toBe('260706-02');
  });

  it('a DIFFERENT day never collides — day rollover resets the counter to 01', () => {
    // Yesterday's names share no day prefix, so they never block/inflate today's counter.
    expect(generateDateSeqName(['260705-01', '260705-02', '260705-03'], day)).toBe('260706-01');
  });

  it('zero-pads through double digits (the 10th run of the day is "-10", not "-1" or "-010")', () => {
    const nineTaken = Array.from({ length: 9 }, (_, i) => `260706-0${i + 1}`);
    expect(generateDateSeqName(nineTaken, day)).toBe('260706-10');
  });

  it('the minted base name is DOT-FREE (dots are reserved for child-run lineage, M1.4)', () => {
    expect(generateDateSeqName([], day)).not.toContain('.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (D) childRunName — a spawned child's id: `<parent>.<nodeId>`, then `.<n>` from n=2 on a collision
// (mirrors generateRunName's collision-safe contract, just deterministic — the parent+node pair IS the
// disambiguator, no RNG needed).
// ─────────────────────────────────────────────────────────────────────────────
describe('childRunName — <parent>.<nodeId> child-run lineage naming (M1)', () => {
  it('mints "<parent>.<nodeId>" when the pair is unused', () => {
    expect(childRunName('260706-01', 'gameplay', [])).toBe('260706-01.gameplay');
  });

  it('appends ".2" when the base pair already has a child run', () => {
    expect(childRunName('260706-01', 'gameplay', ['260706-01.gameplay'])).toBe('260706-01.gameplay.2');
  });

  it('keeps escalating past further collisions (".2" taken ⇒ ".3")', () => {
    const existing = ['260706-01.gameplay', '260706-01.gameplay.2'];
    expect(childRunName('260706-01', 'gameplay', existing)).toBe('260706-01.gameplay.3');
  });
});
