import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTemplate } from '../src/extract.js';

// The template-min fixture lives in @piflow/core's test tree: one serial root (w0-classify) feeding a
// 2-node PARALLEL lane (w2a-levels + w2b-assets, write-disjoint owns). `extract` is the FREE DAG preview
// (no model): loadTemplate(dir) → compile → render the stages/lanes. These assertions pin BOTH the node
// inventory AND that the parallel lane is shown as one stage with two ids.
//
// loadTemplate (re)writes the template's generated workflow.json lock, so we run over a CLONE in a tmp
// dir (the load-template.test convention) — the source fixture stays pristine.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../core/test/fixtures/template-min');

let TEMPLATE_MIN: string;
beforeAll(async () => {
  TEMPLATE_MIN = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cli-extract-'));
  await fs.cp(FIXTURE, TEMPLATE_MIN, { recursive: true });
});
afterAll(async () => {
  await fs.rm(TEMPLATE_MIN, { recursive: true, force: true });
});

describe('piflowctl extract — the free DAG preview over loadTemplate→compile', () => {
  it('names every node in the template', async () => {
    const out = await extractTemplate(TEMPLATE_MIN);
    expect(out).toContain('w0-classify');
    expect(out).toContain('w2a-levels');
    expect(out).toContain('w2b-assets');
  });

  it('reports the node count', async () => {
    const out = await extractTemplate(TEMPLATE_MIN);
    expect(out).toMatch(/3 nodes/);
  });

  it('SHOWS the parallel lane — w2a-levels + w2b-assets together in ONE stage marked parallel', async () => {
    const out = await extractTemplate(TEMPLATE_MIN);
    // The two build-lane siblings must land on the SAME stage line, and that line must be flagged parallel.
    const laneLine = out
      .split('\n')
      .find((l) => l.includes('w2a-levels') && l.includes('w2b-assets'));
    expect(laneLine, 'the two lane nodes must share one stage line').toBeDefined();
    expect(laneLine!.toLowerCase()).toContain('parallel');
    // And the serial root must NOT be on that same line (it is an earlier, single-node stage).
    expect(laneLine).not.toContain('w0-classify');
  });

  it('reports the stage count (2 topological levels: root, then the lane)', async () => {
    const out = await extractTemplate(TEMPLATE_MIN);
    expect(out).toMatch(/2 stages/);
  });
});
