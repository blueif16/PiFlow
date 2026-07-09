// packages/cli/src/optimize-substrate.ts — the M5 substrate CLI (docs/specs/optimize-substrate-plan.md §M5).
// Dispatch routing (the M5.1 table), the arg parsers, and the triage/fix/full-loop/adopt orchestration — all
// driven through INJECTED seams so nothing live-spawns (measure/judge/fixIssue/adopt are all fakes; the M7 live
// demo proves real agents). Every test FAILS when the routing/selection logic is wrong.
//
// Run: npx vitest run packages/cli/test/optimize-substrate-cli.test.ts

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IssueRecord, Issue, MeasureReport, SubstrateJudgeResult, FixIssueResult, SubstrateEvent, VerifyStageResult, SubstrateManifestRecord } from '@piflow/core';
import {
  routeOptimize, firstPositional, parseSubstrateTriageArgs, parseSubstrateFixArgs, parseSubstrateAdoptArgs,
  parseSubstrateVerifyArgs, runSubstrateTriageCli, runSubstrateFixCli, runSubstrateAdoptCli, runSubstrateVerifyCli,
  resolveSubstrateSelector, runsHomeFor, DEFAULT_FIX_CAP, resolveNodeAndRun,
} from '../src/optimize-substrate.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'substrate-cli-'));
afterEach(() => { process.exitCode = 0; });

// ── seed helpers ────────────────────────────────────────────────────────────────────────────────────────────
async function seedRun(runsHome: string, id: string, o: { node: string; nodeStatus?: string; startedAt: string; triaged?: boolean; parent?: string; done?: boolean; ok?: boolean | null }): Promise<string> {
  const runDir = path.join(runsHome, id);
  await fs.mkdir(path.join(runDir, '.pi'), { recursive: true });
  await fs.writeFile(path.join(runDir, '.pi', 'run.json'), JSON.stringify({
    run: id, name: id, startedAt: o.startedAt, updatedAt: o.startedAt, done: o.done ?? true, ok: o.ok ?? true,
    durationMs: 1, stage: null, totals: null, ...(o.parent ? { parent: o.parent } : {}),
    nodes: { [o.node]: { id: o.node, label: o.node, status: o.nodeStatus ?? 'ok', artifacts: [], issues: [] } },
  }, null, 2));
  if (o.triaged) {
    await fs.mkdir(path.join(runDir, 'optimize', 'substrate'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'optimize', 'substrate', `triaged.${o.node}.json`), '{"when":"x","issues":[]}');
  }
  return runDir;
}

function issueRec(name: string, severity: Issue['severity'], status: Issue['status'], firstSeen: string): IssueRecord {
  const issue: Issue = { id: `sha256:${'0'.repeat(64)}`, name, title: `t-${name}`, severity, status, reason: status === 'resolved' ? 'fixed' : null, sig: `gameplay::${name}`, firstSeen, lastSeen: firstSeen, attempts: [], body: 'b\n' };
  return { node: 'gameplay', file: `/tpl/nodes/gameplay/issues/${name}.md`, issue };
}
const okReport = (): MeasureReport => ({ node: 'gameplay', graded: {} } as unknown as MeasureReport);
const judged = (issues: string[]): SubstrateJudgeResult => ({ when: 'now', issues, capped: [], agentText: '', agentStatus: {} as SubstrateJudgeResult['agentStatus'] });

/** Seed a per-issue record.json under a run's lifecycle dir (runs/<run>/optimize/issues/<node>/<issue>/). */
async function seedRecord(runDir: string, node: string, issue: string, over: Partial<SubstrateManifestRecord> = {}): Promise<void> {
  const dir = path.join(runDir, 'optimize', 'issues', node, issue);
  await fs.mkdir(dir, { recursive: true });
  const rec: SubstrateManifestRecord = {
    issue, issueId: `sha256:${'0'.repeat(64)}`, node, decision: 'discarded', candidateRef: `optimize/${node}/${issue}/attempt-1`,
    liveRoot: '/live', baseSha: 'base0', candidateSha: 'cand0', landPolicy: 'stage-for-human', reason: '',
    verifiedByRun: 'tS2.gameplay', deltaSummary: {}, ...over,
  };
  await fs.writeFile(path.join(dir, 'record.json'), JSON.stringify(rec, null, 2));
}

