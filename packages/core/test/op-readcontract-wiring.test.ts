// (op-integrity WS-I4) End-to-end wiring test for the readContract marker backstop: a literal NodeIntent
// declares `io.readContract`, runs through the REAL lifecycle (buildNodeConfig mirrors it onto
// `rec.config.readContract`, persisted to `.pi/run.json`), and `buildRunView` (the shared observe path)
// threads it into `buildNodeContext` so a traced read gets its `contract` verdict — WITHOUT the caller ever
// touching the compiled NodeSpec again. This proves the FULL chain (types.ts → node-lifecycle.ts →
// status.ts → run.json → runView.ts → contextComposition.ts), not just each layer in isolation (already
// covered by context-composition.test.ts's direct `buildNodeContext` calls and trace.test.ts's render-only
// hand-built RunViewNode).
//
// The node itself is PROGRAMMATIC (no `pi` spawn, so no real tool-call events) — the "read" tool-call event
// is hand-staged into `.pi/nodes/<id>/events.jsonl` afterward, over a file the node's `pre` seed op ALSO
// wrote for real — mirroring exactly what an in-turn staging script + a subsequent model `read` would leave
// behind on a real run.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';
import { buildRunView } from '../src/observe/runView.js';
import type { NodeIntent, WorkflowSpec } from '../src/types.js';

const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-readcontract-'));

describe('readContract wiring — NodeIO → buildNodeConfig → run.json → buildRunView → buildNodeContext', () => {
  it('a node.io.readContract survives to run.json (NodeConfig) and a traced read gets its contract verdict', async () => {
    const node: NodeIntent = {
      label: 'plan',
      programmatic: true,
      tools: {},
      io: {
        reads: ['src.json'],
        produces: ['persona.md'],
        externalInputs: ['src.json'],
        artifacts: [{ path: 'persona.md' }],
        readContract: [{ path: 'persona.md', marker: 'required_kp_ids' }],
      },
      op: [{ when: 'pre', writes: ['persona.md'], transform: { kind: 'seed', from: '{{RUN}}/src.json' } }],
    };
    const outDir = await tmpOut();
    // The seed source is the persona content ITSELF (a min viable "staged persona" stand-in) — MISSING the
    // required_kp_ids marker, mirroring the incident's silently-corrupted staging output.
    await fs.writeFile(path.join(outDir, 'src.json'), 'persona body with nothing required');
    const { status } = await runWorkflow(compile(wf([node])), { run: 'rc-wire', outDir });
    expect(status.nodes.plan.status).toBe('ok');

    // (1) buildNodeConfig mirrored the declared contract onto the persisted config slice.
    const runJson = JSON.parse(await fs.readFile(path.join(outDir, '.pi', 'run.json'), 'utf8'));
    expect(runJson.nodes.plan.config.readContract).toEqual([{ path: 'persona.md', marker: 'required_kp_ids' }]);

    // (2) hand-stage a "read" tool-call event over the SAME file the seed op wrote for real — the model
    // reading the (corrupted) staged persona, exactly as a real pi run's events.jsonl would record it.
    const personaAbs = path.join(outDir, 'persona.md');
    const nodeDir = path.join(outDir, '.pi', 'nodes', 'plan');
    await fs.mkdir(nodeDir, { recursive: true });
    const events = [
      JSON.stringify({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'a', args: { path: personaAbs }, _t: 1 }),
      JSON.stringify({ type: 'tool_execution_end', toolCallId: 'a', result: { content: [{ type: 'text', text: 'persona body with nothing required' }] }, isError: false, _t: 2 }),
    ].join('\n') + '\n';
    await fs.writeFile(path.join(nodeDir, 'events.jsonl'), events);

    // (3) buildRunView threads the persisted readContract into buildNodeContext — the traced read carries
    // the FAILING contract verdict (the silent in-turn corruption, now visible in `trace`).
    const { view } = buildRunView(outDir);
    const planNode = view.nodes.find((n) => n.id === 'plan')!;
    const readOp = planNode.context?.find((c) => c.op === 'read');
    expect(readOp?.contract).toEqual({ marker: 'required_kp_ids', ok: false });
  });

  it('a node with NO readContract declared carries no `contract` field on any traced read (byte-identical to today)', async () => {
    const node: NodeIntent = {
      label: 'plain',
      programmatic: true,
      tools: {},
      io: { reads: ['src.json'], produces: ['out.txt'], externalInputs: ['src.json'], artifacts: [{ path: 'out.txt' }] },
      op: [{ when: 'pre', writes: ['out.txt'], transform: { kind: 'seed', from: '{{RUN}}/src.json' } }],
    };
    const outDir = await tmpOut();
    await fs.writeFile(path.join(outDir, 'src.json'), 'plain content');
    const { status } = await runWorkflow(compile(wf([node])), { run: 'rc-none', outDir });
    expect(status.nodes.plain.status).toBe('ok');

    const outAbs = path.join(outDir, 'out.txt');
    const nodeDir = path.join(outDir, '.pi', 'nodes', 'plain');
    await fs.mkdir(nodeDir, { recursive: true });
    const events = [
      JSON.stringify({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'a', args: { path: outAbs }, _t: 1 }),
      JSON.stringify({ type: 'tool_execution_end', toolCallId: 'a', result: { content: [{ type: 'text', text: 'plain content' }] }, isError: false, _t: 2 }),
    ].join('\n') + '\n';
    await fs.writeFile(path.join(nodeDir, 'events.jsonl'), events);

    const { view } = buildRunView(outDir);
    const plainNode = view.nodes.find((n) => n.id === 'plain')!;
    const readOp = plainNode.context?.find((c) => c.op === 'read');
    expect(readOp?.contract).toBeUndefined();
  });
});
