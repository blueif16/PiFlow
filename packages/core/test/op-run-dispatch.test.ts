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
import { mergeFailureDetail } from '../src/runner/op-dispatch.js';
import { runWorkflow } from '../src/runner/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import type { MergeResult } from '../src/index.js';

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

describe('mergeFailureDetail — the SINGLE merge-op-failure detail construction (was duplicated at node-lifecycle.ts + node-lanes.ts)', () => {
  // Live gap (run 260715-01, gameplay): a failing merge `run` op's captured stderr was empty (the check script
  // reported its verdict on stdout), so the detail rendered as the causeless "merge run failed (exit 1)" — the
  // gate's real verdict text never rode. mergeFailureDetail prefers stderr, falls back to stdout, and always
  // keeps today's short form when there is no output at all.
  const base: MergeResult = { op: 'run', wrote: false, failed: true };

  it('stdout-only output (stderr empty) lands in the detail', () => {
    const r: MergeResult = { ...base, exit: 1, stdout: 'capability-refs: bad id at mechanics[4]' };
    expect(mergeFailureDetail(r)).toBe('merge run failed (exit 1): capability-refs: bad id at mechanics[4]');
  });

  it('stderr takes precedence over stdout when both are present', () => {
    const r: MergeResult = { ...base, exit: 1, stderr: 'the real error', stdout: 'noise on stdout' };
    expect(mergeFailureDetail(r)).toBe('merge run failed (exit 1): the real error');
  });

  it('no output at all keeps today\'s short form (no trailing colon segment)', () => {
    const r: MergeResult = { ...base, exit: 1 };
    expect(mergeFailureDetail(r)).toBe('merge run failed (exit 1)');
  });

  it('a spawn error (skipped, no exit/stderr/stdout) still surfaces via `skipped`', () => {
    const r: MergeResult = { ...base, skipped: 'spawn error: ENOENT' };
    expect(mergeFailureDetail(r)).toBe('merge run failed: spawn error: ENOENT');
  });

  it('caps the embedded output at ~600 chars — a runaway script cannot blow out the digest', () => {
    const long = 'x'.repeat(1000);
    const r: MergeResult = { ...base, exit: 1, stdout: long };
    const detail = mergeFailureDetail(r);
    expect(detail.length).toBeLessThan(650);
    expect(detail).not.toContain(long); // the full 1000-char run must NOT ride verbatim
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
    // (A1) The op failure rides the DEDICATED TYPED `opFailures` channel — NOT the `issues[]` string (op has
    // nothing to do with the issue system). The undispatchable run op's detail is recorded there, absent from issues[].
    expect((rec.opFailures ?? []).map((f) => f.detail).join(' '), 'the typed channel names the undispatchable run op').toMatch(/run op .*has no executor/);
    expect((rec.issues ?? []).join(' '), 'op failures never leak into issues[]').not.toMatch(/run op .*has no executor/);
  });
});

describe('run op spawn error — the errno surfaces in the op-failure detail (not a causeless "failed")', () => {
  it('a post run op whose cmd cannot spawn reports the spawn error message on the typed opFailures channel', async () => {
    // A programmatic node whose artifact is produced by a valid PRE seed, plus a POST run op with a
    // nonexistent cmd: spawnSync sets res.error (ENOENT) — the merge executor reports that in `skipped`
    // (no exit, no stderr). Pre-fix the detail rendered only exit/stderr, so the op detail read a causeless
    // "run <cmd> failed" (live: w3a's freeze-check on count-three-e2e-1). RED without the skipped field.
    // (A1) The op-failure detail now rides the DEDICATED TYPED `opFailures` channel, never `issues[]`.
    const node: NodeIntent = {
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
        { when: 'post', run: { cmd: 'definitely-not-a-real-command-8f3a' }, onFailure: 'block' },
      ],
    };
    const outDir = await tmpOut();
    await fs.writeFile(path.join(outDir, 'src.json'), '{"v":1}');
    const { status } = await runWorkflow(compile(wf([node])), { run: 'spawnerr', outDir });
    const rec = status.nodes.gen;
    expect(rec.status, 'a spawn-failing blocking run op must block the node').toBe('blocked');
    expect((rec.opFailures ?? []).map((f) => f.detail).join(' '), 'the typed op detail must carry the spawn error, not a bare "failed"').toMatch(
      /spawn error|ENOENT/,
    );
    expect((rec.issues ?? []).join(' '), 'op failures never leak into issues[]').not.toMatch(/spawn error|ENOENT/);
  });
});

describe('merge run-op failure detail (programmatic lane) — the STDOUT verdict rides, not a bare "failed"', () => {
  it('a failing merge `run` sub-op whose script reports on stdout (not stderr) lands that text in opFailures[].detail', async () => {
    // Live gap (run 260715-01, gameplay): rec.opFailures details were exactly "merge run failed (exit 1)" —
    // empty stderr — because the check script's real verdict rode stdout, which node-lanes.ts's merge-op-failure
    // detail construction never read. RED before the fix: the detail contains only the causeless "failed" text.
    const node: NodeIntent = {
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
        { when: 'post', transform: { kind: 'merge', ops: [{ run: { cmd: 'node', args: ['-e', "console.log('capability-refs: bad id at mechanics[4]'); process.exit(1)"] } }] } },
      ],
    };
    const outDir = await tmpOut();
    await fs.writeFile(path.join(outDir, 'src.json'), '{"v":1}');
    const { status } = await runWorkflow(compile(wf([node])), { run: 'mergestdoutprog', outDir });
    const rec = status.nodes.gen;
    expect(rec.status, 'a failing merge run op defaults to onFailure:block').toBe('blocked');
    expect(
      (rec.opFailures ?? []).map((f) => f.detail).join(' '),
      'the gate\'s own stdout verdict must ride the op-failure detail',
    ).toContain('capability-refs: bad id at mechanics[4]');
  });
});

describe('run op token resolution — {{RUN}}/{{WORKSPACE}} in cmd/args/cwd resolve at dispatch', () => {
  it('a post run op with a tokened cwd executes there instead of ENOENT-ing on the literal token path', async () => {
    // merge ops (node-lifecycle resolveDeep at the merges loop) and promotes resolve their specs at dispatch;
    // the run-op dispatch passed body.{cmd,args,cwd} RAW, so a cwd of "{{RUN}}" joined literally under the
    // project base — a nonexistent dir — and spawnSync reported ENOENT (live: w3a's freeze-check op, whose
    // cwd is {{WORKSPACE}}/remotion-svg-primitives, on count-three-e2e-1). RED without the dispatch resolve.
    const node: NodeIntent = {
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
        // `node -e` writes proof.txt into its cwd — the file lands in outDir ONLY if {{RUN}} resolved.
        {
          when: 'post',
          run: { cmd: 'node', args: ['-e', "require('fs').writeFileSync('proof.txt','ran')"], cwd: '{{RUN}}' },
          onFailure: 'block',
        },
      ],
    };
    const outDir = await tmpOut();
    await fs.writeFile(path.join(outDir, 'src.json'), '{"v":1}');
    const { status } = await runWorkflow(compile(wf([node])), { run: 'runtok', outDir });
    expect(status.nodes.gen.status, 'the tokened-cwd run op must execute, not block').toBe('ok');
    const proof = await fs.readFile(path.join(outDir, 'proof.txt'), 'utf8');
    expect(proof, 'the op ran in the RESOLVED cwd').toBe('ran');
  });
});
