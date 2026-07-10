// optimize/substrate/fix.ts + events.ts — the M6 FIX phase, WS0 candidate-as-git-worktree model
// (docs/design/optimize-issue-lifecycle-redesign.md). Every test FAILS when the code is wrong (proven by the
// §4 mutation drills on the fence / editsApplied / the oracle diff-guard). No live claude/pi spawn: the fixer
// agent, the child prove-run, and the measure pass are all injected seams; prepareCandidateWorktree /
// commitCandidate / adoptSubstrateManifest run against a THROWAWAY git repo created per test in a temp dir.
//
// Run: npx vitest run packages/core/test/optimize-substrate-fix.test.ts

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  fixIssue,
  adoptSubstrateManifest,
  reproveCandidate,
  prepareCandidateWorktree,
  removeCandidateWorktree,
  commitCandidate,
  oracleTouchedByDiff,
  collectWorkspaceRefs,
  readClosureRefs,
  foldGradedDelta,
  buildFixerPrompt,
  readSubstrateManifest,
  scanRecords,
  issueLifecycleDir,
  verifyStage,
  UNPROVEN_BY_RUN,
  type SubstrateManifest,
  type SubstrateManifestRecord,
} from '../src/optimize/substrate/fix.js';
import { renderSubstrateEvent, safeEmit, type SubstrateEvent } from '../src/optimize/substrate/events.js';
import { computeIssueId, writeIssueFile, parseIssueFile, transitionIssue, type Issue } from '../src/optimize/substrate/issues.js';
import type { RunBaseAgentOpts, RunBaseAgentResult } from '../src/optimize/substrate/agent.js';
import type { SpawnChildRunResult } from '../src/optimize/substrate/child-run.js';
import type { MeasureReport } from '../src/optimize/substrate/measure.js';

const tmpDirs: string[] = [];
const scratch = async (prefix = 'piflow-fix-'): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function initGitRepo(dir: string): void {
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'test@piflow.dev');
  git('config', 'user.name', 'piflow test');
  git('config', 'commit.gpgsign', 'false');
}

/** Make `dir` a committed git repo AND register its sibling optimize-worktree base for cleanup. */
function seedGitRepo(dir: string): void {
  initGitRepo(dir);
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'seed'], { stdio: ['ignore', 'pipe', 'pipe'] });
  tmpDirs.push(join(dirname(dir), '.piflow-optimize-worktrees', basename(dir)));
}

const headOf = (repo: string): string => execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();

// ── shared fakes ────────────────────────────────────────────────────────────────────────────────────────
const okStatus = () =>
  ({ id: 'agent', label: 'agent', status: 'ok', artifacts: [], issues: [] }) as unknown as RunBaseAgentResult['status'];
const agentResult = (): RunBaseAgentResult => ({ status: okStatus(), text: '' });
const measureReport = (graded: Record<string, number>): MeasureReport => ({ node: 'gameplay', graded }) as unknown as MeasureReport;
const childResult = (childId: string, childDir: string): SpawnChildRunResult => ({ childId, childDir } as unknown as SpawnChildRunResult);

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: computeIssueId('gameplay', 'gameplay::compose-in-thinking'),
    name: 'soggy-crust',
    title: 'compose() thinks 9-13s before writing',
    severity: 'high',
    status: 'open',
    reason: null,
    sig: 'gameplay::compose-in-thinking',
    firstSeen: '260706-01',
    lastSeen: '260706-01',
    attempts: [],
    body: 'The compose step burns long thinking spans before any tool call.\n',
    ...overrides,
  };
}

/** A gameplay fixture: template (node.json + one open issue), a GIT-REPO workspace (readScope files + a measure
 *  script living INSIDE a readScope dir), and a parent run carrying a base graded measure report. The workspace
 *  is a committed git repo because the candidate is now a git WORKTREE branched from its HEAD (WS0). */
async function setupFixture(opts: { baseGraded?: Record<string, number> } = {}) {
  const templateDir = await scratch('piflow-tpl-');
  const workspace = await scratch('piflow-ws-');
  const parentRunDir = await scratch('piflow-run-');
  const nodeDir = join(templateDir, 'nodes', 'gameplay');
  await fs.mkdir(join(nodeDir, 'issues'), { recursive: true });
  await fs.writeFile(
    join(nodeDir, 'node.json'),
    JSON.stringify(
      {
        label: 'gameplay',
        contract: { artifacts: [], owns: [], readScope: ['{{WORKSPACE}}/templates', '{{WORKSPACE}}/eval'] },
        optimize: {
          // the scorer script lives INSIDE the readScope `eval` dir — the diff guard must catch an edit to it.
          measure: [{ id: 'feas', run: { cmd: 'node', args: ['{{WORKSPACE}}/eval/check.mjs'] }, writes: ['optimize/substrate/x.json'] }],
        },
      },
      null,
      2,
    ),
  );
  await fs.mkdir(join(workspace, 'templates'), { recursive: true });
  await fs.writeFile(join(workspace, 'templates', 'genres.json'), '{"a":1}\n');
  await fs.mkdir(join(workspace, 'eval'), { recursive: true });
  await fs.writeFile(join(workspace, 'eval', 'check.mjs'), '// the scorer — must NEVER be edited by a candidate\n');
  await fs.writeFile(join(workspace, 'eval', 'data.json'), '{"kept":true}\n'); // a non-oracle eval file
  seedGitRepo(workspace);

  const issuePath = join(nodeDir, 'issues', 'soggy-crust.md');
  await writeIssueFile(issuePath, makeIssue());

  if (opts.baseGraded) {
    await fs.mkdir(join(parentRunDir, 'optimize', 'substrate'), { recursive: true });
    await fs.writeFile(
      join(parentRunDir, 'optimize', 'substrate', 'measure.gameplay.json'),
      JSON.stringify({ graded: opts.baseGraded }, null, 2),
    );
  }
  return { templateDir, workspace, parentRunDir, issuePath };
}

/** A fixer that appends bytes to a worktree file (a real, git-visible edit). */
const editingAgent = async (o: { cwd: string }): Promise<RunBaseAgentResult> => {
  await fs.appendFile(join(o.cwd, 'templates', 'genres.json'), '\n// fixed\n');
  return agentResult();
};
/** A fixer that touches nothing (a no-op proposal → editsApplied 0). */
const noopAgent = async (): Promise<RunBaseAgentResult> => agentResult();

/** Give the gameplay node a soft bar under `optimize.<key>` (criteria OR the judge alias) so nodeHasCriteria is
 *  true and the SOFT gate-agent path is reachable. Default `criteria` (the WS3 spelling). */
async function setSoftBar(templateDir: string, key: 'criteria' | 'judge' = 'criteria'): Promise<void> {
  const p = join(templateDir, 'nodes', 'gameplay', 'node.json');
  const nj = JSON.parse(await fs.readFile(p, 'utf8'));
  nj.optimize[key] = '{{WORKSPACE}}/skills/judge.md';
  await fs.writeFile(p, JSON.stringify(nj, null, 2));
}

/** Set the node's optimize.verifyDefault tier on disk. */
async function setVerifyDefault(templateDir: string, tier: string): Promise<void> {
  const p = join(templateDir, 'nodes', 'gameplay', 'node.json');
  const nj = JSON.parse(await fs.readFile(p, 'utf8'));
  nj.optimize.verifyDefault = tier;
  await fs.writeFile(p, JSON.stringify(nj, null, 2));
}

// ── events.ts ───────────────────────────────────────────────────────────────────────────────────────────
describe('events — renderSubstrateEvent + safeEmit', () => {
  const ALL: SubstrateEvent[] = [
    { type: 'issue-activated', issue: 'soggy-crust', node: 'gameplay' },
    { type: 'candidate-prepared', issue: 'soggy-crust', candidateRef: '/c', included: 2, excluded: 1 },
    { type: 'fixer-started', issue: 'soggy-crust' },
    { type: 'fixer-done', issue: 'soggy-crust', editsApplied: 3 },
    { type: 'prove-started', issue: 'soggy-crust', childId: 'tS2.gameplay' },
    { type: 'measured', issue: 'soggy-crust', sharedKeys: 2 },
    { type: 'gated', issue: 'soggy-crust', accept: true, reason: 'strict improvement (+1)' },
    { type: 'staged', issue: 'soggy-crust', decision: 'staged', manifestPath: '/m.json' },
    { type: 'adopted', issue: 'soggy-crust', commit: 'abc1234', files: 2 },
    { type: 'stopped', issue: 'soggy-crust', reason: 'staged for adopt' },
  ];

  it('renders one non-empty, issue-tagged line per variant, each carrying its payload', () => {
    for (const e of ALL) {
      const line = renderSubstrateEvent(e);
      expect(line).toContain('soggy-crust');
      expect(line.length).toBeGreaterThan(e.type.length);
    }
    expect(renderSubstrateEvent(ALL[3])).toContain('edits=3');
    expect(renderSubstrateEvent(ALL[4])).toContain('tS2.gameplay');
    expect(renderSubstrateEvent(ALL[6])).toMatch(/accept ✓/);
    expect(renderSubstrateEvent({ type: 'gated', issue: 'x', accept: false, reason: 'no edit applied' })).toMatch(/reject ✗/);
    expect(renderSubstrateEvent(ALL[8])).toContain('commit=abc1234');
  });

  it('safeEmit forwards to the sink, swallows a throwing sink, and no-ops on undefined', () => {
    const seen: SubstrateEvent[] = [];
    safeEmit((e) => seen.push(e), ALL[0]);
    expect(seen).toEqual([ALL[0]]);
    expect(() => safeEmit(() => { throw new Error('broken stdout'); }, ALL[0])).not.toThrow();
    expect(() => safeEmit(undefined, ALL[0])).not.toThrow();
  });
});

// ── collectWorkspaceRefs ──────────────────────────────────────────────────────────────────────────────────
describe('collectWorkspaceRefs — {{WORKSPACE}} ref extraction (mechanical)', () => {
  it('extracts refs from strings (incl. embedded in an arg), recurses arrays/objects, ignores bare {{WORKSPACE}}', () => {
    const refs = collectWorkspaceRefs({
      a: '{{WORKSPACE}}/templates/genres.json',
      b: ['--out', '{{WORKSPACE}}/eval/check.mjs', 'plain'],
      c: { d: 'prefix {{WORKSPACE}}/src/x.mjs suffix' },
      bare: '{{WORKSPACE}}', // the whole product root — never a fence/guard target
      none: 'no token here',
    });
    expect([...refs].sort()).toEqual(['eval/check.mjs', 'src/x.mjs', 'templates/genres.json']);
  });

  it('normalizes redundant separators and drops workspace-escaping / empty paths', () => {
    const refs = collectWorkspaceRefs(['{{WORKSPACE}}/a//b/', '{{WORKSPACE}}/../escape', '{{WORKSPACE}}/']);
    expect([...refs]).toEqual(['a/b']);
  });
});

