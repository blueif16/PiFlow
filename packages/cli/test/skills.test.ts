import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSkills, runSkillsCli } from '../src/skills.js';
import type { PromptIO } from '../src/init/types.js';

// `piflowctl skills install` ships the DEFAULT skill set (the authoring trio piflow-init/start/enhance +
// piflow-fixer + the piflow-inspect instrument router) into ANY target repo's `.claude/skills/` so a fresh
// Claude Code agent there is equipped to compose, run, and debug workflows against the SDK and to run the
// fixer playbook. The canonical skill SOURCE stays repo-root `.claude/skills/`; the packaged copy is a
// generated build artifact (prepack). The load-bearing invariant these tests pin is ANTI-DRIFT: install is a
// byte-faithful COPY, never a transform — an installed SKILL.md must equal its canonical source byte-for-byte.

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

    for (const name of ['piflow-init', 'piflow-start', 'piflow-inspect', 'piflow-triage', 'piflow-fixer', 'piflow-gate', 'piflow-overlord']) {
      const canonical = await fs.readFile(path.join(REPO_SKILLS, name, 'SKILL.md'));
      const installed = await fs.readFile(
        path.join(TARGET, '.claude', 'skills', name, 'SKILL.md'),
      );
      expect(installed.equals(canonical), `${name}/SKILL.md must be a byte-identical copy`).toBe(true);
    }
  });
});

describe('runSkillsCli — install [targetDir] [--force]', () => {
  it('installs EXACTLY the DEFAULT skill set via the dev fallback (dev ≡ packaged)', async () => {
    await runSkillsCli(['install', TARGET]);

    const skillsRoot = path.join(TARGET, '.claude', 'skills');
    // The default set landed (proving srcDir resolved to the repo-root via the dev fallback — the packaged
    // skills/ dir is absent in a source checkout).
    for (const name of ['piflow-init', 'piflow-start', 'piflow-inspect', 'piflow-triage', 'piflow-fixer', 'piflow-gate', 'piflow-overlord']) {
      await expect(fs.access(path.join(skillsRoot, name, 'SKILL.md'))).resolves.toBeUndefined();
    }
    // The dev fallback must install ONLY the default set — not piflow-release (SDK publishing) or
    // piflow-web-design (marketing-site only), even though both sit in repo-root .claude/skills. This keeps the
    // dev fallback byte-equivalent to the prepack-filtered packaged dir, so `skills install` never leaks a
    // non-consumer skill.
    for (const excluded of ['piflow-release', 'piflow-web-design', 'piflow-enhance']) {
      await expect(fs.access(path.join(skillsRoot, excluded))).rejects.toThrow();
    }
    // And nothing OUTSIDE the default set at all (e.g. unrelated repo skills like premium-saas-stack).
    const landed = await fs.readdir(skillsRoot);
    expect(landed.sort()).toEqual(['piflow-fixer', 'piflow-gate', 'piflow-init', 'piflow-inspect', 'piflow-overlord', 'piflow-start', 'piflow-triage']);

    // PORTABILITY GUARANTEE: the fixer OWNS the method library (Leg C) under `piflow-fixer/library/` — it MUST
    // travel with the fixer on install (the whole skill subtree copies recursively), so a fixer on a fresh repo
    // has the universal method cards from day one. This is exactly what a SKILL.md-only copy would silently drop.
    const libCards = (await fs.readdir(path.join(skillsRoot, 'piflow-fixer', 'library', 'cards')))
      .filter((f) => f.endsWith('.md') && !f.startsWith('_'));
    expect(libCards.length, 'the fixer method library cards must install with the fixer').toBeGreaterThan(10);
    expect(libCards).toContain('judge-reliability.md'); // a specific card the gate/fixer reference by [[key]]
  });
});

