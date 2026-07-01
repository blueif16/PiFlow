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

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = process.env.OKF_TOPICS_DIR ? resolve(process.env.OKF_TOPICS_DIR) : dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(readFileSync(join(HERE, '..', 'okf.config.json'), 'utf8'));
const REPO = resolve(join(HERE, '..'), CFG.repoRoot);
const MEMDIR = process.env.OKF_MEMORY_DIR || CFG.memoryDir;
const NOISE = CFG.noise || [];
const START = '<!-- okf:auto-start -->';
const END = '<!-- okf:auto-end -->';

const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--write') ? 'write' : null;
if (!mode) { console.error('usage: _generate.mjs --write|--check [<key>...]'); process.exit(2); }
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));

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
function healthCheck(card, spec) {
  const issues = [];
  const WINDOW = 3;
  for (const s of spec.seeds || []) if (!isNoise(s) && !existsSync(join(REPO, s))) issues.push(`seed missing: ${s}`);
  const rx = anchorRe();
  for (const m of card.matchAll(rx)) {
    const [, path, lineStr, sym] = m;
    if (path.startsWith('http') || path.startsWith('~') || isNoise(path)) continue;
    const line = parseInt(lineStr, 10);
    const lines = fileLines(path);
    if (!lines) { issues.push(`anchor path missing: ${path} (\`${sym}\`)`); continue; }
    const toks = [...new Set((sym.match(/[A-Za-z_$][\w$]*/g) || []).filter(t => t.length >= 3))];
    const nearLine = t => { for (let d = 0; d <= WINDOW; d++) { const a = lines[line - 1 - d], b = lines[line - 1 + d]; if ((a && a.includes(t)) || (b && b.includes(t))) return true; } return false; };
    const blob = lines.join('\n');
    const inFile = t => new RegExp(`\\b${reEsc(t)}\\b`).test(blob);
    // (1) DEFINITION anchor: a significant token is DEFINED in this file (codegraph span) — validate line ∈ span.
    let drift = null; // a line-drift issue string if a def anchor's line is wrong
    let pass = false;
    for (const t of toks.filter(t => t.length >= 5)) {
      const nodes = (cgFind(t) || []).filter(n => n.filePath === path && n.startLine);
      if (!nodes.length) continue;
      if (nodes.some(n => line >= n.startLine && line <= n.endLine) || nearLine(t)) { pass = true; break; }
      const n = nodes[0];
      drift = drift || `anchor line drift: ${path}:${line} \`${t}\` — defined :${n.startLine}-${n.endLine} (re-author the anchor)`;
    }
    if (pass) continue;
    if (drift) { issues.push(drift); continue; }
    // (2) CALL-SITE / field / codegraph-unindexed: the symbol token must still be present in the cited file.
    if (toks.some(inFile)) continue;
    // (3) Not in the file → renamed/moved/deleted. codegraph (if present) says where it went.
    let moved = null;
    for (const t of toks.filter(t => t.length >= 5)) { const e = (cgFind(t) || []).find(n => n.filePath !== path); if (e) { moved = `anchor moved: \`${t}\` cited ${path}:${line}, now ${e.filePath}:${e.startLine}`; break; } }
    issues.push(moved || `anchor unresolved: ${path}:${line} \`${sym}\` — symbol not found in file`);
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
  try { const j = JSON.parse(sh(CFG.codegraph, ['status', '--json'])); return `${j.lastIndexed}:${j.nodeCount}:${j.edgeCount}`; }
  catch { return 'cg-unknown'; }
})();

