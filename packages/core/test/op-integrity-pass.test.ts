// (op-integrity WS-I1) opIntegrityFailures — the pure integrity pass both runner lanes call. It evaluates
// each op's `expect` post-conditions over its writes and returns ONE entry per op with ≥1 FAILING expectation
// (a fully-passing op is silent), tagging the consequence with the op's onFailure DEFAULTING TO warn. These
// assert the ORCHESTRATION (path fan-out, silent-on-pass, warn-vs-block consequence, the integrity[] shape,
// schemaPath resolution) — the predicates themselves are proven in checks.test.ts.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { opIntegrityFailures, type FileBytes } from '../src/checks.js';
import { compile } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';
import type { OpSpec, NodeIntent, WorkflowSpec } from '../src/types.js';

const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-integ-'));

/** A reader fake: serve canned bytes per path; an unknown path reads as absent. */
function reader(files: Record<string, string>): (p: string) => FileBytes {
  return (p) => (p in files ? { bytes: files[p], size: Buffer.byteLength(files[p]) } : { bytes: null, size: 0 });
}

describe('opIntegrityFailures — the integrity pass over op.expect', () => {
  it('is SILENT when every expectation passes (no entry for a clean op)', () => {
    const ops: OpSpec[] = [
      { id: 'stage', when: 'pre', writes: ['persona.md'], expect: [{ kind: 'min-bytes', path: 'persona.md', param: 5 }] },
    ];
    expect(opIntegrityFailures(ops, reader({ 'persona.md': 'plenty of bytes here' }))).toEqual([]);
  });

  it('records ONE entry for a failing expect, default consequence warn, with the integrity verdicts', () => {
    const ops: OpSpec[] = [
      { id: 'stage', when: 'pre', writes: ['persona.md'], expect: [{ kind: 'min-bytes', path: 'persona.md', param: 200000 }] },
    ];
    const out = opIntegrityFailures(ops, reader({ 'persona.md': '' }));
    expect(out).toHaveLength(1);
    expect(out[0].onFailure).toBe('warn'); // default consequence is warn, NOT block
    expect(out[0].detail).toContain('stage'); // the op id
    expect(out[0].detail).toContain('min-bytes'); // the integrity kind (not the aliased CHECK_KIND 'non-empty')
    expect(out[0].detail).toContain('persona.md');
    expect(out[0].integrity).toEqual([{ kind: 'min-bytes', ok: false, detail: expect.stringContaining('persona.md') }]);
  });

  it('an author-set onFailure:block makes the SAME violation block-consequenced', () => {
    const ops: OpSpec[] = [
      { id: 's', writes: ['p.md'], onFailure: 'block', expect: [{ kind: 'min-bytes', path: 'p.md', param: 100 }] },
    ];
    expect(opIntegrityFailures(ops, reader({ 'p.md': 'tiny' }))[0].onFailure).toBe('block');
  });

  it('an expectation with NO path fans out over the op writes (each is checked)', () => {
    const ops: OpSpec[] = [{ id: 'g', writes: ['a.json', 'b.json'], expect: [{ kind: 'json-parses' }] }];
    const out = opIntegrityFailures(ops, reader({ 'a.json': '{"ok":true}', 'b.json': 'NOT JSON' }));
    expect(out).toHaveLength(1);
    // both writes were evaluated; a.json passes, b.json fails — the failing one is named in detail.
    expect(out[0].integrity).toHaveLength(2);
    expect(out[0].integrity.find((v) => v.detail.includes('a.json'))?.ok).toBe(true);
    expect(out[0].integrity.find((v) => v.detail.includes('b.json'))?.ok).toBe(false);
    expect(out[0].detail).toContain('b.json');
    expect(out[0].detail).not.toContain('a.json'); // detail summarizes FAILING only
  });

  it('a structured predicate (json-pointer-exists over a manifest) catches a vanished LOAD-BEARING block', () => {
    const ops: OpSpec[] = [
      {
        id: 'plan',
        writes: ['persona.md'],
        resultFile: 'persona.manifest.json',
        expect: [{ kind: 'json-pointer-exists', path: 'persona.manifest.json', param: { pointer: '/required_kp_ids' } }],
      },
    ];
    // the cache-empty run: the manifest exists but the required block is an EMPTY array — a silent corruption.
    const out = opIntegrityFailures(ops, reader({ 'persona.manifest.json': '{"required_kp_ids":[]}' }));
    expect(out).toHaveLength(1);
    expect(out[0].integrity[0]).toMatchObject({ kind: 'json-pointer-exists', ok: false });
  });

  it('json-schema resolves a param.schemaPath via the SAME reader before validating', () => {
    const validate = (schema: object, data: unknown) => {
      const req = (schema as { required?: string[] }).required ?? [];
      const obj = (data ?? {}) as Record<string, unknown>;
      const missing = req.filter((k) => !(k in obj));
      return { ok: missing.length === 0, errors: missing };
    };
    const ops: OpSpec[] = [
      { id: 'v', writes: ['ledger.json'], expect: [{ kind: 'json-schema', path: 'ledger.json', param: { schemaPath: 'ledger.schema.json' } }] },
    ];
    const files = { 'ledger.json': '{}', 'ledger.schema.json': '{"type":"object","required":["ok"]}' };
    const out = opIntegrityFailures(ops, reader(files), { validate });
    expect(out).toHaveLength(1); // the ledger lacks the required `ok` → schema violation
    expect(out[0].integrity[0]).toMatchObject({ kind: 'json-schema', ok: false });
    // and a conforming ledger is silent
    expect(opIntegrityFailures(ops, reader({ ...files, 'ledger.json': '{"ok":true}' }), { validate })).toEqual([]);
  });

  it('ignores ops with no expect (a body-only op is untouched)', () => {
    const ops: OpSpec[] = [{ id: 'r', when: 'post', run: { cmd: 'gen' } }];
    expect(opIntegrityFailures(ops, reader({}))).toEqual([]);
    expect(opIntegrityFailures(undefined, reader({}))).toEqual([]);
  });
});