// The optional OPT-IN add-ons layer (starting with `understand` → the okf-slices skill dir). A bare install
// stays default-set-only (asserted above); an add-on is opted in per-run via --with/--all/--wizard, or remembered
// per project in `.piflow/skills.json`. These tests pin: the default set is ALWAYS present, the chosen add-on skill
// lands (byte-faithful), the manifest is written when a choice was made, an unknown --with id is a clean
// error that installs nothing new, and the LEGACY `okf` id still resolves (back-compat alias).
describe('runSkillsCli — understand add-on (--with / --all / --wizard / manifest)', () => {
  const skillsRootOf = (t: string) => path.join(t, '.claude', 'skills');
  const manifestOf = (t: string) => path.join(t, '.piflow', 'skills.json');
  const DEFAULT_SKILL_NAMES = ['piflow-init', 'piflow-start', 'piflow-inspect', 'piflow-triage', 'piflow-fixer', 'piflow-gate', 'piflow-overlord'];

  const assertDefaultsPresent = async (): Promise<void> => {
    for (const name of DEFAULT_SKILL_NAMES) {
      await expect(
        fs.access(path.join(skillsRootOf(TARGET), name, 'SKILL.md')),
      ).resolves.toBeUndefined();
    }
  };

  it('--with understand installs the default set + okf-slices and writes the manifest', async () => {
    await runSkillsCli(['install', TARGET, '--with', 'understand']);

    await assertDefaultsPresent();
    await expect(
      fs.access(path.join(skillsRootOf(TARGET), 'okf-slices', 'SKILL.md')),
    ).resolves.toBeUndefined();

    const manifest = JSON.parse(await fs.readFile(manifestOf(TARGET), 'utf8'));
    expect(manifest).toEqual({ addons: ['understand'] });
  });

  it('--with memory installs the default set + memory-slices and writes the manifest', async () => {
    await runSkillsCli(['install', TARGET, '--with', 'memory']);

    await assertDefaultsPresent();
    await expect(
      fs.access(path.join(skillsRootOf(TARGET), 'memory-slices', 'SKILL.md')),
    ).resolves.toBeUndefined();

    const manifest = JSON.parse(await fs.readFile(manifestOf(TARGET), 'utf8'));
    expect(manifest).toEqual({ addons: ['memory'] });
  });

  it('--all installs the default set + every add-on skill and writes the manifest', async () => {
    await runSkillsCli(['install', TARGET, '--all']);

    await assertDefaultsPresent();
    // Every add-on's skill(s) landed — understand → okf-slices, memory → memory-slices.
    await expect(
      fs.access(path.join(skillsRootOf(TARGET), 'okf-slices', 'SKILL.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(skillsRootOf(TARGET), 'memory-slices', 'SKILL.md')),
    ).resolves.toBeUndefined();

    const manifest = JSON.parse(await fs.readFile(manifestOf(TARGET), 'utf8'));
    expect(manifest.addons).toContain('understand');
    expect(manifest.addons).toContain('memory');
  });

  it('a bare install READS a LEGACY-okf manifest (alias → understand, installs okf-slices) and does NOT rewrite it', async () => {
    // Pre-seed the per-project manifest with the OLD id `okf`, then run a BARE install (no flags). This is the
    // back-compat regression: an existing opt-in written before the rename must still resolve.
    await fs.mkdir(path.dirname(manifestOf(TARGET)), { recursive: true });
    const seeded = '{\n  "addons": [\n    "okf"\n  ]\n}\n'; // the legacy id, deliberately custom formatting
    await fs.writeFile(manifestOf(TARGET), seeded);

    await runSkillsCli(['install', TARGET]);

    await assertDefaultsPresent();
    // okf-slices installed because the legacy `okf` id aliases to `understand` (no flag given).
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
    expect(stderr).toContain('understand'); // the valid ids are surfaced
    // Nothing was installed (not even the default set) — the run bailed before any copy.
    await expect(fs.access(skillsRootOf(TARGET))).rejects.toThrow();
    await expect(fs.access(manifestOf(TARGET))).rejects.toThrow();
  });

  it('--wizard uses the injected PromptIO to opt in understand, then installs it + writes the manifest', async () => {
    // A scripted PromptIO that says YES to every confirm (the understand add-on prompt) and no-ops otherwise.
    const io: PromptIO = {
      print: () => {},
      confirm: async () => true,
      input: async (_q, def = '') => def,
    };

    await runSkillsCli(['install', TARGET, '--wizard'], { io });

    await assertDefaultsPresent();
    await expect(
      fs.access(path.join(skillsRootOf(TARGET), 'okf-slices', 'SKILL.md')),
    ).resolves.toBeUndefined();
    const manifest = JSON.parse(await fs.readFile(manifestOf(TARGET), 'utf8'));
    expect(manifest.addons).toContain('understand');
  });

  it('ANTI-DRIFT: okf-slices/SKILL.md installed via --with understand is byte-identical to the canonical source', async () => {
    await runSkillsCli(['install', TARGET, '--with', 'understand']);

    const canonical = await fs.readFile(path.join(REPO_SKILLS, 'okf-slices', 'SKILL.md'));
    const installed = await fs.readFile(
      path.join(skillsRootOf(TARGET), 'okf-slices', 'SKILL.md'),
    );
    expect(
      installed.equals(canonical),
      'okf-slices/SKILL.md must be a byte-identical copy',
    ).toBe(true);
  });

  it('ANTI-DRIFT: memory-slices/SKILL.md installed via --with memory is byte-identical to the canonical source', async () => {
    // This is the guard that pins the dual-copy discipline — if `memory-slices` is missing from the add-on
    // catalog / bundle mirror, the `only` allowlist excludes it and this fs.readFile rejects (RED).
    await runSkillsCli(['install', TARGET, '--with', 'memory']);

    const canonical = await fs.readFile(path.join(REPO_SKILLS, 'memory-slices', 'SKILL.md'));
    const installed = await fs.readFile(
      path.join(skillsRootOf(TARGET), 'memory-slices', 'SKILL.md'),
    );
    expect(
      installed.equals(canonical),
      'memory-slices/SKILL.md must be a byte-identical copy',
    ).toBe(true);
  });
});
