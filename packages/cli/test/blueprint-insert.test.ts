// `piflowctl blueprint insert <id> --plan <plan.json> --into <existing-dir> --ns <prefix>` — splice a
// blueprint FRAGMENT into an EXISTING template. `insert` has NO golden to deep-equal (it composes over a
// pre-existing DAG the goldens don't cover), so the gate is THREE observable facts, not a round-trip:
//
//   (a) exit 0 + `extract` GREEN with the fragment spliced in as a new parallel stage;
//   (b) NAMESPACING — every inserted id/owns/artifact is prefixed by `--ns` (the id is SLUGIFIED from
//       `<ns>__<id>` → `review-review-a` per the subworkflow-inlining precedent; owns/artifacts → review/…);
//   (c) COLLISION-FREE — the inserted ids + owns are disjoint from the pre-existing nodes;
//   (d) the ADDITIVE INVARIANT — the ONLY mutation to a pre-existing node is the seam consumer gaining a
//       dep/read; every OTHER pre-existing node.json is BYTE-IDENTICAL before vs. after (prompt.md + owns +
//       existing deps of the consumer unchanged too — it gains exactly one dep + one read, nothing else).
//
// Plus the PURE `nsRewrite` unit (ids/owns/paths/deps/reroute-target in→out) and the two test-the-test reds.
//
// Hermetic like blueprint-stamp.test.ts: a temp PIFLOW_HOME seeded with the real presets, and the golden
// COPIED into a temp dir (never mutated in the repo).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBlueprintCli } from '../src/blueprint.js';
import { nsRewriteId, nsRewritePath, nsRewriteNodeOpts } from '../src/blueprint-namespace.js';
import type { NodeOpts } from '../src/scaffold.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AGENT_SEEDS = path.join(REPO_ROOT, '.claude/skills/piflow-init/references/agent-presets');
const GOLDEN = path.join(REPO_ROOT, '.piflow/example-produce-verify-fix/template');

let DIR: string; // a COPY of the golden (the insert target)
let HOME_DIR: string;
let SAVED_HOME: string | undefined;

function sink(): { text: string; write: (s: string) => void } {
  const parts: string[] = [];
  return { write: (s: string) => void parts.push(s), get text() { return parts.join(''); } };
}

async function run(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const o = sink();
  const e = sink();
  const code = await runBlueprintCli(argv, { out: o.write, err: e.write });
  return { out: o.text, err: e.text, code };
}

const readJson = async (p: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(p, 'utf8'));
const readText = async (p: string): Promise<string> => fs.readFile(p, 'utf8');

async function writePlan(plan: unknown): Promise<string> {
  const p = path.join(HOME_DIR, `plan-${Math.random().toString(36).slice(2)}.json`);
  await fs.writeFile(p, JSON.stringify(plan, null, 2));
  return p;
}

