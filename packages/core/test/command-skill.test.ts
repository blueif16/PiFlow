// defaultPiCommand — `--skill` emission (PURE LOGIC gate, test-discipline §0). The skills lane (option C,
// docs/design/skills-integration.md): the runner stages a node's skill folder into the sandbox and passes its
// in-sandbox path as `ctx.skillPath`; the command builder emits `pi --skill <dir>` so pi loads it explicitly
// (additive even under `--no-skills`, never reliant on `.pi/skills/` auto-discovery surviving the headless set).

import { describe, it, expect } from 'vitest';
import { defaultPiCommand } from '../src/runner/command.js';
import type { NodeSpec, ResolveResult } from '../src/types.js';

// defaultPiCommand reads only ctx/resolved/opts (never `node`), so a bare stub is enough.
const node = {} as NodeSpec;
const resolved: ResolveResult = { piTools: ['read'] };

describe('defaultPiCommand — --skill emission', () => {
  it('emits --skill <quoted path> when ctx.skillPath is set', () => {
    const cmd = defaultPiCommand(node, resolved, { promptFile: 'p.md', skillPath: '/sb/.pi/skills/my-skill' });
    expect(cmd).toContain("--skill '/sb/.pi/skills/my-skill'");
  });

  it('emits NO --skill when ctx.skillPath is absent (additivity: a no-skill node is byte-identical)', () => {
    const cmd = defaultPiCommand(node, resolved, { promptFile: 'p.md' });
    expect(cmd).not.toContain('--skill');
  });
});
