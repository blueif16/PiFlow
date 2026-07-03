// Skill LOCATION — the impure twin of `resolveSkillStage` (P0 skill-resolution unification). A BARE id
// (no separator, not absolute, no {{token}}) searches the two local rings — Ring 0 `<workspace>/.agents/
// skills/<id>`, then Ring 1 `<piflowHome>/skills/<id>` — accepting only a dir that CONTAINS a SKILL.md;
// a PATH-LIKE ref keeps `resolveSkillStage`'s exact semantics (byte-identical source). `skillSearchRoots`
// is the single-source-of-truth ordering the server display path must share; `listSkills` enumerates both
// rings (workspace wins an id clash; the shadowed installed entry is still reported, flagged).
//
// HERMETIC: PIFLOW_HOME points at a temp dir for every test (piflow-home.test.ts precedent) — the real
// ~/.piflow is never read.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSkillStage } from '../src/workflow/ops/skill.js';
import { locateSkillStage, skillSearchRoots, listSkills } from '../src/workflow/ops/skill-locate.js';
import type { ResolveCtx } from '../src/workflow/resolver.js';

let WS: string; // workspace root (Ring 0 base)
let HOME: string; // PIFLOW_HOME (Ring 1 base)
let SAVED: string | undefined;

beforeEach(async () => {
  WS = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-skill-ws-'));
  HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-skill-home-'));
  SAVED = process.env.PIFLOW_HOME;
  process.env.PIFLOW_HOME = HOME;
});
afterEach(async () => {
  if (SAVED === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = SAVED;
  await fs.rm(WS, { recursive: true, force: true });
  await fs.rm(HOME, { recursive: true, force: true });
});

const ctx = (): ResolveCtx => ({ run: path.join(WS, 'out', 'r1'), workspace: WS });

/** Write a minimal Agent-Skill bundle at `dir` (a SKILL.md with the given frontmatter lines). */
async function writeSkill(dir: string, fm = 'name: x\ndescription: a skill\n'): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${fm}---\nBody.\n`);
}

describe('skillSearchRoots — the ONE ring ordering (workspace first, then installed home)', () => {
  it('returns [<workspace>/.agents/skills, <piflowHome>/skills] in that order', () => {
    expect(skillSearchRoots(WS)).toEqual([path.join(WS, '.agents', 'skills'), path.join(HOME, 'skills')]);
  });

  it('an explicit piflowHome overrides the env default', () => {
    expect(skillSearchRoots(WS, '/custom/home')).toEqual([
      path.join(WS, '.agents', 'skills'),
      path.join('/custom/home', 'skills'),
    ]);
  });
});

describe('locateSkillStage — BARE id searches the rings', () => {
  it('finds a bare id in the WORKSPACE ring (<workspace>/.agents/skills/<id>)', async () => {
    const dir = path.join(WS, '.agents', 'skills', 'research');
    await writeSkill(dir);
    const r = await locateSkillStage('research', ctx());
    expect(r).toEqual({ found: true, stage: { source: dir, name: 'research' } });
  });

  it('finds a bare id in the HOME ring when the workspace ring misses', async () => {
    const dir = path.join(HOME, 'skills', 'installed-only');
    await writeSkill(dir);
    const r = await locateSkillStage('installed-only', ctx());
    expect(r).toEqual({ found: true, stage: { source: dir, name: 'installed-only' } });
  });

  it('WORKSPACE SHADOWS HOME: when both rings carry the id, the workspace hit wins', async () => {
    const wsDir = path.join(WS, '.agents', 'skills', 'dup');
    await writeSkill(wsDir);
    await writeSkill(path.join(HOME, 'skills', 'dup'));
    const r = await locateSkillStage('dup', ctx());
    expect(r).toEqual({ found: true, stage: { source: wsDir, name: 'dup' } });
  });

  it('a ring dir WITHOUT a SKILL.md is not a hit (falls through to the next ring)', async () => {
    await fs.mkdir(path.join(WS, '.agents', 'skills', 'hollow'), { recursive: true }); // no SKILL.md
    const homeDir = path.join(HOME, 'skills', 'hollow');
    await writeSkill(homeDir);
    const r = await locateSkillStage('hollow', ctx());
    expect(r).toEqual({ found: true, stage: { source: homeDir, name: 'hollow' } });
  });

  it('a MISSING bare id reports found:false with the ref + BOTH searched candidates in ring order', async () => {
    const r = await locateSkillStage('ghost', ctx());
    expect(r).toEqual({
      found: false,
      ref: 'ghost',
      searched: [path.join(WS, '.agents', 'skills', 'ghost'), path.join(HOME, 'skills', 'ghost')],
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
    // The same trailing id exists in the home ring — a separator-bearing ref must NOT ring-search.
    await writeSkill(path.join(HOME, 'skills', 'relskill'));
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

describe('listSkills — enumerate Ring 0 (workspace) + Ring 1 (installed)', () => {
  it('merges both rings with correct ring tags + parsed manifest fields incl. description', async () => {
    await writeSkill(
      path.join(WS, '.agents', 'skills', 'alpha'),
      'name: alpha\ndescription: "ws alpha"\nrequires: [web.search]\nallowed: [web.search, fs.read]\n',
    );
    await writeSkill(path.join(HOME, 'skills', 'beta'), 'name: beta\ndescription: home beta\n');

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
      dir: path.join(HOME, 'skills', 'beta'),
      ring: 'installed',
      description: 'home beta',
    });
  });

  it('workspace WINS an id clash; the shadowed installed entry is still reported, flagged', async () => {
    await writeSkill(path.join(WS, '.agents', 'skills', 'dup'), 'name: dup\ndescription: ws copy\n');
    await writeSkill(path.join(HOME, 'skills', 'dup'), 'name: dup\ndescription: home copy\n');

    const entries = await listSkills({ workspace: WS });
    const dups = entries.filter((e) => e.id === 'dup');
    expect(dups).toHaveLength(2);
    const ws = dups.find((e) => e.ring === 'workspace');
    const home = dups.find((e) => e.ring === 'installed');
    expect(ws?.shadowed).toBeUndefined();
    expect(home?.shadowed).toBe(true);
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

  it('with no workspace given, only the installed ring is enumerated', async () => {
    await writeSkill(path.join(HOME, 'skills', 'solo'), 'name: solo\ndescription: only home\n');
    const entries = await listSkills({});
    expect(entries.map((e) => e.id)).toEqual(['solo']);
    expect(entries[0].ring).toBe('installed');
  });
});
