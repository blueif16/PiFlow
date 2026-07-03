import { describe, it, expect } from 'vitest';
import { buildNodeConfig } from '../src/index.js';
import type { NodeSpec } from '../src/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// buildNodeConfig — the per-node `skill` slice (the config mirror).
//
// The SKILL a node loads is part of what DEFINES the agent (loadout = skills + tools — the expert-
// representations contract), so it earns a place in the curated NodeConfig the single observe path mirrors
// to disk: the GUI's agent hover card renders "available skills" off config, never a template side-channel.
// Same minimal-slice discipline as every field: set `skill` ONLY when the resolved node carries one; OMIT
// the key entirely otherwise (a skill-less node's slice stays byte-identical to today).
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal dense NodeSpec for the config-slice unit (only the fields buildNodeConfig reads). */
function nodeWith(extra: Partial<NodeSpec>): NodeSpec {
  return {
    id: 'n',
    label: 'n',
    tools: {},
    io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
    sandbox: { provider: 'local', workspace: '.', read: [], write: [], output: 'out/n' },
    ...extra,
  } as unknown as NodeSpec;
}

describe('buildNodeConfig — skill slice (the loadout half the config was missing)', () => {
  it('carries node.skill verbatim onto the config slice', () => {
    // The node runs with a skill (mergePreset fallback or its own authoring) → the slice records it so the
    // observe plane carries "what this agent loaded" and the hover card renders it. If buildNodeConfig did
    // not map the field, the GUI would have nothing to render and this fails.
    const cfg = buildNodeConfig(nodeWith({ skill: '{{WORKSPACE}}/packages/skills/harden-blueprint/SKILL.md' }));
    expect(cfg.skill).toBe('{{WORKSPACE}}/packages/skills/harden-blueprint/SKILL.md');
  });

  it('OMITS skill entirely when the node has none (the slice stays minimal — additive)', () => {
    // `'skill' in cfg` must be false so the on-disk slice is byte-identical to today for every existing
    // skill-less node (not `undefined`, not `""`).
    const cfg = buildNodeConfig(nodeWith({}));
    expect('skill' in cfg).toBe(false);
  });
});