// ── WS3: readClosureRefs — the shared bar (criteria OR the judge alias) is an oracle exclusion ──────────────
describe('readClosureRefs — excludes BOTH optimize.criteria and the optimize.judge alias (WS3)', () => {
  it('drops criteria + judge {{WORKSPACE}} refs from the fence include set (both are oracle)', async () => {
    const templateDir = await scratch('piflow-tpl-');
    const nodeDir = join(templateDir, 'nodes', 'gameplay');
    await fs.mkdir(nodeDir, { recursive: true });
    await fs.writeFile(join(nodeDir, 'node.json'), JSON.stringify({
      contract: { readScope: ['{{WORKSPACE}}/templates'] },
      optimize: {
        measure: [{ id: 'm', run: { cmd: 'node', args: ['{{WORKSPACE}}/eval/check.mjs'] } }],
        criteria: '{{WORKSPACE}}/skills/criteria.md',
        judge: '{{WORKSPACE}}/skills/legacy-judge.md',
      },
    }));
    const { include, exclude } = await readClosureRefs(templateDir, 'gameplay');
    expect(include).toEqual(['templates']);
    expect(exclude.sort()).toEqual(['eval/check.mjs', 'skills/criteria.md', 'skills/legacy-judge.md']);
  });
});

// ── WS0 behavior 1: prepareCandidateWorktree ──────────────────────────────────────────────────────────────
describe('prepareCandidateWorktree — a git worktree candidate at HEAD (WS0 behavior 1)', () => {
  it('creates a per-attempt worktree on branch optimize/<node>/<issue>/attempt-N at HEAD; baseSha = HEAD', async () => {
    const repo = await scratch('piflow-repo-');
    await fs.writeFile(join(repo, 'a.txt'), 'a');
    seedGitRepo(repo);
    const head = headOf(repo);

    const wt = await prepareCandidateWorktree(repo, { node: 'gameplay', issue: 'soggy-crust', attempt: 2 });
    expect(wt.baseSha).toBe(head);
    expect(wt.branch).toBe('optimize/gameplay/soggy-crust/attempt-2');
    // the worktree is a real checkout at HEAD, OUTSIDE the repo tree, holding the committed file.
    expect(wt.worktreeDir.startsWith(`${repo}/`)).toBe(false);
    expect(await fs.readFile(join(wt.worktreeDir, 'a.txt'), 'utf8')).toBe('a');
    // a fresh -B branch reset to HEAD resolves to baseSha.
    expect(execFileSync('git', ['-C', repo, 'rev-parse', wt.branch]).toString().trim()).toBe(head);
    removeCandidateWorktree(repo, wt.worktreeDir);
  });
});

// ── WS0 behavior 3: commitCandidate (git commit → candidateSha; editsApplied = diff name-count) ────────────
describe('commitCandidate — git commit → candidateSha; editsApplied = diff name-count (WS0 behavior 3)', () => {
  it('commits the fixer edits (subject+trailer) and returns candidateSha + changed files; a no-op makes NO commit', async () => {
    const repo = await scratch('piflow-repo-');
    await fs.writeFile(join(repo, 'a.txt'), 'a');
    seedGitRepo(repo);
    const wt = await prepareCandidateWorktree(repo, { node: 'gameplay', issue: 'soggy-crust', attempt: 1 });
    const ref = { node: 'gameplay', name: 'soggy-crust', id: makeIssue().id, title: 'compose too long' };

    // no edit → no commit, candidateSha undefined, changed []
    const noop = commitCandidate(wt.worktreeDir, wt.baseSha, ref);
    expect(noop.candidateSha).toBeUndefined();
    expect(noop.changed).toEqual([]);

    // two edits → one commit, changed lists both (editsApplied = 2)
    await fs.appendFile(join(wt.worktreeDir, 'a.txt'), '-CHANGED');
    await fs.writeFile(join(wt.worktreeDir, 'b.txt'), 'b');
    const c = commitCandidate(wt.worktreeDir, wt.baseSha, ref);
    expect(c.candidateSha).toBeDefined();
    expect(c.changed.sort()).toEqual(['a.txt', 'b.txt']);
    // the commit carries the greppable subject + Issue trailer, so a later cherry-pick preserves the identity.
    const body = execFileSync('git', ['-C', wt.worktreeDir, 'log', '-1', '--format=%B']).toString();
    expect(body).toContain('optimize(gameplay): compose too long');
    expect(body).toContain('Issue: gameplay/soggy-crust');
    removeCandidateWorktree(repo, wt.worktreeDir);
  });
});

// ── Defect 3: commitCandidate must not fail on a headless host with NO git identity ─────────────────────────
describe('commitCandidate — succeeds on a headless host with NO git identity (Defect 3)', () => {
  it('injects an optimizer identity so `commit` never fails with "who are you" on a CI/cloud host', async () => {
    const repo = await scratch('piflow-repo-');
    await fs.writeFile(join(repo, 'a.txt'), 'a');
    seedGitRepo(repo); // the SEED commit is made with the test identity
    const wt = await prepareCandidateWorktree(repo, { node: 'gameplay', issue: 'soggy-crust', attempt: 1 });
    const ref = { node: 'gameplay', name: 'soggy-crust', id: makeIssue().id, title: 'x' };
    await fs.appendFile(join(wt.worktreeDir, 'a.txt'), '-CHANGED');

    // simulate a headless host: strip ALL config identity AND forbid git's user@host auto-detection.
    const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
    g('config', '--unset', 'user.name');
    g('config', '--unset', 'user.email');
    g('config', 'user.useConfigOnly', 'true');

    const envKeys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
    const saved: Record<string, string | undefined> = {};
    for (const k of envKeys) saved[k] = process.env[k];
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[k];
    try {
      const c = commitCandidate(wt.worktreeDir, wt.baseSha, ref); // RED before the fix: throws "Please tell me who you are"
      expect(c.candidateSha).toBeDefined();
      expect(c.changed).toEqual(['a.txt']);
    } finally {
      for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      removeCandidateWorktree(repo, wt.worktreeDir);
    }
  });
});

// ── WS0 behavior 4: the oracle diff-guard (pure fn) ───────────────────────────────────────────────────────
describe('oracleTouchedByDiff — the diff guard (pure) (WS0 behavior 4)', () => {
  it('true iff a changed path is an oracle path (exact or under an excluded dir); empty exclude never trips', () => {
    expect(oracleTouchedByDiff(['templates/genres.json'], ['eval/check.mjs'])).toBe(false);
    expect(oracleTouchedByDiff(['eval/check.mjs'], ['eval/check.mjs'])).toBe(true); // exact
    expect(oracleTouchedByDiff(['skills/judge.md'], ['skills'])).toBe(true); // under an excluded dir
    expect(oracleTouchedByDiff(['skillset/x'], ['skills'])).toBe(false); // 'skillset' is not under 'skills/'
    expect(oracleTouchedByDiff(['eval/check.mjs'], [])).toBe(false); // no oracle declared → can't be touched
  });
});

// ── foldGradedDelta — the accept signal (M6.3) ────────────────────────────────────────────────────────────
describe('foldGradedDelta — multi-key graded comparison folded to evaluateGate scalars', () => {
  it('≥1 shared key improves and none regress ⇒ (base 0, candidate +1) = accept', () => {
    const f = foldGradedDelta({ score: 0.5, other: 1 }, { score: 0.9, other: 1 });
    expect(f.sharedKeys).toBe(2);
    expect([f.base, f.candidate]).toEqual([0, 1]);
    expect(f.deltaSummary).toEqual({ score: expect.closeTo(0.4, 6), other: 0 });
  });

  it('any key regresses beyond tolerance ⇒ (0, −1) = reject', () => {
    const f = foldGradedDelta({ a: 1, b: 1 }, { a: 2, b: 0.5 }); // a up, b down
    expect([f.base, f.candidate]).toEqual([0, -1]);
    expect(f.regressed).toBe(true);
  });

  it('all flat ⇒ (0, 0) = reject (no improvement)', () => {
    expect(foldGradedDelta({ a: 1 }, { a: 1 })).toMatchObject({ base: 0, candidate: 0, improved: false, regressed: false });
  });

  it('no shared keys ⇒ (null, null) = unmeasurable (routes to a human)', () => {
    expect(foldGradedDelta({ a: 1 }, { b: 2 })).toMatchObject({ base: null, candidate: null, sharedKeys: 0 });
  });

  it('lowerIsBetter INVERTS direction (a drop is an improvement)', () => {
    const higher = foldGradedDelta({ ms: 100 }, { ms: 60 });
    expect(higher.candidate).toBe(-1); // default higher-better: a drop looks like a regression
    const lower = foldGradedDelta({ ms: 100 }, { ms: 60 }, { lowerIsBetter: (k) => k === 'ms' });
    expect(lower.candidate).toBe(1); // ms down IS the win
  });

  it('tolerance absorbs a small regression below the margin', () => {
    expect(foldGradedDelta({ a: 1, b: 1 }, { a: 1.5, b: 0.95 }, { tolerance: 0.1 }).candidate).toBe(1); // b's −0.05 within tol
    expect(foldGradedDelta({ a: 1, b: 1 }, { a: 1.5, b: 0.8 }, { tolerance: 0.1 }).candidate).toBe(-1); // b's −0.2 exceeds tol
  });
});

// ── buildFixerPrompt — the fix contract's load-bearing lines ─────────────────────────────────────────────
describe('buildFixerPrompt — issue-as-dispatch + a root-cause / no-oracle / no-commit contract', () => {
  it('embeds the issue file verbatim and pins the MUST-NOT-commit / MUST-NOT-edit-oracle / root-cause rules', () => {
    const p = buildFixerPrompt('---\ntitle: X\n---\nISSUE-BODY-MARKER-9', 'gameplay');
    expect(p).toContain('ISSUE-BODY-MARKER-9');
    expect(p).toMatch(/root[- ]cause/i);
    expect(p).toMatch(/candidate copy/i);
    expect(p.toLowerCase()).toMatch(/must not.*(git|commit)/s);
    expect(p.toLowerCase()).toMatch(/must not edit.*(oracle|measurement|judge)/s);
    expect(p).toContain('piflow-fixer');
  });

  it('appends a diversification block on a retry — prior categories, steers, and accounts + a "try a DIFFERENT approach" order', () => {
    const p = buildFixerPrompt('---\ntitle: X\n---\nISSUE-BODY-MARKER-9', 'gameplay', {
      attempt: 2,
      priorDropbacks: [{ category: 'didnt-reach-root', steer: 'STEER-MARKER: the root is upstream in the schema' }],
      priorAccounts: ['ACCOUNT-MARKER: I only reworded the prompt'],
    });
    expect(p).toMatch(/prior attempt/i);
    expect(p).toMatch(/reject/i);
    expect(p).toMatch(/do not repeat/i);
    expect(p).toMatch(/different/i);
    expect(p).toContain('didnt-reach-root');
    expect(p).toContain('STEER-MARKER: the root is upstream in the schema');
    expect(p).toContain('ACCOUNT-MARKER: I only reworded the prompt');
  });

  it('omits the diversification block on the first attempt (no retry context) — the block is CONDITIONAL', () => {
    const p = buildFixerPrompt('---\ntitle: X\n---\nISSUE-BODY-MARKER-9', 'gameplay');
    expect(p).not.toMatch(/prior attempt/i);
  });
});

