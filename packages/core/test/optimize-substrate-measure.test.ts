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

  beforeAll(async () => {
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
