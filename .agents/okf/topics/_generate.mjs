#!/usr/bin/env node
// OKF topic-card generator — decoupled, system-agnostic, zero-dependency.
//
// A "topic card" is a vertical view over a cross-cutting concern. Its CURATED half
// (frontmatter + prose above the auto-marker) is hand-authored; its DERIVED half is
// filled by this script from THREE generic substrates, none of them project-specific:
//   • git     — the evolution arc + (for a no-seed topic) the file set        [universal]
//   • memory  — a dir of markdown notes with `[[links]]` + frontmatter         [convention]
//   • codegraph — code anchors / blast radius                                  [optional]
// Plus a HEALTH pass that flags any repo path referenced in the card that no longer exists
// (the drift detector). No knowledge of game-omni lives here — all inputs come from each
// card's frontmatter (key/aliases/seeds/memoryHub/symbols) and okf.config.json.
//
// Usage:
//   node _generate.mjs --write [<key>...]   regenerate the auto region of every (or named) card
//   node _generate.mjs --check [<key>...]   the pre-commit drift gate. Exit 1 ONLY on a HEALTH
//                                           failure (a seed/anchor file or symbol/line moved — the
//                                           anchors may be wrong). Auto-region DRIFT (a stale git/
//                                           memory/blast block) is ADVISORY: reported, non-blocking
//                                           — run --write to refresh it.
//   --staged (with --check)                 scope the gate to cards whose seeds/anchors (or the card
//                                           file itself) intersect the git-staged files — the
//                                           pre-commit hook's fast path.
//   node _generate.mjs --reconcile          the POST-MERGE advisory pass (never blocks): the E4 rung
//                                           (normalized span-hash of every def-anchored symbol — a
//                                           body change is a SEMANTIC? trigger to re-read the card's
//                                           prose), the E5 rung (change-site symbols from diff hunk
//                                           headers → codegraph impact → card deps reached OUTSIDE
//                                           the change set), and the coverage rung (hot product files
//                                           no card owns). State in gitignored .reconcile-state.json;
//                                           first run stamps the baseline.
//   node _generate.mjs --owns <path>        reverse lookup: which card(s) own this file (seeds/anchors).
//   OKF_NO_SYNC=1                           skip the automatic `codegraph sync` of a stale index.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseCardForRank, rankCards } from './_rank.mjs'; // the ONE ranker — shared by --find and the CLI

const HERE = process.env.OKF_TOPICS_DIR ? resolve(process.env.OKF_TOPICS_DIR) : dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(readFileSync(join(HERE, '..', 'okf.config.json'), 'utf8'));
const REPO = resolve(join(HERE, '..'), CFG.repoRoot);
const MEMDIR = process.env.OKF_MEMORY_DIR || CFG.memoryDir;
const NOISE = CFG.noise || [];
const START = '<!-- okf:auto-start -->';
const END = '<!-- okf:auto-end -->';

const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--write') ? 'write'
  : process.argv.includes('--reconcile') ? 'reconcile' : process.argv.includes('--owns') ? 'owns'
  : process.argv.includes('--find') ? 'find' : null;
if (!mode) { console.error('usage: _generate.mjs --write|--check [--staged]|--reconcile|--owns <path>|--find [--json] <query…> [<key>...]'); process.exit(2); }
const STAGED = process.argv.includes('--staged');
if (STAGED && mode !== 'check') { console.error('--staged only applies to --check'); process.exit(2); }
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));

// ---- MODE: --find (query → owning card; the standalone ranked reader — `node` only, no piflowctl) ----
// Placed BEFORE the heavy git/codegraph globals and the known-card-key validation: FIND is a pure,
// fast read over the card frontmatter (via the vendored `_rank.mjs`), and its positionals are a free-text
// QUERY, not card keys. This is what makes `.agents/okf/` a self-contained retrieval tool on `node` alone.
if (mode === 'find') {
  const JSON_OUT = process.argv.includes('--json');
  const query = only.join(' ');
  const cards = readdirSync(HERE).filter(f => f.endsWith('.md') && !f.startsWith('_'))
    .map(f => parseCardForRank(f.replace(/\.md$/, ''), readFileSync(join(HERE, f), 'utf8')));
  const ranked = rankCards(cards, query);
  if (JSON_OUT) { // machine surface: the CLI reader + the optimizer's fixer wire source ranking from here
    console.log(JSON.stringify(ranked.map(r => ({ key: r.card.key, title: r.card.title, resource: r.card.resource, score: r.score }))));
    process.exit(0);
  }
  if (!query) { // bare --find lists the covered slices (the index), never the `_`-prefixed engine files
    console.log(`${cards.length} subsystem slice(s) in ${HERE}:`);
    for (const c of [...cards].sort((a, b) => a.key.localeCompare(b.key))) console.log(`  ${c.key}  —  ${c.title}`);
    process.exit(0);
  }
  if (!ranked.length) {
    console.log(`no slice owns "${query}" — UNCOVERED (a gap to author, or explore the code directly).`);
    process.exit(0);
  }
  const top = ranked[0].card;
  console.log(`# ${top.key}  —  ${top.title}`);
  if (top.resource) console.log(`owns: ${top.resource}`);
  console.log(`\n${top.curated}\n`);
  const related = ranked.slice(1, 4).map(r => r.card.key);
  if (related.length) console.log(`related slices: ${related.join(', ')}`);
  console.log(`\nvalidate freshness:  node _generate.mjs --check ${top.key}`);
  process.exit(0);
}

