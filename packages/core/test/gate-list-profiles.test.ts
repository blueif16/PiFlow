// Additive gate LIST + additive PROFILE overlays (docs/design/gate-list-and-additive-profiles.md).
//
// The owner decision: a node's gating is a typed additive LIST `gates: GateEntry[]` (types
// `execution`/`agentic`/`hitl`), lowered at LOAD onto the machinery that already exists — `op[]`/
// `io.checks` (execution), `materializeJudgeNodes` (agentic), the `checkpoint` surface (hitl). A PROFILE
// is a sparse additive overlay file (`template/profiles/<name>.json`) that APPENDS gates to the nodes it
// names. These oracles drive the PUBLIC `loadTemplate` seam:
//
//   • no gates + no profile ⇒ byte-identical compile to today (a captured golden is the witness);
//   • an `agentic` entry ⇒ a real `<id>__judge` node materializes (the existing judge path is reused);
//   • an `execution` entry ⇒ its predicate lands in the node's `io.checks` (a `cmd` ⇒ a run op);
//   • a `hitl` entry ⇒ the node's `checkpoint` is set;
//   • an empty `gates:[]` ⇒ no gates (still byte-identical);
//   • a profile overlay adds the gate ONLY when `--profile` is passed (off by default);
//   • a profile naming an UNKNOWN node ⇒ a LOUD TemplateError;
//   • merge is APPEND (authored + overlay both survive);
//   • a legacy `meta.json` `profiles` map ⇒ a LOUD deprecation warning (never a silent break).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemplate, TemplateError, compile } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'template-min');
const GOLDEN = path.join(HERE, 'fixtures', 'template-min.compiled.golden.json');

const readJson = async (p: string): Promise<any> => JSON.parse(await fs.readFile(p, 'utf8'));
const writeJson = async (p: string, v: unknown): Promise<void> => fs.writeFile(p, JSON.stringify(v, null, 2) + '\n');
const nodeJson = (dir: string, id: string): string => path.join(dir, 'nodes', id, 'node.json');