// ── WS0 behavior 2: the fence — the fixer spawns jailed to (include MINUS oracle) as worktree-abs paths ─────
describe('fixIssue fence — the fixer spawns jailed to (include MINUS oracle) under the worktree (WS0 behavior 2)', () => {
  it('readScope/owns = (include\\exclude) under the worktree; cwd = worktree; oracle paths ABSENT', async () => {
    // A node whose readScope DIRECTLY lists an oracle file, so the subtraction is OBSERVABLE (the oracle path
    // must be removed from an allowlist that otherwise contained it).
    const templateDir = await scratch('piflow-tpl-');
    const workspace = await scratch('piflow-ws-');
    const parentRunDir = await scratch('piflow-run-');
    const nodeDir = join(templateDir, 'nodes', 'gameplay');
    await fs.mkdir(join(nodeDir, 'issues'), { recursive: true });
    await fs.writeFile(
      join(nodeDir, 'node.json'),
      JSON.stringify({
        label: 'gameplay',
        contract: { readScope: ['{{WORKSPACE}}/templates', '{{WORKSPACE}}/eval/check.mjs'] },
        optimize: { measure: [{ id: 'f', run: { cmd: 'node', args: ['{{WORKSPACE}}/eval/check.mjs'] } }] },
      }),
    );
    await fs.mkdir(join(workspace, 'templates'), { recursive: true });
    await fs.writeFile(join(workspace, 'templates', 'genres.json'), '{"a":1}\n');
    await fs.mkdir(join(workspace, 'eval'), { recursive: true });
    await fs.writeFile(join(workspace, 'eval', 'check.mjs'), '// scorer\n');
    seedGitRepo(workspace);
    const issuePath = join(nodeDir, 'issues', 'soggy-crust.md');
    await writeIssueFile(issuePath, makeIssue());

    let captured: RunBaseAgentOpts | undefined;
    await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace, prove: false,
      runAgent: async (o) => { captured = o; return agentResult(); }, // no edit — we test the spawn opts only
    });
    const wt = captured!.cwd;
    // include = {templates, eval/check.mjs}; oracle = {eval/check.mjs} → fence = {templates} ONLY.
    expect(captured!.readScope).toEqual([join(wt, 'templates')]);
    expect(captured!.owns).toEqual([join(wt, 'templates')]);
    // the oracle path is ABSENT from both (the subtraction actually removed it), and cwd is the worktree.
    expect(captured!.readScope).not.toContain(join(wt, 'eval', 'check.mjs'));
    expect(captured!.owns).not.toContain(join(wt, 'eval', 'check.mjs'));
    expect(wt.endsWith(join('soggy-crust', 'attempt-1'))).toBe(true);
  });
});

// ── WS0 behavior 4 wired: the oracle diff-guard is a FIXER-SIDE rejection ──────────────────────────────────
describe('fixIssue — the oracle diff-guard is a FIXER-SIDE rejection (WS0 behavior 4 wired)', () => {
  it('a candidate whose commit touches an oracle path is discarded (never proved/gated); status stays active', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture({ baseGraded: { 'feas.score': 0.5 } });
    let spawned = false;
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      runAgent: async (o) => { await fs.writeFile(join(o.cwd, 'eval', 'check.mjs'), '// tampered scorer\n'); return agentResult(); },
      spawnChild: async () => { spawned = true; return childResult('x', await scratch('piflow-child-')); },
      measure: async () => measureReport({ 'feas.score': 0.9 }),
    });
    expect(res.editsApplied).toBe(1); // it DID edit …
    expect(res.candidateSha).toBeDefined(); // … and committed …
    expect(res.decision).toBe('discarded'); // … but touching the oracle is rejected outright.
    expect(spawned).toBe(false); // NEVER proved a scorer-touching candidate
    expect(res.record?.reason).toMatch(/oracle path/i);
    expect((await parseIssueFile(issuePath)).status).toBe('active'); // never advanced to fix-landed
  });

  it('a candidate that touches ONLY non-oracle paths proceeds to prove + gate (the other way)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture({ baseGraded: { 'feas.score': 0.5 } });
    let spawned = false;
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      runAgent: editingAgent, // edits templates/genres.json (non-oracle)
      spawnChild: async () => { spawned = true; return childResult('c', await scratch('piflow-child-')); },
      measure: async () => measureReport({ 'feas.score': 0.9 }),
    });
    expect(spawned).toBe(true); // a clean edit IS proved …
    expect(res.decision).toBe('staged'); // … and gated normally.
  });
});

// ── WS0 behavior 5/7/8: prove against the worktree · cleanup · result shape ────────────────────────────────
describe('fixIssue — prove path (edit → commit → child on the worktree → graded delta → accept → stage)', () => {
  it('proves against the candidate worktree, measures against the live root, stages baseSha/candidateSha', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture({ baseGraded: { 'feas.score': 0.5 } });
    let capturedWt = '';
    const events: SubstrateEvent[] = [];
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      onEvent: (e) => events.push(e),
      runAgent: async (o) => { capturedWt = o.cwd; await fs.appendFile(join(o.cwd, 'templates', 'genres.json'), '\n// fixed\n'); return agentResult(); },
      spawnChild: async (_p, _n, o) => {
        expect(o.workspace).toBe(capturedWt); // the node re-runs against the candidate WORKTREE (HEAD=candidateSha)
        expect(o.spawnedBy).toEqual({ by: 'substrate-fix', issue: 'soggy-crust', issueId: makeIssue().id });
        return childResult('tS2.gameplay', await scratch('piflow-child-'));
      },
      measure: async (_runDir, _node, o) => {
        expect(o.workspace).toBe(workspace); // measured against the LIVE product root (pristine oracle)
        return measureReport({ 'feas.score': 0.9 });
      },
    });

    expect(res.editsApplied).toBe(1);
    expect(res.proved).toBe(true);
    expect(res.childId).toBe('tS2.gameplay');
    expect(res.candidateSha).toBeDefined();
    expect(res.baseSha).toBe(headOf(workspace)); // the live root did not move (only a branch got the commit)
    expect(res.candidateRef).toBe('optimize/gameplay/soggy-crust/attempt-1');
    expect(res.verdict?.accept).toBe(true);
    expect(res.decision).toBe('staged');
    expect(res.deltaSummary).toEqual({ 'feas.score': expect.closeTo(0.4, 6) });

    // the ledger advanced open → active → fix-landed → verifying (awaiting the human adopt).
    expect((await parseIssueFile(issuePath)).status).toBe('verifying');

    // the manifest carries the staged record with SHAs + childId (WS0 behavior 8).
    const manifest = await readSubstrateManifest(parentRunDir);
    expect(manifest.records).toHaveLength(1);
    expect(manifest.records[0]).toMatchObject({ issue: 'soggy-crust', decision: 'staged', verifiedByRun: 'tS2.gameplay', node: 'gameplay' });
    expect(manifest.records[0].candidateSha).toBe(res.candidateSha);
    expect(manifest.records[0].baseSha).toBe(res.baseSha);
    expect(manifest.records[0].candidateRef).toBe('optimize/gameplay/soggy-crust/attempt-1');

    // WS1: the record lives at ONE folder per issue — record.json UNDER the lifecycle dir; NO shared manifest.json.
    const lifecycleDir = issueLifecycleDir(parentRunDir, 'gameplay', 'soggy-crust');
    const onDisk = JSON.parse(await fs.readFile(join(lifecycleDir, 'record.json'), 'utf8')) as SubstrateManifestRecord;
    expect(onDisk.candidateSha).toBe(res.candidateSha);
    expect(res.manifestPath).toBe(join(lifecycleDir, 'record.json'));
    await expect(fs.access(join(parentRunDir, 'optimize', 'substrate', 'staging', 'manifest.json'))).rejects.toThrow();

    expect(events.map((e) => e.type)).toEqual([
      'issue-activated', 'candidate-prepared', 'fixer-started', 'fixer-done', 'prove-started', 'measured', 'gated', 'staged', 'stopped',
    ]);
  });
});

describe('fixIssue — the candidate worktree is torn down after the gate; the branch + SHA persist (WS0 behavior 7)', () => {
  it('removes the worktree checkout but keeps the branch resolvable to candidateSha', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    let capturedWt = '';
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace, prove: false,
      runAgent: async (o) => { capturedWt = o.cwd; await fs.appendFile(join(o.cwd, 'templates', 'genres.json'), '\n// fixed\n'); return agentResult(); },
    });
    // the checkout is GONE …
    await expect(fs.access(capturedWt)).rejects.toThrow();
    // … but the branch still resolves to the candidate commit (durable for adopt).
    expect(res.candidateSha).toBeDefined();
    expect(execFileSync('git', ['-C', workspace, 'rev-parse', res.candidateRef]).toString().trim()).toBe(res.candidateSha);
  });
});

describe('fixIssue — the candidate worktree is torn down even on a THROW (try/finally; Defect 2/5)', () => {
  it('a throwing spawnChild rejects the fix AND still removes the candidate worktree checkout (no orphan)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture({ baseGraded: { 'feas.score': 0.5 } });
    let capturedWt = '';
    await expect(
      fixIssue(issuePath, {
        parentRunDir, templateDir, workspace,
        // a real edit → commit → the worktree + candidateSha exist, THEN prove throws.
        runAgent: async (o) => { capturedWt = o.cwd; await fs.appendFile(join(o.cwd, 'templates', 'genres.json'), '\n// fixed\n'); return agentResult(); },
        spawnChild: async () => { throw new Error('boom-in-prove'); },
        measure: async () => measureReport({ 'feas.score': 0.9 }),
      }),
    ).rejects.toThrow(/boom-in-prove/);
    // the throw propagated, but the finally still tore down the checkout (the branch/SHA persist by design).
    expect(capturedWt).not.toBe('');
    await expect(fs.access(capturedWt)).rejects.toThrow();
  });
});

describe('fixIssue — attemptTag + retry context threading (WS0: per-attempt worktree/branch)', () => {
  it('scopes the candidate worktree/branch by attemptTag and threads the retry context into the fixer prompt', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    let capturedPrompt = '';
    let capturedCwd = '';
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      prove: false,
      attemptTag: 'attempt-2',
      retry: { attempt: 2, priorDropbacks: [{ category: 'band-aid', steer: 'RETRY-STEER-42' }], priorAccounts: ['reworded only'] },
      runAgent: async (o) => {
        capturedPrompt = o.prompt;
        capturedCwd = o.cwd;
        await fs.appendFile(join(o.cwd, 'templates', 'genres.json'), '\n// fixed\n');
        return agentResult();
      },
    });
    expect(res.candidateRef).toBe('optimize/gameplay/soggy-crust/attempt-2'); // per-attempt branch
    expect(capturedCwd.endsWith(join('soggy-crust', 'attempt-2'))).toBe(true); // ran in the per-attempt worktree
    expect(capturedPrompt).toMatch(/prior attempt/i);
    expect(capturedPrompt).toContain('RETRY-STEER-42');
  });

  it('defaults to attempt-1 when no attemptTag is given', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    const res = await fixIssue(issuePath, { parentRunDir, templateDir, workspace, prove: false, runAgent: editingAgent });
    expect(res.candidateRef).toBe('optimize/gameplay/soggy-crust/attempt-1');
  });
});

describe('fixIssue — prove path rejects a regression (no auto-adopt)', () => {
  it('a measured regression ⇒ verdict reject, decision discarded, issue walks back to open', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture({ baseGraded: { 'feas.score': 0.9 } });
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      runAgent: editingAgent,
      spawnChild: async () => childResult('tS2.gameplay', await scratch('piflow-child-')),
      measure: async () => measureReport({ 'feas.score': 0.4 }), // worse than base 0.9
    });
    expect(res.verdict?.accept).toBe(false);
    expect(res.decision).toBe('discarded');
    const manifest = await readSubstrateManifest(parentRunDir);
    expect(manifest.records[0].decision).toBe('discarded');

    // a proven-REJECT walks the issue back to `open` (nothing landed: reason null, no attempt stamped).
    const after = await parseIssueFile(issuePath);
    expect(after.status).toBe('open');
    expect(after.reason).toBeNull();
    expect(after.attempts).toEqual([]);
  });
});