// ---- substrate helpers (all best-effort; a dead substrate degrades, never crashes) ----
const sh = (cmd, args, opts = {}) => {
  try { return execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'], ...opts }); }
  catch { return ''; }
};
const isNoise = p => NOISE.some(n => p.includes(n));
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The structured-anchor pattern (`path:line` — `symbol`) — the slice's contract. ONE source of
// truth: healthCheck validates these anchors, and the incremental fingerprint stats exactly the
// files they point at, so the two can never disagree about a card's dependency set.
const anchorRe = () => /`([\w./@-]+\.[A-Za-z0-9]+):(\d+)`\s*[—-]+\s*`([^`]+)`/g;

// codegraph exact-name lookup (memoized) — used ONLY to explain WHERE a missing anchor symbol moved;
// degrades to null when codegraph is unavailable, so the line:symbol gate still runs deterministically.
const NO_CG = !!process.env.OKF_NO_CODEGRAPH || !CFG.codegraph;
// DRIFT (next !== text) is only an honest signal when this run derives the same way the committed
// region was derived. When the env flag disables a codegraph the config DECLARES (CI has no index),
// the re-render is guaranteed to differ — report HEALTH only, never that vacuous DRIFT.
const DRIFT_COMPARABLE = !(process.env.OKF_NO_CODEGRAPH && CFG.codegraph);
const _symCache = new Map();
function cgFind(name) {
  if (NO_CG || !name) return null;
  if (_symCache.has(name)) return _symCache.get(name);
  let hits = [];
  const out = sh(CFG.codegraph, ['query', name, '--json', '--limit', '25']);
  if (out) { try { hits = JSON.parse(out).map(r => r.node).filter(n => n && n.name === name); } catch { /* not JSON */ } }
  _symCache.set(name, hits); return hits;
}
const fileLines = p => { try { return readFileSync(join(REPO, p), 'utf8').split('\n'); } catch { return null; } };

// ---- frontmatter (tiny YAML subset: scalars + inline [a, b] arrays) ----
function parseCard(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let [, k, v] = kv;
    if (v.startsWith('[') && v.endsWith(']')) {
      fm[k] = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else { fm[k] = v.replace(/^["']|["']$/g, ''); }
  }
  return { fm, body: m[2] };
}

// ---- DERIVE: evolution arc ----
function deriveArc(spec) {
  let lines = [];
  if (spec.seeds?.length) {
    const out = sh('git', ['log', '--reverse', '--date=short', '--format=%ad|%h|%s', '--', ...spec.seeds]);
    lines = out.trim().split('\n').filter(Boolean);
  } else if (spec.grepArc || spec.aliases?.length) {
    const rx = spec.grepArc || spec.aliases.map(reEsc).join('|');
    const out = sh('git', ['log', '--reverse', '--date=short', '--format=%ad|%h|%s', '-E', '-i', `--grep=${rx}`]);
    lines = out.trim().split('\n').filter(Boolean);
  }
  const seen = new Set();
  return lines.map(l => { const [date, hash, ...s] = l.split('|'); return { date, hash, subj: s.join('|') }; })
    .filter(c => c.hash && !seen.has(c.hash) && seen.add(c.hash));
}

// ---- DERIVE: file set ----
function deriveFiles(spec) {
  if (spec.seeds?.length) return spec.seeds.map(p => ({ path: p, exists: existsSync(join(REPO, p)) }));
  if (!spec.grepArc && !spec.aliases?.length) return [];
  const rx = spec.grepArc || spec.aliases.map(reEsc).join('|');
  const out = sh('git', ['log', '-E', '-i', `--grep=${rx}`, '--name-only', '--pretty=format:']);
  const freq = new Map();
  for (const f of out.split('\n').map(s => s.trim()).filter(Boolean)) {
    if (isNoise(f)) continue; freq.set(f, (freq.get(f) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([path, n]) => ({ path, n, exists: existsSync(join(REPO, path)) }));
}

// ---- DERIVE: lessons (hub cluster vs alias matches — the prune the fuzzy case needs) ----
function deriveLessons(spec) {
  if (!existsSync(MEMDIR)) return { hubCluster: [], aliasMatches: [], note: 'memory dir not found — lessons skipped' };
  const files = readdirSync(MEMDIR).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  const read = f => { try { return readFileSync(join(MEMDIR, f), 'utf8'); } catch { return ''; } };
  const oneLine = f => (read(f).match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] || '').slice(0, 140);

  const cluster = new Set();
  if (spec.memoryHub) {
    const hub = spec.memoryHub.endsWith('.md') ? spec.memoryHub : spec.memoryHub + '.md';
    if (existsSync(join(MEMDIR, hub))) {
      cluster.add(hub);
      for (const l of read(hub).matchAll(/\[\[([^\]]+)\]\]/g)) { const t = l[1] + '.md'; if (files.includes(t)) cluster.add(t); }
      for (const f of files) if (read(f).includes(`[[${hub.replace(/\.md$/, '')}]]`)) cluster.add(f); // back-links
    }
  }
  const rx = new RegExp(spec.aliases.map(reEsc).join('|'), 'i');
  const aliasMatches = files.filter(f => (rx.test(f) || rx.test(read(f))) && !cluster.has(f));
  return {
    hubCluster: [...cluster].map(f => ({ file: f, desc: oneLine(f) })),
    aliasMatches: aliasMatches.map(f => ({ file: f, desc: oneLine(f) })),
  };
}

// ---- DERIVE: code anchors (codegraph; optional) ----
function deriveAnchors(spec) {
  const q = (spec.symbols?.length ? spec.symbols : spec.aliases.slice(0, 6)).join(' ');
  const out = sh(CFG.codegraph || 'codegraph', ['explore', q]);
  if (!out) return null;
  const anchors = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^- `(.+?)`\s*\((.+?)\)\s*—\s*(.+)$/);
    if (m && !isNoise(m[2])) anchors.push({ sym: m[1], loc: m[2], note: m[3].replace(/⚠️?/g, '⚠').trim() });
    if (anchors.length >= 5) break;
  }
  return anchors;
}

// ---- HEALTH: the §4 tier-0 drift gate, line:symbol-accurate (not just filename-existence). ----
// Two checks, deterministic-first: (1) every SEED file exists; (2) every structured ANCHOR
// (`path:line` — `symbol`) resolves — the file exists AND the cited line (±WINDOW) still carries the
// symbol/snippet. When the line check fails, codegraph (if present) says whether the symbol moved
// lines (line drift) or files (moved); without codegraph the line check alone still catches it.
// Free prose paths are intentionally NOT scanned — anchors + seeds are the slice's contract, and
// scanning prose produced benign false positives on abbreviated/negative references.
// Issues are structured: `{ msg, repair? }` — `repair` is present ONLY for same-file line drift
// (the span is known, the symbol unchanged), the one class the machine may fix itself by re-stamping
// the `path:line` token. Moves and unresolved symbols stay manual (they change the card's meaning).
function healthCheck(card, spec) {
  const issues = [];
  const WINDOW = 3;
  for (const s of spec.seeds || []) if (!isNoise(s) && !existsSync(join(REPO, s))) issues.push({ msg: `seed missing: ${s}` });
  const rx = anchorRe();
  for (const m of card.matchAll(rx)) {
    const [, path, lineStr, sym] = m;
    if (path.startsWith('http') || path.startsWith('~') || isNoise(path)) continue;
    const line = parseInt(lineStr, 10);
    const lines = fileLines(path);
    if (!lines) { issues.push({ msg: `anchor path missing: ${path} (\`${sym}\`)` }); continue; }
    const toks = [...new Set((sym.match(/[A-Za-z_$][\w$]*/g) || []).filter(t => t.length >= 3))];
    const nearLine = t => { for (let d = 0; d <= WINDOW; d++) { const a = lines[line - 1 - d], b = lines[line - 1 + d]; if ((a && a.includes(t)) || (b && b.includes(t))) return true; } return false; };
    const blob = lines.join('\n');
    const inFile = t => new RegExp(`\\b${reEsc(t)}\\b`).test(blob);
    // (1) DEFINITION anchor: a significant token is DEFINED in this file (codegraph span) — validate line ∈ span.
    let drift = null; // a line-drift issue (with repair info) if a def anchor's line is wrong
    let pass = false;
    for (const t of toks.filter(t => t.length >= 5)) {
      const nodes = (cgFind(t) || []).filter(n => n.filePath === path && n.startLine);
      if (!nodes.length) continue;
      if (nodes.some(n => line >= n.startLine && line <= n.endLine) || nearLine(t)) { pass = true; break; }
      const n = nodes[0];
      drift = drift || { msg: `anchor line drift: ${path}:${line} \`${t}\` — defined :${n.startLine}-${n.endLine}`, repair: { path, line, newLine: n.startLine } };
    }
    if (pass) continue;
    if (drift) { issues.push(drift); continue; }
    // (2) CALL-SITE / field / codegraph-unindexed: the symbol token must still be present in the cited file.
    if (toks.some(inFile)) continue;
    // (3) Not in the file → renamed/moved/deleted. codegraph (if present) says where it went.
    let moved = null;
    for (const t of toks.filter(t => t.length >= 5)) { const e = (cgFind(t) || []).find(n => n.filePath !== path); if (e) { moved = `anchor moved: \`${t}\` cited ${path}:${line}, now ${e.filePath}:${e.startLine}`; break; } }
    issues.push({ msg: moved || `anchor unresolved: ${path}:${line} \`${sym}\` — symbol not found in file` });
  }
  return issues;
}

