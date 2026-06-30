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
//   node _generate.mjs --check [<key>...]   exit 1 if regenerating would change anything, or a
//                                           referenced path is missing (the pre-commit drift gate)

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
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

// ---- HEALTH: every repo path referenced in the card must exist (the drift detector) ----
function healthCheck(card) {
  const issues = [];
  const paths = new Set();
  for (const m of card.matchAll(/[`(\s]((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]+)/g)) paths.add(m[1]);
  for (const p of paths) {
    if (p.includes('*') || p.startsWith('http') || p.startsWith('~') || isNoise(p)) continue;
    if (!existsSync(join(REPO, p))) issues.push(`referenced path missing: ${p}`);
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

// ---- main ----
const cards = readdirSync(HERE).filter(f => f.endsWith('.md') && (!only.length || only.includes(f.replace(/\.md$/, ''))));
let drift = 0;
for (const file of cards) {
  const path = join(HERE, file);
  const text = readFileSync(path, 'utf8');
  const { fm } = parseCard(text);
  const spec = { key: fm.key || file.replace(/\.md$/, ''), aliases: fm.aliases || [], seeds: fm.seeds || [], symbols: fm.symbols || [], memoryHub: fm.memoryHub };
  const data = { arc: deriveArc(spec), files: deriveFiles(spec), lessons: deriveLessons(spec), anchors: process.env.OKF_NO_CODEGRAPH ? null : deriveAnchors(spec) };
  const next = splice(text, render(spec, data));
  const health = healthCheck(next.split(START)[0]); // curated region only — the auto block's exists-column IS the data
  const tag = `[${spec.key}]`;

  if (mode === 'write') {
    if (next !== text) { writeFileSync(path, next); console.log(`${tag} regenerated (arc=${data.arc.length}, files=${data.files.length})`); }
    else console.log(`${tag} unchanged`);
    for (const h of health) console.log(`  ⚠ ${h}`);
  } else { // check
    if (next !== text) { console.error(`${tag} DRIFT: auto region is stale — run --write`); drift++; }
    for (const h of health) { console.error(`${tag} HEALTH: ${h}`); drift++; }
    if (next === text && !health.length) console.log(`${tag} ok`);
  }
}
if (mode === 'check' && drift) { console.error(`\n${drift} drift/health issue(s).`); process.exit(1); }