describe('fixIssue — SOFT gate path (no numeric oracle → the independent gate agent decides)', () => {
  /** Give the node an `optimize.judge` so `nodeHasJudge()` is true and the SOFT path is taken. */
  async function makeSoft(templateDir: string): Promise<void> {
    const nodeJsonPath = join(templateDir, 'nodes', 'gameplay', 'node.json');
    const nj = JSON.parse(await fs.readFile(nodeJsonPath, 'utf8'));
    nj.optimize.judge = '{{WORKSPACE}}/skills/judge.md';
    await fs.writeFile(nodeJsonPath, JSON.stringify(nj, null, 2));
  }

  it('ACCEPT ⇒ staged for human, gateVerdict present, numeric verdict ABSENT, status stays verifying', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture(); // no baseGraded ⇒ unmeasurable
    await makeSoft(templateDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let gateSeen: any;
    let capturedWt = '';
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      runAgent: async (o) => {
        capturedWt = o.cwd;
        await fs.appendFile(join(o.cwd, 'templates', 'genres.json'), '\n// fixed\n');
        return { status: okStatus(), text: 'ACCOUNT: I added an enumeration rule for every named mechanic.' };
      },
      spawnChild: async () => childResult('tS2.gameplay', await scratch('piflow-child-')),
      measure: async () => measureReport({}), // graded {} ⇒ no shared keys ⇒ SOFT path
      gate: async (_runDir, _node, o) => {
        gateSeen = o;
        return { verdict: { decision: 'accept', rationale: 'the ladder mechanic is now classified; nothing else regressed' } };
      },
    });
    expect(res.decision).toBe('staged');
    expect(res.gateVerdict?.decision).toBe('accept');
    expect(res.verdict).toBeUndefined(); // the numeric gate did NOT decide on the soft path
    expect(res.dropback).toBeUndefined();
    expect(res.childId).toBe('tS2.gameplay');
    // the gate received the issue text, the fixer's account, and read access to the candidate WORKTREE.
    expect(gateSeen.issueFileText).toContain('compose');
    expect(gateSeen.fixerAccount).toContain('enumeration rule');
    expect(gateSeen.candidateRef).toBe(capturedWt);
    expect((await parseIssueFile(issuePath)).status).toBe('verifying');
    const manifest = await readSubstrateManifest(parentRunDir);
    expect(manifest.records[0]).toMatchObject({ decision: 'staged', landPolicy: 'stage-for-human', verifiedByRun: 'tS2.gameplay' });
  });

  it('REJECT ⇒ discarded, issue walks back to OPEN (re-attemptable), drop-back packet persisted (NO rubric)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    await makeSoft(templateDir);
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      runAgent: editingAgent,
      spawnChild: async () => childResult('tS2.gameplay', await scratch('piflow-child-')),
      measure: async () => measureReport({}),
      gate: async () => ({
        verdict: {
          decision: 'reject',
          rationale: 'the detector was loosened, not the cause fixed',
          category: 'band-aid',
          steer: 'the root is upstream in the prompt, not the schema',
        },
      }),
    });
    expect(res.decision).toBe('discarded');
    expect(res.gateVerdict?.decision).toBe('reject');
    expect(res.dropback).toEqual({ category: 'band-aid', steer: 'the root is upstream in the prompt, not the schema' });

    const after = await parseIssueFile(issuePath);
    expect(after.status).toBe('open');
    expect(after.reason).toBeNull();
    expect(after.attempts).toEqual([]);

    const manifest = await readSubstrateManifest(parentRunDir);
    expect(manifest.records[0].dropback).toEqual({ category: 'band-aid', steer: 'the root is upstream in the prompt, not the schema' });
  });

  it('a node with NEITHER a number NOR a judge does NOT invoke the gate agent (evaluateGate stage-for-human)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture(); // measure {} + NO judge
    let gateCalled = false;
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      runAgent: editingAgent,
      spawnChild: async () => childResult('x', await scratch('piflow-child-')),
      measure: async () => measureReport({}),
      gate: async () => {
        gateCalled = true;
        return { verdict: { decision: 'accept', rationale: 'x' } };
      },
    });
    expect(gateCalled).toBe(false); // no optimize.judge ⇒ the gate agent is NOT the decider
    expect(res.gateVerdict).toBeUndefined();
    expect(res.decision).toBe('staged'); // evaluateGate: unmeasurable → stage-for-human
    expect(res.verdict?.landPolicy).toBe('stage-for-human');
  });
});

// ── WS3: per-issue verify TIER dispatch (none skips prove+gate · rerun = numeric only · full = gate agent) ──
describe('fixIssue — WS3 verify-tier dispatch (none | rerun | full)', () => {
  it('verify:none ⇒ STAGED with NO prove and NO gate (trivial); rests fix-landed, reason "verify:none"', async () => {
    // measure THROWS: a §4 drill proving the prove path never runs under `none`.
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture({ baseGraded: { 'feas.score': 0.5 } });
    await setSoftBar(templateDir); // even WITH criteria, none must not gate
    let spawned = false;
    let gateCalled = false;
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      verify: 'none',
      runAgent: editingAgent,
      spawnChild: async () => { spawned = true; return childResult('x', await scratch('piflow-child-')); },
      measure: async () => { throw new Error('measure must NOT run under verify:none'); },
      gate: async () => { gateCalled = true; return { verdict: { decision: 'accept', rationale: 'x' } }; },
    });
    expect(spawned).toBe(false);          // no prove
    expect(gateCalled).toBe(false);       // no gate agent
    expect(res.proved).toBe(false);
    expect(res.childId).toBeNull();
    expect(res.decision).toBe('staged');  // adopt-ready
    expect(res.candidateSha).toBeDefined();
    expect(res.record?.reason).toMatch(/verify:none/);
    expect(res.record?.verifiedByRun).toBeNull();
    expect((await parseIssueFile(issuePath)).status).toBe('fix-landed'); // rests adopt-ready
  });

  it('verify:none with a NO-OP fixer (0 edits) ⇒ discarded "no edit applied" (the trivial tier still needs an edit)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      verify: 'none',
      runAgent: noopAgent,
      spawnChild: async () => childResult('x', await scratch()),
      measure: async () => measureReport({}),
    });
    expect(res.editsApplied).toBe(0);
    expect(res.decision).toBe('discarded');
    expect((await parseIssueFile(issuePath)).status).toBe('active'); // never advanced
  });

  it('verify:rerun ⇒ proves but NEVER the gate agent, even when the node has criteria (unmeasurable ⇒ numeric stage-for-human)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture(); // unmeasurable
    await setSoftBar(templateDir); // node HAS criteria …
    let spawned = false;
    let gateCalled = false;
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      verify: 'rerun',
      runAgent: editingAgent,
      spawnChild: async () => { spawned = true; return childResult('tS2.gameplay', await scratch('piflow-child-')); },
      measure: async () => measureReport({}),
      gate: async () => { gateCalled = true; return { verdict: { decision: 'accept', rationale: 'x' } }; },
    });
    expect(spawned).toBe(true);           // it DID prove …
    expect(gateCalled).toBe(false);       // … but rerun NEVER invokes the gate agent (numeric gate only)
    expect(res.gateVerdict).toBeUndefined();
    expect(res.verdict?.landPolicy).toBe('stage-for-human'); // numeric gate: unmeasurable → human
    expect(res.decision).toBe('staged');
  });

  it('verify:rerun with shared numeric keys ⇒ the NUMERIC gate decides (proves + evaluateGate)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture({ baseGraded: { 'feas.score': 0.5 } });
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      verify: 'rerun',
      runAgent: editingAgent,
      spawnChild: async () => childResult('tS2.gameplay', await scratch('piflow-child-')),
      measure: async () => measureReport({ 'feas.score': 0.9 }),
    });
    expect(res.proved).toBe(true);
    expect(res.verdict?.accept).toBe(true); // 0.5 → 0.9 strict improvement, numeric
    expect(res.decision).toBe('staged');
  });

  it('verify:full ⇒ proves + the gate AGENT decides (the contrast to rerun on the SAME unmeasurable+criteria node)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    await setSoftBar(templateDir);
    let gateCalled = false;
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      verify: 'full',
      runAgent: editingAgent,
      spawnChild: async () => childResult('tS2.gameplay', await scratch('piflow-child-')),
      measure: async () => measureReport({}),
      gate: async () => { gateCalled = true; return { verdict: { decision: 'accept', rationale: 'ok' } }; },
    });
    expect(gateCalled).toBe(true);          // full DOES invoke the gate agent
    expect(res.gateVerdict?.decision).toBe('accept');
    expect(res.verdict).toBeUndefined();    // numeric gate did not decide on the soft path
    expect(res.decision).toBe('staged');
  });

  it('the tier SPINE: the issue\'s OWN `verify: none` frontmatter drives the tier (no opts override)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    await writeIssueFile(issuePath, makeIssue({ verify: 'none' }));
    let spawned = false;
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      runAgent: editingAgent,
      spawnChild: async () => { spawned = true; return childResult('x', await scratch()); },
      measure: async () => measureReport({}),
    });
    expect(spawned).toBe(false);          // frontmatter none ⇒ no prove
    expect(res.record?.reason).toMatch(/verify:none/);
  });

  it('the tier SPINE: the node\'s optimize.verifyDefault drives the tier when the issue omits its own', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    await setVerifyDefault(templateDir, 'none');
    let spawned = false;
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      runAgent: editingAgent,
      spawnChild: async () => { spawned = true; return childResult('x', await scratch()); },
      measure: async () => measureReport({}),
    });
    expect(spawned).toBe(false);          // node default none ⇒ no prove
    expect(res.decision).toBe('staged');
  });

  it('opts.verify (the CLI override) WINS over the issue frontmatter', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    await writeIssueFile(issuePath, makeIssue({ verify: 'full' })); // frontmatter says full …
    let spawned = false;
    await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      verify: 'none', // … but the override says none
      runAgent: editingAgent,
      spawnChild: async () => { spawned = true; return childResult('x', await scratch()); },
      measure: async () => measureReport({}),
    });
    expect(spawned).toBe(false);          // none won ⇒ no prove
  });
});

describe('fixIssue — skip-proof path (prove off)', () => {
  it('editsApplied≥1 with prove:false ⇒ no child run, status fix-landed, decision staged, verifiedByRun null, candidateSha present', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    let spawned = false;
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      prove: false,
      runAgent: editingAgent,
      spawnChild: async () => { spawned = true; return childResult('x', await scratch()); },
      measure: async () => measureReport({}),
    });
    expect(spawned).toBe(false); // proving skipped → no child run
    expect(res.proved).toBe(false);
    expect(res.childId).toBeNull();
    expect(res.decision).toBe('staged'); // unmeasurable ⇒ stage-for-human
    expect(res.candidateSha).toBeDefined(); // a real commit exists on the branch (skip only skips proving)
    expect(res.record?.verifiedByRun).toBeNull();
    expect((await parseIssueFile(issuePath)).status).toBe('fix-landed'); // the skip-proof landing state
  });

  it('the staged record carries the issue severity + firstSeen (so the adopt train can order within a node)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      prove: false,
      runAgent: editingAgent,
      spawnChild: async () => childResult('x', await scratch()),
      measure: async () => measureReport({}),
    });
    // the fixture issue is severity:high, firstSeen:260706-01 — copied onto the record for orderRecords (§6).
    expect(res.record?.severity).toBe('high');
    expect(res.record?.firstSeen).toBe('260706-01');
    // and PERSISTED to record.json on disk (scanRecords → the adopt train reads these, not the ledger).
    const onDisk = JSON.parse(await fs.readFile(res.manifestPath!, 'utf8'));
    expect(onDisk.severity).toBe('high');
    expect(onDisk.firstSeen).toBe('260706-01');
  });
});