// ---- RENDER ----
function render(spec, { arc, files, lessons, anchors }) {
  const L = [];
  L.push(`> _Auto-generated by \`_generate.mjs\` — do not hand-edit between the markers; re-run \`--write\`._`, '');

  L.push('### Final state — file set' + (spec.seeds?.length ? ' (seeds)' : ' (derived by commit-touch frequency)'), '');
  if (files.length) { L.push('| File | exists |' + (spec.seeds?.length ? '' : ' touches |'), '|---|---|' + (spec.seeds?.length ? '' : '---|'));
    for (const f of files) L.push(`| \`${f.path}\` | ${f.exists ? '✓' : '**MISSING**'} |` + (spec.seeds?.length ? '' : ` ${f.n} |`)); }
  else L.push('_(none derived)_');
  L.push('');

  L.push('### Evolution arc', '');
  if (arc.length) for (const c of arc) L.push(`- \`${c.hash}\` ${c.date} — ${c.subj}`);
  else L.push('_(no commits matched)_');
  L.push('');

  L.push('### Lessons — memory cluster', '');
  if (lessons.note) L.push(`_${lessons.note}_`);
  if (lessons.hubCluster?.length) { L.push('**Hub cluster** (hub + links + back-links):');
    for (const m of lessons.hubCluster) L.push(`- [[${m.file.replace(/\.md$/, '')}]]${m.desc ? ' — ' + m.desc : ''}`); L.push(''); }
  if (lessons.aliasMatches?.length) { L.push('**Alias matches** (review — may include false positives):');
    for (const m of lessons.aliasMatches) L.push(`- [[${m.file.replace(/\.md$/, '')}]]`); L.push(''); }

  if (anchors) { L.push('### Code anchors / blast radius (codegraph)', '');
    if (anchors.length) for (const a of anchors) L.push(`- \`${a.sym}\` (${a.loc}) — ${a.note}`);
    else L.push('_(no in-repo anchors)_'); L.push(''); }

  L.push(`<sub>derived ${new Date().toISOString().slice(0, 10)} · arc=${arc.length} commits · files=${files.length} · lessons=${(lessons.hubCluster?.length || 0) + (lessons.aliasMatches?.length || 0)}</sub>`);
  return L.join('\n');
}

