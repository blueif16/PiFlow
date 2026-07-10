// Real-fs tests for packages/core/src/optimize/substrate/measure.ts (M3.1/M3.2 of
// docs/specs/optimize-substrate-plan.md) — runSubstrateMeasure reads a node's `optimize.measure` op[]
// straight off `<templateDir>/nodes/<id>/node.json`, resolves + fires it against a REAL finished run dir
// (a fixture template run through the real `runFromTemplate` lifecycle, mirroring spawn-child-run.test.ts's
// convention), folds the trace detectors + digest anomalies, and writes ONE deterministic report.
//
// Run: npx vitest run packages/core/test/optimize-substrate-measure.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFromTemplate } from '../src/runner/index.js';
import { runSubstrateMeasure } from '../src/optimize/substrate/measure.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, 'fixtures', 'template-substrate-measure');

// The offline stub (mirrors spawn-child-run.test.ts's convention): write each declared artifact, then end
// with a parseable return-protocol block.
function stubBuilder() {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => {
        const dest = `${node.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

describe('runSubstrateMeasure — op[] execution + report shape + determinism', () => {
  let tmpRoot: string;
  let templateDir: string;
  let runDir: string;
  // HERMETIC (M3): `runFromTemplate` self-registers `workspace` — `templateDir` here doesn't satisfy the
  // `.piflow/<wf>/template` shape `templateLayout` requires, so it falls back to `process.cwd()` (a REAL
  // repo path) — into `~/.piflow/products.json`. Point PIFLOW_HOME at a scratch dir for this suite.
  let piflowHome: string;
  let savedPiflowHome: string | undefined;

  beforeAll(async () => {
    piflowHome = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-home-substrate-measure-'));
    savedPiflowHome = process.env.PIFLOW_HOME;
    process.env.PIFLOW_HOME = piflowHome;

    // `runSubstrateMeasure` derives templateDir from runDir the SAME way optimize-fix.ts's `templateDirFor`
    // does (`<runDir>/../../template`, the canonical `.piflow/<wf>/runs/<id>` layout) — so the fixture must
    // sit in that exact relative shape: `<tmpRoot>/template` (a copy of the fixture) + `<tmpRoot>/runs/run-1`.
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-substrate-measure-'));
    templateDir = path.join(tmpRoot, 'template');
    await fs.cp(FIXTURE, templateDir, { recursive: true });
    runDir = path.join(tmpRoot, 'runs', 'run-1');
    const res = await runFromTemplate(templateDir, { run: 'run-1', runDir, buildCommand: stubBuilder() });
    expect(res.status.ok).toBe(true);
    expect(await fs.readFile(path.join(runDir, 'out.txt'), 'utf8')).toBe('build');
  });
  afterAll(async () => {
    if (savedPiflowHome === undefined) delete process.env.PIFLOW_HOME;
    else process.env.PIFLOW_HOME = savedPiflowHome;
    await fs.rm(piflowHome, { recursive: true, force: true });
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('fires the measure op[] (a run-op writing a report + post gates checking it), folding a graded numeric report', async () => {
    const report = await runSubstrateMeasure(runDir, 'build', { workspace: templateDir });

    expect(report.node).toBe('build');
    expect(typeof report.generatedAt).toBe('string');

    // the run-op executed and wrote its declared report.
    expect(report.ops.runs).toHaveLength(1);
    expect(report.ops.runs[0].wrote).toBe(true);
    expect(report.ops.runs[0].failed).toBe(false);

    // both post gates passed: the node's own artifact is non-empty, and the run-op's report parses.
    expect(report.ops.checks).toHaveLength(2);
    expect(report.ops.checks.every((c) => c.verdict === 'pass')).toBe(true);

    expect(report.ops.rejected).toEqual([]);

    // graded numeric metrics were pulled from the op's own declared `writes` JSON report.
    expect(report.graded['write-report.fillRatio']).toBe(0.75);
    expect(report.graded['write-report.spanMs']).toBe(1200);

    // detectors ran (no thinking/tool/turn events in this stub trace ⇒ all empty, never throws).
    expect(report.detectors.thinkingSpans).toEqual([]);
    expect(report.detectors.toolLoops).toEqual([]);
    expect(report.detectors.tokenWaste).toBeNull();
    expect(report.detectors.truncatedLines).toBe(0);

    // digest anomalies folded (a clean stub run ⇒ none).
    expect(report.digestAnomalies).toEqual([]);

    // the report was persisted at the documented path.
    const onDisk = JSON.parse(await fs.readFile(path.join(runDir, 'optimize', 'substrate', 'measure.build.json'), 'utf8'));
    expect(onDisk.node).toBe('build');
  });

  it('degrades gracefully when the node has NO optimize block: ops section empty, detectors still run', async () => {
    const report = await runSubstrateMeasure(runDir, 'plain', { workspace: templateDir });
    expect(report.ops.checks).toEqual([]);
    expect(report.ops.runs).toEqual([]);
    expect(report.ops.rejected).toEqual([]);
    expect(report.graded).toEqual({});
    expect(report.detectors.thinkingSpans).toEqual([]);
  });

  it('is deterministic: two measure passes over the SAME run write byte-identical reports (modulo generatedAt)', async () => {
    const first = await runSubstrateMeasure(runDir, 'build', { workspace: templateDir });
    const second = await runSubstrateMeasure(runDir, 'build', { workspace: templateDir });
    const strip = (r: typeof first) => ({ ...r, generatedAt: '' });
    expect(strip(first)).toEqual(strip(second));
  });
});

// A measure op[] may reference the RUN's args via `{{arg.<key>}}` (e.g. `{{arg.lessonId}}`). The substrate is
// external to the runner, so it must LOAD those args from the finished run's persisted `.pi/run.json` and
// thread them into the `ResolveCtx` — otherwise `resolveDeep` throws `MissingArgError` and crashes measurement
// for the whole node. This block pins BOTH halves of that seam: (1) the runner PERSISTS the run's args into
// `.pi/run.json`, and (2) `runSubstrateMeasure` LOADS + THREADS them — while KEEPING the loud discipline
// (a referenced-but-absent arg still throws; a run.json with no args degrades to `{}`, never throws at load).
describe('runSubstrateMeasure — run-arg ({{arg.*}}) threading from .pi/run.json', () => {
  let tmpRoot: string;
  let templateDir: string;
  let runDir: string;
  let piflowHome: string;
  let savedPiflowHome: string | undefined;

  // A measure-only node (never runs through the lifecycle — read straight off disk by readMeasureOps): its
  // `optimize.measure` op[] references `{{arg.lessonId}}`, capturing the resolved value into a file so a test
  // can assert the arg physically flowed, then gating that the capture is non-empty.
  const ARGNODE = {
    id: 'argnode',
    optimize: {
      measure: [
        {
          id: 'capture-lesson',
          when: 'post',
          writes: ['{{RUN}}/optimize/substrate/lesson.txt'],
          run: {
            cmd: 'node',
            args: [
              '-e',
              "const fs=require('fs');const dir='{{RUN}}/optimize/substrate';fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/lesson.txt','{{arg.lessonId}}')",
            ],
          },
        },
        { id: 'lesson-present', when: 'post', gate: { kind: 'non-empty', path: '{{RUN}}/optimize/substrate/lesson.txt' } },
      ],
    },
  };
  // A measure-only node whose op references an arg the run NEVER supplied — resolving it MUST throw.
  const ARGMISSING = {
    id: 'argmissing',
    optimize: {
      measure: [
        {
          id: 'needs-nope',
          when: 'post',
          writes: ['{{RUN}}/optimize/substrate/nope.txt'],
          run: { cmd: 'node', args: ['-e', "require('fs').writeFileSync('nope.txt','{{arg.nope}}')"] },
        },
      ],
    },
  };

  beforeAll(async () => {
    piflowHome = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-home-substrate-measure-args-'));
    savedPiflowHome = process.env.PIFLOW_HOME;
    process.env.PIFLOW_HOME = piflowHome;

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-substrate-measure-args-'));
    templateDir = path.join(tmpRoot, 'template');
    await fs.cp(FIXTURE, templateDir, { recursive: true });

    // (1) run the REAL lifecycle WITH `--arg lessonId=L-42` — this is the persist half (run.json must record it).
    runDir = path.join(tmpRoot, 'runs', 'run-args');
    const res = await runFromTemplate(templateDir, {
      run: 'run-args',
      runDir,
      buildCommand: stubBuilder(),
      args: { lessonId: 'L-42' },
    });
    expect(res.status.ok).toBe(true);

    // (2) add the two MEASURE-only nodes AFTER the run (readMeasureOps reads their node.json straight off disk;
    // they are never part of the compiled DAG, so loadTemplate above never saw them).
    for (const n of [ARGNODE, ARGMISSING]) {
      const dir = path.join(templateDir, 'nodes', n.id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'node.json'), JSON.stringify(n, null, 2));
    }
  });
  afterAll(async () => {
    if (savedPiflowHome === undefined) delete process.env.PIFLOW_HOME;
    else process.env.PIFLOW_HOME = savedPiflowHome;
    await fs.rm(piflowHome, { recursive: true, force: true });
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  // Hand-build a run dir with a chosen run.json shape (control over the args key) so the LOADER's degrade/loud
  // semantics are pinned independently of the runner. templateDir is derived as `<runDir>/../../template`, so
  // these sit under the SAME `<tmpRoot>/runs/` as the real run and see the SAME template (incl. the two nodes).
  async function handRun(id: string, runJson: Record<string, unknown>): Promise<string> {
    const rd = path.join(tmpRoot, 'runs', id);
    await fs.mkdir(path.join(rd, '.pi'), { recursive: true });
    await fs.writeFile(path.join(rd, '.pi', 'run.json'), JSON.stringify(runJson, null, 2));
    return rd;
  }

  it('PART 1 — the runner PERSISTS the run args into .pi/run.json', async () => {
    const persisted = JSON.parse(await fs.readFile(path.join(runDir, '.pi', 'run.json'), 'utf8')) as {
      args?: Record<string, string>;
    };
    expect(persisted.args).toEqual({ lessonId: 'L-42' });
  });

  it('PART 2 — resolves {{arg.lessonId}} from the run\'s persisted args (end-to-end)', async () => {
    const report = await runSubstrateMeasure(runDir, 'argnode', { workspace: templateDir });

    // the run-op fired (did not crash on the arg token) and its gate passed.
    expect(report.ops.runs).toHaveLength(1);
    expect(report.ops.runs[0].failed).toBe(false);
    expect(report.ops.checks.every((c) => c.verdict === 'pass')).toBe(true);

    // the arg value physically flowed through resolveDeep into the op's output.
    const captured = await fs.readFile(path.join(runDir, 'optimize', 'substrate', 'lesson.txt'), 'utf8');
    expect(captured).toBe('L-42');
  });

  it('loud discipline preserved — a referenced-but-ABSENT arg still throws MissingArgError', async () => {
    // run.json HAS args, but not the `nope` key the op references — the resolver must throw, never silent ''.
    const rd = await handRun('run-absent-arg', { run: 'run-absent-arg', done: true, ok: true, nodes: {}, args: { lessonId: 'L-42' } });
    await expect(runSubstrateMeasure(rd, 'argmissing', { workspace: templateDir })).rejects.toThrow(
      /unresolved run arg "nope"/,
    );
  });

  it('degrades gracefully — a run.json with NO args key measures a no-arg node without throwing', async () => {
    // an OLD/argless run.json (backward-compat): the loader degrades to `{}` and never throws at load; a node
    // whose measure has no `{{arg.*}}` token measures cleanly.
    const rd = await handRun('run-no-args', { run: 'run-no-args', done: true, ok: true, nodes: {} });
    const report = await runSubstrateMeasure(rd, 'build', { workspace: templateDir });
    expect(report.node).toBe('build');
    expect(report.ops.rejected).toEqual([]);
  });
});