describe('fixIssue — surfaces the fixer agent\'s runDir (Phase-3 observe wiring)', () => {
  it('forwards the LIVE fixer spawn\'s runDir onto FixIssueResult.fixerRunDir', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      prove: false,
      runAgent: async (o) => {
        await fs.appendFile(join(o.cwd, 'templates', 'genres.json'), '\n// fixed\n');
        return { ...agentResult(), runDir: '/fake/observe/fix-dir' };
      },
      spawnChild: async () => childResult('x', await scratch()),
      measure: async () => measureReport({}),
    });
    expect(res.fixerRunDir).toBe('/fake/observe/fix-dir');
  });

  it('is ABSENT when the fixer spawn returns no runDir (the ephemeral default)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      prove: false,
      runAgent: editingAgent,
      spawnChild: async () => childResult('x', await scratch()),
      measure: async () => measureReport({}),
    });
    expect(res.fixerRunDir).toBeUndefined();
  });
});

describe('fixIssue — stages the piflow-fixer playbook for the fixer spawn', () => {
  it('passes the EXACT piflow-fixer skill PATH (product-root .claude/skills) to runAgent', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    let capturedSkill: string | undefined = 'UNSET';
    const capturingRunAgent = async (o: RunBaseAgentOpts): Promise<RunBaseAgentResult> => {
      capturedSkill = o.skill;
      await fs.appendFile(join(o.cwd, 'templates', 'genres.json'), '\n// fixed\n');
      return agentResult();
    };
    await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      prove: false,
      runAgent: capturingRunAgent,
      spawnChild: async () => childResult('x', await scratch()),
      measure: async () => measureReport({}),
    });
    expect(capturedSkill).toBe(join(workspace, '.claude', 'skills', 'piflow-fixer'));
  });
});

describe('fixIssue — a TRUE child of the base agent (the ONE shared inherited field surface)', () => {
  it('forwards the base agent\'s inherited fields — dryRun INCLUDED — to runAgent (never a hand-copied subset)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    let captured: RunBaseAgentOpts | undefined;
    const capturingRunAgent = async (o: RunBaseAgentOpts): Promise<RunBaseAgentResult> => {
      captured = o;
      return agentResult();
    };
    await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      dryRun: true, // a BASE field the fixer's old hand-copied forward list silently dropped
      timeoutMs: 45000,
      runAgent: capturingRunAgent,
      spawnChild: async () => childResult('x', await scratch()),
      measure: async () => measureReport({}),
    });
    expect(captured?.dryRun).toBe(true);
    expect(captured?.timeoutMs).toBe(45000);
  });
});

describe('fixIssue — dry-run (the inherited base-agent preview)', () => {
  it('returns the composed fixer plan (worktree jail) and mutates NOTHING — no transition, no worktree, no manifest, no events', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    const events: SubstrateEvent[] = [];
    // NO runAgent injection: the REAL base agent short-circuits on dryRun (pure spec-building, spawns nothing).
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      dryRun: true,
      onEvent: (e) => events.push(e),
    });

    const execCwd = res.dryRun?.sandbox?.execCwd as string;
    expect(res.dryRun?.prompt).toContain('The compose step burns long thinking spans'); // the issue body = the dispatch
    expect(res.dryRun?.executor).toBe('claude-code');
    expect(res.dryRun?.skill).toBe(join(workspace, '.claude', 'skills', 'piflow-fixer'));
    // the jail is the candidate WORKTREE (execCwd), read/write = (include\oracle) under it, provider local.
    expect(execCwd.endsWith(join('soggy-crust', 'attempt-1'))).toBe(true);
    expect(res.dryRun?.sandbox?.read).toEqual([join(execCwd, 'templates'), join(execCwd, 'eval')]);
    expect(res.dryRun?.sandbox?.write).toEqual([join(execCwd, 'templates'), join(execCwd, 'eval')]);
    expect(res.dryRun?.sandbox?.provider).toBe('local');
    expect(res.candidateRef).toBe('optimize/gameplay/soggy-crust/attempt-1');

    // NOTHING mutated: the issue never left `open`, the worktree was never created, no manifest, no events.
    expect((await parseIssueFile(issuePath)).status).toBe('open');
    await expect(fs.access(execCwd)).rejects.toThrow();
    expect((await readSubstrateManifest(parentRunDir)).records).toEqual([]);
    expect(events).toEqual([]);
    expect(res.decision).toBeUndefined();
    expect(res.verdict).toBeUndefined();
    expect(res.manifestPath).toBeUndefined();
    expect(res.editsApplied).toBe(0);
    expect(res.childId).toBeNull();
    expect(res.candidateSha).toBeUndefined();
  });
});

describe('fixIssue — a no-op fixer is rejected', () => {
  it('editsApplied 0 ⇒ gate "no edit applied", decision discarded, status stays active, prove never runs', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture({ baseGraded: { 'feas.score': 0.5 } });
    let spawned = false;
    const res = await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      runAgent: noopAgent,
      spawnChild: async () => { spawned = true; return childResult('x', await scratch()); },
      measure: async () => measureReport({ 'feas.score': 0.9 }),
    });
    expect(res.editsApplied).toBe(0);
    expect(res.candidateSha).toBeUndefined(); // nothing committed
    expect(res.decision).toBe('discarded');
    expect(res.verdict?.reason).toMatch(/no edit applied/);
    expect(spawned).toBe(false); // never proves a 0-edit proposal
    expect((await parseIssueFile(issuePath)).status).toBe('active'); // never advanced to fix-landed
  });
});

// ── WS1: one folder per issue — issueLifecycleDir · scanRecords · record.json · verdict.json · log.jsonl ─────
describe('issueLifecycleDir — runs/<run>/optimize/issues/<node>/<issue>/ (WS1 behavior 1)', () => {
  it('composes the per-issue lifecycle dir under the run dir', () => {
    expect(issueLifecycleDir('/runs/tS2', 'gameplay', 'soggy-crust')).toBe(
      join('/runs/tS2', 'optimize', 'issues', 'gameplay', 'soggy-crust'),
    );
  });
});

describe('scanRecords — the aggregate VIEW globs optimize/issues/*/*/record.json (WS1 behavior 3)', () => {
  it('collects every per-issue record.json across nodes/issues; ignores dirs with no record.json', async () => {
    const runDir = await scratch('piflow-run-');
    const write = async (node: string, issue: string, rec: Partial<SubstrateManifestRecord>): Promise<void> => {
      const dir = issueLifecycleDir(runDir, node, issue);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'record.json'), JSON.stringify({ issue, issueId: `id-${issue}`, node, decision: 'staged', candidateRef: 'r', liveRoot: '/l', landPolicy: 'stage-for-human', reason: 'x', verifiedByRun: null, deltaSummary: {}, ...rec }, null, 2));
    };
    await write('gameplay', 'soggy-crust', { candidateSha: 'aaa' });
    await write('gameplay', 'burnt-edge', { candidateSha: 'bbb' });
    await write('narrative', 'flat-arc', { candidateSha: 'ccc' });
    // a lifecycle dir with NO record.json (e.g. only a log.jsonl) contributes nothing.
    const empty = issueLifecycleDir(runDir, 'gameplay', 'no-record');
    await fs.mkdir(empty, { recursive: true });
    await fs.writeFile(join(empty, 'log.jsonl'), '{}\n');

    const records = await scanRecords(runDir);
    expect(records.map((r) => `${r.node}/${r.issue}`).sort()).toEqual(['gameplay/burnt-edge', 'gameplay/soggy-crust', 'narrative/flat-arc']);
    expect(records.find((r) => r.issue === 'flat-arc')?.candidateSha).toBe('ccc');
    // an absent issues/ tree yields [] (never throws) — the empty-run case bulk readers rely on.
    expect(await scanRecords(await scratch('piflow-empty-'))).toEqual([]);
  });

  it('readSubstrateManifest(runDir) returns { records: scanRecords(runDir) } (back-compat view)', async () => {
    const runDir = await scratch('piflow-run-');
    const dir = issueLifecycleDir(runDir, 'gameplay', 'soggy-crust');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'record.json'), JSON.stringify({ issue: 'soggy-crust', issueId: 'id-x', node: 'gameplay', decision: 'staged', candidateRef: 'r', liveRoot: '/l', landPolicy: 'stage-for-human', reason: 'x', verifiedByRun: null, deltaSummary: {} }, null, 2));
    const manifest = await readSubstrateManifest(runDir);
    expect(manifest.records).toHaveLength(1);
    expect(manifest.records[0].issue).toBe('soggy-crust');
  });
});