// PER-CARD fingerprint: the curated half (frontmatter + anchors + prose) + the stat-signature of
// every file it points at (seeds + structured anchors) + the three globals. Any of these moving — a
// code edit (committed or not), a new commit, a memory note, a codegraph re-sync — misses the cache.
function fingerprint(curated, spec) {
  const deps = {};
  for (const s of spec.seeds || []) if (!isNoise(s)) deps[s] = statSig(s);
  for (const m of curated.matchAll(anchorRe())) {
    const p = m[1];
    if (!p.startsWith('http') && !p.startsWith('~') && !isNoise(p)) deps[p] = statSig(p);
  }
  // trimEnd the curated half: splice() normalizes trailing whitespace when it first appends the auto
  // block, so a fresh card's pre-write vs post-write curated differ only in trailing newlines — that
  // must not miss the cache. Trailing whitespace never affects a health/derive verdict.
  return sha(JSON.stringify({ curated: curated.replace(/\s+$/, ''), deps, head: gHead, memory: gMemory, cg: gCg }));
}

// ---- main ----
const allKeys = readdirSync(HERE).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
const unknown = only.filter(k => !allKeys.includes(k));
if (unknown.length) { console.error(`unknown card key(s): ${unknown.join(', ')} — known: ${allKeys.join(', ')}`); process.exit(2); }
const cards = readdirSync(HERE).filter(f => f.endsWith('.md') && (!only.length || only.includes(f.replace(/\.md$/, ''))));
const cache = loadCache();
let drift = 0, healthFail = 0;
for (const file of cards) {
  const path = join(HERE, file);
  const text = readFileSync(path, 'utf8');
  const { fm } = parseCard(text);
  const spec = { key: fm.key || file.replace(/\.md$/, ''), aliases: fm.aliases || [], seeds: fm.seeds || [], symbols: fm.symbols || [], memoryHub: fm.memoryHub };
  const tag = `[${spec.key}]`;
  const curated = text.split(START)[0]; // splice never touches this half → curated == next's curated half
  const fp = fingerprint(curated, spec);

  // INCREMENTAL SKIP: a cache entry exists ONLY for a fully-clean card, so a fingerprint match proves
  // the card is still fresh + healthy (identical inputs → identical deterministic derive). Skip the
  // costly deriveArc/Files/Lessons/Anchors + healthCheck entirely.
  if (cache[spec.key] === fp) { console.log(`${tag} ${mode === 'write' ? 'unchanged (cached)' : 'ok (cached)'}`); continue; }

  const data = { arc: deriveArc(spec), files: deriveFiles(spec), lessons: deriveLessons(spec), anchors: process.env.OKF_NO_CODEGRAPH ? null : deriveAnchors(spec) };
  const next = splice(text, render(spec, data));
  const health = healthCheck(next.split(START)[0], spec); // curated region only — the auto block's exists-column IS the data

  // Cache a card ONLY when it is fully clean at this fingerprint: healthy, and (for --check, which
  // doesn't rewrite) not drifted. --write refreshes the region, so post-write clean == healthy. A
  // drifted or unhealthy card is dropped from the cache so it always re-checks until resolved.
  if (!health.length && (mode === 'write' || next === text)) cache[spec.key] = fp; else delete cache[spec.key];

  if (mode === 'write') {
    if (next !== text) { writeFileSync(path, next); console.log(`${tag} regenerated (arc=${data.arc.length}, files=${data.files.length})`); }
    else console.log(`${tag} unchanged`);
    for (const h of health) console.log(`  ⚠ ${h}`);
  } else { // check
    if (next !== text) { console.error(`${tag} DRIFT: auto region is stale — run --write`); drift++; }
    for (const h of health) { console.error(`${tag} HEALTH: ${h}`); healthFail++; }
    if (next === text && !health.length) console.log(`${tag} ok`);
  }
}
saveCache(cache); // persist before any exit, so a failing --check still records the clean cards
if (mode === 'check') {
  // DRIFT is advisory (the auto region is regenerable); only a HEALTH failure means the
  // curated anchors may be WRONG — that is what blocks the commit.
  if (drift) console.error(`\n${drift} advisory DRIFT (auto region stale — non-blocking; run --write to refresh).`);
  if (healthFail) { console.error(`\n${healthFail} HEALTH failure(s) — blocking.`); process.exit(1); }
}
