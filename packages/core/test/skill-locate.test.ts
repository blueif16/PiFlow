// Skill LOCATION — the impure twin of `resolveSkillStage` (P0 skill-resolution unification). A BARE id
// (no separator, not absolute, no {{token}}) searches the two PROJECT-LOCAL rings — Ring 0 `<workspace>/
// .agents/skills/<id>`, then Ring 1 `<workspace>/.claude/skills/<id>` (where `piflowctl skills install`
// lands them) — accepting only a dir that CONTAINS a SKILL.md; a PATH-LIKE ref keeps `resolveSkillStage`'s
// exact semantics (byte-identical source). `skillSearchRoots` is the single-source-of-truth ordering the
// server display path must share; `listSkills` enumerates both rings (`.agents/skills` wins an id clash;
// the shadowed `.claude/skills` entry is still reported, flagged).
//
// NEVER the global `~/.piflow/skills` — skill resolution is ALWAYS project-local (both rings hang off the
// product-root workspace), so a run is reproducible from the product alone with no machine-global state.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSkillStage } from '../src/workflow/ops/skill.js';
import { locateSkillStage, skillSearchRoots, listSkills } from '../src/workflow/ops/skill-locate.js';
import type { ResolveCtx } from '../src/workflow/resolver.js';

let WS: string; // workspace = the product root; BOTH rings hang off it

beforeEach(async () => {
  WS = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-skill-ws-'));
});
afterEach(async () => {
  await fs.rm(WS, { recursive: true, force: true });
});

const ctx = (): ResolveCtx => ({ run: path.join(WS, 'out', 'r1'), workspace: WS });

