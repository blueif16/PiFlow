// optimize/substrate/fix.ts + events.ts — the M6 FIX phase (docs/specs/optimize-substrate-plan.md §M6).
// Every test FAILS when the code is wrong (proven by mutation in the M6 return note). No live claude/pi
// spawn: the fixer agent, the child prove-run, and the measure pass are all injected seams; commitAdoption
// and adoptSubstrateManifest run against a THROWAWAY git repo created per test in a temp dir.
//
// Run: npx vitest run packages/core/test/optimize-substrate-fix.test.ts

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  fixIssue,
  adoptSubstrateManifest,
  commitAdoption,
  prepareCandidateClosure,
  collectWorkspaceRefs,
  foldGradedDelta,
  hashCandidateTree,
  countChangedFiles,
  buildFixerPrompt,
  readSubstrateManifest,
  UNPROVEN_BY_RUN,
  type SubstrateManifest,
  type SubstrateManifestRecord,
} from '../src/optimize/substrate/fix.js';
import { renderSubstrateEvent, safeEmit, type SubstrateEvent } from '../src/optimize/substrate/events.js';
import { computeIssueId, writeIssueFile, parseIssueFile, type Issue } from '../src/optimize/substrate/issues.js';
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

/** A gameplay fixture: template (node.json + one open issue), workspace (readScope files + a measure script
 *  living INSIDE a readScope dir), and a parent run carrying a base graded measure report. */
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
          // the scorer script lives INSIDE the readScope `eval` dir — the exclusion must skip it during the walk.
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
  await fs.writeFile(join(workspace, 'eval', 'check.mjs'), '// the scorer — must NEVER land in the candidate\n');
  await fs.writeFile(join(workspace, 'eval', 'data.json'), '{"kept":true}\n'); // a non-oracle eval file

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

/** A fixer that appends bytes to a copied candidate file (a real, hash-visible edit). */
const editingAgent = async (o: { cwd: string }): Promise<RunBaseAgentResult> => {
  await fs.appendFile(join(o.cwd, 'templates', 'genres.json'), '\n// fixed\n');
  return agentResult();
};
/** A fixer that touches nothing (a no-op proposal → editsApplied 0). */
const noopAgent = async (): Promise<RunBaseAgentResult> => agentResult();

function initGitRepo(dir: string): void {
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'test@piflow.dev');
  git('config', 'user.name', 'piflow test');
  git('config', 'commit.gpgsign', 'false');
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
    // payload-specific evidence (not just the tag)
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
      bare: '{{WORKSPACE}}', // the whole product root — never a copy target
      none: 'no token here',
    });
    expect([...refs].sort()).toEqual(['eval/check.mjs', 'src/x.mjs', 'templates/genres.json']);
  });

  it('normalizes redundant separators and drops workspace-escaping / empty paths', () => {
    const refs = collectWorkspaceRefs(['{{WORKSPACE}}/a//b/', '{{WORKSPACE}}/../escape', '{{WORKSPACE}}/']);
    expect([...refs]).toEqual(['a/b']);
  });
});

