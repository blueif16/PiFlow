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

// REGRESSION (skill-staging collision race): `prompt.skill` (node.schema.ts) is documented as "a SKILL.md
// pointer", so a template legitimately authors the ref as `.../<skill-dir>/SKILL.md` (a FILE), not the skill
// DIR. Every Agent-Skill file is named "SKILL.md" by convention, so basenaming the FILE directly collapses
// every such node's staged `name` to the literal string "SKILL.md" — every skill-bearing sibling in a
// parallel stage then stages into the SAME `.pi/skills/SKILL.md` destination and races `fs.cp` on it
// (observed: `ENOENT ... chmod/unlink/open '<run>/.pi/skills/SKILL.md'` when 2+ land at once — reproduced in
// runner-skill-collision.test.ts). The fix: a `.../SKILL.md` ref must basename its OWNING DIRECTORY, not the
// file, so the staged name matches what a directory ref for the SAME skill would already produce.
describe('resolveSkillStage — FILE-style refs (a `.../SKILL.md` pointer) stay collision-free', () => {
  it('a `.../SKILL.md` file ref names the skill by its OWNING DIRECTORY, not the shared "SKILL.md" filename', () => {
    expect(resolveSkillStage('{{WORKSPACE}}/skills/my-skill/SKILL.md', ctx)).toEqual({
      source: '/ws/skills/my-skill/SKILL.md',
      name: 'my-skill',
    });
  });

  it('is case-insensitive on the "SKILL.md" filename (authors may write Skill.md)', () => {
    expect(resolveSkillStage('{{WORKSPACE}}/skills/other/Skill.md', ctx)).toEqual({
      source: '/ws/skills/other/Skill.md',
      name: 'other',
    });
  });

  it('two DIFFERENT skills referenced as `.../SKILL.md` files resolve to DIFFERENT names (never collide)', () => {
    const a = resolveSkillStage('{{WORKSPACE}}/skills/author-guidance/SKILL.md', ctx);
    const b = resolveSkillStage('{{WORKSPACE}}/skills/author-shell/SKILL.md', ctx);
    expect(a?.name).not.toBe(b?.name);
    expect(a?.name).toBe('author-guidance');
    expect(b?.name).toBe('author-shell');
  });

  it('a directory ref and the SAME skill\'s `.../SKILL.md` file ref agree on the staged name', () => {
    const dirRef = resolveSkillStage('{{WORKSPACE}}/skills/my-skill', ctx);
    const fileRef = resolveSkillStage('{{WORKSPACE}}/skills/my-skill/SKILL.md', ctx);
    expect(fileRef?.name).toBe(dirRef?.name);
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