// ── DISPATCH ROUTING (M5.1 table) ─────────────────────────────────────────────────────────────────────────
describe('routeOptimize — the M5.1 dispatch table', () => {
  it.each<[string[], string]>([
    [['triage', '--node', 'g'], 'substrate-triage'],
    [['fix', '--node', 'g'], 'substrate-fix'],
    [['verify', '--node', 'g'], 'substrate-verify'],       // WS2: the new gate-only verb
    [['adopt', '--manifest', 'm.json'], 'substrate-adopt'],
    [['adopt', '--node', 'g'], 'substrate-adopt'],         // WS2: adopt by --node/--issue (scanRecords)
    [['verify'], 'classic'],                               // a rundir literally named `verify` WITHOUT --node
    [['--node', 'gameplay'], 'substrate-full'],           // bare --node, no positional → full loop
    [['--node', 'gameplay', '--run', 'tS2'], 'substrate-full'],
    [['somedir'], 'classic'],                             // optimize <rundir>
    [['--fix', 'somedir', '--node', 'x'], 'classic-fix'], // classic --fix keeps its --node substring filter
    [['--adopt', 'm.json'], 'classic-adopt'],
    [['--rounds', '3', '--binding', 'b.mjs'], 'classic-rounds'],
    [['fix'], 'classic'],                                 // a rundir literally named `fix` WITHOUT --node
    [['triage'], 'classic'],                              // a rundir literally named `triage` WITHOUT --node
    [['adopt'], 'classic'],                               // `adopt` positional WITHOUT --manifest → not substrate
    [['--json'], 'classic'],                              // read-only accessor, no node
  ])('%j → %s', (rest, expected) => {
    expect(routeOptimize(rest)).toBe(expected);
  });

  it('firstPositional skips value-flags and their values, returns a bare rundir', () => {
    expect(firstPositional(['--node', 'g', '--topk', '3'])).toBeUndefined();
    expect(firstPositional(['--json', 'run-42'])).toBe('run-42');
    expect(firstPositional(['run-42', '--node', 'g'])).toBe('run-42');
  });
});

// ── PARSERS ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('parsers', () => {
  it('parseSubstrateTriageArgs: node, run pin, topk default 1 + override, workspace/tier/model/cap', () => {
    expect(parseSubstrateTriageArgs(['--node', 'gameplay'])).toMatchObject({ node: 'gameplay', topk: 1 });
    expect(parseSubstrateTriageArgs(['--node', 'g', '--run', 'tS2'])).toMatchObject({ run: 'tS2' });
    expect(parseSubstrateTriageArgs(['--node', 'g', '--topk', '5', '--tier', 'deep'])).toMatchObject({ topk: 5, tier: 'deep' });
    expect(parseSubstrateTriageArgs(['--node', 'g', '--topk', '0']).topk).toBe(1); // clamped ≥1
  });
  it('parseSubstrateFixArgs: issue XOR status(default), watch/-json, cap default, --no-prove', () => {
    expect(parseSubstrateFixArgs(['--node', 'g'])).toMatchObject({ status: 'open,regressed', cap: DEFAULT_FIX_CAP, prove: true, watch: false });
    expect(parseSubstrateFixArgs(['--node', 'g', '--issue', 'soggy-crust'])).toMatchObject({ issue: 'soggy-crust' });
    expect(parseSubstrateFixArgs(['--node', 'g', '--watch-json'])).toMatchObject({ watch: true, watchJson: true });
    expect(parseSubstrateFixArgs(['--node', 'g', '--no-prove']).prove).toBe(false);
  });
  it('parseSubstrateFixArgs: --dry-run → dryRun (the inherited base-agent preview; off by default)', () => {
    expect(parseSubstrateFixArgs(['--node', 'g', '--dry-run']).dryRun).toBe(true);
    expect(parseSubstrateFixArgs(['--node', 'g']).dryRun).toBeUndefined();
  });
  it('parseSubstrateAdoptArgs: manifest + template + backup-dir + watch; also --node/--issue/--run (WS2 regrammar)', () => {
    expect(parseSubstrateAdoptArgs(['--manifest', 'm.json', '--template', 't', '--backup-dir', 'b'])).toMatchObject({ manifest: 'm.json', template: 't', backupDir: 'b' });
    expect(parseSubstrateAdoptArgs(['--node', 'g', '--issue', 'soggy-crust', '--run', 'tS2'])).toMatchObject({ node: 'g', issue: 'soggy-crust', run: 'tS2' });
  });
  it('parseSubstrateVerifyArgs: node, issue, run pin, tier/model (WS2 verify verb)', () => {
    expect(parseSubstrateVerifyArgs(['--node', 'g'])).toMatchObject({ node: 'g' });
    expect(parseSubstrateVerifyArgs(['--node', 'g', '--issue', 'soggy-crust', '--run', 'tS2', '--tier', 'deep'])).toMatchObject({ node: 'g', issue: 'soggy-crust', run: 'tS2', tier: 'deep' });
  });
  it('runsHomeFor: canonical template ↔ sibling runs home', () => {
    expect(runsHomeFor('/x/.piflow/wf/template')).toBe(path.join('/x/.piflow/wf', 'runs'));
  });
});