// ── prepareCandidateClosure — the oracle-exclusion rule (M6.1) ──────────────────────────────────────────────
describe('prepareCandidateClosure — copies the read closure MINUS the oracle', () => {
  it('a measure-script path (inside a readScope dir) NEVER lands in the candidate; non-oracle siblings DO', async () => {
    const { templateDir, workspace } = await setupFixture();
    const candidateDir = await scratch('piflow-cand-');
    const closure = await prepareCandidateClosure(templateDir, 'gameplay', { workspace, candidateDir });

    // the included read closure landed …
    expect(await fs.readFile(join(candidateDir, 'templates', 'genres.json'), 'utf8')).toContain('"a":1');
    expect(await fs.readFile(join(candidateDir, 'eval', 'data.json'), 'utf8')).toContain('kept'); // non-oracle sibling
    // … but the oracle scorer, though it lives INSIDE the readScope `eval` dir, was skipped by the walk.
    await expect(fs.access(join(candidateDir, 'eval', 'check.mjs'))).rejects.toThrow();
    expect(closure.excluded).toContain('eval/check.mjs');
    expect(closure.included.sort()).toEqual(['eval', 'templates']);
  });

  it('excludes an optimize.judge file even when its dir is in readScope', async () => {
    const templateDir = await scratch('piflow-tpl-');
    const workspace = await scratch('piflow-ws-');
    const nodeDir = join(templateDir, 'nodes', 'n');
    await fs.mkdir(nodeDir, { recursive: true });
    await fs.writeFile(
      join(nodeDir, 'node.json'),
      JSON.stringify({
        contract: { readScope: ['{{WORKSPACE}}/skills'] },
        optimize: { judge: '{{WORKSPACE}}/skills/judge.md' },
      }),
    );
    await fs.mkdir(join(workspace, 'skills'), { recursive: true });
    await fs.writeFile(join(workspace, 'skills', 'judge.md'), 'JUDGE');
    await fs.writeFile(join(workspace, 'skills', 'helper.md'), 'HELPER');

    const candidateDir = await scratch('piflow-cand-');
    await prepareCandidateClosure(templateDir, 'n', { workspace, candidateDir });
    await expect(fs.access(join(candidateDir, 'skills', 'judge.md'))).rejects.toThrow(); // oracle judge excluded
    expect(await fs.readFile(join(candidateDir, 'skills', 'helper.md'), 'utf8')).toBe('HELPER'); // sibling kept
  });

  it('throws (naming the file) when the node.json is missing', async () => {
    const templateDir = await scratch('piflow-tpl-');
    const candidateDir = await scratch('piflow-cand-');
    await expect(prepareCandidateClosure(templateDir, 'ghost', { workspace: templateDir, candidateDir })).rejects.toThrow(
      /node\.json/,
    );
  });
});

// ── hashCandidateTree / countChangedFiles ────────────────────────────────────────────────────────────────
describe('editsApplied diff — hashCandidateTree + countChangedFiles', () => {
  it('counts adds, removes, and content changes; a pure re-read is 0', async () => {
    const dir = await scratch('piflow-diff-');
    await fs.writeFile(join(dir, 'a.txt'), 'a');
    await fs.writeFile(join(dir, 'b.txt'), 'b');
    const before = await hashCandidateTree(dir);
    expect(countChangedFiles(before, await hashCandidateTree(dir))).toBe(0); // idempotent read

    await fs.writeFile(join(dir, 'a.txt'), 'a-CHANGED'); // change
    await fs.rm(join(dir, 'b.txt')); // remove
    await fs.writeFile(join(dir, 'c.txt'), 'c'); // add
    expect(countChangedFiles(before, await hashCandidateTree(dir))).toBe(3);
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

// ── commitAdoption — against a throwaway git repo (M6.4) ──────────────────────────────────────────────────
describe('commitAdoption — subject/trailer format, SHA capture, empty-diff no-op', () => {
  it('commits staged files with the optimize(<node>) subject + Issue trailer, returns the real SHA', async () => {
    const repo = await scratch('piflow-repo-');
    initGitRepo(repo);
    await fs.writeFile(join(repo, 'seed.txt'), 'seed');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'seed']);

    await fs.writeFile(join(repo, 'level.json'), '{"fixed":true}');
    const issue = { node: 'gameplay', name: 'soggy-crust', id: computeIssueId('gameplay', 'gameplay::compose-in-thinking'), title: 'compose() thinks too long' };
    const r = commitAdoption(repo, ['level.json'], issue);

    expect(r.committed).toBe(true);
    expect(r.subject).toBe('optimize(gameplay): compose() thinks too long');
    const hash7 = issue.id.replace('sha256:', '').slice(0, 7);
    expect(r.trailer).toBe(`Issue: gameplay/soggy-crust — "compose() thinks too long" (${hash7})`);
    // the SHA is the real HEAD, and the message on disk carries subject + trailer.
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
    expect(r.sha).toBe(head);
    const body = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%B']).toString();
    expect(body).toContain(r.subject);
    expect(body).toContain(r.trailer);
  });

  it('is a NO-OP (committed:false, sha:"") when nothing is staged', async () => {
    const repo = await scratch('piflow-repo-');
    initGitRepo(repo);
    await fs.writeFile(join(repo, 'seed.txt'), 'seed');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'seed']);
    const before = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();

    const issue = { node: 'gameplay', name: 'n', id: computeIssueId('gameplay', 'gameplay::x'), title: 't' };
    const r = commitAdoption(repo, ['seed.txt'], issue); // seed.txt is unchanged → nothing staged
    expect(r.committed).toBe(false);
    expect(r.sha).toBe('');
    expect(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim()).toBe(before); // no new commit
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
    // a data-tier anchor points the fixer at its staged playbook by id (the procedure this contract assumes).
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
    expect(p).toMatch(/do not repeat/i); // the anti-repeat instruction …
    expect(p).toMatch(/different/i); //     … and the diversify order
    expect(p).toContain('didnt-reach-root'); // the coarse category the gate returned
    expect(p).toContain('STEER-MARKER: the root is upstream in the schema'); // the diversification steer
    expect(p).toContain('ACCOUNT-MARKER: I only reworded the prompt'); // what the prior fixer tried (don't repeat)
  });

  it('omits the diversification block on the first attempt (no retry context) — the block is CONDITIONAL', () => {
    const p = buildFixerPrompt('---\ntitle: X\n---\nISSUE-BODY-MARKER-9', 'gameplay');
    expect(p).not.toMatch(/prior attempt/i);
  });
});

