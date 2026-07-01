import { describe, it, expect } from 'vitest';
import { summarizeGates, buildNodeConfig } from '../src/index.js';
import type { NodeSpec, OpSpec, CheckpointSpec } from '../src/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// summarizeGates — the POLICY-channel distiller: a node's canonical op[] (+ G5 checkpoint) folded into the
// LEGIBLE post-node consequence chain the single observe path mirrors, so the GUI/TUI/optimizer render
// "what happens after this node" without re-parsing the template. These pin the fold and the minimal-slice
// rule; each fails if the mapping regresses (wrong kind/label/onFail/when, or a plumbing op leaking in).
// ─────────────────────────────────────────────────────────────────────────────

/** A dense NodeSpec carrying only the fields summarizeGates reads (op[] + checkpoint). */
function nodeWith(op?: OpSpec[], checkpoint?: CheckpointSpec): NodeSpec {
  return {
    id: 'n',
    label: 'n',
    tools: {},
    io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
    sandbox: { provider: 'local', workspace: '.', read: [], write: [], output: 'out/n' },
    ...(op ? { op } : {}),
    ...(checkpoint ? { checkpoint } : {}),
  } as unknown as NodeSpec;
}

describe('summarizeGates — op[] + checkpoint → the legible consequence chain', () => {
  it('folds gate/run/action bodies in authored order with their on-fail policy + when', () => {
    // A realistic cost-ladder chain: a deterministic floor check, an execution gate that only WARNS on fail,
    // and a judge-fail reroute back to the producer. If the fold dropped the policy (onFail) or the order,
    // the GUI would render a wrong "what happens after" and this fails.
    const s = summarizeGates(
      nodeWith([
        { when: 'post', gate: { kind: 'non-empty' } },
        { when: 'post', run: { cmd: 'npm', args: ['test'] }, onFailure: 'warn' },
        { when: 'on-failure', action: { kind: 'rerouteTo', node: 'n', max: 2 } },
      ]),
    );
    expect(s?.entries).toEqual([
      { kind: 'check', label: 'non-empty', when: 'post', onFail: 'block' }, // default onFailure = block
      { kind: 'exec', label: 'npm test', when: 'post', onFail: 'warn' },
      { kind: 'reroute', label: 'reroute→n ×2', when: 'on-failure' },
    ]);
    expect(s?.checkpoint).toBeUndefined();
  });

  it('appends the G5 human checkpoint LAST and records its kind (cost-ladder: a person is spent last)', () => {
    const s = summarizeGates(
      nodeWith([{ when: 'post', gate: { kind: 'json-parses' } }], { kind: 'confirm', prompt: 'Approve?' }),
    );
    expect(s?.entries.at(-1)).toEqual({ kind: 'human', label: 'confirm', when: 'post' });
    expect(s?.checkpoint).toBe('confirm');
  });

  it('EXCLUDES transform (plumbing) ops — seed/project/merge/promote are not gates', () => {
    // A node whose only op is a seed transform has NO consequence chain to show. If the fold treated
    // transforms as gates, this would return a bogus entry and fail.
    const s = summarizeGates(nodeWith([{ when: 'pre', transform: { kind: 'seed', from: 'x' } }]));
    expect(s).toBeUndefined();
  });

  it('carries advisory (non-blocking) gates through', () => {
    const s = summarizeGates(nodeWith([{ when: 'post', gate: { kind: 'non-empty', advisory: true } }]));
    expect(s?.entries[0]).toMatchObject({ kind: 'check', advisory: true });
  });

  it('returns undefined for a gate-less, checkpoint-less node (the minimal-slice rule)', () => {
    expect(summarizeGates(nodeWith())).toBeUndefined();
  });

  it('rides the curated NodeConfig slice via buildNodeConfig — and is OMITTED when empty', () => {
    // The end-to-end contract: observe passes `config` verbatim, so a node's gates reach the GUI iff
    // buildNodeConfig attached them. With gates → present; without → the key is absent (byte-identical slice).
    const withGates = buildNodeConfig(nodeWith([{ when: 'post', gate: { kind: 'non-empty' } }]));
    expect(withGates.gates?.entries[0]).toMatchObject({ kind: 'check', label: 'non-empty' });
    const without = buildNodeConfig(nodeWith());
    expect('gates' in without).toBe(false);
  });
});
