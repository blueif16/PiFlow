import { describe, it, expect } from 'vitest';
import { emitMarkers, parseMarkers, markersFromNode, compile } from '../src/index.js';
import type { ContractMarkers, WorkflowSpec } from '../src/index.js';

describe('DRIVER-* marker codec', () => {
  it('round-trips a full marker set (emit → parse)', () => {
    const m: ContractMarkers = {
      artifacts: ['out/a.json', 'out/b.md'],
      owns: ['src/x', 'src/y'],
      readScope: ['/repo/src', '/repo/data'],
      tools: ['read', 'bash'],
      excludeTools: ['write'],
      seed: [{ to: 'out/tpl.json', from: 'templates/tpl.json' }],
      schema: [{ path: 'out/a.json', schema: 'schemas/a.schema.json' }],
    };
    expect(parseMarkers(emitMarkers(m))).toEqual(m);
  });

  it('emits nothing for an empty set and parses back to empty', () => {
    expect(emitMarkers({})).toBe('');
    expect(parseMarkers('a prompt with no markers')).toEqual({});
  });

  it('ignores prose around the markers', () => {
    const prompt = `Do the thing.\n\nDRIVER-ARTIFACTS: out/x.json\nDRIVER-TOOLS: read,write\n\nThanks.`;
    expect(parseMarkers(prompt)).toEqual({ artifacts: ['out/x.json'], tools: ['read', 'write'] });
  });

  // DRIVER-TOOLS is authored SPACE-separated in the wild (run.mjs's markerPaths splits on whitespace,
  // like every other DRIVER-* marker), not just comma. Parsing it comma-only collapses the whole list
  // to ONE token → pi binds only the first tool and treats the rest as positional args → the node can't
  // write → the gate-3 W0 "never-write". The parser must tokenize on whitespace AND comma.
  it('tokenizes DRIVER-TOOLS on whitespace as well as commas', () => {
    expect(parseMarkers('DRIVER-TOOLS: read ls write bash submit_result').tools)
      .toEqual(['read', 'ls', 'write', 'bash', 'submit_result']);
    expect(parseMarkers('DRIVER-EXCLUDE-TOOLS: write   bash').excludeTools).toEqual(['write', 'bash']);
    // mixed / comma still works (emitMarkers writes commas) — round-trip preserved
    expect(parseMarkers('DRIVER-TOOLS: read, ls,  bash').tools).toEqual(['read', 'ls', 'bash']);
  });

  it('round-trips the unified-contract markers (checks/policy/returnMode/fillSentinel)', () => {
    const m: ContractMarkers = {
      artifacts: ['spec/blueprint.json'],
      checks: [
        { kind: 'count-floor', path: 'spec/blueprint.json', param: { path: 'milestones', min: 3 }, severity: 'fail' },
        { kind: 'regex-absent', path: 'spec/blueprint.json', param: '<FILL:', severity: 'fail' },
      ],
      policy: { fail: 'block', warn: 'warn' },
      returnMode: 'optional',
      fillSentinel: '<FILL:',
    };
    // base64-on-one-line survives a round-trip (the param objects/regex come back identical).
    expect(parseMarkers(emitMarkers(m))).toEqual(m);
  });

  it('DRIVER-CHECKS tolerates an inline-JSON value (a hand-authored marker, not base64)', () => {
    const prompt = `DRIVER-CHECKS: [{"kind":"non-empty","path":"out/a.json"}]`;
    expect(parseMarkers(prompt)).toEqual({ checks: [{ kind: 'non-empty', path: 'out/a.json' }] });
  });

  // U7 — the `promote` POST-op marker (DRIVER-PROMOTE), a sibling of DRIVER-SEED. One line per promote:
  // `DRIVER-PROMOTE: <channel> <= <from> [merge=<reducer>]`. The default reducer is `set` (omitted on emit).
  it('round-trips DRIVER-PROMOTE markers (artifact + @return sources, all three reducers)', () => {
    const m: ContractMarkers = {
      artifacts: ['spec/classification.json'],
      promote: [
        { from: 'spec/classification.json:archetype', to: 'archetype', merge: 'set' },
        { from: '@return:milestones', to: 'milestones', merge: 'append' },
        { from: '@return:cfg', to: 'cfg', merge: 'deepMerge' },
      ],
    };
    expect(parseMarkers(emitMarkers(m))).toEqual(m);
  });

  it('DRIVER-PROMOTE defaults an omitted reducer to set on parse', () => {
    // The W0 canonical case: `promote: [{ from: 'spec/classification.json:archetype', to: 'archetype' }]`.
    const parsed = parseMarkers('DRIVER-PROMOTE: archetype <= spec/classification.json:archetype');
    expect(parsed.promote).toEqual([
      { from: 'spec/classification.json:archetype', to: 'archetype', merge: 'set' },
    ]);
  });

  it('emitMarkers omits merge=set (the default) but emits an explicit append/deepMerge', () => {
    const out = emitMarkers({
      promote: [
        { from: 'a.json:x', to: 'x', merge: 'set' },
        { from: '@return:y', to: 'y', merge: 'append' },
      ],
    });
    expect(out).toContain('DRIVER-PROMOTE: x <= a.json:x');
    expect(out).not.toContain('x <= a.json:x merge=set'); // default reducer not written
    expect(out).toContain('DRIVER-PROMOTE: y <= @return:y merge=append');
  });
});