async function cloneFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-gatelist-'));
  await fs.cp(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Author a `gates[]` list on a node (the new unified surface). */
async function authorGatesOn(dir: string, id: string, gates: unknown[]): Promise<void> {
  const n = await readJson(nodeJson(dir, id));
  n.gates = gates;
  await writeJson(nodeJson(dir, id), n);
}

/** Write an additive profile overlay file `template/profiles/<name>.json`. */
async function writeProfile(dir: string, name: string, overlay: unknown): Promise<void> {
  const pdir = path.join(dir, 'profiles');
  await fs.mkdir(pdir, { recursive: true });
  await writeJson(path.join(pdir, `${name}.json`), overlay);
}

let dir: string;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('gates[] — the additive typed gate list', () => {
  it('no gates + no profile ⇒ compile is BYTE-IDENTICAL to the pre-change golden', async () => {
    dir = await cloneFixture();
    const wf = compile(await loadTemplate(dir));
    const golden = (await fs.readFile(GOLDEN, 'utf8')).trimEnd();
    expect(JSON.stringify(wf, null, 2)).toBe(golden);
  });

  it('an `agentic` gate materializes a real `<id>__judge` node (reuses the judge path)', async () => {
    dir = await cloneFixture();
    // producer tier must differ from the judge tier (the no-self-judge invariant).
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    n.tier = 'fast';
    n.gates = [{ type: 'agentic', judgeTier: 'deep', rubric: 'The classification must be exhaustive.', threshold: '7/10' }];
    await writeJson(nodeJson(dir, 'w0-classify'), n);

    const spec = await loadTemplate(dir);
    const judge = spec.nodes.find((x) => x.label === 'w0-classify__judge');
    expect(judge, 'an agentic gate MUST materialize a `<producer>__judge` node').toBeDefined();
    expect(judge!.agentType).toBe('judge');
    expect(judge!.tier).toBe('deep');
    expect(judge!.prompt).toContain('The classification must be exhaustive');
  });

  it('an `execution` gate (check predicate) lands in the node io.checks', async () => {
    dir = await cloneFixture();
    await authorGatesOn(dir, 'w2b-assets', [{ type: 'execution', check: 'non-empty', path: 'assets/pack.json' }]);
    const spec = await loadTemplate(dir);
    const node = spec.nodes.find((x) => x.label === 'w2b-assets')!;
    const checks = node.io.checks ?? [];
    expect(
      checks.some((c) => c.kind === 'non-empty' && c.path === 'assets/pack.json'),
      'the execution gate predicate must be enforced via io.checks',
    ).toBe(true);
  });

  it('an `execution` gate (cmd script) lowers to a run op on the node', async () => {
    dir = await cloneFixture();
    await authorGatesOn(dir, 'w2b-assets', [{ type: 'execution', cmd: 'npm', args: ['test'] }]);
    const spec = await loadTemplate(dir);
    const node = spec.nodes.find((x) => x.label === 'w2b-assets')!;
    const runOp = (node.op ?? []).find((o) => (o.run as any)?.cmd === 'npm');
    expect(runOp, 'a cmd execution gate must lower to a run op').toBeDefined();
    expect((runOp!.run as any).args).toEqual(['test']);
  });

  it('a `hitl` gate INLINES on the producer (node.gate.checkpoint, NOT node.checkpoint)', async () => {
    // (P3 · MUST-2) A hitl gate now lands on `node.gate.checkpoint` — the INLINE post-model gate — NOT
    // `node.checkpoint` (the standalone no-pi human node that would skip the producer's model at
    // runner.ts dispatch). The behavior DELIBERATELY changed from the pre-P3 standalone-checkpoint mapping.
    dir = await cloneFixture();
    await authorGatesOn(dir, 'w2b-assets', [{ type: 'hitl', question: 'Ship these assets?', checkpointKind: 'confirm' }]);
    const spec = await loadTemplate(dir);
    const node = spec.nodes.find((x) => x.label === 'w2b-assets')!;
    expect(node.checkpoint, 'a hitl gate must NOT set the standalone node.checkpoint (it would skip the model)').toBeUndefined();
    expect(node.gate?.checkpoint, 'a hitl gate must set the INLINE node.gate.checkpoint').toBeDefined();
    expect(node.gate!.checkpoint!.kind).toBe('confirm');
    expect(node.gate!.checkpoint!.prompt).toBe('Ship these assets?');
  });

  it('an EMPTY gates:[] list adds no gates (still byte-identical to the golden)', async () => {
    dir = await cloneFixture();
    await authorGatesOn(dir, 'w2b-assets', []);
    const wf = compile(await loadTemplate(dir));
    const golden = (await fs.readFile(GOLDEN, 'utf8')).trimEnd();
    expect(JSON.stringify(wf, null, 2)).toBe(golden);
  });

  it('a SECOND agentic gate on one node is a LOUD error (single judge slot)', async () => {
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    n.tier = 'fast';
    n.gates = [
      { type: 'agentic', judgeTier: 'deep', rubric: 'r1' },
      { type: 'agentic', judgeTier: 'deep', rubric: 'r2' },
    ];
    await writeJson(nodeJson(dir, 'w0-classify'), n);
    await expect(loadTemplate(dir)).rejects.toThrow(TemplateError);
  });
});

describe('profiles — sparse additive overlay files', () => {
  it('a profile overlay adds an agentic gate ONLY when --profile is passed (off by default)', async () => {
    dir = await cloneFixture();
    // set the producer tier so the overlay judge tier differs.
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    n.tier = 'fast';
    await writeJson(nodeJson(dir, 'w0-classify'), n);
    await writeProfile(dir, 'production', {
      description: 'adds a judge',
      nodes: { 'w0-classify': [{ type: 'agentic', judgeTier: 'deep', rubric: 'Exhaustive + consistent.' }] },
    });

    const bare = await loadTemplate(dir);
    expect(bare.nodes.some((x) => x.label === 'w0-classify__judge'), 'no profile ⇒ no judge').toBe(false);

    const prod = await loadTemplate(dir, { profile: 'production' });
    const judge = prod.nodes.find((x) => x.label === 'w0-classify__judge');
    expect(judge, '--profile production ⇒ the judge materializes').toBeDefined();
    expect(judge!.tier).toBe('deep');
  });

  it('a profile naming an UNKNOWN node is a LOUD TemplateError', async () => {
    dir = await cloneFixture();
    await writeProfile(dir, 'production', {
      nodes: { 'no-such-node': [{ type: 'hitl', question: 'ok?' }] },
    });
    await expect(loadTemplate(dir, { profile: 'production' })).rejects.toThrow(/no-such-node/);
  });

  it('merge is APPEND: an authored execution gate and an overlay agentic gate both survive', async () => {
    dir = await cloneFixture();
    const n = await readJson(nodeJson(dir, 'w0-classify'));
    n.tier = 'fast';
    n.gates = [{ type: 'execution', check: 'non-empty', path: 'spec/classification.json' }];
    await writeJson(nodeJson(dir, 'w0-classify'), n);
    await writeProfile(dir, 'production', {
      nodes: { 'w0-classify': [{ type: 'agentic', judgeTier: 'deep', rubric: 'r' }] },
    });

    const prod = await loadTemplate(dir, { profile: 'production' });
    // authored execution gate survives (in io.checks) AND the overlay agentic gate materialized a judge.
    const node = prod.nodes.find((x) => x.label === 'w0-classify')!;
    expect((node.io.checks ?? []).some((c) => c.kind === 'non-empty' && c.path === 'spec/classification.json')).toBe(true);
    expect(prod.nodes.some((x) => x.label === 'w0-classify__judge')).toBe(true);
  });

  it('a LEGACY meta.json `profiles` map fires a LOUD deprecation warning', async () => {
    dir = await cloneFixture();
    const meta = await readJson(path.join(dir, 'meta.json'));
    meta.profiles = { legacy: { elidePhases: ['build'] } };
    await writeJson(path.join(dir, 'meta.json'), meta);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadTemplate(dir);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/deprecat/i);
  });

  it('a `profiles` map with NO non-empty `elidePhases` does NOT fire the deprecation warning (already migrated)', async () => {
    dir = await cloneFixture();
    const meta = await readJson(path.join(dir, 'meta.json'));
    // A declared profiles map that elides NOTHING (empty predicate + empty elidePhases) — the elidePhases model
    // is not in use, so the deprecation warning (which is about elidePhases) must stay silent. Firing it on mere
    // PRESENCE cries wolf on every already-migrated template. Narrowing to "some profile declares a non-empty
    // elidePhases" is the fix — this asserts the silence.
    meta.profiles = { full: {}, prod: { elidePhases: [] } };
    await writeJson(path.join(dir, 'meta.json'), meta);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadTemplate(dir);
    const deprecationWarned = warn.mock.calls.flat().join(' ').match(/deprecat/i);
    expect(deprecationWarned, 'no non-empty elidePhases ⇒ no deprecation warning').toBeNull();
  });
});
