// `piflowctl understand [subsystem] [--check|--rebuild]` — the user-facing front door to the OKF
// code-understanding slices (the `.agents/okf/topics/*.md` cards). It answers "how does <subsystem> work /
// where do I change it" by FINDING the card that OWNS the query, and it keeps the cards honest via the drift
// gate. The name replaces the internal `okf` acronym (a user won't know what OKF means; everyone knows what it
// means to `understand` a subsystem).
//
// THIN over the ENGINE, on purpose: the check/rebuild logic is NOT re-implemented here — it stays in the one
// zero-dependency, system-agnostic `_generate.mjs` script that also backs the pre-commit hook, so the CLI and
// the hook can never drift. This verb only (a) RANKS cards for the reader path and (b) shells to that engine
// for --check/--rebuild. Seeding `.agents/okf/` into a repo that lacks it is a SEPARATE step (not done here) —
// `understand` reports the gap clearly instead of guessing.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const AUTO_START = '<!-- okf:auto-start -->';

/** A parsed slice card: its frontmatter ownership signals + the curated (hand-authored) body. */
export interface Card {
  key: string;
  title: string;
  resource: string; // the one canonical file the card owns ('' if none)
  seeds: string[];
  symbols: string[];
  aliases: string[];
  tags: string[];
  curated: string; // the curated body (below frontmatter, above the auto marker), original case
  curatedLower: string; // ↑ lowercased, for the WEAK prose-mention match
}

