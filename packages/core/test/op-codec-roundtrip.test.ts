// (M5 · G13) op-codec-roundtrip — the LOSSLESS-PROFILE proof. A node authored in the new `op[]` envelope
// must round-trip through the DRIVER-* marker codec without loss: markersFromNode(opNode) carries `op`, and
// emitMarkers → parseMarkers recovers the IDENTICAL op[]. This is what lets the loader render a node's
// realized prompt AND re-read the node back (the run.mjs marker grammar the fusion judge carry depends on).
//
// Written test-first against the absent `DRIVER-OP` marker: today `markersFromNode` never reads `node.op`,
// `emitMarkers` never writes a DRIVER-OP line, and `parseMarkers` never recovers it — so the round-trip
// DROPS the op[] (RED for the right reason: no codec support for the new shape).

import { describe, it, expect } from 'vitest';
import { markersFromNode, emitMarkers, parseMarkers } from '../src/contract.js';
import type { NodeSpec, OpSpec } from '../src/types.js';

/** A dense NodeSpec carrying a representative op[] (one of each body + a body-less inject-fold op). */
function opNode(op: OpSpec[]): NodeSpec {
  return {
    id: 'verify',
    label: 'verify',
    prompt: 'do it',
    sandbox: { provider: 'inmemory', workspace: '.', read: [], write: [], output: 'out/verify' },
    tools: {},
    io: { reads: [], produces: ['out/report.json'], artifacts: [{ path: 'out/report.json' }] },
    op,
  };
}

describe('op-codec-roundtrip — the op[] envelope is a LOSSLESS codec profile', () => {
  it('markersFromNode → emitMarkers → parseMarkers recovers the IDENTICAL op[]', () => {
    const op: OpSpec[] = [
      { when: 'pre', reads: ['{{RUN}}/spec/request.json'] },
      { when: 'pre', writes: ['spec/seed.json'], transform: { kind: 'seed', from: '{{WORKSPACE}}/seed.json' } },
      { when: 'pre', gate: { kind: 'json-parses', path: 'spec/request.json' }, onFailure: 'block' },
      { when: 'post', writes: ['out/report.json'], run: { cmd: 'node', args: ['lint.mjs'] }, onFailure: 'warn' },
      { when: 'on-failure', action: { kind: 'escalate', via: 'deep', evidence: ['out/report.json'] } },
    ];

    const node = opNode(op);
    const markers = markersFromNode(node);
    // The codec must SURFACE op[] (RED today: markersFromNode never reads node.op).
    expect(markers.op, 'markersFromNode must carry op[]').toEqual(op);

    // The full text round-trip: emit the marker block, re-parse it, recover the identical op[].
    const text = emitMarkers(markers);
    expect(text, 'a DRIVER-OP marker line must be emitted').toMatch(/^DRIVER-OP:/m);
    const reparsed = parseMarkers(text);
    expect(reparsed.op, 'parseMarkers must recover the identical op[]').toEqual(op);
  });
});