function splice(text, block) {
  const body = `${START}\n${block}\n${END}`;
  if (text.includes(START) && text.includes(END)) return text.replace(new RegExp(`${START}[\\s\\S]*?${END}`), body);
  return text.replace(/\s*$/, '') + `\n\n${body}\n`;
}

// ---- incremental invalidation (borrowed from codebase-memory-mcp's classify-by-fingerprint) ----
// Re-deriving every card's 4 substrates on every run is wasted work when nothing a card depends on
// moved. We skip a card whose EVERY input is byte-identical to its last fully-clean derive. Safety
// law (the vendor's too): over-invalidate on ANY doubt — a missing cache, codegraph flipping on,
// an unreadable stat — falls back to a full re-derive; we NEVER under-invalidate (a false-green gate
// is worse than a slow one). The cache is derived local state (gitignored), not a shareable artifact.
const CACHE_FILE = join(HERE, '.gen-cache.json');
const NO_CACHE = !!process.env.OKF_NO_CACHE;
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16);
const loadCache = () => { if (NO_CACHE) return {}; try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; } };
const saveCache = c => { if (NO_CACHE) return; try { writeFileSync(CACHE_FILE, JSON.stringify(c) + '\n'); } catch { /* best-effort */ } };
const statSig = p => { try { const s = statSync(join(REPO, p)); return `${Math.round(s.mtimeMs)}:${s.size}`; } catch { return 'MISSING'; } };

