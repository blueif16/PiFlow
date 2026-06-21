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
});
