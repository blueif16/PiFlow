// Real-fs tests for packages/core/src/optimize/blame/measure.ts (WS-B1 of docs/design/optimize-blame.md
// §2/§4 step 1) — runBlameMeasure reads the template's RUN-LEVEL `optimize.measure` op[] straight off
// `<templateDir>/meta.json`, resolves + fires it against a finished run dir, folds a best-effort digest
// section, and writes ONE deterministic report. Mirrors optimize-substrate-measure.test.ts's fixtures and
// conventions (tmpdir workspace + runDir, hand-built `.pi/run.json` for degrade paths — no git needed).
//
// Run: npx vitest run packages/core/test/optimize-blame-measure.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFromTemplate } from '../src/runner/index.js';
import { runBlameMeasure } from '../src/optimize/blame/measure.js';
import { blameMeasurePath } from '../src/optimize/blame/paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, 'fixtures', 'template-blame-measure');

// The offline stub (mirrors spawn-child-run.test.ts / optimize-substrate-measure.test.ts's convention):
// write each declared artifact, then end with a parseable return-protocol block.
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

describe('runBlameMeasure — op[] execution + report shape + determinism', () => {
  let tmpRoot: string;
  let templateDir: string;
  let runDir: string;
  // HERMETIC (mirrors optimize-substrate-measure.test.ts): point PIFLOW_HOME at a scratch dir so
  // `runFromTemplate`'s workspace self-registration never touches the real `~/.piflow/products.json`.
  let piflowHome: string;
  let savedPiflowHome: string | undefined;

  beforeAll(async () => {
    piflowHome = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-home-blame-measure-'));
    savedPiflowHome = process.env.PIFLOW_HOME;
    process.env.PIFLOW_HOME = piflowHome;

    // `runBlameMeasure` derives templateDir from runDir the SAME way substrate/measure.ts's
    // `templateDirForRun` does (`<runDir>/../../template`) — so the fixture must sit in that exact
    // relative shape: `<tmpRoot>/template` (a copy of the fixture) + `<tmpRoot>/runs/run-1`.
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-blame-measure-'));
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

  it('fires the meta-level op[] (a run-op writing a report + post gates checking it), folding a graded numeric report', async () => {
    const report = await runBlameMeasure(runDir, { workspace: templateDir });

    expect(typeof report.generatedAt).toBe('string');

    // the run-op executed and wrote its declared report.
    expect(report.ops.runs).toHaveLength(1);
    expect(report.ops.runs[0].wrote).toBe(true);
    expect(report.ops.runs[0].failed).toBe(false);

    // both post gates passed: the run's final artifact is non-empty, and the run-op's report parses.
    expect(report.ops.checks).toHaveLength(2);
    expect(report.ops.checks.every((c) => c.verdict === 'pass')).toBe(true);

    expect(report.ops.rejected).toEqual([]);

    // graded numeric metrics were pulled from the op's own declared `writes` JSON report.
    expect(report.graded['write-report.fillRatio']).toBe(0.6);
    expect(report.graded['write-report.spanMs']).toBe(900);

    // the digest section folded from the real run — one clean node, no root causes.
    expect(report.digest.nodes.map((n) => n.id)).toEqual(['build']);
    expect(report.digest.rootCauses).toEqual([]);

    // the report was persisted at the documented path.
    const onDisk = JSON.parse(await fs.readFile(blameMeasurePath(runDir), 'utf8'));
    expect(onDisk.graded['write-report.fillRatio']).toBe(0.6);
  });

  it('is deterministic: two measure passes over the SAME run write byte-identical reports (modulo generatedAt)', async () => {
    const first = await runBlameMeasure(runDir, { workspace: templateDir });
    const second = await runBlameMeasure(runDir, { workspace: templateDir });
    const strip = (r: typeof first) => ({ ...r, generatedAt: '' });
    expect(strip(first)).toEqual(strip(second));
  });
});

describe('runBlameMeasure — degrade paths (no live run needed)', () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-blame-measure-degrade-'));
  });
  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  // Hand-build a `<root>/template` + `<root>/runs/<id>` pair with a chosen meta.json/run.json shape — no
  // `runFromTemplate` lifecycle needed, since `runBlameMeasure` reads both straight off disk.
  async function makeRoot(id: string, meta: Record<string, unknown>, runJson: Record<string, unknown> | null): Promise<string> {
    const root = path.join(tmpRoot, id);
    await fs.mkdir(path.join(root, 'template'), { recursive: true });
    await fs.writeFile(path.join(root, 'template', 'meta.json'), JSON.stringify(meta, null, 2));
    const rd = path.join(root, 'runs', 'r1');
    await fs.mkdir(path.join(rd, '.pi'), { recursive: true });
    if (runJson) await fs.writeFile(path.join(rd, '.pi', 'run.json'), JSON.stringify(runJson, null, 2));
    return rd;
  }

  it('an absent optimize block degrades to an EMPTY op[] — valid report, empty ops+graded, still written', async () => {
    const rd = await makeRoot(
      'absent-optimize',
      { id: 'x', name: 'x', description: 'x' },
      { run: 'r1', done: true, ok: true, nodes: {} },
    );
    const report = await runBlameMeasure(rd, { workspace: path.dirname(path.dirname(rd)) });

    expect(report.ops).toEqual({ checks: [], runs: [], rejected: [] });
    expect(report.graded).toEqual({});

    const onDisk = JSON.parse(await fs.readFile(blameMeasurePath(rd), 'utf8'));
    expect(onDisk.ops).toEqual({ checks: [], runs: [], rejected: [] });
  });

  it('an UNRESOLVABLE {{arg.*}} op is dropped+recorded in ops.rejected while a sibling op still runs', async () => {
    const meta = {
      id: 'x',
      name: 'x',
      description: 'x',
      optimize: {
        measure: [
          {
            id: 'needs-lesson',
            when: 'post',
            writes: ['{{RUN}}/optimize/blame/lesson.txt'],
            run: {
              cmd: 'node',
              args: [
                '-e',
                "const fs=require('fs');const dir='{{RUN}}/optimize/blame';fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/lesson.txt','{{arg.lessonId}}')",
              ],
            },
          },
          {
            id: 'ok-report',
            when: 'post',
            writes: ['{{RUN}}/optimize/blame/ok-report.json'],
            run: {
              cmd: 'node',
              args: [
                '-e',
                "const fs=require('fs');const dir='{{RUN}}/optimize/blame';fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/ok-report.json',JSON.stringify({metric:1}))",
              ],
            },
          },
          { id: 'ok-parses', when: 'post', gate: { kind: 'json-parses', path: '{{RUN}}/optimize/blame/ok-report.json' } },
        ],
      },
    };
    // run.json has NO args at all — {{arg.lessonId}} is unresolvable.
    const rd = await makeRoot('unresolvable-arg', meta, { run: 'r1', done: true, ok: true, nodes: {} });
    const report = await runBlameMeasure(rd, { workspace: path.dirname(path.dirname(rd)) });

    // (A) the unresolvable op was dropped + recorded — never a crash, never a silent pass.
    expect(report.ops.rejected).toHaveLength(1);
    expect(report.ops.rejected[0]).toMatch(/needs-lesson/);
    expect(report.ops.rejected[0]).toMatch(/unresolved run arg "lessonId"/);
    await expect(fs.readFile(path.join(rd, 'optimize', 'blame', 'lesson.txt'), 'utf8')).rejects.toThrow();

    // (B) the RESOLVABLE sibling op STILL ran and (C) its gate STILL passed.
    expect(report.ops.runs).toHaveLength(1);
    expect(report.ops.runs[0].wrote).toBe(true);
    expect(report.ops.runs[0].failed).toBe(false);
    expect(report.ops.checks).toHaveLength(1);
    expect(report.ops.checks[0].verdict).toBe('pass');
    expect(report.graded['ok-report.metric']).toBe(1);
  });

  it('a malformed .pi/run.json degrades the digest to empty — the report is still written and the ops still ran', async () => {
    const meta = {
      id: 'x',
      name: 'x',
      description: 'x',
      optimize: {
        measure: [
          {
            id: 'write-report',
            when: 'post',
            writes: ['{{RUN}}/optimize/blame/check-report.json'],
            run: {
              cmd: 'node',
              args: [
                '-e',
                "const fs=require('fs');const dir='{{RUN}}/optimize/blame';fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/check-report.json',JSON.stringify({metric:2}))",
              ],
            },
          },
        ],
      },
    };
    const rd = await makeRoot('malformed-run-json', meta, null);
    // write a run.json that is NOT valid JSON — buildRunView's JSON.parse throws.
    await fs.writeFile(path.join(rd, '.pi', 'run.json'), '{not valid json');

    const report = await runBlameMeasure(rd, { workspace: path.dirname(path.dirname(rd)) });

    // the op[] has no {{arg.*}}/{{state.*}} tokens, so it still ran despite the malformed run.json (readRunArgs
    // degrades to {} on the SAME malformed file — a separate, independently-caught read).
    expect(report.ops.runs).toHaveLength(1);
    expect(report.ops.runs[0].failed).toBe(false);
    expect(report.graded['write-report.metric']).toBe(2);

    // the digest degraded to empty — never threw out of the module.
    expect(report.digest).toEqual({ nodes: [], rootCauses: [] });

    const onDisk = JSON.parse(await fs.readFile(blameMeasurePath(rd), 'utf8'));
    expect(onDisk.digest).toEqual({ nodes: [], rootCauses: [] });
  });

  // (op-integrity WS-I5) The RUN-LEVEL twin of the substrate fix: a failing `run` op declaring a
  // `resultFile` must distill the ledger's verdict (naming the failing CHECK) into `detail`, never leave
  // only `stderr` noise for a blame judge to read — the exact incident the design doc names, one level up.
  it('a failing resultFile op distills the LEDGER verdict, not stderr noise (WS-I5)', async () => {
    const meta = {
      id: 'x',
      name: 'x',
      description: 'x',
      optimize: {
        measure: [
          {
            id: 'verify',
            when: 'post',
            writes: ['{{RUN}}/optimize/blame/ledger.json'],
            resultFile: '{{RUN}}/optimize/blame/ledger.json',
            run: {
              cmd: 'node',
              args: [
                '-e',
                "const fs=require('fs');const dir='{{RUN}}/optimize/blame';fs.mkdirSync(dir,{recursive:true});" +
                  "fs.writeFileSync(dir+'/ledger.json',JSON.stringify({ok:false,checks:[{name:'answer_in_choices',ok:false,detail:'choice not in options'}]}));" +
                  "process.stderr.write('[kp_cache] MCP client unavailable');process.exit(1)",
              ],
            },
          },
        ],
      },
    };
    const rd = await makeRoot('resultfile-run', meta, { run: 'r1', done: true, ok: true, nodes: {} });
    const report = await runBlameMeasure(rd, { workspace: path.dirname(path.dirname(rd)) });

    expect(report.ops.runs).toHaveLength(1);
    const [run] = report.ops.runs;
    expect(run.failed).toBe(true);
    expect(run.detail, 'the failing CHECK is named').toContain('answer_in_choices');
    expect(run.detail, 'never the raw stderr WARNING').not.toMatch(/MCP client unavailable|\[kp_cache\]/);
    expect(run.resultFile, 'the raw path rides so a verb can open it').toContain('ledger.json');
  });
});
