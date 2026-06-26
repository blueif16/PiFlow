import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import type { NodeIntent, WorkflowSpec, Policy } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';

// ── M4 · #15 — `stop` is a DOCUMENTED ALIAS of `block` (design §2.4 option B) ────────────────────────
// NOT a "stop drains while block doesn't" theater test (that would PASS on the unmodified runner — both
// already drain via Promise.all, runner.ts:1543, and halt at :1589). Instead a DISCRIMINATING EQUIVALENCE:
// run the SAME 2-node stage (one node fails on a blocking check, one clean sibling) under `policy.fail:
// 'block'` and under `policy.fail:'stop'`, and assert the two runs produce the IDENTICAL halt verdict, the
// IDENTICAL failed-node status, AND the IDENTICAL sibling-completion set. It fails ONLY if someone mistakenly
// gives `stop` a distinct mid-stage abort (which would break additivity for every existing block template).

function n(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return { label, prompt: `do ${label}`, tools: {}, io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) }, ...over };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-stopblock-'));

/** A builder that writes the EXACT bytes for each artifact (so a check can pass/fail deterministically). */
function contentBuilder(contentFor: (id: string) => Record<string, string>) {
  return (node: { id: string; sandbox: { output: string } }): string => {
    const out = node.sandbox.output;
    const writes = Object.entries(contentFor(node.id))
      .map(([p, c]) => {
        const dest = `${out}/${p}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' '${c}' > ${dest}`;
      })
      .join(' && ');
    return writes || 'true';
  };
}

// One stage, two independent lanes: `Bad` fails a json-parses check; `Good` is clean. The check's
// consequence is the variable under test (`block` vs `stop`).
function buildSpec(failPolicy: Policy['fail']): WorkflowSpec {
  const bad = n('Bad', [], ['bad.json'], {
    io: {
      reads: [], produces: ['bad.json'], artifacts: [{ path: 'bad.json' }],
      checks: [{ kind: 'json-parses', path: 'bad.json' }],
      policy: { fail: failPolicy },
    },
  });
  const good = n('Good', [], ['good.txt']);
  return wf([bad, good]);
}

const builder = contentBuilder((id) => (id === 'bad' ? { 'bad.json': 'NOT JSON {{' } : { 'good.txt': 'ok' }));

/** A comparable digest of a run: the halt verdict + each node's terminal status. */
async function runDigest(failPolicy: Policy['fail']): Promise<{ ok: boolean | null; bad: string; good: string }> {
  const outDir = await tmpOut();
  const { status } = await runWorkflow(compile(buildSpec(failPolicy)), { run: `sb-${failPolicy}`, outDir, buildCommand: builder });
  const digest = { ok: status.ok, bad: status.nodes.bad.status, good: status.nodes.good.status };
  await fs.rm(outDir, { recursive: true, force: true });
  return digest;
}

describe('#15 — stop is a documented alias of block (identical halt + sibling-completion set)', () => {
  it('block and stop produce the IDENTICAL halt verdict, failed-node status, and sibling completion', async () => {
    const blockRun = await runDigest('block');
    const stopRun = await runDigest('stop');

    // The discriminating equivalence: byte-for-byte the same outcome.
    expect(stopRun).toEqual(blockRun);

    // And concretely (so a vacuous {==} can't pass): both HALT, the bad node blocks, the sibling DRAINS ok.
    expect(blockRun.ok).toBe(false);
    expect(blockRun.bad).toBe('blocked');
    expect(blockRun.good).toBe('ok'); // same-stage sibling completes under BOTH — no mid-stage abort
    expect(stopRun.good).toBe('ok');
  });
});
