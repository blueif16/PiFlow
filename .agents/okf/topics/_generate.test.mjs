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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
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

// ---- 3. --find: the standalone ranked reader (node only, no piflowctl) — the portability primitive ----
// The scoring itself is unit-tested in packages/cli/test/rank.test.ts (the pure `_rank.mjs`); these prove
// the ENGINE wiring — that `.agents/okf/` alone answers a query end-to-end as a subprocess.

function find(topics, args) {
  const env = { ...process.env, OKF_TOPICS_DIR: topics, OKF_NO_CODEGRAPH: '1' };
  try { return { code: 0, out: execFileSync('node', [SCRIPT, '--find', ...args], { env, encoding: 'utf8', stdio: 'pipe' }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}

test('--find --json ranks the card that OWNS the query first', () => {
  const { topics } = fixture({
    'sandbox.md': CARD('key: sandbox\ntitle: The jail\naliases: [jail, seatbelt]'),
    'runner.md': CARD('key: runner\ntitle: Runner\nsymbols: [runWorkflow]'),
  });
  const ranked = JSON.parse(find(topics, ['--json', 'jail']).out.trim());
  assert.equal(ranked[0].key, 'sandbox', 'the card owning the alias "jail" ranks first');
});

test('bare --find lists the slices and never the _-prefixed engine files', () => {
  const { topics } = fixture({ 'sandbox.md': CARD('key: sandbox'), 'runner.md': CARD('key: runner'), '_engine.md': CARD('key: _engine') });
  const { out } = find(topics, []);
  assert.match(out, /sandbox/);
  assert.match(out, /runner/);
  assert.doesNotMatch(out, /_engine/, '_-prefixed files are engine, not slices');
});

test('--find on an uncovered query reports the gap, never invents a slice', () => {
  const { topics } = fixture({ 'sandbox.md': CARD('key: sandbox\naliases: [jail]') });
  const { out } = find(topics, ['stripe', 'payment', 'webhooks']);
  assert.match(out, /UNCOVERED/i);
  assert.doesNotMatch(out, /# sandbox/, 'an uncovered query must not crown a card');
});

// ---- 4. --reconcile coverage rung: UNCOVERED-CENTRAL (codegraph fan-in) beside UNCOVERED-HOT (churn) ----
// Exercised end-to-end against a hermetic GIT repo (controls churn) + a FAKE codegraph (controls each
// file's in-degree), so {uncovered file, in-degree, churn} are fed as controlled inputs — NO dependence
// on the live index. UNCOVERED-CENTRAL must fire on a high-fan-in uncovered file REGARDLESS of churn;
// UNCOVERED-HOT (churn) must be unchanged; instrument paths and low-fan-in leaves must stay silent.

// A fake `codegraph` executable answering only the subcommands --reconcile makes. File in-degree comes
// from a baked {path: usedByN} map, so `node <file> --symbols-only` returns a controlled count.
function fakeCodegraph(root, indeg) {
  const p = join(root, 'fake-codegraph.mjs');
  writeFileSync(p, `#!/usr/bin/env node
const a = process.argv.slice(2), INDEG = ${JSON.stringify(indeg)};
if (a[0] === 'status') { process.stdout.write(JSON.stringify({ lastIndexed: 't', nodeCount: 1, edgeCount: 1, pendingChanges: { added: 0, modified: 0, removed: 0 } })); process.exit(0); }
if (a[0] === 'node') { process.stdout.write(\`**\${a[1]}** — 1 symbols, used by \${INDEG[a[1]] || 0} files: x\\n\`); process.exit(0); }
if (a[0] === 'query') { process.stdout.write('[]'); process.exit(0); }
if (a[0] === 'impact') { process.stdout.write(JSON.stringify({ affected: [] })); process.exit(0); }
process.exit(0);
`);
  chmodSync(p, 0o755);
  return p;
}

// A hermetic OKF root that is ALSO a git repo, codegraph ON (pointed at the fake). Commit counts drive
// churn; `indeg` drives centrality. One card owns NONE of the fixture files, so every one is uncovered.
function reconcileFixture() {
  const root = mkdtempSync(join(tmpdir(), 'okf-recon-'));
  const topics = join(root, 'topics');
  mkdirSync(topics);
  const fake = fakeCodegraph(root, {
    'src/hub.ts': 5,       // clearly central
    'src/edge.ts': 2,      // exactly at the threshold (the >= boundary)
    'src/leaf.ts': 1,      // below the threshold
    'src/churny.ts': 1,    // low centrality, but churn-hot
    'scripts/tool.ts': 9,  // very central AND churn-hot — but instrument-excluded
  });
  writeFileSync(join(root, 'okf.config.json'), JSON.stringify({
    repoRoot: '.', memoryDir: join(root, '__absent__'), noise: [], codegraph: fake, coverageExclude: ['scripts/'],
  }));
  writeFileSync(join(topics, 'misc.md'), CARD('key: misc\naliases: [misc]'));

  const put = (rel, body) => { const fp = join(root, rel); mkdirSync(dirname(fp), { recursive: true }); writeFileSync(fp, body); };
  const G = args => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: 'pipe' });
  G(['init', '-q', '-b', 'main']);
  const all = ['src/hub.ts', 'src/edge.ts', 'src/leaf.ts', 'src/churny.ts', 'scripts/tool.ts'];
  for (const f of all) put(f, 'export const v = 1;\n');
  G(['add', ...all]); G(['commit', '-q', '-m', 'c1']);                         // every file: churn 1
  for (const n of [2, 3]) {                                                    // churny + tool: churn 3
    for (const f of ['src/churny.ts', 'scripts/tool.ts']) put(f, `export const v = ${n};\n`);
    G(['add', 'src/churny.ts', 'scripts/tool.ts']); G(['commit', '-q', '-m', `c${n}`]);
  }
  return { topics };
}

// Run the reconcile pass ONCE with codegraph ON (cache off so the coverage rung always recomputes);
// memoized so the git + subprocess cost is paid a single time and shared across the assertions below.
let _reconOut;
function reconcile() {
  if (_reconOut != null) return _reconOut;
  const { topics } = reconcileFixture();
  const env = { ...process.env, OKF_TOPICS_DIR: topics, OKF_NO_CACHE: '1' };
  try { _reconOut = execFileSync('node', [SCRIPT, '--reconcile'], { env, encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { _reconOut = (e.stdout || '') + (e.stderr || ''); }
  return _reconOut;
}

test('UNCOVERED-CENTRAL fires on a high-fan-in uncovered file, regardless of churn', () => {
  // src/hub.ts: in-degree 5, committed ONCE (churn 1, below the HOT floor) — the whole point: a central
  // file the churn-gated HOT rung can never see. This assertion FAILS when the signal is absent (RED).
  const out = reconcile();
  assert.match(out, /UNCOVERED-CENTRAL: src\/hub\.ts \(in-degree 5/, 'a central low-churn file must be flagged');
  assert.doesNotMatch(out, /UNCOVERED-HOT: src\/hub\.ts/, 'hub is low-churn — a CENTRAL find, not a HOT one');
});

test('a file exactly at the centrality threshold fires (the >= boundary)', () => {
  // src/edge.ts: in-degree 2 == CENTRALITY_MIN_INDEGREE. Catches the comparator mutation `>=`→`>`
  // (edge would then fall silent).
  assert.match(reconcile(), /UNCOVERED-CENTRAL: src\/edge\.ts \(in-degree 2/, 'in-degree == threshold must fire under >=');
});

test('UNCOVERED-CENTRAL does NOT fire on a below-threshold leaf', () => {
  // src/leaf.ts: in-degree 1 < threshold. Catches a mutation that drops/weakens the threshold so the
  // rung fires on everything.
  assert.doesNotMatch(reconcile(), /UNCOVERED-CENTRAL: src\/leaf\.ts/, 'a below-threshold leaf must stay silent');
});

test('UNCOVERED-HOT still fires on a churn-hot file (no regression)', () => {
  // src/churny.ts: 3 commits, in-degree 1. The existing churn signal must be untouched by the new rung.
  const out = reconcile();
  assert.match(out, /UNCOVERED-HOT: src\/churny\.ts \(3 recent commits/, 'the churn rung must still fire');
  assert.doesNotMatch(out, /UNCOVERED-CENTRAL: src\/churny\.ts/, 'churny is low-centrality — not a CENTRAL find');
});

test('an instrument-path file is excluded from BOTH signals even when central + hot', () => {
  // scripts/tool.ts: in-degree 9 AND 3 commits — would fire both rungs if not excluded. The
  // instrument-exclusion rule (shared tooling is skill-documented, never card material) must hold for
  // the new rung too. Catches a CENTRAL rung that re-enumerates files bypassing `excl`.
  assert.doesNotMatch(reconcile(), /scripts\/tool\.ts/, 'an excluded instrument path must never be flagged');
});