// ── resolveNodeAndRun — reconcile a DOTTED --node with an optional EXPLICIT --run ─────────────────────────────
describe('resolveNodeAndRun — a dotted --node pins a run exactly like --run; an EXPLICIT --run must agree', () => {
  it('no explicit --run: the dotted ref\'s own run becomes the effective pin', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    await fs.mkdir(path.join(runsHome, 'tS2'), { recursive: true });
    expect(resolveNodeAndRun('tS2.gameplay', undefined, runsHome)).toEqual({ node: 'gameplay', run: 'tS2' });
  });

  it('an EXPLICIT --run that AGREES with the dotted ref is allowed', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    await fs.mkdir(path.join(runsHome, 'tS2'), { recursive: true });
    expect(resolveNodeAndRun('tS2.gameplay', 'tS2', runsHome)).toEqual({ node: 'gameplay', run: 'tS2' });
  });

  it('an EXPLICIT --run that DISAGREES with the dotted ref errors clearly', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    await fs.mkdir(path.join(runsHome, 'tS2'), { recursive: true });
    await fs.mkdir(path.join(runsHome, 'other'), { recursive: true });
    expect(() => resolveNodeAndRun('tS2.gameplay', 'other', runsHome)).toThrowError(/tS2\.gameplay.*"tS2".*"other"|disagree/s);
  });

  it('a plain (dot-free) node is a no-op passthrough — the explicit --run (if any) is untouched', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    expect(resolveNodeAndRun('gameplay', 'tS2', runsHome)).toEqual({ node: 'gameplay', run: 'tS2' });
    expect(resolveNodeAndRun('gameplay', undefined, runsHome)).toEqual({ node: 'gameplay', run: undefined });
  });
});

// ── resolveSubstrateSelector — the ONE selector shared by fix/verify/adopt (WS2.3) ────────────────────────────
describe('resolveSubstrateSelector — uniform (node, run, scope) resolution with dotted-ref handling', () => {
  it('a plain node passes through; the injected scope is returned verbatim', () => {
    const sel = resolveSubstrateSelector({ node: 'gameplay', run: 'tS2' }, {
      resolveScope: () => ({ templateDir: '/tpl', runsHome: '/runs' }),
    });
    expect(sel).toEqual({ templateDir: '/tpl', runsHome: '/runs', node: 'gameplay', run: 'tS2' });
  });

  it('a DOTTED node pins the run (≡ --run), and a DISAGREEING explicit --run throws', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    await fs.mkdir(path.join(runsHome, 'tS2'), { recursive: true });
    await fs.mkdir(path.join(runsHome, 'other'), { recursive: true });
    const scope = { resolveScope: () => ({ templateDir: '/tpl', runsHome }) };
    expect(resolveSubstrateSelector({ node: 'tS2.gameplay' }, scope)).toMatchObject({ node: 'gameplay', run: 'tS2' });
    expect(() => resolveSubstrateSelector({ node: 'tS2.gameplay', run: 'other' }, scope)).toThrowError(/disagree/);
  });
});