// ── fixIssue — retry threading (per-attempt candidate dir + diversification prompt) ─────────────────────────
describe('fixIssue — attemptTag + retry context threading', () => {
  it('scopes the candidate dir by attemptTag and threads the retry context into the fixer prompt', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    let capturedPrompt = '';
    let capturedCwd = '';
    const res = await fixIssue(issuePath, {
      parentRunDir,
      templateDir,
      workspace,
      prove: false, // isolate the spawn composition — no child run needed
      attemptTag: 'attempt-2',
      retry: { attempt: 2, priorDropbacks: [{ category: 'band-aid', steer: 'RETRY-STEER-42' }], priorAccounts: ['reworded only'] },
      runAgent: async (o: { cwd: string; prompt: string }): Promise<RunBaseAgentResult> => {
        capturedPrompt = o.prompt;
        capturedCwd = o.cwd;
        await fs.appendFile(join(o.cwd, 'templates', 'genres.json'), '\n// fixed\n'); // a real edit ⇒ editsApplied ≥ 1
        return agentResult();
      },
    });
    const tail = join('candidates', 'soggy-crust', 'attempt-2');
    expect(res.candidateRef.endsWith(tail)).toBe(true); // per-attempt dir, not the shared candidates/<issue>
    expect(capturedCwd.endsWith(tail)).toBe(true); // the fixer actually ran in that per-attempt dir
    expect(capturedPrompt).toMatch(/prior attempt/i); // retry threaded → diversification block present
    expect(capturedPrompt).toContain('RETRY-STEER-42');
  });

  it('defaults to the shared candidates/<issue> dir when no attemptTag is given (backward compatible)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    const res = await fixIssue(issuePath, {
      parentRunDir,
      templateDir,
      workspace,
      prove: false,
      runAgent: editingAgent,
    });
    expect(res.candidateRef.endsWith(join('candidates', 'soggy-crust'))).toBe(true);
    expect(res.candidateRef.endsWith(join('soggy-crust', 'soggy-crust'))).toBe(false); // no accidental double nest
  });
});

