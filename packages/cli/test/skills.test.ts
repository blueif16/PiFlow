import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSkills, runSkillsCli } from '../src/skills.js';
import type { PromptIO } from '../src/init/types.js';

// `piflowctl skills install` ships the workflow-authoring TRIO (piflow-init/start/enhance) into ANY target
// repo's `.claude/skills/` so a fresh Claude Code agent there is equipped to compose workflows against the
// SDK. The canonical skill SOURCE stays repo-root `.claude/skills/`; the packaged copy is a generated build
// artifact (prepack). The load-bearing invariant these tests pin is ANTI-DRIFT: install is a byte-faithful
// COPY, never a transform — an installed SKILL.md must equal its canonical source byte-for-byte.

// The repo-root canonical skills dir, resolved from this test file (packages/cli/test → repo root).
const REPO_SKILLS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
  '.claude/skills',
);

let TARGET: string;
let SRC: string;
beforeEach(async () => {
  TARGET = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-skills-target-'));
  SRC = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-skills-src-'));
});
afterEach(async () => {
  await fs.rm(TARGET, { recursive: true, force: true });
  await fs.rm(SRC, { recursive: true, force: true });
});

// Build a fake skill SOURCE dir: two skill subdirs, each a SKILL.md (+ a nested references/ to prove the
// whole subtree is copied, not just the top file).
const seedFixtureSrc = async (): Promise<void> => {
  for (const name of ['alpha-skill', 'beta-skill']) {
    const dir = path.join(SRC, name);
    await fs.mkdir(path.join(dir, 'references'), { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), `# ${name}\nbody for ${name}\n`);
    await fs.writeFile(path.join(dir, 'references', 'r.md'), `ref of ${name}\n`);
  }
  // A stray FILE at the src root (not a skill dir) — must be ignored (only subdirs are skills).
  await fs.writeFile(path.join(SRC, 'README.md'), 'not a skill\n');
};

describe('installSkills — pure copy of each skill subdir into <target>/.claude/skills/', () => {
  it('lands each skill dir (with its subtree) under target/.claude/skills and returns the names', async () => {
    await seedFixtureSrc();

    const installed = installSkills(SRC, TARGET, { force: false });

    // Only the two skill SUBDIRS, not the stray README file.
    expect(installed.sort()).toEqual(['alpha-skill', 'beta-skill']);

    const skillsRoot = path.join(TARGET, '.claude', 'skills');
    // SKILL.md content intact + the nested reference subtree copied.
    expect(await fs.readFile(path.join(skillsRoot, 'alpha-skill', 'SKILL.md'), 'utf8')).toBe(
      '# alpha-skill\nbody for alpha-skill\n',
    );
    expect(await fs.readFile(path.join(skillsRoot, 'beta-skill', 'references', 'r.md'), 'utf8')).toBe(
      'ref of beta-skill\n',
    );
    // The stray non-dir at src root was not installed.
    await expect(fs.access(path.join(skillsRoot, 'README.md'))).rejects.toThrow();
  });

  it('SKIPS an existing skill dir without force, then OVERWRITES it with force:true', async () => {
    await seedFixtureSrc();
    const skillsRoot = path.join(TARGET, '.claude', 'skills');
    // Pre-existing user copy of alpha-skill with DIFFERENT content.
    await fs.mkdir(path.join(skillsRoot, 'alpha-skill'), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, 'alpha-skill', 'SKILL.md'), 'USER EDIT — keep me\n');

    // force:false — alpha is skipped (not in the returned names), beta is installed.
    const installed = installSkills(SRC, TARGET, { force: false });
    expect(installed).toEqual(['beta-skill']);
    expect(await fs.readFile(path.join(skillsRoot, 'alpha-skill', 'SKILL.md'), 'utf8')).toBe(
      'USER EDIT — keep me\n',
    );

    // force:true — alpha is overwritten from source.
    const forced = installSkills(SRC, TARGET, { force: true });
    expect(forced.sort()).toEqual(['alpha-skill', 'beta-skill']);
    expect(await fs.readFile(path.join(skillsRoot, 'alpha-skill', 'SKILL.md'), 'utf8')).toBe(
      '# alpha-skill\nbody for alpha-skill\n',
    );
  });

  it('ANTI-DRIFT: an installed SKILL.md is BYTE-IDENTICAL to its canonical repo-root source', async () => {
    // Copy from the REAL canonical repo-root skills (not the fixture) so this asserts a true copy, not a
    // transform/duplicate. Compare raw bytes (Buffer.equals), the strongest no-drift guard.
    installSkills(REPO_SKILLS, TARGET, { force: false });

    for (const name of ['piflow-init', 'piflow-start', 'piflow-enhance']) {
      const canonical = await fs.readFile(path.join(REPO_SKILLS, name, 'SKILL.md'));
      const installed = await fs.readFile(
        path.join(TARGET, '.claude', 'skills', name, 'SKILL.md'),
      );
      expect(installed.equals(canonical), `${name}/SKILL.md must be a byte-identical copy`).toBe(true);
    }
  });
});

