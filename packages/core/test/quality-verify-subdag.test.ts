// (G3) The shipped `verify` quality sub-DAG (templates/quality/verify) — N independent reviewers in
// parallel → a consensus adjudicator — composed via G9's `expandSubworkflow`. Two proofs: (1) the
// sub-template LOADS + COMPILES standalone (passes the §8 gate; reviewers share a parallel stage feeding
// the consensus); (2) referenced from a parent node it SPLICES correctly (namespaced, entry inherits the
// parent's deps, the consensus terminal takes over the parent's downstream edge). This is the G3-on-G9
// composition contract — it FAILS if the template regresses or the splice mis-wires.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemplate } from '../src/workflow/template/loader.js';
import { expandSubworkflow } from '../src/workflow/subworkflow/expand.js';
import { compile } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY_SRC = path.resolve(HERE, '../../../templates/quality/verify');

// loadTemplate (re)writes the template's generated workflow.json lock, so we run over a CLONE in tmp —
// the shipped source stays pristine (the load-template.test convention).
let verifyDir: string;
beforeAll(async () => {
  verifyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-verify-subdag-'));
  await fs.cp(VERIFY_SRC, verifyDir, { recursive: true });
});
afterAll(async () => {
  await fs.rm(verifyDir, { recursive: true, force: true });
});

const edgesInto = (wf: ReturnType<typeof compile>, id: string): string[] =>
  wf.edges.filter((e) => e.to === id).map((e) => e.from).sort();

describe('quality/verify — loads + compiles standalone (the §8 gate)', () => {
  it('passes the gate and recovers the 3 nodes (2 reviewers + consensus)', async () => {
    const spec = await loadTemplate(verifyDir);
    expect(spec.nodes.map((n) => n.label).sort()).toEqual(['consensus', 'review-a', 'review-b']);
  });

  it('compiles to a 2-wide parallel reviewer lane feeding the consensus', async () => {
    const wf = compile(await loadTemplate(verifyDir));
    const parallel = wf.stages.find((s) => s.nodeIds.length > 1);
    expect(parallel?.parallel).toBe(true);
    expect([...(parallel?.nodeIds ?? [])].sort()).toEqual(['review-a', 'review-b']);
    expect(edgesInto(wf, 'consensus')).toEqual(['review-a', 'review-b']);
  });

  it('carries the authored reviewer/consensus prompts (in-memory)', async () => {
    const spec = await loadTemplate(verifyDir);
    const reviewer = spec.nodes.find((n) => n.label === 'review-a')!;
    const consensus = spec.nodes.find((n) => n.label === 'consensus')!;
    expect(reviewer.prompt).toContain('independent, skeptical reviewer');
    expect(consensus.prompt).toContain('consensus adjudicator');
  });
});

describe('quality/verify — splices into a parent via expandSubworkflow (G3-on-G9)', () => {
  /** prep → gate(subworkflow→verify) → publish. */
  function parentSpec(): WorkflowSpec {
    const prep: NodeIntent = {
      label: 'prep',
      prompt: 'stage the subject',
      tools: {},
      io: { reads: [], produces: ['verify/subject.md'], dependsOn: [], artifacts: [{ path: 'verify/subject.md' }] },
    };
    const gate: NodeIntent = {
      label: 'gate',
      prompt: 'verify the subject',
      tools: {},
      io: { reads: [], produces: ['verify/verdict.json'], dependsOn: ['prep'], artifacts: [{ path: 'verify/verdict.json' }] },
      subworkflow: { ref: 'verify' },
    };
    const publish: NodeIntent = {
      label: 'publish',
      prompt: 'act on the verdict',
      tools: {},
      io: { reads: [], produces: ['out/done.md'], dependsOn: ['gate'], artifacts: [{ path: 'out/done.md' }] },
    };
    return { meta: { name: 't', description: 'd' }, nodes: [prep, gate, publish] };
  }

  it('replaces the gate with the namespaced verify nodes, wired prep→reviewers→consensus→publish', async () => {
    const out = await expandSubworkflow(parentSpec(), { loadChild: () => loadTemplate(verifyDir) });
    expect(out.nodes.map((n) => n.label).sort()).toEqual([
      'gate__consensus',
      'gate__review-a',
      'gate__review-b',
      'prep',
      'publish',
    ]);
    const wf = compile(out);
    // reviewers (entry) inherit the gate's upstream dep (prep); they share a parallel stage.
    expect(edgesInto(wf, 'gate-review-a')).toEqual(['prep']);
    expect(edgesInto(wf, 'gate-review-b')).toEqual(['prep']);
    // the consensus is the sub-DAG terminal — it gathers both reviewers AND feeds the gate's old successor.
    expect(edgesInto(wf, 'gate-consensus')).toEqual(['gate-review-a', 'gate-review-b']);
    expect(edgesInto(wf, 'publish')).toEqual(['gate-consensus']);
  });

  it('carries the child reviewer prompt onto the spliced node', async () => {
    const out = await expandSubworkflow(parentSpec(), { loadChild: () => loadTemplate(verifyDir) });
    expect(out.nodes.find((n) => n.label === 'gate__review-a')!.prompt).toContain('independent, skeptical reviewer');
  });
});
