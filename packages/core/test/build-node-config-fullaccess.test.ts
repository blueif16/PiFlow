import { describe, it, expect } from 'vitest';
import { buildNodeConfig } from '../src/index.js';
import type { NodeSpec } from '../src/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// buildNodeConfig — the per-node `fullAccess` slice (the config mirror).
//
// `fullAccess` is a real per-node EXECUTION knob (jail off for that node), so it earns a place in the
// curated NodeConfig the single observe path mirrors to disk — exactly like the `programmatic` slice it
// parallels. The contract is the SAME minimal-slice discipline as every other field: set `fullAccess:true`
// ONLY when the resolved node carries `sandbox.fullAccess === true`; OMIT the key entirely otherwise (a
// node WITHOUT it must produce a config byte-identical to today — no `undefined`/`false` key written).
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal dense NodeSpec for the config-slice unit (only the fields buildNodeConfig reads). */
function nodeWith(sandbox: Partial<NodeSpec['sandbox']>): NodeSpec {
  return {
    id: 'n',
    label: 'n',
    tools: {},
    io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
    sandbox: {
      provider: 'local',
      workspace: '.',
      read: [],
      write: [],
      output: 'out/n',
      ...sandbox,
    },
  } as unknown as NodeSpec;
}

describe('buildNodeConfig — fullAccess slice (parallels the programmatic carve-out)', () => {
  it('sets fullAccess:true when node.sandbox.fullAccess === true', () => {
    // The node opted its LLM out of the jail → the slice records it so observe/the GUI can read "this node
    // ran unlocked" off config (no separate channel). If buildNodeConfig did not map the flag, the GUI skin
    // would have nothing to render and this fails.
    const cfg = buildNodeConfig(nodeWith({ fullAccess: true }));
    expect(cfg.fullAccess).toBe(true);
  });

  it('OMITS fullAccess entirely when absent (the slice stays minimal — additive)', () => {
    // The additivity guarantee: a node WITHOUT fullAccess produces a slice that does not carry the key AT
    // ALL (not `false`, not `undefined`). `'fullAccess' in cfg` must be false so the on-disk slice is
    // byte-identical to today for every existing node. If the impl wrote `cfg.fullAccess = node.sandbox?.
    // fullAccess` unconditionally, an absent node would carry `fullAccess: undefined` and this fails.
    const cfg = buildNodeConfig(nodeWith({}));
    expect('fullAccess' in cfg).toBe(false);
  });

  it('OMITS fullAccess when sandbox.fullAccess === false (only true sets it)', () => {
    // Loosen-only + minimal-slice: an explicit `false` is the default posture (jailed), so it carries NO
    // marker — identical to absent. Only an explicit `true` opens the slice.
    const cfg = buildNodeConfig(nodeWith({ fullAccess: false }));
    expect('fullAccess' in cfg).toBe(false);
  });
});