describe('runSkillsCli — install [targetDir] [--force]', () => {
  it('installs EXACTLY the workflow-authoring trio via the dev fallback (dev ≡ packaged)', async () => {
    await runSkillsCli(['install', TARGET]);

    const skillsRoot = path.join(TARGET, '.claude', 'skills');
    // The three workflow-authoring skills landed (proving srcDir resolved to the repo-root via the dev
    // fallback — the packaged skills/ dir is absent in a source checkout).
    for (const name of ['piflow-init', 'piflow-start', 'piflow-enhance']) {
      await expect(fs.access(path.join(skillsRoot, name, 'SKILL.md'))).resolves.toBeUndefined();
    }
    // The dev fallback must install ONLY the trio — not piflow-release (SDK publishing) or piflow-web-design
    // (marketing-site only), even though both sit in repo-root .claude/skills. This keeps the dev fallback
    // byte-equivalent to the prepack-filtered packaged dir, so `skills install` never leaks a non-consumer skill.
    for (const excluded of ['piflow-release', 'piflow-web-design']) {
      await expect(fs.access(path.join(skillsRoot, excluded))).rejects.toThrow();
    }
    // And nothing OUTSIDE the trio at all (e.g. unrelated repo skills like premium-saas-stack).
    const landed = await fs.readdir(skillsRoot);
    expect(landed.sort()).toEqual(['piflow-enhance', 'piflow-init', 'piflow-start']);
  });
});

