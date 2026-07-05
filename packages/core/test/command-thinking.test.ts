// defaultPiCommand / claudeCommand — PER-NODE thinking cap (PURE LOGIC gate, test-discipline §0).
//
// A node may declare `thinking` in node.json (off|minimal|low|medium|high|xhigh) to cap ITS OWN reasoning
// depth WITHOUT an operator flag — the SDK forwards it to `pi --thinking` (and claude `--effort`),
// OVERRIDING the run-level thinking. This is the operator-free fix for the producer over-think stall
// (game-omni gameplay: a thinking-heavy model composes the whole artifact in its thinking channel, blows the
// output cap, never writes — `thinking:"minimal"` caps it). Mirrors per-node model/provider/tier.
//
// The "node wins" cases FAIL before the builders read node.thinking (today they emit only opts.thinking).

import { describe, it, expect } from 'vitest';
import { defaultPiCommand, claudeCommand } from '../src/runner/command.js';
import type { NodeSpec, ResolveResult } from '../src/types.js';

const resolved: ResolveResult = { piTools: ['read'] };
const ctx = { promptFile: 'p.md' };
// cast: the field is added in GREEN; the RED behavior is the builder ignoring node.thinking.
const nodeWith = (thinking?: string) => ({ thinking } as unknown as NodeSpec);

describe('defaultPiCommand — per-node thinking overrides run-level (pi --thinking)', () => {
  it('node.thinking WINS over the run-level opts.thinking', () => {
    const cmd = defaultPiCommand(nodeWith('minimal'), resolved, ctx, { thinking: 'low' });
    expect(cmd).toContain('--thinking minimal');
    expect(cmd).not.toContain('--thinking low');
  });

  it('falls back to run-level opts.thinking when the node declares none', () => {
    const cmd = defaultPiCommand(nodeWith(undefined), resolved, ctx, { thinking: 'low' });
    expect(cmd).toContain('--thinking low');
  });

  it('emits no --thinking when neither the node nor the run sets it', () => {
    const cmd = defaultPiCommand(nodeWith(undefined), resolved, ctx, {});
    expect(cmd).not.toContain('--thinking');
  });
});

describe('claudeCommand — per-node thinking maps to --effort (claude-code executor)', () => {
  it('node.thinking (a valid effort) overrides run-level → --effort', () => {
    const cmd = claudeCommand(nodeWith('high'), resolved, ctx, { thinking: 'low' });
    expect(cmd).toContain('--effort high');
    expect(cmd).not.toContain('--effort low');
  });
});
