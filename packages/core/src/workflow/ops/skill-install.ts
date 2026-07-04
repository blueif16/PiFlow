// The skill INSTALLER — materialize a source (local dir as-is; git — incl. the `owner/repo` GitHub
// shorthand — via a shallow clone to tmp), locate the skill dir(s) (root SKILL.md, else `*/SKILL.md` +
// `skills/*/SKILL.md`), enforce the agentskills.io rule (frontmatter `name` = dir name), validate the
// manifest, and copy to `<piflowHome>/skills/<id>/` (never overwriting without `force`), recording
// provenance in `<dest>/.install.json` { source, sha256, installedAt }.
//
// HOISTED from @piflow/cli's `skill add` (2026-07-04) — the SAME move made for `searchRemote` (skill-remote.ts):
// so the CLI verb AND the control-plane server share ONE install implementation. The CLI verb (`piflowctl
// skill add`) is now a thin renderer over `installSkill`; the server's `POST /__piflow/skill-install` calls
// it directly (a browser can't `git clone` + write to `~/.piflow`). `installSkill` THROWS a typed
// `SkillInstallError` on any failure — the server maps that to a 502 one-line message, the CLI to `err()`+1.
//
// The sha256 is a DETERMINISTIC content hash over the bundle's files (sorted relative paths + bytes;
// `.git`/`.install.json` excluded), so the same source always yields the same hash (an integrity anchor,
// not a timestamp). This module is node-only (fs/child_process) and is NEVER imported by the browser bundle.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkillManifest } from './skill-manifest.js';

/** A typed failure from {@link installSkill} — lets callers map an install failure to a clean one-line
 *  message (server → 502, CLI → stderr) instead of leaking a raw crash/stack. */
export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillInstallError';
  }
}

/** Where a `skill add` source comes from. `none` = nothing resolvable (the caller reports it). */
export type SkillSource = { kind: 'git'; url: string } | { kind: 'local'; dir: string } | { kind: 'none' };

/**
 * Classify an install source, PURE apart from one existence stat: a git-shaped ref (`http(s)://`, `git://`,
 * `ssh://`, `file://`, `git@…`, or a `.git` suffix) is git verbatim; an EXISTING local dir is local (checked
 * before the shorthand so a real path always wins); a bare `owner/repo` expands to the GitHub clone URL.
 */
export function classifySkillSource(source: string): SkillSource {
  if (/^(https?|git|ssh|file):\/\//.test(source) || source.startsWith('git@') || source.endsWith('.git')) {
    return { kind: 'git', url: source };
  }
  const dir = path.resolve(source);
  try {
    if (statSync(dir).isDirectory()) return { kind: 'local', dir };
  } catch {
    /* not a local dir — fall through to the shorthand */
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    return { kind: 'git', url: `https://github.com/${source}.git` };
  }
  return { kind: 'none' };
}

/** The repo name a git URL clones as — the root-bundle's dir-name stand-in (the tmp clone dir is random). */
function repoNameFromUrl(url: string): string {
  const tail = url.replace(/\/+$/, '').split(/[/:]/).pop() ?? 'skill';
  return tail.replace(/\.git$/, '');
}

/** One installable skill dir found inside a materialized source. `id` = the dir name (the resolvable token). */
interface Candidate {
  id: string;
  dir: string;
}

/** Locate the skill dir(s): a root SKILL.md wins (id = the source-derived root name); else scan every
 *  direct child dir plus the conventional `skills/` subdir's children for a SKILL.md. Sorted by id. */
