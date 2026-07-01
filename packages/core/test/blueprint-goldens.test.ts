// Regression guards for the 4 shipped blueprint golden templates under `.piflow/` that had ZERO
// coverage (the 5th, quality/verify, is guarded by quality-verify-subdag.test.ts). Each golden is a
// stamped composable-recipe topology; if one rots (a dropped dep edge, a mis-namespaced owns glob, a
// stripped fusion/reroute block) it may still "extract-green" (load + compile) yet no longer BE the
// blueprint it advertises. These tests assert the STABLE promised shape — stage topology + the ONE
// load-bearing wiring fact per recipe — not volatile prose/tool arrays, so a legitimate agentType or
// tool edit does NOT trip them while a structural regression DOES.
//
// Public API only: loadTemplate + compile, exactly as quality-verify-subdag.test.ts uses them.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemplate } from '../src/workflow/template/loader.js';
import { compile } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// packages/core/test -> repo root -> .piflow/<golden>/template
const GOLDENS = path.resolve(HERE, '../../..', '.piflow');

// loadTemplate (re)writes the template's generated workflow.json lock, so — like the sibling subdag
// test — we clone each golden into tmp and load from the clone, keeping the shipped source pristine.
const clones: string[] = [];
async function loadGolden(name: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `piflow-golden-${name}-`));
  clones.push(dir);
  await fs.cp(path.join(GOLDENS, name, 'template'), dir, { recursive: true });
  const spec = await loadTemplate(dir);
  return { spec, wf: compile(spec) };
}
afterAll(async () => {
  await Promise.all(clones.map((d) => fs.rm(d, { recursive: true, force: true })));
});

// A stage's node set (compile keys stages by node id; in these goldens id === label).
const stageSet = (wf: { stages: { parallel: boolean; nodeIds: readonly string[] }[] }, i: number) =>
  [...wf.stages[i].nodeIds].sort();