// (op-integrity WS-I1) The pass wired into the runner LANE — a programmatic node runs its op[] through
// node-lanes.ts (which mirrors node-lifecycle.ts). These prove the three lane behaviors the design pins:
// expect-pass is silent; an expect-fail at the default `warn` records evidence but the node stays ok; an
// author-set onFailure:'block' blocks the node with the integrity label carried on opFailures, NOT issues[].
describe('op-integrity pass wired into the runner (programmatic lane, end-to-end)', () => {
  // A programmatic node: a PRE seed produces the required artifact `out.json`, and a POST run op writes
  // `gen.txt` with a size controlled by `bytes`, carrying an `expect` min-bytes floor of 100. Structuring it
  // this way means the artifact contract is ALWAYS satisfied — the ONLY thing the integrity floor changes.
  const mkNode = (bytes: number, onFailure?: 'warn' | 'block'): NodeIntent => ({
    label: 'gen',
    programmatic: true,
    tools: {},
    io: { reads: ['src.json'], produces: ['out.json'], externalInputs: ['src.json'], artifacts: [{ path: 'out.json' }] },
    op: [
      { when: 'pre', writes: ['out.json'], transform: { kind: 'seed', from: '{{RUN}}/src.json' } },
      {
        id: 'stage',
        when: 'post',
        writes: ['gen.txt'],
        run: { cmd: 'node', args: ['-e', `require('fs').writeFileSync('gen.txt','x'.repeat(${bytes}))`], cwd: '{{RUN}}' },
        ...(onFailure ? { onFailure } : {}),
        expect: [{ kind: 'min-bytes', path: 'gen.txt', param: 100 }],
      },
    ],
  });

  const run = async (node: NodeIntent, id: string) => {
    const outDir = await tmpOut();
    await fs.writeFile(path.join(outDir, 'src.json'), '{"v":1}');
    const { status } = await runWorkflow(compile(wf([node])), { run: id, outDir });
    return status.nodes.gen;
  };

  it('expect-PASS is silent — a satisfied floor leaves the node ok and records no opFailure', async () => {
    const rec = await run(mkNode(500), 'pass');
    expect(rec.status).toBe('ok');
    expect(rec.opFailures ?? []).toEqual([]);
  });

  it('expect-FAIL at the default warn — the node STAYS ok, but the integrity evidence is recorded', async () => {
    const rec = await run(mkNode(10), 'warn'); // 10 < 100 → min-bytes fails, default consequence warn
    expect(rec.status, 'a warn integrity violation does not block').toBe('ok');
    const detail = (rec.opFailures ?? []).map((f) => f.detail).join(' ');
    expect(detail, 'the integrity label is recorded on the typed channel').toMatch(/integrity — min-bytes.*gen\.txt/);
    // the structured verdicts ride the new `integrity` field, not just a string.
    expect((rec.opFailures ?? [])[0]?.integrity?.[0]).toMatchObject({ kind: 'min-bytes', ok: false });
    expect((rec.issues ?? []).join(' '), 'integrity evidence never leaks into issues[]').not.toMatch(/integrity — min-bytes/);
  });

  it('expect-FAIL with onFailure:block — the node BLOCKS with the integrity label (not a stderr line)', async () => {
    const rec = await run(mkNode(10, 'block'), 'block');
    expect(rec.status, 'a block integrity violation fails the node').toBe('blocked');
    const detail = (rec.opFailures ?? []).map((f) => f.detail).join(' ');
    expect(detail).toMatch(/integrity — min-bytes/);
    expect(detail, 'the reason is the integrity label, NOT a run/stderr failure line').not.toMatch(/run .* failed|exit \d/);
    expect((rec.issues ?? []).join(' '), 'op integrity stays out of the issue system').not.toMatch(/integrity — min-bytes/);
  });
});
