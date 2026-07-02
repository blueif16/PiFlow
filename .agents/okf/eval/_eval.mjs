#!/usr/bin/env node
// E6 retrieval eval — scores the FIND ranker against golden.json, with `codegraph explore` as the
// HONEST baseline arm (the alternative an agent would actually use, not a strawman subagent re-map).
//
// Arms per case:
//   FIND    — drives the real CLI surface (`node packages/cli/dist/cli.js understand <query>`); a hit
//             is the expected card as the TOP match (or an UNCOVERED verdict when expected).
//   EXPLORE — `codegraph explore "<query>"`; a hit is the case's primaryFile appearing in the output.
//             Negatives are N/A for this arm (explore always returns something).
// Both arms also record output size (chars/4 ≈ tokens) — the context-cost half of the comparison.
//
// This is an EVAL, not a gate: it always exits 0 and prints the verdict table; wire a threshold only
// after baselines exist (a threshold invented before the first measurement is theater). Never edit a
// golden expectation to make a run pass — fix the ranker or the cards (test-discipline Iron Law).
//
// Usage: node _eval.mjs [--golden <path>]   (run from anywhere inside the repo)

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const goldenPath = process.argv.includes('--golden')
  ? resolve(process.argv[process.argv.indexOf('--golden') + 1])
  : join(HERE, 'golden.json');
const { cases } = JSON.parse(readFileSync(goldenPath, 'utf8'));

const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};
const CLI = join(REPO, 'packages', 'cli', 'dist', 'cli.js');
const tok = (s) => Math.round(s.length / 4);

const rows = [];
for (const c of cases) {
  // FIND arm — parse the verb's real output: `# <key>  —  <title>` or the UNCOVERED message.
  const findOut = run('node', [CLI, 'understand', ...c.query.split(/\s+/)]);
  const topKey = findOut.match(/^# (\S+)/m)?.[1] ?? (findOut.includes('UNCOVERED') ? 'UNCOVERED' : '(unparsed)');
  const findHit = topKey === c.expect;
  // EXPLORE arm — negatives are N/A (explore has no "uncovered" concept).
  let expHit = null, expTok = null;
  if (c.expect !== 'UNCOVERED') {
    const expOut = run('codegraph', ['explore', c.query]);
    expHit = c.primaryFile ? expOut.includes(c.primaryFile) : null;
    expTok = tok(expOut);
  }
  rows.push({ class: c.class, query: c.query, expect: c.expect, got: topKey, findHit, findTok: tok(findOut), expHit, expTok });
}

// ---- report ----
const classes = [...new Set(rows.map(r => r.class))];
const pct = (hits, n) => n ? `${hits}/${n} (${Math.round(100 * hits / n)}%)` : 'n/a';
console.log('E6 retrieval eval — FIND (card ranker via CLI) vs EXPLORE (codegraph baseline)\n');
for (const r of rows.filter(r => !r.findHit))
  console.log(`  MISS [${r.class}] "${r.query}" — expected ${r.expect}, got ${r.got}`);
console.log('\nclass      FIND hits        EXPLORE hits     med FIND tok   med EXPLORE tok');
const med = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
for (const cl of classes) {
  const g = rows.filter(r => r.class === cl);
  const e = g.filter(r => r.expHit !== null);
  console.log(`${cl.padEnd(10)} ${pct(g.filter(r => r.findHit).length, g.length).padEnd(16)} ${pct(e.filter(r => r.expHit).length, e.length).padEnd(16)} ${String(med(g.map(r => r.findTok))).padEnd(14)} ${med(g.map(r => r.expTok)) ?? 'n/a'}`);
}
const all = rows.filter(r => r.expect !== 'UNCOVERED');
const neg = rows.filter(r => r.expect === 'UNCOVERED');
console.log(`\nTOTAL positive: FIND ${pct(all.filter(r => r.findHit).length, all.length)} · EXPLORE ${pct(all.filter(r => r.expHit).length, all.length)}`);
console.log(`NEGATIVE controls (must return UNCOVERED): ${pct(neg.filter(r => r.findHit).length, neg.length)}`);
console.log('\nVerdict guide: FIND must beat EXPLORE on concept-class hits AND hold >=90% on file+symbol,');
console.log('at materially lower tokens — otherwise the card layer is not earning its curation cost there.');
