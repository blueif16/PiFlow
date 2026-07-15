// Validation oracle for the template-format JSON Schemas (draft 2020-12) — node.json / meta.json /
// the generated workflow.json (docs/design/template-format.md §3/§5). This is the test a future
// loadTemplate/compile step builds on: it proves the schemas ACCEPT the real authored shape AND
// REJECT malformed ones. The malformed cases are the load-bearing assertions — a too-loose schema
// (e.g. dropping `additionalProperties:false` or a `required`) makes them stop failing, which is the
// exact bug this test exists to catch (verified by the mutation pass in the task report).
//
// We validate with the SAME ajv draft-2020-12 the runner's DRIVER-SCHEMA gate uses
// (src/runner/schema.ts:defaultSchemaValidator) — one validator across the package.

import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeSchema, metaSchema, workflowSchema } from '../src/index.js';
import { defaultSchemaValidator, type SchemaValidator } from '../src/runner/schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TPL = path.join(HERE, 'fixtures', 'template-min');
const NODE_IDS = ['w0-classify', 'w2a-levels', 'w2b-assets'] as const;

const readJson = async (p: string): Promise<unknown> => JSON.parse(await fs.readFile(p, 'utf8'));
const nodePath = (id: string) => path.join(TPL, 'nodes', id, 'node.json');
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

let validate: SchemaValidator;

beforeAll(async () => {
  const v = await defaultSchemaValidator();
  // ajv is installed in this repo (the DRIVER-SCHEMA gate depends on it); fail loud if it ever isn't,
  // rather than silently skipping the whole oracle.
  if (!v) throw new Error('ajv draft-2020-12 did not resolve — the schema oracle cannot run');
  validate = v;
});

