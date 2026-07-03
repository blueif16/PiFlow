// `piflowctl skill add <source>` — install a skill bundle into the home ring (`<piflowHome>/skills/<id>/`)
// from a local dir, a git URL, or an `owner/repo` GitHub shorthand. Tested hermetically: local sources are
// temp dirs; the GIT pathway is proven against a LOCAL fixture repo (`git init` in tmp, cloned via a
// `file://` URL) — the network is NEVER touched (the shorthand→URL expansion is pinned via the pure,
// exported `classifySkillSource`).
//
// Load-bearing behaviors pinned here:
//   • a local-dir add lands the bundle + `.install.json` { source, sha256, installedAt }; the sha256 is a
//     DETERMINISTIC content hash (same input ⇒ same hash across installs; a changed file ⇒ a new hash;
//     the `.install.json` itself — whose installedAt varies — never feeds the hash).
//   • an existing id is refused without `--force`; `--force` replaces it.
//   • several candidate skill dirs without `--skill` exit 1 LISTING the candidates; `--skill <name>` picks.
//   • the agentskills.io rule: the SKILL.md frontmatter `name` must match the dir name, else rejected.
//   • a git source clones (shallow) to a temp dir, installs the located bundle, and the `.git` innards are
//     NOT copied into the installed bundle.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSkillCli, classifySkillSource } from '../src/skill.js';

let HOME: string;
let SRC: string; // scratch dir the per-test sources are built under

function sink(): { text: string; write: (s: string) => void } {
  const parts: string[] = [];
  return {
    write: (s: string) => void parts.push(s),
    get text() {
      return parts.join('');
    },
  };
}

async function add(
  argv: string[],
  opts: { home?: string; now?: () => string } = {},
): Promise<{ out: string; err: string; code: number }> {
  const o = sink();
  const e = sink();
  const code = await runSkillCli(['add', ...argv], {
    out: o.write,
    err: e.write,
    piflowHome: opts.home ?? HOME,
    now: opts.now,
  });
  return { out: o.text, err: e.text, code };
}

/** Build a one-skill bundle dir: <SRC>/<id>/SKILL.md (+ extra files). Returns the bundle dir. */
async function bundleDir(id: string, extra: Record<string, string> = {}, name = id): Promise<string> {
  const dir = path.join(SRC, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: the ${id} skill\n---\nBody.\n`);
  for (const [rel, content] of Object.entries(extra)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}

beforeEach(async () => {
  HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-skilladd-home-'));
  SRC = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-skilladd-src-'));
});

afterEach(async () => {
  await fs.rm(HOME, { recursive: true, force: true });
  await fs.rm(SRC, { recursive: true, force: true });
});

describe('classifySkillSource — the pure source classifier', () => {
  it('expands owner/repo GitHub shorthand to https://github.com/owner/repo.git', () => {
    expect(classifySkillSource('anthropics/skills')).toEqual({
      kind: 'git',
      url: 'https://github.com/anthropics/skills.git',
    });
  });

  it('passes a real git URL through verbatim', () => {
    expect(classifySkillSource('https://example.com/repo.git')).toEqual({
      kind: 'git',
      url: 'https://example.com/repo.git',
    });
    expect(classifySkillSource('git@github.com:owner/repo.git')).toEqual({
      kind: 'git',
      url: 'git@github.com:owner/repo.git',
    });
    expect(classifySkillSource('file:///tmp/fixture-repo')).toEqual({ kind: 'git', url: 'file:///tmp/fixture-repo' });
  });

  it('an existing local dir is local — even when it looks like owner/repo', async () => {
    const dir = await bundleDir('looks');
    expect(classifySkillSource(dir)).toEqual({ kind: 'local', dir });
    // a RELATIVE path with a slash that exists resolves local, not shorthand
    const rel = path.relative(process.cwd(), dir);
    expect(classifySkillSource(rel)).toEqual({ kind: 'local', dir });
  });
});

describe('piflowctl skill add — local dir', () => {
  it('installs the bundle to <home>/skills/<id> and writes .install.json {source, sha256, installedAt}', async () => {
    const dir = await bundleDir('my-skill', { 'references/notes.md': 'deep notes\n' });
    const r = await add([dir], { now: () => '2026-07-03T01:02:03.000Z' });
    expect(r.code).toBe(0);

    const dest = path.join(HOME, 'skills', 'my-skill');
    expect(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8')).toBe(
      await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8'),
    );
    expect(await fs.readFile(path.join(dest, 'references', 'notes.md'), 'utf8')).toBe('deep notes\n');

    const manifest = JSON.parse(await fs.readFile(path.join(dest, '.install.json'), 'utf8')) as {
      source: string;
      sha256: string;
      installedAt: string;
    };
    expect(manifest.source).toBe(dir);
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.installedAt).toBe('2026-07-03T01:02:03.000Z');
  });

  it('sha256 is deterministic over the bundle contents: same input ⇒ same hash, changed input ⇒ new hash', async () => {
    const dir = await bundleDir('stable', { 'assets/data.txt': 'v1\n' });
    const homeB = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-skilladd-homeB-'));
    try {
      // two installs of the SAME source, at DIFFERENT times, into different homes ⇒ the SAME hash
      // (a hash that folded in .install.json/installedAt would differ here).
      await add([dir], { now: () => '2026-07-03T01:00:00.000Z' });
      await add([dir], { home: homeB, now: () => '2026-07-04T09:00:00.000Z' });
      const read = async (home: string) =>
        (JSON.parse(await fs.readFile(path.join(home, 'skills', 'stable', '.install.json'), 'utf8')) as { sha256: string })
          .sha256;
      const a = await read(HOME);
      expect(a).toBe(await read(homeB));

      // teeth: a changed file content changes the hash
      await fs.writeFile(path.join(dir, 'assets', 'data.txt'), 'v2\n');
      await add([dir, '--force']);
      expect(await read(HOME)).not.toBe(a);
    } finally {
      await fs.rm(homeB, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing id without --force; --force replaces it', async () => {
    const dir = await bundleDir('dup', { 'a.txt': 'first\n' });
    expect((await add([dir])).code).toBe(0);

    const again = await add([dir]);
    expect(again.code).toBe(1);
    expect(again.err).toContain('--force');
    expect(await fs.readFile(path.join(HOME, 'skills', 'dup', 'a.txt'), 'utf8')).toBe('first\n'); // untouched

    await fs.writeFile(path.join(dir, 'a.txt'), 'second\n');
    const forced = await add([dir, '--force']);
    expect(forced.code).toBe(0);
    expect(await fs.readFile(path.join(HOME, 'skills', 'dup', 'a.txt'), 'utf8')).toBe('second\n');
  });

  it('a source with several candidate skills and no --skill exits 1 LISTING the candidates', async () => {
    const root = path.join(SRC, 'many');
    await fs.mkdir(path.join(root, 'skills', 'one'), { recursive: true });
    await fs.mkdir(path.join(root, 'skills', 'two'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'one', 'SKILL.md'), '---\nname: one\n---\nOne.\n');
    await fs.writeFile(path.join(root, 'skills', 'two', 'SKILL.md'), '---\nname: two\n---\nTwo.\n');

    const r = await add([root]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('one');
    expect(r.err).toContain('two');
    expect(r.err).toContain('--skill');

    // --skill picks exactly one
    const picked = await add([root, '--skill', 'two']);
    expect(picked.code).toBe(0);
    expect(await fs.readFile(path.join(HOME, 'skills', 'two', 'SKILL.md'), 'utf8')).toContain('name: two');
    await expect(fs.stat(path.join(HOME, 'skills', 'one'))).rejects.toThrow(); // 'one' was NOT installed
  });

  it('rejects a bundle whose frontmatter name does not match its dir name (the agentskills.io rule)', async () => {
    const dir = await bundleDir('dir-name', {}, 'other-name');
    const r = await add([dir]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('dir-name');
    expect(r.err).toContain('other-name');
    await expect(fs.stat(path.join(HOME, 'skills', 'dir-name'))).rejects.toThrow();
  });

  it('a nonexistent source exits 1 with a clear message', async () => {
    const r = await add([path.join(SRC, 'nope-not-here')]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('nope-not-here');
  });

  it('REJECTS a bundle whose manifest violates requires ⊆ allowed (exit 1, nothing installed)', async () => {
    const dir = path.join(SRC, 'broken');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: broken\ndescription: violates the floor/ceiling invariant\nrequires: [bash]\nallowed: [read]\n---\nBody.\n`,
    );
    const r = await add([dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/requires/);
    await expect(fs.stat(path.join(HOME, 'skills', 'broken'))).rejects.toThrow();
  });
});