export async function findCandidates(root: string, rootName: string): Promise<Candidate[]> {
  const hasSkillMd = async (dir: string) =>
    fs.stat(path.join(dir, 'SKILL.md')).then((s) => s.isFile(), () => false);
  if (await hasSkillMd(root)) return [{ id: rootName, dir: root }];

  const out: Candidate[] = [];
  const scan = async (parent: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(parent, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (!d.isDirectory() || d.name === '.git') continue;
      const dir = path.join(parent, d.name);
      if (await hasSkillMd(dir)) out.push({ id: d.name, dir });
    }
  };
  await scan(root);
  await scan(path.join(root, 'skills'));
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// The SAME frontmatter regex core parses SKILL.md with (skill-manifest.ts / skill-locate.ts).
const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

/** The frontmatter `name:` scalar (one wrapping-quote layer stripped); undefined = unparseable manifest. */
function manifestName(raw: string): string | undefined {
  const fm = FRONTMATTER.exec(raw);
  const nm = fm && /^name:[ \t]*(.+)$/m.exec(fm[1]);
  if (!nm) return undefined;
  let n = nm[1].trim();
  if (n.length >= 2 && ((n[0] === '"' && n.endsWith('"')) || (n[0] === "'" && n.endsWith("'")))) n = n.slice(1, -1);
  return n || undefined;
}

/**
 * The DETERMINISTIC bundle hash: sha256 over every file's `relpath NUL bytes NUL`, walked in sorted
 * relative-path order. `.git/**` and the provenance file itself (`.install.json` — its installedAt varies
 * per install) are excluded, so the hash is a pure function of the skill's content.
 */
async function bundleSha256(root: string): Promise<string> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      if (d.name === '.git') continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else if (d.isFile() && path.relative(root, p) !== '.install.json') files.push(path.relative(root, p));
    }
  };
  await walk(root);
  files.sort();
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(await fs.readFile(path.join(root, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** The global piflow home — the SAME resolution core's `skillSearchRoots`/`defaultAgentsDir` use. */
function piflowHomeDir(override?: string): string {
  return override ?? process.env.PIFLOW_HOME ?? path.join(os.homedir(), '.piflow');
}

export interface InstallSkillOpts {
  /** The global home (default `PIFLOW_HOME ?? ~/.piflow`) — the install target's parent (`<home>/skills`). */
  piflowHome?: string;
  /** Disambiguate a multi-candidate source (the `--skill <name>` pick). */
  pick?: string;
  /** Replace an already-installed id instead of refusing it. */
  force?: boolean;
  /** The `.install.json` `installedAt` stamp (default `new Date().toISOString()`). */
  now?: () => string;
}

/** What a successful install landed — everything the CLI prints and the server returns to the GUI. */
export interface InstalledSkill {
  /** The installed skill id (the resolvable token = the bundle dir name). */
  id: string;
  /** The absolute install dir (`<piflowHome>/skills/<id>`). */
  dest: string;
  /** The deterministic bundle content hash. */
  sha256: string;
  /** The source AS GIVEN (provenance) — a local dir, a git URL, or `owner/repo`. */
  source: string;
  /** The `installedAt` ISO stamp written to `.install.json`. */
  installedAt: string;
}

/**
 * Install a skill bundle into the home ring from a local dir, a git URL, or an `owner/repo` GitHub
 * shorthand. Returns the {@link InstalledSkill} record on success; THROWS {@link SkillInstallError} with a
 * clean one-line message on every failure (unresolvable source, clone failure, no SKILL.md, ambiguous
 * candidates, name≠dir, invalid manifest, or an already-installed id without `force`) — never a raw crash.
 */
export async function installSkill(source: string, opts: InstallSkillOpts = {}): Promise<InstalledSkill> {
  const classified = classifySkillSource(source);
  if (classified.kind === 'none') {
    throw new SkillInstallError(`source '${source}' not found (not a local dir, a git URL, or owner/repo).`);
  }

  // Materialize: a local dir is used as-is; a git source shallow-clones into a throwaway tmp dir.
  let root: string;
  let rootName: string;
  let tmp: string | undefined;
  if (classified.kind === 'git') {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'piflow-skill-add-'));
    const clone = spawnSync('git', ['clone', '--depth', '1', classified.url, tmp], { encoding: 'utf8' });
    if (clone.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      throw new SkillInstallError(`git clone of ${classified.url} failed:\n${clone.stderr || clone.error?.message || ''}`);
    }
    root = tmp;
    rootName = repoNameFromUrl(classified.url);
  } else {
    root = classified.dir;
    rootName = path.basename(classified.dir);
  }

  try {
    const candidates = await findCandidates(root, rootName);
    if (candidates.length === 0) {
      throw new SkillInstallError(`no SKILL.md found in '${source}' (looked at the root, */, and skills/*/).`);
    }
    let chosen: Candidate | undefined;
    if (opts.pick) {
      chosen = candidates.find((c) => c.id === opts.pick);
      if (!chosen) {
        throw new SkillInstallError(`no candidate skill '${opts.pick}'. candidates: ${candidates.map((c) => c.id).join(', ')}`);
      }
    } else if (candidates.length === 1) {
      chosen = candidates[0];
    } else {
      throw new SkillInstallError(
        `'${source}' holds ${candidates.length} candidate skills — pick ONE with --skill <name>:\n` +
          candidates.map((c) => `  ${c.id}\n`).join(''),
      );
    }

    // The agentskills.io rule: the SKILL.md frontmatter `name` must equal the bundle dir name (the
    // resolvable token a node's bare `skill:` ref uses) — a mismatch would install an unresolvable id.
    const raw = await fs.readFile(path.join(chosen.dir, 'SKILL.md'), 'utf8');
    const name = manifestName(raw);
    if (!name) {
      throw new SkillInstallError(`${chosen.id}/SKILL.md has no parseable frontmatter 'name:'.`);
    }
    if (name !== chosen.id) {
      throw new SkillInstallError(
        `frontmatter name '${name}' does not match the dir name '${chosen.id}' ` +
          `(the agentskills.io rule) — rename one so they agree.`,
      );
    }

    // Full manifest validation via the shared parser — it throws when `requires ⊄ allowed`, and a bundle
    // that can't satisfy its own floor must be refused HERE, not discovered broken at run time.
    try {
      parseSkillManifest(raw, chosen.id);
    } catch (e) {
      throw new SkillInstallError(`${chosen.id}/SKILL.md manifest is invalid — ${e instanceof Error ? e.message : e}`);
    }

    const dest = path.join(piflowHomeDir(opts.piflowHome), 'skills', chosen.id);
    if (existsSync(dest)) {
      if (!opts.force) {
        throw new SkillInstallError(`'${chosen.id}' is already installed at ${dest} — pass --force to replace it.`);
      }
      rmSync(dest, { recursive: true, force: true });
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    cpSync(chosen.dir, dest, { recursive: true, filter: (src) => path.basename(src) !== '.git' });

    const sha256 = await bundleSha256(dest);
    const installedAt = opts.now ? opts.now() : new Date().toISOString();
    await fs.writeFile(path.join(dest, '.install.json'), JSON.stringify({ source, sha256, installedAt }, null, 2) + '\n');
    return { id: chosen.id, dest, sha256, source, installedAt };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}