describe('template-format schemas — the fixture VALIDATES (accept the real shape)', () => {
  it('meta.json validates', async () => {
    const meta = await readJson(path.join(TPL, 'meta.json'));
    const r = validate(metaSchema as object, meta);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // (docs/design/optimize-blame.md WS-B0) The run-level `optimize` block — the meta.json twin of the
  // node-level block above (node.schema.ts:385), exact per-node symmetry: `measure` (op[], expected-sparse)
  // + `criteria` (soft bar, load-bearing). No `judge` alias, no `verifyDefault` (meta-level-only omissions).
  describe('meta.json optimize block (WS-B0 — the run-level twin)', () => {
    const withMetaOptimize = async (optimize: unknown) => {
      const meta = { ...((await readJson(path.join(TPL, 'meta.json'))) as Record<string, unknown>), optimize };
      return validate(metaSchema as object, meta);
    };
    it('accepts optimize.criteria alone', async () => {
      const r = await withMetaOptimize({ criteria: '{{WORKSPACE}}/criteria.md' });
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
    it('accepts optimize.measure with a real op', async () => {
      const r = await withMetaOptimize({
        measure: [{ id: 'out-non-empty', when: 'post', gate: { kind: 'non-empty', path: '{{RUN}}/out.txt' } }],
      });
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
    it('REJECTS a typo\'d key inside optimize (additionalProperties:false)', async () => {
      const r = await withMetaOptimize({ criterion: 'typo' });
      expect(r.ok).toBe(false);
    });
    it('REJECTS optimize.judge at meta level (no alias at this grain)', async () => {
      const r = await withMetaOptimize({ judge: '{{WORKSPACE}}/judge.md' });
      expect(r.ok).toBe(false);
    });
    it('a meta.json WITHOUT optimize still validates (the block is optional)', async () => {
      const meta = await readJson(path.join(TPL, 'meta.json'));
      const r = validate(metaSchema as object, meta);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
  });

  it('the generated workflow.json validates', async () => {
    const wf = await readJson(path.join(TPL, 'workflow.json'));
    const r = validate(workflowSchema as object, wf);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  for (const id of NODE_IDS) {
    it(`node ${id}/node.json validates`, async () => {
      const node = await readJson(nodePath(id));
      const r = validate(nodeSchema as object, node);
      // Surface the first errors in the assertion message so a real break is debuggable.
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }

  // A3 — the `note` affordance: a strict node.json now has ONE comment slot at the node top-level AND on
  // each op[] entry, so authoring rationale has a home. These ACCEPT cases go RED if `note` is dropped from
  // the schema (additionalProperties:false rejects an unknown key) — the mutation this pins.
  it('a top-level `note` (author rationale) validates', async () => {
    const node = { ...((await readJson(nodePath('w0-classify'))) as Record<string, unknown>), note: 'why this node exists' };
    const r = validate(nodeSchema as object, node);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('an op[] entry carrying a `note` validates', async () => {
    const node = { ...((await readJson(nodePath('w0-classify'))) as Record<string, unknown>) };
    node.op = [{ when: 'post', gate: { kind: 'non-empty', path: 'out.md' }, note: 'runs lesson-measured.mjs, not lesson:check' }];
    const r = validate(nodeSchema as object, node);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // (op-integrity WS-I0) the op envelope gains `expect` (integrity post-conditions) + `resultFile` (the structured
  // verdict/manifest pointer). The ACCEPT cases are the load-bearing RED: until the op schema declares these two
  // keys, additionalProperties:false rejects them (the mutation these pin). The manifest convention: expect targets
  // the resultFile manifest via json-pointer/json-schema; contains-marker is the documented last resort.
  describe('op[] integrity — expect + resultFile (WS-I0)', () => {
    const withOp = async (op: unknown): Promise<ReturnType<SchemaValidator>> => {
      const node = { ...((await readJson(nodePath('w0-classify'))) as Record<string, unknown>), op };
      return validate(nodeSchema as object, node);
    };
    it('accepts a pre-op with expect + a resultFile manifest (the recommended structured predicates)', async () => {
      const r = await withOp([
        {
          when: 'pre',
          writes: ['persona.md'],
          run: { cmd: 'planner-context', args: ['--emit-manifest', 'persona.manifest.json'] },
          resultFile: 'persona.manifest.json',
          onFailure: 'warn',
          expect: [
            { kind: 'min-bytes', path: 'persona.md', param: 200000 },
            { kind: 'json-pointer-exists', path: 'persona.manifest.json', param: { pointer: '/required_kp_ids' } },
            { kind: 'json-pointer-equals', path: 'persona.manifest.json', param: { pointer: '/ok', value: true } },
            { kind: 'json-schema', path: 'persona.manifest.json', param: { schema: { type: 'object', required: ['ok'] } } },
            { kind: 'contains-marker', path: 'persona.md', param: 'required_kp_ids' },
          ],
        },
      ]);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
    it('accepts an expect entry that omits `path` (checks each of the op writes)', async () => {
      const r = await withOp([{ when: 'post', writes: ['a.json', 'b.json'], run: { cmd: 'gen' }, expect: [{ kind: 'json-parses' }] }]);
      expect(r.ok).toBe(true);
    });
    it('REJECTS an expect entry missing `kind` (required)', async () => {
      const r = await withOp([{ when: 'post', run: { cmd: 'gen' }, expect: [{ path: 'x.json' }] }]);
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/kind|required/);
    });
    it('REJECTS an unknown key inside an expect entry (additionalProperties:false)', async () => {
      const r = await withOp([{ when: 'post', run: { cmd: 'gen' }, expect: [{ kind: 'min-bytes', paths: 'typo' }] }]);
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/additional|paths/i);
    });
    it('REJECTS an expect that is not an array', async () => {
      const r = await withOp([{ when: 'post', run: { cmd: 'gen' }, expect: { kind: 'min-bytes' } }]);
      expect(r.ok).toBe(false);
    });
    it('REJECTS a non-string resultFile', async () => {
      const r = await withOp([{ when: 'post', run: { cmd: 'gen' }, resultFile: 42 }]);
      expect(r.ok).toBe(false);
    });
    it('an op with NEITHER expect nor resultFile still validates (both optional — backward compat)', async () => {
      const r = await withOp([{ when: 'post', run: { cmd: 'gen' } }]);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
  });

  // (WS3) The optimizer-facing `optimize` block gains `criteria` (the rename of `judge` — the SHARED bar read
  // by triage + gate) and `verifyDefault` (the node's default per-issue verify tier). `judge` survives as a
  // back-compat READ alias. additionalProperties:false makes the typo/enum cases bite (the mutation these pin).
  describe('optimize block — criteria (judge alias) + verifyDefault (WS3)', () => {
    const withOptimize = async (optimize: unknown) => {
      const node = { ...((await readJson(nodePath('w0-classify'))) as Record<string, unknown>), optimize };
      return validate(nodeSchema as object, node);
    };
    it('accepts optimize.criteria (the renamed bar) + optimize.verifyDefault', async () => {
      const r = await withOptimize({ criteria: '{{WORKSPACE}}/skills/criteria.md', verifyDefault: 'rerun' });
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
    it('STILL accepts optimize.judge (the back-compat read alias)', async () => {
      const r = await withOptimize({ judge: '{{WORKSPACE}}/skills/judge.md' });
      expect(r.ok).toBe(true);
    });
    it('REJECTS an unknown verifyDefault tier (enum bites)', async () => {
      const r = await withOptimize({ verifyDefault: 'sometimes' });
      expect(r.ok).toBe(false);
    });
    it('REJECTS a typo\'d optimize key (additionalProperties:false)', async () => {
      const r = await withOptimize({ criterion: 'typo' });
      expect(r.ok).toBe(false);
    });
  });

  it('the parallel lane is write-disjoint (the §5 invariant the fixture must encode)', async () => {
    const a = (await readJson(nodePath('w2a-levels'))) as { deps: string[]; contract: { owns: string[] } };
    const b = (await readJson(nodePath('w2b-assets'))) as { deps: string[]; contract: { owns: string[] } };
    expect(a.deps).toEqual(b.deps); // same deps …
    expect(a.contract.owns.some((o) => b.contract.owns.includes(o))).toBe(false); // … disjoint owns ⇒ a lane
  });

  // (script-tools) `tools.defs` — the DEFINE-path override map for `tool:<name>` allow entries.
  it('a `tools.defs` map ("tool:<name>" → a tool-dir path) validates', async () => {
    const node = { ...((await readJson(nodePath('w0-classify'))) as Record<string, unknown>) };
    node.tools = { allow: ['read', 'tool:demo_probe'], defs: { 'tool:demo_probe': '{{WORKSPACE}}/tools/demo_probe' } };
    const r = validate(nodeSchema as object, node);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // (script-tools · optional) the OBJECT defs form `{ path, optional }` — presence-based tool offering.
  it('a `tools.defs` OBJECT entry ({ path, optional: true }) validates', async () => {
    const node = { ...((await readJson(nodePath('w0-classify'))) as Record<string, unknown>) };
    node.tools = {
      allow: ['read', 'tool:demo_probe'],
      defs: { 'tool:demo_probe': { path: '{{WORKSPACE}}/tools/demo_probe', optional: true } },
    };
    const r = validate(nodeSchema as object, node);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('template-format schemas — MALFORMED node.json FAILS (the load-bearing assertions)', () => {
  // Each case starts from the REAL valid root node, mutates ONE thing, and asserts the schema rejects
  // it. If any of these passes, the schema is too loose. (These are structural — pure JSON-Schema's job.)
  let base: Record<string, unknown>;
  beforeAll(async () => {
    base = (await readJson(nodePath('w0-classify'))) as Record<string, unknown>;
    // guard: the base we mutate must itself be valid, else a "fail" proves nothing
    expect(validate(nodeSchema as object, base).ok).toBe(true);
  });

  const rejects = (mutate: (n: Record<string, unknown>) => void): ReturnType<SchemaValidator> => {
    const bad = clone(base);
    mutate(bad);
    return validate(nodeSchema as object, bad);
  };

  it('a node missing `id` is rejected', () => {
    const r = rejects((n) => { delete n.id; });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/id/);
  });

  it('a node whose `owns` is not an array is rejected', () => {
    const r = rejects((n) => { (n.contract as Record<string, unknown>).owns = 'spec/**'; });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/owns|array/);
  });

  it('a node missing the core `contract.readScope` is rejected', () => {
    const r = rejects((n) => { delete (n.contract as Record<string, unknown>).readScope; });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/readScope|required/);
  });

  it('an unknown top-level key (a typo like `dep` for `deps`) is rejected', () => {
    const r = rejects((n) => { n.dep = ['w0-classify']; });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/additional|dep/i);
  });

  it('an invalid policy ACTION (outside block|warn|stop) is rejected', () => {
    const r = rejects((n) => { n.policy = { fail: 'retry-forever' }; });
    expect(r.ok).toBe(false);
  });

  it('a promote hook missing `to` (the target channel) is rejected', () => {
    const r = rejects((n) => {
      n.hooks = { promote: [{ from: 'spec/classification.json:archetype', merge: 'set' }] };
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/to|required/);
  });

  // (script-tools) a `tools.defs` value that is not a string is rejected.
  it('a `tools.defs` entry whose value is not a string is rejected', () => {
    const r = rejects((n) => {
      n.tools = { allow: ['tool:demo_probe'], defs: { 'tool:demo_probe': 42 } };
    });
    expect(r.ok).toBe(false);
  });

  // (script-tools · optional) an OBJECT defs entry missing its required `path` is rejected.
  it('a `tools.defs` OBJECT entry missing `path` is rejected', () => {
    const r = rejects((n) => {
      n.tools = { allow: ['tool:demo_probe'], defs: { 'tool:demo_probe': { optional: true } } };
    });
    expect(r.ok).toBe(false);
  });

  // (script-tools · optional) an unknown key inside an OBJECT defs entry (a typo like `option`) is rejected.
  it('a `tools.defs` OBJECT entry with an unknown key (a typo like `option`) is rejected', () => {
    const r = rejects((n) => {
      n.tools = { allow: ['tool:demo_probe'], defs: { 'tool:demo_probe': { path: 'x', option: true } } };
    });
    expect(r.ok).toBe(false);
  });

  // an unknown key inside `tools` (a typo like `allows` for `allow`) is rejected — additionalProperties:false.
  it('an unknown key inside `tools` (a typo like `allows`) is rejected', () => {
    const r = rejects((n) => {
      n.tools = { allows: ['read'] };
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/additional|allows/i);
  });
});

describe('fusion block (Phase 2) — accepts a valid activation, rejects malformed', () => {
  // The fusion block opts a node into the siblings+judge DAG expansion (spec §4). It is the G5
  // `checkpoint` block's twin: a nested object, `additionalProperties:false`, a required enum
  // discriminator (`mode`). The ACCEPT case is the load-bearing RED — until the schema allows the
  // `fusion` key the top-level `additionalProperties:false` rejects it; the malformed cases only become
  // discriminating once a WELL-FORMED fusion validates (else "bad fusion rejected" is vacuously green).
  let base: Record<string, unknown>;
  beforeAll(async () => {
    base = (await readJson(nodePath('w0-classify'))) as Record<string, unknown>;
    expect(validate(nodeSchema as object, base).ok).toBe(true);
  });
  const withFusion = (fusion: unknown): ReturnType<SchemaValidator> => {
    const n = clone(base);
    n.fusion = fusion;
    return validate(nodeSchema as object, n);
  };

  it('a moa fusion block (mode + panel) validates', () => {
    const r = withFusion({ mode: 'moa', panel: ['fast', 'deep'], judge: 'deep' });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('a best-of-n fusion block (mode + n + flags) validates', () => {
    const r = withFusion({ mode: 'best-of-n', n: 3, obligations: true, verify: false });
    expect(r.ok).toBe(true);
  });

  it('a fusion block MISSING `mode` is rejected', () => {
    const r = withFusion({ panel: ['fast', 'deep'] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/mode|required/);
  });

  it('a fusion `mode` outside moa|best-of-n is rejected', () => {
    const r = withFusion({ mode: 'ensemble' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/mode|enum/i);
  });

  it('an unknown key INSIDE fusion (a typo like `pannel`) is rejected', () => {
    const r = withFusion({ mode: 'moa', pannel: ['fast'] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/additional|pannel/i);
  });
});

describe('template referential integrity — a dangling `dep` is caught (loader-level, NOT the schema)', () => {
  // §8: "every dep resolves to a discovered node" is a CROSS-NODE check the compile step owns — JSON
  // Schema can't see the node SET. We assert the property over the fixture so the oracle a loader binds
  // to exists now: the real templates have no dangling deps, and a synthetic dangling dep is detectable.
  it('every fixture dep resolves to a discovered node', async () => {
    const ids = new Set(NODE_IDS);
    for (const id of NODE_IDS) {
      const node = (await readJson(nodePath(id))) as { deps: string[] };
      for (const d of node.deps) expect(ids.has(d as (typeof NODE_IDS)[number])).toBe(true);
    }
  });

  it('a synthetic dangling dep is detectable by the same set check', () => {
    const ids = new Set<string>(NODE_IDS);
    const danglingDep = 'w9-does-not-exist';
    expect(ids.has(danglingDep)).toBe(false); // the loader would reject this node
  });
});