beforeEach(async () => {
  DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-insert-'));
  HOME_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-home-'));
  await fs.cp(AGENT_SEEDS, path.join(HOME_DIR, 'agents'), { recursive: true });
  // COPY the golden into the insert target (never mutate the repo fixture).
  await fs.cp(GOLDEN, DIR, { recursive: true });
  SAVED_HOME = process.env.PIFLOW_HOME;
  process.env.PIFLOW_HOME = HOME_DIR;
});
afterEach(async () => {
  if (SAVED_HOME === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = SAVED_HOME;
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.rm(HOME_DIR, { recursive: true, force: true });
});

// ── the review-panel insert plan (fan-out-map-reduce, ns=review) ──────────────────────────────────────
// A 2-worker review panel whose input seam binds to `produce`'s output (`{{RUN}}/out/result.md`) and whose
// reduce (`consensus`) output is read by the pre-existing `verify` node. The workers/reduce are no-preset
// lanes (the golden shape). `seams.input` names the produce path; `seams.consumer` names verify + the panel
// verdict path verify should additively read.
function reviewPanelPlan(ns = 'review'): unknown {
  return {
    blueprint: 'fan-out-map-reduce',
    params: {},
    lanes: [
      { role: 'worker', id: 'review-a', agentType: null, extraTools: ['read', 'write', 'submit_result'] },
      { role: 'worker', id: 'review-b', agentType: null, extraTools: ['read', 'write', 'submit_result'] },
      { role: 'reduce', id: 'consensus', agentType: null, extraTools: ['read', 'write', 'submit_result'] },
    ],
    seams: {
      // the fragment's input seam → the EXISTING produce artifact the panel reviews
      input: '{{RUN}}/out/result.md',
      // additively extend this EXISTING consumer to read the panel's (namespaced) verdict
      consumer: 'verify',
      consumerReads: '{{RUN}}/review/verify/verdict.json',
    },
    meta: {}, // insert never rewrites meta (the target's meta is kept)
  };
}

describe('nsRewrite — the pure scaffolder-layer namespacing helper (in→out)', () => {
  it('namespaces an inserted lane id under `<ns>` (slugified from `<ns>__<id>` so it round-trips)', () => {
    // `<ns>__<id>` slugified — the subworkflow-inlining precedent; a raw `review__review-a` would collapse
    // `__`→`-` at compile while its dependsOn stayed literal, so the slug IS the authored id.
    expect(nsRewriteId('review-a', 'review')).toBe('review-review-a');
    expect(nsRewriteId('consensus', 'review')).toBe('review-consensus');
    // empty ns is the stamp degenerate case — the id is unchanged
    expect(nsRewriteId('review-a', '')).toBe('review-a');
  });

  it('prefixes a run-relative owns/artifact path under `<ns>/` (keeps the glob tail)', () => {
    expect(nsRewritePath('verify/review-a.json', 'review')).toBe('review/verify/review-a.json');
    expect(nsRewritePath('verify/**', 'review')).toBe('review/verify/**');
    // a `{{RUN}}`-rooted path keeps its root, gets `<ns>/` inserted after it
    expect(nsRewritePath('{{RUN}}/draft/draft.md', 'ns2')).toBe('{{RUN}}/ns2/draft/draft.md');
    // a bare `{{RUN}}` whole-run read is left as-is (namespacing a whole-run allow-list would be wrong)
    expect(nsRewritePath('{{RUN}}', 'review')).toBe('{{RUN}}');
    // empty ns ⇒ unchanged (the stamp degenerate case)
    expect(nsRewritePath('verify/review-a.json', '')).toBe('verify/review-a.json');
  });

  it('rewrites a NodeOpts: id, owns, artifacts, deps-among-inserted, inject, reroute-target', () => {
    const inserted = new Set(['review-a', 'review-b', 'consensus']);
    const opts: NodeOpts = {
      id: 'consensus',
      deps: ['review-a', 'review-b', 'produce'], // review-* are inserted; produce is EXTERNAL (kept)
      owns: ['verify/consensus.json'],
      artifacts: ['verify/consensus.json'],
      readScope: ['{{RUN}}'],
      inject: ['{{RUN}}/verify/review-a.json', '{{RUN}}/out/result.md'], // internal vs external read
      reroute: { node: 'review-a', max: 2 }, // inserted target → namespaced
      checks: [{ kind: 'json-parses', path: 'verify/consensus.json' }],
    };
    // external ids the ns MUST NOT touch: `produce` (a dep) and the external inject path `{{RUN}}/out/result.md`
    const external = new Set(['produce']);
    const externalReads = new Set(['{{RUN}}/out/result.md']);
    const out = nsRewriteNodeOpts(opts, 'review', inserted, external, externalReads);
    expect(out.id).toBe('review-consensus');
    // inserted deps namespaced (slugified); the external `produce` dep kept verbatim
    expect(out.deps).toEqual(['review-review-a', 'review-review-b', 'produce']);
    expect(out.owns).toEqual(['review/verify/consensus.json']);
    expect(out.artifacts).toEqual(['review/verify/consensus.json']);
    expect(out.readScope).toEqual(['{{RUN}}']); // whole-run read untouched
    // internal inject namespaced; the EXTERNAL seam read kept verbatim
    expect(out.inject).toEqual(['{{RUN}}/review/verify/review-a.json', '{{RUN}}/out/result.md']);
    expect(out.reroute).toEqual({ node: 'review-review-a', max: 2 });
    // check paths namespaced in lockstep with the artifact they gate
    expect(out.checks).toEqual([{ kind: 'json-parses', path: 'review/verify/consensus.json' }]);
    // the original opts object is NOT mutated (pure)
    expect(opts.id).toBe('consensus');
  });
});

describe('blueprint insert — splice a review panel into produce-verify-fix', () => {
  it('exits 0 + extract green with the panel as a new parallel stage', async () => {
    const planPath = await writePlan(reviewPanelPlan());
    const { code, err, out } = await run(
      'insert',
      'fan-out-map-reduce',
      '--plan',
      planPath,
      '--into',
      DIR,
      '--ns',
      'review',
    );
    expect(err, 'insert should not error').toBe('');
    expect(code).toBe(0);
    // extract preview shows a PARALLEL stage carrying the two namespaced workers
    expect(out).toContain('review-review-a');
    expect(out).toContain('review-review-b');
    expect(out).toContain('review-consensus');
    expect(out.toLowerCase()).toContain('parallel');
  });

  it('inserted ids/owns are namespaced (review-* · review/…) and collision-free', async () => {
    const planPath = await writePlan(reviewPanelPlan());
    const { code } = await run('insert', 'fan-out-map-reduce', '--plan', planPath, '--into', DIR, '--ns', 'review');
    expect(code).toBe(0);

    for (const id of ['review-review-a', 'review-review-b', 'review-consensus']) {
      const node = await readJson(path.join(DIR, 'nodes', id, 'node.json'));
      expect(node.id, `id of ${id}`).toBe(id);
      const owns = (node.contract as { owns: string[] }).owns;
      for (const g of owns) expect(g.startsWith('review/'), `owns of ${id}: ${g}`).toBe(true);
    }

    // no id/owns collision with the pre-existing plan/produce/verify
    const existingOwns = new Set<string>();
    for (const id of ['plan', 'produce', 'verify']) {
      const node = await readJson(path.join(DIR, 'nodes', id, 'node.json'));
      for (const g of (node.contract as { owns: string[] }).owns) existingOwns.add(g);
    }
    for (const id of ['review-review-a', 'review-review-b', 'review-consensus']) {
      const node = await readJson(path.join(DIR, 'nodes', id, 'node.json'));
      for (const g of (node.contract as { owns: string[] }).owns) {
        expect(existingOwns.has(g), `inserted owns "${g}" collides with an existing owns`).toBe(false);
      }
    }
  });

  it('ADDITIVE INVARIANT: pre-existing nodes byte-unchanged except the seam consumer gains one dep + one read', async () => {
    // capture BEFORE
    const before = new Map<string, string>();
    for (const id of ['plan', 'produce', 'verify']) {
      before.set(`${id}/node.json`, await readText(path.join(DIR, 'nodes', id, 'node.json')));
      before.set(`${id}/prompt.md`, await readText(path.join(DIR, 'nodes', id, 'prompt.md')));
    }

    const planPath = await writePlan(reviewPanelPlan());
    const { code } = await run('insert', 'fan-out-map-reduce', '--plan', planPath, '--into', DIR, '--ns', 'review');
    expect(code).toBe(0);

    // plan + produce: node.json AND prompt.md byte-identical (NOT the seam consumer → nothing changed)
    for (const id of ['plan', 'produce']) {
      expect(await readText(path.join(DIR, 'nodes', id, 'node.json')), `${id} node.json unchanged`).toBe(
        before.get(`${id}/node.json`),
      );
      expect(await readText(path.join(DIR, 'nodes', id, 'prompt.md')), `${id} prompt.md unchanged`).toBe(
        before.get(`${id}/prompt.md`),
      );
    }
    // every pre-existing prompt.md is untouched (prose is never the verb's)
    expect(await readText(path.join(DIR, 'nodes', 'verify', 'prompt.md')), 'verify prompt.md unchanged').toBe(
      before.get('verify/prompt.md'),
    );

    // the seam consumer (verify) — the ONLY additive mutation: gains a dep on the reduce + a read of its verdict.
    const verifyBefore = JSON.parse(before.get('verify/node.json')!) as Record<string, unknown>;
    const verifyAfter = await readJson(path.join(DIR, 'nodes', 'verify', 'node.json'));

    // deps: exactly the original set PLUS the namespaced reduce id — nothing removed/reordered before it.
    const depsBefore = verifyBefore.deps as string[];
    const depsAfter = verifyAfter.deps as string[];
    expect(depsAfter.slice(0, depsBefore.length), 'existing verify deps unchanged/leading').toEqual(depsBefore);
    expect(depsAfter).toContain('review-consensus');
    expect(depsAfter.length, 'exactly one dep added').toBe(depsBefore.length + 1);

    // readScope: original entries all still present + exactly ONE new read (the panel verdict).
    const rsBefore = (verifyBefore.contract as { readScope: string[] }).readScope;
    const rsAfter = (verifyAfter.contract as { readScope: string[] }).readScope;
    for (const r of rsBefore) expect(rsAfter, 'existing readScope kept').toContain(r);
    expect(rsAfter.length, 'exactly one read added').toBe(rsBefore.length + 1);
    const added = rsAfter.filter((r) => !rsBefore.includes(r));
    expect(added, 'the added read is the panel verdict').toEqual(['{{RUN}}/review/verify/verdict.json']);

    // NOTHING ELSE on verify changed: prompt, owns, artifacts, agentType, tools, policy, returnMode, op.
    expect(verifyAfter.prompt, 'verify prompt block unchanged').toEqual(verifyBefore.prompt);
    expect((verifyAfter.contract as { owns: unknown }).owns, 'verify owns unchanged').toEqual(
      (verifyBefore.contract as { owns: unknown }).owns,
    );
    expect((verifyAfter.contract as { artifacts: unknown }).artifacts, 'verify artifacts unchanged').toEqual(
      (verifyBefore.contract as { artifacts: unknown }).artifacts,
    );
    expect(verifyAfter.agentType, 'verify agentType unchanged').toEqual(verifyBefore.agentType);
    expect(verifyAfter.tools, 'verify tools unchanged').toEqual(verifyBefore.tools);
    expect(verifyAfter.policy, 'verify policy unchanged').toEqual(verifyBefore.policy);
    expect(verifyAfter.op, 'verify op[] (reroute loop) unchanged').toEqual(verifyBefore.op);
    expect((verifyAfter.contract as { returnMode: unknown }).returnMode, 'verify returnMode unchanged').toEqual(
      (verifyBefore.contract as { returnMode: unknown }).returnMode,
    );
  });
});

describe('blueprint insert — guard rails', () => {
  it('a colliding id (--ns "" reuses an existing node id) HALTS non-zero via the ID guard, no partial splice', async () => {
    // ISOLATE the id-collision guard: name a worker `plan` (an EXISTING node) with ns="". Its id collides
    // with the existing `plan`, but its owns (`verify/plan.json`) are DISJOINT from `plan`'s (`plan/**`), so
    // ONLY the id-collision guard (delta 3a) can fire — neutering it reddens this test (test-the-test i).
    const plan = {
      blueprint: 'fan-out-map-reduce',
      params: {},
      lanes: [
        { role: 'worker', id: 'plan', agentType: null, extraTools: ['read', 'write', 'submit_result'] },
        { role: 'worker', id: 'review-b', agentType: null, extraTools: ['read', 'write', 'submit_result'] },
        { role: 'reduce', id: 'consensus', agentType: null, extraTools: ['read', 'write', 'submit_result'] },
      ],
      seams: { input: '{{RUN}}/out/result.md' },
    };
    const planPath = await writePlan(plan);
    const { code, err } = await run('insert', 'fan-out-map-reduce', '--plan', planPath, '--into', DIR, '--ns', '');
    expect(code).not.toBe(0);
    expect(err.toLowerCase()).toContain('id collision');
    // no partial splice — the collided id did NOT overwrite the existing plan node (its phase stays `plan`,
    // never the worker's `review`); and produce is untouched.
    const planNode = await readJson(path.join(DIR, 'nodes', 'plan', 'node.json'));
    expect(planNode.phase, 'existing plan node not clobbered').toBe('plan');
  });

  it('an unresolvable input seam (no node produces the path) HALTS non-zero', async () => {
    const plan = {
      ...(reviewPanelPlan() as Record<string, unknown>),
      seams: { input: '{{RUN}}/nope/missing.md', consumer: 'verify', consumerReads: '{{RUN}}/review/verify/verdict.json' },
    };
    const planPath = await writePlan(plan);
    const { code, err } = await run('insert', 'fan-out-map-reduce', '--plan', planPath, '--into', DIR, '--ns', 'review');
    expect(code).not.toBe(0);
    expect(err.toLowerCase()).toMatch(/seam|produce|resolve/);
  });
});