// ── VERIFY (WS2.2) — gate an existing candidate record; NO fixer, NO re-prove ─────────────────────────────────
describe('runSubstrateVerifyCli — resolves the candidate record(s) and runs verifyStage', () => {
  const scope = (templateDir: string, runsHome: string) => ({ templateDir, runsHome });

  it('--node --issue: scans the record, calls verifyStage for that issue, prints the ACCEPT verdict', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    const parent = await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    await seedRecord(parent, 'gameplay', 'soggy-crust', { candidateSha: 'cand-1' });
    const targets: unknown[] = [];
    const lines: string[] = [];
    await runSubstrateVerifyCli(['--node', 'gameplay', '--issue', 'soggy-crust'], {
      resolveScope: () => scope(path.join(dir, 'template'), runsHome),
      verifyStage: async (target): Promise<VerifyStageResult> => {
        targets.push(target);
        return { decision: 'staged', gateVerdict: { decision: 'accept', rationale: 'the defect is absent now' }, record: {} as SubstrateManifestRecord, verdictPath: '/v/verdict.json' };
      },
      print: (s) => lines.push(s),
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ node: 'gameplay', issue: 'soggy-crust' });
    const out = lines.join('\n');
    expect(out).toMatch(/soggy-crust/);
    expect(out).toMatch(/staged|accept/i);
  });

  it('on a REJECT prints the drop-back category + steer', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    const parent = await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    await seedRecord(parent, 'gameplay', 'soggy-crust', { candidateSha: 'cand-1' });
    const lines: string[] = [];
    await runSubstrateVerifyCli(['--node', 'gameplay', '--issue', 'soggy-crust'], {
      resolveScope: () => scope(path.join(dir, 'template'), runsHome),
      verifyStage: async (): Promise<VerifyStageResult> => ({
        decision: 'discarded',
        gateVerdict: { decision: 'reject', rationale: 'band-aid', category: 'band-aid', steer: 'the root is upstream in the prompt' },
        dropback: { category: 'band-aid', steer: 'the root is upstream in the prompt' },
        record: {} as SubstrateManifestRecord,
      }),
      print: (s) => lines.push(s),
    });
    const out = lines.join('\n');
    expect(out).toMatch(/band-aid/);
    expect(out).toMatch(/the root is upstream in the prompt/);
  });

  it('omit --issue: verifies EVERY record carrying a candidateSha, skipping one that has none', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    const parent = await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    await seedRecord(parent, 'gameplay', 'soggy-crust', { candidateSha: 'cand-a' });
    await seedRecord(parent, 'gameplay', 'burnt-edge', { candidateSha: 'cand-b' });
    await seedRecord(parent, 'gameplay', 'no-candidate', { candidateSha: undefined }); // pre-WS0 / no-edit — NOT verifiable
    const verified: string[] = [];
    await runSubstrateVerifyCli(['--node', 'gameplay'], {
      resolveScope: () => scope(path.join(dir, 'template'), runsHome),
      verifyStage: async (target): Promise<VerifyStageResult> => {
        verified.push((target as { issue: string }).issue);
        return { decision: 'staged', gateVerdict: { decision: 'accept', rationale: 'ok' }, record: {} as SubstrateManifestRecord };
      },
      print: () => {},
    });
    expect(verified.sort()).toEqual(['burnt-edge', 'soggy-crust']); // the no-candidateSha record is skipped
  });

  it('no verifiable record → prints nothing-to-verify and never calls verifyStage', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    const parent = await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    await seedRecord(parent, 'gameplay', 'no-candidate', { candidateSha: undefined });
    let calls = 0;
    const lines: string[] = [];
    await runSubstrateVerifyCli(['--node', 'gameplay'], {
      resolveScope: () => scope(path.join(dir, 'template'), runsHome),
      verifyStage: async (): Promise<VerifyStageResult> => { calls++; return { decision: 'staged', gateVerdict: { decision: 'accept', rationale: 'x' }, record: {} as SubstrateManifestRecord }; },
      print: (s) => lines.push(s),
    });
    expect(calls).toBe(0);
    expect(lines.join('\n')).toMatch(/no .*candidate|nothing to verify/i);
  });

  it('missing --node exits 2', async () => {
    const errs: string[] = [];
    await runSubstrateVerifyCli([], { printErr: (s) => errs.push(s) });
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toMatch(/--node/);
  });
});

// ── ADOPT by --node/--issue via scanRecords (WS2.4) ───────────────────────────────────────────────────────────
describe('runSubstrateAdoptCli — adopt by --node/--issue resolves staged records via scanRecords', () => {
  const scope = (templateDir: string, runsHome: string) => ({ templateDir, runsHome });

  it('--node --issue: builds a manifest from the staged record and drives adoptManifest', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    const parent = await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    await seedRecord(parent, 'gameplay', 'soggy-crust', { decision: 'staged', candidateSha: 'cand-1' });
    let seenRecords: SubstrateManifestRecord[] = [];
    const lines: string[] = [];
    await runSubstrateAdoptCli(['--node', 'gameplay', '--issue', 'soggy-crust'], {
      resolveScope: () => scope(path.join(dir, 'template'), runsHome),
      adoptManifest: async (m) => { seenRecords = m.records; return { adopted: [{ issue: 'soggy-crust', node: 'gameplay', commit: 'abcdef1', files: ['x'] }], skipped: [] }; },
      print: (s) => lines.push(s),
    });
    expect(seenRecords).toHaveLength(1);
    expect(seenRecords[0]).toMatchObject({ issue: 'soggy-crust', decision: 'staged', candidateSha: 'cand-1' });
    expect(lines.join('\n')).toMatch(/1 issue\(s\) landed/);
  });

  it('--node with NO --issue adopts ALL staged records (a discarded record is not handed to adopt)', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    const parent = await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    await seedRecord(parent, 'gameplay', 'soggy-crust', { decision: 'staged', candidateSha: 'a' });
    await seedRecord(parent, 'gameplay', 'burnt-edge', { decision: 'staged', candidateSha: 'b' });
    await seedRecord(parent, 'gameplay', 'flat-note', { decision: 'discarded', candidateSha: 'c' });
    let seen: SubstrateManifestRecord[] = [];
    await runSubstrateAdoptCli(['--node', 'gameplay'], {
      resolveScope: () => scope(path.join(dir, 'template'), runsHome),
      adoptManifest: async (m) => { seen = m.records; return { adopted: [], skipped: [] }; },
      print: () => {},
    });
    expect(seen.map((r) => r.issue).sort()).toEqual(['burnt-edge', 'soggy-crust']); // discarded flat-note excluded
  });
});