describe('markersFromNode', () => {
  it('derives artifacts/owns/readScope/schema/tools from a compiled node', () => {
    const spec: WorkflowSpec = {
      meta: { name: 't', description: 'd' },
      nodes: [
        {
          label: 'Build',
          prompt: 'build it',
          tools: {},
          sandbox: { read: ['/repo/src'], write: ['out/dist'] },
          io: {
            reads: [],
            produces: ['out/dist/app.js'],
            artifacts: [{ path: 'out/dist/app.js', schema: 'schemas/app.json' }],
          },
        },
      ],
    };
    const node = compile(spec).nodes['build'];
    expect(node).toBeDefined();
    const markers = markersFromNode(node!, { piTools: ['read', 'bash'] });
    expect(markers).toEqual({
      artifacts: ['out/dist/app.js'],
      schema: [{ path: 'out/dist/app.js', schema: 'schemas/app.json' }],
      owns: ['out/dist'],
      readScope: ['/repo/src'],
      tools: ['read', 'bash'],
    });
    // and it round-trips through the codec
    expect(parseMarkers(emitMarkers(markers))).toEqual(markers);
  });

  it('derives checks/policy/returnMode/fillSentinel from a node that declares them', () => {
    const spec: WorkflowSpec = {
      meta: { name: 't', description: 'd' },
      nodes: [
        {
          label: 'Harden',
          prompt: 'harden it',
          tools: {},
          io: {
            reads: [],
            produces: ['spec/blueprint.json'],
            artifacts: [{ path: 'spec/blueprint.json' }],
            checks: [{ kind: 'count-floor', path: 'spec/blueprint.json', param: { path: 'milestones', min: 3 } }],
            policy: { fail: 'block' },
            returnMode: 'optional',
            fillSentinel: '<FILL:',
          },
        },
      ],
    };
    const node = compile(spec).nodes['harden'];
    const markers = markersFromNode(node!, { piTools: [] });
    expect(markers.checks).toEqual([{ kind: 'count-floor', path: 'spec/blueprint.json', param: { path: 'milestones', min: 3 } }]);
    expect(markers.policy).toEqual({ fail: 'block' });
    expect(markers.returnMode).toBe('optional');
    expect(markers.fillSentinel).toBe('<FILL:');
    expect(parseMarkers(emitMarkers(markers))).toEqual(markers);
  });
});