// The optional OPT-IN add-ons layer (starting with `okf` → the okf-slices skill). A bare install stays
// trio-only (asserted above); an add-on is opted in per-run via --with/--all/--wizard, or remembered per
// project in `.piflow/skills.json`. These tests pin: the trio is ALWAYS present, the chosen add-on skill
// lands (byte-faithful), the manifest is written when a choice was made, and an unknown --with id is a
// clean error that installs nothing new.
describe('runSkillsCli — OKF add-on (--with / --all / --wizard / manifest)', () => {
  const skillsRootOf = (t: string) => path.join(t, '.claude', 'skills');
  const manifestOf = (t: string) => path.join(t, '.piflow', 'skills.json');
  const TRIO_NAMES = ['piflow-init', 'piflow-start', 'piflow-enhance'];

  const assertTrioPresent = async (): Promise<void> => {
    for (const name of TRIO_NAMES) {
      await expect(
        fs.access(path.join(skillsRootOf(TARGET), name, 'SKILL.md')),
      ).resolves.toBeUndefined();
    }
  };

  it('--with okf installs the trio + okf-slices and writes the manifest', async () => {
    await runSkillsCli(['install', TARGET, '--with', 'okf']);

    await assertTrioPresent();
    await expect(
      fs.access(path.join(skillsRootOf(TARGET), 'okf-slices', 'SKILL.md')),
    ).resolves.toBeUndefined();

    const manifest = JSON.parse(await fs.readFile(manifestOf(TARGET), 'utf8'));
    expect(manifest).toEqual({ addons: ['okf'] });
  });

  it('--all installs the trio + every add-on skill and writes the manifest', async () => {
    await runSkillsCli(['install', TARGET, '--all']);

    await assertTrioPresent();
    // Every add-on's skill(s) landed — currently okf → okf-slices.
    await expect(
      fs.access(path.join(skillsRootOf(TARGET), 'okf-slices', 'SKILL.md')),
    ).resolves.toBeUndefined();

    const manifest = JSON.parse(await fs.readFile(manifestOf(TARGET), 'utf8'));
    expect(manifest.addons).toContain('okf');
  });

  it('a bare install READS an existing manifest (installs okf) and does NOT rewrite it', async () => {
    // Pre-seed the per-project manifest, then run a BARE install (no flags).
    await fs.mkdir(path.dirname(manifestOf(TARGET)), { recursive: true });
    const seeded = '{\n  "addons": [\n    "okf"\n  ]\n}\n'; // deliberately custom formatting
    await fs.writeFile(manifestOf(TARGET), seeded);

    await runSkillsCli(['install', TARGET]);

    await assertTrioPresent();
    // okf-slices installed because the manifest asked for it (no flag given).
    await expect(
      fs.access(path.join(skillsRootOf(TARGET), 'okf-slices', 'SKILL.md')),
    ).resolves.toBeUndefined();
    // The manifest is READ, not re-written — the original bytes survive untouched.
    expect(await fs.readFile(manifestOf(TARGET), 'utf8')).toBe(seeded);
  });

  it('--with bogus errors (lists valid ids on stderr), sets exitCode, installs nothing new', async () => {
    let stderr = '';
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
    process.exitCode = 0;
    try {
      await runSkillsCli(['install', TARGET, '--with', 'bogus']);
    } finally {
      errSpy.mockRestore();
    }

    expect(Number(process.exitCode ?? 0)).not.toBe(0);
    process.exitCode = 0;
    expect(stderr).toContain('bogus');
    expect(stderr).toContain('okf'); // the valid ids are surfaced
    // Nothing was installed (not even the trio) — the run bailed before any copy.
    await expect(fs.access(skillsRootOf(TARGET))).rejects.toThrow();
    await expect(fs.access(manifestOf(TARGET))).rejects.toThrow();
  });

  it('--wizard uses the injected PromptIO to opt in okf, then installs it + writes the manifest', async () => {
    // A scripted PromptIO that says YES to every confirm (the okf add-on prompt) and no-ops otherwise.
    const io: PromptIO = {
      print: () => {},
      confirm: async () => true,
      input: async (_q, def = '') => def,
    };

    await runSkillsCli(['install', TARGET, '--wizard'], { io });

    await assertTrioPresent();
    await expect(
      fs.access(path.join(skillsRootOf(TARGET), 'okf-slices', 'SKILL.md')),
    ).resolves.toBeUndefined();
    const manifest = JSON.parse(await fs.readFile(manifestOf(TARGET), 'utf8'));
    expect(manifest.addons).toContain('okf');
  });

  it('ANTI-DRIFT: okf-slices/SKILL.md installed via --with okf is byte-identical to the canonical source', async () => {
    await runSkillsCli(['install', TARGET, '--with', 'okf']);

    const canonical = await fs.readFile(path.join(REPO_SKILLS, 'okf-slices', 'SKILL.md'));
    const installed = await fs.readFile(
      path.join(skillsRootOf(TARGET), 'okf-slices', 'SKILL.md'),
    );
    expect(
      installed.equals(canonical),
      'okf-slices/SKILL.md must be a byte-identical copy',
    ).toBe(true);
  });
});
