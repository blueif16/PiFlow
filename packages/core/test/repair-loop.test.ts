import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import type { NodeIntent, WorkflowSpec, NodeSpec } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';

// ── G8 fold (composed in M4) — the SCHEMA failure-class lane is a bounded IN-SANDBOX repair BEFORE any ──
// full re-run. A repair is NOT a retry: it re-prompts the still-alive sandbox from {previousOutput,
// ajvErrors, schema}, reusing the node's ONE slot. THIS test is the discriminating one (g8 spec §"Test
// strategy" #1): with maxRepairAttempts:1, retries:0 and a STATEFUL builder (bad on call 1, good on call
// 2), the builder is called TWICE INSIDE one runNode, the node ends ok via rec.repairAttempts===1, and the
// retry budget stays UNTOUCHED (the schema class took the cheap lane before any full re-seed). Model-free.

function n(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return { label, prompt: `do ${label}`, tools: {}, io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) }, ...over };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-repair-'));

// A zero-artifact node whose structured RETURN is its only output ⇒ returnMode 'required' and the
// return-schema gate is the SOLE block reason on a miss (the clean schema-only-breach trigger).
const RETURN_SCHEMA = {
  type: 'object',
  required: ['status', 'summary'],
  properties: { status: { type: 'string', enum: ['ok', 'gap', 'blocked'] }, summary: { type: 'string', minLength: 1 } },
} as const;

describe('G8 — schema miss repairs IN-SANDBOX in ONE runNode (no full re-run, retry budget untouched)', () => {
  it('bad-then-good: builder called twice inside one runNode, ends ok, repairAttempts===1', async () => {
    const node = n('Gate', [], [], {
      io: { reads: [], produces: [], artifacts: [], returnSchema: RETURN_SCHEMA, maxRepairAttempts: 1, retries: 0 },
    });
    const g = compile(wf([node]));
    const outDir = await tmpOut();

    // STATEFUL stub: call 1 emits a SCHEMA-VIOLATING return (bad enum + missing `summary`); call 2 (the
    // repair turn, in the SAME live sandbox) emits a CONFORMING return. Count every builder invocation.
    let calls = 0;
    const builder = (_node: NodeSpec & { sandbox: { output: string } }): string => {
      calls++;
      const ret = calls === 1 ? { status: 'totally-wrong' } : { status: 'ok', summary: 'repaired' };
      return `printf '%s' '\`\`\`json\n${JSON.stringify(ret)}\n\`\`\`'`;
    };

    const { status } = await runWorkflow(g, { run: 'repair-bg', outDir, buildCommand: builder as never });

    // The node ended OK because the SECOND (repair) turn produced a conforming result.
    expect(status.nodes.gate.status).toBe('ok');
    // The builder ran TWICE — both INSIDE one runNode (one node, one stage, no full re-run).
    expect(calls).toBe(2);
    // It took exactly ONE repair turn…
    expect(status.nodes.gate.repairAttempts).toBe(1);
    // …and the schema breach is gone.
    expect(status.nodes.gate.returnSchemaInvalid).toBeUndefined();
    // The repair did NOT consume the retry budget (the cheap in-sandbox lane ran before any full re-seed).
    expect(status.nodes.gate.repairExhausted).toBeUndefined();

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('maxRepairAttempts:0 (default) — a schema miss SKIPS the repair lane: blocked, builder once', async () => {
    const node = n('Gate', [], [], {
      io: { reads: [], produces: [], artifacts: [], returnSchema: RETURN_SCHEMA }, // no maxRepairAttempts ⇒ 0
    });
    const g = compile(wf([node]));
    const outDir = await tmpOut();
    let calls = 0;
    const builder = (_node: NodeSpec & { sandbox: { output: string } }): string => {
      calls++;
      return `printf '%s' '\`\`\`json\n${JSON.stringify({ status: 'totally-wrong' })}\n\`\`\`'`;
    };
    const { status } = await runWorkflow(g, { run: 'repair-off', outDir, buildCommand: builder as never });
    // Default off: the schema miss falls straight through to blocked (today's exact behavior), builder once.
    expect(status.nodes.gate.status).toBe('blocked');
    expect(calls).toBe(1);
    expect(status.nodes.gate.repairAttempts).toBeUndefined();
    await fs.rm(outDir, { recursive: true, force: true });
  });
});
