// optimize/substrate/judge.ts — the M4 soft-judge orchestration (docs/specs/optimize-substrate-plan.md §M4).
// Three independently-testable layers, each pinned here without ever spawning a real agent:
//   (1) `buildJudgePrompt` — pure(-ish) prompt ASSEMBLY: every input (judge file, measure report, memory.md,
//       existing issues, the git-search instruction, the separation law) lands in the string; a declared-but-
//       missing judge file HALTS; a missing measure report degrades to a clear marker, never a throw.
//   (2) `postProcessJudgeDrafts` — the MECHANICAL post-processor, pure filesystem-state in/out: a draft is
//       identity-stamped into a full Issue; a sig collision merges (reopen on `resolved`, bump `lastSeen`
//       otherwise) instead of duplicating; the per-pass cap keeps the most-severe N and reports the rest;
//       a malformed draft fails CLOSED, naming the file.
//   (3) `runSubstrateJudge` — the full pipeline WIRING, with the agent spawn itself replaced by an injected
//       `runAgent` stub (never a live claude spawn — the M7 live demo proves agent behavior, not this suite).
//
// Run: npx vitest run packages/core/test/optimize-substrate-judge.test.ts

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildJudgePrompt,
  postProcessJudgeDrafts,
  runSubstrateJudge,
  DEFAULT_JUDGE_CAP,
} from '../src/optimize/substrate/judge.js';
import { computeIssueId, writeIssueFile, parseIssueFile, listIssues, type Issue } from '../src/optimize/substrate/issues.js';
import type { RunBaseAgentOpts, RunBaseAgentResult } from '../src/optimize/substrate/agent.js';

const tmpDirs: string[] = [];
const scratch = async (prefix = 'piflow-judge-'): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Write `<templateDir>/nodes/<node>/node.json` carrying just the `optimize` block judge.ts reads via fs. */
async function writeNodeJson(templateDir: string, node: string, optimize: Record<string, unknown>): Promise<void> {
  const dir = join(templateDir, 'nodes', node);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'node.json'), JSON.stringify({ label: node, optimize }, null, 2));
}

const issuesDir = (templateDir: string, node: string): string => join(templateDir, 'nodes', node, 'issues');

/** A minimal, valid full Issue — for pre-seeding an "already exists" ledger entry. */
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

/** Write a minimal DRAFT file (the agent-authored subset: title/severity/sig/status:open + body). */
function draftContent(fields: { title: string; severity: string; sig: string; status?: string }, body = 'body text here\n'): string {
  return [
    '---',
    `title: ${fields.title}`,
    `severity: ${fields.severity}`,
    `sig: ${fields.sig}`,
    `status: ${fields.status ?? 'open'}`,
    '---',
    body,
  ].join('\n');
}

