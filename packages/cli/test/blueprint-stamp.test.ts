// `piflowctl blueprint stamp <id> --plan <lane-plan.json> --into <dir>` — the DETERMINISM gate.
//
// The verb is the mechanical logic gate that composes a blueprint's topology into a template so the init
// agent never hand-wires it. Its correctness contract (docs/design/blueprint-compose-verb.md, "Determinism
// contract"): given the lane-plan implied by a hand-stamped GOLDEN, the verb reproduces that golden's
// `node.json` set + `meta.json` — compared PARSED DEEP-EQUAL (`JSON.parse(stamped) ≡ JSON.parse(golden)`),
// NOT byte string (the goldens' compact vs. canonical whitespace differs but is semantically identical).
// prompt.md is the agent's — never emitted, never compared.
//
// This test is the acceptance gate the implementation is driven to: for EACH of the 2 canonical goldens
// (produce-verify-fix, spec-fanout-build) it authors the lane-plan that encodes that golden's ACTUAL state
// (its ids, agentTypes, K, M), stamps into a temp dir under a hermetic PIFLOW_HOME (real preset seeds copied
// in so `--agent-type` resolves), then asserts deep-equal per node.json + meta.json. A dropped field, a wrong
// reroute max, a non-disjoint owns glob → a red deep-equal on the exact node/field.
//
// Test-the-test: perturb the wiring map (verify's reroute max, a producer's owns glob) and the round-trip
// reddens on the exact node/field — the assertion pins the golden's real state, not a subset.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBlueprintCli } from '../src/blueprint.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// The in-repo preset seeds → a temp PIFLOW_HOME so `--agent-type plan|coder|verify` resolves without the
// dev's real ~/.piflow/agents (absent in clean CI), exactly as scaffold.test.ts does.
const AGENT_SEEDS = path.join(REPO_ROOT, '.claude/skills/piflow-init/references/agent-presets');

let DIR: string; // the stamp target (a fresh template dir)
let HOME_DIR: string;
let SAVED_HOME: string | undefined;

function sink(): { text: string; write: (s: string) => void } {
  const parts: string[] = [];
  return { write: (s: string) => void parts.push(s), get text() { return parts.join(''); } };
}

/** Run the verb with captured sinks; returns { out, err, code }. */
async function run(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const o = sink();
  const e = sink();
  const code = await runBlueprintCli(argv, { out: o.write, err: e.write });
  return { out: o.text, err: e.text, code };
}

const readJson = async (p: string): Promise<unknown> => JSON.parse(await fs.readFile(p, 'utf8'));

/** Write a lane-plan JSON to a temp file and return its path. */
async function writePlan(plan: unknown): Promise<string> {
  const p = path.join(HOME_DIR, `plan-${Math.random().toString(36).slice(2)}.json`);
  await fs.writeFile(p, JSON.stringify(plan, null, 2));
  return p;
}

/**
 * Deep-equal every golden node's node.json against the stamped one, plus meta.json. The nodes are named by
 * the golden's dir listing. prompt.md is NOT compared (the agent's, not emitted).
 */
async function assertRoundTrip(goldenTemplate: string, nodeIds: string[]): Promise<void> {
  const stampedMeta = await readJson(path.join(DIR, 'meta.json'));
  const goldenMeta = await readJson(path.join(goldenTemplate, 'meta.json'));
  expect(stampedMeta, 'meta.json').toEqual(goldenMeta);
  for (const id of nodeIds) {
    const stamped = await readJson(path.join(DIR, 'nodes', id, 'node.json'));
    const golden = await readJson(path.join(goldenTemplate, 'nodes', id, 'node.json'));
    expect(stamped, `node ${id}`).toEqual(golden);
  }
}

