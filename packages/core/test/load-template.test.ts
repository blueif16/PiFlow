// The compile gate (T2): `loadTemplate(dir) → WorkflowSpec` (template-format.md §8) — the workflow's
// `tsc`. This is the fail-closed oracle: the UNMODIFIED template-min fixture LOADS and yields the
// correct stages (incl. the [w2a-levels, w2b-assets] parallel lane); and EACH §8 static check goes
// RED when its rule is violated.
//
// The malformed cases are the load-bearing assertions. We violate ONE rule per test by cloning the
// fixture into a fresh tmp dir and mutating exactly one file, then assert loadTemplate REJECTS with a
// precise, naming message. A check that stops rejecting (a loosened gate) is the exact bug this oracle
// exists to catch (verified by the mutation pass in the task report).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemplate, TemplateError } from '../src/index.js';
import { compile } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'template-min');

/** Copy the pristine fixture into a fresh tmp dir so a test can mutate it without touching the source. */
async function cloneFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-loadtpl-'));
  await fs.cp(FIXTURE, dir, { recursive: true });
  return dir;
}

const readJson = async (p: string): Promise<any> => JSON.parse(await fs.readFile(p, 'utf8'));
const writeJson = async (p: string, v: unknown): Promise<void> =>
  fs.writeFile(p, JSON.stringify(v, null, 2) + '\n');
const nodeJson = (dir: string, id: string): string => path.join(dir, 'nodes', id, 'node.json');

/** Run loadTemplate and capture the thrown TemplateError (or fail loudly if it did NOT throw). */
async function expectReject(dir: string): Promise<TemplateError> {
  try {
    await loadTemplate(dir);
  } catch (e) {
    if (e instanceof TemplateError) return e;
    throw e; // a non-TemplateError throw is itself a failure (e.g. a typo/import error)
  }
  throw new Error('expected loadTemplate to REJECT, but it resolved');
}

let dir: string;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('loadTemplate — HAPPY PATH (the unmodified fixture LOADS)', () => {
  it('returns a WorkflowSpec the existing compile consumes, with the right id→node mapping', async () => {
    dir = await cloneFixture(); // never write the committed source fixture
    const spec = await loadTemplate(dir);
    expect(spec.meta.name).toBe('template-min');
    // 3 nodes, labelled by their template id so compile's slug round-trips to the SAME id.
    const labels = spec.nodes.map((n) => n.label).sort();
    expect(labels).toEqual(['w0-classify', 'w2a-levels', 'w2b-assets']);
    // The returned spec must be buildable by the existing DAG compiler.
    const wf = compile(spec);
    expect(Object.keys(wf.nodes).sort()).toEqual(['w0-classify', 'w2a-levels', 'w2b-assets']);
  });

  it('derives stages from deps+owns: a serial root then the [w2a-levels, w2b-assets] PARALLEL lane', async () => {
    dir = await cloneFixture();
    await loadTemplate(dir); // (re)writes workflow.json
    const wfjson = await readJson(path.join(dir, 'workflow.json'));
    expect(wfjson.stages).toEqual([['w0-classify'], ['w2a-levels', 'w2b-assets']]);
    // And the existing compiler agrees: stage 2 is parallel (the lane).
    const wf = compile(await loadTemplate(dir));
    const parallel = wf.stages.find((s) => s.nodeIds.length > 1);
    expect(parallel?.parallel).toBe(true);
    expect([...(parallel?.nodeIds ?? [])].sort()).toEqual(['w2a-levels', 'w2b-assets']);
  });

  it('renders the DRIVER-* marker tail into each node prompt (artifacts/owns/read-scope)', async () => {
    dir = await cloneFixture(); // never write the committed source fixture
    const spec = await loadTemplate(dir);
    const w0 = spec.nodes.find((n) => n.label === 'w0-classify')!;
    // The prose body survives AND the rendered contract tail is appended.
    expect(w0.prompt).toContain('Classify the request');
    expect(w0.prompt).toMatch(/^DRIVER-ARTIFACTS: .*spec\/classification\.json/m);
    expect(w0.prompt).toMatch(/^DRIVER-OWNS:/m);
    expect(w0.prompt).toMatch(/^DRIVER-READ-SCOPE:/m);
  });
});