// ── (1) buildJudgePrompt — assembly + HALT/tolerate rules ───────────────────────────────────────────────
describe('buildJudgePrompt — assembles every input; HALTs on a declared-but-missing judge file', () => {
  it('embeds the judge file, the measure report, memory.md, existing issues, the git instruction, and the separation law', async () => {
    const templateDir = await scratch();
    const runDir = await scratch();
    await writeNodeJson(templateDir, 'gameplay', { judge: 'nodes/gameplay/judge.md' });
    await fs.writeFile(join(templateDir, 'nodes', 'gameplay', 'judge.md'), 'JUDGE-INSTRUCTIONS-MARKER-42');
    await fs.writeFile(join(templateDir, 'nodes', 'gameplay', 'memory.md'), 'MEMORY-LESSON-MARKER-7');
    await fs.mkdir(join(runDir, 'optimize', 'substrate'), { recursive: true });
    await fs.writeFile(join(runDir, 'optimize', 'substrate', 'measure.gameplay.json'), '{"MEASURE-REPORT-MARKER":true}');
    await writeIssueFile(join(issuesDir(templateDir, 'gameplay'), 'soggy-crust.md'), makeIssue());

    const prompt = await buildJudgePrompt('gameplay', { runDir, workspace: templateDir, templateDir });

    expect(prompt).toContain('JUDGE-INSTRUCTIONS-MARKER-42');
    expect(prompt).toContain('MEMORY-LESSON-MARKER-7');
    expect(prompt).toContain('MEASURE-REPORT-MARKER');
    expect(prompt).toContain('soggy-crust'); // the existing issue's name
    expect(prompt).toContain('compose() thinks 9-13s before writing'); // its title
    expect(prompt).toMatch(/git log --grep/); // the git-history instruction (git only)
    expect(prompt).toMatch(/never `gh`|no gh|git only/i); // explicitly PROHIBITS gh — git only, per the plan
    expect(prompt.toLowerCase()).toMatch(/zero fix proposals|no fix proposals/); // the separation law
  });

  it('HALTS with a clear error when optimize.judge is not declared at all', async () => {
    const templateDir = await scratch();
    const runDir = await scratch();
    await writeNodeJson(templateDir, 'gameplay', {}); // no `judge` key
    await expect(buildJudgePrompt('gameplay', { runDir, workspace: templateDir, templateDir })).rejects.toThrow(
      /no "optimize\.judge" configured|has no optimize\.judge/i,
    );
  });

  it('HALTS with a clear error naming the resolved path when the declared judge FILE is missing', async () => {
    const templateDir = await scratch();
    const runDir = await scratch();
    await writeNodeJson(templateDir, 'gameplay', { judge: 'nodes/gameplay/does-not-exist.md' });
    const err = await buildJudgePrompt('gameplay', { runDir, workspace: templateDir, templateDir }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('does-not-exist.md');
  });

  it('tolerates a MISSING measure report with a clear marker (never throws)', async () => {
    const templateDir = await scratch();
    const runDir = await scratch(); // no optimize/substrate/measure.*.json written at all
    await writeNodeJson(templateDir, 'gameplay', { judge: 'nodes/gameplay/judge.md' });
    await fs.writeFile(join(templateDir, 'nodes', 'gameplay', 'judge.md'), 'j');

    const prompt = await buildJudgePrompt('gameplay', { runDir, workspace: templateDir, templateDir });
    expect(prompt).toMatch(/not available|no measure report|unavailable/i);
  });

  it('resolves a `{{WORKSPACE}}`-rooted judge path (token-resolved, not just a bare relative join)', async () => {
    const templateDir = await scratch();
    const runDir = await scratch();
    const workspace = await scratch();
    await fs.mkdir(join(workspace, 'skills'), { recursive: true });
    await fs.writeFile(join(workspace, 'skills', 'judge.md'), 'WORKSPACE-ROOTED-JUDGE-MARKER');
    await writeNodeJson(templateDir, 'gameplay', { judge: '{{WORKSPACE}}/skills/judge.md' });

    const prompt = await buildJudgePrompt('gameplay', { runDir, workspace, templateDir });
    expect(prompt).toContain('WORKSPACE-ROOTED-JUDGE-MARKER');
  });
});

// ── (2) postProcessJudgeDrafts — the mechanical, fail-closed post-processor ─────────────────────────────
describe('postProcessJudgeDrafts — draft → identity-stamped issue; dedup/reopen; cap; fail-closed', () => {
  it('stamps a brand-new draft into a full, valid Issue (id/name/dates tool-computed, draft file removed)', async () => {
    const templateDir = await scratch();
    const dir = issuesDir(templateDir, 'gameplay');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'draft-1.md'), draftContent({ title: 'thing is slow', severity: 'high', sig: 'gameplay::slow-thing' }));

    const { landed, capped } = await postProcessJudgeDrafts(templateDir, 'gameplay', '260706-01');
    expect(capped).toEqual([]);
    expect(landed).toHaveLength(1);

    const entries = await fs.readdir(dir);
    expect(entries).toEqual([`${landed[0]}.md`]); // the raw draft file is gone, replaced by the minted name
    const issue = await parseIssueFile(join(dir, `${landed[0]}.md`));
    expect(issue.id).toBe(computeIssueId('gameplay', 'gameplay::slow-thing'));
    expect(issue.title).toBe('thing is slow');
    expect(issue.severity).toBe('high');
    expect(issue.status).toBe('open');
    expect(issue.reason).toBeNull();
    expect(issue.firstSeen).toBe('260706-01');
    expect(issue.lastSeen).toBe('260706-01');
    expect(issue.attempts).toEqual([]);
  });

  it('a sig collision with an EXISTING RESOLVED issue REOPENS it (regressed) instead of minting a duplicate', async () => {
    const templateDir = await scratch();
    const dir = issuesDir(templateDir, 'gameplay');
    await fs.mkdir(dir, { recursive: true });
    const resolved = makeIssue({
      status: 'resolved', reason: 'fixed',
      attempts: [{ commit: 'c1', verifiedByRun: 'tS1.gameplay' }],
    });
    await writeIssueFile(join(dir, 'soggy-crust.md'), resolved);
    await fs.writeFile(join(dir, 'draft-again.md'), draftContent({
      title: 'compose() STILL thinks too long', severity: 'high', sig: resolved.sig,
    }));

    const { landed } = await postProcessJudgeDrafts(templateDir, 'gameplay', '260706-02');
    expect(landed).toEqual(['soggy-crust']); // merged into the SAME name — never a new file

    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['soggy-crust.md']); // no duplicate file was created

    const updated = await parseIssueFile(join(dir, 'soggy-crust.md'));
    expect(updated.status).toBe('regressed');
    expect(updated.reason).toBeNull();
    expect(updated.lastSeen).toBe('260706-02');
    expect(updated.attempts).toEqual([{ commit: 'c1', verifiedByRun: 'tS1.gameplay', regressedIn: '260706-02' }]);
  });

  it('a sig collision with an existing OPEN (not yet resolved) issue merges — bumps lastSeen, no duplicate, no status churn', async () => {
    const templateDir = await scratch();
    const dir = issuesDir(templateDir, 'gameplay');
    await fs.mkdir(dir, { recursive: true });
    const openSig = 'gameplay::tool-loop-genre-lookup';
    const open = makeIssue({ id: computeIssueId('gameplay', openSig), name: 'still-open', sig: openSig, status: 'open' });
    await writeIssueFile(join(dir, 'still-open.md'), open);
    await fs.writeFile(join(dir, 'draft-dup.md'), draftContent({ title: 'seen again', severity: 'medium', sig: open.sig }));

    const { landed } = await postProcessJudgeDrafts(templateDir, 'gameplay', '260706-02');
    expect(landed).toEqual(['still-open']);
    expect(await fs.readdir(dir)).toEqual(['still-open.md']);
    const updated = await parseIssueFile(join(dir, 'still-open.md'));
    expect(updated.status).toBe('open'); // unchanged — a plain re-seen, not a reopen
    expect(updated.lastSeen).toBe('260706-02');
    expect(updated.title).toBe(open.title); // the draft's differing title is NOT applied (mechanical merge only)
  });

  it('enforces the per-pass cap — the N most severe drafts land, the rest are reported as capped (untouched)', async () => {
    const templateDir = await scratch();
    const dir = issuesDir(templateDir, 'gameplay');
    await fs.mkdir(dir, { recursive: true });
    const severities = ['low', 'medium', 'high', 'critical', 'low', 'medium', 'high'];
    for (const [i, sev] of severities.entries()) {
      await fs.writeFile(join(dir, `draft-${i}.md`), draftContent({ title: `defect ${i}`, severity: sev, sig: `gameplay::defect-${i}` }));
    }
    const { landed, capped } = await postProcessJudgeDrafts(templateDir, 'gameplay', '260706-01', { cap: 5 });
    expect(landed).toHaveLength(5);
    expect(capped).toHaveLength(2);
    // the landed set is the 5 MOST SEVERE (critical, high, high, medium, medium) — never an arbitrary 5.
    const landedIssues = await Promise.all(landed.map((n) => parseIssueFile(join(dir, `${n}.md`))));
    const landedSeverities = landedIssues.map((i) => i.severity).sort();
    expect(landedSeverities).toEqual(['critical', 'high', 'high', 'medium', 'medium']);
    // the capped drafts are left ON DISK (a `.pending/` sibling — never the flat issues/ dir a fail-closed
    // `listIssues` scans), untouched and available for a future pass — never silently deleted.
    for (const f of capped) expect(await fs.readFile(join(dir, '.pending', f), 'utf8')).toMatch(/^---/);
    // the flat issues/ dir itself stays LISTABLE — no stray draft-shaped file survives in it.
    await expect(listIssues(templateDir, { node: 'gameplay' })).resolves.toHaveLength(5);
  });

  it('honors an explicit cap override (config-with-defaults, never hardcoded)', async () => {
    const templateDir = await scratch();
    const dir = issuesDir(templateDir, 'gameplay');
    await fs.mkdir(dir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(join(dir, `draft-${i}.md`), draftContent({ title: `defect ${i}`, severity: 'high', sig: `gameplay::defect-${i}` }));
    }
    const { landed, capped } = await postProcessJudgeDrafts(templateDir, 'gameplay', '260706-01', { cap: 1 });
    expect(landed).toHaveLength(1);
    expect(capped).toHaveLength(2);
  });

  it('DEFAULT_JUDGE_CAP is 5 (the plan\'s documented default) and is what a caller gets when `cap` is omitted', async () => {
    expect(DEFAULT_JUDGE_CAP).toBe(5);
    const templateDir = await scratch();
    const dir = issuesDir(templateDir, 'gameplay');
    await fs.mkdir(dir, { recursive: true });
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(join(dir, `draft-${i}.md`), draftContent({ title: `defect ${i}`, severity: 'high', sig: `gameplay::defect-${i}` }));
    }
    const { landed, capped } = await postProcessJudgeDrafts(templateDir, 'gameplay', '260706-01');
    expect(landed).toHaveLength(5);
    expect(capped).toHaveLength(1);
  });

  it('a MALFORMED draft (missing a required key) fails CLOSED, naming the file — nothing else in the pass is silently dropped', async () => {
    const templateDir = await scratch();
    const dir = issuesDir(templateDir, 'gameplay');
    await fs.mkdir(dir, { recursive: true });
    // valid draft has title/severity/sig/status — this one is missing `sig` entirely.
    await fs.writeFile(join(dir, 'broken-draft.md'), ['---', 'title: t', 'severity: high', 'status: open', '---', 'body'].join('\n'));
    await expect(postProcessJudgeDrafts(templateDir, 'gameplay', '260706-01')).rejects.toThrow(/broken-draft\.md/);
  });

  it('leaves an already-valid, untouched full issue file exactly as-is (no mechanical action needed)', async () => {
    const templateDir = await scratch();
    const dir = issuesDir(templateDir, 'gameplay');
    await fs.mkdir(dir, { recursive: true });
    const issue = makeIssue({ name: 'untouched-one' });
    const file = join(dir, 'untouched-one.md');
    await writeIssueFile(file, issue);
    const before = await fs.readFile(file, 'utf8');

    const { landed } = await postProcessJudgeDrafts(templateDir, 'gameplay', '260706-05');
    expect(landed).toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe(before); // byte-identical — nothing touched it
  });

  it('an empty/absent issues dir is a no-op (a fresh node has no ledger yet)', async () => {
    const templateDir = await scratch();
    const { landed, capped } = await postProcessJudgeDrafts(templateDir, 'gameplay', '260706-01');
    expect(landed).toEqual([]);
    expect(capped).toEqual([]);
  });
});

