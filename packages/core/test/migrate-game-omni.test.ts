// T6 CAPSTONE — the first REAL migrated template loads GREEN. `.piflow/game-omni/template/` was INGESTED
// from the live 9→16-node game-omni-v1.6.js Claude Workflow via extractWorkflow + parseMarkers (the per-node
// mapping is recorded in the T6 report). This is the proof the ingest → template → compile chain holds on a
// real workflow, not just the template-min fixture: loadTemplate passes the §8 static gate, compile consumes
// the WorkflowSpec, and the 5-wide parallel PRODUCER lane + the unrolled milestone chain are recovered.
//
// MEANINGFUL-OR-NOTHING: each assertion pins a load-bearing structural fact that, if the migration drifts
// (a dropped node, a broken edge, a lost parallel lane, a duplicate producer), goes RED. The committed
// template is the oracle; a regenerated/edited template that breaks the DAG must fail here. (RED-first proof:
// the T6 report records the load going RED on an incomplete template before authoring completed.)

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemplate, compile } from '../src/index.js';

// The migrated template lives at the repo root (.piflow/game-omni/template), 4 levels up from this test file
// (packages/core/test → packages/core → packages → <repo>). Resolve it relative to here so the test is
// location-independent.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(HERE, '..', '..', '..', '.piflow', 'game-omni', 'template');

const ALL_NODES = [
  'asset', 'gameplay', 'guidance', 'model', 'shell', 'sound',
  'verify-1-design', 'verify-2-m1', 'verify-2-m2', 'verify-2-m3',
  'w0-classify', 'w1-design', 'w2-scaffold',
  'w4-execute-m1', 'w4-execute-m2', 'w4-execute-m3',
];
const PRODUCER_LANE = ['asset', 'guidance', 'model', 'shell', 'sound'];

describe('T6 migrate — game-omni-v1.6 → template loads GREEN', () => {
  it('loadTemplate passes the §8 gate and recovers all 16 ingested nodes', async () => {
    const spec = await loadTemplate(TEMPLATE); // throws TemplateError on any §8 violation
    expect(spec.meta.name).toBe('game-omni');
    expect(spec.nodes.map((n) => n.label).sort()).toEqual(ALL_NODES);
  });

  it('carries the P2/P3 derive hooks onto NodeOps (seedContracts on gameplay, projectGenre on w2-scaffold)', async () => {
    const spec = await loadTemplate(TEMPLATE);
    const byId = Object.fromEntries(spec.nodes.map((n) => [n.label, n]));
    // P2 — gameplay seeds per-node contracts from the drift-gated catalog (RED if the schema/loader drops it).
    expect(byId['gameplay'].ops?.seedContracts).toEqual({
      source: 'spec/blueprint.json',
      catalog: '{{WORKSPACE}}/.agents/node-catalog.json',
    });
    // P3 — W2 derives gameConfig/index/world from the genre record's projections map.
    expect(byId['w2-scaffold'].ops?.projectGenre).toEqual({
      source: 'spec/blueprint.json',
      mapRef: '{{WORKSPACE}}/templates/genres.json',
      genre: '{{state.archetype}}',
    });
  });

  it('the WorkflowSpec is buildable by the existing compile (the runtime contract)', async () => {
    const wf = compile(await loadTemplate(TEMPLATE));
    expect(Object.keys(wf.nodes).sort()).toEqual(ALL_NODES);
  });

  it('recovers the 5-wide PARALLEL producer lane (Shell ∥ Guidance ∥ Asset ∥ Sound ∥ Model)', async () => {
    const wf = compile(await loadTemplate(TEMPLATE));
    const parallel = wf.stages.filter((s) => s.parallel);
    // EXACTLY one parallel stage, and it is the 5 producers — all depending on `gameplay`, write-disjoint owns.
    expect(parallel).toHaveLength(1);
    expect([...parallel[0].nodeIds].sort()).toEqual(PRODUCER_LANE);
    // each producer depends on gameplay (the lane forks off the one frozen blueprint).
    for (const id of PRODUCER_LANE) {
      const n = wf.nodes[id];
      expect(n.dependsOn ?? n.io?.dependsOn).toContain('gameplay');
    }
  });

  it('generates workflow.json with the right stage spine: serial head → producer lane → build → milestone chain', async () => {
    await loadTemplate(TEMPLATE); // (re)writes the committed lock
    const { promises: fs } = await import('node:fs');
    const wfjson = JSON.parse(await fs.readFile(path.join(TEMPLATE, 'workflow.json'), 'utf8'));
    expect(wfjson.stages[0]).toEqual(['w0-classify']);
    expect(wfjson.stages[1]).toEqual(['w1-design']);
    expect(wfjson.stages[2]).toEqual(['gameplay']);
    expect([...wfjson.stages[3]].sort()).toEqual(PRODUCER_LANE); // the parallel lane
    expect(wfjson.stages[4]).toEqual(['verify-1-design']);
    expect(wfjson.stages[5]).toEqual(['w2-scaffold']);
    // the per-milestone unrolled chain: W4-Mk → VERIFY-2-Mk, serial.
    expect(wfjson.stages.slice(6)).toEqual([
      ['w4-execute-m1'], ['verify-2-m1'],
      ['w4-execute-m2'], ['verify-2-m2'],
      ['w4-execute-m3'], ['verify-2-m3'],
    ]);
  });

  it('preserves each producing node’s contract: artifacts/owns are RUN-relative, the blueprint sentinel survives', async () => {
    const spec = await loadTemplate(TEMPLATE);
    const byId = new Map(spec.nodes.map((n) => [n.label, n]));
    // W0 produces classification.json (run-relative — the {{RUN}} prefix was abstracted out of the artifact).
    expect(byId.get('w0-classify')!.io.produces).toContain('spec/classification.json');
    // Gameplay is the blueprint producer and carries the <FILL: write-first sentinel parsed from the marker.
    expect(byId.get('gameplay')!.io.produces).toContain('spec/blueprint.json');
    expect(byId.get('gameplay')!.io.fillSentinel).toBe('<FILL:');
    // The realized prompt re-renders the DRIVER-* tail from the parsed contract (prose body + appended markers).
    const w0 = byId.get('w0-classify')!;
    expect(w0.prompt).toContain('W0 Classify node');
    expect(w0.prompt).toMatch(/^DRIVER-ARTIFACTS: .*spec\/classification\.json/m);
  });
});
