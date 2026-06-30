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
import { compile, derivesFromOp } from '../src/index.js';

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

// Hermetic agents catalog (see scaffold.test.ts): seed the in-repo presets into a temp PIFLOW_HOME so the
// agentType-label case resolves market-research without the dev's real ~/.piflow/agents (absent in CI).
const AGENT_SEEDS = path.join(HERE, '../../..', '.claude/skills/piflow-init/references/agent-presets');
let PIFLOW_HOME_DIR: string;
let SAVED_PIFLOW_HOME: string | undefined;
beforeEach(async () => {
  PIFLOW_HOME_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-home-'));
  await fs.cp(AGENT_SEEDS, path.join(PIFLOW_HOME_DIR, 'agents'), { recursive: true });
  SAVED_PIFLOW_HOME = process.env.PIFLOW_HOME;
  process.env.PIFLOW_HOME = PIFLOW_HOME_DIR;
});
afterEach(async () => {
  if (SAVED_PIFLOW_HOME === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = SAVED_PIFLOW_HOME;
  await fs.rm(PIFLOW_HOME_DIR, { recursive: true, force: true });
});

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

  // S1(a) — the loader must LOWER the authored op-specs (node.json `hooks`) onto the canonical `op[]` (the
  // SOLE derive rep since U6) so the run loop can stage seeds / promote at the barrier. `derivesFromOp`
  // reconstructs the per-family executor inputs the run loop consumes — the same view `node.ops` carried
  // before retirement. Pre-S1 `toNodeIntent` dropped `hooks` entirely.
  it('lowers the authored hooks (seed/promote/project) onto intent.op (read via derivesFromOp)', async () => {
    dir = await cloneFixture();
    const spec = await loadTemplate(dir);
    // w0-classify declares a `promote` (archetype); w2a-levels declares a `seed`.
    const w0 = spec.nodes.find((n) => n.label === 'w0-classify')!;
    expect(derivesFromOp(w0.op).promotes).toEqual([
      { from: 'spec/classification.json:archetype', to: 'archetype', merge: 'set' },
    ]);
    const w2a = spec.nodes.find((n) => n.label === 'w2a-levels')!;
    expect(derivesFromOp(w2a.op).seeds).toEqual([
      {
        to: 'spec/level-skeleton.json',
        from: '{{WORKSPACE}}/templates/modules/{{state.archetype}}/level-skeleton.json',
      },
    ]);
    // w2b-assets authors a `project` hook → it lowers onto op[] as a project transform (not seed/promote).
    const w2b = spec.nodes.find((n) => n.label === 'w2b-assets')!;
    const w2bDerives = derivesFromOp(w2b.op);
    expect(w2bDerives.projects).toEqual([
      { to: 'public/assets/manifest.json', from: ['spec/classification.json', 'public/assets'] },
    ]);
    expect(w2bDerives.seeds).toEqual([]);
    expect(w2bDerives.promotes).toEqual([]);
  });

  it('compile passes op[] through onto the dense NodeSpec (the derives survive densification)', async () => {
    dir = await cloneFixture();
    const wf = compile(await loadTemplate(dir));
    expect(derivesFromOp(wf.nodes['w0-classify'].op).promotes[0].to).toBe('archetype');
    expect(derivesFromOp(wf.nodes['w2a-levels'].op).seeds[0].to).toBe('spec/level-skeleton.json');
  });

  // G1 — the loader must CARRY the authored per-node routing fields (model/provider/tier) through to the
  // compiled NodeSpec so the runner can route a different model per node. Mirrors the timeoutMs/retries carry.
  it('carries per-node model/provider/tier onto the compiled NodeSpec (G1 routing)', async () => {
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    n.model = 'glm-4.6';
    n.provider = 'openrouter';
    n.tier = 'deep';
    await writeJson(nodeJson(dir, 'w0-classify'), n);
    const wf = compile(await loadTemplate(dir));
    expect(wf.nodes['w0-classify'].model).toBe('glm-4.6');
    expect(wf.nodes['w0-classify'].provider).toBe('openrouter');
    expect(wf.nodes['w0-classify'].tier).toBe('deep');
    // additive: a node that declares none stays undefined downstream (byte-identical to today).
    expect(wf.nodes['w2a-levels'].model).toBeUndefined();
    expect(wf.nodes['w2a-levels'].provider).toBeUndefined();
    expect(wf.nodes['w2a-levels'].tier).toBeUndefined();
  });

  // Phase 2 — the loader must CARRY the authored `fusion` block onto the loaded WorkflowSpec INTENT. Unlike
  // the routing fields, fusion is consumed by `expandFusion` BEFORE compile and never reaches the dense
  // NodeSpec, so the assertion is on `spec.nodes` (the intent), not `wf.nodes`. Mirrors the checkpoint carry.
  it('carries the authored `fusion` block onto the loaded intent (Phase 2)', async () => {
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    n.fusion = { mode: 'moa', panel: ['fast', 'deep'], judge: 'deep', obligations: true };
    await writeJson(nodeJson(dir, 'w0-classify'), n);
    const spec = await loadTemplate(dir);
    const w0 = spec.nodes.find((nd) => nd.label === 'w0-classify')!;
    expect(w0.fusion).toEqual({ mode: 'moa', panel: ['fast', 'deep'], judge: 'deep', obligations: true });
    // additive: a node that declares no fusion stays fusion-free on the intent.
    expect(spec.nodes.find((nd) => nd.label === 'w2a-levels')!.fusion).toBeUndefined();
  });

  // G6 — the loader must CARRY the authored `agentType` LABEL through to the compiled NodeSpec (the GUI
  // keys the preset icon off it via observe). Today the template format has NO agentType field and the
  // loader drops it, so this guards the new wiring. Mirrors the G1 routing carry.
  it('carries the authored `agentType` label onto the compiled NodeSpec (G6)', async () => {
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    n.agentType = 'market-research';
    await writeJson(nodeJson(dir, 'w0-classify'), n);
    const wf = compile(await loadTemplate(dir));
    expect(wf.nodes['w0-classify'].agentType).toBe('market-research');
    // additive: a node that declares none stays undefined downstream (byte-identical to today).
    expect(wf.nodes['w2a-levels'].agentType).toBeUndefined();
  });

  // claude-code executor — the loader must CARRY the authored `executor` selector through to the compiled
  // NodeSpec so dispatch routes the node to `claude -p` instead of `pi` (RunOptions.buildCommand reads it).
  // The runtime already READS executor at the 3 dispatch seams; this guards the TEMPLATE authoring path —
  // the last gap (node.json → NodeSpec). Mirrors the G6 agentType carry.
  it('carries the authored `executor` selector onto the compiled NodeSpec (claude-code)', async () => {
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    n.executor = 'claude-code';
    await writeJson(nodeJson(dir, 'w0-classify'), n);
    const wf = compile(await loadTemplate(dir));
    expect(wf.nodes['w0-classify'].executor).toBe('claude-code');
    // additive: a node that declares none stays undefined downstream (⇒ pi, byte-identical to today).
    expect(wf.nodes['w2a-levels'].executor).toBeUndefined();
  });

  it('a NodeIntent with NO derives compiles to a NodeSpec with op[] undefined (additive — absence stays absent)', () => {
    // The additivity guarantee: an authored node that declares no derives is byte-for-byte op-free
    // downstream (`op[]` is the SOLE derive rep since U6 — no `op` ⇒ derivesFromOp yields five empty lists).
    const wf = compile({
      meta: { name: 't', description: 'd' },
      nodes: [{ label: 'Plain', prompt: 'x', tools: {}, io: { reads: [], produces: ['p.txt'], artifacts: [{ path: 'p.txt' }] } }],
    });
    expect(wf.nodes.plain.op).toBeUndefined();
    expect(derivesFromOp(wf.nodes.plain.op)).toEqual({ seeds: [], projects: [], registryProjects: [], merges: [], promotes: [] });
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

  it('(1b) an unknown executor value (not pi|claude-code) → REJECT (enum guard)', async () => {
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    n.executor = 'gpt-cli'; // not one of the two recognized executors
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

// per-node `fullAccess` — the AUTHORED jail-off flag. It is a per-node fs-scope posture, so it is authored
// where the OTHER fs scope lives: under `contract` (alongside `readScope`/`owns`), and the loader threads it
// onto `node.sandbox.fullAccess` exactly as it threads `contract.readScope`→`sandbox.read`/`owns`→`write`.
// The schema must ACCEPT a boolean and REJECT a non-boolean (an unchecked field is the bug this guards).
describe('loadTemplate — per-node contract.fullAccess (the jail-off authoring flag)', () => {
  it('ACCEPTS contract.fullAccess:true and threads it onto the compiled node.sandbox.fullAccess', async () => {
    // The authored boolean must (a) pass the schema gate (no REJECT) and (b) ride loader→compile onto the
    // dense NodeSpec at `sandbox.fullAccess`, which is the field the runner (scope.create) + buildNodeConfig
    // both key off. If the schema dropped it (additionalProperties:false) loadTemplate would REJECT; if the
    // loader failed to thread it, `sandbox.fullAccess` would be undefined and the second assertion fails.
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    n.contract.fullAccess = true;
    await writeJson(nodeJson(dir, 'w0-classify'), n);
    const wf = compile(await loadTemplate(dir)); // must NOT throw (schema accepts the field)
    expect(wf.nodes['w0-classify'].sandbox.fullAccess).toBe(true);
    // additive: a node that declares none stays undefined downstream (byte-identical to today).
    expect(wf.nodes['w2a-levels'].sandbox.fullAccess).toBeUndefined();
  });

  it('REJECTS a non-boolean contract.fullAccess (the schema actually validates the type)', async () => {
    // The negative control that makes the ACCEPT test meaningful: a string `fullAccess` must be REJECTED by
    // the schema's `type: boolean`. If the schema accepted any type (or omitted the field), this would NOT
    // reject and the ACCEPT test above could be passing for the wrong reason (a loose/absent schema).
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    n.contract.fullAccess = 'yes'; // wrong type
    await writeJson(nodeJson(dir, 'w0-classify'), n);
    const e = await expectReject(dir);
    expect(e.message).toMatch(/schema/i);
    expect(e.message).toContain('w0-classify');
  });
});

// #3 (M2) — the per-node `mcp.servers` field is now READ (the M1 carry). A committable template must
// reference secrets as `$VAR`/`${VAR}` env REFERENCES, never a literal secret on disk. The loader rejects
// a literal secret-bearing value loudly at author time (the SecretResolver allowlist contract, design §4).
describe('loadTemplate — #3 literal-secret guard on mcp.servers', () => {
  it('rejects a literal secret in mcp.servers (a raw Bearer token in a header)', async () => {
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    // A LITERAL credential committed in a header value — exactly what must never reach disk.
    n.mcp = {
      servers: {
        github: {
          transport: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          headers: { Authorization: 'Bearer ghp_LIVE_LITERAL_TOKEN_abc123' },
        },
      },
    };
    await writeJson(nodeJson(dir, 'w0-classify'), n);
    const e = await expectReject(dir);
    // the message must name the offence (secret/literal) and locate it (the node + the server).
    expect(e.message).toMatch(/secret|literal/i);
    expect(e.message).toContain('w0-classify');
    expect(e.message).toContain('github');
  });

  it('ACCEPTS a $VAR-ref secret in mcp.servers (the committable form loads cleanly)', async () => {
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    // The SAME header, but a `$VAR` REFERENCE — the only committable form. Must NOT reject.
    n.mcp = {
      servers: {
        github: {
          transport: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          headers: { Authorization: 'Bearer $GITHUB_TOKEN' },
        },
      },
    };
    await writeJson(nodeJson(dir, 'w0-classify'), n);
    const spec = await loadTemplate(dir); // must resolve, not throw
    const w0 = spec.nodes.find((nd) => nd.label === 'w0-classify')!;
    // and the carried-through mcp survives onto the intent (the M1 carry, intact).
    expect((w0.mcp?.servers as any).github.headers.Authorization).toBe('Bearer $GITHUB_TOKEN');
  });
});
