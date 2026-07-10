// packages/cli/src/optimize-substrate.ts — the WS-B3 `optimize blame` CLI verb (docs/design/optimize-blame.md
// §4/§10). Dispatch routing, arg parsing, and the run-level attribution orchestration (measure missing nodes →
// run-level hard fold → judge+verify → memorize) — all driven through INJECTED seams so nothing live-spawns.
// Mirrors packages/cli/test/optimize-substrate-cli.test.ts's conventions.
//
// Run: npx vitest run packages/cli/test/optimize-blame-cli.test.ts

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MeasureReport, BlameMeasureReport, RunBlameJudgeResult, BlameSummary } from '@piflow/core';
import {
  routeOptimize, parseSubstrateBlameArgs, runSubstrateBlameCli, blameAgentOutDir,
} from '../src/optimize-substrate.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'blame-cli-'));
afterEach(() => { process.exitCode = 0; });

const okMeasure = (): MeasureReport => ({ node: 'x', graded: {} } as unknown as MeasureReport);
const okBlameMeasure = (): BlameMeasureReport => ({ generatedAt: 'x', ops: { checks: [], runs: [], rejected: [] }, graded: {}, digest: { nodes: [], rootCauses: [] } });
const emptySummary: BlameSummary = { blamed: [], edges: [], unattributed: [] };
function judged(summary: BlameSummary, files: string[] = []): RunBlameJudgeResult {
  return { summary, files, judgeText: '' };
}

/** Seed a canonical run dir under a runs home with a minimal `.pi/run.json`. */
async function seedRun(runsHome: string, id: string, startedAt: string): Promise<string> {
  const runDir = path.join(runsHome, id);
  await fs.mkdir(path.join(runDir, '.pi'), { recursive: true });
  await fs.writeFile(path.join(runDir, '.pi', 'run.json'), JSON.stringify({
    run: id, name: id, startedAt, updatedAt: startedAt, done: true, ok: true, durationMs: 1, stage: null, totals: null,
    nodes: {},
  }, null, 2));
  return runDir;
}

/** Seed `<templateDir>/nodes/<id>/node.json` (empty is enough — discoverNodeIds only needs the dir to exist). */
async function seedNode(templateDir: string, id: string): Promise<void> {
  const dir = path.join(templateDir, 'nodes', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'node.json'), '{}');
}

// ── DISPATCH ROUTING ───────────────────────────────────────────────────────────────────────────────────────
describe('routeOptimize — the blame subverb (WS-B3)', () => {
  it.each<[string[], string]>([
    [['blame', '--latest'], 'substrate-blame'],
    [['blame', 'some-run-dir'], 'substrate-blame'],
    [['blame'], 'classic'],                                // a workflow literally named "blame", no subverb signal
  ])('%j → %s', (rest, expected) => {
    expect(routeOptimize(rest)).toBe(expected);
  });
});

// ── PARSER ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('parseSubstrateBlameArgs', () => {
  it('positional run + defaults', () => {
    expect(parseSubstrateBlameArgs(['myrun'])).toMatchObject({ run: 'myrun', latest: false, verifyRound: true, memorize: true, watch: false });
  });
  it('--latest, --template/--workspace/--tier/--model', () => {
    expect(parseSubstrateBlameArgs(['--latest', '--template', 't', '--workspace', 'w', '--tier', 'deep', '--model', 'm'])).toMatchObject({
      latest: true, template: 't', workspace: 'w', tier: 'deep', model: 'm',
    });
  });
  it('--no-verify-round / --no-memorize flip their defaults', () => {
    expect(parseSubstrateBlameArgs(['--no-verify-round']).verifyRound).toBe(false);
    expect(parseSubstrateBlameArgs(['--no-memorize']).memorize).toBe(false);
  });
  it('--watch-json implies --watch; --dry-run', () => {
    expect(parseSubstrateBlameArgs(['--watch-json'])).toMatchObject({ watch: true, watchJson: true });
    expect(parseSubstrateBlameArgs(['--dry-run']).dryRun).toBe(true);
  });
  it('--mode topo|train is a value flag (design §5 override) — its value is NEVER swallowed as the <run> positional', () => {
    // the regression: `--mode train` used to fall through, leaving `train` captured as the run positional.
    const train = parseSubstrateBlameArgs(['--mode', 'train']);
    expect(train.mode).toBe('train');
    expect(train.run).toBeUndefined();
    expect(parseSubstrateBlameArgs(['--mode', 'topo', 'myrun'])).toMatchObject({ mode: 'topo', run: 'myrun' });
    // an invalid mode is ignored (never captured as the run), like every other unknown flag value.
    expect(parseSubstrateBlameArgs(['--mode', 'bogus']).mode).toBeUndefined();
    expect(parseSubstrateBlameArgs(['--mode', 'bogus']).run).toBeUndefined();
  });
});