// ── fixIssue — the per-issue orchestration (seams injected) ───────────────────────────────────────────────
describe('fixIssue — prove path (edit → child → graded delta → accept → stage)', () => {
  it('stages an accepted, proven fix: status verifying, verifiedByRun=childId, oracle absent from candidate', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture({ baseGraded: { 'feas.score': 0.5 } });
    const expectedCandidate = join(parentRunDir, 'optimize', 'substrate', 'staging', 'candidates', 'soggy-crust');
    const events: SubstrateEvent[] = [];
    const res = await fixIssue(issuePath, {
      parentRunDir,
      templateDir,
      workspace,
      onEvent: (e) => events.push(e),
      runAgent: editingAgent,
      spawnChild: async (_p, _n, o) => {
        const childDir = await scratch('piflow-child-');
        expect(o.workspace).toBe(expectedCandidate); // the node re-runs against the CANDIDATE workspace
        expect(o.spawnedBy).toEqual({ by: 'substrate-fix', issue: 'soggy-crust', issueId: makeIssue().id });
        return childResult('tS2.gameplay', childDir);
      },
      measure: async (_runDir, _node, o) => {
        expect(o.workspace).toBe(workspace); // measured against the LIVE product root (pristine oracle)
        return measureReport({ 'feas.score': 0.9 });
      },
    });

    expect(res.editsApplied).toBe(1);
    expect(res.proved).toBe(true);
    expect(res.childId).toBe('tS2.gameplay');
    expect(res.verdict.accept).toBe(true);
    expect(res.decision).toBe('staged');
    expect(res.deltaSummary).toEqual({ 'feas.score': expect.closeTo(0.4, 6) });

    // the candidate physically excludes the scorer.
    await expect(fs.access(join(res.candidateRef, 'eval', 'check.mjs'))).rejects.toThrow();

    // the ledger advanced open → active → fix-landed → verifying (awaiting the human adopt).
    expect((await parseIssueFile(issuePath)).status).toBe('verifying');

    // the manifest carries the staged record with the childId as verifiedByRun.
    const manifest = await readSubstrateManifest(join(parentRunDir, 'optimize', 'substrate', 'staging'));
    expect(manifest.records).toHaveLength(1);
    expect(manifest.records[0]).toMatchObject({ issue: 'soggy-crust', decision: 'staged', verifiedByRun: 'tS2.gameplay', node: 'gameplay' });

    // the event stream narrated every boundary in order.
    expect(events.map((e) => e.type)).toEqual([
      'issue-activated', 'candidate-prepared', 'fixer-started', 'fixer-done', 'prove-started', 'measured', 'gated', 'staged', 'stopped',
    ]);
  });
});

describe('fixIssue — prove path rejects a regression (no auto-adopt)', () => {
  it('a measured regression ⇒ verdict reject, decision discarded, no verifiedByRun win', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture({ baseGraded: { 'feas.score': 0.9 } });
    const res = await fixIssue(issuePath, {
      parentRunDir,
      templateDir,
      workspace,
      runAgent: editingAgent,
      spawnChild: async () => childResult('tS2.gameplay', await scratch('piflow-child-')),
      measure: async () => measureReport({ 'feas.score': 0.4 }), // worse than base 0.9
    });
    expect(res.verdict.accept).toBe(false);
    expect(res.decision).toBe('discarded');
    const manifest = await readSubstrateManifest(join(parentRunDir, 'optimize', 'substrate', 'staging'));
    expect(manifest.records[0].decision).toBe('discarded');

    // TASK 0: a proven-REJECT must NOT strand the issue at `verifying` — it walks back to `open` so a
    // later triage/fix can re-attempt it. Nothing landed: reason stays null, no attempt row is stamped.
    const after = await parseIssueFile(issuePath);
    expect(after.status).toBe('open');
    expect(after.reason).toBeNull();
    expect(after.attempts).toEqual([]);
  });
});