// GLOBAL fingerprint inputs — identical for every card, so compute them ONCE per run: git HEAD (the
// arc/grep derives), the memory dir manifest (the lessons derive), and the codegraph index identity
// (the anchor span checks). pendingChanges is deliberately EXCLUDED — a dirty tree at pre-commit must
// not force a global miss; the per-card dep-file stats below already catch the actual code edits.
const gHead = sh('git', ['rev-parse', 'HEAD']).trim() || 'no-head';
const gMemory = (() => {
  try {
    return sha(readdirSync(MEMDIR).filter(f => f.endsWith('.md')).sort()
      .map(f => { const s = statSync(join(MEMDIR, f)); return `${f}:${Math.round(s.mtimeMs)}:${s.size}`; }).join('|'));
  } catch { return 'no-memory'; }
})();
const gCg = (() => {
  if (NO_CG) return 'off';
  try {
    let j = JSON.parse(sh(CFG.codegraph, ['status', '--json']));
    // Self-sync: the span checks resolve against the INDEX, so a stale index makes the gate lie.
    // pendingChanges is an object ({added, modified, removed}), not a count.
    const pending = Object.values(j.pendingChanges || {}).reduce((a, n) => a + (n || 0), 0);
    if (pending > 0 && !process.env.OKF_NO_SYNC) {
      console.error(`codegraph: ${pending} pending change(s) — syncing so the gate checks the current graph`);
      sh(CFG.codegraph, ['sync', '-q'], { timeout: 180000 });
      j = JSON.parse(sh(CFG.codegraph, ['status', '--json']));
    }
    return `${j.lastIndexed}:${j.nodeCount}:${j.edgeCount}`;
  } catch { return 'cg-unknown'; }
})();

// A card's dependency set — seeds + structured-anchor paths. ONE source of truth shared by the
// fingerprint and the --staged filter, so they can never disagree about what a card depends on.
function depPaths(curated, spec) {
  const deps = new Set();
  for (const s of spec.seeds || []) if (!isNoise(s)) deps.add(s);
  for (const m of curated.matchAll(anchorRe())) {
    const p = m[1];
    if (!p.startsWith('http') && !p.startsWith('~') && !isNoise(p)) deps.add(p);
  }
  return deps;
}

// PER-CARD fingerprint: the curated half (frontmatter + anchors + prose) + the stat-signature of
// every file it points at (seeds + structured anchors) + the three globals. Any of these moving — a
// code edit (committed or not), a new commit, a memory note, a codegraph re-sync — misses the cache.
function fingerprint(curated, spec) {
  const deps = {};
  for (const p of depPaths(curated, spec)) deps[p] = statSig(p);
  // trimEnd the curated half: splice() normalizes trailing whitespace when it first appends the auto
  // block, so a fresh card's pre-write vs post-write curated differ only in trailing newlines — that
  // must not miss the cache. Trailing whitespace never affects a health/derive verdict.
  return sha(JSON.stringify({ curated: curated.replace(/\s+$/, ''), deps, head: gHead, memory: gMemory, cg: gCg }));
}

// ---- RECONCILE substrate (post-merge, advisory) ----
// E4 approximation: a formatting-insensitive-ish hash of a symbol's codegraph span — comments
// stripped, whitespace collapsed (a normalized-text span hash, not a true AST hash; zero-dep).
// A changed hash is a SEMANTIC? trigger for the MAINTAIN agent to re-read prose — never a block.
const RECON_FILE = join(HERE, '.reconcile-state.json');
const loadRecon = () => { try { return JSON.parse(readFileSync(RECON_FILE, 'utf8')); } catch { return { head: null, bodyHashes: {} }; } };
const saveRecon = s => { try { writeFileSync(RECON_FILE, JSON.stringify(s) + '\n'); } catch { /* best-effort */ } };
function spanHash(p, startLine, endLine) {
  const lines = fileLines(p); if (!lines) return null;
  return sha(lines.slice(startLine - 1, endLine).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim());
}
// shared leading path segments — the coverage rung's "nearest card" heuristic.
const sharedSegs = (a, b) => { const A = a.split('/'), B = b.split('/'); let i = 0; while (i < A.length && i < B.length && A[i] === B[i]) i++; return i; };

// Coverage-rung centrality tunables. CENTRALITY_MIN_INDEGREE: an uncovered file USED BY >= this many
// other files is a genuine shared hub whose correctness spans multiple call-sites — a real mapping gap
// even at ZERO churn (which the churn-gated HOT rung structurally cannot see). Live-calibrated against
// this index (`codegraph node <f> --symbols-only` → "used by N files"): leaf/entrypoint files score 0,
// a private single-consumer helper 1, while shared modules like profile-overlay.ts (2) / gate-list.ts (3)
// and hubs like op-dispatch.ts (15) / loader.ts (29) score >= 2. So 2 is the leaf/private → shared-hub
// boundary — the smallest fan-in that means "more than one module's correctness rides on this file."
// CENTRALITY_MAX_PROBES bounds the per-file codegraph calls when the commit window touches many files.
const CENTRALITY_MIN_INDEGREE = 2;
const CENTRALITY_MAX_PROBES = 50;
// A file's codegraph in-degree (how many other files depend on it) — the fan-in centrality §2 ranks by,
// read from `node <file> --symbols-only`'s "used by N files" header. 0 when codegraph is off/unindexed.
function fileInDegree(file) {
  if (NO_CG) return 0;
  const m = sh(CFG.codegraph, ['node', file, '--symbols-only']).match(/used by (\d+) files?/i);
  return m ? parseInt(m[1], 10) : 0;
}

