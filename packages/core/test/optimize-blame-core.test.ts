// optimize/blame — WS-B2 core (docs/design/optimize-blame.md §2/§3/§4). Four independently-testable layers,
// each pinned WITHOUT ever spawning a real agent:
//   • composeRoster/renderRoster — the AUTO-COMPOSED responsibility roster: a pure fn off each node.json's OWN
//     declarations (id · phase · contract.artifacts → produces · contract.owns) + prompt.md's first line. The
//     no-manual-sync law (§2): EDIT one node.json and ONLY that entry changes; a malformed node.json is skipped.
//   • parseBlameSummaryTail/renderBlameSummaryTail — the run summary's fenced-tail codec (the ONLY machine-read
//     blame surface): round-trips, and FAILS CLOSED on a missing tail / bad severity / non-pair edge / empty node
//     (mirrors parseGateVerdict's strictness — a malformed tail must block, never silently degrade).
//   • buildBlamePrompt — pure prompt ASSEMBLY: the tagged sections in order, the discipline MUST-lines verbatim,
//     a HARD-THROW when the run-level criteria is absent (no soft bar, no blame pass), and a verify-mode swap.
//   • runBlameJudge — the full pass WIRING, the agent spawn itself replaced by an injected `runAgent` stub (never
//     a live claude spawn — the live demo proves agent behavior, not this suite).
//
// Run: npx vitest run packages/core/test/optimize-blame-core.test.ts --project default

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeRoster, renderRoster } from '../src/optimize/blame/roster.js';
import {
  parseBlameSummaryTail,
  renderBlameSummaryTail,
  type BlameSummary,
} from '../src/optimize/blame/summary.js';
import { buildBlamePrompt, runBlameJudge } from '../src/optimize/blame/judge.js';
import { blameFilePath, blameSummaryPath, blameDir } from '../src/optimize/blame/paths.js';
import { renderSubstrateEvent, type SubstrateEvent } from '../src/optimize/substrate/events.js';
import type { RunBaseAgentOpts, RunBaseAgentResult } from '../src/optimize/substrate/agent.js';

const tmpDirs: string[] = [];
const scratch = async (prefix = 'piflow-blame-'): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Write `<templateDir>/nodes/<id>/node.json` (+ optional prompt.md) — the roster's per-node source. */
async function writeNode(
  templateDir: string,
  id: string,
  node: Record<string, unknown>,
  prompt?: string,
): Promise<void> {
  const dir = join(templateDir, 'nodes', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'node.json'), JSON.stringify({ id, ...node }, null, 2));
  if (prompt !== undefined) await fs.writeFile(join(dir, 'prompt.md'), prompt);
}

/** Write `<templateDir>/meta.json` carrying the run-level `optimize.criteria` (+ its file). */
async function writeCriteria(templateDir: string, content = 'CRITERIA-MARKER-run-level-bar'): Promise<void> {
  await fs.mkdir(templateDir, { recursive: true });
  await fs.writeFile(
    join(templateDir, 'meta.json'),
    JSON.stringify({ id: 't', name: 't', optimize: { criteria: 'criteria.md' } }, null, 2),
  );
  await fs.writeFile(join(templateDir, 'criteria.md'), content);
}