describe('fixIssue — SOFT gate path (no numeric oracle → the independent gate agent decides)', () => {
  /** Give the node an `optimize.judge` so `nodeHasJudge()` is true and the SOFT path is taken. The judge file
   *  need not exist — the injected `gate` seam replaces `runSubstrateGate`, so `buildGatePrompt` never runs. */
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
    const res = await fixIssue(issuePath, {
      parentRunDir,
      templateDir,
      workspace,
      runAgent: async (o) => {
        await fs.appendFile(join(o.cwd, 'templates', 'genres.json'), '\n// fixed\n'); // a real edit
        return { status: okStatus(), text: 'ACCOUNT: I added an enumeration rule for every named mechanic.' };
      },
      spawnChild: async () => childResult('tS2.gameplay', await scratch('piflow-child-')),
      measure: async () => measureReport({}), // graded {} ⇒ no shared keys ⇒ SOFT path (numeric gate can't decide)
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
    // the gate received the issue text, the fixer's own account, and read access to the candidate harness
    expect(gateSeen.issueFileText).toContain('compose');
    expect(gateSeen.fixerAccount).toContain('enumeration rule');
    expect(gateSeen.candidateRef).toBe(res.candidateRef);
    // a staged candidate stays at `verifying`, awaiting the human adopt (never a judge-gated auto-accept)
    expect((await parseIssueFile(issuePath)).status).toBe('verifying');
    const manifest = await readSubstrateManifest(join(parentRunDir, 'optimize', 'substrate', 'staging'));
    expect(manifest.records[0]).toMatchObject({ decision: 'staged', landPolicy: 'stage-for-human', verifiedByRun: 'tS2.gameplay' });
  });

  it('REJECT ⇒ discarded, issue walks back to OPEN (re-attemptable), drop-back packet persisted (NO rubric)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    await makeSoft(templateDir);
    const res = await fixIssue(issuePath, {
      parentRunDir,
      templateDir,
      workspace,
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

    // the drop-back path (the least-tested path elsewhere): a proven-REJECT walks the issue back to `open` so a
    // FRESH fixer can re-attempt it. Nothing landed: reason null, no attempt stamped.
    const after = await parseIssueFile(issuePath);
    expect(after.status).toBe('open');
    expect(after.reason).toBeNull();
    expect(after.attempts).toEqual([]);

    // the drop-back packet rides the manifest for the outer loop — it carries the category + steer, no criteria.
    const manifest = await readSubstrateManifest(join(parentRunDir, 'optimize', 'substrate', 'staging'));
    expect(manifest.records[0].dropback).toEqual({ category: 'band-aid', steer: 'the root is upstream in the prompt, not the schema' });
  });

  it('a node with NEITHER a number NOR a judge does NOT invoke the gate agent (evaluateGate stage-for-human)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture(); // measure {} + NO judge
    let gateCalled = false;
    const res = await fixIssue(issuePath, {
      parentRunDir,
      templateDir,
      workspace,
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

describe('fixIssue — skip-proof path (prove off)', () => {
  it('editsApplied≥1 with prove:false ⇒ no child run, status fix-landed, decision staged (unmeasurable→human), verifiedByRun null', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    let spawned = false;
    const res = await fixIssue(issuePath, {
      parentRunDir,
      templateDir,
      workspace,
      prove: false,
      runAgent: editingAgent,
      spawnChild: async () => { spawned = true; return childResult('x', await scratch()); },
      measure: async () => measureReport({}),
    });
    expect(spawned).toBe(false); // proving skipped → no child run
    expect(res.proved).toBe(false);
    expect(res.childId).toBeNull();
    expect(res.decision).toBe('staged'); // unmeasurable ⇒ stage-for-human
    expect(res.record.verifiedByRun).toBeNull();
    expect((await parseIssueFile(issuePath)).status).toBe('fix-landed'); // the skip-proof landing state
  });
});

describe('fixIssue — surfaces the fixer agent\'s runDir (Phase-3 observe wiring)', () => {
  it('forwards the LIVE fixer spawn\'s runDir onto FixIssueResult.fixerRunDir, so the observe instruments can read the spawn like a node', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    const res = await fixIssue(issuePath, {
      parentRunDir,
      templateDir,
      workspace,
      prove: false,
      runAgent: async (o) => {
        await fs.appendFile(join(o.cwd, 'templates', 'genres.json'), '\n// fixed\n'); // a real edit → normal flow
        return { ...agentResult(), runDir: '/fake/observe/fix-dir' };
      },
      spawnChild: async () => childResult('x', await scratch()),
      measure: async () => measureReport({}),
    });
    // RED before the wiring: the ONLY live `runAgent(fixerSpawn(...))` call's result (fix.ts's fixer-spawn
    // site) was discarded entirely — nothing surfaced its `runDir` onto FixIssueResult.
    expect(res.fixerRunDir).toBe('/fake/observe/fix-dir');
  });

  it('is ABSENT when the fixer spawn returns no runDir (the ephemeral default — nothing was persisted)', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    const res = await fixIssue(issuePath, {
      parentRunDir,
      templateDir,
      workspace,
      prove: false,
      runAgent: editingAgent,
      spawnChild: async () => childResult('x', await scratch()),
      measure: async () => measureReport({}),
    });
    expect(res.fixerRunDir).toBeUndefined();
  });
});

describe('fixIssue — stages the piflow-fixer playbook for the fixer spawn', () => {
  it('passes the EXACT piflow-fixer skill PATH (product-root .claude/skills) to runAgent — a path-like ref the runner uses DIRECTLY, no fragile ring-search from the candidate cwd', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    let capturedSkill: string | undefined = 'UNSET';
    const capturingRunAgent = async (o: RunBaseAgentOpts): Promise<RunBaseAgentResult> => {
      capturedSkill = o.skill; // the bare id 'piflow-fixer' before the wiring → RED against the exact path
      await fs.appendFile(join(o.cwd, 'templates', 'genres.json'), '\n// fixed\n'); // a real edit → normal flow
      return agentResult();
    };
    await fixIssue(issuePath, {
      parentRunDir,
      templateDir,
      workspace,
      prove: false,
      runAgent: capturingRunAgent,
      spawnChild: async () => childResult('x', await scratch()),
      measure: async () => measureReport({}),
    });
    // A path-like ref (absolute path) → the runner uses it DIRECTLY, no ring-search against the fixer's
    // candidate cwd. Before the wiring this was the bare id 'piflow-fixer' → searched the candidate → miss.
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
      parentRunDir,
      templateDir,
      workspace,
      dryRun: true, // a BASE field the fixer's old hand-copied forward list silently dropped
      timeoutMs: 45000,
      runAgent: capturingRunAgent,
      spawnChild: async () => childResult('x', await scratch()),
      measure: async () => measureReport({}),
    });
    // RED before the shared surface: fix.ts's runAgent call enumerated its own subset with no `dryRun`,
    // so the flag was silently lost between FixIssueOpts and the base agent.
    expect(captured?.dryRun).toBe(true);
    expect(captured?.timeoutMs).toBe(45000);
  });
});

