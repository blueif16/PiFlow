// (op-integrity WS-I2) The verdict-vs-stderr fix. When an op declares a `resultFile` (a structured verdict,
// by convention a JSON ledger/manifest) and the op FAILS, the runner builds the op-failure `detail` from THAT
// file's content — the gate's real verdict — instead of the first stderr line. `distillResultFile` is the pure
// distiller; the end-to-end test proves it is wired into the run-op failure push (the ledger verdict rides the
// opFailures channel, not the stderr WARNING).

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distillResultFile } from '../src/checks.js';
import { compile } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/types.js';

const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-resultfile-'));

describe('distillResultFile — the ledger distiller', () => {
  it('surfaces the top verdict + the FAILING check entries (not the passing ones)', () => {
    const ledger = JSON.stringify({
      ok: false,
      checks: [
        { name: 'kp-coverage', ok: false, detail: 'required_kp_ids empty (0 of 7)' },
        { name: 'schema', ok: true, detail: 'valid' },
      ],
    });
    const d = distillResultFile('ledger/verify/output.json', ledger);
    expect(d).toContain('ledger/verify/output.json');
    expect(d).toContain('kp-coverage'); // the failing check named
    expect(d).toContain('required_kp_ids empty (0 of 7)'); // its verdict detail
    expect(d).toContain('false'); // the top-level ok=false
    expect(d).not.toContain('schema'); // a PASSING check is not noise in the failure detail
  });

  it('surfaces a bare top-level verdict when there is no checks array', () => {
    const d = distillResultFile('r.json', JSON.stringify({ ok: false, note: 'gate refused' }));
    expect(d).toContain('false');
  });

  it('degrades to a labelled fallback on unparseable JSON or a missing file (never throws)', () => {
    expect(distillResultFile('r.json', '{not json')).toMatch(/r\.json.*unparseable/);
    expect(distillResultFile('r.json', null)).toMatch(/r\.json.*missing/);
  });
});

describe('op resultFile wired into the runner — the ledger verdict rides opFailures, not stderr (WS-I2)', () => {
  // A programmatic node whose POST run op emits a JSON ledger AND writes stderr NOISE AND exits nonzero, with
  // resultFile pointing at the ledger. Pre-WS-I2 the op-failure detail was the stderr line; now it is the
  // ledger's verdict. onFailure:block so the node blocks and the reason is inspectable on the record.
  it('a failing op with a resultFile records the ledger verdict as detail, never the stderr WARNING', async () => {
    const ledger = JSON.stringify({ ok: false, checks: [{ name: 'kp-coverage', ok: false, detail: 'required_kp_ids empty' }] });
    const node: NodeIntent = {
      label: 'gate',
      programmatic: true,
      tools: {},
      io: { reads: ['src.json'], produces: ['out.json'], externalInputs: ['src.json'], artifacts: [{ path: 'out.json' }] },
      op: [
        { when: 'pre', writes: ['out.json'], transform: { kind: 'seed', from: '{{RUN}}/src.json' } },
        {
          id: 'verify',
          when: 'post',
          writes: ['ledger.json'],
          resultFile: 'ledger.json',
          onFailure: 'block',
          run: {
            cmd: 'node',
            args: ['-e', `require('fs').writeFileSync('ledger.json', ${JSON.stringify(ledger)}); process.stderr.write('[kp_cache] MCP client unavailable'); process.exit(1)`],
            cwd: '{{RUN}}',
          },
        },
      ],
    };
    const outDir = await tmpOut();
    await fs.writeFile(path.join(outDir, 'src.json'), '{"v":1}');
    const { status } = await runWorkflow(compile(wf([node])), { run: 'ledger', outDir });
    const rec = status.nodes.gate;
    expect(rec.status, 'a blocking run op with a failing ledger blocks the node').toBe('blocked');
    const fail = (rec.opFailures ?? [])[0];
    expect(fail?.detail, 'the detail carries the LEDGER verdict').toMatch(/kp-coverage.*required_kp_ids empty/);
    expect(fail?.detail, 'the detail is NOT the stderr WARNING').not.toMatch(/MCP client unavailable/);
    expect(fail?.resultFile, 'the raw resultFile path rides the envelope for verbs to open').toBe('ledger.json');
    expect((rec.issues ?? []).join(' '), 'op failures never leak into issues[]').not.toMatch(/kp-coverage|MCP client/);
  });
});