/** Write a minimal Agent-Skill bundle at `dir` (a SKILL.md with the given frontmatter lines). */
async function writeSkill(dir: string, fm = 'name: x\ndescription: a skill\n'): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${fm}---\nBody.\n`);
}

describe('skillSearchRoots — the ONE ring ordering, BOTH project-local (never global)', () => {
  it('returns [<workspace>/.agents/skills, <workspace>/.claude/skills] in that order', () => {
    expect(skillSearchRoots(WS)).toEqual([
      path.join(WS, '.agents', 'skills'),
      path.join(WS, '.claude', 'skills'),
    ]);
  });

  it('is a pure function of the workspace root — no home/global path anywhere in the roots', () => {
    for (const root of skillSearchRoots(WS)) {
      expect(root.startsWith(WS)).toBe(true);
      expect(root).not.toContain('.piflow');
    }
  });
});

describe('locateSkillStage — BARE id searches the two project rings', () => {
  it('finds a bare id in the .agents/skills ring (<workspace>/.agents/skills/<id>)', async () => {
    const dir = path.join(WS, '.agents', 'skills', 'research');
    await writeSkill(dir);
    const r = await locateSkillStage('research', ctx());
    expect(r).toEqual({ found: true, stage: { source: dir, name: 'research' } });
  });

  it('finds a bare id in the .claude/skills ring when the .agents/skills ring misses', async () => {
    const dir = path.join(WS, '.claude', 'skills', 'installed-only');
    await writeSkill(dir);
    const r = await locateSkillStage('installed-only', ctx());
    expect(r).toEqual({ found: true, stage: { source: dir, name: 'installed-only' } });
  });

  it('.agents/skills SHADOWS .claude/skills: when both rings carry the id, the .agents hit wins', async () => {
    const agentsDir = path.join(WS, '.agents', 'skills', 'dup');
    await writeSkill(agentsDir);
    await writeSkill(path.join(WS, '.claude', 'skills', 'dup'));
    const r = await locateSkillStage('dup', ctx());
    expect(r).toEqual({ found: true, stage: { source: agentsDir, name: 'dup' } });
  });

  it('a ring dir WITHOUT a SKILL.md is not a hit (falls through to the next ring)', async () => {
    await fs.mkdir(path.join(WS, '.agents', 'skills', 'hollow'), { recursive: true }); // no SKILL.md
    const claudeDir = path.join(WS, '.claude', 'skills', 'hollow');
    await writeSkill(claudeDir);
    const r = await locateSkillStage('hollow', ctx());
    expect(r).toEqual({ found: true, stage: { source: claudeDir, name: 'hollow' } });
  });

  it('a MISSING bare id reports found:false with the ref + BOTH project candidates in ring order', async () => {
    const r = await locateSkillStage('ghost', ctx());
    expect(r).toEqual({
      found: false,
      ref: 'ghost',
      searched: [
        path.join(WS, '.agents', 'skills', 'ghost'),
        path.join(WS, '.claude', 'skills', 'ghost'),
      ],
    });
  });
});

describe('locateSkillStage — PATH-LIKE refs keep resolveSkillStage semantics byte-identically', () => {
  it('an absolute ref stages from EXACTLY the resolveSkillStage source', async () => {
    const dir = path.join(WS, 'somewhere', 'abs-skill');
    await writeSkill(dir);
    const r = await locateSkillStage(dir, ctx());
    expect(r).toEqual({ found: true, stage: resolveSkillStage(dir, ctx()) });
  });

  it('a {{WORKSPACE}} token ref resolves EXACTLY as resolveSkillStage does', async () => {
    await writeSkill(path.join(WS, 'skills', 'tok'));
    const ref = '{{WORKSPACE}}/skills/tok';
    const r = await locateSkillStage(ref, ctx());
    expect(r).toEqual({ found: true, stage: resolveSkillStage(ref, ctx()) });
  });

  it("a RELATIVE path ref resolves against the workspace (today's semantics), NEVER the rings", async () => {
    // The same trailing id exists in the .claude ring — a separator-bearing ref must NOT ring-search.
    await writeSkill(path.join(WS, '.claude', 'skills', 'relskill'));
    await writeSkill(path.join(WS, 'sub', 'relskill'));
    const r = await locateSkillStage('sub/relskill', ctx());
    expect(r).toEqual({ found: true, stage: resolveSkillStage('sub/relskill', ctx()) });
    expect(r && r.found && r.stage.source).toBe(path.join(WS, 'sub', 'relskill'));
  });

  it('a MISSING path-like ref reports found:false with the one resolved source as searched', async () => {
    const ref = '/nonexistent/skills/ghost';
    const r = await locateSkillStage(ref, ctx());
    expect(r).toEqual({ found: false, ref, searched: ['/nonexistent/skills/ghost'] });
  });

  it('no skill declared (undefined / blank) ⇒ undefined (fully additive, matches resolveSkillStage)', async () => {
    expect(await locateSkillStage(undefined, ctx())).toBeUndefined();
    expect(await locateSkillStage('  ', ctx())).toBeUndefined();
  });
});

describe('listSkills — enumerate Ring 0 (.agents/skills) + Ring 1 (.claude/skills), both project-local', () => {
  it('merges both rings with correct ring tags + parsed manifest fields incl. description', async () => {
    await writeSkill(
      path.join(WS, '.agents', 'skills', 'alpha'),
      'name: alpha\ndescription: "ws alpha"\nrequires: [web.search]\nallowed: [web.search, fs.read]\n',
    );
    await writeSkill(path.join(WS, '.claude', 'skills', 'beta'), 'name: beta\ndescription: claude beta\n');

    const entries = await listSkills({ workspace: WS });
    const alpha = entries.find((e) => e.id === 'alpha');
    const beta = entries.find((e) => e.id === 'beta');

    expect(alpha).toMatchObject({
      id: 'alpha',
      dir: path.join(WS, '.agents', 'skills', 'alpha'),
      ring: 'workspace',
      description: 'ws alpha', // quotes stripped, the same way the server handler extracts it
      requires: ['web.search'],
      allowed: ['web.search', 'fs.read'],
    });
    expect(beta).toMatchObject({
      id: 'beta',
      dir: path.join(WS, '.claude', 'skills', 'beta'),
      ring: 'installed',
      description: 'claude beta',
    });
  });

  it('.agents/skills WINS an id clash; the shadowed .claude/skills entry is still reported, flagged', async () => {
    await writeSkill(path.join(WS, '.agents', 'skills', 'dup'), 'name: dup\ndescription: agents copy\n');
    await writeSkill(path.join(WS, '.claude', 'skills', 'dup'), 'name: dup\ndescription: claude copy\n');

    const entries = await listSkills({ workspace: WS });
    const dups = entries.filter((e) => e.id === 'dup');
    expect(dups).toHaveLength(2);
    const agents = dups.find((e) => e.ring === 'workspace');
    const claude = dups.find((e) => e.ring === 'installed');
    expect(agents?.shadowed).toBeUndefined();
    expect(claude?.shadowed).toBe(true);
  });

  it('a MALFORMED manifest (requires ⊄ allowed) never sinks the listing — entry kept with an error note', async () => {
    await writeSkill(path.join(WS, '.agents', 'skills', 'bad'), 'name: bad\nrequires: [x]\nallowed: [y]\n');
    await writeSkill(path.join(WS, '.agents', 'skills', 'good'), 'name: good\ndescription: fine\n');

    const entries = await listSkills({ workspace: WS });
    expect(entries.find((e) => e.id === 'good')).toBeDefined();
    const bad = entries.find((e) => e.id === 'bad');
    expect(bad?.error).toMatch(/requires/);
  });

  it('a ring dir without a SKILL.md is not listed; empty rings ⇒ []', async () => {
    await fs.mkdir(path.join(WS, '.agents', 'skills', 'hollow'), { recursive: true }); // no SKILL.md
    expect(await listSkills({ workspace: WS })).toEqual([]);
  });

  it('with no workspace given, there are NO rings (never a global scan) ⇒ []', async () => {
    // Both rings are workspace-relative now; without a workspace there is nothing to enumerate.
    expect(await listSkills({})).toEqual([]);
  });
});