describe('fixIssue — dry-run (the inherited base-agent preview)', () => {
  it('returns the composed fixer plan and mutates NOTHING — no issue transition, no candidate copy, no manifest, no events', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture();
    const events: SubstrateEvent[] = [];
    // NO runAgent injection: the REAL base agent short-circuits on dryRun (pure spec-building, spawns nothing).
    const res = await fixIssue(issuePath, {
      parentRunDir,
      templateDir,
      workspace,
      dryRun: true,
      onEvent: (e) => events.push(e),
    });

    const expectedCandidate = join(parentRunDir, 'optimize', 'substrate', 'staging', 'candidates', 'soggy-crust');
    // the plan IS the composition the fixer WOULD get: the issue rides the prompt, the jail is the candidate
    // copy path, the skill is the exact product-root playbook path, the sandbox declares `local`.
    expect(res.dryRun?.prompt).toContain('The compose step burns long thinking spans'); // the issue body = the dispatch
    expect(res.dryRun?.executor).toBe('claude-code');
    expect(res.dryRun?.skill).toBe(join(workspace, '.claude', 'skills', 'piflow-fixer'));
    expect(res.dryRun?.sandbox?.execCwd).toBe(expectedCandidate);
    expect(res.dryRun?.sandbox?.read).toEqual([expectedCandidate]);
    expect(res.dryRun?.sandbox?.write).toEqual([expectedCandidate]);
    expect(res.dryRun?.sandbox?.provider).toBe('local');

    // NOTHING mutated: the issue never left `open` (RED before: dryRun unthreaded → the full mutating flow
    // transitioned it to `active` and prepared a candidate), the candidate dir was never created, no manifest
    // was staged, and the event stream stayed silent.
    expect((await parseIssueFile(issuePath)).status).toBe('open');
    await expect(fs.access(expectedCandidate)).rejects.toThrow();
    expect((await readSubstrateManifest(join(parentRunDir, 'optimize', 'substrate', 'staging'))).records).toEqual([]);
    expect(events).toEqual([]);
    // the mutating-path fields are ABSENT — nothing was decided, gated, or staged.
    expect(res.decision).toBeUndefined();
    expect(res.verdict).toBeUndefined();
    expect(res.manifestPath).toBeUndefined();
    expect(res.editsApplied).toBe(0);
    expect(res.childId).toBeNull();
  });
});

describe('fixIssue — a no-op fixer is rejected', () => {
  it('editsApplied 0 ⇒ gate "no edit applied", decision discarded, status stays active, prove never runs', async () => {
    const { templateDir, workspace, parentRunDir, issuePath } = await setupFixture({ baseGraded: { 'feas.score': 0.5 } });
    let spawned = false;
    const res = await fixIssue(issuePath, {
      parentRunDir,
      templateDir,
      workspace,
      runAgent: noopAgent,
      spawnChild: async () => { spawned = true; return childResult('x', await scratch()); },
      measure: async () => measureReport({ 'feas.score': 0.9 }),
    });
    expect(res.editsApplied).toBe(0);
    expect(res.decision).toBe('discarded');
    expect(res.verdict.reason).toMatch(/no edit applied/);
    expect(spawned).toBe(false); // never proves a 0-edit proposal
    expect((await parseIssueFile(issuePath)).status).toBe('active'); // never advanced to fix-landed
  });
});

