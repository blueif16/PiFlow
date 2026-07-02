import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compile,
  runWorkflow,
  buildRunView,
  assessRunView,
  InMemorySandboxProvider,
} from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';

// ── Target 8 · N-inmemory LOCK-IN — RUN THE REAL PIPELINE (not a test-option flip). ────────────────
//
// The design's non-hackable claim: `assessRunView` disqualifies an `inmemory` run as PROOF OF
// EXECUTION *even when the run genuinely produced its declared artifact* — because the inmemory
// backend is a no-op-equivalent that proves nothing about a real sandbox. This test runs a REAL
// 1-node `runWorkflow` on `InMemorySandboxProvider` with a builder that DOES write the artifact,
// distils the run-view off disk, and asserts the default rubric still reds — and reds ONLY on the
// backend gate, not on a missing artifact. (docs/design/full-run-e2e-LOCKED.md — Target 8.)

/** A NodeIntent factory (mirrors runner.test / dag.test): reads/produces; artifacts default to produces. */
function n(label: string, reads: string[], produces: string[]): NodeIntent {
  return {
    label,
    prompt: `do ${label}`,
    tools: {},
    io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) },
  };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });

async function tmpOut(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-assess-neg-'));
}

/**
 * A builder that writes EXACT bytes to each declared artifact into the node's sandbox OUTPUT dir at
 * `<output>/<path>` (the convention the runner flattens onto the host run dir), so the artifact
 * GENUINELY lands on host disk — proving the red below is the backend gate, not a missing file.
 */
function contentBuilder(contents: Record<string, string>) {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const out = node.sandbox.output;
    const writes = Object.entries(contents)
      .map(([p, c]) => {
        const dest = `${out}/${p}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' '${c}' > ${dest}`;
      })
      .join(' && ');
    return writes || 'true';
  };
}

describe('assessRunView — N-inmemory lock-in (real inmemory run, artifact present, still reds)', () => {
  it('reds a genuine inmemory run whose artifact IS on disk — ONLY the backend gate disqualifies it', async () => {
    const g = compile(wf([n('Greet', [], ['out/greet/greeting.txt'])]));
    const outDir = await tmpOut();

    // REAL pipeline: inmemory backend, a builder that DOES write the artifact.
    const { status } = await runWorkflow(g, {
      run: 'inmem-neg',
      outDir,
      provider: new InMemorySandboxProvider(),
      buildCommand: contentBuilder({ 'out/greet/greeting.txt': 'CONTROL-VM-OK' }),
    });

    // The run genuinely succeeded and produced the artifact — INDEPENDENT fresh reads of real state:
    // (1) the node reached a good verdict; (2) the file is actually on host disk with the right bytes.
    expect(status.nodes.greet.status).toBe('ok');
    const onDisk = await fs.readFile(path.join(outDir, 'out/greet/greeting.txt'), 'utf8');
    expect(onDisk.trim()).toBe('CONTROL-VM-OK');

    // Distil the run-view off disk and assess with DEFAULT opts (forbidSandbox: ['inmemory']).
    const { view } = buildRunView(outDir);
    expect(view.sandbox).toBe('inmemory'); // the real backend that ran — the thing under judgement
    const a = assessRunView(view, { expectNodes: ['greet'] });

    // The rubric REDS — despite the produced artifact — and reds ONLY on the backend gate.
    expect(a.pass).toBe(false);
    const backendFailure = a.failures.find((f) => /inmemory/i.test(f) && /non-proving/i.test(f));
    expect(backendFailure).toBeDefined();
    // And NOT because the artifact is missing — no failure line names the declared artifact.
    expect(a.failures.some((f) => /greeting\.txt/i.test(f))).toBe(false);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
