// G4 — content-hash journal/replay resume. Two layers, two gates (test-discipline):
//   PURE LOGIC (envelopeHash / inputFilesOf / descendantsMap / decideResume) → example tests with
//     independently-justified assertions (the DECISION reused-vs-run, never a literal digest).
//   ORCHESTRATION GLUE (the runner consults the journal on resume) → integration tests through
//     `runWorkflow` with the injected `buildCommand`/`execRunner` seam — the SAME stub the existing
//     runner tests use (write the node's artifact in the fake builder). The observable seam is the
//     per-node `status` in `.pi/run.json` (`reused` vs `ok`) PLUS the produced file's bytes PLUS the
//     `.pi/journal.json` content.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import type { NodeIntent, WorkflowSpec, NodeSpec, Workflow } from '../src/index.js';
import { runWorkflow, defaultExecRunner, type ExecRunner } from '../src/runner/index.js';
import { piDir, stateFile } from '../src/runner/layout.js';
import {
  envelopeHash,
  inputFilesOf,
  descendantsMap,
  decideResume,
  loadJournal,
  journalFile,
  type Journal,
} from '../src/runner/journal.js';

// ── helpers (mirror runner.test.ts) ─────────────────────────────────────────────────────────────

function n(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return {
    label,
    prompt: `do ${label}`,
    tools: {},
    io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) },
    ...over,
  };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });

async function tmpOut(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-journal-'));
}

/** The offline stub builder (mirrors runner.test.ts): writes each declared artifact into the sandbox
 *  output dir at `<output>/<artifactPath>`, plus an ok return block. Tracks which nodes executed. */
