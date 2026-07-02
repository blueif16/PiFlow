import { describe, it, expect } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, LocalSandboxProvider, buildRunView, assessRunView } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';

// ── Target 7 — N-mutant GUARDRAIL (rubric-has-teeth negative control) ──────────────────────────────
//
// A NEGATIVE CONTROL that proves the §5 rubric can actually FAIL. A "mutant" node declares an artifact
// (`out/must-exist.md`) but its buildCommand exits 0 while writing NOTHING — a structurally-impossible
// deliverable. Run through the SAME real `runWorkflow → buildRunView → assessRunView` pipeline as the L1
// lifecycle tier. The standing assertion `pass === false` on this real no-op run IS the teeth: if the
// rubric ever lost its artifact-existence check, a run that produced nothing would falsely pass here.
//
// The backend is LocalSandboxProvider (kind 'local', NOT inmemory) ON PURPOSE: the provider-proof gate
// (assess.ts:43, forbid inmemory) does NOT fire, so the ONLY thing that reds the run is the missing
// on-disk artifact (assess.ts:72, `if (!a.exists)`). That isolation is what makes the teeth-mutation
// (delete `if (!a.exists)`) flip `pass` to `true` and RED this test — a self-report-independent, fresh
// read of real state, never a config/template substring nor `status==='done'` alone.

/** A NodeIntent factory (mirrors runner.test.ts:23): reads/produces; artifacts default to produces. */
function n(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return { label, prompt: `do ${label}`, tools: {}, io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) }, ...over };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });

/** THE MUTANT COMMAND: exit 0, write NOTHING (structurally cannot satisfy its declared artifact). */
function mutantBuilder() {
  return (): string => 'true';
}

describe('N-mutant guardrail — the rubric FAILS a node that cannot produce its declared artifact', () => {
  it('assessRunView reds (pass===false) with the missing artifact named, and the file truly is absent on disk', async () => {
    // A single node declaring `out/must-exist.md` that its command never writes.
    const g = compile(wf([n('Mutant', [], ['out/must-exist.md'])]));
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-run-'));

    // Run through the REAL pipeline on a non-inmemory backend so the provider-proof gate does NOT fire —
    // the missing on-disk artifact is the SOLE thing the rubric can red on.
    await runWorkflow(g, {
      run: 'mutant',
      outDir,
      provider: new LocalSandboxProvider({ enforceReadScope: false }),
      buildCommand: mutantBuilder(),
    });

    // (a) The rubric CATCHES the no-op: a fresh assessment of the distilled run-view fails.
    const { view } = buildRunView(outDir);
    expect(view.sandbox).toBe('local'); // real backend ran — NOT rejected as inmemory
    const assessment = assessRunView(view, { expectNodes: ['mutant'] });
    expect(assessment.pass).toBe(false);

    // (b) A failure line NAMES the missing artifact (not a generic "something failed").
    expect(assessment.failures.join(' ')).toContain('out/must-exist.md');
    expect(assessment.failures.join(' ')).toMatch(/missing/i);

    // (c) INDEPENDENT probe — a fresh host-disk check confirms the deliverable truly never landed
    // (different code path than the runner's artifactState the rubric read).
    expect(existsSync(path.resolve(outDir, 'out/must-exist.md'))).toBe(false);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