// ── (3) runSubstrateJudge — full pipeline wiring, agent spawn replaced by an injected stub ──────────────
describe('runSubstrateJudge — wires prompt→agent→post-process→marker, with the spawn itself stubbed', () => {
  it('runs the whole pass: builds the prompt, drives the (stubbed) agent, lands its draft, writes the triaged marker', async () => {
    const templateDir = await scratch();
    const runDir = await scratch();
    const workspace = templateDir;
    await writeNodeJson(templateDir, 'gameplay', { judge: 'nodes/gameplay/judge.md' });
    await fs.writeFile(join(templateDir, 'nodes', 'gameplay', 'judge.md'), 'judge the gameplay node');

    let capturedPrompt = '';
    const fakeRunAgent = async (agentOpts: { prompt: string; owns: string[] }): Promise<RunBaseAgentResult> => {
      capturedPrompt = agentOpts.prompt;
      // simulate the live agent's ONLY allowed side effect: writing a draft under its `owns` scope.
      const dir = agentOpts.owns[0];
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        join(dir, 'my-draft.md'),
        draftContent({ title: 'schema gate silently skipped', severity: 'critical', sig: 'gameplay::schema-gate-skipped' }),
      );
      return {
        status: { id: 'agent', label: 'agent', status: 'ok', artifacts: [], issues: [] } as unknown as RunBaseAgentResult['status'],
        text: 'filed 1 issue',
      };
    };

    const result = await runSubstrateJudge(runDir, 'gameplay', { workspace, templateDir, runAgent: fakeRunAgent });

    expect(capturedPrompt).toContain('judge the gameplay node');
    expect(result.issues).toHaveLength(1);
    const dir = issuesDir(templateDir, 'gameplay');
    expect(await fs.readdir(dir)).toEqual([`${result.issues[0]}.md`]);

    const markerPath = join(runDir, 'optimize', 'substrate', 'triaged.gameplay.json');
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    expect(marker.issues).toEqual(result.issues);
    expect(typeof marker.when).toBe('string');
  });

  it('spawns the agent with readScope=[runDir,templateDir,workspace] and owns=the node\'s issues/ dir', async () => {
    const templateDir = await scratch();
    const runDir = await scratch();
    const workspace = await scratch();
    await writeNodeJson(templateDir, 'gameplay', { judge: 'nodes/gameplay/judge.md' });
    await fs.writeFile(join(templateDir, 'nodes', 'gameplay', 'judge.md'), 'j');

    let seenReadScope: string[] = [];
    let seenOwns: string[] = [];
    const fakeRunAgent = async (agentOpts: { readScope: string[]; owns: string[] }): Promise<RunBaseAgentResult> => {
      seenReadScope = agentOpts.readScope;
      seenOwns = agentOpts.owns;
      return { status: { id: 'agent', label: 'agent', status: 'ok', artifacts: [], issues: [] } as unknown as RunBaseAgentResult['status'], text: '' };
    };
    await runSubstrateJudge(runDir, 'gameplay', { workspace, templateDir, runAgent: fakeRunAgent });

    expect(seenReadScope).toEqual(expect.arrayContaining([runDir, templateDir, workspace]));
    expect(seenOwns).toEqual([issuesDir(templateDir, 'gameplay')]);
  });
});