describe('fixIssue — WS1 lifecycle artifacts (record.json · verdict.json · log.jsonl all under one dir)', () => {
  it('writes verdict.json under the lifecycle dir (gate gets gateOutDir = the lifecycle dir) + a log.jsonl of the events', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    // make the node soft (has an optimize.judge) so the gate agent path runs.
    const nodeJsonPath = join(templateDir, 'nodes', 'gameplay', 'node.json');
    const nj = JSON.parse(await fs.readFile(nodeJsonPath, 'utf8'));
    nj.optimize.judge = '{{WORKSPACE}}/skills/judge.md';
    await fs.writeFile(nodeJsonPath, JSON.stringify(nj, null, 2));

    let seenGateOutDir: string | undefined;
    await fixIssue(issuePath, {
      parentRunDir, templateDir, workspace,
      runAgent: async (o) => { await fs.appendFile(join(o.cwd, 'templates', 'genres.json'), '\n// fixed\n'); return { status: okStatus(), text: 'root cause fixed' }; },
      spawnChild: async () => childResult('tS2.gameplay', await scratch('piflow-child-')),
      measure: async () => measureReport({}), // unmeasurable ⇒ SOFT path
      gate: async (_rd, _n, o) => { seenGateOutDir = o.gateOutDir; return { verdict: { decision: 'accept', rationale: 'ok' } }; },
    });

    const lifecycleDir = issueLifecycleDir(parentRunDir, 'gameplay', 'soggy-crust');
    expect(seenGateOutDir).toBe(lifecycleDir); // WS1 behavior 4: the gate writes verdict.json under the lifecycle dir

    // log.jsonl records the event stream for this issue under the same dir.
    const log = (await fs.readFile(join(lifecycleDir, 'log.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(log.map((e) => e.type)).toContain('issue-activated');
    expect(log.map((e) => e.type)).toContain('staged');
    expect(log.every((e) => e.issue === 'soggy-crust')).toBe(true);
  });
});

// ── WS2: verifyStage — the decoupled GATE stage (reads record.json → gate agent → verdict → record + status) ─
describe('verifyStage — the standalone gate stage (WS2.1: NO fixer, NO re-prove)', () => {
  /** Give the node an optimize.judge (the SOFT bar) so the gate agent path applies. */
  async function makeSoft(templateDir: string): Promise<void> {
    const nodeJsonPath = join(templateDir, 'nodes', 'gameplay', 'node.json');
    const nj = JSON.parse(await fs.readFile(nodeJsonPath, 'utf8'));
    nj.optimize.judge = '{{WORKSPACE}}/skills/judge.md';
    await fs.writeFile(nodeJsonPath, JSON.stringify(nj, null, 2));
  }

  /** Walk the issue open → active → fix-landed → verifying (the state a staged candidate rests at). */
  async function toVerifying(issuePath: string): Promise<void> {
    await transitionIssue(issuePath, 'active');
    await transitionIssue(issuePath, 'fix-landed');
    await transitionIssue(issuePath, 'verifying');
  }

  /** Seed a record.json (with a candidateSha) under the issue's lifecycle dir. */
  async function seedRecord(parentRunDir: string, workspace: string, over: Partial<SubstrateManifestRecord> = {}): Promise<string> {
    const dir = issueLifecycleDir(parentRunDir, 'gameplay', 'soggy-crust');
    await fs.mkdir(dir, { recursive: true });
    const rec: SubstrateManifestRecord = {
      issue: 'soggy-crust', issueId: makeIssue().id, node: 'gameplay', decision: 'discarded',
      candidateRef: 'optimize/gameplay/soggy-crust/attempt-1', liveRoot: workspace, baseSha: 'base0',
      candidateSha: 'deadbeefcafe', landPolicy: 'stage-for-human', reason: 'pre-gate', verifiedByRun: 'tS2.gameplay',
      deltaSummary: {}, ...over,
    };
    await fs.writeFile(join(dir, 'record.json'), JSON.stringify(rec, null, 2));
    return dir;
  }

  it('ACCEPT: reads record.json + runs the gate (gateOutDir = lifecycle dir), record → staged, issue stays verifying', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    await makeSoft(templateDir);
    await toVerifying(issuePath);
    const lifecycleDir = await seedRecord(parentRunDir, workspace);
    const wt = await scratch('piflow-wt-'); // an EXISTING candidateRef dir ⇒ no worktree recreation
    const childDir = await scratch('piflow-child-');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let gateSeen: any;
    const res = await verifyStage({ runDir: parentRunDir, node: 'gameplay', issue: 'soggy-crust' }, {
      templateDir, workspace, childDir, candidateRef: wt, issuePath, fixerAccount: 'ACCT-MARKER',
      gate: async (_rd, _n, o) => { gateSeen = o; return { verdict: { decision: 'accept', rationale: 'defect absent, nothing regressed' }, verdictPath: join(o.gateOutDir!, 'verdict.json') }; },
    });
    expect(res.decision).toBe('staged');
    expect(res.gateVerdict.decision).toBe('accept');
    expect(res.dropback).toBeUndefined();
    // the gate ran against the candidate worktree, wrote its verdict under the lifecycle dir, saw the fixer account.
    expect(gateSeen.gateOutDir).toBe(lifecycleDir);
    expect(gateSeen.candidateRef).toBe(wt);
    expect(gateSeen.fixerAccount).toBe('ACCT-MARKER');
    // record.json flips to staged; the issue stays verifying (awaiting the human adopt).
    const onDisk = JSON.parse(await fs.readFile(join(lifecycleDir, 'record.json'), 'utf8')) as SubstrateManifestRecord;
    expect(onDisk.decision).toBe('staged');
    expect(onDisk.candidateSha).toBe('deadbeefcafe'); // durable candidate fields preserved
    expect((await parseIssueFile(issuePath)).status).toBe('verifying');
  });

  it('REJECT: record → discarded + dropback persisted, issue walks back to OPEN (re-attemptable), NO re-prove', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    await makeSoft(templateDir);
    await toVerifying(issuePath);
    const lifecycleDir = await seedRecord(parentRunDir, workspace);
    const wt = await scratch('piflow-wt-');
    let spawned = false;
    const res = await verifyStage({ runDir: parentRunDir, node: 'gameplay', issue: 'soggy-crust' }, {
      templateDir, workspace, childDir: await scratch('piflow-child-'), candidateRef: wt, issuePath,
      spawnChild: async () => { spawned = true; return childResult('x', await scratch()); }, // MUST be untouched (no re-prove)
      gate: async () => ({ verdict: { decision: 'reject', rationale: 'detector loosened, not the cause', category: 'band-aid', steer: 'root is upstream in the prompt' } }),
    } as Parameters<typeof verifyStage>[1]);
    expect(res.decision).toBe('discarded');
    expect(res.dropback).toEqual({ category: 'band-aid', steer: 'root is upstream in the prompt' });
    expect(spawned).toBe(false); // verify NEVER re-proves
    const onDisk = JSON.parse(await fs.readFile(join(lifecycleDir, 'record.json'), 'utf8')) as SubstrateManifestRecord;
    expect(onDisk.decision).toBe('discarded');
    expect(onDisk.dropback).toEqual({ category: 'band-aid', steer: 'root is upstream in the prompt' });
    // a proven-REJECT walks the verifying issue back to open (nothing landed).
    const after = await parseIssueFile(issuePath);
    expect(after.status).toBe('open');
    expect(after.reason).toBeNull();
  });

  it('a record with NO candidateSha cannot be gated — throws (the pre-WS0 copy-based candidate case)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    await makeSoft(templateDir);
    await toVerifying(issuePath);
    await seedRecord(parentRunDir, workspace, { candidateSha: undefined });
    await expect(
      verifyStage({ runDir: parentRunDir, node: 'gameplay', issue: 'soggy-crust' }, {
        templateDir, workspace, childDir: await scratch('piflow-child-'), candidateRef: join(await scratch(), 'gone'), issuePath,
        gate: async () => ({ verdict: { decision: 'accept', rationale: 'x' } }),
      }),
    ).rejects.toThrow(/candidateSha|no candidate/i);
  });

  it('re-creates a worktree at candidateSha when the candidate checkout is gone, then tears it down', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    await makeSoft(templateDir);
    await toVerifying(issuePath);
    // make a REAL candidate commit on a throwaway branch (as fixIssue would), then tear the worktree down.
    const issue = makeIssue();
    const cwt = await prepareCandidateWorktree(workspace, { node: 'gameplay', issue: 'soggy-crust', attempt: 1 });
    await fs.appendFile(join(cwt.worktreeDir, 'templates', 'genres.json'), '\n// candidate edit\n');
    const committed = commitCandidate(cwt.worktreeDir, cwt.baseSha, { node: 'gameplay', name: 'soggy-crust', id: issue.id, title: issue.title });
    removeCandidateWorktree(workspace, cwt.worktreeDir); // torn down — only the SHA persists
    await seedRecord(parentRunDir, workspace, { candidateSha: committed.candidateSha, candidateRef: cwt.branch });

    let recreatedDir = '';
    const res = await verifyStage({ runDir: parentRunDir, node: 'gameplay', issue: 'soggy-crust' }, {
      templateDir, workspace, childDir: await scratch('piflow-child-'),
      candidateRef: cwt.worktreeDir, // the torn-down path (does not exist) ⇒ verifyStage must recreate at candidateSha
      issuePath,
      gate: async (_rd, _n, o) => {
        recreatedDir = o.candidateRef!;
        // the recreated worktree exists at gate time and holds the candidate's committed edit.
        expect((await fs.readFile(join(o.candidateRef!, 'templates', 'genres.json'), 'utf8'))).toContain('candidate edit');
        return { verdict: { decision: 'accept', rationale: 'ok' } };
      },
    });
    expect(res.decision).toBe('staged');
    // the recreated checkout is torn down after gating (verifyStage owns what it created).
    await expect(fs.access(recreatedDir)).rejects.toThrow();
  });

  // ── Defect 1 (CRITICAL): the oracle fence TRAVELS to verifyStage — a decoupled verify can NEVER gate-accept an
  // oracle-touched candidate (else adopt would cherry-pick a scorer-tamper into the live product). ────────────
  it('REFUSES an oracle-touched candidate — never gates it, finalizes discarded with the oracle reason, walks the issue back', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture({ baseGraded: { 'feas.score': 0.5 } });
    await makeSoft(templateDir);
    await toVerifying(issuePath);
    // a REAL candidate commit that TAMPERS with the scorer (eval/check.mjs is the measure oracle in setupFixture).
    const issue = makeIssue();
    const cwt = await prepareCandidateWorktree(workspace, { node: 'gameplay', issue: 'soggy-crust', attempt: 1 });
    await fs.writeFile(join(cwt.worktreeDir, 'eval', 'check.mjs'), '// TAMPERED scorer\n');
    const committed = commitCandidate(cwt.worktreeDir, cwt.baseSha, { node: 'gameplay', name: 'soggy-crust', id: issue.id, title: issue.title });
    removeCandidateWorktree(workspace, cwt.worktreeDir); // only the SHA persists
    const lifecycleDir = await seedRecord(parentRunDir, workspace, { candidateSha: committed.candidateSha, baseSha: cwt.baseSha, candidateRef: cwt.branch });

    let gateCalled = false;
    const res = await verifyStage({ runDir: parentRunDir, node: 'gameplay', issue: 'soggy-crust' }, {
      templateDir, workspace, childDir: await scratch('piflow-child-'),
      candidateRef: join(await scratch(), 'gone'), issuePath,
      gate: async () => { gateCalled = true; return { verdict: { decision: 'accept', rationale: 'x' } }; },
    });
    expect(gateCalled).toBe(false);            // an oracle candidate is NEVER handed to the gate agent
    expect(res.decision).toBe('discarded');
    expect(res.gateVerdict.decision).toBe('reject');
    expect(res.gateVerdict.rationale).toMatch(/oracle path/i);
    // record.json is finalized discarded with the oracle reason (so a later verify/adopt won't re-pick it).
    const onDisk = JSON.parse(await fs.readFile(join(lifecycleDir, 'record.json'), 'utf8')) as SubstrateManifestRecord;
    expect(onDisk.decision).toBe('discarded');
    expect(onDisk.reason).toMatch(/oracle path/i);
    // the verifying issue is walked back to open (nothing landed).
    expect((await parseIssueFile(issuePath)).status).toBe('open');
  });
});

