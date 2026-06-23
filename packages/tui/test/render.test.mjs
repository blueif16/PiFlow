// ── packages/tui/test/render.test.mjs ───────────────────────────────────────────
// The MIGRATION oracle: the ink monitor, rendered headlessly against a real `.pi/` fixture run dir,
// must show each node and a status indicator that reflects `.pi/run.json` — ok ✔, blocked ⊘, running
// (spinner / ◐). This test REDDENS if the migrated reader mis-maps `.pi/run.json` statuses to rows
// (mutation-proven). The data source is the ONLY thing under test; the visuals are the legacy's.
import { describe, it, expect, beforeAll } from 'vitest';
import { render } from 'ink-testing-library';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildFixture } from './fixtures/build-fixture.mjs';
import { discoverNamespaces, buildModel } from '../model.mjs';
import { App, html } from '../components.mjs';
import { GLYPH } from '../components.mjs';

let runDir;
beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-tui-'));
  runDir = await buildFixture(tmp, 'demo');
});

// strip ANSI so we assert on the glyphs/text, not the colour codes.
const plain = (s) => s.replace(/\[[0-9;]*m/g, '');

describe('migrated .pi/ reader → model', () => {
  it('discoverNamespaces builds one namespace+thread from the run dir', () => {
    const nss = discoverNamespaces({ runDir });
    expect(nss).toHaveLength(1);
    expect(nss[0].threads).toHaveLength(1);
    expect(nss[0].threads[0].run).toBe('demo');
  });

  it('buildModel maps each .pi/run.json status onto its node (the load-bearing mapping)', async () => {
    const m = await buildModel({ runDir, run: 'demo' });
    expect(m.nodes['w0-classify'].status).toBe('ok');
    expect(m.nodes['w1-design'].status).toBe('running');
    expect(m.nodes['w1-assets'].status).toBe('blocked');
    // a parallel lane: w1-design + w1-assets share a stage (two nodeIds in one stage).
    const parallel = m.stages.find((st) => st.nodeIds.length > 1);
    expect(parallel).toBeTruthy();
    expect(parallel.nodeIds).toEqual(expect.arrayContaining(['w1-design', 'w1-assets']));
    // the data-flow edge w0 → w1-design, derived from the io ledgers (w1 reads what w0 wrote).
    expect(m.nodes['w0-classify'].io.outputs[0].toNodes).toContain('w1-design');
  });

  it('the live tail comes from .pi/nodes/<id>/events.jsonl', async () => {
    const m = await buildModel({ runDir, run: 'demo' });
    const { tailNodeOutput } = await import('../model.mjs');
    const to = tailNodeOutput({ runDir, node: 'w1-design' });
    expect(to.tail).toContain('designing the core loop');
  });
});

describe('migrated monitor renders against the .pi/ fixture', () => {
  it('renders without crashing and shows each node id + a status indicator from .pi/run.json', async () => {
    const config = { runDir, every: 2 };
    const { lastFrame, unmount } = render(html`<${App} config=${config} />`);
    // let the initial async refresh + first render settle.
    await new Promise((r) => setTimeout(r, 200));
    const out = plain(lastFrame() || '');
    unmount();

    // every node is present (id-derived label).
    expect(out).toContain('W0 Classify');
    expect(out).toContain('W1 Design');
    expect(out).toContain('W1 Assets');
    // status indicators that REFLECT .pi/run.json: ok ✔ and blocked ⊘ glyphs from the status map.
    expect(out).toContain(GLYPH.ok);       // ✔ — w0-classify ok
    expect(out).toContain(GLYPH.blocked);  // ⊘ — w1-assets blocked
  });
});