describe('loadTemplate — §8 STATIC CHECKS (each goes RED when violated)', () => {
  it('(1) schema-invalid node.json → REJECT', async () => {
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    // A typo'd top-level key the schema's `additionalProperties:false` must reject — `contract` stays
    // INTACT so the ONLY thing that can fail this node is the schema check (an unambiguous RED signal).
    n.depz = n.deps;
    await writeJson(nodeJson(dir, 'w0-classify'), n);
    const e = await expectReject(dir);
    expect(e.message).toMatch(/schema/i);
    expect(e.message).toContain('w0-classify');
  });

  it('(2) dangling dep (a dep with no discovered node) → REJECT', async () => {
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w2a-levels'));
    n.deps = ['no-such-node'];
    await writeJson(nodeJson(dir, 'w2a-levels'), n);
    const e = await expectReject(dir);
    expect(e.message).toMatch(/dep/i);
    expect(e.message).toContain('no-such-node');
  });

  it('(3) a cycle in deps → REJECT', async () => {
    dir = await cloneFixture();
    // Make w0 depend on w2a, while w2a already depends on w0 ⇒ a 2-cycle.
    const w0 = await readJson(nodeJson(dir, 'w0-classify'));
    w0.deps = ['w2a-levels'];
    await writeJson(nodeJson(dir, 'w0-classify'), w0);
    const e = await expectReject(dir);
    expect(e.message).toMatch(/cycle/i);
  });

  it('(4) two PARALLEL lanes with OVERLAPPING owns → REJECT', async () => {
    dir = await cloneFixture();
    // w2a and w2b are same-level (both dep only on w0). Make their owns overlap.
    const w2b = await readJson(nodeJson(dir, 'w2b-assets'));
    w2b.contract.owns = ['src/levels/**']; // collides with w2a-levels' owns
    await writeJson(nodeJson(dir, 'w2b-assets'), w2b);
    const e = await expectReject(dir);
    expect(e.message).toMatch(/owns|disjoint|lane/i);
    expect(e.message).toContain('w2a-levels');
    expect(e.message).toContain('w2b-assets');
  });

  it('(5) dangling channel: a {{state.x}} consumed but never promoted upstream → REJECT', async () => {
    dir = await cloneFixture();
    // w2a-levels consumes {{state.archetype}} (readScope + seed); w0 promotes it. Drop the promote.
    const w0 = await readJson(nodeJson(dir, 'w0-classify'));
    delete w0.hooks.promote;
    await writeJson(nodeJson(dir, 'w0-classify'), w0);
    const e = await expectReject(dir);
    expect(e.message).toMatch(/channel|state|promote/i);
    expect(e.message).toContain('archetype');
  });

  it('(6) dangling producer/consumer: an injected artifact only a NON-upstream node produces → REJECT', async () => {
    dir = await cloneFixture();
    // w2b-assets injects {{RUN}}/spec/classification.json — produced upstream by w0. Move that producer
    // to w2a-levels (w2b's SAME-LEVEL sibling, NOT upstream): now classification.json IS produced in the
    // graph, but no upstream node produces it → an ordering dangle (the consumer can't see a sibling's
    // output). w0 keeps producing it too? No — w0 must STOP producing it so the only producer is w2a.
    const w0 = await readJson(nodeJson(dir, 'w0-classify'));
    w0.contract.artifacts = ['spec/other.json'];
    w0.contract.owns = ['spec/other.json'];
    w0.hooks.promote = [{ from: 'spec/other.json:archetype', to: 'archetype', merge: 'set' }]; // keep (5) clean
    await writeJson(nodeJson(dir, 'w0-classify'), w0);
    const w2a = await readJson(nodeJson(dir, 'w2a-levels'));
    w2a.contract.artifacts = ['src/levels/level-1.json', 'spec/classification.json'];
    w2a.contract.owns = ['src/levels/**', 'spec/classification.json']; // disjoint from w2b's public/assets/**
    await writeJson(nodeJson(dir, 'w2a-levels'), w2a);
    const e = await expectReject(dir);
    expect(e.message).toMatch(/produce|producer|upstream/i);
    expect(e.message).toContain('spec/classification.json');
    expect(e.message).toContain('w2b-assets'); // the consumer named
  });

  it('(7) dangling ref: a prompt.file that does not exist → REJECT', async () => {
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w2a-levels'));
    n.prompt.file = 'no-such-prompt.md';
    await writeJson(nodeJson(dir, 'w2a-levels'), n);
    const e = await expectReject(dir);
    expect(e.message).toMatch(/ref|exist|prompt/i);
    expect(e.message).toContain('no-such-prompt.md');
  });

  it('(8) a STALE committed workflow.json is regenerated IN SYNC with the node topology', async () => {
    dir = await cloneFixture();
    // Corrupt the committed lock: wrong stages + a phantom node.
    await writeJson(path.join(dir, 'workflow.json'), {
      id: 'template-min',
      meta: { name: 'template-min', description: 'stale' },
      stages: [['w0-classify', 'w2a-levels', 'w2b-assets']], // wrong: all in one stage
      nodes: { 'w0-classify': { phase: 'classify', deps: [] }, phantom: { phase: 'x', deps: [] } },
    });
    await loadTemplate(dir); // must REWRITE it from the node set
    const wf = await readJson(path.join(dir, 'workflow.json'));
    expect(wf.stages).toEqual([['w0-classify'], ['w2a-levels', 'w2b-assets']]);
    expect(Object.keys(wf.nodes).sort()).toEqual(['w0-classify', 'w2a-levels', 'w2b-assets']);
    expect(wf.nodes.phantom).toBeUndefined();
    expect(wf.nodes['w2a-levels'].deps).toEqual(['w0-classify']);
  });

  it('(8b) an ALREADY-IN-SYNC workflow.json is left byte-identical (no churn / git noise)', async () => {
    dir = await cloneFixture();
    await loadTemplate(dir); // first load canonicalizes the committed lock
    const after1 = await fs.readFile(path.join(dir, 'workflow.json'), 'utf8');
    await loadTemplate(dir); // second load on a synced lock must NOT rewrite
    const after2 = await fs.readFile(path.join(dir, 'workflow.json'), 'utf8');
    expect(after2).toBe(after1);
  });
});
