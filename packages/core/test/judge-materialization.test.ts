// Judge-gate DAG MATERIALIZATION at load time (expert-representations · "Judge expansion").
//
// THE GAP this oracle closes: a `judgeGate` authored on a producer node was lowered to a `judgeNode`
// shape by `compileNodeBase`/`lowerGates` but NOTHING inserted it into the compiled WorkflowSpec — so a
// judge gate ran no judge. These tests assert through the PUBLIC `loadTemplate` seam that a producer
// carrying a `judgeGate` materializes a REAL judge NodeIntent wired into the DAG:
//
//   • id `<producer>__judge`, agentType:'judge', tier == judgeTier (and != the producer's tier);
//   • prompt CONTAINS the rubric (the materialized judge prompt);
//   • io.reads = the producer's produced artifact(s); deps place the judge AFTER the producer;
//   • a producer-side `rerouteTo`→producer action carries the retry budget (the judge-fail loop);
//   • the producer's downstream CONSUMERS depend on the judge (the judge gates the hand-off);
//   • the judge model MUST differ from the producer (the design invariant — a same-tier judge is REJECTED).
//
// Additivity guard: a template with NO judge gate compiles byte-identically (no `__judge` node appears).
// A minimal change that only emits the producer reroute op WITHOUT inserting a real judge node FAILS here.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemplate, TemplateError, compile } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'template-min');

async function cloneFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-judgemat-'));
  await fs.cp(FIXTURE, dir, { recursive: true });
  return dir;
}

const readJson = async (p: string): Promise<any> => JSON.parse(await fs.readFile(p, 'utf8'));
const writeJson = async (p: string, v: unknown): Promise<void> =>
  fs.writeFile(p, JSON.stringify(v, null, 2) + '\n');
const nodeJson = (dir: string, id: string): string => path.join(dir, 'nodes', id, 'node.json');

let dir: string;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Author a JUDGE GATE on the `w0-classify` producer (tier `fast`) with a `deep` judge tier — the two
 * tiers DIFFER, so this is a valid judge. The fixture's downstream nodes read w0's produced artifact
 * `spec/classification.json`, so they are the consumers the judge must come to gate.
 */
async function authorJudgeOn(d: string, judgeTier = 'deep', rubric = 'The classification must be exhaustive and self-consistent.'): Promise<void> {
  const n = await readJson(nodeJson(d, 'w0-classify'));
  n.tier = 'fast'; // the producer's tier — the judge tier (deep) MUST differ
  n.judgeGate = { judgeTier, rubric, threshold: '7/10', policy: { retryMax: 2 } };
  await writeJson(nodeJson(d, 'w0-classify'), n);
}