describe('runSubstrateJudge — a TRUE child of the base agent (the ONE shared inherited field surface)', () => {
  it('forwards timeoutMs to runAgent (a base field the judge\'s old hand-copied subset silently dropped)', async () => {
    const templateDir = await scratch();
    const runDir = await scratch();
    const workspace = templateDir;
    await writeNodeJson(templateDir, 'gameplay', { judge: 'nodes/gameplay/judge.md' });
    await fs.writeFile(join(templateDir, 'nodes', 'gameplay', 'judge.md'), 'j');

    let captured: RunBaseAgentOpts | undefined;
    const capturingRunAgent = async (o: RunBaseAgentOpts): Promise<RunBaseAgentResult> => {
      captured = o;
      return { status: { id: 'agent', label: 'agent', status: 'ok', artifacts: [], issues: [] } as unknown as RunBaseAgentResult['status'], text: '' };
    };
    await runSubstrateJudge(runDir, 'gameplay', { workspace, templateDir, timeoutMs: 45000, runAgent: capturingRunAgent });

    // RED before the shared surface: SubstrateJudgeOpts re-declared its own forward subset WITHOUT
    // timeoutMs, so a judge turn could never be wall-clock capped — the silent-loss bug class.
    expect(captured?.timeoutMs).toBe(45000);
  });
});

