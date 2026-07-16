// (op-integrity WS-I3) `rec.ops[]` — the per-op execution record (id · exit · durationMs · integrity) that
// the telemetry per-node ops table (`piflowctl telemetry <run> <node>`) projects. Distinct from `opFailures`
// (which only carries FAILING ops): `rec.ops[]` records EVERY dispatched run op, pass or fail, so the table
// shows what actually ran — not just what broke. Both the pi lane (node-lifecycle.ts) and the no-pi
// programmatic lane (node-lanes.ts) must populate it identically (the OKF DRIFT NOTE: the parallel run-op
// loops move together).

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/types.js';

const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-ops-table-'));

describe('rec.ops[] — every dispatched run op recorded (programmatic lane)', () => {
  it('records id + exit(0) + a numeric durationMs for a clean run op, with NO integrity when no expect is declared', async () => {
    const node: NodeIntent = {
      label: 'gen',
      programmatic: true,
      tools: {},
      io: { reads: ['src.json'], produces: ['out.json'], externalInputs: ['src.json'], artifacts: [{ path: 'out.json' }] },
      op: [
        { when: 'pre', writes: ['out.json'], transform: { kind: 'seed', from: '{{RUN}}/src.json' } },
        { id: 'gen-txt', when: 'post', writes: ['gen.txt'], run: { cmd: 'node', args: ['-e', "require('fs').writeFileSync('gen.txt','hi')"], cwd: '{{RUN}}' } },
      ],
    };
    const outDir = await tmpOut();
    await fs.writeFile(path.join(outDir, 'src.json'), '{"v":1}');
    const { status } = await runWorkflow(compile(wf([node])), { run: 'ops-clean', outDir });
    const rec = status.nodes.gen;
    expect(rec.status).toBe('ok');
    expect(rec.ops).toHaveLength(1);
    const [op] = rec.ops!;
    expect(op.id).toBe('gen-txt');
    expect(op.exit).toBe(0);
    expect(typeof op.durationMs).toBe('number');
    expect(op.durationMs).toBeGreaterThanOrEqual(0);
    expect(op.integrity).toBeUndefined(); // no `expect` declared on this op ⇒ no integrity to report
  });

  it('records EVERY op in order (2 ops), even though only one fails', async () => {
    const node: NodeIntent = {
      label: 'multi',
      programmatic: true,
      tools: {},
      io: { reads: ['src.json'], produces: ['out.json'], externalInputs: ['src.json'], artifacts: [{ path: 'out.json' }] },
      op: [
        { when: 'pre', writes: ['out.json'], transform: { kind: 'seed', from: '{{RUN}}/src.json' } },
        { id: 'ok-op', when: 'post', writes: ['a.txt'], run: { cmd: 'node', args: ['-e', "require('fs').writeFileSync('a.txt','x')"], cwd: '{{RUN}}' } },
        { id: 'fail-op', when: 'post', onFailure: 'warn', writes: ['b.txt'], run: { cmd: 'node', args: ['-e', 'process.exit(1)'], cwd: '{{RUN}}' } },
      ],
    };
    const outDir = await tmpOut();
    await fs.writeFile(path.join(outDir, 'src.json'), '{"v":1}');
    const { status } = await runWorkflow(compile(wf([node])), { run: 'ops-multi', outDir });
    const rec = status.nodes.multi;
    expect(rec.ops).toHaveLength(2);
    expect(rec.ops!.map((o) => o.id)).toEqual(['ok-op', 'fail-op']);
    expect(rec.ops!.find((o) => o.id === 'ok-op')?.exit).toBe(0);
    expect(rec.ops!.find((o) => o.id === 'fail-op')?.exit).toBe(1);
  });

  it('carries the per-op integrity verdicts (pass AND fail) when the op declares `expect`', async () => {
    const node: NodeIntent = {
      label: 'checked',
      programmatic: true,
      tools: {},
      io: { reads: ['src.json'], produces: ['out.json'], externalInputs: ['src.json'], artifacts: [{ path: 'out.json' }] },
      op: [
        { when: 'pre', writes: ['out.json'], transform: { kind: 'seed', from: '{{RUN}}/src.json' } },
        {
          id: 'stage',
          when: 'post',
          writes: ['gen.txt'],
          run: { cmd: 'node', args: ['-e', "require('fs').writeFileSync('gen.txt','x'.repeat(10))"], cwd: '{{RUN}}' },
          expect: [{ kind: 'min-bytes', path: 'gen.txt', param: 100 }],
        },
      ],
    };
    const outDir = await tmpOut();
    await fs.writeFile(path.join(outDir, 'src.json'), '{"v":1}');
    const { status } = await runWorkflow(compile(wf([node])), { run: 'ops-integrity', outDir });
    const rec = status.nodes.checked;
    expect(rec.ops).toHaveLength(1);
    const [op] = rec.ops!;
    expect(op.integrity).toEqual([{ kind: 'min-bytes', ok: false, detail: expect.stringContaining('gen.txt') }]);
  });

  it('is ABSENT when the node runs no dispatched run op (the minimal-record rule)', async () => {
    const node: NodeIntent = {
      label: 'plain',
      programmatic: true,
      tools: {},
      io: { reads: ['src.json'], produces: ['out.json'], externalInputs: ['src.json'], artifacts: [{ path: 'out.json' }] },
      op: [{ when: 'pre', writes: ['out.json'], transform: { kind: 'seed', from: '{{RUN}}/src.json' } }],
    };
    const outDir = await tmpOut();
    await fs.writeFile(path.join(outDir, 'src.json'), '{"v":1}');
    const { status } = await runWorkflow(compile(wf([node])), { run: 'ops-none', outDir });
    expect(status.nodes.plain.ops).toBeUndefined();
  });
});