beforeEach(async () => {
  DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-stamp-'));
  HOME_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-home-'));
  await fs.cp(AGENT_SEEDS, path.join(HOME_DIR, 'agents'), { recursive: true });
  SAVED_HOME = process.env.PIFLOW_HOME;
  process.env.PIFLOW_HOME = HOME_DIR;
});
afterEach(async () => {
  if (SAVED_HOME === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = SAVED_HOME;
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.rm(HOME_DIR, { recursive: true, force: true });
});

describe('blueprint stamp — produce-verify-fix round-trips the golden deep-equal', () => {
  // The lane-plan encoding the golden's ACTUAL state: N=1, K=3, plan head. plan adds `write` (the read-only
  // preset persists its plan); produce=coder; verify=verify (read-only critic, reroutes to produce max K).
  const plan = {
    blueprint: 'produce-verify-fix',
    params: { K: 3 },
    lanes: [
      { role: 'plan', id: 'plan', agentType: 'plan', extraTools: ['write'] },
      { role: 'produce', id: 'produce', agentType: 'coder' },
      { role: 'verify', id: 'verify', agentType: 'verify' },
    ],
    meta: {
      id: 'produce-verify-fix',
      name: 'Produce → Verify → Fix (self-correcting pipeline)',
      description: '',
    },
  };

  it('stamps 3 nodes + meta identical to the golden', async () => {
    const planPath = await writePlan(plan);
    const { code, err } = await run('stamp', 'produce-verify-fix', '--plan', planPath, '--into', DIR);
    expect(err, 'stamp should not error').toBe('');
    expect(code).toBe(0);
    await assertRoundTrip(
      path.join(REPO_ROOT, '.piflow/example-produce-verify-fix/template'),
      ['plan', 'produce', 'verify'],
    );
  });
});

describe('blueprint stamp — spec-fanout-build round-trips the golden deep-equal', () => {
  // M=3 producers (types · impl · tests), each a disjoint frag/<facet>/** lane bound to coder. Producer lane
  // ORDER matches the golden's verify-join.deps array ([prod-types, prod-impl, prod-tests]) so deps deep-equal.
  const plan = {
    blueprint: 'spec-fanout-build',
    params: {},
    lanes: [
      { role: 'design', id: 'design', agentType: 'plan', extraTools: ['write'] },
      { role: 'produce', id: 'prod-types', agentType: 'coder' },
      { role: 'produce', id: 'prod-impl', agentType: 'coder' },
      { role: 'produce', id: 'prod-tests', agentType: 'coder' },
      { role: 'verify-join', id: 'verify-join', agentType: 'verify' },
      { role: 'build', id: 'build', agentType: 'coder' },
    ],
    meta: {
      id: 'spec-fanout-build',
      name: 'Spec fan-out → build',
      description: '',
    },
  };

  it('stamps 6 nodes + meta identical to the golden', async () => {
    const planPath = await writePlan(plan);
    const { code, err } = await run('stamp', 'spec-fanout-build', '--plan', planPath, '--into', DIR);
    expect(err, 'stamp should not error').toBe('');
    expect(code).toBe(0);
    await assertRoundTrip(
      path.join(REPO_ROOT, '.piflow/example-spec-fanout/template'),
      ['design', 'prod-types', 'prod-impl', 'prod-tests', 'verify-join', 'build'],
    );
  });
});

describe('blueprint stamp — fan-out-map-reduce round-trips the golden deep-equal', () => {
  // templates/quality/verify — N=2 adjudicate. review-a + review-b are NO-preset lanes (agentType: null),
  // hand-wired tools.allow [read, write, submit_result] + deny [bash], and post-checks [json-parses,
  // field-present:verdict:fail]; consensus is the reduce (deps on both workers). Worker id → owns
  // verify/<id>.json (the FULL id, not the `-`-tail facet). Worker order [review-a, review-b] matches the
  // golden's consensus.deps. The two post-checks + deny + policy{fail,warn} are FIXED by the shape (the
  // wiring rule), so the lane-plan only carries the hand-wired tool allow-list + the null preset.
  const plan = {
    blueprint: 'fan-out-map-reduce',
    params: {},
    lanes: [
      { role: 'worker', id: 'review-a', agentType: null, extraTools: ['read', 'write', 'submit_result'] },
      { role: 'worker', id: 'review-b', agentType: null, extraTools: ['read', 'write', 'submit_result'] },
      { role: 'reduce', id: 'consensus', agentType: null, extraTools: ['read', 'write', 'submit_result'] },
    ],
    meta: {
      id: 'verify',
      name: 'verify',
      description:
        'Quality sub-DAG (G3): N independent skeptical reviewers judge a subject in parallel, then a consensus adjudicator reconciles them into one evidenced verdict. Reference it from a parent node via `node.subworkflow` (G9). The parent stages the subject at {{RUN}}/verify/subject.md (and optional criteria.md); the verdict lands at {{RUN}}/verify/verdict.json.',
      phases: ['review', 'consensus'],
    },
  };

  it('stamps 3 nodes + meta identical to the golden', async () => {
    const planPath = await writePlan(plan);
    const { code, err } = await run('stamp', 'fan-out-map-reduce', '--plan', planPath, '--into', DIR);
    expect(err, 'stamp should not error').toBe('');
    expect(code).toBe(0);
    await assertRoundTrip(path.join(REPO_ROOT, 'templates/quality/verify'), ['review-a', 'review-b', 'consensus']);
  });
});

describe('blueprint stamp — candidate-fusion-refine round-trips the golden deep-equal', () => {
  // .piflow/example-fusion — linear plan → draft → harden → publish. draft carries fusion.mode=moa +
  // panel[fast,balanced,deep] + judge=deep; harden carries fusion.mode=best-of-n + n=3 + tier=deep. draft/
  // harden are NO-preset lanes (agentType null) that inject the prior stage's artifact and hand-wire their
  // tools. Every lane denies bash (shape) + carries a non-empty post-check over its artifact (shape) +
  // returnMode optional (shape). fusion + inject are per-lane holes.
  //
  // plan/publish keep the general-purpose brand; `--deny edit` narrows the broad preset
  // [read,write,edit,bash,submit_result] (bash denied by the shape) to the golden's [read,write,submit_result],
  // so brand AND tools round-trip. (The golden's deny was completed to [bash, edit] to close the earlier
  // finding that its plan/publish were hand-authored to a tool set the preset could not produce.)
  const draftHardenPlan = {
    blueprint: 'candidate-fusion-refine',
    params: {},
    lanes: [
      // plan/publish keep the general-purpose brand + `--deny edit` (the shape denies bash) → golden tools.
      // draft/harden inherit the default agent (agentType null) as the golden does.
      { role: 'plan', id: 'plan', agentType: 'general-purpose', denyTools: ['edit'] },
      {
        role: 'draft',
        id: 'draft',
        agentType: null,
        extraTools: ['read', 'write', 'submit_result'],
        inject: ['{{RUN}}/plan/outline.md'],
        fusion: { mode: 'moa', panel: ['fast', 'balanced', 'deep'], judge: 'deep' },
      },
      {
        role: 'harden',
        id: 'harden',
        agentType: null,
        tier: 'deep',
        extraTools: ['read', 'write', 'submit_result'],
        inject: ['{{RUN}}/draft/draft.md'],
        fusion: { mode: 'best-of-n', n: 3 },
      },
      {
        role: 'publish',
        id: 'publish',
        agentType: 'general-purpose',
        denyTools: ['edit'],
        inject: ['{{RUN}}/harden/hardened.md'],
      },
    ],
    meta: {
      id: 'example-fusion',
      name: 'example-fusion',
      description:
        'Fusion showcase — a short-explainer pipeline (plan → draft → harden → publish) that demonstrates BOTH fusion modes side by side: `draft` is a MoA panel (one sibling per model tier → a judge SYNTHESIZES across them) and `harden` is best-of-n (one model sampled N times → a judge SELECTS + repairs the strongest), each feeding the next, then a plain `publish` consumer. Dry-run it (`piflowctl run .piflow/example-fusion/template --dry-run`) to see the siblings+judge expansion, or open the GUI, press F for Fusion mode, and toggle any node between moa / best-of-n to watch the DAG re-expand live.',
      phases: ['plan', 'draft', 'harden', 'publish'],
    },
  };

  // All 4 nodes + meta round-trip deep-equal: the fusion lanes (draft·harden — the full field set: fusion
  // mode/panel/judge/n, inject, deny, checks, returnMode) AND the general-purpose plan/publish (brand + tools).
  it('stamps all 4 nodes + meta identical to the golden', async () => {
    const planPath = await writePlan(draftHardenPlan);
    const { code, err } = await run('stamp', 'candidate-fusion-refine', '--plan', planPath, '--into', DIR);
    expect(err, 'stamp should not error').toBe('');
    expect(code).toBe(0);
    await assertRoundTrip(
      path.join(REPO_ROOT, '.piflow/example-fusion/template'),
      ['plan', 'draft', 'harden', 'publish'],
    );
  });
});

describe('blueprint stamp — guard rails', () => {
  it('an unknown/no-rule blueprint id exits non-zero and says compose by hand', async () => {
    const planPath = await writePlan({ blueprint: 'no-such', lanes: [] });
    const { code, err } = await run('stamp', 'no-such', '--plan', planPath, '--into', DIR);
    expect(code).not.toBe(0);
    expect(err.toLowerCase()).toContain('not stampable');
  });

  it('a malformed lane-plan (a lane missing role/id) HALTS non-zero', async () => {
    const planPath = await writePlan({
      blueprint: 'produce-verify-fix',
      params: { K: 3 },
      lanes: [{ role: 'plan' /* no id */ }],
    });
    const { code } = await run('stamp', 'produce-verify-fix', '--plan', planPath, '--into', DIR);
    expect(code).not.toBe(0);
  });
});