// ── TRIAGE orchestration (measure THEN judge; selection) ──────────────────────────────────────────────────────
describe('runSubstrateTriageCli — measure feeds judge; --topk selects fresh, un-triaged, newest-first', () => {
  it('runs measure BEFORE judge for each selected run, newest-first, skipping reused + already-triaged runs', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    await seedRun(runsHome, '260706-03', { node: 'gameplay', startedAt: '2026-07-06T03:00:00Z' });                 // fresh, untriaged, newest
    await seedRun(runsHome, '260706-02', { node: 'gameplay', startedAt: '2026-07-06T02:00:00Z' });                 // fresh, untriaged, older
    await seedRun(runsHome, '260706-01', { node: 'gameplay', startedAt: '2026-07-06T01:00:00Z', triaged: true });  // already triaged → skip
    await seedRun(runsHome, '260706-00', { node: 'gameplay', nodeStatus: 'reused', startedAt: '2026-07-06T00:30:00Z' }); // reused → skip

    const calls: string[] = [];
    await runSubstrateTriageCli(['--node', 'gameplay', '--topk', '5'], {
      resolveScope: () => ({ templateDir, runsHome }),
      measure: async (runDir) => { calls.push(`measure:${path.basename(runDir)}`); return okReport(); },
      judge: async (runDir) => { calls.push(`judge:${path.basename(runDir)}`); return judged(['iss']); },
      print: () => {},
    });

    // exactly the two fresh, un-triaged runs — newest first — each measured THEN judged.
    expect(calls).toEqual(['measure:260706-03', 'judge:260706-03', 'measure:260706-02', 'judge:260706-02']);
  });

  it('--run pins ONE exact run, bypassing the triaged-marker skip (reproducible demo)', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    const pinned = await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    const calls: string[] = [];
    await runSubstrateTriageCli(['--node', 'gameplay', '--run', 'tS2'], {
      resolveScope: () => ({ templateDir, runsHome }),
      resolveRunDir: () => pinned,
      measure: async (rd) => { calls.push(`m:${path.basename(rd)}`); return okReport(); },
      judge: async (rd) => { calls.push(`j:${path.basename(rd)}`); return judged([]); },
      print: () => {},
    });
    expect(calls).toEqual(['m:tS2', 'j:tS2']); // triaged marker present, but --run forces it
  });

  it('a DOTTED --node tS2.gameplay selects exactly the pinned run tS2 (≡ --node gameplay --run tS2)', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    const pinned = await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    const calls: string[] = [];
    await runSubstrateTriageCli(['--node', 'tS2.gameplay'], {
      resolveScope: () => ({ templateDir, runsHome }),
      resolveRunDir: () => pinned,
      measure: async (rd) => { calls.push(`m:${path.basename(rd)}`); return okReport(); },
      judge: async (rd) => { calls.push(`j:${path.basename(rd)}`); return judged([]); },
      print: () => {},
    });
    expect(calls).toEqual(['m:tS2', 'j:tS2']); // dotted ref forces the exact pinned run, same as --run
  });

  it('a DOTTED --node combined with a DISAGREEING explicit --run exits 2', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z' });
    await seedRun(runsHome, 'other', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z' });
    const errs: string[] = [];
    await runSubstrateTriageCli(['--node', 'tS2.gameplay', '--run', 'other'], {
      resolveScope: () => ({ templateDir, runsHome }),
      printErr: (s) => errs.push(s),
    });
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toMatch(/disagree/);
  });

  it('missing --node exits 2', async () => {
    const errs: string[] = [];
    await runSubstrateTriageCli([], { printErr: (s) => errs.push(s) });
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toMatch(/--node/);
  });

  it('an UNRESOLVABLE template exits 2 cleanly (no thrown stack)', async () => {
    const errs: string[] = [];
    await expect(runSubstrateTriageCli(['--node', 'ghost'], {
      resolveScope: () => { throw new Error('could not resolve a template holding nodes/ghost/'); },
      printErr: (s) => errs.push(s),
    })).resolves.toBeUndefined();
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toMatch(/could not resolve a template/);
  });

  it('Phase-3 observe wiring: passes a PERSISTENT outDir=<runDir>/optimize/substrate/agents/judge.<node>/ to judge, and prints an observe hint naming it', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    const runDir = await seedRun(runsHome, '260706-03', { node: 'gameplay', startedAt: '2026-07-06T03:00:00Z' });
    let seenOutDir: string | undefined;
    const lines: string[] = [];
    await runSubstrateTriageCli(['--node', 'gameplay', '--topk', '1'], {
      resolveScope: () => ({ templateDir, runsHome }),
      measure: async () => okReport(),
      judge: async (_rd, _n, opts) => { seenOutDir = opts.outDir; return judged(['iss']); },
      print: (s) => lines.push(s),
    });
    const expected = path.join(runDir, 'optimize', 'substrate', 'agents', 'judge.gameplay');
    // RED before the wiring: judge ran with the base agent's ephemeral default (no `outDir`), so a triage
    // spawn's run dir was deleted before anything could observe it.
    expect(seenOutDir).toBe(expected);
    expect(lines.some((l) => l.includes('observe:') && l.includes(expected))).toBe(true);
  });

  it('Phase-3 observe wiring: a DRY RUN passes no observe hint (nothing was spawned, so nothing to observe)', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    await seedRun(runsHome, '260706-03', { node: 'gameplay', startedAt: '2026-07-06T03:00:00Z' });
    const lines: string[] = [];
    await runSubstrateTriageCli(['--node', 'gameplay', '--topk', '1', '--dry-run'], {
      resolveScope: () => ({ templateDir, runsHome }),
      measure: async () => okReport(),
      judge: async () => ({
        when: 'now', issues: [], capped: [],
        dryRun: { label: 'agent', executor: 'claude-code', prompt: 'p', tools: {}, io: { reads: [], produces: [], artifacts: [] } },
      }),
      print: (s) => lines.push(s),
    });
    expect(lines.some((l) => l.includes('observe:'))).toBe(false);
  });
});

