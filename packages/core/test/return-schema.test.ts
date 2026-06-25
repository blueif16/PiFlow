import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import { loadTemplate } from '../src/workflow/template/loader.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';

// ── The post-node RETURN-SCHEMA gate — OPT-IN, a CHOICE never forced ───────────────────────────────
// A node's authored `returnSchema` (node.json top-level `return`) constrains the SHAPE of its structured
// result. This proves the loader WIRES it onto NodeIO and the runner ENFORCES it ONLY when the node opts in
// via `returnMode: 'required'` (a non-conforming result BLOCKS, mirroring the artifact schema gate). Under
// 'optional' / the artifact-backed default, the gate is INERT — a filesystem-write node proves its work by
// the file on disk, so its structured return is never validated, never warns, never blocks. The mechanism
// stays available for rigid workflows without forcing it. 100% GENERIC — no domain knowledge.

function n(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return {
    label,
    prompt: `do ${label}`,
    tools: {},
    io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) },
    ...over,
  };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-retschema-'));

/**
 * A builder whose node WRITES each declared artifact and emits the GIVEN return object as a fenced-JSON
 * block on stdout (the handshake the runner parses via `lastJsonBlock`). `ret === null` ⇒ no fence at all.
 * The JSON sits inside shell single-quotes — fine for our test payloads (no single-quote chars).
 */