describe('loadTemplate — judge gate materializes a REAL judge node into the DAG', () => {
  it('inserts a `<producer>__judge` NodeIntent: agentType:judge, tier==judgeTier, prompt has the rubric', async () => {
    dir = await cloneFixture();
    await authorJudgeOn(dir);
    const spec = await loadTemplate(dir);

    const judge = spec.nodes.find((n) => n.label === 'w0-classify__judge');
    expect(judge, 'a judge gate MUST materialize a `<producer>__judge` node in the spec').toBeDefined();
    expect(judge!.agentType).toBe('judge');
    expect(judge!.tier).toBe('deep');
    expect(judge!.prompt, 'the judge prompt must carry the authored rubric').toContain(
      'The classification must be exhaustive',
    );
  });

  it('the judge tier MUST differ from the producer tier (the materialized judge != producer)', async () => {
    dir = await cloneFixture();
    await authorJudgeOn(dir);
    const spec = await loadTemplate(dir);
    const producer = spec.nodes.find((n) => n.label === 'w0-classify')!;
    const judge = spec.nodes.find((n) => n.label === 'w0-classify__judge')!;
    expect(judge.tier).not.toBe(producer.tier); // deep != fast — the no-self-judge invariant
  });

  it('REJECTS a judge whose tier EQUALS the producer tier (self-judging is forbidden)', async () => {
    dir = await cloneFixture();
    // Producer tier == judge tier == 'fast' → must be a loud TemplateError, never a silent same-tier judge.
    await authorJudgeOn(dir, 'fast');
    await expect(loadTemplate(dir)).rejects.toThrow(TemplateError);
  });

  it('wires io.reads = the producer artifact + deps placing the judge AFTER the producer', async () => {
    dir = await cloneFixture();
    await authorJudgeOn(dir);
    const spec = await loadTemplate(dir);
    const judge = spec.nodes.find((n) => n.label === 'w0-classify__judge')!;
    // The judge READS the producer's produced artifact (so the data-flow edge orders it after the producer).
    expect(judge.io.reads).toContain('spec/classification.json');
    // It produces a verdict artifact (a real output gating the hand-off).
    expect(judge.io.produces.length, 'the judge must produce a verdict artifact').toBeGreaterThan(0);
    // And it sits downstream of the producer (dependsOn OR a reads⋈produces edge — assert the reads edge).
    const producer = spec.nodes.find((n) => n.label === 'w0-classify')!;
    expect(producer.io.produces).toContain('spec/classification.json');
  });

  it('attaches a producer-side rerouteTo→producer action carrying the retry budget (judge-fail loop)', async () => {
    dir = await cloneFixture();
    await authorJudgeOn(dir);
    const spec = await loadTemplate(dir);
    const producer = spec.nodes.find((n) => n.label === 'w0-classify')!;
    const reroute = (producer.op ?? []).find((o) => (o.action as any)?.kind === 'rerouteTo');
    expect(reroute, 'the producer must carry a rerouteTo action for the judge-fail loop').toBeDefined();
    expect((reroute!.action as any).node).toBe('w0-classify');
    expect((reroute!.action as any).max).toBe(2); // the authored retryMax
  });

  it('the reroute carries an EVIDENCE pointer to the judge verdict (the re-entered producer reads what failed)', async () => {
    dir = await cloneFixture();
    await authorJudgeOn(dir);
    const spec = await loadTemplate(dir);
    const producer = spec.nodes.find((n) => n.label === 'w0-classify')!;
    const judge = spec.nodes.find((n) => n.label === 'w0-classify__judge')!;
    const reroute = (producer.op ?? []).find((o) => (o.action as any)?.kind === 'rerouteTo')!;
    // The judge-fail loop must tell the re-entered producer WHAT failed: the reroute evidence points at the
    // judge's verdict artifact (mirrors the hand-authored verify nodes' `evidence:[…report…]`). Omitting it
    // (attachRerouteLoop's 4th arg dropped) leaves the re-entry blind — this asserts the pointer is threaded.
    expect((reroute.action as any).evidence, 'the reroute must carry the judge verdict as evidence').toEqual([
      judge.io.produces[0],
    ]);
  });

  it('re-points the producer\'s downstream CONSUMERS to depend on the judge (the judge gates the hand-off)', async () => {
    dir = await cloneFixture();
    await authorJudgeOn(dir);
    const spec = await loadTemplate(dir);
    const judge = spec.nodes.find((n) => n.label === 'w0-classify__judge')!;
    // w2a-levels / w2b-assets consume w0's classification.json. After materialization they must order
    // AFTER the judge — either by reading the judge's verdict OR by an explicit dep on the judge label.
    const consumer = spec.nodes.find((n) => n.label === 'w2a-levels')!;
    const verdict = judge.io.produces[0];
    const gatedByVerdict = (consumer.io.reads ?? []).includes(verdict);
    // `dependsOn` resolves against SLUG ids (dag.ts), so the consumer carries the judge's slug id.
    const judgeSlug = 'w0-classify-judge'; // slugify('w0-classify__judge') — the `__` collapses to `-`
    const gatedByDep = (consumer.io.dependsOn ?? []).some((d) => d === judgeSlug);
    expect(gatedByVerdict || gatedByDep, 'a downstream consumer must come AFTER the judge').toBe(true);
  });

  it('the materialized judge is a REAL DAG node: compile() places it in a stage AFTER the producer', async () => {
    dir = await cloneFixture();
    await authorJudgeOn(dir);
    const wf = compile(await loadTemplate(dir)); // must build — the judge is a normal pi node
    // The compiled DAG id is the SLUG of the `<producer>__judge` label (the `__` collapses to `-`).
    const judgeId = Object.keys(wf.nodes).find((id) => id.endsWith('-judge'));
    expect(judgeId, 'the judge node survives densification into the compiled DAG').toBeDefined();
    expect(wf.nodes[judgeId!].agentType).toBe('judge');
    // The judge runs AFTER the producer (its stage index is strictly greater).
    const stageOf = (id: string) => wf.stages.findIndex((s) => s.nodeIds.includes(id));
    const producerId = Object.keys(wf.nodes).find((id) => id === 'w0-classify')!;
    expect(stageOf(judgeId!)).toBeGreaterThan(stageOf(producerId));
  });

  it('ADDITIVE: a template with NO judge gate compiles with NO `__judge` node (byte-identical behavior)', async () => {
    dir = await cloneFixture();
    const spec = await loadTemplate(dir); // pristine fixture — no judge gate authored
    expect(spec.nodes.some((n) => n.label.endsWith('__judge'))).toBe(false);
    // the original three nodes, unchanged
    expect(spec.nodes.map((n) => n.label).sort()).toEqual(['w0-classify', 'w2a-levels', 'w2b-assets']);
  });
});
