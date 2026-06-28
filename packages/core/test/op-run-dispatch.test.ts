// (op⊖ops · C2/B-fix) The op[] gate/run readers were inlined + byte-duplicated across the runner's two lanes
// (programmatic + pi), and a `run` op the runner had no executor for (when:'pre'/'on-failure', the {fn}
// variant, a cmd-less body) was SILENTLY `continue`-skipped. These tests pin the two extracted adapters
// (`gatesFromOp`/`runOpsFromOp`) AND the runtime fail-loud: a non-dispatchable run op now surfaces as an op
// failure instead of vanishing.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, gatesFromOp, runOpsFromOp } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';

const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-oprun-'));

describe('runOpsFromOp — partition top-level run ops into dispatchable vs rejected', () => {
  it('post/always/undefined-when cmd bodies are runnable; pre/on-failure/{fn}/cmd-less are rejected', () => {
    const { runnable, rejected } = runOpsFromOp([
      { when: 'post', run: { cmd: 'a', args: ['x'] } },
      { run: { cmd: 'b' } }, // undefined `when` defaults to post ⇒ runnable
      { when: 'always', run: { cmd: 'c' } },
      { when: 'on-success', run: { cmd: 'd' } },
      { when: 'pre', run: { cmd: 'e' } }, // REJECTED — there is no pre-run executor
      { when: 'on-failure', run: { cmd: 'f' } }, // REJECTED — there is no on-failure-run executor
      { run: { fn: 'g' } }, // REJECTED — the {fn} variant is unsupported
      { transform: { kind: 'seed', from: 'x' } }, // not a run op ⇒ ignored
      { when: 'post', gate: { kind: 'non-empty' } }, // not a run op ⇒ ignored
    ]);
    expect(runnable.map((r) => r.body.cmd)).toEqual(['a', 'b', 'c', 'd']);
    expect(runnable[0].body.args).toEqual(['x']);
    expect(rejected).toHaveLength(3);
    const detail = rejected.map((r) => r.detail).join('\n');
    expect(detail).toMatch(/when:'pre'/);
    expect(detail).toMatch(/when:'on-failure'/);
    expect(detail).toMatch(/\{fn/);
    // every rejected op defaults to a BLOCKING consequence (fail-loud, not a warn).
    expect(rejected.every((r) => r.onFailure === 'block')).toBe(true);
  });
});

describe('gatesFromOp — partition gate ops by firing lane (pre vs post)', () => {
  it('pre = when:pre gates; post = every other gate; advisory ⇒ warn; non-gate ops ignored', () => {
    const { pre, post } = gatesFromOp([
      { when: 'pre', gate: { kind: 'json-parses', path: 'in.json' } },
      { when: 'post', gate: { kind: 'non-empty', path: 'out.json' } },
      { gate: { kind: 'exists', path: 'x', advisory: true } }, // undefined when ⇒ post lane; advisory ⇒ warn
      { when: 'post', gate: { kind: 'regex-absent', path: 'y' }, onFailure: 'warn' }, // onFailure warn ⇒ warn
      { transform: { kind: 'seed', from: 'x' } }, // not a gate ⇒ ignored
    ]);
    expect(pre).toEqual([{ kind: 'json-parses', path: 'in.json', severity: 'fail' }]);
    expect(post).toEqual([
      { kind: 'non-empty', path: 'out.json', severity: 'fail' },
      { kind: 'exists', path: 'x', severity: 'warn' },
      { kind: 'regex-absent', path: 'y', severity: 'warn' },
    ]);
  });
});

describe('run fail-loud — a non-dispatchable run op blocks the node instead of silently no-op-ing (B-fix)', () => {
  it('a {when:pre} run op surfaces an op failure; the same node WITHOUT it runs ok', async () => {
    // A programmatic node whose declared artifact is produced by a valid PRE seed — so a present artifact can
    // never mask the op failure. The ONLY thing separating the two cases is the extra rejected pre-run op.
    const mkNode = (withBadRun: boolean): NodeIntent => ({
      label: 'gen',
      programmatic: true,
      tools: {},
      io: {
        reads: ['src.json'],
        produces: ['out.json'],
        externalInputs: ['src.json'],
        artifacts: [{ path: 'out.json' }],
      },
      op: [
        { when: 'pre', writes: ['out.json'], transform: { kind: 'seed', from: '{{RUN}}/src.json' } },
        ...(withBadRun ? [{ when: 'pre' as const, run: { cmd: 'true' } }] : []),
      ],
    });

    // CONTROL: seed only → artifact present, no rejected op → ok.
    const okOut = await tmpOut();
    await fs.writeFile(path.join(okOut, 'src.json'), '{"v":1}');
    const okRun = await runWorkflow(compile(wf([mkNode(false)])), { run: 'ok', outDir: okOut });
    expect(okRun.status.nodes.gen.status, 'seed-only programmatic node is ok').toBe('ok');

    // FAIL-LOUD: same node + a {when:pre} run op the runner cannot dispatch → blocked on the op failure.
    // (Pre-fix this run op was silently `continue`-skipped, so the node would be 'ok' — RED for the right reason.)
    const badOut = await tmpOut();
    await fs.writeFile(path.join(badOut, 'src.json'), '{"v":1}');
    const badRun = await runWorkflow(compile(wf([mkNode(true)])), { run: 'bad', outDir: badOut });
    const rec = badRun.status.nodes.gen;
    expect(rec.status, 'a non-dispatchable run op must block the node, not vanish').toBe('blocked');
    expect((rec.issues ?? []).join(' '), 'the block names the undispatchable run op').toMatch(/run op .*has no executor/);
  });
});