// ── FIX orchestration (issue selection order + cap + watch + parent run) ─────────────────────────────────────
describe('runSubstrateFixCli — selects issues severity-desc, caps, fixes sequentially', () => {
  const scope = (templateDir: string, runsHome: string) => ({ templateDir, runsHome });

  it('fixes open|regressed issues in listIssues order under --cap, tallying staged/discarded', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    const parent = await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    const listed = [issueRec('crit', 'critical', 'open', '260706-01'), issueRec('hi', 'high', 'regressed', '260706-02'), issueRec('lo', 'low', 'open', '260706-03')];
    const fixedOrder: string[] = [];
    await runSubstrateFixCli(['--node', 'gameplay', '--cap', '2'], {
      resolveScope: () => scope(path.join(dir, 'template'), runsHome),
      listIssues: async () => listed, // already sorted severity-desc by the real listIssues; assert the cap keeps the first 2
      fixIssue: async (issuePath): Promise<FixIssueResult> => {
        fixedOrder.push(path.basename(issuePath, '.md'));
        return { issue: path.basename(issuePath, '.md'), node: 'gameplay', candidateRef: '', editsApplied: 1, proved: true, childId: 'c', verdict: {} as FixIssueResult['verdict'], decision: 'staged', deltaSummary: {}, manifestPath: '', record: {} as FixIssueResult['record'] };
      },
      print: () => {},
    });
    expect(fixedOrder).toEqual(['crit', 'hi']); // the low-severity third issue is left by --cap 2
    // the parent run resolved to the newest triaged run:
    expect(parent).toContain('tS2');
  });

  it('--issue selects exactly that one issue (ignores status filter)', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    const listed = [issueRec('a', 'high', 'open', '260706-01'), issueRec('b', 'high', 'resolved', '260706-02')];
    const fixed: string[] = [];
    await runSubstrateFixCli(['--node', 'gameplay', '--issue', 'b'], {
      resolveScope: () => scope(path.join(dir, 'template'), runsHome),
      listIssues: async () => listed,
      fixIssue: async (p): Promise<FixIssueResult> => { fixed.push(path.basename(p, '.md')); return { decision: 'staged' } as FixIssueResult; },
      print: () => {},
    });
    expect(fixed).toEqual(['b']); // even a resolved issue, because --issue names it explicitly
  });

  it('--watch streams a rendered line per SubstrateEvent; --watch-json emits raw JSON', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    const linesJson: string[] = [];
    await runSubstrateFixCli(['--node', 'gameplay', '--issue', 'a', '--watch-json'], {
      resolveScope: () => scope(path.join(dir, 'template'), runsHome),
      listIssues: async () => [issueRec('a', 'high', 'open', '260706-01')],
      fixIssue: async (_p, opts): Promise<FixIssueResult> => {
        opts.onEvent?.({ type: 'gated', issue: 'a', accept: false, reason: 'no improvement' } as SubstrateEvent);
        return { decision: 'discarded' } as FixIssueResult;
      },
      print: (s) => linesJson.push(s),
    });
    expect(linesJson.some((l) => l.startsWith('{') && l.includes('"type":"gated"'))).toBe(true);
  });

  it('--dry-run threads dryRun to fixIssue and prints the composition via the shared substrate printer (no tally, nothing mutated)', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    const lines: string[] = [];
    let seenDryRun: boolean | undefined;
    await runSubstrateFixCli(['--node', 'gameplay', '--issue', 'a', '--dry-run'], {
      resolveScope: () => scope(path.join(dir, 'template'), runsHome),
      listIssues: async () => [issueRec('a', 'high', 'open', '260706-01')],
      fixIssue: async (_p, opts): Promise<FixIssueResult> => {
        seenDryRun = opts.dryRun;
        return {
          issue: 'a', node: 'gameplay', candidateRef: '/cand/a', editsApplied: 0, proved: false, childId: null, deltaSummary: {},
          dryRun: {
            label: 'agent', prompt: 'THE-INGESTED-FIXER-PROMPT', executor: 'claude-code',
            skill: '/ws/.claude/skills/piflow-fixer', tier: 'balanced', tools: {},
            io: { reads: [], produces: [], artifacts: [] },
            sandbox: { provider: 'local', read: ['/cand/a'], write: ['/cand/a'], execCwd: '/cand/a' },
          },
        } as FixIssueResult;
      },
      print: (s) => lines.push(s),
    });
    // RED before: parseSubstrateFixArgs dropped --dry-run and the handler never forwarded/printed a preview.
    expect(seenDryRun).toBe(true);
    const out = lines.join('\n');
    expect(out).toMatch(/DRY RUN/);
    expect(out).toContain('/ws/.claude/skills/piflow-fixer'); // the resolved skill PATH
    expect(out).toContain('local'); // the declared sandbox provider
    expect(out).toContain('THE-INGESTED-FIXER-PROMPT'); // the full ingested composition
    expect(out).not.toMatch(/staged/); // a preview never prints the processed/staged/discarded tally
  });

  it('no triaged run → exit 2 (must triage first)', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    await seedRun(runsHome, 'x', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z' }); // no triaged marker
    const errs: string[] = [];
    await runSubstrateFixCli(['--node', 'gameplay'], {
      resolveScope: () => scope(path.join(dir, 'template'), runsHome),
      listIssues: async () => [],
      printErr: (s) => errs.push(s),
    });
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toMatch(/triage/);
  });

  it('Phase-3 observe wiring: passes a PERSISTENT outDir=<parentRunDir>/optimize/substrate/agents/fix.<node>.<issue>/ to fixIssue, and prints an observe hint naming it', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    const parent = await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    let seenOutDir: string | undefined;
    const lines: string[] = [];
    await runSubstrateFixCli(['--node', 'gameplay', '--issue', 'a'], {
      resolveScope: () => scope(path.join(dir, 'template'), runsHome),
      listIssues: async () => [issueRec('a', 'high', 'open', '260706-01')],
      fixIssue: async (_p, opts): Promise<FixIssueResult> => {
        seenOutDir = opts.outDir;
        return { decision: 'staged' } as FixIssueResult;
      },
      print: (s) => lines.push(s),
    });
    const expected = path.join(parent, 'optimize', 'substrate', 'agents', 'fix.gameplay.a');
    // RED before the wiring: fixIssue ran with the base agent's ephemeral default (no `outDir`), so a fixer
    // spawn's run dir was deleted before anything could observe it.
    expect(seenOutDir).toBe(expected);
    expect(lines.some((l) => l.includes('observe:') && l.includes(expected))).toBe(true);
  });

  it('Phase-3 observe wiring: a DRY RUN passes no observe hint (nothing was spawned, so nothing to observe)', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    const lines: string[] = [];
    await runSubstrateFixCli(['--node', 'gameplay', '--issue', 'a', '--dry-run'], {
      resolveScope: () => scope(path.join(dir, 'template'), runsHome),
      listIssues: async () => [issueRec('a', 'high', 'open', '260706-01')],
      fixIssue: async (): Promise<FixIssueResult> => ({
        issue: 'a', node: 'gameplay', candidateRef: '/cand/a', editsApplied: 0, proved: false, childId: null, deltaSummary: {},
        dryRun: { label: 'agent', executor: 'claude-code', prompt: 'p', tools: {}, io: { reads: [], produces: [], artifacts: [] } },
      } as FixIssueResult),
      print: (s) => lines.push(s),
    });
    expect(lines.some((l) => l.includes('observe:'))).toBe(false);
  });

  it('the outer loop RETRIES a soft-reject and the system-wide breaker HALTS after N consecutive exhausted issues', async () => {
    const dir = await tmp();
    const runsHome = path.join(dir, 'runs');
    await seedRun(runsHome, 'tS2', { node: 'gameplay', startedAt: '2026-07-06T00:00:00Z', triaged: true });
    const out: string[] = [];
    const errs: string[] = [];
    let calls = 0;
    await runSubstrateFixCli(['--node', 'gameplay', '--status', 'open', '--max-attempts', '2', '--breaker', '2'], {
      resolveScope: () => scope(path.join(dir, 'template'), runsHome),
      listIssues: async () => [
        issueRec('a', 'high', 'open', '260706-01'),
        issueRec('b', 'high', 'open', '260706-02'),
        issueRec('c', 'high', 'open', '260706-03'),
        issueRec('d', 'high', 'open', '260706-04'),
      ],
      // every attempt is a soft-gate REJECT carrying a drop-back ⇒ each issue exhausts its 2-attempt budget.
      fixIssue: async (_p, opts): Promise<FixIssueResult> => {
        calls++;
        return {
          issue: 'x', node: 'gameplay', candidateRef: `/c/${opts.attemptTag}`, editsApplied: 1, proved: true, childId: 'c',
          gateVerdict: { decision: 'reject', rationale: 'band-aid', category: 'band-aid' },
          dropback: { category: 'band-aid', steer: 's' }, decision: 'discarded', deltaSummary: {},
        } as FixIssueResult;
      },
      print: (s) => out.push(s),
      printErr: (s) => errs.push(s),
    });
    // 2 issues × 2 attempts = 4 fix calls, THEN the breaker halts before issues c/d (never reached).
    expect(calls).toBe(4);
    expect(errs.join('\n')).toMatch(/BREAKER tripped/i);
    expect(out.some((l) => l.includes('EXHAUSTED') && l.includes('escalating'))).toBe(true); // the closed menu printed
    const tally = out.find((l) => l.startsWith('optimize fix: node='))!;
    expect(tally).toMatch(/2 issue\(s\) processed/);
    expect(tally).toMatch(/2 escalated/);
    expect(tally).toMatch(/HALTED by --breaker/);
  });
});

