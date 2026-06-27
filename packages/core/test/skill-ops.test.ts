// resolveSkillStage — PURE LOGIC gate (test-discipline §0). Resolves a node's `skill` ref (a {{WORKSPACE}}-
// rooted / workspace-relative / absolute path to a skill dir) into the source + the staged dir name. The
// runner then stages that source into the sandbox `.pi/skills/<name>/` and points `--skill` at it
// (docs/design/skills-integration.md, option C). Pure: token resolution only, no fs.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveSkillStage } from '../src/workflow/ops/skill.js';
import { computeScopeRoots } from '../src/sandbox/scope.js';
import type { ResolveCtx } from '../src/workflow/resolver.js';

const ctx: ResolveCtx = { run: '/run', workspace: '/ws', state: {}, args: {} };

describe('resolveSkillStage', () => {
  it('resolves a {{WORKSPACE}}-rooted ref to an absolute source + basename name', () => {
    expect(resolveSkillStage('{{WORKSPACE}}/skills/my-skill', ctx)).toEqual({
      source: '/ws/skills/my-skill',
      name: 'my-skill',
    });
  });

  it('resolves a workspace-relative ref against the workspace root', () => {
    expect(resolveSkillStage('skills/foo', ctx)).toEqual({ source: '/ws/skills/foo', name: 'foo' });
  });

  it('passes an absolute ref through unchanged', () => {
    expect(resolveSkillStage('/abs/skills/bar', ctx)).toEqual({ source: '/abs/skills/bar', name: 'bar' });
  });

  it('returns undefined for an absent or blank ref (additivity: a no-skill node resolves to nothing)', () => {
    expect(resolveSkillStage(undefined, ctx)).toBeUndefined();
    expect(resolveSkillStage('   ', ctx)).toBeUndefined();
  });
});

// The jail story (docs/design/skills-integration.md §5): because the runner stages the skill UNDER the
// workdir (`.pi/skills/<name>/`), it falls inside `computeScopeRoots`' workdir read-grant by construction —
// no readScope widening. The negative control proves WHY staging-into-the-workdir is what makes it readable.
describe('skill jail-readability — staged under the workdir ⇒ within readRoots, no readScope widening', () => {
  const workdir = '/sandbox/work';

  it('a skill staged at .pi/skills/<name> under the workdir is within readRoots', () => {
    const roots = computeScopeRoots({ workdir, readScope: [] });
    const staged = path.join(workdir, '.pi', 'skills', 'my-skill');
    expect(roots.readRoots).toContain(path.resolve(workdir));
    expect(staged.startsWith(path.resolve(workdir))).toBe(true); // ⇒ a jailed read of SKILL.md is granted
  });

  it('a host-resident skill OUTSIDE the workdir is NOT in readRoots unless explicitly readScoped (why we stage in)', () => {
    const roots = computeScopeRoots({ workdir, readScope: [] });
    const hostSkill = '/home/user/.piflow/skills/my-skill';
    expect(roots.readRoots.some((r) => hostSkill.startsWith(r))).toBe(false);
  });
});