function returnBuilder(ret: Record<string, unknown> | null) {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => {
        const dest = `${node.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    if (ret === null) return writes || 'true';
    const fence = `printf '%s' '\`\`\`json\\n${JSON.stringify(ret)}\\n\`\`\`'`;
    return writes ? `${writes} && ${fence}` : fence;
  };
}

// A representative GENERIC return schema: requires a string `summary` and a `status` enum. Domain-free.
const RETURN_SCHEMA = {
  type: 'object',
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['ok', 'gap', 'blocked'] },
    summary: { type: 'string', minLength: 1 },
  },
} as const;

// A zero-artifact node (its structured return IS its only output) ⇒ returnMode defaults to 'required'.
const gateNode = (over: Partial<NodeIntent['io']> = {}): NodeIntent =>
  n('Gate', [], [], { io: { reads: [], produces: [], artifacts: [], returnSchema: RETURN_SCHEMA, ...over } });

describe('post-node returnSchema gate — authored `return` enforced (required)', () => {
  it('a CONFORMING result → node ok', async () => {
    const g = compile(wf([gateNode()]));
    const outDir = await tmpOut();
    const { status } = await runWorkflow(g, {
      run: 'rs-ok',
      outDir,
      buildCommand: returnBuilder({ status: 'ok', summary: 'all good' }),
    });
    expect(status.nodes.gate.returnMode).toBe('required');
    expect(status.nodes.gate.status).toBe('ok');
    expect(status.nodes.gate.returnSchemaInvalid).toBeUndefined();
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('a VIOLATING result (bad enum + missing required field) → node blocked', async () => {
    const g = compile(wf([gateNode()]));
    const outDir = await tmpOut();
    const { status } = await runWorkflow(g, {
      run: 'rs-bad',
      outDir,
      // `status` not in the enum AND `summary` absent — two schema violations.
      buildCommand: returnBuilder({ status: 'totally-wrong' }),
    });
    expect(status.nodes.gate.returnMode).toBe('required');
    expect(status.nodes.gate.status).toBe('blocked');
    expect(status.nodes.gate.returnSchemaInvalid?.length).toBeGreaterThan(0);
    expect(status.nodes.gate.issues.join(' ')).toMatch(/return violates the declared returnSchema/i);
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('a present result valid against the schema but self-reporting gap is honored (gate is shape-only)', async () => {
    const g = compile(wf([gateNode()]));
    const outDir = await tmpOut();
    const { status } = await runWorkflow(g, {
      run: 'rs-gap',
      outDir,
      buildCommand: returnBuilder({ status: 'gap', summary: 'partial' }),
    });
    // shape-conforming → the gate passes; the self-reported non-ok status flows through unchanged.
    expect(status.nodes.gate.returnSchemaInvalid).toBeUndefined();
    expect(status.nodes.gate.status).toBe('gap');
    await fs.rm(outDir, { recursive: true, force: true });
  });
});

describe('post-node returnSchema gate — optional is INERT (opt-in only)', () => {
  it("optional + MISSING result → NOT blocked (the gate never fires under optional)", async () => {
    // An artifact-backed node ⇒ returnMode defaults to 'optional'; it emits NO return fence.
    const node = n('Solo', [], ['s.txt'], {
      io: { reads: [], produces: ['s.txt'], artifacts: [{ path: 's.txt' }], returnSchema: RETURN_SCHEMA },
    });
    const g = compile(wf([node]));
    const outDir = await tmpOut();
    const { status } = await runWorkflow(g, { run: 'rs-opt-missing', outDir, buildCommand: returnBuilder(null) });
    expect(status.nodes.solo.returnMode).toBe('optional');
    expect(status.nodes.solo.status).toBe('ok'); // missing optional return is never this gate's concern
    expect(status.nodes.solo.returnSchemaInvalid).toBeUndefined();
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('optional + present VIOLATING result → NOT validated, NOT warned, NOT blocked (file IS the contract)', async () => {
    const node = n('Solo', [], ['s.txt'], {
      io: { reads: [], produces: ['s.txt'], artifacts: [{ path: 's.txt' }], returnSchema: RETURN_SCHEMA },
    });
    const g = compile(wf([node]));
    const outDir = await tmpOut();
    const { status } = await runWorkflow(g, {
      run: 'rs-opt-bad',
      outDir,
      // A return that flagrantly violates RETURN_SCHEMA (`summary` wrong type). Under the opt-in rule the
      // gate does NOT even run for an optional node → no recorded invalidity, no warn, status stays ok.
      buildCommand: returnBuilder({ status: 'ok', summary: 123 }),
    });
    expect(status.nodes.solo.returnMode).toBe('optional');
    expect(status.nodes.solo.status).toBe('ok'); // optional ⇒ the return schema is never enforced
    expect(status.nodes.solo.returnSchemaInvalid).toBeUndefined(); // not validated at all
    expect(status.nodes.solo.issues.join(' ')).not.toMatch(/return-schema/i); // no advisory warn either
    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── Loader wiring: the authored top-level `return` becomes NodeIO.returnSchema on the compiled spec ──
describe('loader wires authored `return` → NodeIO.returnSchema', () => {
  it('a template node with a top-level `return` schema populates io.returnSchema (was dormant before)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-tpl-ret-'));
    await fs.writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify({ id: 'tpl', name: 'tpl', description: 'd' }),
    );
    const ndir = path.join(dir, 'nodes', 'only');
    await fs.mkdir(ndir, { recursive: true });
    await fs.writeFile(path.join(ndir, 'prompt.md'), 'do the thing');
    await fs.writeFile(
      path.join(ndir, 'node.json'),
      JSON.stringify({
        id: 'only',
        phase: 'p',
        deps: [],
        prompt: { file: 'prompt.md' },
        contract: { artifacts: [], owns: ['out/**'], readScope: [], returnMode: 'required' },
        return: RETURN_SCHEMA,
      }),
    );
    const spec = await loadTemplate(dir);
    const only = spec.nodes.find((x) => x.label === 'only')!;
    // (a) the loader carried the authored return schema onto NodeIO.returnSchema (the gap this closes).
    expect(only.io.returnSchema).toEqual(RETURN_SCHEMA);
    // (b) the realized prompt now surfaces it as the DRIVER-RETURN-SCHEMA marker for the executor.
    expect(only.prompt).toMatch(/DRIVER-RETURN-SCHEMA:/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
