// ── tui/test/render.test.mjs ───────────────────────────────────────────
// The MIGRATION oracle: the ink monitor, rendered headlessly against a real `.pi/` fixture run dir,
// must show each node and a status indicator that reflects the run — ok ✔, blocked ⊘, running. This
// REDDENS if the adapter mis-maps the SHARED RunModel statuses to rows (mutation-proven). The data
// source is now the shared `@piflow/core/observe` reader/stream (via ./model.mjs); the visuals are the
// legacy's — only the data ACQUISITION is under test.
import { describe, it, expect, beforeAll } from 'vitest';
import { render } from 'ink-testing-library';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildFixture } from './fixtures/build-fixture.mjs';
import { discoverNamespaces, buildModel, subscribeRun } from '../model.mjs';
import { App, html } from '../components.mjs';
import { GLYPH } from '../components.mjs';

let runDir;
beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-tui-'));
  runDir = await buildFixture(tmp, 'demo');
});

// strip ANSI so we assert on the glyphs/text, not the colour codes.
const plain = (s) => s.replace(/\[[0-9;]*m/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('shared @piflow/core/observe reader → model adapter', () => {
  it('discoverNamespaces builds one namespace+thread from the run dir', async () => {
    const nss = await discoverNamespaces({ runDir });
    expect(nss).toHaveLength(1);
    expect(nss[0].threads).toHaveLength(1);
    expect(nss[0].threads[0].run).toBe('demo');
  });

  it('buildModel maps each shared-RunModel status onto its node (the load-bearing mapping)', async () => {
    const m = await buildModel({ runDir, run: 'demo' });
    expect(m.nodes['w0-classify'].status).toBe('ok');
    expect(m.nodes['w1-design'].status).toBe('running');
    expect(m.nodes['w1-assets'].status).toBe('blocked');
    // a parallel lane: w1-design + w1-assets share a stage (two nodeIds in one stage).
    const parallel = m.stages.find((st) => st.nodeIds.length > 1);
    expect(parallel).toBeTruthy();
    expect(parallel.nodeIds).toEqual(expect.arrayContaining(['w1-design', 'w1-assets']));
    // the data-flow edge w0 → w1-design, derived from the shared model's io edges (w1 reads what w0 wrote).
    expect(m.nodes['w0-classify'].io.outputs[0].toNodes).toContain('w1-design');
  });

  it('the live tail is folded from the shared watchRun node-event stream (no .pi/ file read)', async () => {
    // subscribeRun drives the shared stream, which tails only lines APPENDED after its first snapshot
    // (the engine's live-event semantics). So we subscribe, THEN append the running node's text deltas —
    // exactly as a live run writes them — and assert they accumulate into byNode.text via the stream.
    const { nodeEventsFile } = await import('@piflow/core');
    let byNode = {};
    const stop = subscribeRun({ runDir, onTail: (b) => { byNode = b; }, pollMs: 10 });
    await sleep(30); // let the initial snapshot land + baseline the offset
    const ef = nodeEventsFile(runDir, 'w1-design');
    await fs.appendFile(ef, [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' — refining the core loop' } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    // poll until the appended delta has streamed through the shared watchRun stream.
    for (let i = 0; i < 200 && !(byNode['w1-design']?.text || '').includes('refining the core loop'); i++) await sleep(10);
    stop();
    expect(byNode['w1-design']?.text).toContain('refining the core loop');
  });
});

describe('migrated monitor renders against the .pi/ fixture', () => {
  it('renders without crashing and shows each node id + a status indicator from the run', async () => {
    const config = { runDir, every: 2 };
    const { lastFrame, unmount } = render(html`<${App} config=${config} />`);
    // The first paint is the header alone; the detail columns fill once the ASYNC refresh (the shared
    // readRunModel adapter) resolves. Poll the frame until the node labels land (bounded) rather than
    // racing a fixed sleep — deterministic under any test-suite load.
    let out = '';
    for (let i = 0; i < 200; i++) {
      out = plain(lastFrame() || '');
      if (out.includes('W0 Classify') && out.includes(GLYPH.ok) && out.includes(GLYPH.blocked)) break;
      await sleep(15);
    }
    unmount();

    // every node is present (id-derived label).
    expect(out).toContain('W0 Classify');
    expect(out).toContain('W1 Design');
    expect(out).toContain('W1 Assets');
    // status indicators that REFLECT the run: ok ✔ and blocked ⊘ glyphs from the status map.
    expect(out).toContain(GLYPH.ok);       // ✔ — w0-classify ok
    expect(out).toContain(GLYPH.blocked);  // ⊘ — w1-assets blocked
  });
});