// ── ADOPT (wraps adoptSubstrateManifest) ──────────────────────────────────────────────────────────────────────
describe('runSubstrateAdoptCli — reads the manifest and drives adoptSubstrateManifest', () => {
  it('lands staged records via the injected adopt and prints a summary', async () => {
    const dir = await tmp();
    const manifestPath = path.join(dir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify({ records: [{ issue: 'soggy-crust', issueId: 'sha256:x', node: 'gameplay', decision: 'staged', candidateRef: '/c', liveRoot: '/l', landPolicy: 'auto-adopt-eligible', reason: '', verifiedByRun: 'tS2.gameplay', deltaSummary: {} }] }));
    const lines: string[] = [];
    let seenTemplate = '';
    await runSubstrateAdoptCli(['--manifest', manifestPath, '--template', '/tpl'], {
      adoptManifest: async (_m, opts) => { seenTemplate = opts.templateDir; return { adopted: [{ issue: 'soggy-crust', node: 'gameplay', commit: 'abcdef1234', files: ['a.ts'] }], skipped: [] }; },
      print: (s) => lines.push(s),
    });
    expect(seenTemplate).toBe(path.resolve('/tpl'));
    expect(lines.join('\n')).toMatch(/1 issue\(s\) landed/);
    expect(lines.join('\n')).toMatch(/soggy-crust/);
  });

  it('missing --manifest exits 2', async () => {
    const errs: string[] = [];
    await runSubstrateAdoptCli([], { printErr: (s) => errs.push(s) });
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toMatch(/--manifest/);
  });

  it('a manifest with no records[] exits 2', async () => {
    const dir = await tmp();
    const bad = path.join(dir, 'bad.json');
    await fs.writeFile(bad, JSON.stringify({ nope: true }));
    const errs: string[] = [];
    await runSubstrateAdoptCli(['--manifest', bad, '--template', '/t'], { printErr: (s) => errs.push(s) });
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toMatch(/not a substrate manifest/);
  });
});
