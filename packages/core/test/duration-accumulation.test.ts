import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, InMemorySandboxProvider } from '../src/index.js';
import type { NodeIntent, WorkflowSpec, NodeSpec } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';

// ── TRUTHFUL DURATION BOOKKEEPING (run 260710-02) ─────────────────────────────────────────────────────
// Each runNode call re-stamps rec.startedAt/durationMs to its OWN attempt, so a crashed-then-recovered
// node reported only its final attempt's time — gameplay recorded 1147s of a real 3204s span, w4-m2 512s
// of 1019s — silently hiding the crashed attempts' wall-clock from run.json and every instrument that
// reads it. The retry FSM now re-stamps the terminal record to the node's TRUE span: startedAt = the
// FIRST attempt's start, durationMs = first-attempt-start → completion.
//
// Discriminator: runNode stamps startedAt BEFORE it invokes the builder, so the FIRST attempt's startedAt
// is <= the FIRST builder invocation's wall time. Under the old per-attempt stamping the terminal record
// carried the SECOND attempt's startedAt, which is strictly AFTER the first builder call. So the single
// assertion `startedAt <= firstBuilderCallTs` is red on the bug, green on the fix.

function n(label: string, produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return { label, prompt: `do ${label}`, tools: {}, io: { reads: [], produces, artifacts: produces.map((p) => ({ path: p })) }, ...over };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-dur-accum-'));

describe('truthful duration — a retried node reports its FULL span, not just the winning attempt', () => {
  it('re-stamps startedAt to the first attempt and durationMs to the whole span across retries', async () => {
    const g = compile(
      wf([n('Build', ['out.txt'], { io: { reads: [], produces: ['out.txt'], artifacts: [{ path: 'out.txt' }], retries: 1 } })]),
    );
    const outDir = await tmpOut();

    // Attempt 1 produces NOTHING (contract breach → one same-model retry); attempt 2 produces the artifact.
    // Record the wall time of each builder invocation.
    const callTs: number[] = [];
    const builder = (nodeSpec: NodeSpec & { sandbox: { output: string } }): string => {
      callTs.push(Date.now());
      const out = nodeSpec.sandbox.output;
      if (callTs.length === 1) return 'true'; // attempt 1: no artifact
      return `mkdir -p ${out} && printf '%s' done > ${out}/out.txt`;
    };

    const { status } = await runWorkflow(g, {
      run: 'dur',
      outDir,
      provider: new InMemorySandboxProvider(),
      buildCommand: builder as never,
    });

    const rec = status.nodes.build;
    expect(rec.status).toBe('ok');
    expect(callTs.length).toBe(2); // two attempts really ran

    // THE INVARIANT: the terminal record's startedAt is the FIRST attempt's start (stamped before the
    // first builder call), NOT the second attempt's. Under the old code this equals the second attempt's
    // start (strictly after callTs[0]) and this assertion fails.
    const startedMs = Date.parse(rec.startedAt!);
    expect(startedMs).toBeLessThanOrEqual(callTs[0]);

    // durationMs is the true span (first start → completion), so it reaches at least to the second attempt's
    // builder call — the crashed first attempt's time is INCLUDED, never dropped.
    expect(rec.durationMs!).toBeGreaterThanOrEqual(callTs[1] - startedMs);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