// ── runSubstrateBlameCli — orchestration ───────────────────────────────────────────────────────────────────
describe('runSubstrateBlameCli', () => {
  it('measures ONLY nodes missing a report, then folds the run-level measure, then judges', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    await seedNode(templateDir, 'a');
    await seedNode(templateDir, 'b');
    const runDir = await seedRun(runsHome, 'r1', '2026-07-09T00:00:00Z');
    // pre-seed node "a"'s report — it must NOT be re-measured.
    await fs.mkdir(path.join(runDir, 'optimize', 'substrate'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'optimize', 'substrate', 'measure.a.json'), '{}');

    const calls: string[] = [];
    await runSubstrateBlameCli(['r1'], {
      resolveRunDir: () => runDir,
      resolveScope: () => ({ templateDir, runsHome }),
      measure: async (rd, node) => { calls.push(`measure:${node}`); return okMeasure(); },
      blameMeasure: async (rd) => { calls.push('blame-measure'); return okBlameMeasure(); },
      blameJudge: async (rd, opts) => { calls.push('blame-judge'); return judged(emptySummary); },
      print: () => {},
    });

    // only "b" (missing report) is measured; the run-level fold runs regardless; judge runs last.
    expect(calls).toEqual(['measure:b', 'blame-measure', 'blame-judge']);
  });

  it('--watch streams the blame-measured boundary after the mechanical fold (not only judge/verify)', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    const runDir = await seedRun(runsHome, 'r1', '2026-07-09T00:00:00Z');
    const lines: string[] = [];
    await runSubstrateBlameCli(['r1', '--watch-json'], {
      resolveRunDir: () => runDir,
      resolveScope: () => ({ templateDir, runsHome }),
      measure: async () => okMeasure(),
      // the measure fold runs; blame-measured must be announced right after it, before the judge phase.
      blameMeasure: async () => okBlameMeasure(),
      blameJudge: async (rd, opts) => { opts.onEvent?.({ type: 'blame-judged', blamed: 0 }); return judged(emptySummary); },
      print: (s) => lines.push(s),
    });
    const measuredIdx = lines.findIndex((l) => l.includes('blame-measured'));
    const judgedIdx = lines.findIndex((l) => l.includes('blame-judged'));
    expect(measuredIdx).toBeGreaterThanOrEqual(0); // the mechanical fold boundary is on the stream
    expect(judgedIdx).toBeGreaterThanOrEqual(0);
    expect(measuredIdx).toBeLessThan(judgedIdx); // and it precedes the judge phase
  });

  it('passes templateDir/workspace/verifyRound + a PERSISTENT outDir to the judge; prints the observe hint', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    const runDir = await seedRun(runsHome, 'r1', '2026-07-09T00:00:00Z');
    let seenOpts: unknown;
    const lines: string[] = [];
    await runSubstrateBlameCli(['r1', '--no-verify-round'], {
      resolveRunDir: () => runDir,
      resolveScope: () => ({ templateDir, runsHome }),
      measure: async () => okMeasure(),
      blameMeasure: async () => okBlameMeasure(),
      blameJudge: async (rd, opts) => { seenOpts = opts; return judged({ blamed: [{ node: 'gameplay', severity: 'high', observedAt: ['gameplay'] }], edges: [], unattributed: [] }, [path.join(blameAgentOutDir(runDir), '..', 'gameplay.md')]); },
      print: (s) => lines.push(s),
    });
    const expectedOutDir = blameAgentOutDir(runDir);
    expect(seenOpts).toMatchObject({ templateDir, verifyRound: false, outDir: expectedOutDir });
    const out = lines.join('\n');
    expect(out).toMatch(/gameplay\[high\]/);
    expect(out).toContain(`observe: piflowctl telemetry ${expectedOutDir}`);
  });

  it('--latest picks the newest run via the injected scan (scanRunsHome), never a positional', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    await seedRun(runsHome, 'older', '2026-07-08T00:00:00Z');
    const newest = await seedRun(runsHome, 'newer', '2026-07-09T00:00:00Z');
    const measured: string[] = [];
    await runSubstrateBlameCli(['--latest'], {
      resolveScope: () => ({ templateDir, runsHome }),
      measure: async (rd) => { measured.push(rd); return okMeasure(); },
      blameMeasure: async (rd) => { measured.push(rd); return okBlameMeasure(); },
      blameJudge: async () => judged(emptySummary),
      print: () => {},
    });
    expect(measured.every((rd) => rd === newest)).toBe(true);
  });

  it('no positional AND no --latest ALSO resolves the newest run (the doc\'s "or NO positional" clause)', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    const newest = await seedRun(runsHome, 'only', '2026-07-09T00:00:00Z');
    const calls: string[] = [];
    await runSubstrateBlameCli([], {
      resolveScope: () => ({ templateDir, runsHome }),
      measure: async () => okMeasure(),
      blameMeasure: async (rd) => { calls.push(rd); return okBlameMeasure(); },
      blameJudge: async () => judged(emptySummary),
      print: () => {},
    });
    expect(calls).toEqual([newest]);
  });

  it('exit 2 with an actionable message when --latest finds no runs', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    await fs.mkdir(runsHome, { recursive: true });
    const errs: string[] = [];
    await runSubstrateBlameCli(['--latest'], {
      resolveScope: () => ({ templateDir, runsHome }),
      printErr: (s) => errs.push(s),
    });
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toMatch(/no runs found/);
  });

  it('idempotent rewrite: clears a stale <node>.md NOT re-written this pass, but preserves dissent.*.md', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    const runDir = await seedRun(runsHome, 'r1', '2026-07-09T00:00:00Z');
    const blameDirPath = path.join(runDir, 'optimize', 'blame');
    await fs.mkdir(blameDirPath, { recursive: true });
    await fs.writeFile(path.join(blameDirPath, 'stale-node.md'), '# stale — from a prior pass\n');
    await fs.writeFile(path.join(blameDirPath, 'blame.md'), '# old summary\n');
    await fs.writeFile(path.join(blameDirPath, 'dissent.stale-node.md'), '# a triage contest — must survive\n');

    await runSubstrateBlameCli(['r1'], {
      resolveRunDir: () => runDir,
      resolveScope: () => ({ templateDir, runsHome }),
      measure: async () => okMeasure(),
      blameMeasure: async () => okBlameMeasure(),
      // the fake judge writes its OWN fresh files, simulating a real pass that no longer blames "stale-node".
      blameJudge: async () => {
        await fs.writeFile(path.join(blameDirPath, 'blame.md'), '# fresh summary\n');
        return judged(emptySummary);
      },
      print: () => {},
    });

    const remaining = await fs.readdir(blameDirPath);
    expect(remaining).not.toContain('stale-node.md');
    expect(remaining).toContain('dissent.stale-node.md');
    expect(await fs.readFile(path.join(blameDirPath, 'dissent.stale-node.md'), 'utf8')).toMatch(/must survive/);
    expect(await fs.readFile(path.join(blameDirPath, 'blame.md'), 'utf8')).toMatch(/fresh summary/);
  });

  it('--dry-run spawns no memorize and clears nothing (a stale file survives), prints the composed judge plan', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    const runDir = await seedRun(runsHome, 'r1', '2026-07-09T00:00:00Z');
    const blameDirPath = path.join(runDir, 'optimize', 'blame');
    await fs.mkdir(blameDirPath, { recursive: true });
    await fs.writeFile(path.join(blameDirPath, 'stale-node.md'), '# stale\n');

    const lines: string[] = [];
    let memorizeCalled = false;
    let seenDryRun: unknown;
    await runSubstrateBlameCli(['r1', '--dry-run'], {
      resolveRunDir: () => runDir,
      resolveScope: () => ({ templateDir, runsHome }),
      measure: async () => okMeasure(),
      blameMeasure: async () => okBlameMeasure(),
      blameJudge: async (rd, opts) => {
        seenDryRun = opts.dryRun;
        return {
          summary: emptySummary, files: [],
          dryRun: { label: 'agent', executor: 'claude-code', prompt: 'THE-BLAME-PROMPT', tools: {}, io: { reads: [], produces: [], artifacts: [] } },
        };
      },
      blameMemorize: async () => { memorizeCalled = true; },
      print: (s) => lines.push(s),
    });

    expect(seenDryRun).toBe(true);
    expect(memorizeCalled).toBe(false);
    const remaining = await fs.readdir(blameDirPath);
    expect(remaining).toContain('stale-node.md'); // a preview clears/writes NOTHING
    const out = lines.join('\n');
    expect(out).toMatch(/DRY RUN/);
    expect(out).toContain('THE-BLAME-PROMPT');
  });

  it('unless --no-memorize, calls the injected blameMemorize with the summary; a throw is advisory (never aborts)', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    const runDir = await seedRun(runsHome, 'r1', '2026-07-09T00:00:00Z');
    const summary: BlameSummary = { blamed: [{ node: 'gameplay', severity: 'low', observedAt: [] }], edges: [], unattributed: [] };
    let seenSummary: BlameSummary | undefined;
    const errs: string[] = [];
    await runSubstrateBlameCli(['r1'], {
      resolveRunDir: () => runDir,
      resolveScope: () => ({ templateDir, runsHome }),
      measure: async () => okMeasure(),
      blameMeasure: async () => okBlameMeasure(),
      blameJudge: async () => judged(summary),
      blameMemorize: async (rd, opts) => { seenSummary = opts.summary; throw new Error('memory.md is locked'); },
      print: () => {},
      printErr: (s) => errs.push(s),
    });
    expect(seenSummary).toEqual(summary);
    expect(errs.join('\n')).toMatch(/blame-memorize failed/);
    expect(errs.join('\n')).toMatch(/memory\.md is locked/);
    expect(process.exitCode).not.toBe(2); // advisory — the blame pass itself still landed
  });

  it('--no-memorize skips blameMemorize entirely even when injected', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    const runDir = await seedRun(runsHome, 'r1', '2026-07-09T00:00:00Z');
    let called = false;
    await runSubstrateBlameCli(['r1', '--no-memorize'], {
      resolveRunDir: () => runDir,
      resolveScope: () => ({ templateDir, runsHome }),
      measure: async () => okMeasure(),
      blameMeasure: async () => okBlameMeasure(),
      blameJudge: async () => judged(emptySummary),
      blameMemorize: async () => { called = true; },
      print: () => {},
    });
    expect(called).toBe(false);
  });

  it('DEFAULT (no injected blameMemorize): the REAL core memorizeBlame runs — template-root memory.md gets a lesson block (WS-B6 wiring)', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    const runDir = await seedRun(runsHome, 'r1', '2026-07-09T00:00:00Z');
    const blameDirPath = path.join(runDir, 'optimize', 'blame');
    await fs.mkdir(blameDirPath, { recursive: true });
    await fs.mkdir(templateDir, { recursive: true });
    const summary: BlameSummary = { blamed: [{ node: 'gameplay', severity: 'high', observedAt: ['gameplay'] }], edges: [], unattributed: [] };

    await runSubstrateBlameCli(['r1'], {
      resolveRunDir: () => runDir,
      resolveScope: () => ({ templateDir, runsHome }),
      measure: async () => okMeasure(),
      blameMeasure: async () => okBlameMeasure(),
      // simulate the REAL judge's write side-effect: the fenced tail + a per-node prose blame file —
      // memorizeBlame reads BOTH straight off disk, it never trusts the returned `summary` object alone.
      blameJudge: async () => {
        await fs.writeFile(path.join(blameDirPath, 'blame.md'), `# summary\n\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\`\n`);
        await fs.writeFile(path.join(blameDirPath, 'gameplay.md'), '# blame — gameplay @ r1\n\nThe combo counter drops silently mid-fight.\n');
        return judged(summary);
      },
      print: () => {},
      // NO blameMemorize injected — proves the CLI's DEFAULT falls back to the real `memorizeBlame` (core).
    });

    const body = await fs.readFile(path.join(templateDir, 'memory.md'), 'utf8');
    expect(body).toMatch(/sig: blame:gameplay::/);
    expect(body).toContain('recurrence: 1');
  });

  it('--no-memorize skips the REAL memorizeBlame too (no injection at all): no template-root memory.md is written', async () => {
    const dir = await tmp();
    const templateDir = path.join(dir, 'template');
    const runsHome = path.join(dir, 'runs');
    const runDir = await seedRun(runsHome, 'r1', '2026-07-09T00:00:00Z');
    const blameDirPath = path.join(runDir, 'optimize', 'blame');
    await fs.mkdir(blameDirPath, { recursive: true });
    await fs.mkdir(templateDir, { recursive: true });

    await runSubstrateBlameCli(['r1', '--no-memorize'], {
      resolveRunDir: () => runDir,
      resolveScope: () => ({ templateDir, runsHome }),
      measure: async () => okMeasure(),
      blameMeasure: async () => okBlameMeasure(),
      blameJudge: async () => {
        await fs.writeFile(path.join(blameDirPath, 'blame.md'), '# summary\n\n```json\n{"blamed":[],"edges":[],"unattributed":[]}\n```\n');
        return judged(emptySummary);
      },
      print: () => {},
    });

    await expect(fs.access(path.join(templateDir, 'memory.md'))).rejects.toThrow();
  });

  it('an UNRESOLVABLE template exits 2 cleanly (no thrown stack)', async () => {
    const errs: string[] = [];
    await expect(runSubstrateBlameCli(['--latest'], {
      resolveScope: () => { throw new Error('could not resolve a template'); },
      printErr: (s) => errs.push(s),
    })).resolves.toBeUndefined();
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toMatch(/could not resolve a template/);
  });
});