// ── adoptSubstrateManifest — the SEPARATE human adopt step, against a throwaway repo (M6.4/M6.6) ─────────────
describe('adoptSubstrateManifest — lands files, commits, stamps the attempt, resolves the issue', () => {
  /** Build a staged manifest for one issue: a live git repo (workspace) + a candidate holding a changed file. */
  async function stageOne(opts: { verifiedByRun: string | null; issueStatus: Issue['status'] }) {
    const workspace = await scratch('piflow-repo-');
    initGitRepo(workspace);
    await fs.writeFile(join(workspace, 'level.json'), '{"v":1}\n');
    execFileSync('git', ['-C', workspace, 'add', '.']);
    execFileSync('git', ['-C', workspace, 'commit', '-qm', 'seed']);

    const templateDir = await scratch('piflow-tpl-');
    const issueDir = join(templateDir, 'nodes', 'gameplay', 'issues');
    await fs.mkdir(issueDir, { recursive: true });
    const issuePath = join(issueDir, 'soggy-crust.md');
    // the issue must be at a status that legally transitions to resolved (fix-landed | verifying).
    const attempts = opts.issueStatus === 'verifying' || opts.issueStatus === 'fix-landed' ? [] : [];
    await writeIssueFile(issuePath, makeIssue({ status: opts.issueStatus, reason: null, attempts }));

    const candidateRef = await scratch('piflow-cand-');
    await fs.writeFile(join(candidateRef, 'level.json'), '{"v":2,"fixed":true}\n'); // the fixer's changed copy

    const record: SubstrateManifestRecord = {
      issue: 'soggy-crust', issueId: makeIssue().id, node: 'gameplay', decision: 'staged',
      candidateRef, liveRoot: workspace, landPolicy: 'auto-adopt-eligible', reason: 'strict improvement (+1)',
      verifiedByRun: opts.verifiedByRun, deltaSummary: { 'feas.score': 0.4 },
    };
    return { workspace, templateDir, issuePath, manifest: { records: [record] } as SubstrateManifest };
  }

  it('proven fix: verifying → resolved, attempt {commit, verifiedByRun=childId}, real commit with the trailer', async () => {
    const { workspace, templateDir, issuePath, manifest } = await stageOne({ verifiedByRun: 'tS2.gameplay', issueStatus: 'verifying' });
    const res = await adoptSubstrateManifest(manifest, { templateDir });

    expect(res.adopted).toHaveLength(1);
    expect(res.adopted[0].files).toEqual(['level.json']);
    // the live product now holds the candidate content.
    expect(await fs.readFile(join(workspace, 'level.json'), 'utf8')).toContain('fixed');
    // a real commit landed with the greppable subject.
    const body = execFileSync('git', ['-C', workspace, 'log', '-1', '--format=%B']).toString();
    expect(body).toContain('optimize(gameplay):');
    expect(body).toContain('Issue: gameplay/soggy-crust');
    // the issue is resolved/fixed with the attempt row linking commit ⇄ run.
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

  it('skips a discarded record, and a re-adopt is a natural no-op (nothing left to land)', async () => {
    const { templateDir, manifest } = await stageOne({ verifiedByRun: 'tS2.gameplay', issueStatus: 'verifying' });
    // first adopt lands + resolves.
    await adoptSubstrateManifest(manifest, { templateDir });
    // a second adopt of the SAME manifest lands 0 files (live == candidate now) → skipped, never a throw.
    const again = await adoptSubstrateManifest(manifest, { templateDir });
    expect(again.adopted).toEqual([]);
    expect(again.skipped[0].reason).toMatch(/no files to land/);

    // a discarded record is skipped up front.
    const discarded: SubstrateManifest = { records: [{ ...manifest.records[0], decision: 'discarded' }] };
    const r = await adoptSubstrateManifest(discarded, { templateDir });
    expect(r.adopted).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/not staged/);
  });
});