/** Tiny YAML subset — scalars + inline `[a, b]` arrays — matching the generator's own parser. */
function parseFrontmatter(fmText: string): Record<string, string | string[]> {
  const fm: Record<string, string | string[]> = {};
  for (const line of fmText.split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (v.startsWith('[') && v.endsWith(']')) {
      fm[k] = v
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      fm[k] = v.replace(/^["']|["']$/g, '');
    }
  }
  return fm;
}

/** Parse one card's text into a `Card`. `fallbackKey` (the filename) is used when frontmatter omits `key`. */
export function parseCard(fallbackKey: string, text: string): Card {
  const m = text.match(FM_RE);
  const fm = m ? parseFrontmatter(m[1]) : {};
  const body = m ? m[2] : text;
  const curated = body.split(AUTO_START)[0].trimEnd();
  const str = (v: string | string[] | undefined): string => (typeof v === 'string' ? v : '');
  const arr = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : []);
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
 * uncovered). Pure — no I/O, so the heart of FIND is unit-testable without a filesystem.
 */
export function rankCards(cards: Card[], query: string): { card: Card; score: number }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  // OWNERSHIP score — the frontmatter rungs only (key/symbols/aliases/resource/seeds/tags/title).
  // Kept separate from the prose bonus so the phrase fallback can enforce the law structurally.
  const scoreOwnership = (card: Card, term: string): number => {
    const eq = (s: string): boolean => s.toLowerCase() === term;
    const has = (s: string): boolean => s.toLowerCase().includes(term);
    const pathHit = (p: string): boolean => {
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
  const proseBonus = (card: Card, term: string): number => (card.curatedLower.includes(term) ? 8 : 0); // WEAK — a bare mention

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

/**
 * Walk up from `startDir` to the `.agents/okf/topics` dir that holds the engine (`_generate.mjs`). Handles
 * both being INSIDE a repo (finds `<ancestor>/.agents/okf/topics`) and cwd already being the topics dir.
 * `null` when no substrate exists anywhere up the tree.
 */
export function resolveTopicsDir(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (path.basename(dir) === 'topics' && existsSync(path.join(dir, '_generate.mjs'))) return dir;
    const nested = path.join(dir, '.agents', 'okf', 'topics');
    if (existsSync(path.join(nested, '_generate.mjs'))) return nested;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve one slice KEY to its curated "how it works" body — the read-at-fix-time dereference of a memory
 * lesson's `[[okf-slice]]` link (piflow-memory-v1.5 §6/§8; pointer + resolve, NEVER a stored copy). Returns the
 * curated body ABOVE the codegraph auto-region (the condensed, hand-authored semantics), or `null` when the
 * repo has no such slice (a dangling pointer). Reuses `parseCard`, so it strips frontmatter + the auto region
 * exactly like the reader — the optimizer inlines this fresh at fix time, so the code-map can never rot.
 */
export function resolveSlice(topicsDir: string, key: string): string | null {
  const p = path.join(topicsDir, `${key}.md`);
  if (!existsSync(p)) return null;
  return parseCard(key, readFileSync(p, 'utf8')).curated || null;
}

/** Load every slice card in `topicsDir` — the `*.md` files, EXCLUDING `_`-prefixed engine files.
 *  EXPORTED for the fixer wire (`findSliceForDefect`) so FIND has ONE loader, never a fork. */
export function loadCards(topicsDir: string): Card[] {
  return readdirSync(topicsDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .sort()
    .map((f) => parseCard(f.replace(/\.md$/, ''), readFileSync(path.join(topicsDir, f), 'utf8')));
}

/** Engine modes the verb can route to — all four live in the ONE `_generate.mjs`. */
export type GateMode = 'check' | 'write' | 'reconcile' | 'owns';

/** The default gate runner: shell to the repo-local engine, inheriting stdio, returning its exit code.
 *  EXPORTED so `memory check` shells to the SAME OKF engine path (no duplicate shell; the two gates can
 *  never drift). */
export function defaultRunGate(mode: GateMode, topicsDir: string, keys: string[]): number {
  const flag = { check: '--check', write: '--write', reconcile: '--reconcile', owns: '--owns' }[mode];
  try {
    execFileSync('node', [path.join(topicsDir, '_generate.mjs'), flag, ...keys], {
      stdio: 'inherit',
      cwd: topicsDir,
    });
    return 0;
  } catch (e) {
    const status = (e as { status?: unknown }).status;
    return typeof status === 'number' ? status : 1;
  }
}

const out = (s: string): void => void process.stdout.write(s);
const err = (s: string): void => void process.stderr.write(s);

/**
 * `piflowctl understand [subsystem] [--check|--rebuild|--reconcile|--owns] [key…]`.
 *   • bare            → list the covered subsystems (the index)
 *   • <subsystem>     → the owning card (Why/how + Anchors + Freshness)
 *   • --check [key…]  → the drift gate (blocks on HEALTH; auto-region staleness is advisory)
 *   • --rebuild [key…]→ regenerate the cards' auto regions (auto-repairs same-file line drift)
 *   • --reconcile     → the post-merge advisory pass (E4 body-hash · E5 impact · coverage rungs)
 *   • --owns <path>   → reverse lookup: which card(s) own this file
 * `deps.runGate` lets tests exercise engine routing without shelling; `deps.cwd` sets the search root.
 */
export async function runUnderstandCli(
  argv: string[],
  deps: {
    cwd?: string;
    runGate?: (mode: GateMode, topicsDir: string, keys: string[]) => number;
  } = {},
): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const doCheck = argv.includes('--check');
  const doRebuild = argv.includes('--rebuild') || argv.includes('--write');
  const doReconcile = argv.includes('--reconcile');
  const doOwns = argv.includes('--owns');
  const positionals = argv.filter((a) => !a.startsWith('-'));

  const topicsDir = resolveTopicsDir(cwd);
  if (!topicsDir) {
    err(
      `piflowctl understand: no .agents/okf/ code map found from ${cwd} (or any parent).\n` +
        `  This repo isn't set up for 'understand' yet — its subsystem slices haven't been seeded.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // MAINTENANCE modes — delegate to the single engine (never re-implemented here).
  if (doCheck || doRebuild || doReconcile || doOwns) {
    const gate = deps.runGate ?? defaultRunGate;
    const mode: GateMode = doCheck ? 'check' : doRebuild ? 'write' : doReconcile ? 'reconcile' : 'owns';
    const code = gate(mode, topicsDir, positionals);
    if (code !== 0) process.exitCode = code;
    return;
  }

  // READER mode — FIND.
  const cards = loadCards(topicsDir);
  if (positionals.length === 0) {
    out(`piflowctl understand — ${cards.length} subsystem slice(s) in ${topicsDir}:\n`);
    for (const c of cards) out(`  ${c.key}  —  ${c.title}\n`);
    out(`\nask about one:  piflowctl understand <subsystem>\n`);
    return;
  }

  const query = positionals.join(' ');
  const ranked = rankCards(cards, query);
  if (ranked.length === 0) {
    out(
      `piflowctl understand: no slice owns "${query}" — UNCOVERED.\n` +
        `  This subsystem has no card yet (a gap to author). Explore the code directly, e.g. codegraph explore "${query}".\n`,
    );
    return;
  }

  const top = ranked[0].card;
  out(`# ${top.key}  —  ${top.title}\n`);
  if (top.resource) out(`owns: ${top.resource}\n`);
  out(`\n${top.curated}\n`);
  const related = ranked.slice(1, 4).map((r) => r.card.key);
  if (related.length) out(`\nrelated slices: ${related.join(', ')}\n`);
  out(`\nvalidate freshness:  piflowctl understand --check ${top.key}\n`);
}
