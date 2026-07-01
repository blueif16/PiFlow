// ── tui/test/rich-dag.test.mjs ─────────────────────────────────────────
// The REAL-RUN oracle: a run that records itself the way `piflowctl run` does — a run-local resolved DAG
// in `.pi/workflow.json` but an EMPTY io.json ledger — must still render the connected graph the GUI
// draws. Since P0b, `readRunModel` (the lean snapshot) ALSO reads `.pi/workflow.json`, so it now surfaces
// the resolved-DAG EDGES; but it still carries NO per-node output FILES, so the TUI MUST adopt the RICH
// view (`buildRunView`, the SAME source the GUI reads) for the produced files + their producer→consumer
// wiring. This REDDENS on the pre-fix adapter, which derived the DAG from the empty io ledger and drew
// disconnected boxes with no inputs/outputs (mutation-proven: drop the rich-io overlay and every edge
// assertion + the rendered-connector assertion fail).
import { describe, it, expect, beforeAll } from 'vitest';
import { render } from 'ink-testing-library';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readRunModel } from '@piflow/core';
import { buildResolvedDagFixture } from './fixtures/build-fixture.mjs';
import { buildModel } from '../model.mjs';
import { StageDag } from '../dag.mjs';

const plain = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let runDir;
beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-tui-rich-'));
  runDir = await buildResolvedDagFixture(tmp, 'real');
});

describe('rich resolved-DAG topology drives the TUI graph (real-run shape)', () => {
  it('readRunModel surfaces the resolved-DAG edges (P0b: the lean snapshot now reads .pi/workflow.json)', async () => {
    // P0b unified the structure resolver: readRunModel prefers the run-local resolved DAG, so the lean
    // snapshot now draws the SAME edges as the rich buildRunView view (parity). (Before P0b it reconstructed
    // edges from the empty io ledger and found ZERO.) The per-node FILES the tests below assert still come
    // ONLY from the rich view — readRunModel carries no produced-file telemetry.
    const lean = await readRunModel(runDir);
    const pairs = [...new Set(lean.edges.map((e) => `${e.from}->${e.to}`))].sort();
    expect(pairs).toEqual(['classify->design', 'design->build-a', 'design->build-b']);
  });

  it('buildModel adopts the resolved-DAG stages: 3 stages, the build stage parallel (2 lanes)', async () => {
    const m = await buildModel({ runDir, run: 'real' });
    expect(m.stages).toHaveLength(3);
    const parallel = m.stages.find((st) => st.nodeIds.length > 1);
    expect(parallel).toBeTruthy();
    expect(parallel.nodeIds).toEqual(expect.arrayContaining(['build-a', 'build-b']));
  });

  it('buildModel wires the data-flow edges + real output files from the rich view', async () => {
    const m = await buildModel({ runDir, run: 'real' });

    // classify → design, with the produced file surfaced (exists=true, verified on disk).
    const classifyOut = m.nodes['classify'].io.outputs;
    expect(classifyOut.length).toBeGreaterThan(0);
    expect(classifyOut.some((o) => /classification/.test(o.rel || ''))).toBe(true);
    expect(classifyOut.some((o) => o.exists === true)).toBe(true);
    const classifyTo = new Set(classifyOut.flatMap((o) => o.toNodes || []));
    expect(classifyTo.has('design')).toBe(true);

    // design fans out to BOTH parallel builders (one edge file-less — the synthetic-output path keeps it).
    const designTo = new Set(m.nodes['design'].io.outputs.flatMap((o) => o.toNodes || []));
    expect(designTo.has('build-a')).toBe(true);
    expect(designTo.has('build-b')).toBe(true);

    // the consumer sees its upstream producer on the INPUT side (drives the inspector's flow line).
    expect(m.nodes['build-a'].io.inputs.some((i) => i.fromNode === 'design')).toBe(true);
    expect(m.nodes['build-b'].io.inputs.some((i) => i.fromNode === 'design')).toBe(true);
  });

  it('the rendered DAG draws connectors between the nodes (not disconnected boxes)', async () => {
    const m = await buildModel({ runDir, run: 'real' });
    const { lastFrame, unmount } = render(StageDag({ model: m, di: 0, focus: 2, height: 20, width: 100, tick: 0, labels: false, dagCol: 0 }));
    await sleep(40);
    const out = plain(lastFrame());
    unmount();
    // every node is drawn…
    for (const label of ['Classify', 'Design', 'Build A', 'Build B']) expect(out).toContain(label);
    // …and EDGES connect them: ╶/╴ (horizontal edge stubs) + tee/cross glyphs are produced ONLY by the
    // edge router, never by the node boxes (which use ┌┐└┘─│). Their presence proves the graph is wired.
    expect(out).toMatch(/[╶╴┬┴├┤┼]/);
  });
});