// ── adoptSubstrateManifest — the SEPARATE human adopt step, git-native cherry-pick (WS0 behavior 6) ─────────
describe('adoptSubstrateManifest — cherry-picks candidateSha, commits, stamps the attempt, resolves the issue', () => {
  /** Make a REAL candidate commit on a throwaway branch (exactly as fixIssue would), returning its SHAs. */
  async function makeCandidate(repoRoot: string, issue: Issue, edit: (wtDir: string) => Promise<void>): Promise<{ baseSha: string; candidateSha: string; branch: string }> {
    const wt = await prepareCandidateWorktree(repoRoot, { node: 'gameplay', issue: 'soggy-crust', attempt: 1 });
    await edit(wt.worktreeDir);
    const c = commitCandidate(wt.worktreeDir, wt.baseSha, { node: 'gameplay', name: 'soggy-crust', id: issue.id, title: issue.title });
    removeCandidateWorktree(repoRoot, wt.worktreeDir);
    if (!c.candidateSha) throw new Error('test setup: candidate made no commit');
    return { baseSha: wt.baseSha, candidateSha: c.candidateSha, branch: wt.branch };
  }

  /** Build a staged manifest for one issue: a live git repo (workspace) + a candidate commit on a branch. */
  async function stageOne(opts: { verifiedByRun: string | null; issueStatus: Issue['status'] }) {
    const workspace = await scratch('piflow-repo-');
    await fs.writeFile(join(workspace, 'level.json'), '{"v":1}\n');
    seedGitRepo(workspace);

    const templateDir = await scratch('piflow-tpl-');
    const issueDir = join(templateDir, 'nodes', 'gameplay', 'issues');
    await fs.mkdir(issueDir, { recursive: true });
    const issuePath = join(issueDir, 'soggy-crust.md');
    const issue = makeIssue({ status: opts.issueStatus, reason: null, attempts: [] });
    await writeIssueFile(issuePath, issue);

    const { baseSha, candidateSha, branch } = await makeCandidate(workspace, issue, async (wtDir) => {
      await fs.writeFile(join(wtDir, 'level.json'), '{"v":2,"fixed":true}\n');
    });

    const record: SubstrateManifestRecord = {
      issue: 'soggy-crust', issueId: issue.id, node: 'gameplay', decision: 'staged',
      candidateRef: branch, liveRoot: workspace, baseSha, candidateSha,
      landPolicy: 'auto-adopt-eligible', reason: 'strict improvement (+1)',
      verifiedByRun: opts.verifiedByRun, deltaSummary: { 'feas.score': 0.4 },
    };
    return { workspace, templateDir, issuePath, manifest: { records: [record] } as SubstrateManifest };
  }

  it('proven fix: verifying → resolved, attempt {commit, verifiedByRun=childId}, real cherry-picked commit with the trailer', async () => {
    const { workspace, templateDir, issuePath, manifest } = await stageOne({ verifiedByRun: 'tS2.gameplay', issueStatus: 'verifying' });
    const res = await adoptSubstrateManifest(manifest, { templateDir });

    expect(res.adopted).toHaveLength(1);
    expect(res.adopted[0].files).toEqual(['level.json']);
    // the live product now holds the candidate content.
    expect(await fs.readFile(join(workspace, 'level.json'), 'utf8')).toContain('fixed');
    // a real commit landed with the greppable subject + Issue trailer (preserved from the candidate commit).
    const body = execFileSync('git', ['-C', workspace, 'log', '-1', '--format=%B']).toString();
    expect(body).toContain('optimize(gameplay):');
    expect(body).toContain('Issue: gameplay/soggy-crust');
    // the landed commit is a NEW sha (a cherry-pick), and it IS the live HEAD.
    expect(res.adopted[0].commit).toBe(headOf(workspace));
    // the issue is resolved/fixed with the attempt row linking the LANDED commit ⇄ run.
    const issue = await parseIssueFile(issuePath);
    expect(issue.status).toBe('resolved');
    expect(issue.reason).toBe('fixed');
    expect(issue.attempts).toEqual([{ commit: res.adopted[0].commit, verifiedByRun: 'tS2.gameplay' }]);
  });

  it('skip-proof fix: fix-landed → resolved, verifiedByRun stamped as the UNPROVEN sentinel (null cannot persist)', async () => {
    const { templateDir, issuePath, manifest } = await stageOne({ verifiedByRun: null, issueStatus: 'fix-landed' });
    await adoptSubstrateManifest(manifest, { templateDir });
    const issue = await parseIssueFile(issuePath);
    expect(issue.status).toBe('resolved');
    expect(issue.attempts[0].verifiedByRun).toBe(UNPROVEN_BY_RUN);
  });

  it('skips a discarded record and a no-candidateSha record; a re-adopt is a natural no-op', async () => {
    const { templateDir, manifest } = await stageOne({ verifiedByRun: 'tS2.gameplay', issueStatus: 'verifying' });
    // first adopt lands + resolves.
    await adoptSubstrateManifest(manifest, { templateDir });
    // a second adopt of the SAME manifest: the candidate is already applied → empty cherry-pick → skipped.
    const again = await adoptSubstrateManifest(manifest, { templateDir });
    expect(again.adopted).toEqual([]);
    expect(again.skipped).toHaveLength(1);
    // pin the EMPTY/no-op branch specifically — dropping `conflict` so a mislabeled empty-pick (the base-drift
    // reason) can't satisfy this assertion; the base-drift test below pins /base drift|conflict/ separately.
    expect(again.skipped[0].reason).toMatch(/already applied|nothing to land|empty/i);

    // a discarded record is skipped up front.
    const discarded: SubstrateManifest = { records: [{ ...manifest.records[0], decision: 'discarded' }] };
    const r = await adoptSubstrateManifest(discarded, { templateDir });
    expect(r.adopted).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/not staged/);

    // a record with no candidateSha (a no-edit/oracle-touched discard) is skipped, never a throw.
    const noSha: SubstrateManifest = { records: [{ ...manifest.records[0], candidateSha: undefined }] };
    const r2 = await adoptSubstrateManifest(noSha, { templateDir });
    expect(r2.skipped[0].reason).toMatch(/candidateSha|no candidate commit/i);
  });

  it('BASE DRIFT: a conflicting live change ⇒ cherry-pick aborted, record skipped, issue NOT resolved, tree untouched', async () => {
    const { workspace, templateDir, issuePath, manifest } = await stageOne({ verifiedByRun: 'tS2.gameplay', issueStatus: 'verifying' });
    // the live branch moves past baseSha with a CONFLICTING change to the SAME file.
    await fs.writeFile(join(workspace, 'level.json'), '{"v":3,"live":true}\n');
    execFileSync('git', ['-C', workspace, 'add', '-A']);
    execFileSync('git', ['-C', workspace, 'commit', '-qm', 'live drift']);
    const driftHead = headOf(workspace);

    const res = await adoptSubstrateManifest(manifest, { templateDir });
    expect(res.adopted).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toMatch(/base drift|conflict/i);
    // the live tree is untouched (HEAD unchanged) and the issue is NOT resolved.
    expect(headOf(workspace)).toBe(driftHead);
    expect((await parseIssueFile(issuePath)).status).toBe('verifying');
    // no half-applied cherry-pick was left behind (CHERRY_PICK_HEAD was aborted).
    expect(() => execFileSync('git', ['-C', workspace, 'rev-parse', '--verify', 'CHERRY_PICK_HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] })).toThrow();
  });

  // ── Defect 1 (CRITICAL) FINAL BACKSTOP: adopt refuses to cherry-pick an oracle-touched candidate. ───────────
  it('SKIPS an oracle-touched staged record — never cherry-picks the scorer-tamper into the live product', async () => {
    // a live repo whose node.json declares eval/check.mjs as the measure ORACLE.
    const workspace = await scratch('piflow-repo-');
    await fs.mkdir(join(workspace, 'eval'), { recursive: true });
    await fs.writeFile(join(workspace, 'eval', 'check.mjs'), '// scorer\n');
    await fs.writeFile(join(workspace, 'level.json'), '{"v":1}\n');
    seedGitRepo(workspace);

    const templateDir = await scratch('piflow-tpl-');
    const nodeDir = join(templateDir, 'nodes', 'gameplay');
    await fs.mkdir(join(nodeDir, 'issues'), { recursive: true });
    await fs.writeFile(join(nodeDir, 'node.json'), JSON.stringify({
      contract: { readScope: ['{{WORKSPACE}}/eval'] },
      optimize: { measure: [{ id: 'f', run: { cmd: 'node', args: ['{{WORKSPACE}}/eval/check.mjs'] } }] },
    }));
    const issuePath = join(nodeDir, 'issues', 'soggy-crust.md');
    const issue = makeIssue({ status: 'verifying' });
    await writeIssueFile(issuePath, issue);

    // a REAL candidate commit that EDITS the oracle file (as if the fixer-side guard were somehow bypassed).
    const cwt = await prepareCandidateWorktree(workspace, { node: 'gameplay', issue: 'soggy-crust', attempt: 1 });
    await fs.writeFile(join(cwt.worktreeDir, 'eval', 'check.mjs'), '// TAMPERED\n');
    const committed = commitCandidate(cwt.worktreeDir, cwt.baseSha, { node: 'gameplay', name: 'soggy-crust', id: issue.id, title: issue.title });
    removeCandidateWorktree(workspace, cwt.worktreeDir);
    const record: SubstrateManifestRecord = {
      issue: 'soggy-crust', issueId: issue.id, node: 'gameplay', decision: 'staged',
      candidateRef: cwt.branch, liveRoot: workspace, baseSha: cwt.baseSha, candidateSha: committed.candidateSha!,
      landPolicy: 'stage-for-human', reason: 'staged', verifiedByRun: 'tS2.gameplay', deltaSummary: {},
    };

    const head = headOf(workspace);
    const res = await adoptSubstrateManifest({ records: [record] }, { templateDir });
    expect(res.adopted).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toMatch(/oracle path/i);
    // the live product is UNTOUCHED (HEAD unchanged, scorer not tampered).
    expect(headOf(workspace)).toBe(head);
    expect(await fs.readFile(join(workspace, 'eval', 'check.mjs'), 'utf8')).toBe('// scorer\n');
  });

  // ── WS-B5 the adopt TRAIN: staleness policy · stale-base bounce · branch GC (docs/design/optimize-blame.md §6) ──
  const branchExists = (repo: string, branch: string): boolean => {
    try {
      execFileSync('git', ['-C', repo, 'rev-parse', '--verify', `refs/heads/${branch}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      return true;
    } catch {
      return false;
    }
  };
  const commitAll = (repo: string, msg: string): void => {
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', repo, 'commit', '-qm', msg], { stdio: ['ignore', 'pipe', 'pipe'] });
  };

  /** stageOne's richer twin: a node.json declaring `contract.readScope` (so `readClosureRefs` yields a real
   *  include-closure), plus an OUTSIDE-closure file — the staleness policy needs a real closure to assess. */
  async function stageWithClosure(opts: { issueStatus: Issue['status'] }) {
    const workspace = await scratch('piflow-repo-');
    await fs.mkdir(join(workspace, 'templates'), { recursive: true });
    await fs.writeFile(join(workspace, 'templates', 'level.json'), '{"v":1}\n');
    await fs.writeFile(join(workspace, 'README.md'), 'readme\n'); // OUTSIDE the closure
    seedGitRepo(workspace);

    const templateDir = await scratch('piflow-tpl-');
    const nodeDir = join(templateDir, 'nodes', 'gameplay');
    await fs.mkdir(join(nodeDir, 'issues'), { recursive: true });
    await fs.writeFile(join(nodeDir, 'node.json'), JSON.stringify({ contract: { readScope: ['{{WORKSPACE}}/templates'] } }));
    const issuePath = join(nodeDir, 'issues', 'soggy-crust.md');
    const issue = makeIssue({ status: opts.issueStatus });
    await writeIssueFile(issuePath, issue);

    const { baseSha, candidateSha, branch } = await makeCandidate(workspace, issue, async (wtDir) => {
      await fs.writeFile(join(wtDir, 'templates', 'level.json'), '{"v":2,"fixed":true}\n');
    });
    const record: SubstrateManifestRecord = {
      issue: 'soggy-crust', issueId: issue.id, node: 'gameplay', decision: 'staged',
      candidateRef: branch, liveRoot: workspace, baseSha, candidateSha,
      landPolicy: 'stage-for-human', reason: 'staged', verifiedByRun: 'tS2.gameplay', deltaSummary: {},
    };
    return { workspace, templateDir, issuePath, record, branch };
  }

  it('FRESH (base unmoved) lands, and GC deletes the attempt branch after resolve', async () => {
    const { workspace, templateDir, issuePath, record, branch } = await stageWithClosure({ issueStatus: 'verifying' });
    expect(branchExists(workspace, branch)).toBe(true); // present before adopt
    const res = await adoptSubstrateManifest({ records: [record] }, { templateDir });
    expect(res.adopted).toHaveLength(1);
    expect(res.adopted[0].note).toBeUndefined(); // fresh → no base-drift note
    expect((await parseIssueFile(issuePath)).status).toBe('resolved');
    expect(branchExists(workspace, branch)).toBe(false); // GC'd after a successful land
  });

  it('DISJOINT (base moved OUTSIDE the closure) lands WITH a base-drift note; the adopted event carries it', async () => {
    const { workspace, templateDir, issuePath, record } = await stageWithClosure({ issueStatus: 'verifying' });
    await fs.writeFile(join(workspace, 'README.md'), 'unrelated change\n');
    commitAll(workspace, 'drift outside closure');
    const events: SubstrateEvent[] = [];
    const res = await adoptSubstrateManifest({ records: [record] }, { templateDir, onEvent: (e) => events.push(e) });
    expect(res.adopted).toHaveLength(1);
    expect(res.adopted[0].note).toMatch(/closure-disjoint|base drift/i);
    const adopted = events.find((e) => e.type === 'adopted');
    expect(adopted && adopted.type === 'adopted' ? adopted.note : undefined).toMatch(/closure-disjoint|base drift/i);
    expect((await parseIssueFile(issuePath)).status).toBe('resolved');
  });

  it('OVERLAP (base moved INSIDE the closure), no reprove ⇒ BOUNCE: not picked, issue → open, record discarded w/ stale-base, branch KEPT', async () => {
    const { workspace, templateDir, issuePath, record, branch } = await stageWithClosure({ issueStatus: 'verifying' });
    const runDir = await scratch('piflow-run-');
    // drift INSIDE the closure but a DIFFERENT file → no textual conflict; the bounce is the POLICY, not a pick conflict.
    await fs.writeFile(join(workspace, 'templates', 'other.json'), '{"drift":true}\n');
    commitAll(workspace, 'drift inside closure');
    const driftHead = headOf(workspace);

    const res = await adoptSubstrateManifest({ records: [record] }, { templateDir, runDir });
    expect(res.adopted).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toMatch(/stale base|closure overlap|bounced/i);
    expect(headOf(workspace)).toBe(driftHead); // NOT picked — live HEAD unchanged
    expect((await parseIssueFile(issuePath)).status).toBe('open'); // verifying → open walk-back
    const rec = JSON.parse(await fs.readFile(join(runDir, 'optimize', 'issues', 'gameplay', 'soggy-crust', 'record.json'), 'utf8'));
    expect(rec.decision).toBe('discarded');
    expect(rec.dropback.category).toBe('stale-base');
    expect(rec.dropback.steer).toMatch(/re-fix against current HEAD/);
    expect(branchExists(workspace, branch)).toBe(true); // NEVER GC a bounce — the escalation candidate keeps its branch
  });

  it('OVERLAP with reprove ACCEPT lands (re-proved note); the reprove seam is passed the record', async () => {
    const { workspace, templateDir, issuePath, record } = await stageWithClosure({ issueStatus: 'verifying' });
    await fs.writeFile(join(workspace, 'templates', 'other.json'), '{"drift":true}\n');
    commitAll(workspace, 'drift inside closure');
    let seenRecordIssue = '';
    const res = await adoptSubstrateManifest({ records: [record] }, {
      templateDir,
      reprove: async (r) => { seenRecordIssue = r.issue; return { accept: true, reason: 'fresh replay still green' }; },
    });
    expect(seenRecordIssue).toBe('soggy-crust');
    expect(res.adopted).toHaveLength(1);
    expect(res.adopted[0].note).toMatch(/re-proved against/i);
    expect((await parseIssueFile(issuePath)).status).toBe('resolved');
  });

  it('OVERLAP reprove ACCEPT with a HEAD-rebuilt candidateSha lands the REBUILT commit, not the stale one', async () => {
    const { workspace, templateDir, issuePath, record } = await stageWithClosure({ issueStatus: 'verifying' });
    await fs.writeFile(join(workspace, 'templates', 'other.json'), '{"drift":true}\n');
    commitAll(workspace, 'drift inside closure');
    // a REAL fresh candidate on the moved HEAD (attempt-2 branch, distinct sha + distinct content) the reprove hands back.
    const wt2 = await prepareCandidateWorktree(workspace, { node: 'gameplay', issue: 'soggy-crust', attempt: 2 });
    await fs.writeFile(join(wt2.worktreeDir, 'templates', 'level.json'), '{"v":3,"rebuilt":true}\n');
    const rebuilt = commitCandidate(wt2.worktreeDir, wt2.baseSha, { node: 'gameplay', name: 'soggy-crust', id: record.issueId, title: 'rebuilt' });
    removeCandidateWorktree(workspace, wt2.worktreeDir);

    const res = await adoptSubstrateManifest({ records: [record] }, {
      templateDir,
      reprove: async () => ({ accept: true, reason: 'rebuilt + re-proved', candidateSha: rebuilt.candidateSha }),
    });
    expect(res.adopted).toHaveLength(1);
    expect(res.adopted[0].note).toMatch(/re-proved|rebuilt/i);
    expect(res.adopted[0].commit).not.toBe(record.candidateSha); // the landed commit is the REBUILT one
    expect((await parseIssueFile(issuePath)).status).toBe('resolved');
    // the REBUILT content landed on disk — not the stale candidate's {"v":2}.
    expect(await fs.readFile(join(workspace, 'templates', 'level.json'), 'utf8')).toContain('rebuilt');
  });

  it('reproveCandidate ACCEPT: rebuilds on HEAD, re-runs the node vs the fresh base, gates → HEAD-rebuilt sha', async () => {
    const { workspace, templateDir, record } = await stageWithClosure({ issueStatus: 'verifying' });
    const parentRunDir = await scratch('piflow-run-');
    await fs.mkdir(join(parentRunDir, 'optimize', 'substrate'), { recursive: true });
    await fs.writeFile(join(parentRunDir, 'optimize', 'substrate', 'measure.gameplay.json'), JSON.stringify({ graded: { score: 0.5 } }));
    // drift INSIDE the closure but a DIFFERENT file → the candidate cherry-picks clean onto HEAD (no conflict).
    await fs.writeFile(join(workspace, 'templates', 'other.json'), '{"drift":true}\n');
    commitAll(workspace, 'drift inside closure');
    const headBefore = headOf(workspace);

    let seenWorkspace = '';
    const res = await reproveCandidate(record, {
      templateDir, parentRunDir,
      spawnChild: async (_p, _n, o) => { seenWorkspace = o.workspace ?? ''; return childResult('rp-child', await scratch()); },
      measure: async () => measureReport({ score: 0.9 }), // improved vs the parent baseline 0.5
    });

    expect(res.accept).toBe(true);
    expect(res.candidateSha).toBeDefined();
    expect(res.candidateSha).not.toBe(record.candidateSha); // a HEAD-rebuilt commit, not the stale one
    expect(seenWorkspace).toMatch(/reprove/); // the node ran against the HEAD+fix scratch worktree
    expect(headOf(workspace)).toBe(headBefore); // re-prove NEVER touches the live branch
  });

  it('reproveCandidate REJECT: a regressed replay ⇒ bounce, no substitute sha', async () => {
    const { workspace, templateDir, record } = await stageWithClosure({ issueStatus: 'verifying' });
    const parentRunDir = await scratch('piflow-run-');
    await fs.mkdir(join(parentRunDir, 'optimize', 'substrate'), { recursive: true });
    await fs.writeFile(join(parentRunDir, 'optimize', 'substrate', 'measure.gameplay.json'), JSON.stringify({ graded: { score: 0.5 } }));
    await fs.writeFile(join(workspace, 'templates', 'other.json'), '{"drift":true}\n');
    commitAll(workspace, 'drift inside closure');
    const res = await reproveCandidate(record, {
      templateDir, parentRunDir,
      spawnChild: async () => childResult('rp-child', await scratch()),
      measure: async () => measureReport({ score: 0.3 }), // regressed vs 0.5
    });
    expect(res.accept).toBe(false);
    expect(res.candidateSha).toBeUndefined();
  });

  it('reproveCandidate FAIL-SAFE: a spawnChild error bounces (never force-lands)', async () => {
    const { workspace, templateDir, record } = await stageWithClosure({ issueStatus: 'verifying' });
    const parentRunDir = await scratch('piflow-run-');
    await fs.writeFile(join(workspace, 'templates', 'other.json'), '{"drift":true}\n');
    commitAll(workspace, 'drift inside closure');
    const res = await reproveCandidate(record, {
      templateDir, parentRunDir,
      spawnChild: async () => { throw new Error('pi spawn exploded'); },
      measure: async () => measureReport({ score: 0.9 }),
    });
    expect(res.accept).toBe(false);
  });

  it('OVERLAP with reprove REJECT ⇒ bounce (not landed)', async () => {
    const { workspace, templateDir, issuePath, record } = await stageWithClosure({ issueStatus: 'verifying' });
    const runDir = await scratch('piflow-run-');
    await fs.writeFile(join(workspace, 'templates', 'other.json'), '{"drift":true}\n');
    commitAll(workspace, 'drift inside closure');
    const res = await adoptSubstrateManifest({ records: [record] }, {
      templateDir, runDir, reprove: async () => ({ accept: false, reason: 'fresh replay regressed' }),
    });
    expect(res.adopted).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect((await parseIssueFile(issuePath)).status).toBe('open');
  });

  it('BOUNCE of a fix-landed (skip-proof) issue walks it back to OPEN — re-fixable, never stranded', async () => {
    const { workspace, templateDir, issuePath, record } = await stageWithClosure({ issueStatus: 'fix-landed' });
    const runDir = await scratch('piflow-run-');
    await fs.writeFile(join(workspace, 'templates', 'other.json'), '{"drift":true}\n');
    commitAll(workspace, 'drift inside closure');
    const res = await adoptSubstrateManifest({ records: [record] }, { templateDir, runDir });
    expect(res.skipped).toHaveLength(1);
    // the skip-proof bounce now rides the legal fix-landed → open back-edge — the issue returns to the open pool.
    expect((await parseIssueFile(issuePath)).status).toBe('open');
    const rec = JSON.parse(await fs.readFile(join(runDir, 'optimize', 'issues', 'gameplay', 'soggy-crust', 'record.json'), 'utf8'));
    expect(rec.decision).toBe('discarded');
    expect(rec.dropback.category).toBe('stale-base');
    // follow-on: the bounced issue is genuinely re-fixable (open → active is legal) — not the permanent dead state.
    await expect(transitionIssue(issuePath, 'active')).resolves.toBeDefined();
  });

  it('BOUNCE without opts.runDir ⇒ walk-back still happens, but no record.json is rewritten (documented degrade)', async () => {
    const { workspace, templateDir, issuePath, record } = await stageWithClosure({ issueStatus: 'verifying' });
    await fs.writeFile(join(workspace, 'templates', 'other.json'), '{"drift":true}\n');
    commitAll(workspace, 'drift inside closure');
    const res = await adoptSubstrateManifest({ records: [record] }, { templateDir }); // no runDir
    expect(res.skipped).toHaveLength(1);
    expect((await parseIssueFile(issuePath)).status).toBe('open');
  });

  it('gcBranches:false preserves the attempt branch even on a successful land', async () => {
    const { workspace, templateDir, record, branch } = await stageWithClosure({ issueStatus: 'verifying' });
    const res = await adoptSubstrateManifest({ records: [record] }, { templateDir, gcBranches: false });
    expect(res.adopted).toHaveLength(1);
    expect(branchExists(workspace, branch)).toBe(true); // --no-gc → branch preserved
  });
});