function stubBuilder(ran?: Set<string>) {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    ran?.add(node.id);
    const writes = node.io.artifacts
      .map((a) => {
        const dest = `${node.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${node.id} done"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

// ── 1. PURE: envelopeHash ───────────────────────────────────────────────────────────────────────

describe('envelopeHash — the per-node identity', () => {
  const node = compile(wf([n('A', [], ['a.txt'])])).nodes.a;
  const resolved = { piTools: ['read', 'write'] };

  it('is a deterministic sha256: identical inputs → identical hash', () => {
    expect(envelopeHash(node, resolved, 'm1')).toBe(envelopeHash(node, resolved, 'm1'));
    expect(envelopeHash(node, resolved, 'm1')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('flips when the PROMPT changes (a prompt edit must re-run)', () => {
    const edited = { ...node, prompt: 'do A but DIFFERENTLY' };
    expect(envelopeHash(edited, resolved, 'm1')).not.toBe(envelopeHash(node, resolved, 'm1'));
  });

  it('flips when the TOOL set changes (resolved.piTools)', () => {
    expect(envelopeHash(node, { piTools: ['read'] }, 'm1')).not.toBe(envelopeHash(node, resolved, 'm1'));
  });

  it('flips when the MODEL pin changes', () => {
    expect(envelopeHash(node, resolved, 'm2')).not.toBe(envelopeHash(node, resolved, 'm1'));
  });

  it('flips when the return contract (returnSchema/returnMode) changes', () => {
    const tightened: NodeSpec = { ...node, io: { ...node.io, returnMode: 'required' } };
    expect(envelopeHash(tightened, resolved, 'm1')).not.toBe(envelopeHash(node, resolved, 'm1'));
  });
});

// ── 2. PURE: inputFilesOf — the consumed set (the load-bearing template discrepancy) ──────────────

describe('inputFilesOf — derives the consumed set from io.reads OR DAG-parent artifacts', () => {
  it('uses io.reads when populated (the inferred-edge path)', () => {
    const g = compile(wf([n('A', [], ['a.txt']), n('B', ['a.txt'], ['b.txt'])]));
    expect(inputFilesOf(g.nodes.b, g)).toEqual(['a.txt']);
    expect(inputFilesOf(g.nodes.a, g)).toEqual([]); // a leaf input consumes nothing internal
  });

  it('derives from DAG-parent produces when io.reads is [] (the TEMPLATE/deps path)', () => {
    // Simulate the template loader: io.reads hardcoded [], edges via dependsOn. We hand-build the
    // compiled Workflow so B depends on A but reads nothing (io.reads === []).
    const g = compile(wf([n('A', [], ['a.txt']), n('B', [], ['b.txt'], { io: { reads: [], produces: ['b.txt'], artifacts: [{ path: 'b.txt' }], dependsOn: ['a'] } })]));
    // B's io.reads is [], but A → B edge exists; consumed set must be A's produces.
    expect(inputFilesOf(g.nodes.b, g)).toEqual(['a.txt']);
  });
});

// ── 3. PURE: descendantsMap + decideResume — the §4c algorithm ────────────────────────────────────

describe('descendantsMap — transitive closure of wf.edges', () => {
  it('A→B→C with a sibling A→D: descendants(A) = {B,C,D}, descendants(B) = {C}', () => {
    const g = compile(wf([
      n('A', [], ['a.txt']),
      n('B', ['a.txt'], ['b.txt']),
      n('C', ['b.txt'], ['c.txt']),
      n('D', ['a.txt'], ['d.txt']),
    ]));
    const d = descendantsMap(g);
    expect([...d.a].sort()).toEqual(['b', 'c', 'd']);
    expect([...d.b].sort()).toEqual(['c']);
    expect([...d.d].sort()).toEqual([]);
  });
});

describe('decideResume — reuse the unchanged, run the changed + its descendants', () => {
  // Build a journal as the prior run would have, then mutate one input and assert the decision.
  function buildJournal(g: Workflow, envHash: (id: string) => string, inputHashes: Record<string, Record<string, string>>, outputHashes: Record<string, Record<string, string>>): Journal {
    const nodes: Journal['nodes'] = {};
    for (const id of Object.keys(g.nodes)) {
      nodes[id] = {
        hash: envHash(id),
        inputHashes: inputHashes[id] ?? {},
        outputHashes: outputHashes[id] ?? {},
        status: 'ok',
        producedAt: '2026-06-25T00:00:00.000Z',
      };
    }
    return { version: 1, runId: 'r', source: g.meta.name, nodes };
  }

  it('all unchanged → every node REUSE', () => {
    const g = compile(wf([n('A', [], ['a.txt']), n('B', ['a.txt'], ['b.txt'])]));
    const env = (id: string): string => `sha256:env-${id}`;
    const j = buildJournal(g, env, { b: { 'a.txt': 'sha256:a-out' } }, { a: { 'a.txt': 'sha256:a-out' } });
    const dec = decideResume(g, j, {
      envHash: { a: env('a'), b: env('b') },
      inputHash: { a: {}, b: { 'a.txt': 'sha256:a-out' } }, // B's input bytes match the journal
    });
    expect(dec.get('a')!.decision).toBe('REUSE');
    expect(dec.get('b')!.decision).toBe('REUSE');
  });

  it('A envelope changed → A RUNs AND its descendant B RUNs (topological taint)', () => {
    const g = compile(wf([n('A', [], ['a.txt']), n('B', ['a.txt'], ['b.txt'])]));
    const env = (id: string): string => `sha256:env-${id}`;
    const j = buildJournal(g, env, { b: { 'a.txt': 'sha256:a-out' } }, { a: { 'a.txt': 'sha256:a-out' } });
    const dec = decideResume(g, j, {
      envHash: { a: 'sha256:env-a-EDITED', b: env('b') }, // A's envelope flipped
      inputHash: { a: {}, b: { 'a.txt': 'sha256:a-out' } },
    });
    expect(dec.get('a')!.decision).toBe('RUN');
    expect(dec.get('b')!.decision).toBe('RUN'); // taint propagates to the descendant
  });

  it('an unrelated SIBLING off the changed subgraph is REUSEd', () => {
    const g = compile(wf([
      n('A', [], ['a.txt']),
      n('B', ['a.txt'], ['b.txt']),
      n('C', ['b.txt'], ['c.txt']),
      n('D', ['a.txt'], ['d.txt']), // sibling: A→D, no path B→D
    ]));
    const env = (id: string): string => `sha256:env-${id}`;
    const j = buildJournal(
      g,
      env,
      { b: { 'a.txt': 'sha256:a-out' }, c: { 'b.txt': 'sha256:b-out' }, d: { 'a.txt': 'sha256:a-out' } },
      { a: { 'a.txt': 'sha256:a-out' }, b: { 'b.txt': 'sha256:b-out' } },
    );
    const dec = decideResume(g, j, {
      envHash: { a: env('a'), b: 'sha256:env-b-EDITED', c: env('c'), d: env('d') }, // only B edited
      inputHash: { a: {}, b: { 'a.txt': 'sha256:a-out' }, c: { 'b.txt': 'sha256:b-out' }, d: { 'a.txt': 'sha256:a-out' } },
    });
    expect(dec.get('a')!.decision).toBe('REUSE'); // upstream of B, untouched
    expect(dec.get('b')!.decision).toBe('RUN'); // edited
    expect(dec.get('c')!.decision).toBe('RUN'); // descendant of B
    expect(dec.get('d')!.decision).toBe('REUSE'); // sibling, off B's subgraph
  });

  it('a consumed INPUT file changed on disk → the consumer RUNs even with an unchanged envelope', () => {
    const g = compile(wf([n('A', [], ['a.txt']), n('B', ['a.txt'], ['b.txt'])]));
    const env = (id: string): string => `sha256:env-${id}`;
    const j = buildJournal(g, env, { b: { 'a.txt': 'sha256:a-ORIGINAL' } }, { a: { 'a.txt': 'sha256:a-ORIGINAL' } });
    const dec = decideResume(g, j, {
      envHash: { a: env('a'), b: env('b') }, // B's envelope unchanged
      inputHash: { a: {}, b: { 'a.txt': 'sha256:a-HANDEDITED' } }, // but A's bytes (B's input) differ
    });
    expect(dec.get('b')!.decision).toBe('RUN');
    expect(dec.get('b')!.reason).toMatch(/input changed/i);
  });

  it('a node with NO journal entry RUNs (a new node)', () => {
    const g = compile(wf([n('A', [], ['a.txt']), n('B', ['a.txt'], ['b.txt'])]));
    const j: Journal = { version: 1, runId: 'r', source: 't', nodes: {} }; // empty journal
    const dec = decideResume(g, j, { envHash: { a: 'x', b: 'y' }, inputHash: { a: {}, b: {} } });
    expect(dec.get('a')!.decision).toBe('RUN');
    expect(dec.get('b')!.decision).toBe('RUN');
  });
});

// ── 4. INTEGRATION: the headline — edit a node → it + descendants re-run, sibling reused ──────────

describe('runWorkflow journal resume — the headline (kills stale-reuse)', () => {
  it('edit B prompt → B and C re-run; A and sibling D are reused', async () => {
    const spec = wf([
      n('A', [], ['a.txt']),
      n('B', ['a.txt'], ['b.txt']),
      n('C', ['b.txt'], ['c.txt']),
      n('D', ['a.txt'], ['d.txt']),
    ]);
    const outDir = await tmpOut();

    // Run 1 — full run writes the journal.
    await runWorkflow(compile(spec), { run: 'h', outDir, buildCommand: stubBuilder() });
    const j1 = await loadJournal(outDir);
    expect(j1).not.toBeNull();
    expect(Object.keys(j1!.nodes).sort()).toEqual(['a', 'b', 'c', 'd']);

    // Run 2 — edit B's prompt; resume with NO flags. The journal decides.
    const edited = wf([
      n('A', [], ['a.txt']),
      { ...n('B', ['a.txt'], ['b.txt']), prompt: 'do B but COMPLETELY rewritten' },
      n('C', ['b.txt'], ['c.txt']),
      n('D', ['a.txt'], ['d.txt']),
    ]);
    const ran = new Set<string>();
    const { status } = await runWorkflow(compile(edited), { run: 'h', outDir, buildCommand: stubBuilder(ran) });

    expect(status.nodes.a.status).toBe('reused'); // upstream of B, unchanged
    expect(status.nodes.b.status).toBe('ok'); // edited → re-ran
    expect(status.nodes.c.status).toBe('ok'); // descendant of B → re-ran
    expect(status.nodes.d.status).toBe('reused'); // sibling off B's subgraph → reused
    expect(ran.has('a')).toBe(false);
    expect(ran.has('b')).toBe(true);
    expect(ran.has('c')).toBe(true);
    expect(ran.has('d')).toBe(false);

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('edit A prompt → B re-runs on A’s NEW output bytes (the §2b stale-reuse bug)', async () => {
    // A → B, where B's stub copies A's input bytes into its own artifact, so B's output PROVES which
    // bytes of A it consumed. The discriminating assertion: B's artifact must reflect A's NEW content.
    const aContent = (run: number): string => `A-content-v${run}`;
    function builder(aVal: string) {
      return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
        const out = node.sandbox.output;
        if (node.id === 'a') {
          return `mkdir -p ${out} && printf '%s' '${aVal}' > ${out}/a.txt && printf '%s' '\`\`\`json\\n{"status":"ok"}\\n\`\`\`'`;
        }
        // B reads the staged a.txt (from the host run dir) and echoes it into b.txt — so b.txt === a.txt bytes.
        return `mkdir -p ${out} && cp a.txt ${out}/b.txt && printf '%s' '\`\`\`json\\n{"status":"ok"}\\n\`\`\`'`;
      };
    }
    const outDir = await tmpOut();

    // Run 1: A writes v1.
    await runWorkflow(compile(wf([n('A', [], ['a.txt']), n('B', ['a.txt'], ['b.txt'])])), {
      run: 's', outDir, buildCommand: builder(aContent(1)),
    });
    expect(await fs.readFile(path.join(outDir, 'b.txt'), 'utf8')).toBe(aContent(1));

    // Run 2: edit A's PROMPT (envelope flips) AND A now writes v2. Resume with NO flags.
    const editedA = { ...n('A', [], ['a.txt']), prompt: 'do A v2 — rewritten' };
    const { status } = await runWorkflow(compile(wf([editedA, n('B', ['a.txt'], ['b.txt'])])), {
      run: 's', outDir, buildCommand: builder(aContent(2)),
    });

    expect(status.nodes.a.status).toBe('ok'); // A re-ran (envelope edit)
    expect(status.nodes.b.status).toBe('ok'); // B re-ran (descendant of A)
    // THE staleness assertion: B consumed A's NEW bytes, not the stale v1.
    expect(await fs.readFile(path.join(outDir, 'b.txt'), 'utf8')).toBe(aContent(2));

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 5. INTEGRATION: unchanged everything → all reused, zero exec ──────────────────────────────────

describe('runWorkflow journal resume — unchanged → reused, no exec', () => {
  it('re-running an unchanged workflow reuses every node and invokes the builder ZERO times', async () => {
    const spec = wf([n('A', [], ['a.txt']), n('B', ['a.txt'], ['b.txt'])]);
    const outDir = await tmpOut();
    await runWorkflow(compile(spec), { run: 'u', outDir, buildCommand: stubBuilder() });

    const ran = new Set<string>();
    const { status } = await runWorkflow(compile(spec), { run: 'u', outDir, buildCommand: stubBuilder(ran) });

    expect(status.nodes.a.status).toBe('reused');
    expect(status.nodes.b.status).toBe('reused');
    expect(ran.size).toBe(0); // the builder was never invoked — no node executed
    expect(status.ok).toBe(true);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 6. INTEGRATION: hand-edited input file invalidates (kills the existence-only preflight bug) ────

describe('runWorkflow journal resume — hand-edited input file', () => {
  it('overwrite A’s produced artifact between runs → B re-runs (content hash missed)', async () => {
    const spec = wf([n('A', [], ['a.txt']), n('B', ['a.txt'], ['b.txt'])]);
    const outDir = await tmpOut();
    await runWorkflow(compile(spec), { run: 'i', outDir, buildCommand: stubBuilder() });

    // Hand-edit A's produced artifact on disk (simulate a manual edit between runs). The envelope of
    // every node is unchanged; only the bytes of A's output (B's input) differ.
    await fs.writeFile(path.join(outDir, 'a.txt'), 'HAND-EDITED-BYTES');

    const ran = new Set<string>();
    const { status } = await runWorkflow(compile(spec), { run: 'i', outDir, buildCommand: stubBuilder(ran) });

    expect(status.nodes.a.status).toBe('reused'); // A's envelope + (no) inputs unchanged → reused
    expect(status.nodes.b.status).toBe('ok'); // B re-ran: its input (a.txt) content hash missed
    expect(ran.has('b')).toBe(true);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 7. INTEGRATION: crash safety — a non-terminal node is never journaled ──────────────────────────

describe('runWorkflow journal resume — crash safety', () => {
  it('a node that ends error is NOT journaled, and re-runs on resume', async () => {
    const spec = wf([n('A', [], ['a.txt']), n('B', ['a.txt'], ['b.txt']), n('C', ['b.txt'], ['c.txt'])]);
    const outDir = await tmpOut();

    // Run 1: B ends error (nonzero exit) → halt. B and C never finish good. The exec for B returns a
    // nonzero code WITHOUT running the command (no artifact written); every other node runs for real.
    const crashExec: ExecRunner = async (sandbox, cmd, opts) => {
      if (cmd.includes('b.txt')) return { result: { stdout: '', stderr: 'boom', code: 1 }, killed: null };
      return defaultExecRunner(sandbox, cmd, opts);
    };
    const { status: s1 } = await runWorkflow(compile(spec), { run: 'c', outDir, buildCommand: stubBuilder(), execRunner: crashExec });
    expect(s1.nodes.b.status).toBe('error');

    // The journal recorded A (good) but NOT B (error) and NOT C (never ran).
    const j = await loadJournal(outDir);
    expect(j!.nodes.a).toBeDefined();
    expect(j!.nodes.b).toBeUndefined();
    expect(j!.nodes.c).toBeUndefined();

    // Run 2: fix B (normal builder). A is reused; B + C run.
    const ran = new Set<string>();
    const { status: s2 } = await runWorkflow(compile(spec), { run: 'c', outDir, buildCommand: stubBuilder(ran) });
    expect(s2.nodes.a.status).toBe('reused');
    expect(s2.nodes.b.status).toBe('ok');
    expect(s2.nodes.c.status).toBe('ok');
    expect(ran.has('a')).toBe(false);
    expect(ran.has('b')).toBe(true);
    expect(ran.has('c')).toBe(true);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

// ── 8. INTEGRATION: --from override still works (manual stale-prefix pin) ──────────────────────────

describe('runWorkflow journal resume — --from override', () => {
  it('edit A prompt but resume --from B-stage → A stays reused (manual override honored)', async () => {
    const spec = wf([n('A', [], ['a.txt']), n('B', ['a.txt'], ['b.txt'])]);
    const outDir = await tmpOut();
    await runWorkflow(compile(spec), { run: 'f', outDir, buildCommand: stubBuilder() });

    const editedA = { ...n('A', [], ['a.txt']), prompt: 'do A — edited but pinned by --from' };
    const ran = new Set<string>();
    const { status } = await runWorkflow(compile(wf([editedA, n('B', ['a.txt'], ['b.txt'])])), {
      run: 'f', outDir, from: 'b', buildCommand: stubBuilder(ran),
    });

    // --from forces A (a stage < fromIdx) to REUSE despite the envelope edit — the documented escape hatch.
    expect(status.nodes.a.status).toBe('reused');
    expect(ran.has('a')).toBe(false);
    expect(status.nodes.b.status).toBe('ok');

    await fs.rm(outDir, { recursive: true, force: true });
  });

  // REGRESSION — the resume preflight stats each SKIPPED upstream artifact at its TOKENIZED path. A
  // `--from` resume of a tokenized workflow (every real lesson) must resolve `{{arg.*}}`/`{{state.*}}`
  // against the run's args + the persisted `.pi/state.json` BEFORE statting, or every present-on-disk
  // upstream artifact false-reports "missing" and the run hard-HALTs at `__resume__`. (Reproduced live:
  // `--from w4a-composer` blocked on `lesson-data/{{arg.lessonId}}/brief.md` while the resolved file
  // `lesson-data/kptest-count-to-two/brief.md` existed.)
  it('resolves {{arg.*}}/{{state.*}} in skipped-upstream artifact paths before the preflight stat (does NOT false-block)', async () => {
    // setup → voice → composer (3 stages). The first two are SKIPPED on `--from composer`; their declared
    // artifact paths carry tokens. The resolved files exist on disk, so the preflight must NOT block.
    const setup = n('setup', [], ['lesson-data/{{arg.lessonId}}/brief.txt']);
    const voice = n('voice', ['lesson-data/{{arg.lessonId}}/brief.txt'], ['gen/{{state.camel}}Clips.txt']);
    const composer = n('composer', ['gen/{{state.camel}}Clips.txt'], ['out/scene.txt']);
    const spec = wf([setup, voice, composer]);
    const args = { lessonId: 'kp' };

    const outDir = await tmpOut();
    // Persist `.pi/state.json` exactly as a prior run's barrier would have (mirrors runner.test.ts S3),
    // so the resume's `loadState(outDir)` makes `{{state.camel}}` resolvable from t=0.
    await fs.mkdir(piDir(outDir), { recursive: true });
    await fs.writeFile(stateFile(outDir), JSON.stringify({ camel: 'kpCamel' }));

    // Run 1 — full run with the args + persisted state: the stub writes each artifact at its RESOLVED
    // path under outDir (lesson-data/kp/brief.txt, gen/kpCamelClips.txt, out/scene.txt).
    await runWorkflow(compile(spec), { run: 'r', outDir, args, buildCommand: stubBuilder() });
    // Sanity: the resolved upstream files really are on disk (so a "missing" verdict can ONLY be the bug).
    expect((await fs.stat(path.join(outDir, 'lesson-data/kp/brief.txt'))).isFile()).toBe(true);
    expect((await fs.stat(path.join(outDir, 'gen/kpCamelClips.txt'))).isFile()).toBe(true);

    // Run 2 — `--from composer`: setup + voice are SKIPPED. The preflight stats their tokenized artifact
    // paths; with the fix it resolves them against args + state first → present → no block. `noResume`
    // ignores the journal so `composer` (in the selected window) actually RUNs — proving the preflight let
    // execution proceed past the skipped prefix rather than HALTing on it.
    const ran = new Set<string>();
    const { status } = await runWorkflow(compile(spec), {
      run: 'r', outDir, from: 'composer', noResume: true, args, buildCommand: stubBuilder(ran),
    });

    // THE load-bearing assertions: no `__resume__` HALT, the skipped prefix stays force-reused, and the
    // resumed tail ran (the preflight did NOT false-block on the tokenized upstream artifacts).
    expect(status.nodes.__resume__).toBeUndefined();
    expect(status.nodes.setup.status).toBe('reused');
    expect(status.nodes.voice.status).toBe('reused');
    expect(ran.has('setup')).toBe(false);
    expect(ran.has('voice')).toBe(false);
    expect(status.nodes.composer.status).toBe('ok');
    expect(ran.has('composer')).toBe(true);

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
