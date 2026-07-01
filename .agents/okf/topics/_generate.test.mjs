#!/usr/bin/env node
// Two contracts of _generate.mjs, exercised end-to-end against hermetic fixture topic dirs
// (OKF_TOPICS_DIR seam, codegraph off, no memory dir) so real exit codes / cache behaviour are
// tested, not a unit stub:
//
//   1. The `--check` drift gate exits 1 ONLY on a HEALTH failure (a seed/anchor file or symbol/
//      line moved — anchors may be wrong), NEVER on advisory auto-region DRIFT. (SKILL.md MODE-A.)
//   2. Incremental invalidation skips a card whose inputs are byte-identical to its last clean
//      derive — WITHOUT ever hiding a real break (no false-green).
//
//   run: node --test .agents/okf/topics/_generate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '_generate.mjs');
const START = '<!-- okf:auto-start -->';
const CARD = fm => `---\n${fm}\n---\n\n# card\n\nprose.\n`;

// Build a hermetic OKF root: <root>/okf.config.json + <root>/topics/<cards> + optional repo files
// (repoRoot '.' → seeds/anchors resolve under <root>). Codegraph and the memory dir are absent so
// every derive is deterministic. Returns the root + topics dir + a helper to (re)write repo files.
function fixture(cards, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'okf-'));
  const topics = join(root, 'topics');
  mkdirSync(topics);
  writeFileSync(join(root, 'okf.config.json'),
    JSON.stringify({ repoRoot: '.', memoryDir: join(root, '__absent__'), noise: [], codegraph: null }));
  for (const [name, body] of Object.entries(cards)) writeFileSync(join(topics, name), body);
  const putFile = (rel, body) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
  for (const [rel, body] of Object.entries(files)) putFile(rel, body);
  return { root, topics, putFile, card: name => join(topics, name) };
}

// Run the real gate; return { code, out } (out = stdout+stderr). Codegraph off; cache on unless overridden.
function exec(topics, mode, extraEnv = {}) {
  const env = { ...process.env, OKF_TOPICS_DIR: topics, OKF_NO_CODEGRAPH: '1', ...extraEnv };
  try { return { code: 0, out: execFileSync('node', [SCRIPT, mode], { env, encoding: 'utf8', stdio: 'pipe' }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}
const run = (topics, mode, extraEnv) => exec(topics, mode, extraEnv).code;

// ---- 1. the DRIFT-vs-HEALTH gate contract ----

test('advisory DRIFT alone does NOT block the gate (exit 0)', () => {
  // No auto region on disk → regenerating appends one → next !== text → DRIFT.
  // No seeds and no anchors → HEALTH is clean. The gate must NOT block on drift alone.
  const { topics } = fixture({ 'a.md': CARD('key: a\naliases: [alpha]') });
  assert.equal(run(topics, '--check'), 0, 'stale auto-region is advisory, must not exit 1');
});

test('HEALTH failure blocks the gate (exit 1)', () => {
  // A missing seed is a HEALTH failure. --write first makes the auto region fresh (drift=0),
  // isolating that HEALTH alone still exits 1.
  const { topics } = fixture({ 'b.md': CARD('key: b\nseeds: [does/not/exist.ts]') });
  run(topics, '--write');
  assert.equal(run(topics, '--check'), 1, 'a missing seed must block the commit');
});

test('fresh + healthy card is clean (exit 0)', () => {
  const { topics } = fixture({ 'c.md': CARD('key: c\naliases: [gamma]') });
  run(topics, '--write'); // make the auto region fresh
  assert.equal(run(topics, '--check'), 0, 'no drift + no health issue → clean');
});

// ---- 2. incremental invalidation ----

test('an unchanged card is served from cache, not re-derived', () => {
  // --write leaves the card fresh + healthy and caches its fingerprint; the next --check must hit
  // the cache (marked "(cached)") instead of re-deriving. This is the whole point of the feature.
  const { topics } = fixture({ 'f.md': CARD('key: f\naliases: [foo]') });
  run(topics, '--write');
  assert.match(exec(topics, '--check').out, /\[f\] ok \(cached\)/, 'unchanged card must be cache-served');
});

test('a cached card whose seed is deleted is still caught (no false-green)', () => {
  // The dangerous direction: a stale cache must NEVER hide a real break. Cache the clean card,
  // then delete a dep it points at — invalidation must fire and the gate must still exit 1.
  const { topics, root } = fixture({ 'g.md': CARD('key: g\nseeds: [src/keep.ts]') }, { 'src/keep.ts': 'export const x = 1;\n' });
  run(topics, '--write');                      // caches g as clean (seed present)
  rmSync(join(root, 'src/keep.ts'));           // break the dependency
  assert.equal(run(topics, '--check'), 1, 'deleting a cached card\'s seed must invalidate and block');
});

test('a cached card given a broken anchor is still caught (no false-green)', () => {
  // Editing the CURATED half (adding an anchor to a missing file) must invalidate the cache.
  const { topics, card } = fixture({ 'h.md': CARD('key: h\naliases: [hoo]') });
  run(topics, '--write');                       // caches h as clean
  const t = readFileSync(card('h.md'), 'utf8');
  writeFileSync(card('h.md'), t.replace(START, '`src/ghost.ts:1` — `Ghost`\n\n' + START));
  assert.equal(run(topics, '--check'), 1, 'a new anchor to a missing file must invalidate and block');
});