describe('piflowctl skill add — git source (LOCAL fixture repo, never the network)', () => {
  it('clones a file:// repo, installs the located bundle, and never copies the .git innards', async () => {
    // build a real git repo in tmp carrying skills/git-skill/SKILL.md
    const repo = path.join(SRC, 'fixture-repo');
    await fs.mkdir(path.join(repo, 'skills', 'git-skill'), { recursive: true });
    await fs.writeFile(
      path.join(repo, 'skills', 'git-skill', 'SKILL.md'),
      '---\nname: git-skill\ndescription: from git\n---\nGit body.\n',
    );
    const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    expect(spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' }).status).toBe(0);
    expect(git('add', '-A').status).toBe(0);
    expect(git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init').status).toBe(0);

    const url = `file://${repo}`;
    const r = await add([url]);
    expect(r.code).toBe(0);

    const dest = path.join(HOME, 'skills', 'git-skill');
    expect(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8')).toContain('Git body.');
    await expect(fs.stat(path.join(dest, '.git'))).rejects.toThrow(); // clone innards never installed

    const manifest = JSON.parse(await fs.readFile(path.join(dest, '.install.json'), 'utf8')) as { source: string };
    expect(manifest.source).toBe(url); // provenance = the source AS GIVEN
  });

  it('a ROOT-SKILL.md repo (the clone root IS the bundle): id = the repo name, and .git is filtered out of the copy', async () => {
    // here the .git dir sits INSIDE the chosen bundle dir — the copy filter is what keeps it out (the
    // subdir-bundle test above never exercises that filter; this one is its teeth).
    const repo = path.join(SRC, 'root-skill');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, 'SKILL.md'), '---\nname: root-skill\ndescription: root bundle\n---\nRoot body.\n');
    const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    expect(spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' }).status).toBe(0);
    expect(git('add', '-A').status).toBe(0);
    expect(git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init').status).toBe(0);

    const r = await add([`file://${repo}`]);
    expect(r.code).toBe(0);

    const dest = path.join(HOME, 'skills', 'root-skill');
    expect(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8')).toContain('Root body.');
    await expect(fs.stat(path.join(dest, '.git'))).rejects.toThrow(); // the filter, not luck
  });
});