// ---- main ----
const allKeys = readdirSync(HERE).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
const unknown = only.filter(k => !allKeys.includes(k));
if (mode !== 'owns' && unknown.length) { console.error(`unknown card key(s): ${unknown.join(', ')} — known: ${allKeys.join(', ')}`); process.exit(2); }
const cards = readdirSync(HERE).filter(f => f.endsWith('.md') && (mode === 'owns' || !only.length || only.includes(f.replace(/\.md$/, ''))));

const readCardFile = file => {
  const p = join(HERE, file);
  const text = readFileSync(p, 'utf8');
  const { fm } = parseCard(text);
  return {
    file, path: p, text,
    spec: { key: fm.key || file.replace(/\.md$/, ''), aliases: fm.aliases || [], seeds: fm.seeds || [], symbols: fm.symbols || [], memoryHub: fm.memoryHub },
    curated: text.split(START)[0],
  };
};

// ---- MODE: --owns (reverse lookup, code → card; FIND already has the doc → code direction) ----
if (mode === 'owns') {
  const target = (only[0] || '').replace(/^\.\//, '');
  if (!target) { console.error('usage: _generate.mjs --owns <repo-relative-path>'); process.exit(2); }
  const owners = cards.map(readCardFile).filter(c => {
    const d = depPaths(c.curated, c.spec); d.add(relative(REPO, c.path)); return d.has(target);
  });
  if (owners.length) for (const c of owners) console.log(`${c.spec.key}${c.spec.seeds.includes(target) ? ' (seed)' : ''}`);
  else console.log(`(no card owns ${target} — uncovered)`);
  process.exit(0);
}

// ---- MODE: --reconcile (the post-merge advisory cadence — deterministic FACTS for the MAINTAIN
// agent to judge; the machine never judges prose, and this mode never blocks) ----
if (mode === 'reconcile') {
  const state = loadRecon();
  const parsed = cards.map(readCardFile);
  const baseline = !state.head;
  let triggers = 0;

  // RUNG E4 — span-hash every def-anchored symbol; a changed body is a SEMANTIC? re-read trigger.
  const nextHashes = {};
  if (!NO_CG) {
    for (const c of parsed) {
      const fired = new Set();
      for (const m of c.curated.matchAll(anchorRe())) {
        const [, p, lineStr, symTxt] = m;
        if (p.startsWith('http') || p.startsWith('~') || isNoise(p)) continue;
        const line = parseInt(lineStr, 10);
        for (const t of [...new Set((symTxt.match(/[A-Za-z_$][\w$]*/g) || []).filter(t => t.length >= 5))]) {
          const n = (cgFind(t) || []).find(n => n.filePath === p && n.startLine <= line && line <= n.endLine);
          if (!n) continue;
          const key = `${p}#${n.name}`;
          if (!(key in nextHashes)) nextHashes[key] = spanHash(p, n.startLine, n.endLine);
          if (!baseline && state.bodyHashes[key] && nextHashes[key] && state.bodyHashes[key] !== nextHashes[key] && !fired.has(key)) {
            fired.add(key); triggers++;
            console.log(`SEMANTIC? [${c.spec.key}] \`${n.name}\` (${p}) body changed since last reconcile — re-read the card's prose against the new behavior`);
          }
          break; // the first containing definition is the anchor's symbol
        }
      }
    }
  } else console.log('(codegraph unavailable — E4 body-hash + E5 impact rungs skipped; coverage rung only)');

  // RUNG E5 — the graph-only rung: symbols actually edited in the range (git prints the enclosing
  // definition on each hunk header) → confirmed defined in a changed file → `codegraph impact` →
  // does the blast radius reach a card's dep files from OUTSIDE the change set?
  const changed = !baseline && state.head !== gHead
    ? sh('git', ['diff', '--name-only', `${state.head}..HEAD`]).split('\n').map(s => s.trim()).filter(f => f && !isNoise(f))
    : [];
  if (changed.length && !NO_CG) {
    const changedSet = new Set(changed);
    const hunkSyms = new Set();
    for (const hm of sh('git', ['diff', `${state.head}..HEAD`, '--unified=0']).matchAll(/^@@[^@]*@@\s*(.*)$/gm))
      for (const t of (hm[1].match(/[A-Za-z_$][\w$]{4,}/g) || []).slice(0, 3)) hunkSyms.add(t);
    let ran = 0;
    for (const g of hunkSyms) {
      if (ran >= 25) { console.log(`(impact rung capped at 25 change-site symbols — ${hunkSyms.size - ran} more not traced)`); break; }
      const defs = (cgFind(g) || []).filter(n => changedSet.has(n.filePath));
      if (!defs.length) continue;
      ran++;
      let aff;
      try { aff = new Set((JSON.parse(sh(CFG.codegraph, ['impact', g, '--json'], { timeout: 60000 })).affected || []).map(a => a.filePath).filter(Boolean)); }
      catch { continue; }
      if (aff.size > 200) { console.log(`(impact of \`${g}\` too hot — ${aff.size} affected files; not traced)`); continue; }
      for (const c of parsed) {
        const deps = depPaths(c.curated, c.spec);
        const hits = [...deps].filter(d => aff.has(d) && !changedSet.has(d));
        if (hits.length) { triggers++; console.log(`IMPACT? [${c.spec.key}] change to \`${g}\` (${defs[0].filePath}) reaches its dep ${hits[0]} via blast radius — verify the card's prose/anchors`); }
      }
    }
  }

  // COVERAGE rung — hot product files no card owns. Instrument paths are excluded BY RULE (they are
  // skill-documented shared tooling, not card material — the per-product boundary decision).
  const excl = CFG.coverageExclude || ['.agents/', '.claude/', '.githooks/', '.github/', '.changeset/', 'scripts/', 'vendor/'];
  const freq = new Map();
  for (const f of sh('git', ['log', '-80', '--name-only', '--pretty=format:']).split('\n').map(s => s.trim()).filter(Boolean)) {
    if (isNoise(f) || excl.some(e => f.startsWith(e))) continue;
    freq.set(f, (freq.get(f) || 0) + 1);
  }
  const union = new Set();
  for (const c of parsed) { for (const d of depPaths(c.curated, c.spec)) union.add(d); union.add(relative(REPO, c.path)); }
  const nearestCard = f => { let best = null, bestLen = 1; for (const c of parsed) for (const s of c.spec.seeds || []) { const k = sharedSegs(f, s); if (k > bestLen) { bestLen = k; best = c.spec.key; } } return best; };
  const hot = [...freq.entries()].filter(([f, n]) => n >= 2 && !union.has(f) && existsSync(join(REPO, f))).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const hotReported = new Set(hot.map(([f]) => f));
  for (const [f, n] of hot) {
    triggers++;
    console.log(`UNCOVERED-HOT: ${f} (${n} recent commits, no card)${nearestCard(f) ? ` — nearest card: ${nearestCard(f)}` : ''}`);
  }

  // CENTRAL rung — an uncovered file with high codegraph FAN-IN (used-by-N-files) is flagged REGARDLESS
  // of churn: HOT above is churn-gated, so a NEW architecturally-central low-churn file (a fresh loader
  // hub with 1 commit) is structurally invisible to it. Same candidate universe as HOT — the `freq` map,
  // so instrument paths stay excluded BY THE SAME RULE — but the gate is centrality (§2's fan-in rank),
  // not commit count. Skips whatever HOT already surfaced (one gap, one line). Needs codegraph; advisory,
  // never blocking. Probes are capped so a wide commit window can't explode into unbounded codegraph calls.
  if (!NO_CG) {
    const cands = [...freq.keys()].filter(f => !union.has(f) && !hotReported.has(f) && existsSync(join(REPO, f)));
    const central = [];
    let probes = 0;
    for (const f of cands) {
      if (probes >= CENTRALITY_MAX_PROBES) { console.log(`(centrality rung capped at ${CENTRALITY_MAX_PROBES} probes — ${cands.length - probes} uncovered file(s) not scored)`); break; }
      probes++;
      const deg = fileInDegree(f);
      if (deg >= CENTRALITY_MIN_INDEGREE) central.push([f, deg]);
    }
    for (const [f, deg] of central.sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      triggers++;
      console.log(`UNCOVERED-CENTRAL: ${f} (in-degree ${deg}, no card)${nearestCard(f) ? ` — nearest card: ${nearestCard(f)}` : ''}`);
    }
  }

  saveRecon({ head: gHead, bodyHashes: NO_CG ? state.bodyHashes : nextHashes });
  console.log(baseline
    ? `\nreconcile baseline stamped at ${gHead.slice(0, 7)} — ${Object.keys(nextHashes).length} anchored symbol span(s) across ${parsed.length} card(s)`
    : `\nreconcile: ${triggers} advisory trigger(s) since ${String(state.head).slice(0, 7)} — judge each per okf-slices MAINTAIN (advisory, never blocking)`);
  process.exit(0);
}
const cache = loadCache();
// --staged: the file-level rung of the blast ladder, applied at pre-commit — only cards whose
// dependency set (or own card file) intersects the staged files are checked; the rest can't have
// drifted from THIS commit. Full sweeps stay `--check` (post-merge, CI).
const STAGED_FILES = STAGED ? new Set(sh('git', ['diff', '--cached', '--name-only']).split('\n').filter(Boolean)) : null;
let drift = 0, healthFail = 0, skipped = 0;
for (const file of cards) {
  const path = join(HERE, file);
  const text = readFileSync(path, 'utf8');
  const { fm } = parseCard(text);
  const spec = { key: fm.key || file.replace(/\.md$/, ''), aliases: fm.aliases || [], seeds: fm.seeds || [], symbols: fm.symbols || [], memoryHub: fm.memoryHub };
  const tag = `[${spec.key}]`;
  const curated = text.split(START)[0]; // splice never touches this half → curated == next's curated half
  if (STAGED_FILES) {
    const deps = depPaths(curated, spec);
    deps.add(relative(REPO, path));
    if (![...STAGED_FILES].some(f => deps.has(f))) { skipped++; continue; }
  }
  let fp = fingerprint(curated, spec);

  // INCREMENTAL SKIP: a cache entry exists ONLY for a fully-clean card, so a fingerprint match proves
  // the card is still fresh + healthy (identical inputs → identical deterministic derive). Skip the
  // costly deriveArc/Files/Lessons/Anchors + healthCheck entirely.
  if (cache[spec.key] === fp) { console.log(`${tag} ${mode === 'write' ? 'unchanged (cached)' : 'ok (cached)'}`); continue; }

  // AUTO-REPAIR (--write only): same-file line drift is mechanical — the span is known, the symbol
  // unchanged — so --write re-stamps the `path:line` token itself (every occurrence of the exact
  // token in the card, prose citations included). The machine never touches words; moved/unresolved
  // anchors stay manual (they change the card's MEANING).
  let body = text, cur = curated;
  let health = healthCheck(curated, spec);
  if (mode === 'write' && health.some(h => h.repair)) {
    for (const { repair: r } of health.filter(h => h.repair)) {
      body = body.split(`\`${r.path}:${r.line}\``).join(`\`${r.path}:${r.newLine}\``);
      console.log(`${tag} anchor repaired: ${r.path}:${r.line} → :${r.newLine} (span-verified)`);
    }
    cur = body.split(START)[0];
    health = healthCheck(cur, spec); // residual issues only — repaired anchors must now pass
    fp = fingerprint(cur, spec);
  }

  const data = { arc: deriveArc(spec), files: deriveFiles(spec), lessons: deriveLessons(spec), anchors: process.env.OKF_NO_CODEGRAPH ? null : deriveAnchors(spec) };
  const next = splice(body, render(spec, data));

  // Cache a card ONLY when it is fully clean at this fingerprint: healthy, and (for --check, which
  // doesn't rewrite) not drifted. --write refreshes the region, so post-write clean == healthy. A
  // drifted or unhealthy card is dropped from the cache so it always re-checks until resolved.
  if (!health.length && (mode === 'write' || next === text)) cache[spec.key] = fp; else delete cache[spec.key];

  if (mode === 'write') {
    if (next !== text) { writeFileSync(path, next); console.log(`${tag} regenerated (arc=${data.arc.length}, files=${data.files.length})`); }
    else console.log(`${tag} unchanged`);
    for (const h of health) console.log(`  ⚠ ${h.msg}`);
  } else { // check
    if (next !== text && DRIFT_COMPARABLE) { console.error(`${tag} DRIFT: auto region is stale — run --write`); drift++; }
    for (const h of health) { console.error(`${tag} HEALTH: ${h.msg}${h.repair ? ' — auto-repairable: run --write' : ''}`); healthFail++; }
    if ((next === text || !DRIFT_COMPARABLE) && !health.length) console.log(`${tag} ok`);
  }
}
saveCache(cache); // persist before any exit, so a failing --check still records the clean cards
if (mode === 'check') {
  if (STAGED_FILES) console.log(`--staged: checked ${cards.length - skipped} of ${cards.length} card(s) touching staged files`);
  // DRIFT is advisory (the auto region is regenerable); only a HEALTH failure means the
  // curated anchors may be WRONG — that is what blocks the commit.
  if (drift) console.error(`\n${drift} advisory DRIFT (auto region stale — non-blocking; run --write to refresh).`);
  if (healthFail) { console.error(`\n${healthFail} HEALTH failure(s) — blocking.`); process.exit(1); }
}