describe('runSubstrateJudge — stages the piflow-triage playbook for the judge spawn', () => {
  it('passes skill:"piflow-triage" to runAgent so the runner stages the DEFAULT triage playbook (Ring 1)', async () => {
    const templateDir = await scratch();
    const runDir = await scratch();
    const workspace = templateDir;
    await writeNodeJson(templateDir, 'gameplay', { judge: 'nodes/gameplay/judge.md' });
    await fs.writeFile(join(templateDir, 'nodes', 'gameplay', 'judge.md'), 'j');

    let capturedSkill: string | undefined = 'UNSET';
    const capturingRunAgent = async (o: RunBaseAgentOpts): Promise<RunBaseAgentResult> => {
      capturedSkill = o.skill; // undefined before the wiring → RED against 'piflow-triage'
      return { status: { id: 'agent', label: 'agent', status: 'ok', artifacts: [], issues: [] } as unknown as RunBaseAgentResult['status'], text: '' };
    };
    await runSubstrateJudge(runDir, 'gameplay', { workspace, templateDir, runAgent: capturingRunAgent });

    expect(capturedSkill).toBe('piflow-triage');
  });
});

describe('runSubstrateJudge — surfaces the judge agent\'s runDir (Phase-3 observe wiring)', () => {
  it('forwards the base agent\'s runDir onto SubstrateJudgeResult.agentRunDir, so the observe instruments can read the spawn like a node', async () => {
    const templateDir = await scratch();
    const runDir = await scratch();
    const workspace = templateDir;
    await writeNodeJson(templateDir, 'gameplay', { judge: 'nodes/gameplay/judge.md' });
    await fs.writeFile(join(templateDir, 'nodes', 'gameplay', 'judge.md'), 'j');

    const fakeRunAgent = async (): Promise<RunBaseAgentResult> => ({
      status: { id: 'agent', label: 'agent', status: 'ok', artifacts: [], issues: [] } as unknown as RunBaseAgentResult['status'],
      text: '',
      runDir: '/fake/observe/judge-dir',
    });
    const result = await runSubstrateJudge(runDir, 'gameplay', { workspace, templateDir, runAgent: fakeRunAgent });

    // RED before the wiring: runSubstrateJudge's final return surfaced only agentText/agentStatus — the base
    // agent's `runDir` (already returned by runBaseAgent whenever `outDir` is set) was silently dropped.
    expect(result.agentRunDir).toBe('/fake/observe/judge-dir');
  });

  it('is ABSENT when the agent result carries no runDir (the ephemeral default — nothing was persisted)', async () => {
    const templateDir = await scratch();
    const runDir = await scratch();
    const workspace = templateDir;
    await writeNodeJson(templateDir, 'gameplay', { judge: 'nodes/gameplay/judge.md' });
    await fs.writeFile(join(templateDir, 'nodes', 'gameplay', 'judge.md'), 'j');

    const fakeRunAgent = async (): Promise<RunBaseAgentResult> => ({
      status: { id: 'agent', label: 'agent', status: 'ok', artifacts: [], issues: [] } as unknown as RunBaseAgentResult['status'],
      text: '',
    });
    const result = await runSubstrateJudge(runDir, 'gameplay', { workspace, templateDir, runAgent: fakeRunAgent });

    expect(result.agentRunDir).toBeUndefined();
  });
});