// ---------------------------------------------------------------------------------------------
// produce-verify-fix: plan -> produce -> verify, and verify reroutes back to produce on failure.
// ---------------------------------------------------------------------------------------------
describe('golden: example-produce-verify-fix', () => {
  it('produce_verify_fix_is_three_serial_stages', async () => {
    const { spec, wf } = await loadGolden('example-produce-verify-fix');
    expect(spec.nodes.map((n) => n.label).sort()).toEqual(['plan', 'produce', 'verify']);
    // exactly 3 stages, each a single node, none parallel — a straight pipeline.
    expect(wf.stages.length).toBe(3);
    expect(wf.stages.every((s) => s.nodeIds.length === 1 && !s.parallel)).toBe(true);
    expect([stageSet(wf, 0), stageSet(wf, 1), stageSet(wf, 2)]).toEqual([['plan'], ['produce'], ['verify']]);
  });

  it('produce_verify_fix_verify_reroutes_back_to_produce_on_failure', async () => {
    const { spec } = await loadGolden('example-produce-verify-fix');
    const verify = spec.nodes.find((n) => n.label === 'verify')!;
    // The load-bearing fact: verify's on-failure op reroutes to `produce` (a bounded repair loop).
    const rerouteOp = (verify.op ?? []).find(
      (o) => o.when === 'on-failure' && (o.action?.kind as string) === 'rerouteTo',
    );
    expect(rerouteOp, 'verify must carry an on-failure rerouteTo op').toBeDefined();
    expect(rerouteOp!.action).toMatchObject({ kind: 'rerouteTo', node: 'produce', max: 3 });
    // ...and it must point back UPSTREAM at produce, not at itself or a nonexistent node.
    expect(spec.nodes.some((n) => n.label === 'produce')).toBe(true);
    // No other node carries the reroute — it is verify's contract alone.
    for (const other of spec.nodes.filter((n) => n.label !== 'verify')) {
      expect((other.op ?? []).some((o) => (o.action?.kind as string) === 'rerouteTo')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// spec-fanout: design -> [prod-impl || prod-tests || prod-types] -> verify-join -> build, and the
// three producers write to DISJOINT owns globs (safe parallelism).
// ---------------------------------------------------------------------------------------------
describe('golden: example-spec-fanout', () => {
  const PRODUCERS = ['prod-impl', 'prod-tests', 'prod-types'];

  it('spec_fanout_has_3wide_parallel_producer_stage', async () => {
    const { spec, wf } = await loadGolden('example-spec-fanout');
    expect(spec.nodes.map((n) => n.label).sort()).toEqual([
      'build',
      'design',
      'prod-impl',
      'prod-tests',
      'prod-types',
      'verify-join',
    ]);
    // 4 stages: serial design, a 3-wide PARALLEL producer lane, serial verify-join, serial build.
    expect(wf.stages.length).toBe(4);
    expect(stageSet(wf, 0)).toEqual(['design']);
    expect(wf.stages[0].parallel).toBe(false);
    expect(stageSet(wf, 1)).toEqual(PRODUCERS);
    expect(wf.stages[1].parallel).toBe(true);
    expect(stageSet(wf, 2)).toEqual(['verify-join']);
    expect(stageSet(wf, 3)).toEqual(['build']);
    // The join fans in from all three producers (not a subset — a dropped edge would silently narrow it).
    const verifyJoin = spec.nodes.find((n) => n.label === 'verify-join')!;
    expect([...verifyJoin.io.dependsOn].sort()).toEqual(PRODUCERS);
  });

  it('spec_fanout_producers_own_write_disjoint_globs', async () => {
    const { spec } = await loadGolden('example-spec-fanout');
    const owns = PRODUCERS.map((id) => {
      const n = spec.nodes.find((x) => x.label === id)!;
      const w = n.sandbox?.write ?? [];
      expect(w.length, `${id} must declare exactly one owns glob`).toBe(1);
      return w[0];
    });
    // Parallelism is only safe because no two producers claim overlapping write roots — assert the
    // globs are pairwise write-disjoint (share no prefix path segment before the wildcard).
    const roots = owns.map((g) => g.replace(/\/\*+.*$/, ''));
    expect(new Set(roots).size, `producer owns roots must be distinct, got ${JSON.stringify(owns)}`).toBe(
      PRODUCERS.length,
    );
    for (let i = 0; i < roots.length; i++) {
      for (let j = i + 1; j < roots.length; j++) {
        const [a, b] = [roots[i], roots[j]];
        const overlap = a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
        expect(overlap, `producers ${PRODUCERS[i]}/${PRODUCERS[j]} own overlapping paths ${a} vs ${b}`).toBe(
          false,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// fusion: 4 serial nodes; draft carries fusion.mode=moa, harden carries fusion.mode=best-of-n n=3.
// ---------------------------------------------------------------------------------------------
describe('golden: example-fusion', () => {
  it('fusion_is_four_serial_nodes', async () => {
    const { spec, wf } = await loadGolden('example-fusion');
    expect(spec.nodes.map((n) => n.label).sort()).toEqual(['draft', 'harden', 'plan', 'publish']);
    expect(wf.stages.length).toBe(4);
    expect(wf.stages.every((s) => s.nodeIds.length === 1 && !s.parallel)).toBe(true);
    expect([stageSet(wf, 0), stageSet(wf, 1), stageSet(wf, 2), stageSet(wf, 3)]).toEqual([
      ['plan'],
      ['draft'],
      ['harden'],
      ['publish'],
    ]);
  });

  it('fusion_draft_and_harden_carry_fusion_config', async () => {
    const { spec } = await loadGolden('example-fusion');
    const draft = spec.nodes.find((n) => n.label === 'draft')!;
    const harden = spec.nodes.find((n) => n.label === 'harden')!;
    // The load-bearing fact: these two nodes are FUSION nodes (draft = mixture-of-agents, harden =
    // best-of-n with a panel of 3). Losing either fusion block silently downgrades it to a plain node.
    expect(draft.fusion?.mode).toBe('moa');
    expect(harden.fusion).toMatchObject({ mode: 'best-of-n', n: 3 });
    // ...and the non-fusion nodes must NOT accidentally carry a fusion block.
    expect(spec.nodes.find((n) => n.label === 'plan')!.fusion).toBeUndefined();
    expect(spec.nodes.find((n) => n.label === 'publish')!.fusion).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// outbound-design: [4 research lanes in parallel] -> synthesize -> author.
// ---------------------------------------------------------------------------------------------
describe('golden: outbound-design', () => {
  const RESEARCH = ['research-analyzer', 'research-enrich', 'research-infra', 'research-playbook'];

  it('outbound_design_fans_4_research_lanes_then_synthesize_then_author', async () => {
    const { spec, wf } = await loadGolden('outbound-design');
    expect(spec.nodes.map((n) => n.label).sort()).toEqual([...RESEARCH, 'author', 'synthesize'].sort());
    // 3 stages: a 4-wide PARALLEL research fan, then serial synthesize, then serial author.
    expect(wf.stages.length).toBe(3);
    expect(stageSet(wf, 0)).toEqual(RESEARCH);
    expect(wf.stages[0].parallel).toBe(true);
    expect(stageSet(wf, 1)).toEqual(['synthesize']);
    expect(wf.stages[1].parallel).toBe(false);
    expect(stageSet(wf, 2)).toEqual(['author']);
    // synthesize is the join: it fans in from ALL 4 research lanes (a dropped dep would narrow the fan).
    const synth = spec.nodes.find((n) => n.label === 'synthesize')!;
    expect([...synth.io.dependsOn].sort()).toEqual(RESEARCH);
    // author sits strictly after synthesize (the serial tail).
    expect(spec.nodes.find((n) => n.label === 'author')!.io.dependsOn).toEqual(['synthesize']);
  });
});
