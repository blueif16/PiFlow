// installSkill — the install pipeline hoisted from @piflow/cli's `skill add` so the control-plane
// server can install a remote skill without shelling the CLI (the SAME move made for searchRemote).
// The CLI's skill-add.test.ts remains the behavior oracle for the whole pipeline (clone/copy/provenance);
// THIS file pins the NEW surface the CLI never exercised: the STRUCTURED return value + the typed error.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installSkill, classifySkillSource, SkillInstallError } from '../src/workflow/ops/skill-install.js';

let HOME: string;
let SRC: string;

/** Build a one-skill bundle dir: <SRC>/<id>/SKILL.md. Returns the bundle dir. */
async function bundleDir(id: string, name = id): Promise<string> {
  const dir = path.join(SRC, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: the ${id} skill\n---\nBody.\n`);
  return dir;
}

beforeEach(async () => {
  HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-installskill-home-'));
  SRC = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-installskill-src-'));
});
afterEach(async () => {
  await fs.rm(HOME, { recursive: true, force: true });
  await fs.rm(SRC, { recursive: true, force: true });
});

describe('installSkill — structured install into the home ring', () => {
  it('installs a local bundle and RETURNS { id, dest, sha256, source, installedAt }', async () => {
    // FAILS if the hoisted fn does not surface the id/dest/sha256 the server endpoint needs to answer
    // the GUI (the CLI never returned these — it printed prose).
    const dir = await bundleDir('my-skill');
    const r = await installSkill(dir, { piflowHome: HOME, now: () => '2026-07-03T00:00:00.000Z' });
    expect(r.id).toBe('my-skill');
    expect(r.dest).toBe(path.join(HOME, 'skills', 'my-skill'));
    expect(r.source).toBe(dir); // provenance = the source AS GIVEN
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.installedAt).toBe('2026-07-03T00:00:00.000Z');
    expect(await fs.readFile(path.join(r.dest, 'SKILL.md'), 'utf8')).toContain('name: my-skill');
  });

  it('throws a typed SkillInstallError (not a raw crash) on an unresolvable source, writing nothing', async () => {
    // FAILS if the error is an untyped throw — the server maps SkillInstallError → 502 one-line, and a
    // raw crash would leak a 500/stack. Also proves a rejected install leaves the home ring untouched.
    await expect(installSkill(path.join(SRC, 'does-not-exist'), { piflowHome: HOME })).rejects.toBeInstanceOf(
      SkillInstallError,
    );
    await expect(fs.stat(path.join(HOME, 'skills'))).rejects.toThrow();
  });

  it('re-exports the pure classifySkillSource (owner/repo → github clone URL)', () => {
    // FAILS if the hoist dropped the pure classifier the CLI + preview both depend on.
    expect(classifySkillSource('anthropics/skills')).toEqual({
      kind: 'git',
      url: 'https://github.com/anthropics/skills.git',
    });
  });
});