// ── (1) composeRoster / renderRoster — the auto-composed responsibility roster ──────────────────────────
describe('composeRoster — pure fn off each node.json (id · phase · contract.artifacts/owns) + prompt.md', () => {
  it('reflects node.json + prompt.md into one entry per node', async () => {
    const templateDir = await scratch();
    await writeNode(
      templateDir,
      'greet',
      { phase: 'greeting', contract: { artifacts: ['out/greeting.txt'], owns: ['out/greeting.txt'], readScope: ['{{RUN}}'] } },
      'You produce a warm greeting for the user.\nMore detail follows here.',
    );
    await writeNode(
      templateDir,
      'verify',
      { phase: 'check', contract: { artifacts: ['out/report.json'], owns: ['out/report.json'], readScope: ['{{RUN}}'] } },
      'Verify the greeting meets the bar.',
    );

    const roster = await composeRoster(templateDir);
    expect(roster.map((e) => e.id).sort()).toEqual(['greet', 'verify']);
    const greet = roster.find((e) => e.id === 'greet')!;
    expect(greet.phase).toBe('greeting');
    expect(greet.produces).toEqual(['out/greeting.txt']); // from contract.artifacts (NOT a `produces` key)
    expect(greet.owns).toEqual(['out/greeting.txt']);
    expect(greet.responsibility).toBe('You produce a warm greeting for the user.'); // FIRST non-empty line only

    const md = renderRoster(roster);
    expect(md).toContain('greet');
    expect(md).toContain('out/greeting.txt');
    expect(md).toContain('You produce a warm greeting for the user.');
    expect(md).toContain('verify');
  });

  it('truncates the responsibility to 200 chars (best-effort brief, never the whole prompt)', async () => {
    const templateDir = await scratch();
    const longLine = 'x'.repeat(500);
    await writeNode(templateDir, 'n', { contract: { artifacts: [], owns: [], readScope: [] } }, longLine);
    const [entry] = await composeRoster(templateDir);
    expect(entry.responsibility).toHaveLength(200);
  });

  it('omits responsibility when prompt.md is absent (best-effort — never throws)', async () => {
    const templateDir = await scratch();
    await writeNode(templateDir, 'n', { contract: { artifacts: ['a'], owns: ['a'], readScope: [] } }); // no prompt.md
    const [entry] = await composeRoster(templateDir);
    expect(entry.responsibility).toBeUndefined();
    expect(entry.produces).toEqual(['a']);
  });

  it('EDITING one node.json changes ONLY that entry — the no-manual-sync law (§2)', async () => {
    const templateDir = await scratch();
    await writeNode(templateDir, 'a', { phase: 'p1', contract: { artifacts: ['a/out.txt'], owns: ['a/out.txt'], readScope: [] } }, 'A does a thing.');
    await writeNode(templateDir, 'b', { phase: 'p2', contract: { artifacts: ['b/out.txt'], owns: ['b/out.txt'], readScope: [] } }, 'B does another.');

    const before = await composeRoster(templateDir);
    const bBefore = before.find((e) => e.id === 'b')!;

    // edit ONLY node a's declared outputs — no touch to b, no hand-synced roster anywhere.
    await writeNode(templateDir, 'a', { phase: 'p1', contract: { artifacts: ['a/out.txt', 'a/extra.txt'], owns: ['a/out.txt'], readScope: [] } }, 'A does a thing.');

    const after = await composeRoster(templateDir);
    const aAfter = after.find((e) => e.id === 'a')!;
    const bAfter = after.find((e) => e.id === 'b')!;
    expect(aAfter.produces).toEqual(['a/out.txt', 'a/extra.txt']); // the edit surfaced
    expect(bAfter).toEqual(bBefore); // b is byte-for-byte the same entry — nothing else moved
  });

  it('SKIPS a node whose node.json is missing or unparseable — never throws', async () => {
    const templateDir = await scratch();
    await writeNode(templateDir, 'good', { contract: { artifacts: ['g'], owns: ['g'], readScope: [] } }, 'good node');
    // a node dir with a malformed node.json
    const badDir = join(templateDir, 'nodes', 'bad');
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(join(badDir, 'node.json'), '{ this is not json ');
    // a node dir with NO node.json at all
    await fs.mkdir(join(templateDir, 'nodes', 'empty'), { recursive: true });

    const roster = await composeRoster(templateDir);
    expect(roster.map((e) => e.id)).toEqual(['good']); // only the readable one
  });

  it('returns [] when there is no nodes/ dir (never throws)', async () => {
    const templateDir = await scratch();
    expect(await composeRoster(templateDir)).toEqual([]);
    expect(renderRoster([])).toMatch(/no nodes|no roster|\(/i); // a placeholder, not '' silently
  });
});

// ── (2) parseBlameSummaryTail / renderBlameSummaryTail — the ONE parsed surface, fail-closed ─────────────
describe('blame summary tail codec — round-trips, fails closed', () => {
  const good: BlameSummary = {
    blamed: [
      { node: 'plan', severity: 'high', observedAt: ['author'] },
      { node: 'author', severity: 'low', observedAt: [] },
    ],
    edges: [['plan', 'author']],
    unattributed: ['the tone drifts formal in the closing paragraph'],
  };

  it('parse(render(x)) deep-equals x (the round-trip law)', () => {
    const rendered = renderBlameSummaryTail(good);
    expect(rendered).toContain('```json');
    expect(parseBlameSummaryTail(rendered)).toEqual(good);
  });

  it('extracts the LAST fenced json block from a prose summary that has other fences', () => {
    const md = [
      '# blame summary',
      'Some prose. Here is an illustrative block:',
      '```json',
      '{ "not": "the tail" }',
      '```',
      'and the real machine-read tail:',
      renderBlameSummaryTail(good),
    ].join('\n\n');
    expect(parseBlameSummaryTail(md)).toEqual(good);
  });

  it('throws (named) when there is NO fenced json tail at all', () => {
    expect(() => parseBlameSummaryTail('# blame\n\njust prose, no fenced json')).toThrow(/fenced.*json|no.*tail/i);
  });

  it('throws when the tail is not valid JSON', () => {
    expect(() => parseBlameSummaryTail('```json\n{ not: valid }\n```')).toThrow(/valid JSON|JSON/i);
  });

  it('throws on a bad severity', () => {
    const md = '```json\n' + JSON.stringify({ blamed: [{ node: 'a', severity: 'blocker', observedAt: [] }], edges: [], unattributed: [] }) + '\n```';
    expect(() => parseBlameSummaryTail(md)).toThrow(/severity/i);
  });

  it('throws on a non-pair edge', () => {
    const md = '```json\n' + JSON.stringify({ blamed: [], edges: [['a', 'b', 'c']], unattributed: [] }) + '\n```';
    expect(() => parseBlameSummaryTail(md)).toThrow(/edge/i);
  });

  it('throws on an empty node in blamed', () => {
    const md = '```json\n' + JSON.stringify({ blamed: [{ node: '', severity: 'high', observedAt: [] }], edges: [], unattributed: [] }) + '\n```';
    expect(() => parseBlameSummaryTail(md)).toThrow(/node/i);
  });

  it('throws when observedAt is not an array of strings', () => {
    const md = '```json\n' + JSON.stringify({ blamed: [{ node: 'a', severity: 'high', observedAt: [7] }], edges: [], unattributed: [] }) + '\n```';
    expect(() => parseBlameSummaryTail(md)).toThrow(/observedAt/i);
  });

  it('throws when unattributed is not an array of strings', () => {
    const md = '```json\n' + JSON.stringify({ blamed: [], edges: [], unattributed: [{ x: 1 }] }) + '\n```';
    expect(() => parseBlameSummaryTail(md)).toThrow(/unattributed/i);
  });
});

// ── (3) buildBlamePrompt — assembly, discipline, criteria HALT, verify swap ──────────────────────────────
describe('buildBlamePrompt — tagged sections in order + discipline MUST-lines + criteria HALT', () => {
  async function fixture(): Promise<{ runDir: string; workspace: string; templateDir: string }> {
    const templateDir = await scratch();
    const runDir = await scratch();
    await writeCriteria(templateDir);
    await writeNode(templateDir, 'plan', { phase: 'plan', contract: { artifacts: ['plan.md'], owns: ['plan.md'], readScope: [] } }, 'Plan the work.');
    // a per-node measure report + the run-level measure report, so the evidence index has real listings.
    await fs.mkdir(join(runDir, 'optimize', 'substrate'), { recursive: true });
    await fs.writeFile(join(runDir, 'optimize', 'substrate', 'measure.plan.json'), '{"node":"plan"}');
    await fs.mkdir(join(runDir, 'optimize', 'blame'), { recursive: true });
    await fs.writeFile(join(runDir, 'optimize', 'blame', 'measure.json'), '{"RUN-MEASURE-MARKER":true,"digest":{"rootCauses":[]}}');
    await fs.writeFile(join(templateDir, 'memory.md'), 'MEMORY-RECURRENCE-MARKER');
    return { runDir, workspace: templateDir, templateDir };
  }

  it('assembles the tagged sections in the documented order and embeds every input', async () => {
    const { runDir, workspace, templateDir } = await fixture();
    const p = await buildBlamePrompt({ runDir, workspace, templateDir, mode: 'judge' });

    const order = ['<role>', '<separation_law>', '<criteria', '<responsibility_roster>', '<evidence_index>', '<memory', '<judge_discipline>', '<output_spec>', '<self_check>'];
    let last = -1;
    for (const tag of order) {
      const at = p.indexOf(tag);
      expect(at, `section ${tag} present`).toBeGreaterThan(-1);
      expect(at, `section ${tag} after the previous one`).toBeGreaterThan(last);
      last = at;
    }
    expect(p).toContain('CRITERIA-MARKER-run-level-bar'); // the run-level bar embedded verbatim
    expect(p).toContain('plan'); // the roster carries the node
    expect(p).toContain('RUN-MEASURE-MARKER'); // the run-level measure report as OPAQUE text
    expect(p).toContain('measure.plan.json'); // the per-node measure LISTING
    expect(p).toMatch(/rootCauses/); // the failure-onset walk section
    expect(p).toContain('MEMORY-RECURRENCE-MARKER'); // template-root memory recurrence context
  });

  it('pins the judge-discipline MUST-lines verbatim (manifestation trap · decision point · unattributed)', async () => {
    const { runDir, workspace, templateDir } = await fixture();
    const p = await buildBlamePrompt({ runDir, workspace, templateDir, mode: 'judge' });
    expect(p).toMatch(/manifestation trap/i);
    expect(p).toMatch(/decision point over the execution point/i);
    expect(p.toLowerCase()).toMatch(/cites openable evidence/);
    expect(p.toLowerCase()).toMatch(/unattributed/);
    // the Goodhart fence — blame carries evidence, never the criteria content
    expect(p.toLowerCase()).toMatch(/never.*(the )?(template )?criteria|criteria.*judge-facing/);
  });

  it('the output spec pins the per-node prose file + the ONE fenced-json summary tail shape', async () => {
    const { runDir, workspace, templateDir } = await fixture();
    const p = await buildBlamePrompt({ runDir, workspace, templateDir, mode: 'judge' });
    expect(p).toContain('optimize/blame/<node>.md');
    expect(p).toContain('optimize/blame/blame.md');
    expect(p).toContain('blamed');
    expect(p).toContain('observedAt');
    expect(p).toContain('unattributed');
  });

  it('HARD-THROWS when the run-level criteria is absent (no soft bar, no blame pass)', async () => {
    const templateDir = await scratch();
    const runDir = await scratch();
    await fs.writeFile(join(templateDir, 'meta.json'), JSON.stringify({ id: 't', name: 't' })); // no optimize.criteria
    await expect(buildBlamePrompt({ runDir, workspace: templateDir, templateDir, mode: 'judge' })).rejects.toThrow(/optimize\.criteria|soft bar|criteria/i);
  });

  it('HARD-THROWS naming the resolved path when the declared criteria FILE is missing', async () => {
    const templateDir = await scratch();
    const runDir = await scratch();
    await fs.writeFile(join(templateDir, 'meta.json'), JSON.stringify({ id: 't', name: 't', optimize: { criteria: 'does-not-exist.md' } }));
    const err = await buildBlamePrompt({ runDir, workspace: templateDir, templateDir, mode: 'judge' }).catch((e) => e as Error);
    expect((err as Error).message).toContain('does-not-exist.md');
  });

  it('verify mode swaps role+task for the re-check round (differs from judge mode)', async () => {
    const { runDir, workspace, templateDir } = await fixture();
    const judge = await buildBlamePrompt({ runDir, workspace, templateDir, mode: 'judge' });
    const verify = await buildBlamePrompt({ runDir, workspace, templateDir, mode: 'verify' });
    expect(verify).not.toBe(judge);
    expect(verify).toMatch(/verify|re-check|in place/i);
    // both still carry the same shared references (criteria + discipline) — only role/task swap
    expect(verify).toContain('CRITERIA-MARKER-run-level-bar');
    expect(verify).toMatch(/manifestation trap/i);
  });
});

// ── (4) runBlameJudge — full wiring, agent spawn stubbed ─────────────────────────────────────────────────
describe('runBlameJudge — wires prompt→judge→verify→parse, with the spawn stubbed', () => {
  async function fixture(): Promise<{ runDir: string; workspace: string; templateDir: string }> {
    const templateDir = await scratch();
    const runDir = await scratch();
    await writeCriteria(templateDir);
    await writeNode(templateDir, 'plan', { phase: 'plan', contract: { artifacts: ['plan.md'], owns: ['plan.md'], readScope: [] } }, 'Plan the work.');
    return { runDir, workspace: templateDir, templateDir };
  }

  const goodSummary: BlameSummary = {
    blamed: [{ node: 'plan', severity: 'high', observedAt: ['author'] }],
    edges: [['plan', 'author']],
    unattributed: [],
  };

  /** A fake agent that writes the fixture blame files + summary into its `owns` (the blame dir). */
  function writingAgent(counter: { calls: number }): (o: RunBaseAgentOpts) => Promise<RunBaseAgentResult> {
    return async (o) => {
      counter.calls++;
      const dir = o.owns[0];
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'plan.md'), '# blame — plan @ run\n\nplan owns the defect.\n');
      await fs.writeFile(
        join(dir, 'blame.md'),
        '# blame summary\n\nplan owns it.\n\n' + renderBlameSummaryTail(goodSummary),
      );
      return { status: { id: 'agent', label: 'agent', status: 'ok', artifacts: [], issues: [] } as unknown as RunBaseAgentResult['status'], text: `agent call ${counter.calls}` };
    };
  }

  it('runs judge + verify (TWO spawns), parses the tail, lists the per-node blame files', async () => {
    const { runDir, workspace, templateDir } = await fixture();
    const counter = { calls: 0 };
    const result = await runBlameJudge(runDir, { workspace, templateDir, runAgent: writingAgent(counter) });

    expect(counter.calls).toBe(2); // judge round + one verify round
    expect(result.summary).toEqual(goodSummary);
    expect(result.files.some((f) => f === blameFilePath(runDir, 'plan') || f.endsWith('plan.md'))).toBe(true);
    // blame.md (the summary) is NOT counted among the per-node prose files
    expect(result.files.some((f) => f.endsWith('blame.md'))).toBe(false);
    expect(result.judgeText).toBeDefined();
    expect(result.verifyText).toBeDefined();
  });

  it('verifyRound:false spawns the judge ONCE (no verify)', async () => {
    const { runDir, workspace, templateDir } = await fixture();
    const counter = { calls: 0 };
    const result = await runBlameJudge(runDir, { workspace, templateDir, verifyRound: false, runAgent: writingAgent(counter) });
    expect(counter.calls).toBe(1);
    expect(result.summary).toEqual(goodSummary);
    expect(result.verifyText).toBeUndefined();
  });

  it('spawns with cwd=workspace, readScope=[runDir,templateDir,workspace], owns=[blameDir]', async () => {
    const { runDir, workspace, templateDir } = await fixture();
    let seen: RunBaseAgentOpts | undefined;
    const agent = async (o: RunBaseAgentOpts): Promise<RunBaseAgentResult> => {
      seen = o;
      const dir = o.owns[0];
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'blame.md'), renderBlameSummaryTail(goodSummary));
      await fs.writeFile(join(dir, 'plan.md'), 'x');
      return { status: { id: 'agent', label: 'agent', status: 'ok', artifacts: [], issues: [] } as unknown as RunBaseAgentResult['status'], text: '' };
    };
    await runBlameJudge(runDir, { workspace, templateDir, verifyRound: false, runAgent: agent });
    expect(seen?.cwd).toBe(workspace);
    expect(seen?.readScope).toEqual(expect.arrayContaining([runDir, templateDir, workspace]));
    expect(seen?.owns).toEqual([blameDir(runDir)]);
  });

  // GAP2: the run-level twin of the fixer/judge/gate state hole (d3ae3ce) — buildBlamePrompt embeds the
  // run-level criteria + per-node measure reports + template-root memory.md VERBATIM, any of which may
  // legitimately quote a `{{state.<channel>}}` token the run being blamed actually promoted. The blame spawn is
  // the SAME ephemeral agent.ts turn (no state of its own), so runBlameJudge must hydrate it from THIS pinned
  // run's `.pi/state.json`, exactly like runSubstrateJudge/runSubstrateGate.
  it('hydrates the judge spawn\'s `state` from runDir/.pi/state.json (GAP2)', async () => {
    const { runDir, workspace, templateDir } = await fixture();
    await fs.mkdir(join(runDir, '.pi'), { recursive: true });
    await fs.writeFile(join(runDir, '.pi', 'state.json'), JSON.stringify({ slug: 'grade1-vol1-section-3' }));

    let seen: RunBaseAgentOpts | undefined;
    const agent = async (o: RunBaseAgentOpts): Promise<RunBaseAgentResult> => {
      seen = o;
      const dir = o.owns[0];
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'blame.md'), renderBlameSummaryTail(goodSummary));
      await fs.writeFile(join(dir, 'plan.md'), 'x');
      return { status: { id: 'agent', label: 'agent', status: 'ok', artifacts: [], issues: [] } as unknown as RunBaseAgentResult['status'], text: '' };
    };
    await runBlameJudge(runDir, { workspace, templateDir, verifyRound: false, runAgent: agent });
    expect(seen?.state).toEqual({ slug: 'grade1-vol1-section-3' });
  });

  it('a run with NO .pi/state.json forwards `state: {}` (never throws building the blame spawn) (GAP2)', async () => {
    const { runDir, workspace, templateDir } = await fixture(); // no .pi/state.json written
    let seen: RunBaseAgentOpts | undefined;
    const agent = async (o: RunBaseAgentOpts): Promise<RunBaseAgentResult> => {
      seen = o;
      const dir = o.owns[0];
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'blame.md'), renderBlameSummaryTail(goodSummary));
      await fs.writeFile(join(dir, 'plan.md'), 'x');
      return { status: { id: 'agent', label: 'agent', status: 'ok', artifacts: [], issues: [] } as unknown as RunBaseAgentResult['status'], text: '' };
    };
    await runBlameJudge(runDir, { workspace, templateDir, verifyRound: false, runAgent: agent });
    expect(seen?.state).toEqual({});
  });

  it('HARD-THROWS when the judge wrote no summary (a blame pass that emits no tail is a failed pass)', async () => {
    const { runDir, workspace, templateDir } = await fixture();
    const silentAgent = async (o: RunBaseAgentOpts): Promise<RunBaseAgentResult> => {
      await fs.mkdir(o.owns[0], { recursive: true }); // writes NO blame.md
      return { status: { id: 'agent', label: 'agent', status: 'ok', artifacts: [], issues: [] } as unknown as RunBaseAgentResult['status'], text: '' };
    };
    await expect(runBlameJudge(runDir, { workspace, templateDir, verifyRound: false, runAgent: silentAgent })).rejects.toThrow(/no.*(summary|blame\.md|tail)/i);
  });

  it('dryRun returns the plan without spawning the verify round', async () => {
    const { runDir, workspace, templateDir } = await fixture();
    const counter = { calls: 0 };
    const planAgent = async (_o: RunBaseAgentOpts): Promise<RunBaseAgentResult> => {
      counter.calls++;
      return { plan: { label: 'agent', prompt: 'PLANNED', executor: 'claude-code' } as unknown as RunBaseAgentResult['plan'] };
    };
    const result = await runBlameJudge(runDir, { workspace, templateDir, dryRun: true, runAgent: planAgent });
    expect(counter.calls).toBe(1); // judge preview only — verify NOT spawned
    expect(result.dryRun).toBeDefined();
    // no summary was written under a dry-run — the blame dir stays empty of a tail
    await expect(fs.readFile(blameSummaryPath(runDir), 'utf8')).rejects.toThrow();
  });

  it('emits blame-judged/blame-verified through onEvent (a projection, never load-bearing)', async () => {
    const { runDir, workspace, templateDir } = await fixture();
    const counter = { calls: 0 };
    const events: SubstrateEvent[] = [];
    await runBlameJudge(runDir, { workspace, templateDir, runAgent: writingAgent(counter), onEvent: (e) => events.push(e) });
    const types = events.map((e) => e.type);
    expect(types).toContain('blame-judged');
    expect(types).toContain('blame-verified');
  });

  it('ORACLE FENCE: restores a judge-tampered measure.json + removes a judge-fabricated dissent, keeps a genuine one', async () => {
    const { runDir, workspace, templateDir } = await fixture();
    const dir = blameDir(runDir);
    await fs.mkdir(dir, { recursive: true });
    // the mechanical, code-authored ground truth folded by the CLI's blameMeasure BEFORE the judge spawns.
    await fs.writeFile(join(dir, 'measure.json'), '{"MECHANICAL":true}');
    // a GENUINE prior-pass triage dissent trace (TRIAGE-owned, §4.1) — must survive the judge/verify spawns.
    await fs.writeFile(join(dir, 'dissent.author.md'), '# dissent — author @ prior\n\ngenuine node-local contest.\n');

    // a rogue agent that (a) overwrites the mechanical measure.json and (b) FABRICATES a dissent for a node it blamed.
    const rogueAgent = async (o: RunBaseAgentOpts): Promise<RunBaseAgentResult> => {
      const owns = o.owns[0];
      await fs.mkdir(owns, { recursive: true });
      await fs.writeFile(join(owns, 'blame.md'), '# blame summary\n\nplan owns it.\n\n' + renderBlameSummaryTail(goodSummary));
      await fs.writeFile(join(owns, 'plan.md'), '# blame — plan @ run\n\nplan owns the defect.\n');
      await fs.writeFile(join(owns, 'measure.json'), '{"MODEL_AUTHORED":true}'); // tamper the ground truth
      await fs.writeFile(join(owns, 'dissent.plan.md'), '# a self-exculpating dissent the JUDGE wrote\n'); // fabricate a contest
      return { status: { id: 'agent', label: 'agent', status: 'ok', artifacts: [], issues: [] } as unknown as RunBaseAgentResult['status'], text: '' };
    };

    await runBlameJudge(runDir, { workspace, templateDir, runAgent: rogueAgent });

    // measure.json is RESTORED — the model can never make the mechanical report model-authored.
    expect(await fs.readFile(join(dir, 'measure.json'), 'utf8')).toBe('{"MECHANICAL":true}');
    // the judge-fabricated dissent is GONE — dissent is triage-owned, never judge-authored.
    await expect(fs.access(join(dir, 'dissent.plan.md'))).rejects.toThrow();
    // the genuine prior triage dissent SURVIVES untouched.
    expect(await fs.readFile(join(dir, 'dissent.author.md'), 'utf8')).toMatch(/genuine node-local contest/);
  });

  it('ORACLE FENCE: removes a measure.json the judge CREATES when none existed before (never model-authored)', async () => {
    const { runDir, workspace, templateDir } = await fixture();
    const dir = blameDir(runDir);
    const creatingAgent = async (o: RunBaseAgentOpts): Promise<RunBaseAgentResult> => {
      const owns = o.owns[0];
      await fs.mkdir(owns, { recursive: true });
      await fs.writeFile(join(owns, 'blame.md'), renderBlameSummaryTail(goodSummary));
      await fs.writeFile(join(owns, 'plan.md'), 'x');
      await fs.writeFile(join(owns, 'measure.json'), '{"MODEL_AUTHORED":true}'); // no mechanical fold ran → forbidden
      return { status: { id: 'agent', label: 'agent', status: 'ok', artifacts: [], issues: [] } as unknown as RunBaseAgentResult['status'], text: '' };
    };
    await runBlameJudge(runDir, { workspace, templateDir, verifyRound: false, runAgent: creatingAgent });
    await expect(fs.access(join(dir, 'measure.json'))).rejects.toThrow(); // deleted — never a model-authored ground truth
  });
});

// ── (5) the three new SubstrateEvent members render ──────────────────────────────────────────────────────
describe('renderSubstrateEvent — the run-level blame variants', () => {
  it('renders a non-empty line per blame variant, carrying its count', () => {
    expect(renderSubstrateEvent({ type: 'blame-measured' })).toMatch(/blame-measured/);
    expect(renderSubstrateEvent({ type: 'blame-judged', blamed: 3 })).toContain('3');
    expect(renderSubstrateEvent({ type: 'blame-verified', blamed: 2 })).toContain('2');
    expect(renderSubstrateEvent({ type: 'blame-judged', blamed: 3 })).toMatch(/blame-judged/);
  });
});