// ── T3 (U6b): round-trip the three node.json fields the codec didn't cover ──────────────────────────
// The marker grammar already carried a FLAT `checks: Check[]` (the runtime post-checks), `policy`, and
// `returnMode` (the handshake). What it did NOT carry are the AUTHORING-shape fields of node.json
// (template-format.md §3): the `checks: {pre, post}` STRUCTURE (the flat marker collapses pre/post), and
// the `return` JSON-Schema for the structured fenced-JSON result (distinct from `returnMode`). These are
// what `markersFromNode → parseMarkers` must now reproduce identically.
describe('T3 codec — checks{pre,post} / policy / return round-trip', () => {
  // (1) checks{pre,post} — the authoring STRUCTURE survives (a flat marker would lose which lane a check
  // is in). Non-trivial: a pre-check AND a post-check, each with kind/path/param/severity.
  it('round-trips a node with non-trivial checks{pre,post} (identity)', () => {
    const spec: WorkflowSpec = {
      meta: { name: 't', description: 'd' },
      nodes: [
        {
          label: 'Harden',
          prompt: 'harden it',
          tools: {},
          io: {
            reads: [],
            produces: ['spec/blueprint.json'],
            artifacts: [{ path: 'spec/blueprint.json' }],
            checksPrePost: {
              pre: [{ kind: 'exists', path: 'spec/gdd.md', severity: 'fail' }],
              post: [
                { kind: 'count-floor', path: 'spec/blueprint.json', param: { path: 'milestones', min: 3 }, severity: 'fail' },
                { kind: 'regex-absent', path: 'spec/blueprint.json', param: '<FILL:', severity: 'warn' },
              ],
            },
          },
        },
      ],
    };
    const node = compile(spec).nodes['harden'];
    const markers = markersFromNode(node!, { piTools: [] });
    expect(markers.checksPrePost).toEqual({
      pre: [{ kind: 'exists', path: 'spec/gdd.md', severity: 'fail' }],
      post: [
        { kind: 'count-floor', path: 'spec/blueprint.json', param: { path: 'milestones', min: 3 }, severity: 'fail' },
        { kind: 'regex-absent', path: 'spec/blueprint.json', param: '<FILL:', severity: 'warn' },
      ],
    });
    // the WHOLE thing survives emit → parse byte-for-byte
    const round = parseMarkers(emitMarkers(markers));
    expect(round.checksPrePost).toEqual(markers.checksPrePost);
    expect(round).toEqual(markers);
  });

  // (4) Policy vocabulary: aligned to the runtime PolicyAction enum (block | warn | stop). `stop` (a
  // runtime-only action with NO §3-prose equivalent) must round-trip — proving the chosen vocabulary.
  it('round-trips policy in the runtime vocabulary (block | warn | stop), incl. `stop`', () => {
    const m: ContractMarkers = { policy: { fail: 'stop', warn: 'warn' } };
    expect(parseMarkers(emitMarkers(m)).policy).toEqual({ fail: 'stop', warn: 'warn' });
    // every other runtime action too
    expect(parseMarkers(emitMarkers({ policy: { fail: 'block' } })).policy).toEqual({ fail: 'block' });
  });

  // (1) return — the structured-result JSON-Schema (node.json `return`), DISTINCT from `returnMode`.
  it('round-trips a node with a `return` JSON-Schema (identity)', () => {
    const ret = {
      type: 'object',
      required: ['archetype', 'coreLoop'],
      properties: {
        archetype: { type: 'string', enum: ['platformer', 'voxel_sandbox'] },
        coreLoop: { type: 'string' },
        scopeCut: { type: 'array', items: { type: 'string' } },
      },
    };
    const spec: WorkflowSpec = {
      meta: { name: 't', description: 'd' },
      nodes: [
        {
          label: 'Classify',
          prompt: 'classify it',
          tools: {},
          io: {
            reads: [],
            produces: ['spec/classification.json'],
            artifacts: [{ path: 'spec/classification.json' }],
            returnSchema: ret,
          },
        },
      ],
    };
    const node = compile(spec).nodes['classify'];
    const markers = markersFromNode(node!, { piTools: [] });
    expect(markers.returnSchema).toEqual(ret);
    const round = parseMarkers(emitMarkers(markers));
    expect(round.returnSchema).toEqual(ret);
    expect(round).toEqual(markers);
  });

  // returnMode and the return SCHEMA are independent markers — both present, both survive, no collision.
  it('keeps returnMode and the return schema as independent markers', () => {
    const m: ContractMarkers = {
      returnMode: 'required',
      returnSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    };
    const round = parseMarkers(emitMarkers(m));
    expect(round.returnMode).toBe('required');
    expect(round.returnSchema).toEqual({ type: 'object', properties: { ok: { type: 'boolean' } } });
    expect(round).toEqual(m);
  });

  // all three together on one node → markersFromNode → parseMarkers deep-equals the originals.
  it('round-trips checks{pre,post} + policy + return all on one node (full identity)', () => {
    const ret = { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' } } };
    const spec: WorkflowSpec = {
      meta: { name: 't', description: 'd' },
      nodes: [
        {
          label: 'Verify',
          prompt: 'verify it',
          tools: {},
          io: {
            reads: ['spec/blueprint.json'],
            externalInputs: ['spec/blueprint.json'],
            produces: ['spec/DESIGN_REVIEW.md'],
            artifacts: [{ path: 'spec/DESIGN_REVIEW.md' }],
            checksPrePost: {
              pre: [{ kind: 'json-parses', path: 'spec/blueprint.json', severity: 'fail' }],
              post: [{ kind: 'regex-present', path: 'spec/DESIGN_REVIEW.md', param: 'DESIGN_(PASSED|FAILED)', severity: 'fail' }],
            },
            policy: { fail: 'stop', warn: 'warn' },
            returnSchema: ret,
          },
        },
      ],
    };
    const node = compile(spec).nodes['verify'];
    const markers = markersFromNode(node!, { piTools: [] });
    const round = parseMarkers(emitMarkers(markers));
    expect(round.checksPrePost).toEqual(markers.checksPrePost);
    expect(round.policy).toEqual({ fail: 'stop', warn: 'warn' });
    expect(round.returnSchema).toEqual(ret);
    expect(round).toEqual(markers);
  });

  // (3) Additive / no-regression: a node WITHOUT checks/policy/return emits NONE of the new markers and
  // round-trips exactly as before — the base contract bytes for unrelated fields stay stable.
  it('a node without checks{pre,post}/policy/return emits no new markers (no regression)', () => {
    const spec: WorkflowSpec = {
      meta: { name: 't', description: 'd' },
      nodes: [
        {
          label: 'Plain',
          prompt: 'plain',
          tools: {},
          sandbox: { read: ['/repo/src'], write: ['out/x'] },
          io: { reads: [], produces: ['out/x/a.js'], artifacts: [{ path: 'out/x/a.js' }] },
        },
      ],
    };
    const node = compile(spec).nodes['plain'];
    const markers = markersFromNode(node!, { piTools: ['read'] });
    expect(markers.checksPrePost).toBeUndefined();
    expect(markers.returnSchema).toBeUndefined();
    const text = emitMarkers(markers);
    expect(text).not.toContain('DRIVER-CHECKS-PREPOST');
    expect(text).not.toContain('DRIVER-RETURN-SCHEMA');
    expect(parseMarkers(text)).toEqual(markers);
  });
});
