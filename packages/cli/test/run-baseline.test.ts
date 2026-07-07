// `piflowctl run --baseline <id|path> [--stage-only]` — seed a NEW run from a BASELINE run so a windowed
// `--from` re-run executes ONLY the node(s) under test on FROZEN upstream (every upstream node `reused`).
// This is the SDK surface that kills the manual "hand-copy spec/*.json + .pi/state.json between run dirs"
// protocol operators used to build verification arms.
//
// The integration path reuses run.ts's ENTIRE machinery: the REAL `runTemplate` (workspace derivation,
// canonical run home, the baseline seed, the `--from/--until` window join), with the pi-spawn boundary
// (`runFromTemplate`) stubbed to drive the REAL `runWorkflow` over an offline builder — so the seed/reuse/
// preflight/seed-staging logic under test all runs for real (only the agent command is faked). Mirrors
// node-rerun.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseRunArgs,
  resolveBaselineDir,
  runTemplate as realRunTemplate,
  type RunDeps,
} from '../src/run.js';
import {
  loadTemplate,
  instantiateRun,
  compile,
  runWorkflow,
  runJsonFile,
  type RunStatus,
} from '@piflow/core';

// ── the offline stub builder (mirrors node-rerun.test.ts) — each node writes its declared artifact(s) into
// the sandbox output + returns an ok fence; `ran` records which nodes actually EXECUTED (a reused node never
// calls the builder). ──
function stubBuilder(ran: Set<string>) {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    ran.add(node.id);
    const writes = node.io.artifacts
      .map((a) => {
        const dest = `${node.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${node.id} done"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

/** run.ts deps: stub the pi-spawning template-join with a REAL `runWorkflow` over the stub builder (the
 *  window/seed/preflight/seed-staging logic under test lives in `runWorkflow`, so this exercises it for real). */
function makeRunDeps(ran: Set<string>): RunDeps {
  const stubJoin: NonNullable<RunDeps['runFromTemplate']> = async (templateDir, opts) => {
    const spec = await loadTemplate(templateDir);
    await instantiateRun(templateDir, opts.runDir, { workspace: opts.workspace ?? path.resolve(templateDir, '..') });
    const wf = compile(spec);
    const { status } = await runWorkflow(wf, {
      run: opts.run,
      outDir: opts.runDir,
      workspace: opts.workspace,
      from: opts.from,
      until: opts.until,
      noResume: opts.noResume,
      rerunNodes: opts.rerunNodes,
      args: opts.args ?? {},
      buildCommand: stubBuilder(ran),
      lease: false,
    });
    return { status, outDir: opts.runDir };
  };
  return { runFromTemplate: stubJoin, print: () => {} };
}

/**
 * A CANONICAL linear template `a → b → c` (each its own stage, distinct artifacts). The MID node `b` carries
 * a seed (`pin/menu.json <= {{WORKSPACE}}/tpl/menu.json`) so the pin-survival path is exercised for real:
 * a caller pre-places `pin/menu.json`, and `b`'s seed staging must SKIP the already-filled dest.
 */
async function writeLinearTemplate(templateDir: string): Promise<void> {
  await fs.mkdir(templateDir, { recursive: true });
  await fs.writeFile(
    path.join(templateDir, 'meta.json'),
    JSON.stringify({ id: 'lin', name: 'lin', description: 'baseline-rerun fixture', phases: ['s0', 's1', 's2'] }, null, 2),
  );
  const node = async (id: string, phase: string, deps: string[], extra: Record<string, unknown> = {}) => {
    const dir = path.join(templateDir, 'nodes', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'node.json'),
      JSON.stringify(
        {
          id,
          phase,
          deps,
          prompt: { file: 'prompt.md' },
          tools: { allow: ['read', 'write', 'submit_result'] },
          contract: { artifacts: [`${id}.txt`], owns: [`${id}.txt`], readScope: ['{{RUN}}'], returnMode: 'optional' },
          ...extra,
        },
        null,
        2,
      ),
    );
    await fs.writeFile(path.join(dir, 'prompt.md'), `do ${id}`);
  };
  await node('a', 's0', []);
  // b seeds pin/menu.json from the workspace template — the pin-survival probe.
  await node('b', 's1', ['a'], { hooks: { seed: [{ to: 'pin/menu.json', from: '{{WORKSPACE}}/tpl/menu.json' }] } });
  await node('c', 's2', ['b']);
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) FLAG PARSING — --baseline <v> and --stage-only.
// ─────────────────────────────────────────────────────────────────────────────
describe('parseRunArgs — --baseline / --stage-only', () => {
  it('parses --baseline <id> and --stage-only', () => {
    const p = parseRunArgs(['tpl', '--run', 'wa12', '--baseline', 'wa9', '--stage-only']);
    expect(p.baseline).toBe('wa9');
    expect(p.stageOnly).toBe(true);
  });
  it('absent ⇒ both undefined (byte-identical to a normal run)', () => {
    const p = parseRunArgs(['tpl', '--run', 'wa12']);
    expect(p.baseline).toBeUndefined();
    expect(p.stageOnly).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) resolveBaselineDir — a run id under the runs home, or a path; loud on missing/incomplete (Required #4).
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveBaselineDir — a run id or path, loud on missing/incomplete', () => {
  let root: string;
  let runsHome: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-baseline-resolve-'));
    runsHome = path.join(root, '.piflow', 'lin', 'runs');
    await fs.mkdir(runsHome, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('resolves a bare run id to its sibling under the canonical runs home', async () => {
    const wa9 = path.join(runsHome, 'wa9', '.pi');
    await fs.mkdir(wa9, { recursive: true });
    await fs.writeFile(path.join(wa9, 'run.json'), '{"run":"wa9","source":"lin"}');
    expect(resolveBaselineDir('wa9', { runsHome, landingHome: runsHome })).toBe(path.join(runsHome, 'wa9'));
  });

  it('resolves an explicit path to a run dir', async () => {
    const dir = path.join(root, 'somewhere', 'base');
    await fs.mkdir(path.join(dir, '.pi'), { recursive: true });
    await fs.writeFile(path.join(dir, '.pi', 'run.json'), '{"run":"base"}');
    expect(resolveBaselineDir(dir, { runsHome, landingHome: runsHome })).toBe(dir);
  });

  it('MISSING baseline → throws, naming what it looked for', () => {
    expect(() => resolveBaselineDir('nope', { runsHome, landingHome: runsHome })).toThrow(/--baseline "nope" not found/);
  });

  it('INCOMPLETE baseline (a dir with no .pi/run.json) → throws "not a recorded run"', async () => {
    await fs.mkdir(path.join(runsHome, 'half'), { recursive: true }); // exists, but no .pi/run.json
    expect(() => resolveBaselineDir('half', { runsHome, landingHome: runsHome })).toThrow(/not a recorded run/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (C) runTemplate dispatch — --stage-only requires --baseline; stage-only seeds + STOPS; combined seeds THEN
// runs the window. Spies keep it spawn-free.
// ─────────────────────────────────────────────────────────────────────────────
describe('runTemplate — --baseline / --stage-only dispatch', () => {
  let root: string;
  let templateDir: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-baseline-dispatch-'));
    templateDir = path.join(root, '.piflow', 'lin', 'template');
    await writeLinearTemplate(templateDir);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('--stage-only WITHOUT --baseline throws loudly (never a silent no-op)', async () => {
    await expect(
      realRunTemplate({ templateDir, dryRun: false, run: 'x', args: {}, sandbox: 'inmemory', stageOnly: true }, { print: () => {} }),
    ).rejects.toThrow(/--stage-only is valid only with --baseline/);
  });

  it('--stage-only SEEDS the run dir then STOPS — runFromTemplate is NEVER called', async () => {
    const runFromTemplate = vi.fn();
    const stageBaseline = vi.fn(async () => ['a.txt', '.pi/state.json']);
    const resolveBaseline = vi.fn(() => '/baseline/dir');
    const result = await realRunTemplate(
      { templateDir, dryRun: false, run: 'wa12', args: {}, sandbox: 'inmemory', baseline: 'wa9', stageOnly: true },
      { runFromTemplate: runFromTemplate as never, stageBaseline, resolveBaseline, print: () => {} },
    );
    expect(resolveBaseline).toHaveBeenCalledOnce();
    expect(stageBaseline).toHaveBeenCalledOnce();
    // The destination is the new run's CANONICAL home (…/runs/wa12), seeded from the resolved baseline dir.
    expect(stageBaseline.mock.calls[0][0]).toBe('/baseline/dir');
    expect(stageBaseline.mock.calls[0][1]).toBe(path.join(root, '.piflow', 'lin', 'runs', 'wa12'));
    expect(runFromTemplate).not.toHaveBeenCalled(); // STOPPED after seeding
    expect(result).toBeUndefined();
  });

  it('--baseline WITHOUT --stage-only seeds THEN runs the window (from/until threaded into runFromTemplate)', async () => {
    let optsSeen: { from?: string; until?: string; runDir?: string } | undefined;
    const runFromTemplate = vi.fn(async (_dir: string, opts: { from?: string; until?: string; runDir: string }) => {
      optsSeen = opts;
      return { status: { ok: true } as never, outDir: opts.runDir };
    });
    const stageBaseline = vi.fn(async () => ['a.txt']);
    await realRunTemplate(
      { templateDir, dryRun: false, run: 'wa12', args: {}, sandbox: 'inmemory', baseline: 'wa9', from: 'b', until: 'b' },
      { runFromTemplate: runFromTemplate as never, stageBaseline, resolveBaseline: () => '/baseline/dir', print: () => {} },
    );
    expect(stageBaseline).toHaveBeenCalledOnce(); // seeded first
    expect(runFromTemplate).toHaveBeenCalledOnce(); // THEN ran
    expect(optsSeen?.from).toBe('b');
    expect(optsSeen?.until).toBe('b');
    expect(optsSeen?.runDir).toBe(path.join(root, '.piflow', 'lin', 'runs', 'wa12'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (D) THE INTEGRATION — run A → fork B via --baseline --stage-only → window B from the MID node → upstream
// reused, mid ran, seeded artifacts match A's, and a pin pre-placed into B between stage and run SURVIVES.
// ─────────────────────────────────────────────────────────────────────────────
describe('run --baseline — fork a run + window a mid node on frozen upstream', () => {
  let root: string;
  let templateDir: string;
  let runsHome: string;
  let ran: Set<string>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-baseline-e2e-'));
    templateDir = path.join(root, '.piflow', 'lin', 'template');
    runsHome = path.join(root, '.piflow', 'lin', 'runs');
    await writeLinearTemplate(templateDir);
    // The workspace-side seed source `b` stages from — DISTINCT content from the pin, so pin-survival proves
    // skip-filled (not an absent source): if skip-filled regressed, b's seed would overwrite the pin with this.
    await fs.mkdir(path.join(root, 'tpl'), { recursive: true });
    await fs.writeFile(path.join(root, 'tpl', 'menu.json'), 'TEMPLATE');
    ran = new Set<string>();

    // Seed run A — a FULL run into the canonical home: every node executes ok, artifacts frozen on disk.
    await realRunTemplate({ templateDir, dryRun: false, run: 'A', args: {}, sandbox: 'inmemory' }, makeRunDeps(ran));
    expect(ran.has('a') && ran.has('b') && ran.has('c')).toBe(true);
    expect(await fs.readFile(path.join(runsHome, 'A', 'a.txt'), 'utf8')).toBe('a');
    ran.clear(); // from here, `ran` records ONLY what the forked window re-executes.
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('forks B from A (stage-only), a pin survives, and windowing from b re-runs ONLY b with a reused', async () => {
    // (1) FORK B from A, stage-only — seeds B's dir from A, no run. The REAL stageBaselineRun copies A's dir.
    const stageResult = await realRunTemplate(
      { templateDir, dryRun: false, run: 'B', args: {}, sandbox: 'inmemory', baseline: 'A', stageOnly: true },
      makeRunDeps(ran),
    );
    expect(stageResult).toBeUndefined(); // stage-only STOPS
    expect(ran.size).toBe(0); // nothing ran during staging
    const bDir = path.join(runsHome, 'B');
    // the seed carried A's frozen upstream artifact into B; the journal was DROPPED (so the window re-runs).
    expect(await fs.readFile(path.join(bDir, 'a.txt'), 'utf8')).toBe('a');
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(bDir, '.pi', 'journal.json'))).toBe(false);

    // (2) the caller PINS a file into the staged dir before launching the live window.
    await fs.mkdir(path.join(bDir, 'pin'), { recursive: true });
    await fs.writeFile(path.join(bDir, 'pin', 'menu.json'), 'PINNED');

    // (3) launch the live windowed run: from=b until=b (a NORMAL run — no --baseline).
    const result = await realRunTemplate(
      { templateDir, dryRun: false, run: 'B', args: {}, sandbox: 'inmemory', from: 'b', until: 'b' },
      makeRunDeps(ran),
    );

    // Required #3 — ONLY the windowed node executed; upstream was NOT re-run.
    expect(ran.has('b')).toBe(true);
    expect(ran.has('a')).toBe(false);
    expect(ran.has('c')).toBe(false); // c is out of the --until b window
    // The confound detector a verification protocol gates on: the run record says upstream is `reused`.
    const status = JSON.parse(await fs.readFile(runJsonFile(bDir), 'utf8')) as RunStatus;
    expect(status.nodes.a.status).toBe('reused');
    expect(status.nodes.b.status).toBe('ok');

    // Required #1 — the seeded upstream artifact in B matches A's (frozen, carried, never regenerated).
    expect(await fs.readFile(path.join(bDir, 'a.txt'), 'utf8')).toBe(
      await fs.readFile(path.join(runsHome, 'A', 'a.txt'), 'utf8'),
    );

    // Required #2 — the pin SURVIVED b's seed staging (stageSeed skip-filled): still PINNED, not TEMPLATE.
    expect(await fs.readFile(path.join(bDir, 'pin', 'menu.json'), 'utf8')).toBe('PINNED');
    expect(result?.status.ok).toBe(true);
  });
});
